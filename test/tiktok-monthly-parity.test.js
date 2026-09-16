/**
 * TikTok monthly-parity acceptance test.
 *
 * Covers the four tabs added to bring TikTok to full eight-tab parity with the Meta
 * engine: Movement Map, Ad Power Law, Ad Decay, Ad Age.
 *
 * WHY THIS FILE IS EXHAUSTIVE. There is currently NO real TikTok data anywhere in the
 * BigQuery project — no client has a `tiktok_creative_reporting`-shaped table with
 * real rows, and no live client dashboard has a TIKTOK config enabled. So unlike the
 * LinkedIn tabs, NONE of this SQL has been dry-run or executed against real data.
 * These assertions on the generated SQL strings — the source read, the joins, the
 * grouping, the column references, and the columns that must NOT appear because the
 * normalised TikTok contract does not define them — are the only correctness evidence
 * the TikTok tabs have. Treat a failure here as a real regression, not test noise.
 *
 * Dependency-free: loads the real f10-utils.js / f10-layout.js / f10-tiktok.js into a
 * vm sandbox with a minimal DOM stub and exercises the exported globals directly
 * (no browser, no BigQuery). Same pattern as test/linkedin-channel.test.js.
 *
 * Run: node test/tiktok-monthly-parity.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const LAYOUT = fs.readFileSync(path.join(ROOT, 'f10-layout.js'), 'utf8');
const TIKTOK_JS = fs.readFileSync(path.join(ROOT, 'f10-tiktok.js'), 'utf8');

function makeCtx(opts){
  opts = opts || {};
  const slots = {};
  const sandbox = {
    window: {},
    console: { log(){}, error(){}, warn(){} },
    document: {
      getElementById(id){ return (slots[id] = slots[id] || { innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }, addEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; } }); },
      querySelector(){ return null; },
      querySelectorAll(){ return []; },
      addEventListener(){},
      documentElement: { style: { cssText: '' } },
    },
    _slots: slots,
  };
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  sandbox.PROJECT = 'mcc-poc-477801';
  sandbox.DATASET = 'acme_marts';
  if (opts.targetMetric !== undefined) sandbox.TARGET_METRIC = opts.targetMetric;
  sandbox.TIKTOK = opts.tiktok !== undefined
    ? opts.tiktok
    : { TABLE: 'tiktok_creative_reporting' };
  if (opts.tiktok === null) delete sandbox.TIKTOK;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  vm.runInContext(TIKTOK_JS, sandbox, { filename: 'f10-tiktok.js' });
  /* Top-level `const`s in a vm script live in the context's lexical scope, not on the
   * sandbox object, so read the shared palette back out by evaluating its name. */
  sandbox.ageColors = vm.runInContext('AGE_COLORS', sandbox);
  return sandbox;
}
const internals = (ctx) => ctx.window.f10TikTokInternals;

/* Every query the four new tabs generate, in one place — so a shape rule can be
 * asserted across ALL of them rather than one at a time. */
function everyNewQuery(I){
  const d = I.decaySQL(), a = I.ageSQL();
  return {
    powerlaw: I.powerLawSQL(),
    decaySummary: d.summarySQL,
    decayDaily: d.dailySQL,
    ageChart: a.ageSQL,
    ageTable: a.tableSQL,
  };
}

