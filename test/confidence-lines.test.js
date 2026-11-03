/**
 * Confidence lines acceptance test (creative-dashboard-confidence-lines US-001).
 *
 * Exercises poissonCdf / confidenceBounds / confidenceVerdict /
 * confidenceVerdictSQL / confidenceCurvePoints from f10-utils.js. There is no
 * BigQuery here, so, following test/creative-score.test.js:
 *   1. Backtest parity: the fixtures below are LITERAL output of
 *      workspace/reports/mosh-kill-line-backtest/gen_fixtures.py, which imports
 *      pois_cdf and curve from backtest.py. The dashboard and the backtest
 *      cannot drift without this test failing. Re-run that script and re-paste
 *      FIXTURES if backtest.py changes.
 *   2. SQL parity: it evaluates the EMITTED SQL expression as arithmetic
 *      (defining IF / IFNULL / SAFE_DIVIDE / GREATEST / FLOOR / SQRT / POW /
 *      CAST / SAFE_OFFSET) and asserts it equals the JS mirror.
 *   3. No-change: with the helper block stripped out of the source, every
 *      existing global, tier SQL and score SQL is identical.
 *
 * Dependency-free. Run: node test/confidence-lines.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');

/* gen_fixtures.py output (seeded). conf 0.9 is backtest.py CONF = 0.10. */
const FIXTURES = {"conf": 0.9, "cdf": [{"k": 0, "lam": 1.0, "p": 0.36787944117144233}, {"k": 0, "lam": 2.0, "p": 0.1353352832366127}, {"k": 0, "lam": 3.0, "p": 0.049787068367863944}, {"k": 13, "lam": 20.0, "p": 0.06612764095916593}, {"k": 12, "lam": 20.0, "p": 0.039011992854992794}, {"k": 14, "lam": 20.0, "p": 0.10486428110798471}, {"k": 86, "lam": 100.0, "p": 0.08610547860908083}, {"k": 87, "lam": 100.0, "p": 0.10375492989496125}, {"k": 1, "lam": 5.0, "p": 0.040427681994512805}, {"k": 5, "lam": 2.5, "p": 0.9579789618046939}, {"k": 40, "lam": 55.0, "p": 0.021253588060806947}, {"k": 100, "lam": 120.0, "p": 0.034668034694424955}], "verdicts": [{"spend": 1000, "conv": 12, "target": 50, "verdict": "Cut"}, {"spend": 1000, "conv": 13, "target": 50, "verdict": "Cut"}, {"spend": 1000, "conv": 14, "target": 50, "verdict": "Testing"}, {"spend": 1000, "conv": 26, "target": 50, "verdict": "Testing"}, {"spend": 1000, "conv": 27, "target": 50, "verdict": "Scale"}, {"spend": 1000, "conv": 28, "target": 50, "verdict": "Scale"}, {"spend": 5000, "conv": 85, "target": 50, "verdict": "Cut"}, {"spend": 5000, "conv": 86, "target": 50, "verdict": "Cut"}, {"spend": 5000, "conv": 87, "target": 50, "verdict": "Testing"}, {"spend": 5000, "conv": 113, "target": 50, "verdict": "Testing"}, {"spend": 5000, "conv": 114, "target": 50, "verdict": "Scale"}, {"spend": 5000, "conv": 115, "target": 50, "verdict": "Scale"}, {"spend": 50, "conv": 0, "target": 50, "verdict": "Testing"}, {"spend": 50, "conv": 1, "target": 50, "verdict": "Testing"}, {"spend": 50, "conv": 2, "target": 50, "verdict": "Testing"}, {"spend": 50, "conv": 3, "target": 50, "verdict": "Scale"}, {"spend": 150, "conv": 0, "target": 50, "verdict": "Cut"}, {"spend": 150, "conv": 1, "target": 50, "verdict": "Testing"}, {"spend": 150, "conv": 2, "target": 50, "verdict": "Testing"}, {"spend": 2743.67, "conv": 57, "target": 50, "verdict": "Testing"}, {"spend": 1208.98, "conv": 6, "target": 120, "verdict": "Testing"}, {"spend": 2294.0, "conv": 84, "target": 50, "verdict": "Scale"}, {"spend": 4416.91, "conv": 104, "target": 80, "verdict": "Scale"}, {"spend": 1803.68, "conv": 47, "target": 40, "verdict": "Testing"}, {"spend": 474.25, "conv": 4, "target": 80, "verdict": "Testing"}, {"spend": 2353.41, "conv": 38, "target": 120, "verdict": "Scale"}, {"spend": 536.47, "conv": 36, "target": 25, "verdict": "Scale"}, {"spend": 2594.45, "conv": 80, "target": 50, "verdict": "Scale"}, {"spend": 1141.36, "conv": 26, "target": 25, "verdict": "Cut"}, {"spend": 1662.11, "conv": 33, "target": 50, "verdict": "Testing"}, {"spend": 4243.22, "conv": 32, "target": 120, "verdict": "Testing"}, {"spend": 859.98, "conv": 42, "target": 25, "verdict": "Testing"}, {"spend": 653.78, "conv": 8, "target": 120, "verdict": "Testing"}, {"spend": 1258.66, "conv": 27, "target": 80, "verdict": "Scale"}, {"spend": 1779.76, "conv": 40, "target": 80, "verdict": "Scale"}, {"spend": 2226.47, "conv": 79, "target": 50, "verdict": "Scale"}, {"spend": 5583.83, "conv": 24, "target": 120, "verdict": "Cut"}, {"spend": 2497.96, "conv": 40, "target": 50, "verdict": "Cut"}, {"spend": 2251.15, "conv": 22, "target": 120, "verdict": "Testing"}, {"spend": 1400.18, "conv": 36, "target": 40, "verdict": "Testing"}, {"spend": 578.77, "conv": 8, "target": 80, "verdict": "Testing"}, {"spend": 714.25, "conv": 13, "target": 80, "verdict": "Testing"}, {"spend": 1219.81, "conv": 75, "target": 25, "verdict": "Scale"}, {"spend": 834.34, "conv": 53, "target": 25, "verdict": "Scale"}, {"spend": 1605.74, "conv": 25, "target": 120, "verdict": "Scale"}, {"spend": 873.1, "conv": 36, "target": 50, "verdict": "Scale"}, {"spend": 2613.12, "conv": 41, "target": 120, "verdict": "Scale"}, {"spend": 1532.12, "conv": 12, "target": 50, "verdict": "Cut"}, {"spend": 1362.64, "conv": 84, "target": 25, "verdict": "Scale"}, {"spend": 2500.94, "conv": 107, "target": 50, "verdict": "Scale"}, {"spend": 2757.67, "conv": 78, "target": 50, "verdict": "Scale"}, {"spend": 2093.34, "conv": 45, "target": 40, "verdict": "Testing"}, {"spend": 943.82, "conv": 16, "target": 80, "verdict": "Testing"}, {"spend": 1674.5, "conv": 20, "target": 80, "verdict": "Testing"}, {"spend": 449.81, "conv": 7, "target": 120, "verdict": "Scale"}, {"spend": 1288.17, "conv": 50, "target": 25, "verdict": "Testing"}, {"spend": 1733.18, "conv": 35, "target": 40, "verdict": "Testing"}, {"spend": 2543.35, "conv": 69, "target": 50, "verdict": "Scale"}, {"spend": 359.19, "conv": 4, "target": 120, "verdict": "Testing"}]};

