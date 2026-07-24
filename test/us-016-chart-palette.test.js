/**
 * US-016 — themeable chart palette.
 *
 * The chart colour constants in f10-utils.js (COHORT_COLORS, CLASS_COLOR,
 * AGE_COLORS, STATE_META, CHART_PRIMARY/SECONDARY/NEGATIVE) may be overridden per
 * client via BRANDING keys, which are defined in the dashboard config block before
 * the scripts load. With no BRANDING the F10 palette must be reproduced exactly.
 *
 * Loads f10-utils.js into a vm sandbox (with/without BRANDING) and inspects the
 * resolved constants.
 *
 * Run: node test/us-016-chart-palette.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const UTILS = fs.readFileSync(path.join(__dirname, '..', 'f10-utils.js'), 'utf8');

// Top-level `const`s aren't exposed as vm context globals, so append a line
// (same script scope) that publishes the palette constants onto the context.
const EXPORT = '\nthis.__P = { CHART_PRIMARY, CHART_SECONDARY, CHART_NEGATIVE, COHORT_COLORS, CLASS_COLOR, AGE_COLORS, STATE_META };';

function load(branding) {
  const sandbox = { window: {}, document: { documentElement: {} }, console };
  if (branding !== undefined) sandbox.BRANDING = branding;
  vm.createContext(sandbox);
  vm.runInContext(UTILS + EXPORT, sandbox, { filename: 'f10-utils.js' });
  return sandbox.__P;
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

(() => {
  console.log('US-016 themeable chart palette');

  // ── Backward-compat: no BRANDING reproduces the F10 palette exactly. ──
  check('no BRANDING keeps the F10 defaults', () => {
    const s = load(undefined);
    assert.strictEqual(s.CHART_PRIMARY, '#c8ff00');
    assert.strictEqual(s.CHART_SECONDARY, '#4a90e2');
    assert.strictEqual(s.CHART_NEGATIVE, '#fa023c');
    assert.strictEqual(s.COHORT_COLORS[0], '#c8ff00');
    assert.strictEqual(s.CLASS_COLOR['Home Run'], '#c8ff00');
    assert.strictEqual(s.CLASS_COLOR['Strike Out'], '#fa023c');
    assert.strictEqual(s.STATE_META['Fading'].color, '#fa023c');
    assert.strictEqual(s.STATE_META['Efficient but Shrinking'].color, '#4a90e2');
  });

  // ── Semantic overrides cascade: setting primary/secondary/negative recolours the class map. ──
  check('chartPrimary/Secondary/Negative recolour Home Run / On Base / Strike Out', () => {
    const s = load({ chartPrimary: '#13356B', chartSecondary: '#00858F', chartNegative: '#CF3160' });
    assert.strictEqual(s.CLASS_COLOR['Home Run'], '#13356B');
    assert.strictEqual(s.CLASS_COLOR['On Base'], '#00858F');
    assert.strictEqual(s.CLASS_COLOR['Strike Out'], '#CF3160');
    assert.strictEqual(s.AGE_COLORS['0–14 Days'], '#13356B');
    assert.strictEqual(s.STATE_META['Fading'].color, '#CF3160');       // derives from negative
    assert.strictEqual(s.CLASS_COLOR['Unclassified'], '#b0b0b0');      // neutral unchanged
  });

  // ── Explicit maps win over the derived defaults. ──
  check('chartPalette / chartState / chartClass override explicitly', () => {
    const pal = ['#13356B', '#00858F', '#A974FF', '#F6D000'];
    const s = load({
      chartPalette: pal,
      chartState: { 'Scaling Winner': '#13356B' },
      chartClass: { 'Home Run': '#111', 'On Base': '#222', 'Strike Out': '#333', 'Unclassified': '#444' },
    });
    assert.deepStrictEqual(s.COHORT_COLORS, pal);
    assert.strictEqual(s.STATE_META['Scaling Winner'].color, '#13356B'); // overridden
    assert.strictEqual(s.STATE_META['Steady'].color, '#f5a623');         // untouched default
    assert.strictEqual(s.CLASS_COLOR['Home Run'], '#111');               // explicit map wins
  });

  console.log(`\nUS-016 OK — ${passed} checks passed`);
})();