let passed = 0;
function check(name, fn){
  try { fn(); console.log('  ok - ' + name); passed++; }
  catch (e){ console.error('  FAIL - ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('TikTok monthly parity (Movement Map / Ad Power Law / Ad Decay / Ad Age)');

// ── Config gate: the new tabs do not leak into a TikTok-less dashboard ─────
check('no TIKTOK config: still a total no-op, no new tabs or panels', () => {
  const ctx = makeCtx({ tiktok: null });
  assert.strictEqual(typeof ctx.window.initTikTok, 'undefined', 'initTikTok must not be defined');
  assert.strictEqual(typeof internals(ctx), 'undefined', 'no internals seam without config');
  ctx.renderLayout();
  const html = ctx._slots['app'].innerHTML;
  ['tt-map', 'tt-powerlaw', 'tt-decay', 'tt-age'].forEach((t) => {
    assert.ok(!html.includes('panel-' + t), 'no panel for ' + t);
    assert.ok(!html.includes('data-tt-tab="' + t + '"'), 'no nav link for ' + t);
  });
  assert.ok(html.includes('data-tab="map"'), 'the Meta Movement Map is still there');
});

// ── Eight-tab parity: the tab list, titles and nav order ───────────────────
check('TT_TABS is the full eight-tab set in the Meta order', () => {
  assert.deepStrictEqual(Array.from(internals(makeCtx()).tabs), [
    'tt-summary', 'tt-board', 'tt-map',
    'tt-powerlaw', 'tt-production', 'tt-decay', 'tt-age', 'tt-creative',
  ]);
});

check('every tab has a page title, and the four new ones are named like Meta', () => {
  const I = internals(makeCtx());
  I.tabs.forEach((t) => assert.ok(I.titles[t], 'title for ' + t));
  assert.strictEqual(I.titles['tt-map'], 'TikTok · Movement Map');
  assert.strictEqual(I.titles['tt-powerlaw'], 'TikTok · Ad Power Law');
  assert.strictEqual(I.titles['tt-decay'], 'TikTok · Ad Decay');
  assert.strictEqual(I.titles['tt-age'], 'TikTok · Ad Age');
});

check('the Movement Map is a WEEKLY tab; the other three are monthly', () => {
  const I = internals(makeCtx());
  ['tt-summary', 'tt-board', 'tt-map'].forEach((t) => assert.strictEqual(I.isWeekly(t), true, t + ' is weekly'));
  ['tt-powerlaw', 'tt-production', 'tt-decay', 'tt-age', 'tt-creative'].forEach((t) => assert.strictEqual(I.isWeekly(t), false, t + ' is monthly'));
});

check('renderLayout emits a nav link and a panel for all eight tabs', () => {
  const ctx = makeCtx();
  ctx.renderLayout();
  const html = ctx._slots['app'].innerHTML;
  internals(ctx).tabs.forEach((t) => {
    assert.ok(html.includes('id="panel-' + t + '"'), 'panel for ' + t);
    assert.ok(html.includes('data-tt-tab="' + t + '"'), 'nav link for ' + t);
  });
});

check('nav order mirrors Meta: Map after Board, then a Monthly divider, then PL/Prod/Decay/Age/CE', () => {
  const ctx = makeCtx();
  ctx.renderLayout();
  const html = ctx._slots['app'].innerHTML;
  const at = (s) => { const i = html.indexOf(s); assert.notStrictEqual(i, -1, 'present: ' + s); return i; };
  const order = [
    'data-tt-tab="tt-summary"', 'data-tt-tab="tt-board"', 'data-tt-tab="tt-map"',
    '<div class="nav-section">TikTok - Monthly</div>',
    'data-tt-tab="tt-powerlaw"', 'data-tt-tab="tt-production"', 'data-tt-tab="tt-decay"',
    'data-tt-tab="tt-age"', 'data-tt-tab="tt-creative"',
  ].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], 'nav item ' + i + ' follows the previous one');
  /* Both channel dividers are now explicitly labelled, matching Meta's 'Meta - Weekly' /
   * 'Meta - Monthly' headers, so an existing TikTok sidebar's header text does change
   * (from 'TikTok' to 'TikTok - Weekly') — deliberate, per explicit request. */
  assert.ok(at('<div class="nav-section">TikTok - Weekly</div>') < order[0], 'the TikTok weekly header still leads the group');
  /* And the whole TikTok group still sits after the Meta nav. */
  assert.ok(at('data-tab="summary"') < at('<div class="nav-section">TikTok - Weekly</div>'), 'Meta nav comes first');
});

check('the four new panels carry the DOM ids their loaders write into', () => {
  const ctx = makeCtx();
  const html = ctx.ttPanelsMarkup(internals(ctx).thresholds);
  [ /* Movement Map */
    'tt-map-window-note', 'tt-map-loading', 'tt-map-wrapper', 'tt-map-chart',
    /* Ad Power Law */
    'tt-powerlaw-chart-loading', 'tt-powerlaw-chart-wrapper', 'tt-powerlaw-chart',
    'tt-powerlaw-table-loading', 'tt-powerlaw-table', 'tt-powerlaw-table-body',
    /* Ad Decay */
    'tt-decay-summary-loading', 'tt-decay-summary-table', 'tt-decay-summary-body',
    'tt-decay-chart-loading', 'tt-decay-chart-wrapper', 'tt-decay-chart',
    'tt-decay-pct-loading', 'tt-decay-pct-wrapper', 'tt-decay-pct-chart',
    /* Ad Age */
    'tt-age-chart-loading', 'tt-age-chart-wrapper', 'tt-age-chart',
    'tt-age-table-loading', 'tt-age-table', 'tt-age-table-body',
  ].forEach((id) => assert.ok(html.includes('id="' + id + '"'), 'DOM id present: ' + id));
});

check('every id the TikTok section emits stays tt-scoped (no Meta/LinkedIn collision)', () => {
  const ctx = makeCtx();
  const html = ctx.ttPanelsMarkup(internals(ctx).thresholds) + ctx.ttControlsMarkup();
  (html.match(/id="([^"]+)"/g) || []).forEach((raw) => {
    const id = raw.slice(4, -1);
    assert.ok(id.startsWith('tt-') || id.startsWith('panel-tt-'), 'tt-scoped id: ' + id);
  });
  assert.ok(!/id="li-/.test(html), 'no li- ids');
});

