/**
 * Ad search on charts.
 *
 * The "Search ad" box filtered the ad tables only. Charts that plot one mark per
 * ad (the Movement Map, the Ad Production scatter and the Ad Power Law bars) kept
 * showing every ad, so a search on those tabs looked like it did nothing. These
 * checks cover the shared chart filter and that every per-ad chart on Meta,
 * TikTok and LinkedIn is wired to it.
 *
 * Run: node test/ad-search-charts.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UTILS = read('f10-utils.js');
const EXPORT = `
this.__S = {
  adSearchKey, adNameAttr, followAdSearch, refilterAdSearchCharts,
  setTerm: (v) => { adSearchTerm = v; },
};`;

function load(){
  const sandbox = { window: {}, document: { documentElement: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(UTILS + EXPORT, sandbox, { filename: 'f10-utils.js' });
  return sandbox.__S;
}

/* Minimal stand-in for a Chart.js instance: data, a live canvas, update(). */
function fakeChart(data){
  return { data, canvas: { isConnected: true }, updates: 0, update(){ this.updates++; } };
}

let passed = 0;
function check(name, fn){ fn(); passed++; console.log('  ok -', name); }

(() => {
  console.log('Ad search on charts');
  const S = load();
  const pt = (ad, camp) => ({ x: 1, y: 1, _key: S.adSearchKey(ad, camp) });
  const scatter = () => fakeChart({ datasets: [
    { label: 'Home Run', data: [pt('Broker_Static_Upgrade', 'TOF_Brokers'), pt('Customer_MovingBackIn', 'MOF_Consideration')] },
    { label: 'Strike Out', data: [pt('Customer_2%Deposit', 'BOF_Remarketing')] },
  ] });
  const counts = (c) => c.data.datasets.map((d) => d.data.length);

  check('adSearchKey matches the key adNameAttr writes on table rows', () => {
    assert.strictEqual(`data-adname="${S.adSearchKey('A_b', 'C d')}"`, S.adNameAttr('A_b', 'C d'));
  });

  check('no search: a per-point chart keeps every mark', () => {
    S.setTerm('');
    const c = scatter(); S.followAdSearch('t-scatter', c);
    assert.deepStrictEqual(counts(c), [2, 1]);
  });

  check('a chart drawn while a search is active starts filtered', () => {
    S.setTerm('moving back in');
    const c = scatter(); S.followAdSearch('t-scatter', c);
    assert.deepStrictEqual(counts(c), [1, 0]);
  });

  check('changing the search re-filters from the full set, and clearing restores it', () => {
    S.setTerm('');
    const c = scatter(); S.followAdSearch('t-scatter', c);
    S.setTerm('deposit'); S.refilterAdSearchCharts();
    assert.deepStrictEqual(counts(c), [0, 1]);
    S.setTerm('broker'); S.refilterAdSearchCharts();
    assert.deepStrictEqual(counts(c), [1, 0]);
    S.setTerm(''); S.refilterAdSearchCharts();
    assert.deepStrictEqual(counts(c), [2, 1]);
    assert.ok(c.updates >= 3, 'chart.update() runs on each change');
  });

  check('campaign names match on charts as they do on tables', () => {
    S.setTerm('consideration');
    const c = scatter(); S.followAdSearch('t-scatter', c);
    assert.deepStrictEqual(counts(c), [1, 0]);
  });

  check('indexed charts (power law) filter labels and every dataset together', () => {
    S.setTerm('');
    const c = fakeChart({ labels: ['#1', '#2', '#3'], datasets: [
      { data: [50, 30, 20] }, { data: [50, 80, 100] },
    ] });
    const keys = [S.adSearchKey('Broker_A'), S.adSearchKey('Customer_B'), S.adSearchKey('Broker_C')];
    S.followAdSearch('t-powerlaw', c, keys);
    S.setTerm('broker'); S.refilterAdSearchCharts();
    assert.deepStrictEqual(c.data.labels, ['#1', '#3']);
    assert.deepStrictEqual(c.data.datasets[0].data, [50, 20]);
    assert.deepStrictEqual(c.data.datasets[1].data, [50, 100]);
    S.setTerm(''); S.refilterAdSearchCharts();
    assert.deepStrictEqual(c.data.labels, ['#1', '#2', '#3']);
  });

  check('a redraw into the same slot replaces the old chart; destroyed charts are skipped', () => {
    S.setTerm('');
    const old = scatter(); S.followAdSearch('t-slot', old);
    const fresh = scatter(); S.followAdSearch('t-slot', fresh);
    old.canvas = null;
    const before = old.updates;
    S.setTerm('broker'); S.refilterAdSearchCharts();
    assert.strictEqual(old.updates, before);
    assert.deepStrictEqual(counts(fresh), [1, 0]);
    const gone = scatter(); S.followAdSearch('t-gone', gone);
    gone.canvas = null;
    assert.doesNotThrow(() => S.refilterAdSearchCharts());
  });

  check('every search box re-filters the charts after the tables', () => {
    const body = UTILS.slice(UTILS.indexOf('function wireAdSearchInput'));
    assert.ok(/onApply\(\);\s*refilterAdSearchCharts\(\);/.test(body.slice(0, 900)));
  });

  /* Each per-ad chart registers with followAdSearch and tags its marks. */
  const WIRING = [
    ['f10-weekly.js',   "followAdSearch('map', charts.map)"],
    ['f10-monthly.js',  "followAdSearch('scatter', scatterChart)"],
    ['f10-monthly.js',  "followAdSearch('powerlaw', powerLawChart,"],
    ['f10-tiktok.js',   "followAdSearch('tt-map', ttCharts.map)"],
    ['f10-tiktok.js',   "followAdSearch('tt-scatter', ttCharts.scatter)"],
    ['f10-tiktok.js',   "followAdSearch('tt-powerlaw', ttCharts.powerlaw,"],
    ['f10-linkedin.js', "followAdSearch('li-map', liCharts.map)"],
    ['f10-linkedin.js', "followAdSearch('li-scatter', liCharts.scatter)"],
    ['f10-linkedin.js', "followAdSearch('li-powerlaw', liCharts.powerlaw,"],
  ];
  check('Movement Map, Ad Production scatter and Power Law follow the search on Meta, TikTok and LinkedIn', () => {
    WIRING.forEach(([file, call]) => assert.ok(read(file).includes(call), `${file} is missing ${call}`));
    ['f10-weekly.js', 'f10-monthly.js', 'f10-tiktok.js', 'f10-linkedin.js'].forEach((f) => {
      const src = read(f);
      const tagged = (src.match(/_key: ?adSearchKey\(/g) || []).length;
      assert.ok(tagged >= (f === 'f10-weekly.js' ? 1 : f === 'f10-monthly.js' ? 1 : 2), `${f} tags chart marks with a search key`);
    });
  });

  console.log(`\n${passed} checks passed`);
})();
