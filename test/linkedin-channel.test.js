/**
 * LinkedIn channel acceptance test.
 *
 * Covers the guarantees the LinkedIn section has to hold:
 *   1. CONFIG GATE — with no LINKEDIN config the module is a total no-op (no
 *      initLinkedIn, no nav group, no panels), so every existing Meta-only and
 *      Meta+TikTok dashboard is byte-for-byte unaffected by the new script tag.
 *   2. TWO SOURCE MODES — the SQL builder reads a per-client mart by default, and
 *      switches to the shared all_clients_linkedin_ads dataset when ACCOUNT_URN is
 *      set. ACCOUNT_URN WINS: DATASET/TABLE are ignored in shared-account mode.
 *   3. SHARED-ACCOUNT SQL SHAPE — the joins, the account scope, costInLocalCurrency
 *      as spend, and the feed permalink are the verified-against-live-data forms.
 *   4. LinkedIn-specific metric mapping and thresholds do not leak into, or inherit
 *      from, the Meta/TikTok ones.
 *
 * Dependency-free: loads the real f10-utils.js / f10-layout.js / f10-linkedin.js into
 * a vm sandbox with a minimal DOM stub and exercises the exported globals directly
 * (no browser, no BigQuery).
 *
 * Run: node test/linkedin-channel.test.js
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

/* Minimal DOM stub: enough for the modules to load and for the markup builders to
 * run. Nothing here touches the network or a real document. */
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
  return sandbox;
}
const internals = (ctx) => ctx.window.f10LinkedInInternals;