// ── BUILD ITEM 1: Movement Map ────────────────────────────────────────────
check('Movement Map adds NO query — it reuses the weekly movers array', () => {
  const I = internals(makeCtx());
  assert.strictEqual(typeof I.mapSQL, 'undefined', 'there must be no map SQL builder at all');
  /* The tab dispatcher must not fire a load for tt-map: it is already rendered by
   * the weekly render pass, so dispatching would be a redundant second render. */
  assert.ok(!/tab === 'tt-map'/.test(TIKTOK_JS), 'ttLoadTab does not dispatch tt-map');
  assert.ok(/ttRenderMap\(movers, c\)/.test(TIKTOK_JS), 'ttRenderWeekly renders the map from the SAME movers array');
  assert.ok(/ttLoaded\['tt-map'\] = true/.test(TIKTOK_JS), 'boot marks the map loaded alongside summary/board');
});

check('Movement Map renders a bubble chart keyed by ad state, sized by spend', () => {
  const body = TIKTOK_JS.slice(TIKTOK_JS.indexOf('function ttRenderMap'), TIKTOK_JS.indexOf('Ad Production (lifetime spend'));
  assert.ok(/type: 'bubble'/.test(body), 'bubble chart');
  assert.ok(/a\.improvePct != null && a\.sCur > 0/.test(body), 'only ads with a comparable metric and current spend');
  assert.ok(/y: a\.improvePct \* 100/.test(body), 'y is the % efficiency change vs prior');
  assert.ok(/STATE_META\[s\]\.color/.test(body), 'colour comes from the shared ad-state palette');
  assert.ok(/6 \+ 22 \* Math\.sqrt/.test(body), 'bubble radius scales with sqrt of spend share, as on Meta');
  assert.ok(/id: 'zeroLine'/.test(body), 'the no-change reference line is drawn');
});

// ── BUILD ITEM 2: Ad Power Law ────────────────────────────────────────────
check('Power Law: 90-day window, spend rank and rolling cumulative share', () => {
  const sql = internals(makeCtx()).powerLawSQL();
  assert.ok(sql.includes('`mcc-poc-477801.acme_marts.tiktok_creative_reporting`'), 'reads the TikTok mart');
  assert.ok(sql.includes("date_start >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)"), '90-day window');
  assert.ok(sql.includes('ROW_NUMBER() OVER (ORDER BY a.period_spend DESC) AS rank_num'), 'rank by period spend');
  assert.ok(sql.includes('SAFE_DIVIDE(a.period_spend, t.grand_total) * 100, 2) AS spend_pct'), 'per-ad share of spend');
  assert.ok(sql.includes('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW'), 'rolling cumulative frame');
  assert.ok(sql.includes('AS rolling_pct'), 'cumulative % column');
  assert.ok(/total AS \( SELECT SUM\(period_spend\) AS grand_total FROM ad_spend \)/.test(sql), 'grand total from the same 90-day CTE');
  assert.ok(sql.includes('HAVING period_spend > 0'), 'ads with no spend in the window are not ranked');
});

