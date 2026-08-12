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
 * evaluator binds, so the emitted string is valid arithmetic once bound. The
 * qualityCeil is the per-platform ceiling set both the SQL emitter and the JS
 * mirror read (US-004); the parity harness passes THIS SAME opts to both
 * creativeScoreSQL and creativeScoreParts so the two can never drift. This
 * fixture carries a hook ceiling so all four rate gates are exercised. */
const OPTS = {
  hookExpr: 'HOOK', holdExpr: 'HOLD', ctrExpr: 'CTR', completionExpr: 'COMPLETION',
  hasVideoExpr: 'HASVIDEO', activeDaysExpr: 'ACTIVEDAYS',
  qualityCeil: { hook: 11, hold: 6, ctr: 1.3, completion: 2.5 },
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
/* A decent (not maxed) new ad: rates sit BELOW the tuned per-platform ceilings so
   quality does not saturate, which is what lets the confidence multiplier be seen
   pulling the thin-spend twin toward neutral while the mature twin sits high. */
const FIX_NEW    = { spend: 200, metric: 40, hook: 8, hold: 4, ctr: 1, completion: 1.5, hasVideo: true, activeDays: 3 };
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
    /* Same opts (with qualityCeil) to BOTH sides, so the per-platform ceilings the
       SQL used are the ceilings the JS mirror uses -- that is the parity contract. */
    const partsScore = ctx.creativeScoreParts(vals, OPTS).score;
    assert.strictEqual(sqlScore, partsScore, 'SQL ' + sqlScore + ' vs parts ' + partsScore + ' for spend=' + f.spend);
  });
});

// -- Behaviour: target-anchored outcomes -------------------------------------
check('High-spend low-CPA video ad scores high (>= 80) in CPA mode', () => {
  const ctx = makeCtx(undefined);
  const { vals, vars } = fromFixture(FIX_STRONG);
  const parts = ctx.creativeScoreParts(vals, OPTS);
  assert.strictEqual(parts.efficiency, 1, 'CPA under HR_CPA should max efficiency');
  assert.ok(parts.score >= 80, 'score should be >= 80, got ' + parts.score);
  assert.strictEqual(evalScoreSQL(ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS), vars), parts.score);
  assert.strictEqual(parts.band.label, 'Strong');
});

/* A zero-conversion ad is HARD-CAPPED at the neutral 50. With no conversions the
 * metric is NULL, so efficiency grades 0 and the raw score is
 *   100 * (wEfficiency*0 + wQuality*quality + wDurability*durability) / sumW,
 * whose maximum is 100 * (wQuality + wDurability) = 100 * (0.3 + 0.2) = 50. So no
 * matter how strong the watch rates are, a non-converting ad cannot leave the
 * neutral band, and a mediocre one lands firmly in Weak. This is the true US-004
 * structural invariant (validated on FastCover); it REPLACES the old arbitrary
 * <= 25, which the tuned model legitimately exceeds for engaging non-converting
 * creative (that creative is still capped at 50, never Mid-strong). */
check('Zero-conversion ad is capped at neutral 50 (efficiency 0), never Mid-strong', () => {
  const ctx = makeCtx(undefined);
  /* (a) strong watch rates + full maturity: efficiency 0 pins raw at the 50 cap. */
  const strongNoConv = Object.assign({}, FIX_STRONG, { metric: null });
  const sp = ctx.creativeScoreParts(strongNoConv, OPTS);
  assert.strictEqual(sp.efficiency, 0, 'null metric (no conversions) grades efficiency 0');
  assert.ok(sp.score <= 50, 'a zero-conversion ad is capped at 50, got ' + sp.score);
  assert.strictEqual(evalScoreSQL(ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS), fromFixture(strongNoConv).vars), sp.score);
  /* (b) mediocre/zero watch rates: lands in the Weak band (score < 40). */
  const dp = ctx.creativeScoreParts(FIX_DOG, OPTS);
  assert.strictEqual(dp.efficiency, 0, 'null metric grades efficiency 0');
  assert.ok(dp.score < 40, 'a weak zero-conversion ad scores < 40, got ' + dp.score);
  assert.strictEqual(dp.band.label, 'Weak', 'and lands in the Weak band, got ' + dp.band.label);
  assert.strictEqual(evalScoreSQL(ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS), fromFixture(FIX_DOG).vars), dp.score);
});

