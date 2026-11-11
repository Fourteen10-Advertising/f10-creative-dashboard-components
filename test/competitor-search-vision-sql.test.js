/**
 * Regression: competitor-search SQL reads the vision table by its real keys.
 *
 * The per-client vision table (adlib_competitor_vision_attributes) is keyed by
 * client + asset_id. It has no f10_client column and no ad id column, and
 * on_screen_text is ARRAY<STRING>. An earlier search query filtered it on
 * f10_client and grouped it by ad_archive_id, so BigQuery rejected every search
 * with "Unrecognized name: f10_client".
 *
 * This test compiles the real bq.js with the @google-cloud modules stubbed,
 * captures the SQL the competitor-search action sends, and checks the vision
 * CTE against the live column contract (confirmed via INFORMATION_SCHEMA):
 *   - vision rows are filtered on client = @client and status = 'ok'
 *   - each asset maps to its ad through adlib_creative_manifest
 *     (asset_key = asset_id), scoped to f10_client = @client
 *   - on_screen_text is flattened with ARRAY_TO_STRING before STRING_AGG
 *   - every v.<col> / m.<col> reference exists on that table
 *
 * Run: node test/competitor-search-vision-sql.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BQ_PATH = [
  path.join(ROOT, 'starter/netlify/functions/bq.js'),
  path.join(ROOT, 'netlify/functions/bq.js'),
].find((p) => fs.existsSync(p));
assert.ok(BQ_PATH, 'could not find netlify/functions/bq.js');
const BQ_SRC = fs.readFileSync(BQ_PATH, 'utf8');

// Live columns the vision CTE may reference, per table alias.
const VISION_COLUMNS = new Set(['client', 'asset_id', 'status', 'on_screen_text']);
const MANIFEST_COLUMNS = new Set(['asset_key', 'ad_archive_id', 'f10_client']);

function loadHandler(queries) {
  class FakeBigQuery {
    async query(opts) { queries.push(opts); return [[]]; }
  }
  class FakeStorage {}
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

// A syntactically valid stub is enough because BigQuery/Storage are faked.
process.env.GOOGLE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'x@test', private_key: 'stub' });

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('competitor-search vision SQL');

  const queries = [];
  const handler = loadHandler(queries);
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ action: 'competitor-search', client: 'acme', term: 'sleep' }),
  });
  assert.strictEqual(res.statusCode, 200, `unexpected status ${res.statusCode}: ${res.body}`);
  const search = queries.find((q) => /adlib_competitor_vision_attributes/.test(q.query));
  assert.ok(search, 'search action must send a query that reads the vision table');
  const sql = search.query;
  const cte = (sql.match(/vision AS \(([\s\S]*?)\n\s*\),/) || [])[1];
  assert.ok(cte, 'search SQL must define a vision CTE');
  const code = cte.replace(/--.*$/gm, ''); // ignore SQL comments

  check('vision rows are filtered on client, not f10_client', () => {
    assert.ok(/\bv\.client\s*=\s*@client\b/.test(code), 'vision CTE must filter v.client = @client');
    assert.ok(!/(^|[^.\w])f10_client\b/.test(code), 'vision CTE must not use a bare f10_client');
    assert.ok(!/\bv\.f10_client\b/.test(code), 'vision table has no f10_client column');
  });

  check("only vision rows with status = 'ok' are used", () => {
    assert.ok(/\bv\.status\s*=\s*'ok'/.test(code), "vision CTE must filter v.status = 'ok'");
  });

  check('assets map to ads through the creative manifest', () => {
    assert.ok(/JOIN\s+`[^`]*\.adlib_creative_manifest`\s+m\b/.test(code), 'vision CTE must join adlib_creative_manifest as m');
    assert.ok(/\bm\.asset_key\s*=\s*v\.asset_id\b/.test(code), 'join must be m.asset_key = v.asset_id');
    assert.ok(/\bm\.f10_client\s*=\s*@client\b/.test(code), 'manifest must be scoped to m.f10_client = @client');
    assert.ok(/GROUP BY\s+m\.ad_archive_id\b/.test(code), 'vision CTE must group by m.ad_archive_id');
    assert.ok(!/\bv\.ad_archive_id\b/.test(code), 'vision table has no ad_archive_id column');
  });

  check('on_screen_text (ARRAY<STRING>) is flattened before aggregation', () => {
    assert.ok(/STRING_AGG\(\s*ARRAY_TO_STRING\(\s*v\.on_screen_text\b/.test(code),
      'on_screen_text must go through ARRAY_TO_STRING inside STRING_AGG');
  });

  check('every aliased column exists on its table', () => {
    for (const [, alias, col] of code.matchAll(/\b([vm])\.(\w+)/g)) {
      const cols = alias === 'v' ? VISION_COLUMNS : MANIFEST_COLUMNS;
      assert.ok(cols.has(col), `${alias}.${col} is not a live column of that table`);
    }
  });

  check('search stays metadata only and keeps its guardrails', () => {
    assert.ok(!/gcs_uri/.test(sql), 'search SQL must not select gcs_uri');
    assert.strictEqual(search.params.client, 'acme');
    assert.strictEqual(search.params.term, 'sleep');
    for (const q of queries) {
      assert.ok(q.maximumBytesBilled, 'query missing maximumBytesBilled guardrail');
      assert.ok(q.jobTimeoutMs, 'query missing jobTimeoutMs guardrail');
    }
  });

  console.log(`\ncompetitor-search vision SQL: ${passed} checks passed.`);
})().catch((e) => { console.error('\ncompetitor-search vision SQL FAILED:', (e && e.stack) || e); process.exit(1); });