check('Power Law: divides through SAFE_DIVIDE so a zero-spend window cannot error', () => {
  const sql = internals(makeCtx()).powerLawSQL();
  assert.ok(!/a\.period_spend\/t\.grand_total/.test(sql), 'no bare division by the grand total');
  assert.strictEqual((sql.match(/SAFE_DIVIDE\(a\.period_spend, t\.grand_total\)/g) || []).length, 2, 'both the share and the rolling share are guarded');
});

check('Power Law: CPA mode uses lifetime_cpa; ROAS mode switches to lifetime_roas', () => {
  const cpa = internals(makeCtx()).powerLawSQL();
  assert.ok(/AS lifetime_cpa/.test(cpa) && !/lifetime_roas/.test(cpa), 'CPA column in CPA mode');
  assert.ok(cpa.includes('SAFE_DIVIDE(SUM(spend), NULLIF(SUM(conversions), 0))'), 'CPA is spend / conversions');
  const roas = internals(makeCtx({ targetMetric: 'roas' })).powerLawSQL();
  assert.ok(/AS lifetime_roas/.test(roas) && !/lifetime_cpa/.test(roas), 'ROAS column in ROAS mode');
  assert.ok(roas.includes('SAFE_DIVIDE(SUM(revenue), NULLIF(SUM(spend), 0))'), 'ROAS is gated revenue / spend');
});