function makeCtx(src){
  const sandbox = { window: {}, console: console };
  vm.createContext(sandbox);
  vm.runInContext(src || UTILS, sandbox, { filename: 'f10-utils.js' });
  return sandbox;
}

/* Evaluate an emitted BigQuery verdict expression as JS. A SQL NULL is JS
 * null; an out-of-range SAFE_OFFSET is JS undefined, which IFNULL also treats
 * as NULL. */
function evalVerdictSQL(sql, vars){
  const isNull = (x) => x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x));
  const fns = {
    IF: (c, a, b) => (c === true ? a : b),
    IFNULL: (x, d) => (isNull(x) ? d : x),
    SAFE_DIVIDE: (a, b) => (isNull(a) || isNull(b) || b === 0 ? null : a / b),
    GREATEST: (a, b) => (isNull(a) || isNull(b) ? null : Math.max(a, b)),
    FLOOR: (x) => (isNull(x) ? null : Math.floor(x)),
    SQRT: (x) => (isNull(x) ? null : Math.sqrt(x)),
    POW: (x, y) => (isNull(x) || isNull(y) ? null : Math.pow(x, y)),
    CAST_INT64: (x) => (isNull(x) ? null : Math.trunc(x)),
    SAFE_OFFSET: (i) => i,
    FALSE: false,
  };
  const js = sql.replace(/CAST\(/g, 'CAST_INT64(').replace(/ AS INT64\)/g, ')');
  const names = Object.keys(fns).concat(Object.keys(vars));
  const vals = names.map((n) => (n in fns ? fns[n] : vars[n]));
  return Function.apply(null, names.concat(['"use strict"; return (' + js + ');'])).apply(null, vals);
}

