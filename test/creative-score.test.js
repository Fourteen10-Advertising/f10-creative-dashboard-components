/**
 * Creative Score acceptance test (US-001).
 *
 * Exercises creativeScoreSQL / creativeScoreComponentsSQL / creativeScoreParts /
 * creativeScoreBand from f10-utils.js. There is no BigQuery here, so the test
 * proves the SQL math two ways:
 *   1. Parity: it evaluates the EMITTED SQL expression as arithmetic (defining
 *      LEAST/GREATEST/LN/IF/IFNULL/ROUND) and asserts it equals the JS mirror
 *      creativeScoreParts for the same inputs. That is what keeps the single
 *      SQL source and the JS companion from ever drifting.
 *   2. Behaviour: it then asserts the target-anchored outcomes the story spells
 *      out (high score for a strong video ad, low score for a zero-conversion
 *      ad, confidence pulling a brand-new ad toward neutral, ROAS polarity flip,
 *      static images scoring a neutral 0.5 on creative quality).
 *
 * Dependency-free: loads the real f10-utils.js into a vm sandbox and calls the
 * exported globals directly. Run: node test/creative-score.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');

/* The framework default THRESHOLDS these fixtures are anchored against (same
 * seed the dashboards ship). Kept here so the expectations are explicit. */
const HR_SPEND = 5000, HR_CPA = 70, OB_CPA = 100, SO_CPA = 140;
const HR_ROAS = 4, OB_ROAS = 2, SO_ROAS = 1;

function makeCtx(targetMetric){
  const sandbox = { window: {}, console: console };
  if (targetMetric !== undefined) sandbox.TARGET_METRIC = targetMetric;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  return sandbox;
}

/* Column expressions the emitter reads. Names double as the variables the SQL
 * evaluator binds, so the emitted string is valid arithmetic once bound. */
const OPTS = {
  hookExpr: 'HOOK', holdExpr: 'HOLD', ctrExpr: 'CTR', completionExpr: 'COMPLETION',
  hasVideoExpr: 'HASVIDEO', activeDaysExpr: 'ACTIVEDAYS',
};

/* Evaluate an emitted SQL score expression as plain arithmetic. A SQL NULL is
 * represented as JS NaN in the bound vars, mirroring IFNULL semantics. */
function evalScoreSQL(sql, vars){
  const ctx = Object.assign({
    LEAST: function(){ return Math.min.apply(null, arguments); },
    GREATEST: function(){ return Math.max.apply(null, arguments); },
    LN: function(x){ return Math.log(x); },
    ROUND: function(x){ return Math.round(x); },
    IF: function(c, a, b){ return c ? a : b; },
    IFNULL: function(x, d){ return (x === null || Number.isNaN(x)) ? d : x; },
  }, vars);
  vm.createContext(ctx);
  return vm.runInContext('(' + sql + ')', ctx);
}

/* One fixture drives both the JS mirror (vals) and the SQL evaluator (vars). */
function fromFixture(f){
  const vals = {
    spend: f.spend, metric: f.metric, hook: f.hook, hold: f.hold,
    ctr: f.ctr, completion: f.completion, hasVideo: f.hasVideo, activeDays: f.activeDays,
  };
  const nn = (v) => (v == null ? NaN : v);
  const vars = {
    SPEND: f.spend, METRIC: nn(f.metric), HOOK: nn(f.hook), HOLD: nn(f.hold),
    CTR: nn(f.ctr), COMPLETION: nn(f.completion), HASVIDEO: !!f.hasVideo, ACTIVEDAYS: nn(f.activeDays),
  };
  return { vals: vals, vars: vars };
}

let passed = 0;
function check(name, fn){
  try { fn(); console.log('  ok - ' + name); passed++; }
  catch (e){ console.error('  FAIL - ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('Creative Score (US-001)');

/* Fixtures reused across cases. */
const FIX_STRONG = { spend: 20000, metric: 40, hook: 30, hold: 20, ctr: 3, completion: 15, hasVideo: true, activeDays: 60 };
const FIX_DOG    = { spend: 8000, metric: null, hook: 1, hold: 1, ctr: 0.1, completion: 1, hasVideo: true, activeDays: 20 };
const FIX_NEW    = { spend: 200, metric: 40, hook: 20, hold: 15, ctr: 2, completion: 10, hasVideo: true, activeDays: 3 };
const FIX_MATURE = Object.assign({}, FIX_NEW, { spend: 20000 }); /* same ad, high spend */
const FIX_STATIC = { spend: 5000, metric: 60, hook: 5, hold: 5, ctr: 1, completion: 5, hasVideo: false, activeDays: 30 };

// -- Single source: emitted SQL must equal the JS mirror ---------------------
check('CPA: emitted SQL score equals creativeScoreParts for every fixture', () => {
  const ctx = makeCtx(undefined);
  assert.strictEqual(ctx.targetMetric(), 'cpa');
  [FIX_STRONG, FIX_DOG, FIX_NEW, FIX_MATURE, FIX_STATIC].forEach((f) => {
    const { vals, vars } = fromFixture(f);
    const sql = ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS);
    const sqlScore = evalScoreSQL(sql, vars);
    const partsScore = ctx.creativeScoreParts(vals).score;
    assert.strictEqual(sqlScore, partsScore, 'SQL ' + sqlScore + ' vs parts ' + partsScore + ' for spend=' + f.spend);
  });
});

// -- Behaviour: target-anchored outcomes -------------------------------------
check('High-spend low-CPA video ad scores high (>= 80) in CPA mode', () => {
  const ctx = makeCtx(undefined);
  const { vals, vars } = fromFixture(FIX_STRONG);
  const parts = ctx.creativeScoreParts(vals);
  assert.strictEqual(parts.efficiency, 1, 'CPA under HR_CPA should max efficiency');
  assert.ok(parts.score >= 80, 'score should be >= 80, got ' + parts.score);
  assert.strictEqual(evalScoreSQL(ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS), vars), parts.score);
  assert.strictEqual(parts.band.label, 'Strong');
});

check('Real-spend zero-conversion ad scores low (<= 25)', () => {
  const ctx = makeCtx(undefined);
  const { vals, vars } = fromFixture(FIX_DOG);
  const parts = ctx.creativeScoreParts(vals);
  assert.strictEqual(parts.efficiency, 0, 'null CPA (no conversions) grades efficiency 0');
  assert.ok(parts.score <= 25, 'score should be <= 25, got ' + parts.score);
  assert.strictEqual(evalScoreSQL(ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS), vars), parts.score);
});

