/**
 * Creative Score hover breakdown acceptance test (US-003).
 *
 * Proves, dependency-free, the four things US-003 adds to the per-ad hover:
 *   1. BREAKDOWN: the hover (f10-preview.js metricsHtml, exposed as
 *      window.f10MetricsHtml) leads with the final Creative Score plus its four
 *      component sub-scores (efficiency, creative quality, durability, and the
 *      confidence multiplier applied), each with a plain-English line.
 *   2. NEUTRAL STATED: for a static image (no video to score) the creative
 *      quality line reads its neutral 0.5 contribution explicitly, not blank
 *      and not zero, so the maths still reads.
 *   3. HOVER == TABLE: the headline the hover shows is the SQL creative_score the
 *      table badge shows, carried verbatim through registerAdMetrics, never a
 *      second JS computation. Proven two ways: a realistic ad where the emitted
 *      SQL value round-trips to the same integer the badge renders, and a
 *      carry-verbatim case where the registry score deliberately differs from
 *      what creativeScoreParts would compute and the hover still shows the SQL
 *      value.
 *   4. POLICY: the score-breakdown copy carries no em-dash or en-dash.
 *
 * The score packaging (creativeScoreHover / registerAdMetrics / creativeScoreParts)
 * is exercised against the REAL f10-utils.js in a vm sandbox; the render is the
 * REAL f10-preview.js in a second sandbox reading the same registry entries. The
 * wiring (every score-bearing table registers a hover payload on both Meta and
 * TikTok) is asserted against the source text. Run: node test/us-003-hover-breakdown.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UTILS = read('f10-utils.js');
const PREVIEW = read('f10-preview.js');
const MONTHLY = read('f10-monthly.js');
const TIKTOK = read('f10-tiktok.js');

/* The framework default THRESHOLDS these fixtures are anchored against. */
const HR_CPA = 70; /* documented for readability; the ad below sits under it */

function makeUtils(targetMetric) {
  const sandbox = { window: {}, console: console };
  if (targetMetric !== undefined) sandbox.TARGET_METRIC = targetMetric;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  return sandbox;
}

/* Load the real f10-preview.js. retentionSparkline is intentionally absent here,
 * so metricsHtml skips the video curve and renders text only (mirrors the
 * carousel test's isolated preview sandbox). */