// ── BUILD ITEM 3: Ad Decay ────────────────────────────────────────────────
check('Decay: cohorts are launch months, rolled up from a per-ad CTE', () => {
  const { summarySQL } = internals(makeCtx()).decaySQL();
  assert.ok(/WITH per_ad AS \(/.test(summarySQL), 'collapses to one row per ad first');
  assert.ok(summarySQL.includes('MIN(min_date) AS launch_date'), 'launch date is the lifetime min');
  assert.ok(summarySQL.includes("FORMAT_DATE('%b %Y', launch_date) AS launch_month"), 'cohort label');
  assert.ok(summarySQL.includes('DATE_TRUNC(launch_date, MONTH) AS launch_month_sort'), 'cohort sort key');
  assert.ok(summarySQL.includes('COUNT(DISTINCT ad_id) AS ads_launched'), 'cohort size');
  assert.ok(summarySQL.includes('ROUND(AVG(DATE_DIFF(COALESCE(last_active_date, CURRENT_DATE()), launch_date, DAY)), 0) AS avg_days_running'), 'avg days running is a true per-ad average');
  assert.ok(/GROUP BY 1, 2 ORDER BY 2 DESC/.test(summarySQL), 'grouped and sorted by cohort month');
});

check('Decay: the per-ad last active day is MAX(date_start) — the contract has no max_date', () => {
  const { summarySQL } = internals(makeCtx()).decaySQL();
  assert.ok(summarySQL.includes('MAX(date_start) AS last_active_date'), 'derived from the daily rows');
  assert.ok(!/max_date/.test(summarySQL), 'never references a max_date column');
});

check('Decay: the daily curve is spend per cohort per day', () => {
  const { dailySQL } = internals(makeCtx()).decaySQL();
  assert.ok(dailySQL.includes("FORMAT_DATE('%b %Y', min_date) AS launch_month"), 'cohort from the per-row lifetime min_date');
  assert.ok(dailySQL.includes('date_start, ROUND(SUM(spend), 2) AS daily_spend'), 'daily spend per cohort');
  assert.ok(/GROUP BY 1, 2, 3 ORDER BY 3, 2/.test(dailySQL), 'one row per cohort per day, date-ordered');
});

check('Decay: cohort efficiency is CPA in CPA mode and ROAS in ROAS mode, aliased `cpa` either way', () => {
  const cpa = internals(makeCtx()).decaySQL().summarySQL;
  assert.ok(cpa.includes('ROUND(SAFE_DIVIDE(SUM(ad_spend), NULLIF(SUM(ad_conversions), 0)), 0) AS cpa'), 'CPA at 0 dp');
  assert.ok(!/revenue/.test(cpa), 'CPA mode never selects revenue (a lead-gen mart has no such column)');
  const roas = internals(makeCtx({ targetMetric: 'roas' })).decaySQL().summarySQL;
  assert.ok(roas.includes('SUM(revenue) AS revenue'), 'ROAS mode carries revenue into the per-ad CTE');
  assert.ok(roas.includes('ROUND(SAFE_DIVIDE(SUM(revenue), NULLIF(SUM(ad_spend), 0)), 2) AS cpa'), 'ROAS at 2 dp, same alias');
});

// ── BUILD ITEM 4: Ad Age ──────────────────────────────────────────────────
check('Age: the bucket is DERIVED from days since launch, not a creative_age column', () => {
  const { ageSQL } = internals(makeCtx()).ageSQL();
  assert.ok(!/creative_age/.test(ageSQL), 'the normalised TikTok contract has no creative_age column');
  assert.ok(ageSQL.includes('DATE_DIFF(date_start, min_date, DAY) <= 14'), '0–14 boundary');
  assert.ok(ageSQL.includes('DATE_DIFF(date_start, min_date, DAY) <= 90'), '15–90 boundary');
  assert.ok(ageSQL.includes('AS age_bucket'), 'aliased to the render contract');
});

check('Age: the three bucket labels match the shared AGE_COLORS keys exactly', () => {
  const ctx = makeCtx();
  const I = internals(ctx);
  assert.deepStrictEqual(Array.from(I.ageBuckets), ['0–14 Days', '15–90 Days', '90+ Days']);
  /* The chart looks each label up in AGE_COLORS — a mismatched dash would silently
   * paint every bar `undefineddd`, so pin the keys to the palette. */
  I.ageBuckets.forEach((b) => assert.ok(ctx.ageColors[b], 'AGE_COLORS has a colour for ' + b));
  I.ageBuckets.forEach((b) => assert.ok(I.ageSQL().ageSQL.includes("'" + b + "'"), 'SQL emits the label ' + b));
});

check('Age: AGE_BUCKET_EXPR overrides the derived bucket verbatim', () => {
  const expr = "CASE WHEN creative_age IN ('1. 0-7 Days') THEN '0–14 Days' ELSE '90+ Days' END";
  const I = internals(makeCtx({ tiktok: { TABLE: 'tiktok_creative_reporting', AGE_BUCKET_EXPR: expr } }));
  assert.strictEqual(I.ageBucketSQL(), expr, 'the whole expression is pasted, not parsed');
  const { ageSQL } = I.ageSQL();
  assert.ok(ageSQL.includes(expr + ' AS age_bucket'), 'the override reaches the generated SQL');
  assert.ok(!/DATE_DIFF\(date_start, min_date, DAY\)/.test(ageSQL), 'the derived default is replaced, not appended');
});

check('Age: a blank / non-string AGE_BUCKET_EXPR falls back to the derived default', () => {
  [' ', '', null, 0, {}].forEach((v) => {
    const I = internals(makeCtx({ tiktok: { TABLE: 'tiktok_creative_reporting', AGE_BUCKET_EXPR: v } }));
    assert.ok(I.ageBucketSQL().includes('DATE_DIFF(date_start, min_date, DAY)'), 'derived default for ' + JSON.stringify(v));
  });
});

check('Age: the per-ad library carries launch, last spend, spend, metric and conversions', () => {
  const { tableSQL } = internals(makeCtx()).ageSQL();
  ['MIN(min_date) AS launch_date', 'MAX(date_start) AS last_spend',
   'ANY_VALUE(creative_link) AS preview_link', 'ANY_VALUE(lifetime_spend), 2) AS lifetime_spend',
   'AS lifetime_cpa', 'AS total_conversions'].forEach((frag) => assert.ok(tableSQL.includes(frag), 'selects ' + frag));
  assert.ok(/GROUP BY 1 ORDER BY lifetime_spend DESC/.test(tableSQL), 'one row per ad, biggest spender first');
  assert.ok(tableSQL.includes('ANY_VALUE(adgroup_name) AS adgroup_name'), 'TikTok splits by ad group, not Meta adset');
});

// ── Cross-cutting: every new query obeys the TikTok contract ───────────────
check('every new query reads the resolved TikTok source', () => {
  const I = internals(makeCtx({ tiktok: { DATASET: 'skip_marts', TABLE: 'tt_custom' } }));
  Object.entries(everyNewQuery(I)).forEach(([name, sql]) =>
    assert.ok(sql.includes('FROM `mcc-poc-477801.skip_marts.tt_custom`'), name + ' reads the configured mart'));
});

check('every new query references ONLY columns the normalised TikTok contract defines', () => {
  /* The Meta engine's column names are the trap: the Meta mart has max_date,
   * creative_age, adset_name and Meta-shaped video columns; the TikTok mart has none
   * of them. With no live TikTok table to fail against, this is the guard. */
  const FORBIDDEN = ['max_date', 'creative_age', 'adset_name', 'video_15s', 'video_p100', 'outbound_clicks', 'video_plays'];
  const I = internals(makeCtx());
  Object.entries(everyNewQuery(I)).forEach(([name, sql]) => {
    FORBIDDEN.forEach((col) => assert.ok(!new RegExp('\\b' + col + '\\b').test(sql), name + ' must not reference Meta-only column `' + col + '`'));
  });
});

check('every new query balances its parentheses', () => {
  const I = internals(makeCtx({ targetMetric: 'roas' }));
  Object.entries(everyNewQuery(I)).forEach(([name, sql]) => {
    const open = (sql.match(/\(/g) || []).length, close = (sql.match(/\)/g) || []).length;
    assert.strictEqual(open, close, name + ': parens balance (' + open + ' vs ' + close + ')');
  });
});

check('CONV_EXPR flows into every new conversion aggregate', () => {
  const I = internals(makeCtx({ tiktok: { TABLE: 'tiktok_creative_reporting', CONV_EXPR: 'complete_payment' } }));
  assert.ok(I.powerLawSQL().includes('SUM(complete_payment)'), 'power law metric');
  assert.ok(I.decaySQL().summarySQL.includes('SUM(complete_payment) AS ad_conversions'), 'decay cohort metric');
  assert.ok(I.ageSQL().tableSQL.includes('SUM(complete_payment), 0) AS total_conversions'), 'age table conversions');
  Object.entries(everyNewQuery(I)).forEach(([name, sql]) =>
    assert.ok(!/SUM\(conversions\)/.test(sql), name + ' does not fall back to the default conversions column'));
});

check('CPA mode never SELECTs a revenue column in any new query', () => {
  const I = internals(makeCtx());
  Object.entries(everyNewQuery(I)).forEach(([name, sql]) =>
    assert.ok(!/\brevenue\b/.test(sql), name + ' must not touch revenue in CPA mode'));
});

check('ROAS mode uses the gated revenue column and never raw conversion_value', () => {
  const I = internals(makeCtx({ targetMetric: 'roas', tiktok: { TABLE: 'tiktok_creative_reporting', REVENUE_EXPR: 'gated_revenue' } }));
  assert.ok(I.powerLawSQL().includes('SUM(gated_revenue)'), 'power law reads the gated column');
  assert.ok(I.decaySQL().summarySQL.includes('SUM(gated_revenue) AS revenue'), 'decay reads the gated column');
  Object.entries(everyNewQuery(I)).forEach(([name, sql]) =>
    assert.ok(!/conversion_value/.test(sql), name + ' never sums raw conversion_value (hard policy)'));
});

// ── The pre-existing four tabs are unchanged by the refactor ───────────────
check('the pre-existing tabs still generate the same SQL after the builder split', () => {
  const I = internals(makeCtx());
  const ref = '`mcc-poc-477801.acme_marts.tiktok_creative_reporting`';
  const p = I.productionSQL();
  assert.ok(I.maxDateSQL().includes("MAX(date_start)) AS max_date FROM " + ref), 'max date');
  const w = I.windowsSQL('2026-09-08', '2026-09-14', '2026-09-01', '2026-09-07');
  assert.ok(w.includes("date_start BETWEEN '2026-09-08' AND '2026-09-14'") && w.includes('HAVING cur_spend > 0 OR pri_spend > 0'), 'windows');
  assert.ok(p.scatterSQL.includes('WITH per_ad AS (') && p.scatterSQL.includes('AS classification'), 'production scatter');
  assert.ok(p.monthlySQL.includes('COUNTIF(classification=\'Home Run\') AS home_runs'), 'production rollup');
  assert.ok(I.creativeSQL().includes('WHERE impressions > 0 AND video_play_actions > 0'), 'creative effectiveness');
});

console.log(`\nTikTok monthly parity: ${passed} checks passed.`);
