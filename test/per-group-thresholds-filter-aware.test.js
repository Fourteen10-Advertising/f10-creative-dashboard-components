/**
 * Filter-aware per-group thresholds in the Ad Production UI.
 *
 * The classification SQL is per-row and always grades each product on its own
 * thresholds. This suite covers the UI context on top of that: when the Product
 * filter is on a configured group, the editor inputs, the threshold copy and the
 * scatter guide lines reflect and edit THAT group's thresholds; on "All" or an
 * unconfigured product they reflect the base.
 *
 * Run: node test/per-group-thresholds-filter-aware.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const UTILS = fs.readFileSync(path.join(__dirname, '..', 'f10-utils.js'), 'utf8');
const EXPORT = `
this.__T = {
  activeThresholdGroup, getProductionThresholds, setProductionThresholds,
  resetProductionThresholds, getGroupThresholds, classificationCaseSQL,
  setSel: (col, val) => { groupSelections[col] = val; },
  clearSel: () => { for (const k of Object.keys(groupSelections)) delete groupSelections[k]; },
};`;

const TH = { HR_SPEND: 1000, HR_CPA: 70, OB_SPEND: 250, OB_CPA: 250, SO_SPEND: 250, SO_CPA: 250 };
const SMSF = { HR_SPEND: 3000, HR_CPA: 300, OB_SPEND: 1000, OB_CPA: 1000, SO_SPEND: 1000 };

function load(){
  const sandbox = { window: {}, document: { documentElement: {} }, console };
  Object.assign(sandbox, {
    THRESHOLDS: TH, FULL_COVERAGE_TIERS: true,
    GROUP_FILTERS: [{ col: 'group_name', label: 'Product' }],
    THRESHOLDS_BY_GROUP: { col: 'group_name', groups: { SMSF } },
  });
  vm.createContext(sandbox);
  vm.runInContext(UTILS + EXPORT, sandbox, { filename: 'f10-utils.js' });
  return sandbox.__T;
}

let passed = 0;
function check(name, fn){ fn(); passed++; console.log('  ok -', name); }

(() => {
  console.log('Filter-aware per-group thresholds');

  check('no Product selection: active group is null, editor shows base', () => {
    const t = load();
    assert.strictEqual(t.activeThresholdGroup(), null);
    assert.strictEqual(t.getProductionThresholds().HR_CPA, 70);
  });

  check('Product = All: base', () => {
    const t = load();
    t.setSel('group_name', '__all__');
    assert.strictEqual(t.activeThresholdGroup(), null);
    assert.strictEqual(t.getProductionThresholds().HR_SPEND, 1000);
  });

  check('Product = an unconfigured group (Trade): base', () => {
    const t = load();
    t.setSel('group_name', 'Trade');
    assert.strictEqual(t.activeThresholdGroup(), null);
    assert.strictEqual(t.getProductionThresholds().HR_CPA, 70);
  });

  check('Product = SMSF: editor reflects the SMSF thresholds', () => {
    const t = load();
    t.setSel('group_name', 'SMSF');
    assert.strictEqual(t.activeThresholdGroup(), 'SMSF');
    const th = t.getProductionThresholds();
    assert.strictEqual(th.HR_SPEND, 3000);
    assert.strictEqual(th.HR_CPA, 300);
    assert.strictEqual(th.OB_CPA, 1000);
    // SO_CPA was not overridden, so it inherits the base value.
    assert.strictEqual(th.SO_CPA, 250);
  });

  check('editing while SMSF is active writes to SMSF, not base', () => {
    const t = load();
    t.setSel('group_name', 'SMSF');
    t.setProductionThresholds({ HR_CPA: 350 });
    assert.strictEqual(t.getGroupThresholds('SMSF').HR_CPA, 350);
    // Base is untouched.
    t.clearSel();
    assert.strictEqual(t.getProductionThresholds().HR_CPA, 70);
  });

  check('an applied SMSF edit flows into the classification SQL', () => {
    const t = load();
    t.setSel('group_name', 'SMSF');
    t.setProductionThresholds({ HR_CPA: 350 });
    const sql = t.classificationCaseSQL('lifetime_spend', 'lifetime_cpa');
    const smsf = sql.slice(sql.indexOf("'SMSF' THEN ("), sql.indexOf(') ELSE ('));
    assert.ok(smsf.includes('lifetime_cpa < 350 THEN'), smsf);   // the edited value
    // The base (ELSE) branch is unchanged.
    const base = sql.slice(sql.indexOf(') ELSE ('));
    assert.ok(base.includes('lifetime_cpa < 70 THEN'), base);
  });

  check('editing while base is active does not touch SMSF', () => {
    const t = load();
    t.setSel('group_name', '__all__');
    t.setProductionThresholds({ HR_CPA: 90 });
    assert.strictEqual(t.getProductionThresholds().HR_CPA, 90);        // base moved
    assert.strictEqual(t.getGroupThresholds('SMSF').HR_CPA, 300);      // SMSF intact
  });

  check('reset while SMSF is active restores only SMSF to its config defaults', () => {
    const t = load();
    t.setSel('group_name', 'SMSF');
    t.setProductionThresholds({ HR_CPA: 999, OB_CPA: 999 });
    t.resetProductionThresholds();
    assert.strictEqual(t.getGroupThresholds('SMSF').HR_CPA, 300);
    assert.strictEqual(t.getGroupThresholds('SMSF').OB_CPA, 1000);
  });

  console.log(`\n${passed} checks passed.`);
})();
