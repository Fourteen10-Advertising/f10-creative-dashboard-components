/**
 * TikTok custom target metric (TIKTOK.METRIC = 'CP2S') acceptance test.
 *
 * A brand-only TikTok account (Reach / Traffic, no conversions) grades ads on
 * cost per 2-second view instead of CPA. This pins:
 *   1. Default (no TIKTOK.METRIC) is byte-for-byte the legacy CPA output for every
 *      SQL builder, the dropdown and the benchmark copy.
 *   2. CP2S mode: the weekly prior window carries 2s views, the lifetime metric is
 *      spend / 2s views, Ad Production classifies against HR/OB/SO_METRIC
 *      ceilings, the creative score uses those bands, and the copy names the metric.
 *   3. Formatting: sub-dollar cost per 2s view shows 3 decimals.
 *   4. An unknown METRIC value is ignored (falls back to CPA).
 *
 * Dependency-free: loads the real f10-utils.js, f10-layout.js and f10-tiktok.js
 * into a vm sandbox with a minimal DOM stub (no browser, no BigQuery).
 *
 * Run: node test/tiktok-custom-metric.test.js
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

const BEYOND_TH = { HR_SPEND: 1000, OB_SPEND: 500, SO_SPEND: 250, HR_METRIC: 0.06, OB_METRIC: 0.08, SO_METRIC: 0.10 };

function makeCtx(tiktok){
  const slots = {};
  const el = () => ({ innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }, addEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; } });
  const sandbox = {
    window: {},
    console: { log(){}, error(){}, warn(){} },
    document: {
      getElementById(id){ return (slots[id] = slots[id] || el()); },
      querySelector(){ return null; }, querySelectorAll(){ return []; }, addEventListener(){},
      documentElement: { style: { cssText: '' } },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    PROJECT: 'mcc-poc-477801',
    DATASET: 'acme_marts',
    TIKTOK: tiktok,
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  vm.runInContext(TIKTOK_JS, sandbox, { filename: 'f10-tiktok.js' });
  return sandbox;
}
const I = (ctx) => ctx.window.f10TikTokInternals;

/* Every SQL string the TikTok engine builds, for byte-equivalence checks. */
function allSQL(ctx){
  const i = I(ctx), p = i.productionSQL(), d = i.decaySQL(), a = i.ageSQL();
  return {
    windows: i.windowsSQL('2026-11-04', '2026-11-10', '2026-10-28', '2026-11-03'),
    scatter: p.scatterSQL, monthly: p.monthlySQL, powerlaw: i.powerLawSQL(),
    decay: d.summarySQL, decayDaily: d.dailySQL, ageChart: a.ageSQL, ageTable: a.tableSQL,
    creative: i.creativeSQL(), cls: i.classificationCaseSQL('lifetime_spend', 'm'),
  };
}

