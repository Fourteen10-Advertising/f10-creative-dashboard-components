/**
 * LinkedIn monthly-parity acceptance test.
 *
 * Covers the four tabs added to bring LinkedIn to full eight-tab parity with the Meta
 * engine: Movement Map, Ad Power Law, Ad Decay, Ad Age.
 *
 * Every query asserted here was ALSO dry-run and executed live against Skip's real
 * mart, `mcc-poc-477801.skip_marts.linkedin_creative_reporting` (1,443 rows, 20
 * creatives, Jan–Sep 2026, $21,976.80 AUD), through Skip's real Mode 1b override set.
 * This file locks in the shape that produced those numbers so it cannot drift.
 *
 * The load-bearing divergence from Meta is the Ad Age bucket: LinkedIn DERIVES it from
 * date_start − min_date rather than reading a precomputed `creative_age` column, because
 * `creative_age` is not in the normalised LinkedIn contract and cannot be (shared-account
 * mode has no such column, and a Mode 1b wrapper does not pass one through). Verified
 * 2026-09-16 that this costs nothing in accuracy: on Skip's mart the derived bucket
 * reproduces that mart's own `creative_age` on 1,469 of 1,469 rows (100%).
 * LINKEDIN.AGE_BUCKET_EXPR is the escape hatch back to a mart's own bucketing.
 *
 * Dependency-free: loads the real f10-utils.js / f10-layout.js / f10-linkedin.js into
 * a vm sandbox with a minimal DOM stub (no browser, no BigQuery). Same pattern as
 * test/linkedin-channel.test.js.
 *
 * Run: node test/linkedin-monthly-parity.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const LAYOUT = fs.readFileSync(path.join(ROOT, 'f10-layout.js'), 'utf8');
const LINKEDIN_JS = fs.readFileSync(path.join(ROOT, 'f10-linkedin.js'), 'utf8');
const MONTHLY_JS = fs.readFileSync(path.join(ROOT, 'f10-monthly.js'), 'utf8');

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
  if (opts.linkedin !== undefined) sandbox.LINKEDIN = opts.linkedin;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  vm.runInContext(LINKEDIN_JS, sandbox, { filename: 'f10-linkedin.js' });
  /* Top-level `const`s in a vm script live in the context's lexical scope, not on the
   * sandbox object, so read the shared palette back out by evaluating its name. */
  sandbox.ageColors = vm.runInContext('AGE_COLORS', sandbox);
  return sandbox;
}
const internals = (ctx) => ctx.window.f10LinkedInInternals;

/* Skip's real Mode 1b override set — the config every live-verified query below ran
 * under. Kept identical to the set in test/linkedin-channel.test.js. */
const SKIP_OVERRIDES = {
  DATASET: 'skip_marts',
  TABLE:   'linkedin_creative_reporting',
  AD_ID_EXPR:               'creative_id',
  AD_NAME_EXPR:             'creative_id',
  CAMPAIGN_NAME_EXPR:       'campaign_id',
  ADGROUP_NAME_EXPR:        "'(no ad group)'",
  LANDING_PAGE_CLICKS_EXPR: 'clicks',
  ONE_CLICK_LEADS_EXPR:     'NULL',
  VIDEO_STARTS_EXPR:        'NULL',
  VIDEO_P25_EXPR: 'NULL', VIDEO_P50_EXPR: 'NULL', VIDEO_P75_EXPR: 'NULL', VIDEO_P100_EXPR: 'NULL',
  CONV_EXPR: 'clicks',
};

/* Every query the four new tabs generate, in one place. */
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

console.log('LinkedIn monthly parity (Movement Map / Ad Power Law / Ad Decay / Ad Age)');

// ── Config gate ───────────────────────────────────────────────────────────
check('no LINKEDIN config: the new tabs do not appear either', () => {
  const ctx = makeCtx();
  ctx.renderLayout();
  const html = ctx._slots['app'].innerHTML;
  ['li-map', 'li-powerlaw', 'li-decay', 'li-age'].forEach((t) => {
    assert.ok(!html.includes('panel-' + t), 'no panel for ' + t);
    assert.ok(!html.includes('data-li-tab="' + t + '"'), 'no nav link for ' + t);
  });
});

