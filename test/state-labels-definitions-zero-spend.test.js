/**
 * State display labels, hover definitions, and the zero-spend filter.
 *
 * Three config-gated features, all defaulting to today's behaviour so every
 * dashboard already on this framework is unchanged:
 *
 *   STATE_LABELS            — rename an ad state for display only. The internal
 *                             key classify() produces never moves, so
 *                             BRANDING.chartState and STATE_META keep matching.
 *   STATE_DEFINITIONS       — override the built-in hover wording per state.
 *   METRIC_DEFINITIONS      — same for metric tiles.
 *   SHOW_DEFINITIONS=false  — turn hover text off entirely.
 *   SHOW_ZERO_SPEND_FILTER  — opt in to the hide-zero-spend control.
 *
 * Loads f10-utils.js into a vm sandbox with various configs and inspects the
 * resolved helpers.
 *
 * Run: node test/state-labels-definitions-zero-spend.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const UTILS = fs.readFileSync(path.join(__dirname, '..', 'f10-utils.js'), 'utf8');

// Top-level `const`/`function` declarations aren't exposed as vm context
// globals, so append a line in the same script scope that publishes what the
// tests need onto the context.
const EXPORT = `
this.__F = {
  stateLabel, stateDefinition, metricDefinition, defAttr, stateDefAttr, metricDefAttr,
  showDefinitions, zeroSpendFilterEnabled, isZeroSpendAd, applyZeroSpendFilter,
  STATE_META,
  setHide: (v) => { hideZeroSpend = v; },
};`;

function load(cfg) {
  const sandbox = { window: {}, document: { documentElement: {} }, console };
  Object.assign(sandbox, cfg || {});
  vm.createContext(sandbox);
  vm.runInContext(UTILS + EXPORT, sandbox, { filename: 'f10-utils.js' });
  return sandbox.__F;
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

(() => {
  console.log('State labels, definitions, zero-spend filter');

  // ── STATE_LABELS ──────────────────────────────────────────────────────────
  check('no STATE_LABELS leaves every state reading as it does today', () => {
    const f = load();
    ['Scaling Winner', 'Efficient but Shrinking', 'Fading',
     'New Entrant', 'Dropped Off', 'Steady'].forEach(s => {
      assert.strictEqual(f.stateLabel(s), s);
    });
  });

  check('STATE_LABELS renames only the mapped state', () => {
    const f = load({ STATE_LABELS: { 'Dropped Off': 'Zero Spend' } });
    assert.strictEqual(f.stateLabel('Dropped Off'), 'Zero Spend');
    assert.strictEqual(f.stateLabel('Fading'), 'Fading');
    assert.strictEqual(f.stateLabel('Steady'), 'Steady');
  });

  check('renaming for display does not move the internal STATE_META key', () => {
    // This is the whole point of renaming at the display layer: a client config
    // that themed 'Dropped Off' must keep matching after the rename.
    const f = load({
      STATE_LABELS: { 'Dropped Off': 'Zero Spend' },
      BRANDING: { chartState: { 'Dropped Off': '#123456' } },
    });
    assert.strictEqual(f.STATE_META['Dropped Off'].color, '#123456');
    assert.strictEqual(f.STATE_META['Zero Spend'], undefined);
  });

  check('a state mapped to empty string renders empty, not the fallback', () => {
    const f = load({ STATE_LABELS: { Steady: '' } });
    assert.strictEqual(f.stateLabel('Steady'), '');
  });

  check('an unmapped state passes through untouched', () => {
    const f = load({ STATE_LABELS: { 'Dropped Off': 'Zero Spend' } });
    assert.strictEqual(f.stateLabel('Something New'), 'Something New');
  });

  // ── Definitions ───────────────────────────────────────────────────────────
  check('every state classify() can produce has a built-in definition', () => {
    const f = load();
    ['Scaling Winner', 'Efficient but Shrinking', 'Fading',
     'New Entrant', 'Dropped Off', 'Steady'].forEach(s => {
      assert.ok(f.stateDefinition(s).length > 20, 'missing definition for ' + s);
    });
  });

  check('every graded tier and efficiency metric has a definition', () => {
    const f = load();
    ['home run', 'on base', 'strike out', 'testing', 'zero spend',
     'spend', 'conversions', 'impressions', 'cpa', 'cpc', 'cpm', 'ctr', 'roas', 'revenue']
      .forEach(k => assert.ok(f.metricDefinition(k).length > 10, 'missing definition for ' + k));
  });

  check('metric definitions look up case-insensitively', () => {
    const f = load();
    assert.strictEqual(f.metricDefinition('CPA'), f.metricDefinition('cpa'));
    assert.strictEqual(f.metricDefinition('ROAS'), f.metricDefinition('roas'));
  });

  check('an unknown key returns empty rather than throwing', () => {
    const f = load();
    assert.strictEqual(f.metricDefinition('not a metric'), '');
    assert.strictEqual(f.stateDefinition('not a state'), '');
    assert.strictEqual(f.metricDefinition(undefined), '');
  });

  check('STATE_DEFINITIONS and METRIC_DEFINITIONS override the built-ins', () => {
    const f = load({
      STATE_DEFINITIONS: { Fading: 'Client wording for fading.' },
      METRIC_DEFINITIONS: { spend: 'Client wording for spend.' },
    });
    assert.strictEqual(f.stateDefinition('Fading'), 'Client wording for fading.');
    assert.strictEqual(f.metricDefinition('spend'), 'Client wording for spend.');
    // Unoverridden entries keep the built-in wording.
    assert.ok(f.stateDefinition('Steady').length > 20);
  });

  check('definitions are on by default and SHOW_DEFINITIONS=false turns them off', () => {
    assert.strictEqual(load().showDefinitions(), true);
    assert.strictEqual(load({ SHOW_DEFINITIONS: false }).showDefinitions(), false);
    assert.strictEqual(load({ SHOW_DEFINITIONS: true }).showDefinitions(), true);
  });

  check('defAttr emits a leading space so it drops straight into a tag', () => {
    const f = load();
    const attr = f.defAttr('Some text.');
    assert.ok(attr.startsWith(' title="'), attr);
    assert.ok(attr.endsWith('"'));
  });

  check('defAttr escapes quotes and angle brackets so it cannot break the tag', () => {
    const f = load();
    const attr = f.defAttr('He said "hi" & <b>left</b>');
    assert.ok(!/[<>]/.test(attr.slice(8)), attr);
    assert.ok(attr.includes('&quot;'), attr);
    assert.ok(attr.includes('&amp;'), attr);
    assert.ok(attr.includes('&lt;b&gt;'), attr);
  });

  check('defAttr escapes the ampersand before the entities it introduces', () => {
    // Ordering bug guard: escaping " before & would turn &quot; into &amp;quot;.
    const f = load();
    assert.strictEqual(f.defAttr('a & b'), ' title="a &amp; b"');
    assert.strictEqual(f.defAttr('say "x"'), ' title="say &quot;x&quot;"');
  });

  check('defAttr returns empty when definitions are off or text is missing', () => {
    assert.strictEqual(load({ SHOW_DEFINITIONS: false }).defAttr('Some text.'), '');
    assert.strictEqual(load().defAttr(''), '');
    assert.strictEqual(load().defAttr(undefined), '');
  });

  check('stateDefAttr and metricDefAttr wrap their lookups', () => {
    const f = load();
    assert.ok(f.stateDefAttr('Dropped Off').startsWith(' title="'));
    assert.ok(f.metricDefAttr('home run').startsWith(' title="'));
    assert.strictEqual(f.stateDefAttr('not a state'), '');
  });

  // ── Zero-spend filter ─────────────────────────────────────────────────────
  const ads = [
    { ad_id: 'a', sCur: 1200, state: 'Scaling Winner' },
    { ad_id: 'b', sCur: 0,    state: 'Dropped Off' },
    { ad_id: 'c', sCur: 5e-7, state: 'Dropped Off' }, // below the 1e-6 epsilon
    { ad_id: 'd', sCur: 40,   state: 'Fading' },
  ];

  check('the filter is off unless the dashboard opts in', () => {
    assert.strictEqual(load().zeroSpendFilterEnabled(), false);
    assert.strictEqual(load({ SHOW_ZERO_SPEND_FILTER: true }).zeroSpendFilterEnabled(), true);
    assert.strictEqual(load({ SHOW_ZERO_SPEND_FILTER: 'yes' }).zeroSpendFilterEnabled(), false);
  });

  check('isZeroSpendAd uses the same epsilon as classify()', () => {
    const f = load();
    assert.strictEqual(f.isZeroSpendAd({ sCur: 0 }), true);
    assert.strictEqual(f.isZeroSpendAd({ sCur: 5e-7 }), true);
    assert.strictEqual(f.isZeroSpendAd({ sCur: 2e-6 }), false);
    assert.strictEqual(f.isZeroSpendAd({ sCur: 100 }), false);
    // Missing or malformed rows are treated as zero spend, never crash.
    assert.strictEqual(f.isZeroSpendAd({}), true);
    assert.strictEqual(f.isZeroSpendAd(null), true);
  });

  check('an opted-in dashboard still shows everything until Hide is chosen', () => {
    const f = load({ SHOW_ZERO_SPEND_FILTER: true });
    assert.strictEqual(f.applyZeroSpendFilter(ads).length, 4);
  });

  check('Hide drops exactly the zero-spend ads', () => {
    const f = load({ SHOW_ZERO_SPEND_FILTER: true });
    f.setHide(true);
    const kept = f.applyZeroSpendFilter(ads);
    assert.deepStrictEqual(kept.map(a => a.ad_id), ['a', 'd']);
  });

  check('Hide does nothing on a dashboard that never opted in', () => {
    const f = load();
    f.setHide(true);
    assert.strictEqual(f.applyZeroSpendFilter(ads).length, 4);
  });

  check('the filter returns the same array reference when inactive', () => {
    // Guards against a needless copy on every board render.
    const f = load();
    assert.strictEqual(f.applyZeroSpendFilter(ads), ads);
  });

  console.log(`\n${passed} checks passed.`);
})();

/**
 * FULL_COVERAGE_TIERS — the graded tiers partition the ad base.
 *
 * The default CASE drops two very different kinds of ad into 'Unclassified':
 * ads that spent real money and converted nothing (metric NULL, so they fail
 * every branch including Strike Out), and ads that never spent enough to be
 * judged. That is why Home Run + On Base + Strike Out never sums to 100% and
 * why the strike-out rate understates reality.
 *
 * With the flag on, every ad grades into exactly one of five tiers. Off, the
 * emitted SQL must be byte-identical to what it was.
 */