let passed = 0;
function check(name, fn){
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); process.exitCode = 1; }
}

const ctx = makeCtx();
const SQL = ctx.confidenceVerdictSQL('SPEND', 'CONV', 'TARGET');

check('exports the helpers as globals and on window', () => {
  for (const n of ['poissonCdf', 'confidenceBounds', 'confidenceVerdict', 'confidenceVerdictSQL', 'confidenceCurvePoints']){
    assert.strictEqual(typeof ctx[n], 'function', n + ' global');
    assert.strictEqual(typeof ctx.window[n], 'function', n + ' on window');
  }
});

check('poissonCdf matches backtest.py pois_cdf', () => {
  for (const f of FIXTURES.cdf){
    const got = ctx.poissonCdf(f.k, f.lam);
    assert.ok(Math.abs(got - f.p) < 1e-12, `k=${f.k} lam=${f.lam}: ${got} vs ${f.p}`);
  }
  assert.strictEqual(ctx.poissonCdf(3, 0), 1);
  assert.ok(ctx.poissonCdf(800, 1000) > 0, 'no underflow at large lam');
});

check('confidenceVerdict matches backtest.py curve on every fixture', () => {
  for (const f of FIXTURES.verdicts){
    assert.strictEqual(ctx.confidenceVerdict(f.spend, f.conv, f.target, FIXTURES.conf), f.verdict,
      `spend=${f.spend} conv=${f.conv} target=${f.target}`);
  }
});

check('default confidence is 90%, and 0.9 and 90 mean the same', () => {
  for (const f of FIXTURES.verdicts){
    const d = ctx.confidenceVerdict(f.spend, f.conv, f.target);
    assert.strictEqual(d, f.verdict);
    assert.strictEqual(ctx.confidenceVerdict(f.spend, f.conv, f.target, 90), d);
    assert.strictEqual(ctx.confidenceVerdict(f.spend, f.conv, f.target, { conf: 0.9 }), d);
  }
  assert.strictEqual(ctx.confidenceVerdictSQL('S', 'C', 'T'), ctx.confidenceVerdictSQL('S', 'C', 'T', 90));
  assert.notStrictEqual(ctx.confidenceVerdictSQL('S', 'C', 'T'), ctx.confidenceVerdictSQL('S', 'C', 'T', 0.95));
});

check('SQL evaluated in the vm matches confidenceVerdict on 30+ seeded fixtures', () => {
  const seeded = FIXTURES.verdicts.slice(-40);
  assert.ok(seeded.length >= 30);
  for (const f of FIXTURES.verdicts){
    const got = evalVerdictSQL(SQL, { SPEND: f.spend, CONV: f.conv, TARGET: f.target });
    assert.strictEqual(got, ctx.confidenceVerdict(f.spend, f.conv, f.target), `spend=${f.spend} conv=${f.conv} target=${f.target}`);
    assert.strictEqual(got, f.verdict);
  }
});