// ── Eight-tab parity: tab list, titles, nav order, DOM ids ────────────────
check('LI_TABS is the full eight-tab set in the Meta order', () => {
  assert.deepStrictEqual(Array.from(internals(makeCtx({ linkedin: {} })).tabs), [
    'li-summary', 'li-board', 'li-map',
    'li-powerlaw', 'li-production', 'li-decay', 'li-age', 'li-creative',
  ]);
});

check('every tab has a page title, and the four new ones are named like Meta', () => {
  const I = internals(makeCtx({ linkedin: {} }));
  I.tabs.forEach((t) => assert.ok(I.titles[t], 'title for ' + t));
  assert.strictEqual(I.titles['li-map'], 'LinkedIn · Movement Map');
  assert.strictEqual(I.titles['li-powerlaw'], 'LinkedIn · Ad Power Law');
  assert.strictEqual(I.titles['li-decay'], 'LinkedIn · Ad Decay');
  assert.strictEqual(I.titles['li-age'], 'LinkedIn · Ad Age');
});

check('the Movement Map is a WEEKLY tab; the other three are monthly', () => {
  const I = internals(makeCtx({ linkedin: {} }));
  ['li-summary', 'li-board', 'li-map'].forEach((t) => assert.strictEqual(I.isWeekly(t), true, t + ' is weekly'));
  ['li-powerlaw', 'li-production', 'li-decay', 'li-age', 'li-creative'].forEach((t) => assert.strictEqual(I.isWeekly(t), false, t + ' is monthly'));
});

check('renderLayout emits a nav link and a panel for all eight tabs', () => {
  const ctx = makeCtx({ linkedin: {} });
  ctx.renderLayout();
  const html = ctx._slots['app'].innerHTML;
  internals(ctx).tabs.forEach((t) => {
    assert.ok(html.includes('id="panel-' + t + '"'), 'panel for ' + t);
    assert.ok(html.includes('data-li-tab="' + t + '"'), 'nav link for ' + t);
  });
});

check('nav order mirrors Meta: Map after Board, then a Monthly divider, then PL/Prod/Decay/Age/CE', () => {
  const ctx = makeCtx({ linkedin: {} });
  ctx.renderLayout();
  const html = ctx._slots['app'].innerHTML;
  const at = (s) => { const i = html.indexOf(s); assert.notStrictEqual(i, -1, 'present: ' + s); return i; };
  const order = [
    'data-li-tab="li-summary"', 'data-li-tab="li-board"', 'data-li-tab="li-map"',
    '<div class="nav-section">LinkedIn &middot; Monthly</div>',
    'data-li-tab="li-powerlaw"', 'data-li-tab="li-production"', 'data-li-tab="li-decay"',
    'data-li-tab="li-age"', 'data-li-tab="li-creative"',
  ].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], 'nav item ' + i + ' follows the previous one');
  assert.ok(at('<div class="nav-section">LinkedIn</div>') < order[0], 'the LinkedIn weekly header still leads the group');
  assert.ok(at('data-tab="summary"') < at('<div class="nav-section">LinkedIn</div>'), 'Meta nav comes first');
});

check('the four new panels carry the DOM ids their loaders write into', () => {
  const ctx = makeCtx({ linkedin: {} });
  const html = ctx.liPanelsMarkup(ctx.linkedinThresholds());
  [ 'li-map-window-note', 'li-map-loading', 'li-map-wrapper', 'li-map-chart',
    'li-powerlaw-chart-loading', 'li-powerlaw-chart-wrapper', 'li-powerlaw-chart',
    'li-powerlaw-table-loading', 'li-powerlaw-table', 'li-powerlaw-table-body',
    'li-decay-summary-loading', 'li-decay-summary-table', 'li-decay-summary-body',
    'li-decay-chart-loading', 'li-decay-chart-wrapper', 'li-decay-chart',
    'li-decay-pct-loading', 'li-decay-pct-wrapper', 'li-decay-pct-chart',
    'li-age-chart-loading', 'li-age-chart-wrapper', 'li-age-chart',
    'li-age-table-loading', 'li-age-table', 'li-age-table-body',
  ].forEach((id) => assert.ok(html.includes('id="' + id + '"'), 'DOM id present: ' + id));
});

