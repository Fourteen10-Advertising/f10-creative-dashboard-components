/**
 * US-007 — Netlify function: competitor-intelligence tab data actions.
 *
 * Verifies the five action-named handlers added to
 * starter/netlify/functions/bq.js — themes, age-timeseries, maturity, leaderboard,
 * net-new — that power the new dashboard tabs. Each is a thin read over a governed
 * all_clients_adlib mart, scoped WHERE f10_client=@client, that:
 *   - returns the expected non-empty payload shape for a populated client;
 *   - fails closed exactly like the competitor action — a probe returns { exists },
 *     and a client whose mart HAS NO ROWS or DOES NOT EXIST yet gets an empty
 *     payload rather than a 500;
 *   - carries the maximumBytesBilled + jobTimeoutMs guardrails on every query;
 *   - never leaks a gs:// URI or raw SQL to the browser;
 *   - for the decision-surface actions (maturity, themes) returns the explainable
 *     sub-scores / tier / narrative, not a bare number (insight-ladder-l4-l5-gate).
 *
 * Dependency-free: the real bq.js is compiled with the two @google-cloud modules
 * stubbed by an in-memory fake that records every query and routes canned rows, so
 * the handler's own JS behaviour is exercised end-to-end without network or creds.
 * Mirrors test/us-006-competitor-search.test.js.
 *
 * Run: node test/us-007-competitor-actions.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BQ_PATH = path.join(ROOT, 'starter/netlify/functions/bq.js');
const BQ_SRC = fs.readFileSync(BQ_PATH, 'utf8');

/* Fake BigQuery: records every query() call (so guardrails/params can be asserted)
 * and returns canned rows via a router the test installs. A router may throw to
 * simulate a table-not-found (fail-closed) or a genuine error. */
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

/* Fake Storage: unused by these actions (none sign creatives), but bq.js imports it
 * at module scope, so a stub must exist. */
function makeFakeStorage() {
  class FakeStorage {
    constructor(opts) { this.opts = opts; }
    bucket() { return { file() { return { async getSignedUrl() { return ['https://signed.example/x']; } }; } }; }
  }
  return FakeStorage;
}

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

// A BigQuery "table not found" error, used to prove the fail-closed / absent path.
function tableNotFound(name) {
  const e = new Error(`Not found: Table mcc-poc-477801:all_clients_adlib.${name} was not found in location australia-southeast1`);
  e.code = 404;
  return e;
}

process.env.GOOGLE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'x@test', private_key: 'k' });

let passed = 0;
function check(name, fn) { return fn().then(() => { passed++; console.log('  ok -', name); }); }

function assertGuardrails(queries) {
  assert.ok(queries.length > 0, 'expected at least one guardrailed query');
  for (const q of queries) {
    assert.ok(q.maximumBytesBilled, 'query missing maximumBytesBilled guardrail');
    assert.ok(q.jobTimeoutMs, 'query missing jobTimeoutMs guardrail');
    assert.strictEqual(q.useLegacySql, false, 'query must use standard SQL');
  }
}

// Every action must scope its non-probe read by the f10_client param.
function assertClientScoped(queries) {
  for (const q of queries) {
    assert.ok(q.params && q.params.client === 'mosh', 'query must pass through the client param');
    assert.ok(/f10_client\s*=\s*@client/.test(q.query), 'query must filter WHERE f10_client = @client');
  }
}

