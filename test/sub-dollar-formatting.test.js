/**
 * fmt$() sub-dollar formatting regression test.
 *
 * Bug: fmt$() hardcoded maximumFractionDigits:0, so a genuine sub-dollar figure
 * (e.g. LinkedIn's cost-per-click, often $0.10-$0.70) rounded to '$0' or '$1' and
 * read as missing/free on the Ad Production and Ad Decay tabs. Fixed by mirroring
 * the same <$10 -> 2dp threshold fmtMetric()'s 'money' branch already used for
 * ROAS, so the fix is consistent with an existing convention, not a new one.
 *
 * Must hold:
 *   1. Values under $10 show 2 decimal places (the actual bug).
 *   2. Values at/over $10 stay whole-dollar — every existing dashboard's normal
 *      spend/CPA figures must render byte-for-byte unchanged.
 *   3. null/blank/NaN still render '–', unchanged.
 *
 * Run: node test/sub-dollar-formatting.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');

function makeCtx(){
  const sandbox = {
    window: {},
    console: { log(){}, error(){}, warn(){} },
    document: { getElementById(){ return null; }, querySelector(){ return null; }, querySelectorAll(){ return []; } },
  };
  sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  return sandbox;
}

let passed = 0;
function check(name, fn){
  try { fn(); console.log('  ok - ' + name); passed++; }
  catch (e){ console.error('  FAIL - ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('Sub-dollar fmt$() formatting');

const ctx = makeCtx();

check('a real LinkedIn cost-per-click ($0.10) no longer rounds to $0', () => {
  assert.strictEqual(ctx.fmt$(0.10), '$0.10');
});

check('a value just under $1 renders 2dp, not $0 or $1', () => {
  assert.strictEqual(ctx.fmt$(0.67), '$0.67');
});

check('a value between $1 and $10 also gets 2dp (e.g. $6.83, one of Skip\'s real bands)', () => {
  assert.strictEqual(ctx.fmt$(6.83), '$6.83');
});

check('exactly $10 is the whole-dollar boundary (>=10 stays 0dp)', () => {
  assert.strictEqual(ctx.fmt$(10), '$10');
});

check('ordinary spend ($21,976.80) is unchanged — whole dollars, comma-grouped', () => {
  assert.strictEqual(ctx.fmt$(21976.80), '$21,977');
});

check('a small whole-number spend under $10 (e.g. a $5 test spend) still shows 2dp, not a silent behaviour change only for CPA', () => {
  assert.strictEqual(ctx.fmt$(5), '$5.00');
});

check('null / blank / NaN are unaffected — still the placeholder dash', () => {
  assert.strictEqual(ctx.fmt$(null), '–');
  assert.strictEqual(ctx.fmt$(''), '–');
  assert.strictEqual(ctx.fmt$(NaN), '–');
});

check('fmtMetricCell in CPA mode still routes through fmt$ and inherits the fix', () => {
  assert.strictEqual(ctx.fmtMetricCell(0.30), '$0.30');
});

console.log(`\nSub-dollar fmt$() formatting: ${passed} checks passed.`);