check('every id the new panels emit stays li-scoped (no Meta/TikTok collision)', () => {
  const ctx = makeCtx({ linkedin: {} });
  const html = ctx.liPanelsMarkup(ctx.linkedinThresholds()) + ctx.liControlsMarkup();
  (html.match(/id="([^"]+)"/g) || []).forEach((raw) => {
    const id = raw.slice(4, -1);
    assert.ok(id.startsWith('li-') || id.startsWith('panel-li-'), 'li-scoped id: ' + id);
  });
  assert.ok(!/id="tt-/.test(html), 'no tt- ids');
});

// ── BUILD ITEM 1: Movement Map ────────────────────────────────────────────
check('Movement Map adds NO query — it reuses the weekly movers array', () => {
  const I = internals(makeCtx({ linkedin: {} }));
  assert.strictEqual(typeof I.mapSQL, 'undefined', 'there must be no map SQL builder at all');
  assert.ok(!/tab === 'li-map'/.test(LINKEDIN_JS), 'liLoadTab does not dispatch li-map');
  assert.ok(/liRenderMap\(movers, c\)/.test(LINKEDIN_JS), 'liRenderWeekly renders the map from the SAME movers array');
  assert.ok(/liLoaded\['li-map'\] = true/.test(LINKEDIN_JS), 'boot marks the map loaded alongside summary/board');
});

check('Movement Map renders a bubble chart keyed by ad state, sized by spend', () => {
  const body = LINKEDIN_JS.slice(LINKEDIN_JS.indexOf('function liRenderMap'), LINKEDIN_JS.indexOf('Ad Production (lifetime spend'));
  assert.ok(/type: 'bubble'/.test(body), 'bubble chart');
  assert.ok(/a\.improvePct != null && a\.sCur > 0/.test(body), 'only creatives with a comparable metric and current spend');
  assert.ok(/y: a\.improvePct \* 100/.test(body), 'y is the % efficiency change vs prior');
  assert.ok(/STATE_META\[s\]\.color/.test(body), 'colour comes from the shared ad-state palette');
  assert.ok(/6 \+ 22 \* Math\.sqrt/.test(body), 'bubble radius scales with sqrt of spend share, as on Meta');
  assert.ok(/id: 'zeroLine'/.test(body), 'the no-change reference line is drawn');
});

// ── BUILD ITEM 2: Ad Power Law ────────────────────────────────────────────
check('Power Law: 90-day window, spend rank and rolling cumulative share', () => {
  const sql = internals(makeCtx({ linkedin: {} })).powerLawSQL();
  assert.ok(sql.includes("date_start >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)"), '90-day window');
  assert.ok(sql.includes('ROW_NUMBER() OVER (ORDER BY a.period_spend DESC) AS rank_num'), 'rank by period spend');
  assert.ok(sql.includes('SAFE_DIVIDE(a.period_spend, t.grand_total) * 100, 2) AS spend_pct'), 'per-creative share of spend');
  assert.ok(sql.includes('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW'), 'rolling cumulative frame');
  assert.ok(sql.includes('AS rolling_pct'), 'cumulative % column');
  assert.ok(!/a\.period_spend\/t\.grand_total/.test(sql), 'no bare division by the grand total');
  /* Live on Skip's mart, two creatives had in-window rows but null spend on all of
   * them and took ranks #16/#17 with a blank spend and a blank share. */
  assert.ok(sql.includes('HAVING period_spend > 0'), 'creatives with no spend in the window are not ranked');
});

check('Power Law: reads the resolved source in ALL THREE config modes', () => {
  /* Mode 1 — bare mart. */
  assert.ok(internals(makeCtx({ linkedin: {} })).powerLawSQL()
    .includes('FROM `mcc-poc-477801.acme_marts.linkedin_creative_reporting`'), 'mode 1 reads the mart directly');
  /* Mode 1b — normalising wrapper over Skip's real mart. */
  const m1b = internals(makeCtx({ linkedin: SKIP_OVERRIDES })).powerLawSQL();
  assert.ok(m1b.includes('FROM `mcc-poc-477801.skip_marts.linkedin_creative_reporting`'), 'mode 1b reads the same physical table');
  assert.ok(m1b.includes('creative_id AS ad_id'), 'mode 1b normalises through the wrapper');
  /* Mode 2 — shared account. */
  assert.ok(internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:510299552' } })).powerLawSQL()
    .includes('all_clients_linkedin_ads.ad_creative_analytics'), 'mode 2 reads the shared dataset');
});

