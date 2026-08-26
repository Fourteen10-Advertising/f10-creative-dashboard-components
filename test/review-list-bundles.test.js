/**
 * Creative-pipeline auto-discovery: Netlify function `action:'list-bundles'`.
 *
 * Verifies the `list-bundles` handler in starter/netlify/functions/bq.js: for a client it
 * returns that client's generated bundles (one row per brief_id) discovered from the shared
 * bundle manifest all_clients.creative_manifest, newest first, in the normalised shape the
 * Creative Review tab consumes. This test pins:
 *   - the query targets all_clients.creative_manifest, groups by brief_id, filters by the
 *     client with a BOUND @client parameter, and orders newest-first (MAX(fetched_at) DESC);
 *   - the response normalises each row to { bundle_id, platform, date:'YYYY-MM-DD',
 *     generated_at, n_fetched, n_components }, preserving the query's newest-first order;
 *   - the cost/timeout guardrails ride on the query;
 *   - a missing / empty client is a 400 with no query run;
 *   - a manifest that does not exist yet FAILS CLOSED to an empty list (200, not a 500);
 *   - a genuine (non-not-found) BigQuery error still surfaces as a 500.
 *
 * Dependency-free: the real bq.js is compiled with the two @google-cloud modules stubbed by
 * an in-memory fake that records every query, the same harness as the sibling bq.js action
 * tests (see test/us-006-winning-historical.test.js).
 *
 * Run: node test/review-list-bundles.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BQ_PATH = path.join(ROOT, 'starter/netlify/functions/bq.js');
const BQ_SRC = fs.readFileSync(BQ_PATH, 'utf8');

/* Fake BigQuery: records every query() call (so guardrails/params/SQL can be asserted) and
 * returns canned rows via a router the test installs. A router that throws simulates a
 * warehouse error (e.g. a not-found table). */
function makeFakeBigQuery(router) {
  const queries = [];
  class FakeBigQuery {
    constructor(opts) { this.opts = opts; }
    async query(opts) {
      queries.push(opts);
      const rows = router(opts);
      return [rows || []];
    }
  }
  return { FakeBigQuery, queries };
}

/* Fake Storage: list-bundles never signs, but bq.js requires the module at load. */
function makeFakeStorage() {
  class FakeStorage {
    constructor(opts) { this.opts = opts; }
    bucket() { return { file() { return { async getSignedUrl() { return ['https://signed.example/x']; } }; } }; }
  }
  return FakeStorage;
}

/* Compile the real bq.js with the two @google-cloud deps swapped for our fakes. */
function loadHandler(FakeBigQuery, FakeStorage) {
  const m = new Module(BQ_PATH, null);
  m.filename = BQ_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(BQ_PATH));
  const realRequire = m.require.bind(m);
  m.require = (id) => {
    if (id === '@google-cloud/bigquery') return { BigQuery: FakeBigQuery };
    if (id === '@google-cloud/storage') return { Storage: FakeStorage };
    return realRequire(id);
  };
  m._compile(BQ_SRC, BQ_PATH);
  return m.exports.handler;
}

function makeEvent(payload) {
  return { httpMethod: 'POST', headers: {}, body: JSON.stringify(payload) };
}

// bq.js needs a service-account env var to proceed; a syntactically-valid stub is enough
// because BigQuery/Storage are faked.
process.env.GOOGLE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'x@test', private_key: 'k' });

let passed = 0;
function check(name, fn) { return fn().then(() => { passed++; console.log('  ok -', name); }); }

// Assert every recorded query carried the cost/timeout guardrails.
function assertGuardrails(queries) {
  for (const q of queries) {
    assert.ok(q.maximumBytesBilled, 'query missing maximumBytesBilled guardrail');
    assert.ok(q.jobTimeoutMs, 'query missing jobTimeoutMs guardrail');
  }
}

/* Canned manifest rollup rows, already in the newest-first order the SQL ORDER BY produces.
 * generated_date is delivered both as a plain string and as a { value } wrapper (BigQuery
 * DATE columns arrive either way) so the handler's date coercion is exercised. */
function manifestRows() {
  return [
    { bundle_id: 'brief_mosh_founder_zz99', platform: 'meta', generated_date: '2026-08-22', generated_at: '2026-08-22T04:10:00.000Z', n_fetched: 3, n_components: 4 },
    { bundle_id: 'brief_mosh_ugc_ab12', platform: 'meta', generated_date: { value: '2026-08-20' }, generated_at: { value: '2026-08-20T09:00:00.000Z' }, n_fetched: 2, n_components: 2 },
    { bundle_id: 'brief_mosh_static_cd34', platform: 'tiktok', generated_date: '2026-08-18', generated_at: '2026-08-18T00:00:00.000Z', n_fetched: 0, n_components: 5 },
  ];
}

