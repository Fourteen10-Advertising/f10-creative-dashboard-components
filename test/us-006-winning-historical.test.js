/**
 * US-006 (creative-pipeline): Netlify function, new-ad vs winning-historical join.
 *
 * Verifies the `action:'winning-historical'` handler in
 * starter/netlify/functions/bq.js: for a client plus a generated bundle it returns
 * that client's top-N winning historical ads (from {client}_reporting.creative_reporting)
 * with their policy metric and a signed image each, the winning component scoreboard
 * (from {client}_marts.component_performance), the new generated ad, the bundle's
 * coherence flags, and a so-what / now-what comparison. This test pins:
 *   - top-N winners returned for the RIGHT client, each with a signed image;
 *   - STRICT per-client scoping, a query for client A never reads client B's
 *     {client}_marts / {client}_reporting datasets (no cross-client pooling);
 *   - the revenue-gating policy: CPA is the default, ROAS ONLY for PharmX and
 *     FastCover, and a lead-gen (CPA) client never exposes conversion_value as
 *     revenue;
 *   - injection-safety of the client key (a value that cannot be a bound param);
 *   - AC4: the bundle's coherence flags ride alongside; and the insight-ladder
 *     L4/L5 so-what / now-what read is present.
 *
 * Dependency-free: the real bq.js is compiled with the two @google-cloud modules
 * stubbed by an in-memory fake that records every query and mints a fake signed
 * URL, so the handler's own JS behaviour is exercised end-to-end without network
 * or real credentials, the same harness as the sibling bq.js action tests.
 *
 * Run: node test/us-006-winning-historical.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BQ_PATH = path.join(ROOT, 'starter/netlify/functions/bq.js');
const BQ_SRC = fs.readFileSync(BQ_PATH, 'utf8');

/* Fake BigQuery: records every query() call (so guardrails/params/SQL can be
 * asserted) and returns canned rows via a router the test installs. A router that
 * throws simulates a warehouse error (e.g. a not-found table). */
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

// bq.js needs a service-account env var to proceed; a syntactically-valid stub is
// enough because BigQuery/Storage are faked.
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

/* Every backtick-quoted `project.dataset.table` reference across the queries. */
function backtickRefs(queries) {
  const refs = [];
  const re = /`([^`]+)`/g;
  for (const q of queries) {
    let m;
    while ((m = re.exec(q.query)) !== null) refs.push(m[1]);
  }
  return refs;
}

/* The per-client mart DATASETS touched across a set of recorded queries: the
 * dataset segment of each `project.dataset.table` ref that ends in _marts /
 * _reporting (so the `creative_reporting` TABLE name is never mistaken for a
 * dataset). This is the strict-per-client scoping surface. */
function martDatasetsTouched(queries) {
  const found = new Set();
  for (const ref of backtickRefs(queries)) {
    const parts = ref.split('.');
    const dataset = parts.length >= 3 ? parts[1] : (parts.length === 2 ? parts[0] : '');
    if (/_(?:marts|reporting)$/.test(dataset)) found.add(dataset);
  }
  return found;
}

/* A router covering the four reads the action makes: probe / winners / components /
 * images. Callers pass canned winner + component + image rows. */
function makeRouter({ winners = [], components = [], images = [], existsData } = {}) {
  return (opts) => {
    const sql = opts.query;
    if (/EXISTS\s*\(/.test(sql) && /component_performance/.test(sql)) {
      return [{ has_data: !!existsData }];
    }
    if (/creative_reporting/.test(sql)) return winners;
    if (/component_performance/.test(sql)) return components;
    if (/meta_creative_links|creative_manifest/.test(sql)) return images;
    return [];
  };
}

const SAMPLE_BUNDLE = {
  bundle_id: 'brief_mosh_ugchook_ab12cd',
  components: { format: 'ugc', angle: 'price', hook_style: 'question' },
  coherence_flags: ['angle held: price is unproven for this client'],
  held_dimensions: ['angle'],
};
const SAMPLE_NEW_AD = { bundle_id: 'brief_mosh_ugchook_ab12cd', preview_url: null, platform: 'meta' };

// A lead-gen (CPA) winners set: metric_value is CPA (lower is better).
function cpaWinners() {
  return [
    { ad_id: 'A1', ad_name: 'UGC hook A', is_active: true, creative_link: 'https://fb/A1', spend: 5000, metric_value: 22.5, conversions: 220 },
    { ad_id: 'A2', ad_name: 'Testimonial B', is_active: false, creative_link: 'https://fb/A2', spend: 3200, metric_value: 31.0, conversions: 100 },
    { ad_id: 'A3', ad_name: 'Static C', is_active: true, creative_link: 'https://fb/A3', spend: 1800, metric_value: 44.0, conversions: 40 },
  ];
}
function componentWinners() {
  return [
    { component: 'format', component_value: 'ugc', metric_type: 'cpa', cpa: 21.0, lift: 0.22, confidence_tier: 'high', label: 'Winning', asset_count: 12, spend: 40000 },
    { component: 'hook_style', component_value: 'question', metric_type: 'cpa', cpa: 25.0, lift: 0.10, confidence_tier: 'medium', label: 'Above baseline', asset_count: 6, spend: 18000 },
  ];
}
function imageRows(ids) {
  return ids.map((id) => ({ ad_id: id, asset_type: 'image', gcs_uri: `gs://f10-creative-assets/ads/${id}.jpg`, fetch_status: 'fetched' }));
}