(async () => {
  console.log('US-007 competitor-intelligence tab data actions');

  // ─────────────────────────── themes ───────────────────────────
  await check('themes returns the full explainable theme summary per competitor', async () => {
    const router = (opts) => {
      assert.ok(/competitor_theme_summary/.test(opts.query), 'themes reads competitor_theme_summary');
      return [{
        page_id: 'P1', run_date: { value: '2026-07-01' },
        themes: JSON.stringify([{ name: 'Menopause relief', description: 'symptom relief angle', example_phrases: ['hot flush'] }]),
        dominant_narrative: 'Leans on symptom-relief, doctor-backed framing.',
        format_mix: JSON.stringify({ video: 8, image: 3 }),
        common_phrases: JSON.stringify(['clinically proven', 'as seen on']),
        analysis_confidence: 'high', vision_rows_summarised: 11,
        summary_model: 'vertex:gemini-2.5-pro', generated_at: { value: '2026-07-01T02:00:00Z' },
      }];
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'themes', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.competitors.length, 1);
    const c = payload.competitors[0];
    // Insight-ladder: the narrative + structured themes must be present, not a bare number.
    assert.ok(Array.isArray(c.themes) && c.themes[0].name === 'Menopause relief', 'themes parsed to structured array');
    assert.ok(/symptom-relief/.test(c.dominant_narrative), 'dominant narrative returned');
    assert.deepStrictEqual(c.format_mix, { video: 8, image: 3 }, 'format_mix parsed to object');
    assert.ok(c.common_phrases.includes('clinically proven'), 'common phrases returned');
    assert.strictEqual(c.analysis_confidence, 'high');
    assertGuardrails(queries);
    assertClientScoped(queries);
  });

  await check('themes probe returns exists flag from a cheap check', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery((opts) => {
      assert.ok(/EXISTS\(/.test(opts.query), 'probe hits an EXISTS check');
      return [{ has_data: true }];
    });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'themes', client: 'mosh', probe: true }));
    assert.deepStrictEqual(JSON.parse(res.body), { exists: true });
    assertGuardrails(queries);
  });

  await check('themes fails closed (empty) when the mart does not exist yet', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => { throw tableNotFound('competitor_theme_summary'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'themes', client: 'newclient' }));
    assert.strictEqual(res.statusCode, 200, 'absent mart must not 500');
    assert.deepStrictEqual(JSON.parse(res.body), { competitors: [] });
  });

  await check('themes missing client returns 400 without querying', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => { throw new Error('should not query'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'themes' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(queries.length, 0);
  });

  // ─────────────────────── age-timeseries ───────────────────────
  await check('age-timeseries splits the client line from competitor series', async () => {
    const router = (opts) => {
      assert.ok(/competitor_age_over_time/.test(opts.query), 'reads competitor_age_over_time');
      return [
        { entity_type: 'client', page_id: null, page_name: 'mosh', period_month: { value: '2026-06-01' }, ads_live: 5, avg_age_live_days: 40.5, median_age_live_days: 38 },
        { entity_type: 'competitor', page_id: 'P1', page_name: 'CompA', period_month: { value: '2026-06-01' }, ads_live: 9, avg_age_live_days: 120.2, median_age_live_days: 110 },
        { entity_type: 'competitor', page_id: 'P1', page_name: 'CompA', period_month: { value: '2026-07-01' }, ads_live: 10, avg_age_live_days: 130.0, median_age_live_days: 125 },
      ];
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'age-timeseries', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.client.length, 1, 'one client point');
    assert.strictEqual(payload.client[0].median_age_live_days, 38, 'median carried (not the average)');
    assert.strictEqual(payload.competitors.length, 1, 'one competitor page grouped');
    assert.strictEqual(payload.competitors[0].series.length, 2, 'both months in the competitor series');
    assert.strictEqual(payload.competitors[0].page_name, 'CompA');
    assertGuardrails(queries);
    assertClientScoped(queries);
  });

  await check('age-timeseries fails closed (empty) when the mart is absent', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => { throw tableNotFound('competitor_age_over_time'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'age-timeseries', client: 'newclient' }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { client: [], competitors: [] });
  });

  await check('age-timeseries probe returns exists:false for a no-data client', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => [{ has_data: false }]);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'age-timeseries', client: 'mosh', probe: true }));
    assert.deepStrictEqual(JSON.parse(res.body), { exists: false });
  });

  // ─────────────────────────── maturity ─────────────────────────
  await check('maturity returns composite + all six sub-scores + tier + rank (explainable)', async () => {
    const router = (opts) => {
      assert.ok(/competitor_meta_maturity/.test(opts.query), 'reads competitor_meta_maturity');
      return [
        {
          entity_type: 'competitor', entity_id: 'P1', page_id: 'P1', page_name: 'CompA',
          composite_score: 82.4, maturity_tier: 'Leading', maturity_rank: 1, set_size: 3,
          longevity_score: 90, cadence_score: 70, volume_score: 80, active_ratio_score: 85,
          format_diversity_score: 60, platform_spread_score: 75,
          volume_raw: 40, longevity_raw: 130.5, active_ratio_raw: 0.8, cadence_raw: 3.2, format_raw: 4, platform_raw: 3,
        },
        {
          entity_type: 'client', entity_id: 'mosh', page_id: null, page_name: 'mosh',
          composite_score: 55.1, maturity_tier: 'Developing', maturity_rank: 2, set_size: 3,
          longevity_score: 50, cadence_score: 60, volume_score: 55, active_ratio_score: 58,
          format_diversity_score: 50, platform_spread_score: 50,
          volume_raw: 20, longevity_raw: 60.0, active_ratio_raw: 0.6, cadence_raw: 2.0, format_raw: null, platform_raw: null,
        },
      ];
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'maturity', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.set_size, 3);
    assert.strictEqual(payload.competitors.length, 1);
    const comp = payload.competitors[0];
    assert.strictEqual(comp.composite_score, 82.4, 'composite returned');
    assert.strictEqual(comp.maturity_tier, 'Leading', 'data-layer tier label returned, not re-banded');
    assert.strictEqual(comp.maturity_rank, 1, 'rank returned');
    // Insight-ladder: all six explainable sub-scores present alongside the composite.
    for (const k of ['longevity', 'cadence', 'volume', 'active_ratio', 'format_diversity', 'platform_spread']) {
      assert.ok(typeof comp.sub_scores[k] === 'number', `sub-score ${k} present`);
    }
    assert.ok(comp.raw_signals && comp.raw_signals.longevity === 130.5, 'raw signals present for transparency');
    // The client's own row + rank within its set.
    assert.ok(payload.client, 'client row returned');
    assert.strictEqual(payload.client.maturity_rank, 2, "client's rank within its set");
    assert.strictEqual(payload.client.maturity_tier, 'Developing');
    assertGuardrails(queries);
    assertClientScoped(queries);
  });

  await check('maturity fails closed (client:null) when the mart is absent', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => { throw tableNotFound('competitor_meta_maturity'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'maturity', client: 'newclient' }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { client: null, competitors: [] });
  });

  await check('maturity probe returns exists:true when populated', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => [{ has_data: true }]);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'maturity', client: 'mosh', probe: true }));
    assert.deepStrictEqual(JSON.parse(res.body), { exists: true });
  });

  // ─────────────────────────── leaderboard ──────────────────────
  await check('leaderboard returns live ads ranked by age with a public snapshot_url only', async () => {
    const router = (opts) => {
      if (/EXISTS\(/.test(opts.query)) return [{ has_data: true }];
      assert.ok(/ad_registry/.test(opts.query) && /still_active/.test(opts.query), 'reads still-active ads from ad_registry');
      assert.strictEqual(opts.params.limit, 25, 'default limit applied');
      return [
        { ad_archive_id: 'A1', page_id: 'P1', page_name: 'CompA', display_format: 'VIDEO', snapshot_url: 'https://facebook.com/ads/library/?id=A1', first_seen_date: { value: '2025-01-01' }, days_active_observed: 100, live_age_days: 560 },
        { ad_archive_id: 'A2', page_id: 'P2', page_name: 'CompB', display_format: 'IMAGE', snapshot_url: 'https://facebook.com/ads/library/?id=A2', first_seen_date: { value: '2025-06-01' }, days_active_observed: 40, live_age_days: 410 },
      ];
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'leaderboard', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.ads.length, 2);
    assert.strictEqual(payload.ads[0].rank, 1, 'ranked from 1');
    assert.strictEqual(payload.ads[0].live_age_days, 560, 'ordered by age desc');
    assert.strictEqual(payload.ads[1].rank, 2);
    assert.ok(!/gs:\/\//.test(res.body), 'no gs:// URI leaked to the browser');
    assertGuardrails(queries);
  });

  await check('leaderboard clamps an over-cap limit to 100', async () => {
    const router = (opts) => {
      if (/EXISTS\(/.test(opts.query)) return [{ has_data: true }];
      assert.strictEqual(opts.params.limit, 100, 'limit clamped to the cap');
      return [];
    };
    const { FakeBigQuery } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'leaderboard', client: 'mosh', limit: 9999 }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ads: [] });
  });

  await check('leaderboard fails closed (empty) when the registry is absent', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => { throw tableNotFound('ad_registry'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'leaderboard', client: 'newclient' }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ads: [] });
  });

  await check('leaderboard missing client returns 400', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => { throw new Error('should not query'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'leaderboard' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(queries.length, 0);
  });

  // ─────────────────────────── net-new ──────────────────────────
  await check('net-new returns flagged new ads + per-competitor counts + window', async () => {
    const router = (opts) => {
      if (/competitor_net_new_ads/.test(opts.query) && !/net_new_count/.test(opts.query)) {
        assert.ok(/is_net_new/.test(opts.query), 'per-ad read filters to the net-new flag');
        return [
          { ad_archive_id: 'A1', page_id: 'P1', page_name: 'CompA', first_seen_date: { value: '2026-07-15' }, last_seen_date: { value: '2026-07-16' }, window_start_date: { value: '2026-07-10' }, window_end_date: { value: '2026-07-16' } },
        ];
      }
      if (/competitor_net_new_by_page/.test(opts.query)) {
        return [
          { page_id: 'P1', page_name: 'CompA', ads_total: 12, net_new_count: 3, window_start_date: { value: '2026-07-10' }, window_end_date: { value: '2026-07-16' } },
          { page_id: 'P2', page_name: 'CompB', ads_total: 8, net_new_count: 0, window_start_date: { value: '2026-07-10' }, window_end_date: { value: '2026-07-16' } },
        ];
      }
      return [];
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'net-new', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.ads.length, 1, 'one flagged net-new ad');
    assert.strictEqual(payload.byPage.length, 2, 'both competitors in the rollup');
    assert.strictEqual(payload.byPage[0].net_new_count, 3);
    assert.strictEqual(payload.byPage[1].net_new_count, 0, 'absent-safe zero, not null');
    assert.ok(payload.window && payload.window.end.value === '2026-07-16', 'window carried');
    assertGuardrails(queries);
    assertClientScoped(queries);
  });

  await check('net-new is absent-safe: no new ads returns empty ads + zero-count pages', async () => {
    const router = (opts) => {
      if (/competitor_net_new_ads/.test(opts.query) && !/net_new_count/.test(opts.query)) return [];
      if (/competitor_net_new_by_page/.test(opts.query)) {
        return [{ page_id: 'P1', page_name: 'CompA', ads_total: 12, net_new_count: 0, window_start_date: { value: '2026-07-10' }, window_end_date: { value: '2026-07-16' } }];
      }
      return [];
    };
    const { FakeBigQuery } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'net-new', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.deepStrictEqual(payload.ads, [], 'no flagged ads');
    assert.strictEqual(payload.byPage[0].net_new_count, 0);
    assert.ok(!('error' in payload), 'clean empty state, no error field');
  });

  await check('net-new fails closed (empty) when the mart is absent', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => { throw tableNotFound('competitor_net_new_ads'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'net-new', client: 'newclient' }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { ads: [], byPage: [] });
  });

  await check('net-new probe returns exists flag', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => [{ has_data: true }]);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'net-new', client: 'mosh', probe: true }));
    assert.deepStrictEqual(JSON.parse(res.body), { exists: true });
  });

  // A genuine (non-not-found) BigQuery error must NOT be swallowed (hq-never-swallow-errors).
  await check('a genuine BigQuery error surfaces as a 500, not a silent empty', async () => {
    const { FakeBigQuery } = makeFakeBigQuery(() => { throw new Error('quota exceeded: billing tier'); });
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'maturity', client: 'mosh' }));
    assert.strictEqual(res.statusCode, 500, 'real errors must be loud');
    assert.ok(/quota exceeded/.test(JSON.parse(res.body).error), 'error message preserved');
  });

  console.log(`\nUS-007: ${passed} checks passed.`);
})().catch((e) => { console.error('\nUS-007 FAILED:', e && e.stack || e); process.exit(1); });