let passed = 0;
function check(name, fn){
  try { fn(); console.log('  ok - ' + name); passed++; }
  catch (e){ console.error('  FAIL - ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('LinkedIn channel');

// ── 1. Config gate ─────────────────────────────────────────────────────────
check('no LINKEDIN config: module is a total no-op', () => {
  const ctx = makeCtx();
  assert.strictEqual(ctx.linkedinEnabled(), false, 'gate must be closed');
  assert.strictEqual(typeof ctx.window.initLinkedIn, 'undefined', 'initLinkedIn must not be defined');
  assert.strictEqual(typeof internals(ctx), 'undefined', 'no internals seam without config');
});

check('no LINKEDIN config: renderLayout emits no LinkedIn nav or panels', () => {
  const ctx = makeCtx();
  ctx.renderLayout();
  const html = ctx._slots['app'].innerHTML;
  assert.ok(!html.includes('li-nav-link'), 'no LinkedIn nav links');
  assert.ok(!html.includes('panel-li-summary'), 'no LinkedIn panels');
  assert.ok(!html.includes('li-controls-bar'), 'no LinkedIn controls bar');
  assert.ok(html.includes('data-tab="summary"'), 'the Meta nav is still there');
});

check('LINKEDIN config present: nav group, controls bar and four panels render', () => {
  const ctx = makeCtx({ linkedin: {} });
  assert.strictEqual(ctx.linkedinEnabled(), true);
  assert.strictEqual(typeof ctx.window.initLinkedIn, 'function', 'initLinkedIn is exported');
  ctx.renderLayout();
  const html = ctx._slots['app'].innerHTML;
  assert.ok(html.includes('<div class="nav-section">LinkedIn</div>'), 'LinkedIn nav group');
  assert.ok(html.includes('id="li-controls-bar"'), 'LinkedIn controls bar');
  internals(ctx).tabs.forEach((t) => {
    assert.ok(html.includes('id="panel-' + t + '"'), 'panel for ' + t);
    assert.ok(html.includes('data-li-tab="' + t + '"'), 'nav link for ' + t);
  });
  /* Nav order: channels append, so an existing TikTok sidebar does not reshuffle. */
  assert.ok(html.indexOf('data-tab="summary"') < html.indexOf('data-li-tab="li-summary"'), 'Meta nav comes first');
});

check('an empty LINKEDIN object is enough (no TABLE required, unlike TIKTOK)', () => {
  const ctx = makeCtx({ linkedin: {} });
  assert.strictEqual(internals(ctx).source(), '`mcc-poc-477801.acme_marts.linkedin_creative_reporting`');
});

// ── 2. Two source modes ────────────────────────────────────────────────────
check('mode 1: per-client mart honours DATASET / TABLE / PROJECT', () => {
  const ctx = makeCtx({ linkedin: { PROJECT: 'other-proj', DATASET: 'skip_marts', TABLE: 'li_custom' } });
  assert.strictEqual(ctx.linkedinSharedAccount(), false);
  assert.strictEqual(internals(ctx).source(), '`other-proj.skip_marts.li_custom`');
});

check('mode 2: ACCOUNT_URN switches to the shared dataset', () => {
  const ctx = makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:510299552' } });
  assert.strictEqual(ctx.linkedinSharedAccount(), true);
  const sql = internals(ctx).source();
  assert.ok(sql.includes('mcc-poc-477801.all_clients_linkedin_ads.ad_creative_analytics'), 'reads the shared analytics table');
  assert.ok(sql.includes('mcc-poc-477801.all_clients_linkedin_ads.creatives'), 'reads the shared creatives table');
  assert.ok(sql.includes('mcc-poc-477801.all_clients_linkedin_ads.campaigns'), 'reads the shared campaigns table');
});

check('mode 2 WINS: DATASET / TABLE are ignored when ACCOUNT_URN is set', () => {
  const ctx = makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:510299552', DATASET: 'skip_marts', TABLE: 'linkedin_creative_reporting' } });
  const sql = internals(ctx).source();
  assert.ok(sql.includes('all_clients_linkedin_ads'), 'shared-account mode is active');
  assert.ok(!sql.includes('skip_marts'), 'the per-client DATASET must not appear');
  assert.ok(!sql.includes('.linkedin_creative_reporting`'), 'the per-client TABLE must not appear');
});

check('mode 2: SHARED_DATASET / PROJECT overrides are honoured', () => {
  const ctx = makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:1', PROJECT: 'p2', SHARED_DATASET: 'li_raw' } });
  assert.ok(internals(ctx).source().includes('`p2.li_raw.ad_creative_analytics`'));
});

// ── 3. Shared-account SQL shape (verified against the live Sucasa account) ──
check('shared-account SQL: account scope, numeric-id joins, pivot filter', () => {
  const URN = 'urn:li:sponsoredAccount:510299552';
  const sql = internals(makeCtx({ linkedin: { ACCOUNT_URN: URN } })).source();
  assert.ok(sql.includes(`WHERE c.account = '${URN}'`), 'creatives are scoped to the ad account URN');
  assert.ok(sql.includes(`camp.account = '${URN}'`), 'campaigns are scoped to the same URN');
  assert.ok(sql.includes(`REGEXP_EXTRACT(a.sponsoredCreative, r'([0-9]+)$') = cr.ad_id`), 'analytics join is on the trailing numeric creative id');
  assert.ok(sql.includes(`REGEXP_EXTRACT(c.campaign, r'([0-9]+)$') = CAST(camp.id AS STRING)`), 'campaign join is on the numeric campaign id');
  assert.ok(sql.includes(`WHERE a.pivot = 'CREATIVE'`), 'only creative-pivot rows');
});

check('shared-account SQL: costInLocalCurrency is spend, never costInUsd', () => {
  const sql = internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:1' } })).source();
  assert.ok(/a\.costInLocalCurrency\s+AS spend/.test(sql), 'spend is costInLocalCurrency');
  assert.ok(!sql.includes('costInUsd'), 'costInUsd must never be used — the column is already in local currency');
});

check('shared-account SQL: permalink is built from the creative content reference', () => {
  const sql = internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:1' } })).source();
  assert.ok(sql.includes(`CONCAT('https://www.linkedin.com/feed/update/', JSON_EXTRACT_SCALAR(c.content, '$.reference')) AS creative_link`), 'feed permalink formula');
});

check('shared-account SQL: CREATIVE_REF_EXPR can override the reference expression', () => {
  const sql = internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:1', CREATIVE_REF_EXPR: 'c.content.reference' } })).source();
  assert.ok(sql.includes(`CONCAT('https://www.linkedin.com/feed/update/', c.content.reference)`), 'override is used');
  assert.ok(!sql.includes('JSON_EXTRACT_SCALAR'), 'default is replaced, not appended');
});

check('shared-account SQL: normalises to the LinkedIn column contract', () => {
  const sql = internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:1' } })).source();
  ['ad_id', 'ad_name', 'campaign_name', 'adgroup_name', 'creative_link', 'date_start', 'min_date',
   'lifetime_spend', 'spend', 'impressions', 'clicks', 'landing_page_clicks', 'conversions',
   'one_click_leads', 'revenue', 'video_starts', 'video_views', 'video_p25', 'video_p50',
   'video_p75', 'video_p100'].forEach((col) => {
    assert.ok(new RegExp('\\b' + col + '\\b').test(sql), 'contract column present: ' + col);
  });
  assert.ok(sql.includes('OVER (PARTITION BY cr.ad_id)'), 'lifetime_spend / min_date are lifetime window functions');
});

check('ACCOUNT_URN is sanitised before it is inlined into SQL', () => {
  const ctx = makeCtx({ linkedin: { ACCOUNT_URN: "urn:li:sponsoredAccount:1' OR 1=1 --" } });
  assert.strictEqual(ctx.linkedinAccountUrn(), 'urn:li:sponsoredAccount:1OR1=1--'.replace('=', ''), 'characters outside the URN alphabet are stripped');
  const sql = internals(ctx).source();
  assert.ok(!sql.includes("' OR 1=1"), 'no quote can be injected through the URN');
});

// ── 4. LinkedIn-specific metrics and thresholds ────────────────────────────
check('LinkedIn platform profile maps LinkedIn columns, not TikTok/Meta ones', () => {
  const p = makeCtx().window.PLATFORM_PROFILES.linkedin;
  assert.strictEqual(p.hookCol, 'video_views', 'hook is the 2s in-view view rate');
  assert.strictEqual(p.holdCol, 'video_p50', 'hold is the midpoint quartile');
  assert.strictEqual(p.completionCol, 'video_p100');
  assert.strictEqual(p.playsCol, 'video_starts');
  assert.strictEqual(p.outboundCol, 'landing_page_clicks', 'LinkedIn has a real outbound click');
  assert.strictEqual(p.holdLabel, 'Hold % (50%)');
});

check('creativeRates() reads a LinkedIn row through the LinkedIn profile', () => {
  const ctx = makeCtx();
  const r = ctx.creativeRates({ impressions: 1000, clicks: 80, landing_page_clicks: 2, video_views: 550, video_p50: 43, video_p100: 23, video_starts: 900, video_p25: 100, video_p75: 30 }, ctx.window.PLATFORM_PROFILES.linkedin);
  const near = (v, want, what) => assert.ok(Math.abs(v - want) < 1e-9, what + ': got ' + v + ', want ' + want);
  near(r.hook, 55, 'view rate = video_views / impressions');
  near(r.hold, 4.3, 'hold = midpoint completions / impressions');
  near(r.completion, 2.3, 'completion = video_p100 / impressions');
  near(r.ctr, 8, 'raw CTR is the inflated LinkedIn clicks rate');
  near(r.outboundCtr, 0.2, 'outbound CTR is the landing-page click rate');
  assert.strictEqual(r.hasVideo, true);
});

check('LinkedIn thresholds do not inherit the Meta/TikTok defaults', () => {
  const ctx = makeCtx({ linkedin: {} });
  const th = ctx.linkedinThresholds();
  assert.strictEqual(th.HR_SPEND, 2000, 'LinkedIn runs at a smaller per-creative spend scale');
  assert.strictEqual(th.HR_CPA, 150);
  assert.strictEqual(th.OB_SPEND, 750);
  assert.strictEqual(th.SO_SPEND, 300);
  assert.notStrictEqual(th.HR_SPEND, 5000, 'must not be the TikTok/Meta 5000 floor');
});

check('LINKEDIN.THRESHOLDS overrides only the keys it names', () => {
  const th = makeCtx({ linkedin: { THRESHOLDS: { HR_CPA: 25 } } }).linkedinThresholds();
  assert.strictEqual(th.HR_CPA, 25, 'override applied');
  assert.strictEqual(th.HR_SPEND, 2000, 'unnamed keys keep the LinkedIn default');
});

check('classification CASE is built from the LinkedIn bands', () => {
  const ctx = makeCtx({ linkedin: { THRESHOLDS: { HR_SPEND: 1234, HR_CPA: 42 } } });
  const sql = internals(ctx).classificationCaseSQL('lifetime_spend', 'lifetime_cpa');
  assert.ok(sql.includes('lifetime_spend >= 1234'), 'uses the LinkedIn HR_SPEND');
  assert.ok(sql.includes('lifetime_cpa < 42'), 'uses the LinkedIn HR_CPA');
  assert.ok(sql.includes("THEN 'Home Run'") && sql.includes("THEN 'On Base'") && sql.includes("THEN 'Strike Out'"));
});

check('ROAS mode flips the LinkedIn classification polarity', () => {
  const ctx = makeCtx({ targetMetric: 'roas', linkedin: {} });
  const sql = internals(ctx).classificationCaseSQL('lifetime_spend', 'lifetime_roas');
  assert.ok(sql.includes('lifetime_roas > 4'), 'Home Run is a ROAS floor');
  assert.ok(!/lifetime_roas < 4/.test(sql), 'no CPA-style ceiling in ROAS mode');
});

check('Creative Score inputs use the LinkedIn columns and outbound CTR', () => {
  const o = internals(makeCtx({ linkedin: {} })).scoreOpts();
  assert.ok(o.hookExpr.includes('video_views'));
  assert.ok(o.holdExpr.includes('video_p50'));
  assert.ok(o.completionExpr.includes('video_p100'));
  assert.ok(o.hasVideoExpr.includes('video_starts'));
  assert.ok(o.ctrExpr.includes('landing_page_clicks'), 'score CTR is the outbound rate, not raw clicks');
  assert.deepStrictEqual(Object.assign({}, o.qualityCeil), { hook: 110, hold: 9, ctr: 0.3, completion: 4.5 });
});

// ── Ad Production benchmark copy ───────────────────────────────────────────
check('CPA: LinkedIn Ad Production benchmark reads the LinkedIn bands', () => {
  const ctx = makeCtx({ linkedin: {} });
  const html = ctx.liProdBenchmarkHTML(ctx.linkedinThresholds());
  assert.strictEqual(html, `<span class="bm-item"><strong>Home Run:</strong> Spend &ge; $2,000 &amp; CPA &lt; $150</span><span class="bm-item"><strong>On Base:</strong> Spend &ge; $750 &amp; CPA &lt; $250</span><span class="bm-item"><strong>Strike Out:</strong> Spend &ge; $300 &amp; CPA &gt; $400</span>`);
});

check('ROAS: LinkedIn benchmark flips to ROAS floors / ceiling', () => {
  const ctx = makeCtx({ targetMetric: 'roas', linkedin: {} });
  const html = ctx.liProdBenchmarkHTML(ctx.linkedinThresholds());
  assert.ok(html.includes('ROAS &ge; 4.0x') && html.includes('ROAS &ge; 2.0x') && html.includes('ROAS &lt; 1.0x'));
  assert.ok(!/&amp; CPA/.test(html), 'no CPA wording in the ROAS benchmark');
});

check('LinkedIn and Meta share one efficiency-metric dropdown source', () => {
  for (const mode of [undefined, 'roas']){
    const ctx = makeCtx({ targetMetric: mode, linkedin: {} });
    const opts = ctx.efficiencyMetricOptionsHTML();
    assert.ok(ctx.liControlsMarkup().includes(`<select id="li-ctrl-metric">${opts}</select>`), 'shared option set (' + (mode || 'cpa') + ')');
  }
});

check('revenue-guard slots exist only in ROAS mode', () => {
  const cpa = makeCtx({ linkedin: {} });
  const cpaHtml = cpa.liPanelsMarkup(cpa.linkedinThresholds());
  assert.ok(!cpaHtml.includes('li-summary-revenue-guard') && !cpaHtml.includes('li-production-revenue-guard'));
  const roas = makeCtx({ targetMetric: 'roas', linkedin: {} });
  const roasHtml = roas.liPanelsMarkup(roas.linkedinThresholds());
  assert.ok(roasHtml.includes('id="li-summary-revenue-guard"') && roasHtml.includes('id="li-production-revenue-guard"'));
});

// ── Tab queries: every one reads the resolved source, revenue stays gated ───
check('every tab query reads the resolved source for the active mode', () => {
  const I = internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:510299552' } }));
  const p = I.productionSQL();
  [I.maxDateSQL(), I.windowsSQL('2026-09-08', '2026-09-14', '2026-09-01', '2026-09-07'), p.scatterSQL, p.monthlySQL, I.creativeSQL()]
    .forEach((sql, i) => assert.ok(sql.includes('all_clients_linkedin_ads.ad_creative_analytics'), 'query ' + i + ' reads the shared source'));
});

check('CPA mode never SELECTs a revenue column (a mart may not have one)', () => {
  const I = internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:1' } }));
  const p = I.productionSQL();
  const weekly = I.windowsSQL('2026-09-08', '2026-09-14', '2026-09-01', '2026-09-07');
  assert.ok(!/cur_revenue/.test(weekly), 'no windowed revenue in CPA mode');
  assert.ok(!/period_revenue/.test(p.monthlySQL), 'no rollup revenue in CPA mode');
  assert.ok(/lifetime_cpa/.test(p.scatterSQL) && !/lifetime_roas/.test(p.scatterSQL), 'CPA is the lifetime metric column');
});

check('ROAS mode SELECTs the gated revenue column and switches the metric column', () => {
  const I = internals(makeCtx({ targetMetric: 'roas', linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:1', REVENUE_EXPR: 'gated_revenue' } }));
  const p = I.productionSQL();
  const weekly = I.windowsSQL('2026-09-08', '2026-09-14', '2026-09-01', '2026-09-07');
  assert.ok(weekly.includes('SUM(IF(date_start') && weekly.includes('gated_revenue'), 'windowed revenue uses the gated column');
  assert.ok(p.monthlySQL.includes('gated_revenue'), 'rollup revenue uses the gated column');
  assert.ok(/lifetime_roas/.test(p.scatterSQL), 'ROAS is the lifetime metric column');
  assert.ok(!/conversion_value/.test(weekly + p.scatterSQL + p.monthlySQL), 'raw conversion_value is never summed (hard policy)');
});

check('CONV_EXPR flows into every conversion aggregate', () => {
  const I = internals(makeCtx({ linkedin: { ACCOUNT_URN: 'urn:li:sponsoredAccount:1', CONV_EXPR: 'landing_page_clicks' } }));
  const p = I.productionSQL();
  assert.ok(I.windowsSQL('2026-09-08', '2026-09-14', '2026-09-01', '2026-09-07').includes('SUM(IF(date_start BETWEEN \'2026-09-08\' AND \'2026-09-14\', landing_page_clicks, 0))          AS cur_conv'));
  assert.ok(p.scatterSQL.includes('SUM(landing_page_clicks), 0) AS total_conversions'));
  assert.ok(I.creativeSQL().includes('SUM(landing_page_clicks), 0) AS total_conversions'));
});

// ── Coexistence with the other channels ────────────────────────────────────
check('LinkedIn ids never collide with the Meta or TikTok engines', () => {
  const ctx = makeCtx({ linkedin: {} });
  const html = ctx.liPanelsMarkup(ctx.linkedinThresholds()) + ctx.liControlsMarkup();
  assert.ok(!/id="tt-/.test(html), 'no tt- ids');
  assert.ok(!/id="(summary|board|production|creative)-/.test(html), 'no bare Meta ids');
  /* Every id this section emits is li-prefixed. */
  const ids = html.match(/id="([^"]+)"/g) || [];
  ids.forEach((raw) => {
    const id = raw.slice(4, -1);
    assert.ok(id.startsWith('li-') || id.startsWith('panel-li-'), 'li-scoped id: ' + id);
  });
});

check('preview links carry the linkedin platform so the fallback says LinkedIn', () => {
  const src = fs.readFileSync(path.join(ROOT, 'f10-linkedin.js'), 'utf8');
  assert.ok(src.includes('data-platform="linkedin"'), 'preview links are platform-tagged');
  const prev = fs.readFileSync(path.join(ROOT, 'f10-preview.js'), 'utf8');
  assert.ok(prev.includes("'Opens on LinkedIn'"), 'the preview fallback knows LinkedIn');
});

console.log(`\nLinkedIn channel: ${passed} checks passed.`);
