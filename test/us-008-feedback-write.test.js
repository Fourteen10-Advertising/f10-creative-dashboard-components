/**
 * Feedback write path core logic (US-008).
 *
 * Proves, fully offline (fake GCS + fake BigQuery writers, no Google auth, no
 * live services), the behaviour of the net-new write endpoint's core:
 *
 *   VALIDATION  - the payload is client / bundle_id / platform / state
 *                 (approved|declined|pending) / optional comment / actor, and
 *                 bad or path-unsafe input is rejected before any write.
 *   SIDECAR     - approve/decline writes status.json to the bundle's own prefix
 *                 (components/{platform}/{client}/{bundle_id}/status.json) with a
 *                 clear shape, and the ONLY object it ever writes ends /status.json.
 *   AUDIT       - the full record streams to the feedback_audit table with the
 *                 schema's fields (client, bundle_id, state, comment, actor,
 *                 created_at), and the ONLY table it ever inserts into is
 *                 creative_pipeline.feedback_audit.
 *   SCOPE       - a caller scoped to client A cannot write client B's bundle.
 *   FAIL-CLOSED - a missing/invalid auth context, or a write-backend failure,
 *                 is rejected and no partial/anonymous write escapes.
 *
 * The endpoint's HTTP + ADC wiring is proven separately in
 * test/us-008-feedback-handler.test.js.
 *
 * Run: node test/us-008-feedback-write.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');

const feedback = require(path.join(__dirname, '..', 'starter', 'netlify', 'functions', 'feedback.js'));
const { processFeedback, validatePayload, buildStatusJson, buildAuditRow, statusObjectPath, resolveAuthContext } = feedback;

/* ---- fakes: capture, never call Google ---- */
function makeFakeGcs() {
  const saves = [];
  return {
    saves,
    async save(objectPath, contents, contentType) { saves.push({ objectPath, contents, contentType }); },
  };
}
function makeFakeBq() {
  const inserts = [];
  return {
    inserts,
    async insertAudit(rows) { for (const r of rows) inserts.push(r); },
  };
}
const scope = (...clients) => ({ actor: null, clientScope: clients });
const FIXED = new Date('2026-08-20T03:04:05.000Z');

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok -', name); })
    .catch((e) => { console.error('  FAIL -', name, '\n    ', e && e.message); process.exitCode = 1; });
}