check('Brand-new low-spend ad is pulled toward neutral, not to the top', () => {
  const ctx = makeCtx(undefined);
  const low = ctx.creativeScoreParts(fromFixture(FIX_NEW).vals, OPTS);
  const high = ctx.creativeScoreParts(fromFixture(FIX_MATURE).vals, OPTS);
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
  const partsAt = (roas) => ctx.creativeScoreParts({ spend: 20000, metric: roas, hook: 20, hold: 15, ctr: 2, completion: 10, hasVideo: true, activeDays: 60 }, OPTS);
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
  assert.strictEqual(evalScoreSQL(ctx.creativeScoreSQL('SPEND', 'METRIC', OPTS), vars), ctx.creativeScoreParts(vals, OPTS).score);
});

check('ROAS mode reads only the gated column and never names conversion_value', () => {
  const ctx = makeCtx('roas');
  const sql = ctx.creativeScoreSQL('lifetime_spend', 'lifetime_roas', OPTS);
  assert.ok(/lifetime_roas/.test(sql), 'must consume the gated roas column passed in');
  assert.ok(!/conversion_value/.test(sql), 'ROAS score must never reference raw conversion_value');
});

check('Static image contributes a neutral 0.5 on creative quality, not 0', () => {
  const ctx = makeCtx(undefined);
  const parts = ctx.creativeScoreParts(fromFixture(FIX_STATIC).vals, OPTS);
  assert.strictEqual(parts.quality, 0.5, 'no video gates should give quality 0.5');
  /* And the emitted quality sub-expression agrees when hasVideo is false. */
  const q = ctx.creativeScoreComponentsSQL('SPEND', 'METRIC', OPTS).quality;
  assert.strictEqual(evalScoreSQL(q, fromFixture(FIX_STATIC).vars), 0.5);
});

// -- Per-platform ceilings (US-004): opts.qualityCeil overrides the config -------
check('per-platform ceilings: TikTok ceilings lift quality above Meta on the same rates, and opts overrides config', () => {
  const ctx = makeCtx(undefined);
  /* The validated per-platform ceilings (rates as a percent of impressions).
     Meta carries a hook key here too so both sets compare on the same four rates. */
  const META_CEIL = { hook: 11, hold: 6, ctr: 1.3, completion: 2.5 };
  const TT_CEIL   = { hook: 11, hold: 1.9, ctr: 0.4, completion: 0.3 };
  const vals = { spend: 20000, metric: 40, hook: 5, hold: 3, ctr: 0.5, completion: 1, hasVideo: true, activeDays: 60 };
  const metaQ = ctx.creativeScoreParts(vals, { qualityCeil: META_CEIL }).quality;
  const ttQ   = ctx.creativeScoreParts(vals, { qualityCeil: TT_CEIL }).quality;
  /* TikTok ceilings are lower, so the SAME rate vector clears more of them: a
     strictly higher creative-quality sub-score. This is the fix for TikTok being
     capped and real video being under-credited against statics. */
  assert.ok(ttQ > metaQ, 'TikTok ceilings must yield a higher quality sub-score than Meta on the same rates, got tt=' + ttQ + ' meta=' + metaQ);
  /* opts.qualityCeil overrides creativeScoreConfig().qualityCeil: with no opts the
     config default IS the Meta set, so the default quality equals the Meta-ceiling
     quality and differs from the TikTok-ceiling quality. */
  const defaultQ = ctx.creativeScoreParts(vals).quality;
  assert.ok(Math.abs(defaultQ - metaQ) < 1e-9, 'the config default qualityCeil is the Meta set, got default=' + defaultQ + ' meta=' + metaQ);
  assert.notStrictEqual(ttQ, defaultQ, 'opts.qualityCeil must override the config default');
  /* The SQL emitter honours opts.qualityCeil the same way (quality parity). */
  const OPTS_TT = { hookExpr: 'HOOK', holdExpr: 'HOLD', ctrExpr: 'CTR', completionExpr: 'COMPLETION', hasVideoExpr: 'HASVIDEO', activeDaysExpr: 'ACTIVEDAYS', qualityCeil: TT_CEIL };
  const qSql = ctx.creativeScoreComponentsSQL('SPEND', 'METRIC', OPTS_TT).quality;
  assert.ok(Math.abs(evalScoreSQL(qSql, fromFixture(vals).vars) - ttQ) < 1e-9, 'SQL quality must equal the JS mirror under the TikTok ceilings');
});

// -- Companion helper surface + guardrails -----------------------------------
check('creativeScoreParts exposes the four components, the score and the band', () => {
  const ctx = makeCtx(undefined);
  const parts = ctx.creativeScoreParts(fromFixture(FIX_STRONG).vals, OPTS);
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
