/**
 * US-006 — Netlify function: cross-competitor ad search action.
 *
 * Verifies the `action:'competitor-search'` handler in
 * starter/netlify/functions/bq.js: a client's competitor ads are searchable by
 * copy / link title / page name / link URL / CTA / vision on-screen text; every
 * matched ad reports which field matched and carries short-lived signed creative
 * URLs; the private gs:// URI never leaves the function; empty/short terms and
 * a no-data client fail closed WITHOUT a full-scan query; and every BigQuery job
 * carries the maximumBytesBilled + jobTimeoutMs guardrails.
 *
 * Dependency-free: the real bq.js is compiled with the two @google-cloud modules
 * stubbed by an in-memory fake that records every query and mints a fake signed
 * URL, so the handler's own JS behaviour is exercised end-to-end without network
 * or real credentials.
 *
 * Run: node test/us-006-competitor-search.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BQ_PATH = path.join(ROOT, 'starter/netlify/functions/bq.js');
const BQ_SRC = fs.readFileSync(BQ_PATH, 'utf8');

/* Fake BigQuery: records every query() call (so guardrails/params can be
 * asserted) and returns canned rows via a router the test installs. The router
 * inspects the SQL + params and stands in for the warehouse — this exercises the
 * handler's orchestration, not BigQuery's SQL engine (which no unit test can run). */
function makeFakeBigQuery(router) {
  const queries = [];
  class FakeBigQuery {
    constructor(opts) { this.opts = opts; }
    async query(opts) {
      queries.push(opts);
      const rows = router(opts) || [];
      return [rows];
    }
  }
  return { FakeBigQuery, queries };
}

/* Fake Storage: records getSignedUrl option sets and returns a deterministic
 * https URL so the handler's signing path runs without GCS. */
function makeFakeStorage(signCalls) {
  class FakeStorage {
    constructor(opts) { this.opts = opts; }
    bucket(b) {
      return {
        file(f) {
          return {
            async getSignedUrl(opts) {
              signCalls.push({ bucket: b, file: f, opts });
              return [`https://signed.example/${b}/${f}?X-Goog-Expires=900`];
            },
          };
        },
      };
    }
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

// bq.js needs a service-account env var to proceed; a syntactically-valid stub
// is enough because BigQuery/Storage are faked.
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

(async () => {
  console.log('US-006 cross-competitor ad search action');

  // ── Scenario 1: a term that matches returns the ad with signed media + page_name ──
  await check("term 'menopause' returns matching ad with signed media, page_name, matched_field", async () => {
    const router = (opts) => {
      const sql = opts.query;
      if (/competitor_vision_attributes|ad_snapshots/.test(sql) && !/creative_manifest/.test(sql)) {
        // the search snapshot query
        assert.strictEqual(opts.params.term, 'menopause', 'term param must be passed through');
        assert.strictEqual(opts.params.client, 'mosh', 'client scope must be passed through');
        return [{
          ad_archive_id: 'A1', page_name: 'CompA', cta_type: 'SHOP_NOW',
          ad_creative_bodies: ['Managing menopause naturally'], link_url: 'https://c.example',
          on_screen_text: 'menopause relief', matched_fields: ['ad_creative_bodies', 'on_screen_text'],
          days_active_observed: 42,
        }];
      }
      if (/creative_manifest/.test(sql)) {
        assert.deepStrictEqual(opts.params.adIds, ['A1'], 'creative read must scope to matched ad ids');
        return [{ ad_archive_id: 'A1', media_type: 'image', idx: 0, gcs_uri: 'gs://f10-bucket/a1.jpg' }];
      }
      return [];
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const signCalls = [];
    const FakeStorage = makeFakeStorage(signCalls);
    const handler = loadHandler(FakeBigQuery, FakeStorage);

    const before = Date.now();
    const res = await handler(makeEvent({ action: 'competitor-search', client: 'mosh', term: 'menopause' }));
    const after = Date.now();

    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.ads.length, 1, 'one ad should match');
    const ad = payload.ads[0];
    assert.strictEqual(ad.page_name, 'CompA', 'page_name returned');
    assert.ok(ad.matched_fields.includes('ad_creative_bodies'), 'matched field reported');
    assert.strictEqual(ad.creatives.length, 1, 'creative attached');
    assert.ok(/^https:\/\/signed\.example\//.test(ad.creatives[0].url), 'creative carries a signed https URL');

    // gs:// URI must never reach the browser.
    assert.ok(!/gs:\/\//.test(res.body), 'response must not leak any gs:// URI');
    // Signed URL must be a 15-min V4 read URL.
    assert.strictEqual(signCalls.length, 1, 'exactly one asset signed');
    const so = signCalls[0].opts;
    assert.strictEqual(so.version, 'v4');
    assert.strictEqual(so.action, 'read');
    const ttl = so.expires - before;
    assert.ok(ttl >= 15 * 60 * 1000 - 50 && so.expires - after <= 15 * 60 * 1000 + 50,
      '15-minute expiry (got ' + ttl + 'ms)');

    assertGuardrails(queries);
  });

  // ── Scenario 2: a term with no matches returns an empty set without error ──
  await check('a no-match term returns an empty result set without error', async () => {
    const router = (opts) => {
      if (/creative_manifest/.test(opts.query)) throw new Error('creative read must not run when nothing matched');
      return []; // snapshot query finds nothing
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const signCalls = [];
    const handler = loadHandler(FakeBigQuery, makeFakeStorage(signCalls));

    const res = await handler(makeEvent({ action: 'competitor-search', client: 'mosh', term: 'zzznotarealterm' }));
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.deepStrictEqual(payload.ads, [], 'empty ads on no match');
    assert.ok(!('error' in payload), 'no error field on a clean empty result');
    assert.strictEqual(signCalls.length, 0, 'nothing to sign');
    assertGuardrails(queries);
  });

  // ── Scenario 3: empty / short term fails closed WITHOUT any scan query ──
  for (const term of ['', ' ', 'a']) {
    await check(`term ${JSON.stringify(term)} returns empty fast with no scan query`, async () => {
      const { FakeBigQuery, queries } = makeFakeBigQuery(() => {
        throw new Error('no BigQuery query should run for an empty/short term');
      });
      const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
      const res = await handler(makeEvent({ action: 'competitor-search', client: 'mosh', term }));
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(res.body).ads, []);
      assert.strictEqual(queries.length, 0, 'a short/empty term must not touch BigQuery');
    });
  }

  // ── Scenario 4: probe fails closed for a client with no competitor data ──
  await check('probe returns exists:false for a client with no competitor data', async () => {
    const router = (opts) => {
      assert.ok(/EXISTS\(/.test(opts.query) && /ad_registry/.test(opts.query), 'probe hits the cheap existence check');
      return [{ has_data: false }];
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'competitor-search', client: 'mosh', probe: true }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { exists: false });
    assertGuardrails(queries);
  });

  await check('probe returns exists:true when the client has competitor data', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => [{ has_data: true }]);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'competitor-search', client: 'mosh', probe: true }));
    assert.deepStrictEqual(JSON.parse(res.body), { exists: true });
    assertGuardrails(queries);
  });

  // ── Scenario 5: missing client is a 400, not a full scan ──
  await check('missing client returns 400 without querying', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => { throw new Error('should not query without a client'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'competitor-search', term: 'menopause' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(queries.length, 0);
  });

  console.log(`\nUS-006: ${passed} checks passed.`);
})().catch((e) => { console.error('\nUS-006 FAILED:', e && e.stack || e); process.exit(1); });