function makePreview() {
  const sandbox = { window: {}, document: {}, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(PREVIEW, sandbox, { filename: 'f10-preview.js' });
  return sandbox.window;
}

/* Evaluate an emitted SQL score expression as plain arithmetic (mirrors
 * creative-score.test.js). A SQL NULL is represented as JS NaN in the vars. */
function evalScoreSQL(sql, vars) {
  const ctx = Object.assign({
    LEAST: function () { return Math.min.apply(null, arguments); },
    GREATEST: function () { return Math.max.apply(null, arguments); },
    LN: function (x) { return Math.log(x); },
    ROUND: function (x) { return Math.round(x); },
    IF: function (c, a, b) { return c ? a : b; },
    IFNULL: function (x, d) { return (x === null || Number.isNaN(x)) ? d : x; },
  }, vars);
  vm.createContext(ctx);
  return vm.runInContext('(' + sql + ')', ctx);
}

/* Meta score opts (no hook gate, matching metaScoreOpts). The *Expr strings
 * double as the variable names the SQL evaluator binds. */
const META_OPTS = {
  holdExpr: 'HOLD', ctrExpr: 'CTR', completionExpr: 'COMPLETION',
  hasVideoExpr: 'HASVIDEO', activeDaysExpr: 'ACTIVEDAYS',
};
const nn = (v) => (v == null ? NaN : v);
function metaVars(v) {
  return { SPEND: v.spend, METRIC: nn(v.metric), HOLD: nn(v.hold), CTR: nn(v.ctr),
    COMPLETION: nn(v.completion), HASVIDEO: !!v.hasVideo, ACTIVEDAYS: nn(v.activeDays) };
}

const stripTags = (html) => html.replace(/<[^>]*>/g, ' ');

let passed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok - ' + name); passed++; }
  catch (e) { console.error('  FAIL - ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('Creative Score hover breakdown (US-003)');

/* A strong Meta video ad: high spend, CPA well under HR_CPA, healthy attention. */
const CE_VIDEO = { impressions: 100000, clicks: 2000, video_15s: 22000, video_p25: 40000,
  video_p50: 30000, video_p75: 22000, video_p100: 15000, video_plays: 90000, outbound_clicks: 1500 };
const VIDEO_META = { spend: 20000, metric: 40, activeDays: 60 };

/* A Meta static image: no video plays, so the creative-quality gate does not apply. */
const CE_STATIC = { impressions: 40000, clicks: 600, video_15s: 0, video_p25: 0,
  video_p50: 0, video_p75: 0, video_p100: 0, video_plays: 0, outbound_clicks: 300 };
const STATIC_META = { spend: 6000, metric: 55, activeDays: 30 };

/* Build the registry the way the real table renderers do: creativeRates for the
 * attention rows, creativeScoreHover(sqlScore, vals) for the breakdown, both fed
 * from the SAME numbers. Returns { win, adId, sqlScore, cr }. */
function registerAd(utils, adId, ce, dims) {
  const cr = utils.creativeRates(ce);
  const vals = { spend: dims.spend, metric: dims.metric, hook: cr.hook, hold: cr.hold,
    ctr: cr.ctr, completion: cr.completion, hasVideo: cr.hasVideo, activeDays: dims.activeDays };
  const sqlScore = evalScoreSQL(utils.creativeScoreSQL('SPEND', 'METRIC', META_OPTS), metaVars(vals));
  utils.registerAdMetrics(adId, ce, undefined, utils.creativeScoreHover(sqlScore, vals));
  return { sqlScore: sqlScore, cr: cr };
}

// -- 1. BREAKDOWN: final score + four components on the hover --------------------
check('hover leads with the final Creative Score and all four component sub-scores', () => {
  const utils = makeUtils(undefined);
  const built = registerAd(utils, 'AD_VIDEO', CE_VIDEO, VIDEO_META);
  const win = makePreview();
  win.F10_AD_METRICS = utils.window.F10_AD_METRICS;
  const html = win.f10MetricsHtml('AD_VIDEO');
  const text = stripTags(html);
  assert.ok(/Creative Score/.test(html), 'headline label present');
  assert.ok(/Efficiency/.test(text), 'efficiency component present');
  assert.ok(/Creative quality/.test(text), 'creative quality component present');
  assert.ok(/Durability/.test(text), 'durability component present');
  assert.ok(/Confidence applied/.test(text), 'confidence multiplier line present');
  /* The confidence line labels it as a multiplier (x). */
  assert.ok(/[0-9.]+x/.test(text), 'confidence shown as a multiplier (Nx)');
  /* The headline value is the score integer, and it is the SQL value. */
  const headMatch = html.match(/Creative Score<\/span><b>(\d+)/);
  assert.ok(headMatch, 'headline value renders as an integer');
  assert.strictEqual(Number(headMatch[1]), Math.round(built.sqlScore), 'headline is the SQL score');
});

// -- 2. NEUTRAL STATED: static image quality reads neutral, not blank/zero -------
check('static image states creative quality neutral 0.5 with a reason, not blank or zero', () => {
  const utils = makeUtils(undefined);
  registerAd(utils, 'AD_STATIC', CE_STATIC, STATIC_META);
  const win = makePreview();
  win.F10_AD_METRICS = utils.window.F10_AD_METRICS;
  const html = win.f10MetricsHtml('AD_STATIC');
  /* Isolate the creative-quality row + its note. */
  const q = html.match(/Creative quality<\/span><b>([^<]*)<\/b><\/div><div class="f10-pm-note">([^<]*)</);
  assert.ok(q, 'creative quality line renders');
  assert.strictEqual(q[1].trim(), 'neutral 0.5', 'quality value states the neutral 0.5 contribution, got: ' + q[1]);
  assert.ok(/no video to score/.test(q[2]), 'the note explains why it is neutral, got: ' + q[2]);
  /* Explicitly not blank and not a bare zero. */
  assert.notStrictEqual(q[1].trim(), '', 'quality must not be blank');
  assert.ok(!/^0(\.0+)?$/.test(q[1].trim()), 'quality must not read as zero');
  /* The registry carried hasVideo:false for this ad. */
  assert.strictEqual(utils.window.F10_AD_METRICS['AD_STATIC'].score.hasVideo, false);
});

// -- 3. HOVER == TABLE: headline equals the badge the table shows ----------------
check('hover headline equals the table score badge for the same ad', () => {
  const utils = makeUtils(undefined);
  const built = registerAd(utils, 'AD_VIDEO', CE_VIDEO, VIDEO_META);
  /* The table renders creativeScoreBadge(r.creative_score) from the SAME SQL value. */
  const tableN = Number(stripTags(utils.creativeScoreBadge(built.sqlScore)).trim());
  const win = makePreview();
  win.F10_AD_METRICS = utils.window.F10_AD_METRICS;
  const html = win.f10MetricsHtml('AD_VIDEO');
  const hoverN = Number(html.match(/Creative Score<\/span><b>(\d+)/)[1]);
  assert.strictEqual(hoverN, tableN, 'hover headline ' + hoverN + ' must equal table badge ' + tableN);
});

check('hover carries the SQL score verbatim, not a divergent JS recompute', () => {
  const utils = makeUtils(undefined);
  const cr = utils.creativeRates(CE_VIDEO);
  const vals = { spend: VIDEO_META.spend, metric: VIDEO_META.metric, hook: cr.hook, hold: cr.hold,
    ctr: cr.ctr, completion: cr.completion, hasVideo: cr.hasVideo, activeDays: VIDEO_META.activeDays };
  /* Deliberately hand the registry a score that differs from the JS mirror, as a
   * real SQL result rounded server-side might. The hover must show THIS value. */
  const jsScore = utils.creativeScoreParts(vals).score;
  const fakeSqlScore = jsScore >= 50 ? jsScore - 7 : jsScore + 7;
  utils.registerAdMetrics('AD_FIXED', CE_VIDEO, undefined, utils.creativeScoreHover(fakeSqlScore, vals));
  const win = makePreview();
  win.F10_AD_METRICS = utils.window.F10_AD_METRICS;
  const html = win.f10MetricsHtml('AD_FIXED');
  const hoverN = Number(html.match(/Creative Score<\/span><b>(\d+)/)[1]);
  assert.strictEqual(hoverN, fakeSqlScore, 'hover must render the carried SQL value ' + fakeSqlScore);
  assert.notStrictEqual(hoverN, jsScore, 'and must not fall back to the JS recompute ' + jsScore);
  assert.strictEqual(Number(stripTags(utils.creativeScoreBadge(fakeSqlScore)).trim()), hoverN, 'badge agrees');
});

// -- 4. POLICY: no em-dash / en-dash in the breakdown copy -----------------------
check('score breakdown copy carries no em-dash or en-dash (policy no-em-dashes-in-any-output)', () => {
  for (const ce of [CE_VIDEO, CE_STATIC]) {
    const utils = makeUtils(undefined);
    registerAd(utils, 'AD', ce, ce === CE_VIDEO ? VIDEO_META : STATIC_META);
    const win = makePreview();
    win.F10_AD_METRICS = utils.window.F10_AD_METRICS;
    const html = win.f10MetricsHtml('AD');
    const block = html.match(/<div class="f10-preview-score">[\s\S]*?<\/div>\s*(?=<div class="f10-pm-row")/);
    const scoreHtml = block ? block[0] : html.slice(0, html.indexOf('Hold rate'));
    assert.ok(scoreHtml.indexOf('—') === -1 && scoreHtml.indexOf('–') === -1, 'no long dashes in the score breakdown');
  }
});

// -- WIRING: every score-bearing table registers a hover payload (Meta + TikTok) --
check('registerAdMetrics accepts a score payload and creativeScoreHover is exported', () => {
  const utils = makeUtils(undefined);
  assert.strictEqual(typeof utils.creativeScoreHover, 'function', 'creativeScoreHover must exist');
  assert.strictEqual(typeof utils.window.creativeScoreHover, 'function', 'creativeScoreHover exposed on window');
  /* The 4th arg attaches a score; omitting it leaves a metrics-only entry (back-compat). */
  utils.registerAdMetrics('X', CE_VIDEO, undefined, utils.creativeScoreHover(80, { spend: 20000, metric: 40, hasVideo: true, activeDays: 60 }));
  utils.registerAdMetrics('Y', CE_VIDEO);
  assert.ok(utils.window.F10_AD_METRICS['X'].score && utils.window.F10_AD_METRICS['X'].score.value === 80);
  assert.strictEqual(utils.window.F10_AD_METRICS['Y'].score, undefined, 'no-score caller stays metrics-only');
});

check('both Meta tables register a Creative Score hover payload', () => {
  const calls = MONTHLY.match(/creativeScoreHover\(r\.creative_score,/g) || [];
  assert.strictEqual(calls.length, 2, 'both Meta tabs must register the hover payload, found ' + calls.length);
});

check('both TikTok tables register a Creative Score hover payload', () => {
  const calls = TIKTOK.match(/creativeScoreHover\(r\.creative_score,/g) || [];
  assert.strictEqual(calls.length, 2, 'both TikTok tabs must register the hover payload, found ' + calls.length);
});

console.log('\nCreative Score hover breakdown: ' + passed + ' checks passed.');
