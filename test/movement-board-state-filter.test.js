/**
 * Movement Board ad-state filter (SHOW_STATE_FILTER).
 *
 * A config-gated dropdown that narrows the Movement Board to a single ad state.
 * Like the zero-spend filter it defaults off, is a display filter applied after
 * classification, and uses the display label (so a renamed state reads the same
 * way the board does) over the internal state key as the option value.
 *
 * Run: node test/movement-board-state-filter.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const UTILS = fs.readFileSync(path.join(__dirname, '..', 'f10-utils.js'), 'utf8');
const EXPORT = `
this.__S = {
  stateFilterEnabled, stateFilterActive, applyStateFilter, stateFilterOptionsHTML,
  STATE_ORDER, stateLabel,
  setFilter: (v) => { stateFilter = v; },
};`;

function load(cfg){
  const sandbox = { window: {}, document: { documentElement: {} }, console };
  Object.assign(sandbox, cfg || {});
  vm.createContext(sandbox);
  vm.runInContext(UTILS + EXPORT, sandbox, { filename: 'f10-utils.js' });
  return sandbox.__S;
}

const ADS = [
  { ad_id: 'a', state: 'Scaling Winner', sCur: 900 },
  { ad_id: 'b', state: 'Fading', sCur: 400 },
  { ad_id: 'c', state: 'Dropped Off', sCur: 0 },
  { ad_id: 'd', state: 'Fading', sCur: 120 },
  { ad_id: 'e', state: 'Steady', sCur: 300 },
];

let passed = 0;
function check(name, fn){ fn(); passed++; console.log('  ok -', name); }

(() => {
  console.log('Movement Board state filter');

  check('off unless the dashboard opts in with the literal true', () => {
    assert.strictEqual(load().stateFilterEnabled(), false);
    assert.strictEqual(load({ SHOW_STATE_FILTER: true }).stateFilterEnabled(), true);
    assert.strictEqual(load({ SHOW_STATE_FILTER: 'yes' }).stateFilterEnabled(), false);
  });

  check('with the filter off, everything passes even if a value was set', () => {
    const s = load();
    s.setFilter('Fading');
    assert.strictEqual(s.applyStateFilter(ADS).length, ADS.length);
    assert.strictEqual(s.stateFilterActive(), false);
  });

  check('default selection (__all__) passes everything', () => {
    const s = load({ SHOW_STATE_FILTER: true });
    assert.strictEqual(s.applyStateFilter(ADS).length, ADS.length);
    assert.strictEqual(s.stateFilterActive(), false);
  });

  check('selecting a state keeps only ads in that state', () => {
    const s = load({ SHOW_STATE_FILTER: true });
    s.setFilter('Fading');
    assert.strictEqual(s.stateFilterActive(), true);
    const kept = s.applyStateFilter(ADS);
    assert.deepStrictEqual(kept.map(a => a.ad_id), ['b', 'd']);
  });

  check('filters on the internal state key, not the display label', () => {
    // With STATE_LABELS, Dropped Off shows as Zero Spend but the value stays the key.
    const s = load({ SHOW_STATE_FILTER: true, STATE_LABELS: { 'Dropped Off': 'Zero Spend' } });
    s.setFilter('Dropped Off');
    assert.deepStrictEqual(s.applyStateFilter(ADS).map(a => a.ad_id), ['c']);
  });

  check('the options list is All states plus every state in order', () => {
    const s = load({ SHOW_STATE_FILTER: true });
    const html = s.stateFilterOptionsHTML();
    assert.ok(html.includes('value="__all__" selected>All states<'), html);
    s.STATE_ORDER.forEach(name => {
      assert.ok(html.includes(`value="${name}">`), 'missing option for ' + name);
    });
    // Order preserved: Scaling Winner before Steady.
    assert.ok(html.indexOf('Scaling Winner') < html.indexOf('>Steady<'), html);
  });

  check('option labels use the display name; values stay the internal key', () => {
    const s = load({ SHOW_STATE_FILTER: true, STATE_LABELS: { 'Dropped Off': 'Zero Spend' } });
    const html = s.stateFilterOptionsHTML();
    assert.ok(html.includes('value="Dropped Off">Zero Spend<'), html);
  });

  console.log(`\n${passed} checks passed.`);
})();