check('SQL matches the JS mirror past the exact table (Wilson-Hilferty fallback) and at other confidences', () => {
  let rng = 7;
  const rand = () => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng / 2147483648; };
  for (const conf of [0.8, 0.9, 0.95]){
    const sql = ctx.confidenceVerdictSQL('SPEND', 'CONV', 'TARGET', conf);
    for (let i = 0; i < 200; i++){
      const target = 20 + Math.floor(rand() * 100);
      const lam = rand() * 400;
      const conv = Math.floor(lam * (0.6 + rand() * 0.8));
      const spend = lam * target;
      assert.strictEqual(evalVerdictSQL(sql, { SPEND: spend, CONV: conv, TARGET: target }),
        ctx.confidenceVerdict(spend, conv, target, conf), `conf=${conf} spend=${spend} conv=${conv}`);
    }
  }
});

check('Wilson-Hilferty fallback stays within 1e-4 of the exact boundary past the table', () => {
  const t = ctx.confidenceBounds(101);
  // Exact boundaries at k = 101 by bisection on the exact CDF.
  const solve = (k, p) => { let lo = 0, hi = 400; for (let i = 0; i < 200; i++){ const m = (lo + hi) / 2; if (ctx.poissonCdf(k, m) > p) lo = m; else hi = m; } return lo; };
  assert.ok(Math.abs(t.kill / solve(101, 0.1) - 1) < 1e-4, 'kill');
  assert.ok(Math.abs(t.scale / solve(100, 0.9) - 1) < 1e-4, 'scale');
});

check('target 50: kill CPA 77 at spend 1,000 and 58 at spend 5,000', () => {
  const pts = ctx.confidenceCurvePoints(50, 1000, 5000, 0.9, { steps: 4 });
  assert.strictEqual(pts.length, 5);
  assert.strictEqual(pts[0].spend, 1000);
  assert.strictEqual(Math.round(pts[0].kill), 77);
  assert.strictEqual(pts[0].killConv, 13);
  assert.strictEqual(pts[4].spend, 5000);
  assert.strictEqual(Math.round(pts[4].kill), 58);
  assert.strictEqual(pts[4].killConv, 86);
});

check('curve points give kill and scale bounds that agree with the verdict', () => {
  const pts = ctx.confidenceCurvePoints(50, 0, 6000, 0.9);
  assert.strictEqual(pts.length, 51);
  for (const p of pts){
    if (p.spend === 0){ assert.strictEqual(p.kill, null); assert.strictEqual(p.scale, null); continue; }
    assert.ok(p.scale < 50, 'scale bound below target');
    if (p.kill !== null){
      assert.ok(p.kill > 50, 'kill bound above target');
      assert.strictEqual(ctx.confidenceVerdict(p.spend, p.killConv, 50), 'Cut');
      assert.notStrictEqual(ctx.confidenceVerdict(p.spend, p.killConv + 1, 50), 'Cut');
    }
    assert.strictEqual(ctx.confidenceVerdict(p.spend, p.scaleConv, 50), 'Scale');
    assert.notStrictEqual(ctx.confidenceVerdict(p.spend, p.scaleConv - 1, 50), 'Scale');
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.confidenceCurvePoints(0, 0, 100, 0.9))), []);
});

check('zero conversions: Testing below about 2.3x target, Cut above it', () => {
  assert.ok(Math.abs(ctx.confidenceBounds(0).kill - Math.log(10)) < 1e-9, 'kill line at -ln(0.1) = 2.303x target');
  for (const [mult, want] of [[1, 'Testing'], [2, 'Testing'], [2.3, 'Testing'], [2.31, 'Cut'], [3, 'Cut']]){
    assert.strictEqual(ctx.confidenceVerdict(50 * mult, 0, 50), want, mult + 'x JS');
    assert.strictEqual(evalVerdictSQL(SQL, { SPEND: 50 * mult, CONV: 0, TARGET: 50 }), want, mult + 'x SQL');
  }
});