let passed = 0;
function check(name, fn){
  try { fn(); console.log('  ok - ' + name); passed++; }
  catch (e){ console.error('  FAIL - ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('TikTok custom target metric (CP2S)');

const BASE = { TABLE: 'tiktok_creative_reporting' };

// ── Default stays CPA ──────────────────────────────────────────────────────
check('no METRIC: ttTargetMetricKey is null and ttMetricDef is CPA', () => {
  const ctx = makeCtx(BASE);
  assert.strictEqual(ctx.ttTargetMetricKey(), null);
  assert.strictEqual(ctx.ttMetricDef().label, 'CPA');
});

check('no METRIC: TikTok dropdown is the shared list unchanged', () => {
  const ctx = makeCtx(BASE);
  assert.strictEqual(ctx.ttEfficiencyMetricOptionsHTML(), ctx.efficiencyMetricOptionsHTML());
});

check('unknown METRIC is ignored: every SQL matches the default', () => {
  const def = allSQL(makeCtx(BASE));
  const odd = allSQL(makeCtx(Object.assign({}, BASE, { METRIC: 'NOPE' })));
  for (const k of Object.keys(def)) assert.strictEqual(odd[k], def[k], k);
});

check('no METRIC: lifetime metric is spend / conversions as lifetime_cpa at 2 dp', () => {
  const s = allSQL(makeCtx(BASE));
  assert.match(s.scatter, /ROUND\(SAFE_DIVIDE\(ANY_VALUE\(lifetime_spend\), NULLIF\(SUM\(conversions\), 0\)\), 2\) AS lifetime_cpa/);
  assert.doesNotMatch(s.scatter, /lifetime_metric/);
});

// ── CP2S mode ──────────────────────────────────────────────────────────────
const CP2S = Object.assign({}, BASE, { METRIC: 'cp2s', THRESHOLDS: BEYOND_TH });

check('CP2S: key resolves case-insensitively and def is lower-is-better on 2s views', () => {
  const ctx = makeCtx(CP2S);
  assert.strictEqual(ctx.ttTargetMetricKey(), 'CP2S');
  const m = ctx.ttMetricDef();
  assert.strictEqual(m.den, 'video_watched_2s');
  assert.strictEqual(m.dir, 'lower');
  assert.strictEqual(m.label, 'Cost / 2s view');
});

check('CP2S: dropdown leads with cost per 2s view, selected, others unselected', () => {
  const html = makeCtx(CP2S).ttEfficiencyMetricOptionsHTML();
  assert.ok(html.startsWith('<option value="CP2S" selected>Cost / 2s view</option>'));
  assert.strictEqual((html.match(/selected/g) || []).length, 1);
  assert.ok(html.includes('<option value="CPA">'));
});

check('CP2S: weekly SQL carries prior-window 2s views', () => {
  assert.match(allSQL(makeCtx(CP2S)).windows, /SUM\(IF\(date_start BETWEEN '2026-10-28' AND '2026-11-03', video_watched_2s, 0\)\)\s+AS pri_hook/);
});

check('CP2S: lifetime metric is spend / 2s views at 4 dp in every monthly tab', () => {
  const s = allSQL(makeCtx(CP2S));
  for (const k of ['scatter', 'ageTable', 'creative']) {
    assert.match(s[k], /ROUND\(SAFE_DIVIDE\(ANY_VALUE\(lifetime_spend\), NULLIF\(SUM\(video_watched_2s\), 0\)\), 4\) AS lifetime_metric/, k);
  }
  assert.match(s.powerlaw, /ROUND\(SAFE_DIVIDE\(SUM\(spend\), NULLIF\(SUM\(video_watched_2s\), 0\)\), 4\) AS lifetime_metric/);
  assert.match(s.monthly, /SUM\(video_watched_2s\) AS period_den/);
  assert.match(s.monthly, /ROUND\(SAFE_DIVIDE\(SUM\(period_spend\), NULLIF\(SUM\(period_den\), 0\)\), 4\) AS avg_cpa/);
  assert.match(s.decay, /SUM\(video_watched_2s\) AS ad_den/);
  assert.match(s.decay, /ROUND\(SAFE_DIVIDE\(SUM\(ad_spend\), NULLIF\(SUM\(ad_den\), 0\)\), 4\) AS cpa/);
  for (const k of Object.keys(s)) assert.doesNotMatch(s[k], /revenue/, k + ' must not read revenue');
});

check('CP2S: classification uses spend floors and metric ceilings', () => {
  const sql = allSQL(makeCtx(CP2S)).cls;
  assert.strictEqual(sql,
    "CASE WHEN lifetime_spend >= 1000 AND m > 0 AND m < 0.06 THEN 'Home Run' " +
    "WHEN lifetime_spend >= 500 AND m > 0 AND m < 0.08 THEN 'On Base' " +
    "WHEN lifetime_spend >= 250 AND m > 0.1 THEN 'Strike Out' ELSE 'Unclassified' END");
});

check('CP2S: creative score efficiency uses the metric bands, not CPA globals', () => {
  const ctx = makeCtx(CP2S);
  const opts = I(ctx).scoreOpts();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(opts.lowerBands)), { hr: 0.06, ob: 0.08, so: 0.1, hrSpend: 1000 });
  const sql = ctx.creativeScoreSQL('lifetime_spend', 'lifetime_metric', opts);
  assert.ok(sql.includes('(0.08 - lifetime_metric)'), 'upper band from OB_METRIC');
  assert.ok(!sql.includes('(100 - lifetime_metric)'), 'no CPA OB band');
  // JS mirror agrees: a $0.05 ad is fully efficient, a $0.12 ad scores 0 efficiency.
  const good = ctx.creativeScoreParts({ spend: 1000, metric: 0.05 }, opts);
  const bad = ctx.creativeScoreParts({ spend: 1000, metric: 0.12 }, opts);
  assert.strictEqual(good.efficiency, 1);
  assert.strictEqual(bad.efficiency, 0);
});

check('CP2S: Ad Production benchmark names the metric and bands', () => {
  const ctx = makeCtx(CP2S);
  const th = Object.assign({}, I(ctx).thresholds);
  assert.strictEqual(ctx.ttProdBenchmarkHTML(th),
    '<span class="bm-item"><strong>Home Run:</strong> Spend &ge; $1,000 &amp; Cost / 2s view &lt; $0.06</span>' +
    '<span class="bm-item"><strong>On Base:</strong> Spend &ge; $500 &amp; Cost / 2s view &lt; $0.08</span>' +
    '<span class="bm-item"><strong>Strike Out:</strong> Spend &ge; $250 &amp; Cost / 2s view &gt; $0.10</span>');
});

check('CP2S: sub-dollar values show 3 decimals; other money metrics unchanged', () => {
  const ctx = makeCtx(CP2S);
  assert.strictEqual(ctx.ttFmtMetricCell(0.0612), '$0.061');
  assert.strictEqual(ctx.ttFmtMetricCell(0.1), '$0.10');
  assert.strictEqual(ctx.fmtMetric(0.0612, ctx.METRICS ? ctx.METRICS.CPC : vm.runInContext('METRICS.CPC', ctx)), '$0.06');
});

console.log(`\n${passed} passed`);
