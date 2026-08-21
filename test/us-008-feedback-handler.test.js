/**
 * Feedback write endpoint HTTP + ADC wiring (US-008).
 *
 * Proves the Netlify handler wiring, fully offline. The two Google packages are
 * stubbed via a swapped module require (mirrors test/carousel-preview.test.js and
 * test/us-007-competitor-actions.test.js), so nothing here touches Google auth or
 * live services. This test focuses on what the core-logic test cannot see:
 *
 *   ADC        - the write clients are constructed with { projectId } (and the
 *                BigQuery location) and NO `credentials`, so they authenticate as
 *                the runtime feedback-write SA via Application Default Credentials.
 *                The source reads no service-account JSON env (no stored key).
 *   ROUTING    - a valid POST writes status.json into the f10-creative-assets
 *                bucket at the bundle prefix and inserts into
 *                creative_pipeline.feedback_audit.
 *   HTTP GATE  - OPTIONS preflight is 204, non-POST is 405, and a POST with no
 *                gate auth headers fails closed (401) with no Google calls.
 *
 * Run: node test/us-008-feedback-handler.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const FN_PATH = path.join(__dirname, '..', 'starter', 'netlify', 'functions', 'feedback.js');
const FN_SRC = fs.readFileSync(FN_PATH, 'utf8');

/* Fake Google clients that record how they were constructed and used. */
function makeFakes() {
  const storageOpts = [];
  const bqOpts = [];
  const saved = [];
  const inserted = [];

  class FakeStorage {
    constructor(opts) { storageOpts.push(opts); }
    bucket(bucketName) {
      return {
        file(objectPath) {
          return {
            async save(contents, options) { saved.push({ bucketName, objectPath, contents, options }); },
          };
        },
      };
    }
  }
  class FakeTable {
    constructor(dataset, table) { this.dataset = dataset; this.table = table; }
    async insert(rows) { inserted.push({ dataset: this.dataset, table: this.table, rows }); }
  }
  class FakeBigQuery {
    constructor(opts) { bqOpts.push(opts); }
    dataset(d) { return { table: (t) => new FakeTable(d, t) }; }
  }
  return { FakeStorage, FakeBigQuery, storageOpts, bqOpts, saved, inserted };
}

/* Compile the real feedback.js with the two @google-cloud deps swapped for fakes. */
function loadHandler(fakes) {
  const m = new Module(FN_PATH, null);
  m.filename = FN_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(FN_PATH));
  const realRequire = m.require.bind(m);
  m.require = (id) => {
    if (id === '@google-cloud/storage') return { Storage: fakes.FakeStorage };
    if (id === '@google-cloud/bigquery') return { BigQuery: fakes.FakeBigQuery };
    return realRequire(id);
  };
  m._compile(FN_SRC, FN_PATH);
  return m.exports.handler;
}

const GATE = { 'x-f10-actor': 'zac@f10', 'x-f10-client-scope': 'moshy' };
function event(method, payload, headers) {
  return { httpMethod: method, headers: headers || {}, body: payload === undefined ? '' : JSON.stringify(payload) };
}

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok -', name); })
    .catch((e) => { console.error('  FAIL -', name, '\n    ', e && e.message); process.exitCode = 1; });
}