(async () => {
  console.log('US-006 (creative-pipeline) new-ad vs winning-historical join');

  // ── Scenario 1: top-N winners for the right client, each with a signed image ──
  await check('returns top-N winners + component scoreboard + signed images for the client', async () => {
    const router = makeRouter({ winners: cpaWinners(), components: componentWinners(), images: imageRows(['A1', 'A2', 'A3']) });
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const signCalls = [];
    const handler = loadHandler(FakeBigQuery, makeFakeStorage(signCalls));

    const res = await handler(makeEvent({
      action: 'winning-historical', client: 'mosh', bundle: SAMPLE_BUNDLE, newAd: SAMPLE_NEW_AD, limit: 3,
    }));
    assert.strictEqual(res.statusCode, 200);
    const p = JSON.parse(res.body);

    assert.strictEqual(p.client, 'mosh');
    assert.strictEqual(p.limit, 3);
    assert.strictEqual(p.winners.length, 3, 'three winners returned');
    const w = p.winners[0];
    assert.strictEqual(w.ad_id, 'A1');
    assert.strictEqual(w.metric_type, 'cpa');
    assert.strictEqual(w.metric_value, 22.5);
    assert.ok(/^https:\/\/signed\.example\//.test(w.image_url), 'winner carries a signed image URL');
    assert.strictEqual(p.winners[2].image_url && p.winners[2].image_url.startsWith('https://signed'), true);
    assert.ok(p.winning_components.length >= 1, 'component scoreboard returned alongside');
    assert.deepStrictEqual(p.new_ad, SAMPLE_NEW_AD, 'the new generated ad is echoed alongside the winners');

    // The reads hit exactly this client's two datasets.
    const refs = backtickRefs(queries).join(' | ');
    assert.ok(/mosh_reporting\.creative_reporting/.test(refs), 'winners read mosh_reporting.creative_reporting');
    assert.ok(/mosh_marts\.component_performance/.test(refs), 'components read mosh_marts.component_performance');
    assert.ok(signCalls.length >= 1, 'images were signed');
    assertGuardrails(queries);
  });

  // ── Scenario 2: strict per-client scoping, A never reads B's datasets ──
  await check('strict per-client scoping: a query for client A reads only A\'s datasets', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(makeRouter({ winners: cpaWinners(), components: componentWinners(), images: imageRows(['A1', 'A2', 'A3']) }));
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    await handler(makeEvent({ action: 'winning-historical', client: 'mosh', bundle: SAMPLE_BUNDLE }));

    const datasets = martDatasetsTouched(queries);
    assert.deepStrictEqual([...datasets].sort(), ['mosh_marts', 'mosh_reporting'], 'only mosh_* mart datasets are touched');
    // Not one other tenant's dataset appears anywhere.
    for (const foreign of ['pharmx', 'fastcover', 'bridgit', 'matilda', 'stake']) {
      assert.ok(!datasets.has(`${foreign}_marts`) && !datasets.has(`${foreign}_reporting`), `no ${foreign} dataset leaks into a mosh query`);
    }
    // Every backtick table ref is either this client's dataset or the shared asset store.
    for (const ref of backtickRefs(queries)) {
      assert.ok(/^mcc-poc-477801\.(mosh_marts|mosh_reporting|all_clients)\./.test(ref), `unexpected table ref: ${ref}`);
    }
  });

  await check('a different client (bridgit) reads only bridgit datasets and defaults to CPA', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(makeRouter({ winners: cpaWinners(), components: componentWinners(), images: imageRows(['A1', 'A2', 'A3']) }));
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: 'bridgit', bundle: SAMPLE_BUNDLE }));
    const p = JSON.parse(res.body);
    assert.strictEqual(p.metric, 'cpa', 'bridgit is lead-gen -> CPA');
    assert.deepStrictEqual([...martDatasetsTouched(queries)].sort(), ['bridgit_marts', 'bridgit_reporting']);
  });

  // ── Scenario 3: revenue-gating policy, CPA default, ROAS only PharmX/FastCover ──
  await check('lead-gen client -> CPA, and no conversion_value is exposed as revenue', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(makeRouter({ winners: cpaWinners(), components: componentWinners(), images: [] }));
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: 'mosh', bundle: SAMPLE_BUNDLE }));
    const p = JSON.parse(res.body);
    assert.strictEqual(p.metric, 'cpa');
    assert.strictEqual(p.revenue_eligible, false);
    for (const w of p.winners) assert.ok(!('revenue' in w), 'a CPA winner must not carry a revenue field');
    // The winners query must select the CPA metric and NEVER a revenue / conversion_value column.
    const winnersSql = queries.map((q) => q.query).find((s) => /creative_reporting/.test(s));
    assert.ok(/lifetime_cpa/.test(winnersSql), 'CPA mode selects lifetime_cpa');
    assert.ok(!/revenue/.test(winnersSql), 'CPA mode must not select any revenue column');
    assert.ok(!/conversion_value/.test(winnersSql), 'raw conversion_value is forbidden by policy');
    // And the whole response body never leaks conversion_value or a revenue number.
    assert.ok(!/conversion_value/.test(res.body), 'response must not expose conversion_value');
  });

  for (const client of ['pharmx', 'fastcover']) {
    await check(`${client} -> ROAS, selects gated revenue and orders by ROAS desc`, async () => {
      const winners = [
        { ad_id: 'R1', ad_name: 'ROAS ad', is_active: true, creative_link: null, spend: 8000, metric_value: 4.2, conversions: 120, revenue: 33600 },
      ];
      const { FakeBigQuery, queries } = makeFakeBigQuery(makeRouter({ winners, components: componentWinners(), images: [] }));
      const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
      const res = await handler(makeEvent({ action: 'winning-historical', client, bundle: SAMPLE_BUNDLE }));
      const p = JSON.parse(res.body);
      assert.strictEqual(p.metric, 'roas', `${client} is revenue-eligible -> ROAS`);
      assert.strictEqual(p.revenue_eligible, true);
      assert.strictEqual(p.winners[0].metric_type, 'roas');
      assert.strictEqual(p.winners[0].revenue, 33600, 'gated revenue rides along in ROAS mode');
      const winnersSql = queries.map((q) => q.query).find((s) => /creative_reporting/.test(s));
      assert.ok(/lifetime_roas/.test(winnersSql), 'ROAS mode selects lifetime_roas');
      assert.ok(/SUM\(revenue\)/.test(winnersSql), 'ROAS mode selects the gated revenue column');
      assert.ok(/ORDER BY metric_value DESC/.test(winnersSql), 'ROAS is higher-is-better (DESC)');
    });
  }

  await check('metric allow-list is EXACTLY {pharmx, fastcover} (near-misses default to CPA)', async () => {
    for (const client of ['pharmxx', 'fastcove', 'mosh', 'pharm', 'coverfast']) {
      const { FakeBigQuery } = makeFakeBigQuery(makeRouter({ winners: [], components: [], images: [] }));
      const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
      const res = await handler(makeEvent({ action: 'winning-historical', client, bundle: SAMPLE_BUNDLE }));
      assert.strictEqual(JSON.parse(res.body).metric, 'cpa', `${client} must default to CPA`);
    }
  });

  await check('metric policy is case-insensitive on the client key (PharmX -> ROAS)', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(makeRouter({ winners: [], components: [], images: [] }));
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: 'PharmX', bundle: SAMPLE_BUNDLE }));
    const p = JSON.parse(res.body);
    assert.strictEqual(p.client, 'pharmx', 'client key is normalised to the dataset slug');
    assert.strictEqual(p.metric, 'roas');
    assert.deepStrictEqual([...martDatasetsTouched(queries)].sort(), ['pharmx_marts', 'pharmx_reporting']);
  });

  // ── Scenario 4: injection-safety of the client key ──
  await check('a SQL-injection client value is sanitised and cannot break out of the dataset id', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(makeRouter({ winners: cpaWinners(), components: componentWinners(), images: [] }));
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: 'mosh`; DROP TABLE secrets; --', bundle: SAMPLE_BUNDLE }));
    const p = JSON.parse(res.body);
    assert.strictEqual(p.client, 'moshdroptablesecrets', 'client is reduced to the [a-z0-9_] dataset charset');
    assert.strictEqual(p.metric, 'cpa', 'a garbage client is never revenue-eligible');
    const allSql = queries.map((q) => q.query).join('\n');
    assert.ok(!/;/.test(allSql), 'no semicolon from the injected payload survives into any query');
    assert.ok(!/DROP TABLE/i.test(allSql), 'the injected DROP TABLE statement cannot appear');
    // Every table ref stays inside the sanitised client datasets or the shared store.
    for (const ref of backtickRefs(queries)) {
      assert.ok(/^mcc-poc-477801\.(moshdroptablesecrets_marts|moshdroptablesecrets_reporting|all_clients)\./.test(ref), `escaped ref: ${ref}`);
    }
  });

  await check('a client that sanitises to empty is a 400 with no query run', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => { throw new Error('should not query without a valid client'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: '***', bundle: SAMPLE_BUNDLE }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(queries.length, 0);
  });

  await check('a missing client is a 400 with no query run', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => { throw new Error('should not query without a client'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', bundle: SAMPLE_BUNDLE }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(queries.length, 0);
  });

  // ── Scenario 5: AC4 coherence flags + insight-ladder L4/L5 read ──
  await check('the bundle coherence flags ride alongside and the L4/L5 so-what/now-what is present', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(makeRouter({ winners: cpaWinners(), components: componentWinners(), images: [] }));
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: 'mosh', bundle: SAMPLE_BUNDLE, newAd: SAMPLE_NEW_AD }));
    const p = JSON.parse(res.body);

    // AC4: coherence flags + held dimensions surfaced next to the comparison.
    assert.deepStrictEqual(p.bundle.coherence_flags, SAMPLE_BUNDLE.coherence_flags);
    assert.deepStrictEqual(p.comparison.coherence_flags, SAMPLE_BUNDLE.coherence_flags);
    assert.deepStrictEqual(p.comparison.held_dimensions, ['angle']);

    // L4/L5: aligned reuses a proven winner (format=ugc, hook_style=question), the
    // unproven price angle is flagged to hold/test, and a so-what/now-what read exists.
    const alignedComps = p.comparison.aligned_components.map((a) => a.component).sort();
    assert.deepStrictEqual(alignedComps, ['format', 'hook_style'], 'matched components are marked aligned');
    const unprovenComps = p.comparison.unproven_components.map((u) => u.component);
    assert.deepStrictEqual(unprovenComps, ['angle'], 'the unmatched price angle is flagged unproven');
    assert.ok(typeof p.comparison.so_what === 'string' && p.comparison.so_what.length > 0, 'so-what present');
    assert.ok(typeof p.comparison.now_what === 'string' && p.comparison.now_what.length > 0, 'now-what present');
    assert.ok(/CPA/.test(p.comparison.summary), 'summary states the metric context');
    assert.ok(p.comparison.top_winner && p.comparison.top_winner.ad_id === 'A1', 'the comparison names the top winner to test against');
  });

  // ── Scenario 6: probe existence check ──
  await check('probe reports exists true/false from the component scoreboard', async () => {
    const yes = makeFakeBigQuery(makeRouter({ existsData: true }));
    let handler = loadHandler(yes.FakeBigQuery, makeFakeStorage([]));
    let res = await handler(makeEvent({ action: 'winning-historical', client: 'mosh', probe: true }));
    assert.deepStrictEqual(JSON.parse(res.body), { exists: true });

    const no = makeFakeBigQuery(makeRouter({ existsData: false }));
    handler = loadHandler(no.FakeBigQuery, makeFakeStorage([]));
    res = await handler(makeEvent({ action: 'winning-historical', client: 'mosh', probe: true }));
    assert.deepStrictEqual(JSON.parse(res.body), { exists: false });
  });

  await check('probe on a client with no scoreboard table fails closed to exists:false', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => { throw Object.assign(new Error('Not found: Table mcc-poc-477801:newclient_marts.component_performance'), { code: 404 }); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: 'newclient', probe: true }));
    assert.deepStrictEqual(JSON.parse(res.body), { exists: false });
  });

  // ── Scenario 7: absent-safe, a not-yet-built mart is a clean empty join ──
  await check('a client whose reporting mart does not exist yet returns a clean empty join, not a 500', async () => {
    const { FakeBigQuery } = makeFakeBigQuery((opts) => {
      if (/creative_reporting/.test(opts.query)) {
        throw Object.assign(new Error('Not found: Table mcc-poc-477801:newclient_reporting.creative_reporting'), { code: 404 });
      }
      return [];
    });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: 'newclient', bundle: SAMPLE_BUNDLE }));
    assert.strictEqual(res.statusCode, 200);
    const p = JSON.parse(res.body);
    assert.deepStrictEqual(p.winners, [], 'no winners on an absent mart');
    assert.deepStrictEqual(p.winning_components, []);
    assert.strictEqual(p.metric, 'cpa');
    assert.ok(p.comparison && typeof p.comparison.summary === 'string', 'comparison still present on an empty join');
  });

  // ── Scenario 8: a genuine BigQuery error still surfaces as a 500 ──
  await check('a non-not-found BigQuery error surfaces as a 500 (never swallowed)', async () => {
    const { FakeBigQuery } = makeFakeBigQuery((opts) => {
      if (/creative_reporting/.test(opts.query)) throw new Error('quota exceeded');
      return [];
    });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage([]));
    const res = await handler(makeEvent({ action: 'winning-historical', client: 'mosh', bundle: SAMPLE_BUNDLE }));
    assert.strictEqual(res.statusCode, 500);
    assert.ok(/quota exceeded/.test(JSON.parse(res.body).error));
  });

  console.log(`\nUS-006 (creative-pipeline): ${passed} checks passed.`);
})().catch((e) => { console.error('\nUS-006 (creative-pipeline) FAILED:', e && e.stack || e); process.exit(1); });
