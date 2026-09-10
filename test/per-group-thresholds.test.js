/**
 * THRESHOLDS_BY_GROUP — per-product Ad Production thresholds.
 *
 * A multi-product account can convert on different actions per product, at very
 * different cost scales (Stake: Trade on ~$60 installs, SMSF on ~$255 Calendly
 * bookings). One Home Run / On Base ceiling would strike out every SMSF ad.
 * THRESHOLDS_BY_GROUP grades each product on its own thresholds via an outer
 * CASE on a group column, dispatched per row so it is correct even with the
 * Product filter on "All".
 *
 * With no config, the emitted SQL must be byte-identical to before.
 *
 * Run: node test/per-group-thresholds.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const UTILS = fs.readFileSync(path.join(__dirname, '..', 'f10-utils.js'), 'utf8');
const EXPORT = `
this.__T = { classificationCaseSQL, thresholdGroups, thresholdGroupCol, thresholdGroupSelect, _sqlStr };`;

function load(cfg){
  const sandbox = { window: {}, document: { documentElement: {} }, console };
  Object.assign(sandbox, cfg || {});
  vm.createContext(sandbox);
  vm.runInContext(UTILS + EXPORT, sandbox, { filename: 'f10-utils.js' });
  return sandbox.__T;
}

const TH = { HR_SPEND: 1000, HR_CPA: 70, OB_SPEND: 250, OB_CPA: 250, SO_SPEND: 250, SO_CPA: 250 };
const SMSF = { HR_SPEND: 3000, HR_CPA: 300, OB_SPEND: 1000, OB_CPA: 1000, SO_SPEND: 1000 };

let passed = 0;
function check(name, fn){ fn(); passed++; console.log('  ok -', name); }

(() => {
  console.log('THRESHOLDS_BY_GROUP');

  // ── Off by default: byte-identical SQL ──────────────────────────────────────
  check('no config: full-coverage SQL is the plain single-scale CASE', () => {
    const t = load({ THRESHOLDS: TH, FULL_COVERAGE_TIERS: true });
    const sql = t.classificationCaseSQL('s', 'm');
    assert.strictEqual(sql,
      "CASE WHEN s >= 1000 AND m > 0 AND m < 70 THEN 'Home Run'" +
      " WHEN s >= 250 AND m > 0 AND m < 250 THEN 'On Base'" +
      " WHEN s >= 250 THEN 'Strike Out'" +
      " WHEN s > 0 THEN 'Testing'" +
      " ELSE 'Zero Spend' END");
  });

  check('no config: legacy four-tier SQL is unchanged', () => {
    const t = load({ THRESHOLDS: TH });
    const sql = t.classificationCaseSQL('s', 'm');
    assert.strictEqual(sql,
      "CASE WHEN s >= 1000 AND m > 0 AND m < 70 THEN 'Home Run'" +
      " WHEN s >= 250 AND m > 0 AND m < 250 THEN 'On Base'" +
      " WHEN s >= 250 AND m > 250 THEN 'Strike Out'" +
      " ELSE 'Unclassified' END");
  });

  check('no config: thresholdGroups is null and the select fragment is empty', () => {
    const t = load({ THRESHOLDS: TH });
    assert.strictEqual(t.thresholdGroups(), null);
    assert.strictEqual(t.thresholdGroupSelect(), '');
    assert.strictEqual(t.thresholdGroupCol(), null);
  });

  // ── Per-group dispatch ──────────────────────────────────────────────────────
  const CFG = { THRESHOLDS: TH, FULL_COVERAGE_TIERS: true,
                THRESHOLDS_BY_GROUP: { col: 'group_name', groups: { SMSF } } };

  check('outer CASE dispatches on the group column', () => {
    const t = load(CFG);
    const sql = t.classificationCaseSQL('lifetime_spend', 'lifetime_cpa');
    assert.ok(sql.startsWith("CASE WHEN group_name = 'SMSF' THEN ("), sql.slice(0, 60));
    assert.ok(sql.includes(') ELSE ('), sql);
    assert.ok(sql.trimEnd().endsWith('END'), sql.slice(-40));
  });

  check('the SMSF branch uses SMSF thresholds', () => {
    const t = load(CFG);
    const sql = t.classificationCaseSQL('lifetime_spend', 'lifetime_cpa');
    const smsf = sql.slice(sql.indexOf("'SMSF' THEN ("), sql.indexOf(') ELSE ('));
    assert.ok(smsf.includes('lifetime_spend >= 3000 AND lifetime_cpa > 0 AND lifetime_cpa < 300'), smsf);
    assert.ok(smsf.includes('lifetime_spend >= 1000 AND lifetime_cpa > 0 AND lifetime_cpa < 1000'), smsf);
    // SMSF spend gate for Strike Out is the SMSF SO_SPEND, 1000, not the base 250.
    assert.ok(smsf.includes('lifetime_spend >= 1000 THEN'), smsf);
  });

  check('the ELSE branch keeps the base thresholds', () => {
    const t = load(CFG);
    const sql = t.classificationCaseSQL('lifetime_spend', 'lifetime_cpa');
    const base = sql.slice(sql.indexOf(') ELSE ('));
    assert.ok(base.includes('lifetime_spend >= 1000 AND lifetime_cpa > 0 AND lifetime_cpa < 70'), base);
    assert.ok(base.includes('lifetime_spend >= 250 AND lifetime_cpa > 0 AND lifetime_cpa < 250'), base);
  });

  check('a partial group override inherits the rest from base', () => {
    // Only HR_CPA overridden; OB/SO spend + cpa should come from base TH.
    const t = load({ THRESHOLDS: TH, FULL_COVERAGE_TIERS: true,
                     THRESHOLDS_BY_GROUP: { col: 'group_name', groups: { Brand: { HR_CPA: 500 } } } });
    const sql = t.classificationCaseSQL('s', 'm');
    const brand = sql.slice(sql.indexOf("'Brand' THEN ("), sql.indexOf(') ELSE ('));
    assert.ok(brand.includes('s >= 1000 AND m > 0 AND m < 500 THEN'), brand);  // overridden HR_CPA
    assert.ok(brand.includes('s >= 250 AND m > 0 AND m < 250 THEN'), brand);    // inherited OB
  });

  check('the group select carries the column into the CTE', () => {
    const t = load(CFG);
    assert.strictEqual(t.thresholdGroupSelect(), ', ANY_VALUE(group_name) AS group_name');
    assert.strictEqual(t.thresholdGroupCol(), 'group_name');
  });

  // ── Guards ──────────────────────────────────────────────────────────────────
  check('a non-identifier col disables per-group thresholds', () => {
    const t = load({ THRESHOLDS: TH, THRESHOLDS_BY_GROUP: { col: 'group_name; DROP', groups: { SMSF } } });
    assert.strictEqual(t.thresholdGroups(), null);
    // Falls back to the plain base CASE, no outer dispatch.
    assert.ok(!t.classificationCaseSQL('s', 'm').includes('group_name'), 'should not reference the col');
  });

  check('empty groups map disables per-group thresholds', () => {
    const t = load({ THRESHOLDS: TH, THRESHOLDS_BY_GROUP: { col: 'group_name', groups: {} } });
    assert.strictEqual(t.thresholdGroups(), null);
  });

  check('a group value is escaped as a SQL string literal', () => {
    const t = load({ THRESHOLDS: TH, THRESHOLDS_BY_GROUP: { col: 'group_name', groups: { "O'Brien": SMSF } } });
    const sql = t.classificationCaseSQL('s', 'm');
    assert.ok(sql.includes("group_name = 'O''Brien'"), sql.slice(0, 80));
    assert.strictEqual(t._sqlStr("a'b"), "'a''b'");
  });

  check('ROAS mode dispatches per group with ROAS bands', () => {
    const t = load({ THRESHOLDS: { HR_SPEND: 5000, HR_ROAS: 4, OB_SPEND: 1000, OB_ROAS: 2, SO_SPEND: 500, SO_ROAS: 1 },
                     TARGET_METRIC: 'roas',
                     THRESHOLDS_BY_GROUP: { col: 'group_name', groups: { Wholesale: { HR_ROAS: 6, OB_ROAS: 3 } } } });
    const sql = t.classificationCaseSQL('s', 'm');
    const ws = sql.slice(sql.indexOf("'Wholesale' THEN ("), sql.indexOf(') ELSE ('));
    assert.ok(ws.includes('m > 6 THEN'), ws);   // overridden HR_ROAS
    assert.ok(ws.includes('m > 3 THEN'), ws);   // overridden OB_ROAS
    const base = sql.slice(sql.indexOf(') ELSE ('));
    assert.ok(base.includes('m > 4 THEN'), base);  // base HR_ROAS
  });

  console.log(`\n${passed} checks passed.`);
})();