/* All backtick table refs across the recorded queries. */
function backtickRefs(queries) {
  const refs = [];
  const re = /`([^`]+)`/g;
  for (const q of queries) {
    let m;
    while ((m = re.exec(q.query)) !== null) refs.push(m[1]);
  }
  return refs;
}

(async () => {
  console.log('Creative-pipeline list-bundles discovery');

  // ── Scenario 1: discovers the client's bundles, normalised, newest-first ──
  await check('returns the client bundles from creative_manifest, normalised and newest-first', async () => {
    const router = (opts) => (/creative_manifest/.test(opts.query) ? manifestRows() : []);
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());

    const res = await handler(makeEvent({ action: 'list-bundles', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 200);
    const p = JSON.parse(res.body);

    assert.strictEqual(p.client, 'mosh', 'the response echoes the resolved client slug');
    assert.ok(Array.isArray(p.bundles) && p.bundles.length === 3, 'one entry per discovered bundle');

    // Newest-first order is preserved from the SQL ORDER BY.
    assert.deepStrictEqual(p.bundles.map((b) => b.bundle_id),
      ['brief_mosh_founder_zz99', 'brief_mosh_ugc_ab12', 'brief_mosh_static_cd34'],
      'bundles preserve the newest-first order');

    // Normalised shape.
    const first = p.bundles[0];
    assert.strictEqual(first.bundle_id, 'brief_mosh_founder_zz99');
    assert.strictEqual(first.platform, 'meta');
    assert.strictEqual(first.date, '2026-08-22', 'date is an ISO YYYY-MM-DD string');
    assert.strictEqual(first.n_fetched, 3);
    assert.strictEqual(first.n_components, 4);

    // The { value } wrapped DATE is coerced to a plain ISO string too.
    assert.strictEqual(p.bundles[1].date, '2026-08-20', 'a { value }-wrapped DATE coerces to YYYY-MM-DD');
    assert.strictEqual(p.bundles[2].platform, 'tiktok', 'the platform is carried through');
    assert.strictEqual(p.bundles[2].n_fetched, 0, 'a zero fetched count is preserved, not dropped');

    // The read targets the shared bundle manifest.
    const refs = backtickRefs(queries).join(' | ');
    assert.ok(/mcc-poc-477801\.all_clients\.creative_manifest/.test(refs), 'reads all_clients.creative_manifest');
    assertGuardrails(queries);
  });

  // ── Scenario 2: the query groups by brief_id, binds @client, orders newest-first ──
  await check('the query groups by brief_id, filters by a bound @client, and orders newest-first', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery((opts) => (/creative_manifest/.test(opts.query) ? manifestRows() : []));
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    await handler(makeEvent({ action: 'list-bundles', client: 'mosh' }));

    const q = queries.find((x) => /creative_manifest/.test(x.query));
    assert.ok(q, 'a manifest query ran');
    assert.ok(/GROUP BY brief_id/.test(q.query), 'groups by brief_id (one row per bundle)');
    assert.ok(/WHERE\s+client\s*=\s*@client/.test(q.query), 'filters by a bound @client parameter');
    assert.ok(/brief_id IS NOT NULL/.test(q.query), 'only rows that carry a brief_id are bundles');
    assert.ok(/ORDER BY MAX\(fetched_at\) DESC/.test(q.query), 'orders newest-first by MAX(fetched_at)');
    assert.ok(/COUNTIF\(fetch_status = 'fetched'\)/.test(q.query), 'counts fetched components via fetch_status');
    // The client rides as a bound parameter (never inlined), so there is no injection surface.
    assert.strictEqual(q.params && q.params.client, 'mosh', 'client is passed as a bound parameter');
    assert.ok(q.types && q.types.client === 'STRING', 'the client parameter is typed STRING');
    assert.ok(!/;/.test(q.query), 'no stray semicolon in the query');
  });

  // ── Scenario 3: the client key is sanitised (a value that cannot be inlined) ──
  await check('an injection-style client value is reduced to the dataset charset before binding', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery((opts) => (/creative_manifest/.test(opts.query) ? [] : []));
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'list-bundles', client: 'Mosh`; DROP TABLE x; --' }));
    const p = JSON.parse(res.body);
    assert.strictEqual(p.client, 'moshdroptablex', 'client reduced to the [a-z0-9_] charset');
    const q = queries.find((x) => /creative_manifest/.test(x.query));
    assert.strictEqual(q.params.client, 'moshdroptablex', 'the sanitised client is what gets bound');
  });

  // ── Scenario 4: a missing / empty client is a 400 with no query run ──
  await check('a missing client is a 400 with no query run', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => { throw new Error('should not query without a client'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'list-bundles' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(queries.length, 0);
  });

  await check('a client that sanitises to empty is a 400 with no query run', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => { throw new Error('should not query without a valid client'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'list-bundles', client: '***' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(queries.length, 0);
  });

  // ── Scenario 5: a not-yet-built manifest FAILS CLOSED to an empty list (not a 500) ──
  await check('a client whose manifest does not exist yet returns a clean empty list, not a 500', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => {
      throw Object.assign(new Error('Not found: Table mcc-poc-477801:all_clients.creative_manifest'), { code: 404 });
    });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'list-bundles', client: 'newclient' }));
    assert.strictEqual(res.statusCode, 200);
    const p = JSON.parse(res.body);
    assert.strictEqual(p.client, 'newclient');
    assert.deepStrictEqual(p.bundles, [], 'no bundles on an absent manifest');
  });

  // ── Scenario 6: a genuine BigQuery error still surfaces as a 500 ──
  await check('a non-not-found BigQuery error surfaces as a 500 (never swallowed)', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => { throw new Error('quota exceeded'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'list-bundles', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 500);
    assert.ok(/quota exceeded/.test(JSON.parse(res.body).error));
  });

  console.log(`\nlist-bundles discovery: ${passed} checks passed.`);
})().catch((e) => { console.error('\nlist-bundles FAILED:', (e && e.stack) || e); process.exit(1); });
