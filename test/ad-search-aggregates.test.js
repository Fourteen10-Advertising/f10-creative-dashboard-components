/**
 * Ad search on views whose totals are summed across ads.
 *
 * v1.29 filtered per-ad tables and charts only. Ad Decay, the Ad Age mix, Ads
 * Launched by month, the Weekly Summary and the Creative Effectiveness curve kept
 * showing every ad. These checks cover the SQL clause that carries the search into
 * summed queries, the session query cache that keeps re-queries fast, the
 * debounced reload, and that every section is wired to them.
 *
 * Run: node test/ad-search-aggregates.test.js
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
  adSearchClauses, adSearchWhere, searchScopeWhere, adSearchFilter, adSearchKey,
  onAdSearch, runAdSearchHooks, onAdSearchReload, scheduleAdSearchReload,
  runQuery, clearQueryCache, groupSelections,
  setTerm: (v) => { adSearchTerm = v; },
  setStatus: (v) => { statusFilter = v; },
};`;

function load(fetchImpl){
  const timers = [];
  const sandbox = {
    window: {}, document: { documentElement: {} }, console,
    GROUP_FILTERS: [{ col: 'product', label: 'Product' }],
    BQ_FUNCTION: '/bq',
    fetch: fetchImpl || (async () => { throw new Error('no fetch'); }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS + EXPORT, sandbox, { filename: 'f10-utils.js' });
  sandbox.__S.timers = timers;
  return sandbox.__S;
}

let passed = 0;
async function check(name, fn){ await fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('Ad search on summed views');
  const S = load();

  await check('no search: no SQL clause, so default queries are unchanged', () => {
    S.setTerm('');
    assert.deepStrictEqual(Array.from(S.adSearchClauses('adset_name')), []);
    assert.strictEqual(S.adSearchWhere('WHERE', 'adgroup_name'), '');
  });

  await check('one STRPOS per search word, over the same key the tables use', () => {
    S.setTerm('0926_static apple');
    const parts = S.adSearchClauses('adgroup_name');
    assert.strictEqual(parts.length, 2);
    assert.ok(parts[0].includes("'0926static'") && parts[1].includes("'apple'"));
    ['ad_name', 'campaign_name', 'adgroup_name'].forEach((c) => assert.ok(parts[0].includes(c), c));
    assert.ok(parts[0].includes("r'[^\\p{L}\\p{N}]'"), 'strips everything but letters and digits');
    assert.ok(parts[0].includes("'|'"), 'names joined with | so a word never spans two names');
    assert.ok(/^ WHERE STRPOS\(.* AND STRPOS\(/.test(S.adSearchWhere('WHERE', 'adgroup_name')));
    assert.ok(/^ AND STRPOS\(/.test(S.adSearchWhere('', 'adgroup_name')));
  });

  await check('a quote or backslash in the search cannot reach the SQL', () => {
    S.setTerm("o'brien \\ x");
    S.adSearchClauses('adset_name').forEach((p) => {
      const lit = p.match(/STRPOS\(.*, ('[^']*')\) > 0$/);
      assert.ok(lit && /^'[\p{L}\p{N}]+'$/u.test(lit[1]), p);
    });
  });

  await check('searchScopeWhere composes group filter, ad status and search', () => {
    S.setTerm('');
    S.groupSelections.product = 'Trade';
    S.setStatus('active');
    assert.strictEqual(S.searchScopeWhere('WHERE'), " WHERE product = 'Trade' AND is_active");
    S.setTerm('apple');
    const w = S.searchScopeWhere('WHERE');
    assert.ok(w.startsWith(" WHERE product = 'Trade' AND is_active AND STRPOS("), w);
    S.groupSelections.product = '__all__'; S.setStatus('all'); S.setTerm('');
    assert.strictEqual(S.searchScopeWhere('WHERE'), '');
  });

  await check('adSearchFilter keeps matching items only while a search is active', () => {
    const ads = [{ ad_name: '0926_static_apple_x', campaign_name: 'Trade' }, { ad_name: 'Super_video', campaign_name: 'SMSF' }];
    const key = (a) => S.adSearchKey(a.ad_name, a.campaign_name);
    S.setTerm(''); assert.strictEqual(S.adSearchFilter(ads, key).length, 2);
    S.setTerm('0926_static_apple'); assert.strictEqual(S.adSearchFilter(ads, key).length, 1);
    S.setTerm('smsf'); assert.strictEqual(S.adSearchFilter(ads, key)[0].ad_name, 'Super_video');
    S.setTerm('');
  });

  await check('hooks run on search change; a failing hook does not stop the others', () => {
    let a = 0, b = 0;
    const errors = console.error; console.error = () => {};
    S.onAdSearch('t-bad', () => { throw new Error('boom'); });
    S.onAdSearch('t-a', () => { a++; });
    S.onAdSearch('t-a', () => { b++; });   /* same slot replaces */
    S.runAdSearchHooks();
    console.error = errors;
    assert.strictEqual(a, 0); assert.strictEqual(b, 1);
  });

  await check('reloads wait for a typing pause and run once', () => {
    let n = 0;
    S.onAdSearchReload('t-r', () => { n++; });
    S.scheduleAdSearchReload(); S.scheduleAdSearchReload(); S.scheduleAdSearchReload();
    const live = S.timers.filter((t) => t.fn);
    assert.strictEqual(live.length, 1);
    assert.ok(live[0].ms >= 300, 'debounce is long enough to skip mid-word queries');
    live[0].fn();
    assert.strictEqual(n, 1);
  });

  await check('query cache: same SQL fetched once, errors not kept, Refresh clears', async () => {
    let calls = 0, fail = false;
    const Q = load(async () => { calls++; if (fail) return { ok: false, text: async () => 'bad' }; return { ok: true, json: async () => [{ n: calls }] }; });
    const a = await Q.runQuery('SELECT 1');
    const b = await Q.runQuery('SELECT 1');
    assert.strictEqual(calls, 1); assert.strictEqual(a, b);
    await Q.runQuery('SELECT 2'); assert.strictEqual(calls, 2);
    Q.clearQueryCache(); await Q.runQuery('SELECT 1'); assert.strictEqual(calls, 3);
    fail = true;
    await assert.rejects(Q.runQuery('SELECT 3'));
    fail = false;
    await Q.runQuery('SELECT 3'); assert.strictEqual(calls, 5, 'a failed query is retried, not served from cache');
  });

  /* Wiring: summed queries carry the search; per-ad queries do not. */
  const block = (src, start, end) => { const i = src.indexOf(start); assert.ok(i !== -1, start); return src.slice(i, src.indexOf(end, i)); };
  await check('Meta: Decay, Age mix and Ads Launched by month query with the search', () => {
    const M = read('f10-monthly.js');
    assert.strictEqual((block(M, 'async function loadDecay', '/* ── Ad Age') .match(/searchScopeWhere\(/g) || []).length, 2);
    const age = block(M, 'async function loadAge', 'const tableSQL');
    assert.ok(age.includes('searchScopeWhere('));
    assert.ok(!block(M, 'const tableSQL', 'try {').includes('searchScopeWhere('), 'Age table stays client-filtered');
    const prod = block(M, 'async function loadProduction', '  try {');
    assert.strictEqual((prod.match(/searchScopeWhere\(/g) || []).length, 1, 'only the monthly rollup, not the per-ad scatter');
    assert.ok(M.includes("onAdSearchReload('meta'"));
    assert.ok(M.includes("onAdSearch('creative-curve', drawCurve)"));
    assert.ok(/const totals=adSearchFilter\(scatterData/.test(M), 'scorecards count matching ads');
  });

  await check('Meta: Weekly Summary sums only the matching ads', () => {
    const W = read('f10-weekly.js');
    assert.strictEqual((W.match(/renderSummary\(adSearchFilter\(classified/g) || []).length, 2);
    assert.ok(W.includes('clearQueryCache();'), 'Refresh clears the query cache');
  });

  for (const [f, x] of [['f10-tiktok.js', 'tt'], ['f10-linkedin.js', 'li']]) {
    await check(`${x === 'tt' ? 'TikTok' : 'LinkedIn'}: summed views follow the search`, () => {
      const src = read(f);
      const W = "adSearchWhere('WHERE', 'adgroup_name')";
      assert.strictEqual((block(src, `function ${x}DecaySQL()`, 'return {').split(W).length - 1), 2);
      assert.ok(block(src, `function ${x}AgeSQL()`, 'const tableSQL').includes(W));
      assert.ok(!block(src, `function ${x}AgeSQL()`, 'return {').split('const tableSQL')[1].includes(W));
      const prod = block(src, `function ${x}ProductionSQL()`, 'return {');
      assert.ok(prod.split('const monthlySQL')[1].includes(W) && !prod.split('const monthlySQL')[0].includes(W));
      assert.ok(src.includes(`onAdSearchReload('${x}'`));
      assert.ok(src.includes(`onAdSearch('${x}-weekly'`));
      assert.ok(src.includes(`onAdSearch('${x}-creative-curve', drawCurve)`));
      assert.ok(src.includes(`${x}RenderSummary(adSearchFilter(classified`));
      assert.ok(src.includes('const totals = adSearchFilter(scatterData'));
    });
  }

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