check('missing or zero target, NULL spend or NULL conversions grade safely', () => {
  for (const [s, c, t, want] of [[100, 0, 0, 'Testing'], [100, 0, null, 'Testing'], [null, 0, 50, 'Testing'], [500, null, 50, 'Cut'], [0, 0, 50, 'Testing']]){
    assert.strictEqual(evalVerdictSQL(SQL, { SPEND: s, CONV: c, TARGET: t }), want, `${s},${c},${t} SQL`);
    assert.strictEqual(ctx.confidenceVerdict(s, c, t), want, `${s},${c},${t} JS`);
  }
});

check('separate scale columns: Scale is tested first and wins a tie', () => {
  const sql = ctx.confidenceVerdictSQL('SPEND', 'CONV', 'TARGET', { scaleConvCol: 'SCONV', scaleTargetCol: 'STARGET' });
  // Kill input says Cut (0 plan-assigned at 3x), scale input says Scale.
  const v = { SPEND: 150, CONV: 0, TARGET: 50, SCONV: 20, STARGET: 50 };
  assert.strictEqual(evalVerdictSQL(sql, v), 'Scale');
  assert.strictEqual(ctx.confidenceVerdict(150, 0, 50, { scaleConv: 20, scaleTarget: 50 }), 'Scale');
  assert.strictEqual(evalVerdictSQL(sql, Object.assign({}, v, { SCONV: 1 })), 'Cut');
  assert.strictEqual(ctx.confidenceVerdict(150, 0, 50, { scaleConv: 1, scaleTarget: 50 }), 'Cut');
});

check('no existing global, tier or score output changes when the helper is unused', () => {
  const start = UTILS.indexOf('/* ==== CONFIDENCE LINES START');
  const endMarker = '/* ==== CONFIDENCE LINES END';
  const end = UTILS.indexOf('\n', UTILS.indexOf(endMarker)) + 1;
  assert.ok(start > 0 && end > start, 'block markers present');
  const without = makeCtx(UTILS.slice(0, start) + UTILS.slice(end));
  const added = new Set(['poissonCdf', 'confidenceBounds', 'confidenceVerdict', 'confidenceVerdictSQL',
    'confidenceCurvePoints', 'CONFIDENCE_TABLE_MAX', '_confidenceTables', '_confidenceLevel', '_normInv',
    '_gammaQuantileWH', '_solveFalling', '_confidenceTable', '_confidenceOpts', '_sqlNum', '_sqlNumList']);
  const keys = (o) => Object.keys(o).filter((k) => !added.has(k)).sort();
  const fresh = makeCtx();
  assert.deepStrictEqual(keys(fresh), keys(without), 'global names');
  assert.deepStrictEqual(keys(fresh.window), keys(without.window), 'window names');
  const same = (fn) => assert.strictEqual(fn(fresh), fn(without));
  if (typeof fresh.classificationCaseSQL === 'function') same((c) => c.classificationCaseSQL('spend', 'cpa'));
  if (typeof fresh.creativeScoreSQL === 'function') same((c) => c.creativeScoreSQL('SPEND', 'METRIC', {}));
  if (typeof fresh.lifetimeMetricSQL === 'function') same((c) => String(c.lifetimeMetricSQL('spend', 'conv')));
  // Top-level consts are not sandbox properties, so read them inside the context.
  same((c) => vm.runInContext('JSON.stringify(typeof PRODUCTION_DEFAULTS === "undefined" ? null : PRODUCTION_DEFAULTS)', c));
  same((c) => vm.runInContext('JSON.stringify(typeof THRESHOLDS === "undefined" ? null : THRESHOLDS)', c));
});

check('emitted SQL carries no em-dash or en-dash (policy no-em-dashes-in-any-output)', () => {
  assert.ok(SQL.indexOf('\u2014') === -1 && SQL.indexOf('\u2013') === -1);
});

console.log('\nConfidence lines: ' + passed + ' checks passed.');