(() => {
  console.log('\nFULL_COVERAGE_TIERS');

  const EXPORT2 = `
this.__G = { classificationCaseSQL, classificationTiers, fullCoverageTiers, CLASS_COLOR, targetMetric };`;

  function loadG(cfg) {
    const sandbox = { window: {}, document: { documentElement: {} }, console };
    Object.assign(sandbox, cfg || {});
    vm.createContext(sandbox);
    vm.runInContext(UTILS + EXPORT2, sandbox, { filename: 'f10-utils.js' });
    return sandbox.__G;
  }

  // The exact strings the framework emitted before this change, for both modes.
  const LEGACY_CPA =
    "CASE WHEN s >= 5000 AND m > 0 AND m < 100 THEN 'Home Run'" +
    " WHEN s >= 1000 AND m > 0 AND m < 200 THEN 'On Base'" +
    " WHEN s >= 1000 AND m > 200 THEN 'Strike Out'" +
    " ELSE 'Unclassified' END";
  const LEGACY_ROAS =
    "CASE WHEN s >= 5000 AND m > 4 THEN 'Home Run'" +
    " WHEN s >= 1000 AND m > 2 THEN 'On Base'" +
    " WHEN s >= 1000 AND m < 1 THEN 'Strike Out'" +
    " ELSE 'Unclassified' END";

  const TH = { HR_SPEND: 5000, HR_CPA: 100, OB_SPEND: 1000, OB_CPA: 200, SO_SPEND: 1000, SO_CPA: 200,
               HR_ROAS: 4, OB_ROAS: 2, SO_ROAS: 1 };

  check('off by default, and only the literal true turns it on', () => {
    assert.strictEqual(loadG({ THRESHOLDS: TH }).fullCoverageTiers(), false);
    assert.strictEqual(loadG({ THRESHOLDS: TH, FULL_COVERAGE_TIERS: true }).fullCoverageTiers(), true);
    assert.strictEqual(loadG({ THRESHOLDS: TH, FULL_COVERAGE_TIERS: 'yes' }).fullCoverageTiers(), false);
  });

  check('with the flag off the CPA SQL is byte-identical to the legacy CASE', () => {
    const g = loadG({ THRESHOLDS: TH });
    assert.strictEqual(g.classificationCaseSQL('s', 'm'), LEGACY_CPA);
  });

  check('with the flag off the ROAS SQL is byte-identical to the legacy CASE', () => {
    const g = loadG({ THRESHOLDS: TH, TARGET_METRIC: 'roas' });
    assert.strictEqual(g.classificationCaseSQL('s', 'm'), LEGACY_ROAS);
  });

  check('with the flag on, Strike Out drops its metric test so zero-conversion ads land there', () => {
    const g = loadG({ THRESHOLDS: TH, FULL_COVERAGE_TIERS: true });
    const sql = g.classificationCaseSQL('s', 'm');
    // The strike-out branch gates on spend alone. A NULL metric (spend / 0
    // conversions) reaches it and grades Strike Out instead of vanishing.
    assert.ok(sql.includes("WHEN s >= 1000 THEN 'Strike Out'"), sql);
    assert.ok(!sql.includes("Unclassified"), sql);
  });

  check('with the flag on, every ad falls into exactly one tier', () => {
    const g = loadG({ THRESHOLDS: TH, FULL_COVERAGE_TIERS: true });
    const sql = g.classificationCaseSQL('s', 'm');
    assert.ok(sql.includes("WHEN s > 0 THEN 'Testing'"), sql);
    assert.ok(sql.endsWith("ELSE 'Zero Spend' END"), sql);
  });

  check('the ROAS branch honours the flag the same way', () => {
    const g = loadG({ THRESHOLDS: TH, TARGET_METRIC: 'roas', FULL_COVERAGE_TIERS: true });
    const sql = g.classificationCaseSQL('s', 'm');
    assert.ok(sql.includes("WHEN s >= 5000 AND m > 4 THEN 'Home Run'"), sql);
    assert.ok(sql.includes("WHEN s >= 1000 THEN 'Strike Out'"), sql);
    assert.ok(!sql.includes("Unclassified"), sql);
  });

  check('classificationTiers tracks the flag', () => {
    // Arrays cross the vm realm boundary, so compare by value not identity.
    assert.strictEqual(loadG({ THRESHOLDS: TH }).classificationTiers().join('|'),
      'Home Run|On Base|Strike Out|Unclassified');
    assert.strictEqual(loadG({ THRESHOLDS: TH, FULL_COVERAGE_TIERS: true }).classificationTiers().join('|'),
      'Home Run|On Base|Strike Out|Testing|Zero Spend');
  });

  check('every tier the active CASE can emit has a chart colour', () => {
    [{ THRESHOLDS: TH }, { THRESHOLDS: TH, FULL_COVERAGE_TIERS: true }].forEach(cfg => {
      const g = loadG(cfg);
      g.classificationTiers().forEach(t =>
        assert.ok(g.CLASS_COLOR[t], 'no colour for tier ' + t));
    });
  });

  check('the legacy tier keeps its colour when the flag is on', () => {
    // Nothing should lose a colour just because new tiers were added.
    const g = loadG({ THRESHOLDS: TH, FULL_COVERAGE_TIERS: true });
    assert.ok(g.CLASS_COLOR['Unclassified']);
  });

  console.log(`\n${passed} checks passed.`);
})();