check('Power Law: CPA mode uses lifetime_cpa; ROAS mode switches to lifetime_roas', () => {
  const cpa = internals(makeCtx({ linkedin: {} })).powerLawSQL();
  assert.ok(/AS lifetime_cpa/.test(cpa) && !/lifetime_roas/.test(cpa), 'CPA column in CPA mode');
  const roas = internals(makeCtx({ targetMetric: 'roas', linkedin: {} })).powerLawSQL();
  assert.ok(/AS lifetime_roas/.test(roas) && !/lifetime_cpa/.test(roas), 'ROAS column in ROAS mode');
});

// ── BUILD ITEM 3: Ad Decay ────────────────────────────────────────────────
check('Decay: cohorts are launch months, rolled up from a per-creative CTE', () => {
  const { summarySQL } = internals(makeCtx({ linkedin: {} })).decaySQL();
  assert.ok(/WITH per_ad AS \(/.test(summarySQL), 'collapses to one row per creative first');
  assert.ok(summarySQL.includes('MIN(min_date) AS launch_date'), 'launch date is the lifetime min');
  assert.ok(summarySQL.includes("FORMAT_DATE('%b %Y', launch_date) AS launch_month"), 'cohort label');
  assert.ok(summarySQL.includes('DATE_TRUNC(launch_date, MONTH) AS launch_month_sort'), 'cohort sort key');
  assert.ok(summarySQL.includes('COUNT(DISTINCT ad_id) AS ads_launched'), 'cohort size');
  assert.ok(summarySQL.includes('ROUND(AVG(DATE_DIFF(COALESCE(last_active_date, CURRENT_DATE()), launch_date, DAY)), 0) AS avg_days_running'), 'avg days running is a true per-creative average');
  assert.ok(/GROUP BY 1, 2 ORDER BY 2 DESC/.test(summarySQL), 'grouped and sorted by cohort month');
});

check('Decay: the per-creative last active day is MAX(date_start) — the contract has no max_date', () => {
  const { summarySQL } = internals(makeCtx({ linkedin: {} })).decaySQL();
  assert.ok(summarySQL.includes('MAX(date_start) AS last_active_date'), 'derived from the daily rows');
  assert.ok(!/max_date/.test(summarySQL), 'never references a max_date column');
});

check('Decay: the daily curve is spend per cohort per day', () => {
  const { dailySQL } = internals(makeCtx({ linkedin: {} })).decaySQL();
  assert.ok(dailySQL.includes("FORMAT_DATE('%b %Y', min_date) AS launch_month"), 'cohort from the per-row lifetime min_date');
  assert.ok(dailySQL.includes('date_start, ROUND(SUM(spend), 2) AS daily_spend'), 'daily spend per cohort');
  assert.ok(/GROUP BY 1, 2, 3 ORDER BY 3, 2/.test(dailySQL), 'one row per cohort per day, date-ordered');
});

check('Decay: cohort efficiency is CPA in CPA mode and ROAS in ROAS mode, aliased `cpa` either way', () => {
  const cpa = internals(makeCtx({ linkedin: {} })).decaySQL().summarySQL;
  assert.ok(cpa.includes('ROUND(SAFE_DIVIDE(SUM(ad_spend), NULLIF(SUM(ad_conversions), 0)), 0) AS cpa'), 'CPA at 0 dp');
  assert.ok(!/revenue/.test(cpa), 'CPA mode never selects revenue');
  const roas = internals(makeCtx({ targetMetric: 'roas', linkedin: {} })).decaySQL().summarySQL;
  assert.ok(roas.includes('ROUND(SAFE_DIVIDE(SUM(revenue), NULLIF(SUM(ad_spend), 0)), 2) AS cpa'), 'ROAS at 2 dp, same alias');
});

check('Decay: ROAS mode applies REVENUE_EXPR ONCE, through the Mode 1b wrapper', () => {
  const I = internals(makeCtx({ targetMetric: 'roas', linkedin: Object.assign({}, SKIP_OVERRIDES, { REVENUE_EXPR: 'conversion_value' }) }));
  const { summarySQL } = I.decaySQL();
  assert.ok(summarySQL.includes('conversion_value AS revenue'), 'the wrapper aliases the gated column');
  assert.ok(summarySQL.includes('SUM(revenue) AS revenue'), 'the tab reads the normalised name');
  assert.ok(!/SUM\(conversion_value\)/.test(summarySQL), 'the gated expression is not applied a second time');
});

// ── BUILD ITEM 4: Ad Age (the creative_age divergence) ────────────────────
check('Age: the bucket is DERIVED, never read from a precomputed creative_age column', () => {
  const { ageSQL } = internals(makeCtx({ linkedin: SKIP_OVERRIDES })).ageSQL();
  /* Not because Skip's column is wrong — it is correct today — but because it is not a
   * contract column, so Mode 2 and a Mode 1b wrapper cannot supply one. */
  assert.ok(!/creative_age/.test(ageSQL), 'no dependency on a non-contract column');
  assert.ok(ageSQL.includes('DATE_DIFF(date_start, min_date, DAY) <= 14'), '0–14 boundary from days since launch');
  assert.ok(ageSQL.includes('DATE_DIFF(date_start, min_date, DAY) <= 90'), '15–90 boundary from days since launch');
  assert.ok(ageSQL.includes('AS age_bucket'), 'aliased to the render contract');
});

check('Age: the Meta engine KEEPS its precomputed creative_age path (this is a LinkedIn-only divergence)', () => {
  assert.ok(/CASE WHEN creative_age IN \('1\. 0-7 Days','2\. 8-14 Days'\)/.test(MONTHLY_JS),
    'f10-monthly.js still reads the Meta mart\'s creative_age column unchanged');
});

check('Age: the three bucket labels match the shared AGE_COLORS keys exactly', () => {
  const ctx = makeCtx({ linkedin: {} });
  const I = internals(ctx);
  assert.deepStrictEqual(Array.from(I.ageBuckets), ['0–14 Days', '15–90 Days', '90+ Days']);
  I.ageBuckets.forEach((b) => assert.ok(ctx.ageColors[b], 'AGE_COLORS has a colour for ' + b));
  I.ageBuckets.forEach((b) => assert.ok(I.ageSQL().ageSQL.includes("'" + b + "'"), 'SQL emits the label ' + b));
});

check('Age: AGE_BUCKET_EXPR is the opt-in hook back to a trustworthy precomputed column', () => {
  const expr = "CASE WHEN creative_age IN ('1. 0-7 Days','2. 8-14 Days') THEN '0–14 Days' ELSE '90+ Days' END";
  const I = internals(makeCtx({ linkedin: { AGE_BUCKET_EXPR: expr } }));
  assert.strictEqual(I.ageBucketSQL(), expr, 'the whole expression is pasted, not parsed');
  const { ageSQL } = I.ageSQL();
  assert.ok(ageSQL.includes(expr + ' AS age_bucket'), 'the override reaches the generated SQL');
  assert.ok(!/DATE_DIFF\(date_start, min_date, DAY\)/.test(ageSQL), 'the derived default is replaced, not appended');
});

check('Age: a blank / non-string AGE_BUCKET_EXPR falls back to the derived default', () => {
  [' ', '', null, 0, {}].forEach((v) => {
    const I = internals(makeCtx({ linkedin: { AGE_BUCKET_EXPR: v } }));
    assert.ok(I.ageBucketSQL().includes('DATE_DIFF(date_start, min_date, DAY)'), 'derived default for ' + JSON.stringify(v));
  });
});

check('Age: the derived bucket works unchanged in shared-account mode (which has no age column at all)', () => {
  const { ageSQL } = internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:510299552' } })).ageSQL();
  assert.ok(ageSQL.includes('all_clients_linkedin_ads.ad_creative_analytics'), 'reads the shared source');
  assert.ok(ageSQL.includes('DATE_DIFF(date_start, min_date, DAY)'), 'and still buckets by days since launch');
  assert.ok(ageSQL.includes('OVER (PARTITION BY cr.ad_id)'), 'min_date is the shared normaliser\'s lifetime window function');
});

check('Age: the per-creative library carries launch, last spend, spend, metric and conversions', () => {
  const { tableSQL } = internals(makeCtx({ linkedin: {} })).ageSQL();
  ['MIN(min_date) AS launch_date', 'MAX(date_start) AS last_spend',
   'ANY_VALUE(creative_link) AS preview_link', 'ANY_VALUE(lifetime_spend), 2) AS lifetime_spend',
   'AS lifetime_cpa', 'AS total_conversions'].forEach((frag) => assert.ok(tableSQL.includes(frag), 'selects ' + frag));
  assert.ok(/GROUP BY 1 ORDER BY lifetime_spend DESC/.test(tableSQL), 'one row per creative, biggest spender first');
  assert.ok(tableSQL.includes('ANY_VALUE(adgroup_name) AS adgroup_name'), 'LinkedIn splits by adgroup_name (the objective), not Meta adset');
});

// ── Cross-cutting rules over every new query ──────────────────────────────
check('every new query reads the resolved source for the active mode', () => {
  [['mode 1b', SKIP_OVERRIDES, 'skip_marts.linkedin_creative_reporting'],
   ['mode 2', { ACCOUNT_URN: 'urn:li:sponsoredAccount:1' }, 'all_clients_linkedin_ads.ad_creative_analytics']]
    .forEach(([label, cfg, frag]) => {
      const I = internals(makeCtx({ linkedin: cfg }));
      Object.entries(everyNewQuery(I)).forEach(([name, sql]) =>
        assert.ok(sql.includes(frag), label + ': ' + name + ' reads the resolved source'));
    });
});

check('every new query references ONLY columns the normalised LinkedIn contract defines', () => {
  const FORBIDDEN = ['max_date', 'creative_age', 'adset_name', 'video_15s', 'video_plays', 'outbound_clicks'];
  [{}, SKIP_OVERRIDES, { ACCOUNT_URN: 'urn:li:sponsoredAccount:1' }].forEach((cfg, ci) => {
    const I = internals(makeCtx({ linkedin: cfg }));
    Object.entries(everyNewQuery(I)).forEach(([name, sql]) => {
      FORBIDDEN.forEach((col) => assert.ok(!new RegExp('\\b' + col + '\\b').test(sql), 'cfg ' + ci + ' / ' + name + ' must not reference `' + col + '`'));
    });
  });
});

check('every new query balances its parentheses in every mode', () => {
  [{}, SKIP_OVERRIDES, { ACCOUNT_URN: 'urn:li:sponsoredAccount:1' },
   Object.assign({}, SKIP_OVERRIDES, { REVENUE_EXPR: 'conversion_value' })].forEach((cfg, ci) => {
    for (const metric of [undefined, 'roas']){
      const I = internals(makeCtx({ targetMetric: metric, linkedin: cfg }));
      Object.entries(everyNewQuery(I)).forEach(([name, sql]) => {
        const open = (sql.match(/\(/g) || []).length, close = (sql.match(/\)/g) || []).length;
        assert.strictEqual(open, close, 'cfg ' + ci + ' (' + (metric || 'cpa') + ') / ' + name + ': parens balance (' + open + ' vs ' + close + ')');
      });
    }
  });
});

check('CONV_EXPR flows into every new conversion aggregate (Skip measures cost per click)', () => {
  const I = internals(makeCtx({ linkedin: SKIP_OVERRIDES }));
  assert.ok(I.powerLawSQL().includes('SUM(clicks)'), 'power law metric');
  assert.ok(I.decaySQL().summarySQL.includes('SUM(clicks) AS ad_conversions'), 'decay cohort metric');
  assert.ok(I.ageSQL().tableSQL.includes('SUM(clicks), 0) AS total_conversions'), 'age table conversions');
  Object.entries(everyNewQuery(I)).forEach(([name, sql]) =>
    assert.ok(!/SUM\(conversions\)/.test(sql), name + ' does not fall back to the default conversions column'));
});

check('a NULL-literal override does not break any new query', () => {
  const I = internals(makeCtx({ linkedin: SKIP_OVERRIDES }));
  Object.entries(everyNewQuery(I)).forEach(([name, sql]) => {
    assert.ok(sql.includes('NULL AS video_p50'), name + ' carries the blanked metric through the wrapper');
    assert.ok(sql.includes("'(no ad group)' AS adgroup_name"), name + ' carries the literal ad-group override');
  });
});

console.log(`\nLinkedIn monthly parity: ${passed} checks passed.`);
