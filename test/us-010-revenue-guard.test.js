/**
 * US-010 — Revenue-integrity guard acceptance test.
 *
 * Verifies the dashboard-side half of the guard: in ROAS mode a window with
 * blended revenue 0 while spend > 0 surfaces a warning banner instead of a
 * confident 0.0x, healthy revenue renders normally, and CPA mode is completely
 * unaffected. Dependency-free: loads the real f10-utils.js + f10-layout.js
 * sources into a vm sandbox with a minimal DOM stub, then exercises the exported
 * globals (revenueSignalBroken / applyRevenueGuard / revenueGuardBannerHTML).
 *
 * Run: node test/us-010-revenue-guard.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const LAYOUT = fs.readFileSync(path.join(ROOT, 'f10-layout.js'), 'utf8');

/* Build a fresh sandbox with a tiny DOM stub. `targetMetric` of undefined leaves
 * TARGET_METRIC unset (typeof -> 'undefined' -> CPA); 'roas' sets ROAS mode. */
function makeCtx(targetMetric){
  const slots = {}; // id -> { innerHTML }
  const sandbox = {
    window: {},
    console: console,
    document: {
      getElementById(id){ return (slots[id] = slots[id] || { innerHTML: '' }); },
    },
    _slots: slots,
  };
  if (targetMetric !== undefined) sandbox.TARGET_METRIC = targetMetric;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  return sandbox;
}

let passed = 0;
function check(name, fn){ fn(); passed++; console.log('  ok -', name); }

console.log('US-010 revenue-integrity guard');

// ── Scenario 1: ROAS + revenue=0, spend>0 → broken, banner shown, no 0.0x ──
check('ROAS zeroed-revenue window trips the guard', () => {
  const ctx = makeCtx('roas');
  assert.strictEqual(ctx.revenueSignalBroken(0, 5000), true, 'revenue 0 / spend 5000 must be broken');
  const broken = ctx.applyRevenueGuard('summary-revenue-guard', ctx.revenueSignalBroken(0, 5000));
  assert.strictEqual(broken, true);
  const html = ctx._slots['summary-revenue-guard'].innerHTML;
  assert.ok(/Revenue data looks incomplete for this window/.test(html), 'banner copy must be present');
  assert.ok(/Check the pipeline before acting/.test(html), 'banner call-to-action must be present');
  assert.ok(!/0\.0x/.test(html), 'a broken window must not render a confident 0.0x');
});

// ── Scenario 2: ROAS + healthy revenue → no banner, renders normally ──
check('ROAS healthy-revenue window does not trip the guard', () => {
  const ctx = makeCtx('roas');
  assert.strictEqual(ctx.revenueSignalBroken(24000, 5000), false, 'revenue > 0 is healthy');
  const broken = ctx.applyRevenueGuard('summary-revenue-guard', ctx.revenueSignalBroken(24000, 5000));
  assert.strictEqual(broken, false);
  assert.strictEqual(ctx._slots['summary-revenue-guard'].innerHTML, '', 'no banner on healthy revenue');
});

// ── Scenario 3: CPA mode → guard never fires, whatever the aggregates ──
check('CPA mode never trips the guard', () => {
  const ctx = makeCtx(undefined); // TARGET_METRIC unset -> CPA
  assert.strictEqual(ctx.targetMetric(), 'cpa');
  // Even the exact broken-looking aggregate must stay quiet in CPA mode.
  assert.strictEqual(ctx.revenueSignalBroken(0, 5000), false);
  assert.strictEqual(ctx.revenueSignalBroken(0, 0), false);
  const broken = ctx.applyRevenueGuard('summary-revenue-guard', ctx.revenueSignalBroken(0, 5000));
  assert.strictEqual(broken, false);
  assert.strictEqual(ctx._slots['summary-revenue-guard'].innerHTML, '', 'CPA must never show the banner');
});

// ── Edge: real spend but ZERO spend window (no spend) never trips ──
check('a zero-spend window never trips the guard', () => {
  const ctx = makeCtx('roas');
  assert.strictEqual(ctx.revenueSignalBroken(0, 0), false, 'no spend -> nothing to understate');
});

// ── Edge: the production-tab per-ad derivation (some spend, no positive ROAS) ──
check('production-tab derivation: spend present but no ad has positive ROAS is broken', () => {
  const ctx = makeCtx('roas');
  const scatter = [
    { lifetime_spend: 1200, lifetime_roas: 0 },
    { lifetime_spend: 800,  lifetime_roas: 0 },
  ];
  const mCol = ctx.lifetimeMetricCol(); // 'lifetime_roas' in ROAS mode
  const broken = ctx.targetMetric() === 'roas'
    && scatter.some(r => (Number(r.lifetime_spend) || 0) > 0)
    && !scatter.some(r => (Number(r[mCol]) || 0) > 0);
  assert.strictEqual(broken, true);
  // One ad earning revenue (a normal account with a Strike Out) must NOT trip it.
  const mixed = [ { lifetime_spend: 1200, lifetime_roas: 0 }, { lifetime_spend: 800, lifetime_roas: 3.4 } ];
  const brokenMixed = ctx.targetMetric() === 'roas'
    && mixed.some(r => (Number(r.lifetime_spend) || 0) > 0)
    && !mixed.some(r => (Number(r[mCol]) || 0) > 0);
  assert.strictEqual(brokenMixed, false, 'a lone Strike Out among earners is valid, not a broken signal');
});

console.log(`\nUS-010: ${passed} checks passed.`);