(async () => {
  console.log('Feedback write path core (US-008)');

  /* ------------------------------------------------------------------ *
   * e2e 1: approve -> status.json approved + a row lands in the audit    *
   * ------------------------------------------------------------------ */
  await check('approve writes status.json=approved to the bundle prefix and inserts one audit row', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    const res = await processFeedback({
      authContext: scope('moshy'),
      body: { client: 'moshy', platform: 'meta', bundle_id: 'b_123', state: 'approved', actor: 'zac@f10' },
      gcs, bq, now: FIXED,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.payload));
    // exactly one GCS write, to the bundle's own status.json prefix
    assert.strictEqual(gcs.saves.length, 1, 'exactly one object written');
    assert.strictEqual(gcs.saves[0].objectPath, 'components/meta/moshy/b_123/status.json');
    assert.strictEqual(gcs.saves[0].contentType, 'application/json');
    const status = JSON.parse(gcs.saves[0].contents);
    assert.strictEqual(status.state, 'approved', 'sidecar shows approved');
    assert.strictEqual(status.client, 'moshy');
    assert.strictEqual(status.bundle_id, 'b_123');
    // exactly one audit row, mirroring the decision
    assert.strictEqual(bq.inserts.length, 1, 'exactly one audit row');
    assert.strictEqual(bq.inserts[0].state, 'approved');
    assert.strictEqual(bq.inserts[0].client, 'moshy');
    assert.strictEqual(bq.inserts[0].created_at, '2026-08-20T03:04:05.000Z');
  });

  /* ------------------------------------------------------------------ *
   * e2e 2: decline with a comment -> comment + actor land in the audit   *
   * ------------------------------------------------------------------ */
  await check('decline with a comment records the comment and actor in the audit row and sidecar', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    const res = await processFeedback({
      authContext: scope('mosh'),
      body: { client: 'mosh', platform: 'tiktok', bundle_id: 'bundle9', state: 'declined', comment: 'logo too small', actor: 'cam@f10' },
      gcs, bq, now: FIXED,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.payload));
    const row = bq.inserts[0];
    assert.strictEqual(row.state, 'declined');
    assert.strictEqual(row.comment, 'logo too small', 'comment recorded in audit');
    assert.strictEqual(row.actor, 'cam@f10', 'actor recorded in audit');
    const status = JSON.parse(gcs.saves[0].contents);
    assert.strictEqual(status.comment, 'logo too small');
    assert.strictEqual(status.actor, 'cam@f10');
    assert.strictEqual(status.state, 'declined');
  });

  /* ------------------------------------------------------------------ *
   * e2e 3: write for a bundle outside the caller's client scope -> reject *
   * ------------------------------------------------------------------ */
  await check('a write for a client outside the caller scope is rejected with no writes (A cannot write B)', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    const res = await processFeedback({
      authContext: scope('clientA'), // caller scoped to A only
      body: { client: 'clientB', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'zac@f10' },
      gcs, bq, now: FIXED,
    });
    assert.strictEqual(res.statusCode, 403, 'out-of-scope write must be forbidden');
    assert.strictEqual(gcs.saves.length, 0, 'no sidecar written for out-of-scope client');
    assert.strictEqual(bq.inserts.length, 0, 'no audit row for out-of-scope client');
  });

  await check('a caller scoped to several clients can write any of them but not one outside the list', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    const ctx = scope('clientA', 'clientB');
    const ok = await processFeedback({ authContext: ctx, body: { client: 'clientB', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'z' }, gcs, bq, now: FIXED });
    assert.strictEqual(ok.statusCode, 200);
    const bad = await processFeedback({ authContext: ctx, body: { client: 'clientC', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'z' }, gcs, bq, now: FIXED });
    assert.strictEqual(bad.statusCode, 403);
    assert.strictEqual(gcs.saves.length, 1, 'only the in-scope write happened');
  });

  /* ------------------------------------------------------------------ *
   * FAIL-CLOSED on auth context                                          *
   * ------------------------------------------------------------------ */
  await check('fail closed: no auth context is rejected 401 with no writes', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    for (const authContext of [null, undefined, {}, { clientScope: [] }, { clientScope: 'moshy' }]) {
      const res = await processFeedback({
        authContext,
        body: { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'z' },
        gcs, bq, now: FIXED,
      });
      assert.strictEqual(res.statusCode, 401, 'auth context ' + JSON.stringify(authContext) + ' must fail closed');
    }
    assert.strictEqual(gcs.saves.length, 0);
    assert.strictEqual(bq.inserts.length, 0);
  });

  /* ------------------------------------------------------------------ *
   * PAYLOAD VALIDATION                                                   *
   * ------------------------------------------------------------------ */
  await check('validatePayload accepts a well-formed record and normalises optional fields', () => {
    const { record, error } = validatePayload({ client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'pending' });
    assert.ok(!error, error);
    assert.strictEqual(record.comment, null, 'absent comment normalises to null');
    assert.strictEqual(record.actor, null, 'absent actor normalises to null');
  });

  await check('validatePayload rejects bad state, missing fields, and path-unsafe segments', () => {
    const bad = [
      { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'yes' },        // not an allowed state
      { client: 'moshy', platform: 'meta', bundle_id: 'b1' },                       // missing state
      { platform: 'meta', bundle_id: 'b1', state: 'approved' },                     // missing client
      { client: 'moshy', bundle_id: 'b1', state: 'approved' },                      // missing platform
      { client: 'moshy', platform: 'meta', state: 'approved' },                     // missing bundle_id
      { client: 'moshy', platform: 'meta', bundle_id: '../evil', state: 'approved' }, // traversal
      { client: 'a/b', platform: 'meta', bundle_id: 'b1', state: 'approved' },      // separator in client
      { client: 'moshy', platform: 'me ta', bundle_id: 'b1', state: 'approved' },   // space in platform
      { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved', comment: 42 }, // non-string comment
    ];
    for (const b of bad) {
      const { record, error } = validatePayload(b);
      assert.ok(error && !record, 'should reject: ' + JSON.stringify(b));
    }
  });

  await check('an invalid payload is rejected 400 before any write', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    const res = await processFeedback({
      authContext: scope('moshy'),
      body: { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'maybe', actor: 'z' },
      gcs, bq, now: FIXED,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(gcs.saves.length, 0);
    assert.strictEqual(bq.inserts.length, 0);
  });

  await check('an in-scope write with no actor anywhere is rejected 400 (who is required)', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    const res = await processFeedback({
      authContext: scope('moshy'), // gate actor is null here
      body: { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved' }, // no body actor
      gcs, bq, now: FIXED,
    });
    assert.strictEqual(res.statusCode, 400, 'a decision must record who made it');
    assert.strictEqual(gcs.saves.length, 0);
  });

  await check('the gate-authenticated actor takes precedence over a self-declared body actor', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    const res = await processFeedback({
      authContext: { actor: 'gate-user@f10', clientScope: ['moshy'] },
      body: { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'spoofed@evil' },
      gcs, bq, now: FIXED,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(bq.inserts[0].actor, 'gate-user@f10', 'gate identity wins over body-supplied actor');
    assert.strictEqual(JSON.parse(gcs.saves[0].contents).actor, 'gate-user@f10');
  });

  /* ------------------------------------------------------------------ *
   * SHAPES: status.json and audit row                                   *
   * ------------------------------------------------------------------ */
  await check('buildStatusJson has the documented shape and the audit row matches the BQ schema', () => {
    const record = { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved', comment: 'nice', actor: 'zac@f10' };
    const status = buildStatusJson(record, '2026-08-20T03:04:05.000Z');
    assert.deepStrictEqual(Object.keys(status).sort(), ['actor', 'bundle_id', 'client', 'comment', 'platform', 'state', 'updated_at'].sort());
    assert.strictEqual(status.updated_at, '2026-08-20T03:04:05.000Z');

    const row = buildAuditRow(record, '2026-08-20T03:04:05.000Z');
    assert.deepStrictEqual(Object.keys(row).sort(), ['actor', 'bundle_id', 'client', 'comment', 'created_at', 'state'].sort());
    // REQUIRED columns are present and non-null; nullable ones may be null.
    for (const req of ['client', 'bundle_id', 'state', 'created_at']) {
      assert.ok(row[req] !== null && row[req] !== undefined, req + ' is REQUIRED and must be present');
    }
  });

  await check('statusObjectPath always targets /status.json in the bundle prefix', () => {
    assert.strictEqual(statusObjectPath('meta', 'moshy', 'b_1'), 'components/meta/moshy/b_1/status.json');
    assert.ok(statusObjectPath('tiktok', 'mosh', 'x').endsWith('/status.json'), 'only ever writes status.json');
  });

  await check('the endpoint only ever writes status.json and only inserts into feedback_audit (matches SA scope)', async () => {
    const gcs = makeFakeGcs();
    const bq = makeFakeBq();
    await processFeedback({ authContext: scope('moshy'), body: { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'z' }, gcs, bq, now: FIXED });
    for (const s of gcs.saves) assert.ok(/\/status\.json$/.test(s.objectPath), 'wrote a non-status.json object: ' + s.objectPath);
    // The BQ writer only exposes insertAudit -> the code cannot target another table.
    assert.strictEqual(typeof bq.insertAudit, 'function');
    assert.strictEqual(feedback.constants.DATASET, 'creative_pipeline');
    assert.strictEqual(feedback.constants.AUDIT_TABLE, 'feedback_audit');
    assert.strictEqual(feedback.constants.BUCKET, 'f10-creative-assets');
  });

  /* ------------------------------------------------------------------ *
   * FAIL-CLOSED on a write-backend failure                              *
   * ------------------------------------------------------------------ */
  await check('a GCS failure fails closed (502) and never inserts an audit row', async () => {
    const bq = makeFakeBq();
    const gcs = { async save() { throw new Error('gcs down'); } };
    const res = await processFeedback({ authContext: scope('moshy'), body: { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'z' }, gcs, bq, now: FIXED });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(bq.inserts.length, 0, 'audit must not run if the sidecar write failed');
  });

  await check('an audit-insert failure after the sidecar write surfaces as an error (502)', async () => {
    const gcs = makeFakeGcs();
    const bq = { async insertAudit() { throw new Error('bq down'); } };
    const res = await processFeedback({ authContext: scope('moshy'), body: { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'z' }, gcs, bq, now: FIXED });
    assert.strictEqual(res.statusCode, 502);
  });

  /* ------------------------------------------------------------------ *
   * resolveAuthContext (header -> scope), fail-closed on wildcard/empty  *
   * ------------------------------------------------------------------ */
  await check('resolveAuthContext parses the gate scope header and rejects empty/wildcard scope', () => {
    const ev = (scopeVal, actorVal) => ({ headers: { 'x-f10-client-scope': scopeVal, 'x-f10-actor': actorVal } });
    const ok = resolveAuthContext(ev('moshy, mosh', 'zac@f10'));
    assert.deepStrictEqual(ok.clientScope, ['moshy', 'mosh']);
    assert.strictEqual(ok.actor, 'zac@f10');
    assert.strictEqual(resolveAuthContext({ headers: {} }), null, 'no scope header => null (fail closed)');
    assert.strictEqual(resolveAuthContext(ev('', 'z')), null, 'empty scope => null');
    assert.strictEqual(resolveAuthContext(ev('*', 'z')), null, 'wildcard scope not honoured');
  });

  await check('no long dashes anywhere in feedback.js (F10 policy)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'starter', 'netlify', 'functions', 'feedback.js'), 'utf8');
    // Reference the code points via escapes so this file itself carries no literal
    // em/en dash (the policy applies to the tests too).
    const emDash = String.fromCharCode(0x2014);
    const enDash = String.fromCharCode(0x2013);
    assert.ok(src.indexOf(emDash) === -1 && src.indexOf(enDash) === -1, 'no em/en dashes in feedback.js');
  });

  console.log('\nFeedback write core: ' + passed + ' checks passed.');
})();