(async () => {
  console.log('Feedback write endpoint wiring (US-008)');

  await check('a gated POST approve writes status.json to the bundle prefix and inserts an audit row', async () => {
    const fakes = makeFakes();
    const handler = loadHandler(fakes);
    const res = await handler(event('POST', { client: 'moshy', platform: 'meta', bundle_id: 'b_42', state: 'approved' }, GATE));
    assert.strictEqual(res.statusCode, 200, res.body);

    assert.strictEqual(fakes.saved.length, 1, 'one object written');
    assert.strictEqual(fakes.saved[0].bucketName, 'f10-creative-assets', 'writes to the components bucket');
    assert.strictEqual(fakes.saved[0].objectPath, 'components/meta/moshy/b_42/status.json');
    assert.strictEqual(fakes.saved[0].options.contentType, 'application/json');
    const written = JSON.parse(fakes.saved[0].contents);
    assert.strictEqual(written.state, 'approved');
    // Cross-repo contract: the written sidecar carries `status` too, so the
    // bundle service (which gates on doc.status === "approved") serves it.
    assert.strictEqual(written.status, 'approved', 'sidecar carries status the bundle service reads');

    assert.strictEqual(fakes.inserted.length, 1, 'one audit insert');
    assert.strictEqual(fakes.inserted[0].dataset, 'creative_pipeline');
    assert.strictEqual(fakes.inserted[0].table, 'feedback_audit');
    assert.strictEqual(fakes.inserted[0].rows[0].client, 'moshy');
    assert.strictEqual(fakes.inserted[0].rows[0].actor, 'zac@f10', 'gate actor recorded');
  });

  await check('the write clients use ADC (projectId/location only, NO credentials) = runtime SA', async () => {
    const fakes = makeFakes();
    const handler = loadHandler(fakes);
    await handler(event('POST', { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved' }, GATE));
    assert.strictEqual(fakes.storageOpts.length, 1);
    assert.strictEqual(fakes.storageOpts[0].projectId, 'mcc-poc-477801');
    assert.ok(!('credentials' in fakes.storageOpts[0]), 'Storage must not be given credentials (ADC only)');
    assert.strictEqual(fakes.bqOpts[0].projectId, 'mcc-poc-477801');
    assert.strictEqual(fakes.bqOpts[0].location, 'australia-southeast1');
    assert.ok(!('credentials' in fakes.bqOpts[0]), 'BigQuery must not be given credentials (ADC only)');
  });

  await check('source reads no stored service-account key (no GOOGLE_SERVICE_ACCOUNT / FEEDBACK_WRITE_SA_JSON env read)', () => {
    // The decision is ADC/runtime SA, not a stored JSON key: the code must never
    // READ either env. (The names may still appear in explanatory comments.)
    assert.strictEqual(/process\.env\.GOOGLE_SERVICE_ACCOUNT/.test(FN_SRC), false, 'must not read the read-path SA env');
    assert.strictEqual(/process\.env\.FEEDBACK_WRITE_SA_JSON/.test(FN_SRC), false, 'must not read a stored write-SA key (superseded)');
    // And it must not hand any credentials object to the Google clients.
    assert.strictEqual(/credentials\s*:/.test(FN_SRC), false, 'must not pass a credentials option (ADC only)');
  });

  await check('OPTIONS preflight returns 204 and does no Google work', async () => {
    const fakes = makeFakes();
    const handler = loadHandler(fakes);
    const res = await handler(event('OPTIONS', undefined, GATE));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(fakes.saved.length, 0);
    assert.strictEqual(fakes.inserted.length, 0);
  });

  await check('a non-POST method is 405', async () => {
    const fakes = makeFakes();
    const handler = loadHandler(fakes);
    const res = await handler(event('GET', undefined, GATE));
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(fakes.saved.length, 0);
  });

  await check('fail closed: a POST with no gate auth headers is 401 and does no Google work', async () => {
    const fakes = makeFakes();
    const handler = loadHandler(fakes);
    const res = await handler(event('POST', { client: 'moshy', platform: 'meta', bundle_id: 'b1', state: 'approved', actor: 'someone' }, {}));
    assert.strictEqual(res.statusCode, 401, 'not anonymously writable');
    assert.strictEqual(fakes.saved.length, 0, 'no sidecar write for an unauthenticated caller');
    assert.strictEqual(fakes.inserted.length, 0, 'no audit row for an unauthenticated caller');
  });

  await check('a gated POST for a client outside the caller scope is 403 with no writes', async () => {
    const fakes = makeFakes();
    const handler = loadHandler(fakes);
    const res = await handler(event('POST', { client: 'other', platform: 'meta', bundle_id: 'b1', state: 'approved' }, GATE));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(fakes.saved.length, 0);
    assert.strictEqual(fakes.inserted.length, 0);
  });

  await check('a malformed JSON body is rejected 400', async () => {
    const fakes = makeFakes();
    const handler = loadHandler(fakes);
    const res = await handler({ httpMethod: 'POST', headers: GATE, body: '{ not json' });
    assert.strictEqual(res.statusCode, 400);
  });

  console.log('\nFeedback write wiring: ' + passed + ' checks passed.');
})();