check('Brand-new low-spend ad is pulled toward neutral, not to the top', () => {
  const ctx = makeCtx(undefined);
  const low = ctx.creativeScoreParts(fromFixture(FIX_NEW).vals);
  const high = ctx.creativeScoreParts(fromFixture(FIX_MATURE).vals);
  /* Confidence is a multiplier on the deviation from 50, so thin volume damps it. */
  assert.ok(low.confidence < 1, 'thin spend should not reach full confidence, got ' + low.confidence);
  assert.strictEqual(high.confidence, 1, 'high spend should reach full confidence');
  assert.ok(low.score < high.score, 'low-spend score (' + low.score + ') should trail high-spend (' + high.score + ')');
  assert.ok(low.score < 70, 'low-spend ad must not reach the top band, got ' + low.score);
  assert.ok(Math.abs(low.score - 50) < Math.abs(high.score - 50), 'low-spend score should sit closer to neutral 50');
});

check('ROAS mode inverts efficiency polarity and anchors to the ROAS bands', () => {
  const ctx = makeCtx('roas');
  assert.strictEqual(ctx.targetMetric(), 'roas');
  const partsAt = (roas) => ctx.creativeScoreParts({ spend: 20000, metric: roas, hook: 20, hold: 15, ctr: 2, completion: 10, hasVideo: true, activeDays: 60 });
  const high = partsAt(5);   /* above HR_ROAS */
  const ob   = partsAt(OB_ROAS);
  const low  = partsAt(0.5); /* below SO_ROAS */
  assert.strictEqual(high.efficiency, 1, 'ROAS above HR_ROAS maxes efficiency');
  assert.strictEqual(ob.efficiency, 0.5, 'ROAS at OB_ROAS anchors to 0.5');
  assert.strictEqual(low.efficiency, 0, 'ROAS below SO_ROAS floors efficiency at 0');
  assert.ok(high.efficiency > low.efficiency, 'higher ROAS must score better (polarity inverted vs CPA)');
  assert.ok(high.score > low.score, 'higher ROAS must yield a higher score');
  /* SQL parity in ROAS mode too. */
  const { vals, vars } = fromFixture({ spend: 20000, metric: 5, hook: 20, hold: 15, ctr: 2, completion: 10, hasVideo: true, activeDays: 60 });
  assert.strictEqual(evalScoreSQL(ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS), vars), ctx.creativeScoreParts(vals).score);
});

check('ROAS mode reads only the gated column and never names conversion_value', () => {
  const ctx = makeCtx('roas');
  const sql = ctx.creativeScoreSQL('lifetime_spend', 'lifetime_roas', OPTS);
  assert.ok(/lifetime_roas/.test(sql), 'must consume the gated roas column passed in');
  assert.ok(!/conversion_value/.test(sql), 'ROAS score must never reference raw conversion_value');
});

check('Static image contributes a neutral 0.5 on creative quality, not 0', () => {
  const ctx = makeCtx(undefined);
  const parts = ctx.creativeScoreParts(fromFixture(FIX_STATIC).vals);
  assert.strictEqual(parts.quality, 0.5, 'no video gates should give quality 0.5');
  /* And the emitted quality sub-expression agrees when hasVideo is false. */
  const q = ctx.creativeScoreComponentsSQL('SPEND', 'METRIC', OPTS).quality;
  assert.strictEqual(evalScoreSQL(q, fromFixture(FIX_STATIC).vars), 0.5);
});

// -- Companion helper surface + guardrails -----------------------------------
check('creativeScoreParts exposes the four components, the score and the band', () => {
  const ctx = makeCtx(undefined);
  const parts = ctx.creativeScoreParts(fromFixture(FIX_STRONG).vals);
  ['efficiency', 'quality', 'durability', 'confidence', 'score', 'band'].forEach((k) => {
    assert.ok(k in parts, 'missing ' + k);
  });
  assert.ok(parts.band && typeof parts.band.label === 'string' && typeof parts.band.color === 'string');
});

check('creativeScoreBand maps scores to the three colour tiers', () => {
  const ctx = makeCtx(undefined);
  assert.strictEqual(ctx.creativeScoreBand(85).label, 'Strong');
  assert.strictEqual(ctx.creativeScoreBand(55).label, 'Mid');
  assert.strictEqual(ctx.creativeScoreBand(20).label, 'Weak');
});

check('emitted SQL carries no em-dash or en-dash (policy no-em-dashes-in-any-output)', () => {
  for (const mode of [undefined, 'roas']){
    const ctx = makeCtx(mode);
    const sql = ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS);
    assert.ok(sql.indexOf('—') === -1 && sql.indexOf('–') === -1, 'no long dashes in emitted SQL');
  }
});

console.log('\nCreative Score: ' + passed + ' checks passed.');
