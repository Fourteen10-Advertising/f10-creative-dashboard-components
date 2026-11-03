'use strict';
/* Confidence lines US-007: the Cost per 1,000 reached (CPMr) x axis on the Ad
 * Production scatter, read from the client's ad_window_reach mart. Fixtures
 * only: the mart has not run live yet. The verdict comes from the scatter SQL,
 * evaluated by test/helpers/confidence-sql.js as in the US-003 tests. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { withSqlVerdicts } = require('./helpers/confidence-sql');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SEGMENT_EXPR = `CASE
  WHEN campaign_name LIKE '%_Prospecting%' THEN 'Prospecting'
  WHEN campaign_name LIKE '%_Retargeting%' THEN 'Retargeting'
  ELSE 'Unmatched' END`;
const BASE_CONFIG = {
  KILL_CONV_EXPR: 'plan_assigned',
  SCALE_CONV_EXPR: 'subscriptions',
  SEGMENT_EXPR,
  BASELINE_DAYS: 90,
  CONFIDENCE: 0.9,
};
const CONFIG = Object.assign({}, BASE_CONFIG, { REACH_TABLE: 'ad_window_reach' });
const GROUPS = [{ col: 'group_name', label: 'Product' }];
const KILL_T = 766;
const SCALE_T = 1500;

function makeDom(){
  const els = {};
  function makeEl(id){
    const el = {
      id: id || '', value: '', checked: false, disabled: false, textContent: '', style: {}, dataset: {}, children: [], _listeners: {}, _html: '',
      classList: { _s: new Set(), add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); }, contains(c){ return this._s.has(c); },
        toggle(c, on){ if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); return on; } },
      get innerHTML(){ return this._html; },
      set innerHTML(v){
        this._html = String(v);
        const re = /\bid="([^"]+)"/g; let m;
        while ((m = re.exec(this._html))) delete els[m[1]];
        const sel = /<option value="([^"]*)"[^>]*selected/.exec(this._html) || /<option value="([^"]*)"/.exec(this._html);
        if (sel) this.value = sel[1];
        const re2 = /<input[^>]*\bid="([^"]+)"[^>]*\bvalue="([^"]*)"/g;
        while ((m = re2.exec(this._html))) { const e = doc.getElementById(m[1]); e.value = m[2]; }
      },
      addEventListener(t, fn){ (this._listeners[t] || (this._listeners[t] = [])).push(fn); },
      removeEventListener(){},
      dispatch(t){ (this._listeners[t] || []).forEach((fn) => fn({ target: el, preventDefault(){} })); },
      click(){ this.dispatch('click'); },
      appendChild(c){ this.children.push(c); return c; },
      insertAdjacentHTML(){}, setAttribute(k, v){ this[k] = v; }, getAttribute(k){ return this[k]; },
      querySelector(){ return null; }, querySelectorAll(){ return []; }, closest(){ return null; },
      getContext(){ return {}; }, remove(){}, focus(){}, scrollIntoView(){},
      getBoundingClientRect(){ return { top: 0, left: 0, width: 0, height: 0 }; },
    };
    return el;
  }
  const doc = {
    els,
    getElementById(id){ return els[id] || (els[id] = makeEl(id)); },
    createElement(){ return makeEl(); },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    addEventListener(){}, documentElement: { style: {} },
  };
  doc.body = makeEl('body'); doc.head = makeEl('head');
  return doc;
}

/* Ads in the Hair x Prospecting cell, plus one Retargeting ad that must not
 * move the Prospecting median. */
const AD = (id, name, spend, kill, scale, seg) => ({
  ad_id: id, ad_name: name, campaign_name: 'Mosh_Hair_' + (seg || 'Prospecting'), adset_name: 'set', lifetime_spend: spend,
  conf_group: 'Hair', conf_segment: seg || 'Prospecting', kill_conv: kill, scale_conv: scale,
  classification: 'On Base', creative_score: 50, lifetime_metric: spend / Math.max(1, kill),
});
const ADS = [
  AD(101, 'cutthree', 7.5 * KILL_T, 3, 0),     // Cut, cost per kill 1915, cheap reach
  AD(102, 'twoxlead', 2 * KILL_T, 3, 0),       // Testing, cost per kill 511
  AD(103, 'bothcutscale', 6000, 0, 10),        // Scale on subs, no kill conversions
  AD(104, 'scalesubs', 2000, 20, 8),           // Scale, cost per kill 100
  AD(105, 'freshad', 300, 0, 0),               // no reach row yet
  AD(106, 'steady', 4000, 6, 2),               // cost per kill 667
  AD(107, 'cutpricey', 7.5 * KILL_T, 3, 0),    // Cut, dear reach
  AD(108, 'retarg', 900, 9, 9, 'Retargeting'), // other cell
];
/* CPMr by ad id. Prospecting values 4, 6, 10, 15, 20, 30: median 12.5. */
const CPMR = { 101: 4, 102: 6, 103: 20, 104: 15, 106: 10, 107: 30, 108: 1000 };
const AS_OF = { last_28d: '2026-10-30', last_90d: '2026-10-29', lifetime: '2026-10-28' };
function reachRowsFor(sql){
  const m = /`window` = '([a-z0-9_]+)'/.exec(sql);
  const win = m ? m[1] : null;
  return Object.keys(CPMR).map((id) => ({ ad_id: String(id), spend: 100, impressions: 50000, reach: 20000, cpmr: CPMR[id], as_of_date: AS_OF[win] }));
}

function boot(opts){
  opts = opts || {};
  const doc = makeDom();
  const queries = [];
  const charts = [];
  const errors = [];
  const F10A = { init(){}, track(){}, page(){}, identify(){} };
  const quiet = { log(){}, warn(){}, error: (...a) => { errors.push(a); }, info(){} };
  const sb = {
    window: { F10A, f10MediaMarkup: () => '', addEventListener(){}, location: { search: '', hash: '' } },
    document: doc, console: quiet, F10A,
    PROJECT: 'mcc-poc-477801', DATASET: 'mosh_marts', TABLE: 'creative_reporting', CONV_EXPR: 'purchase',
    CLIENT_NAME: 'Mosh', BQ_FUNCTION: '/bq', GROUP_FILTERS: GROUPS,
    fetch: async () => { throw new Error('no fetch'); }, setTimeout: () => 0, clearTimeout(){},
    Chart: function(el, cfg){
      const c = { el, cfg, data: cfg.data, options: cfg.options, plugins: cfg.plugins, destroy(){}, update(){} };
      charts.push(c);
      return c;
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem(){ return null; }, setItem(){} }, sessionStorage: { getItem(){ return null; }, setItem(){} },
    requestAnimationFrame: () => 0, navigator: { userAgent: 'node' },
  };
  if (opts.config) sb.CONFIDENCE_LINES = opts.config;
  vm.createContext(sb);
  ['f10-utils.js', 'f10-weekly.js', 'f10-layout.js', 'f10-monthly.js']
    .forEach((f) => vm.runInContext(read(f), sb, { filename: f }));
  const baseline = [
    { grp: 'Hair', segment: 'Prospecting', spend: KILL_T * 100, kill_conv: 100, scale_conv: 60, cost_per_kill: KILL_T, cost_per_scale: SCALE_T },
    { grp: 'Hair', segment: 'Retargeting', spend: 9000, kill_conv: 80, scale_conv: 70, cost_per_kill: 112.5, cost_per_scale: 128.57 },
  ];
  sb.runQuery = async (sql) => {
    queries.push(sql);
    if (/ad_window_reach/.test(sql)){
      if (opts.reachFails) throw new Error('reach table not found');
      return reachRowsFor(sql);
    }
    if (/cost_per_kill/.test(sql)) return baseline;
    if (/SELECT DISTINCT/.test(sql) && /AS segment/.test(sql)) return [{ segment: 'Prospecting' }, { segment: 'Retargeting' }];
    if (/FROM per_ad/.test(sql) || /per_ad_conf/.test(sql)) return withSqlVerdicts(sql, ADS);
    return [];
  };
  const run = (code) => vm.runInContext(code, sb);
  return { sb, doc, queries, charts, errors, run };
}

async function flush(){ for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

/* Boot with confidence lines, pick Hair x Prospecting, set the dashboard
 * window, then switch the x axis to Cost per 1,000 reached. */
async function bootReach(opts){
  opts = opts || {};
  const ctx = boot({ config: opts.config || CONFIG, reachFails: opts.reachFails });
  ctx.sb.renderLayout();
  ctx.doc.getElementById('ctrl-enddate').value = '2026-10-31';
  ctx.doc.getElementById('ctrl-length').value = String(opts.days || 30);
  if (opts.group !== false) ctx.run("groupSelections['group_name'] = 'Hair';");
  ctx.sb.setSegmentSelection('Prospecting');
  if (opts.search) ctx.run(`adSearchTerm = ${JSON.stringify(opts.search)};`);
  await ctx.sb.loadProduction();
  await flush();
  if (opts.cpmr !== false){
    const sel = ctx.doc.getElementById('cl-x-mode');
    sel.value = 'cpmr';
    sel.dispatch('change');
    await flush();
  }
  return ctx;
}

const scatterChart = (ctx) => { const c = ctx.charts.filter((x) => x.el && x.el.id === 'scatter-chart'); return c[c.length - 1]; };
const allPoints = (chart) => chart.data.datasets.reduce((a, d) => a.concat(d.data.map((p) => Object.assign({ _set: d.label }, p))), []);
const pointOf = (chart, name) => allPoints(chart).find((p) => p.label === name);
const reachQueries = (ctx) => ctx.queries.filter((q) => /ad_window_reach/.test(q));

let failures = 0;
async function test(name, fn){
  try { await fn(); console.log('ok - ' + name); }
  catch (e) { failures++; console.log('not ok - ' + name); console.log(e && e.stack ? e.stack : e); }
}

(async () => {
  await test('no REACH_TABLE: no x axis option and no reach query, even in cpmr mode', async () => {
    const ctx = boot({ config: BASE_CONFIG });
    ctx.sb.renderLayout();
    ctx.doc.getElementById('ctrl-length').value = '30';
    ctx.run("groupSelections['group_name'] = 'Hair';");
    ctx.sb.setSegmentSelection('Prospecting');
    ctx.run("confidenceXMode = 'cpmr';");
    await ctx.sb.loadProduction();
    await flush();
    const html = ctx.doc.getElementById('app').innerHTML;
    ['cl-x-mode', 'Cost per 1,000 reached', 'prod-reach-note', 'prod-reach-missing'].forEach((s) => assert.ok(!html.includes(s), s));
    assert.strictEqual(reachQueries(ctx).length, 0);
    assert.strictEqual(ctx.sb.confidenceReachActive(), false);
    assert.strictEqual(ctx.sb.confidenceLinesConfig().reachTable, null);
    const chart = scatterChart(ctx);
    assert.notStrictEqual(chart.options.scales.x.title.text, 'Cost per 1,000 reached ($)');
    assert.ok(!chart.plugins.some((p) => p.id === 'confidence-quadrants'));
  });

  await test('REACH_TABLE set but lifetime spend picked: the option shows and no reach query runs', async () => {
    const ctx = await bootReach({ cpmr: false });
    const html = ctx.doc.getElementById('app').innerHTML;
    assert.ok(html.includes('<option value="cpmr">Cost per 1,000 reached</option>'), html.slice(html.indexOf('cl-x-mode') - 40, html.indexOf('cl-x-mode') + 300));
    assert.ok(html.includes('<option value="spend" selected>Lifetime spend</option>'), 'lifetime spend is the default');
    assert.strictEqual(reachQueries(ctx).length, 0);
    assert.strictEqual(ctx.doc.getElementById('prod-reach-note').textContent, '');
  });

  await test('a bad REACH_TABLE value is ignored', async () => {
    const ctx = boot({ config: Object.assign({}, BASE_CONFIG, { REACH_TABLE: 'x`; DROP TABLE y' }) });
    assert.strictEqual(ctx.sb.confidenceLinesConfig().reachTable, null);
    assert.strictEqual(ctx.sb.confidenceReachEnabled(), false);
  });

  await test('reach window follows the dashboard window', async () => {
    const w = (d) => vmCall(d);
    const ctx = boot({ config: CONFIG });
    function vmCall(d){ return ctx.sb.confidenceReachWindow(d); }
    assert.strictEqual(w(7), 'last_28d');
    assert.strictEqual(w(28), 'last_28d');
    assert.strictEqual(w(30), 'last_28d');
    assert.strictEqual(w(59), 'last_28d');
    assert.strictEqual(w(60), 'last_90d');
    assert.strictEqual(w(90), 'last_90d');
    assert.strictEqual(w(180), 'last_90d');
    assert.strictEqual(w(181), 'lifetime');
    assert.strictEqual(w(null), 'lifetime');
  });

  await test('30 day window: queries the 28 day reach window and the label says so', async () => {
    const ctx = await bootReach({ days: 30 });
    const q = reachQueries(ctx);
    assert.strictEqual(q.length, 1, 'one reach query');
    const sql = q[0];
    assert.ok(sql.includes('FROM `mcc-poc-477801.mosh_marts.ad_window_reach`'), sql);
    assert.ok(sql.includes("`window` = 'last_28d'"), sql);
    assert.ok(/WHERE is_latest AND/.test(sql), sql);
    assert.ok(sql.includes('FROM `mcc-poc-477801.mosh_marts.creative_reporting`' + ctx.sb.scopeWhere('WHERE')), 'scoped to the page ads');
    assert.ok(!/all_clients_|staging/.test(sql), 'reads the mart only');
    const note = ctx.doc.getElementById('prod-reach-note').textContent;
    assert.ok(note.startsWith('Using the 28 day reach window (as of 2026-10-30).'), note);
    assert.ok(note.includes('Meta-reported') && note.includes('index'), note);
    assert.deepStrictEqual(ctx.errors, []);
  });

  await test('90 day dashboard window reads the 90 day reach window', async () => {
    const ctx = await bootReach({ days: 90 });
    assert.ok(reachQueries(ctx)[0].includes("`window` = 'last_90d'"));
    assert.ok(ctx.doc.getElementById('prod-reach-note').textContent.startsWith('Using the 90 day reach window (as of 2026-10-29).'));
  });

  await test('Cut ad with low CPMr and high cost per conversion lands in Reach play with the marker', async () => {
    const ctx = await bootReach();
    const chart = scatterChart(ctx);
    assert.strictEqual(chart.options.scales.x.title.text, 'Cost per 1,000 reached ($)');
    assert.strictEqual(chart.options.scales.y.title.text, 'Cost per kill conversion');
    const p = pointOf(chart, 'cutthree');
    assert.strictEqual(p._verdict, 'Cut');
    assert.strictEqual(p.x, 4);
    assert.ok(Math.abs(p.y - 7.5 * KILL_T / 3) < 1e-9);
    assert.strictEqual(p._quadrant, 'Reach play');
    assert.strictEqual(p._newPeople, true);
    assert.strictEqual(p._set, 'Cut, may be bringing in new people');
    const marker = chart.data.datasets.find((d) => d.label === 'Cut, may be bringing in new people');
    assert.strictEqual(marker.pointStyle, 'triangle');
    assert.strictEqual(JSON.stringify(marker.data.map((x) => x.label)), '["cutthree"]');
    const lines = chart.options.plugins.tooltip.callbacks.label({ raw: p, dataset: marker });
    assert.ok(lines.some((l) => /may be bringing in new people/.test(l)), lines.join(' / '));
    assert.ok(lines.includes('Quadrant: Reach play'));
    /* A Cut ad with dear reach is a Cut candidate and gets no marker. */
    const dear = pointOf(chart, 'cutpricey');
    assert.strictEqual(dear._verdict, 'Cut');
    assert.strictEqual(dear._quadrant, 'Cut candidate');
    assert.ok(!dear._newPeople);
    assert.strictEqual(dear._set, 'Cut');
  });

  await test('quadrant lines sit at the cell median CPMr and the target, with all four labels', async () => {
    const ctx = await bootReach();
    const st = ctx.run('confidenceQuadState');
    assert.strictEqual(st.median, 12.5, 'median of 4, 6, 10, 15, 20, 30; Retargeting ad excluded');
    assert.strictEqual(st.target, KILL_T);
    const chart = scatterChart(ctx);
    assert.strictEqual(pointOf(chart, 'twoxlead')._quadrant, 'Efficient growth');
    assert.strictEqual(pointOf(chart, 'steady')._quadrant, 'Efficient growth');
    assert.strictEqual(pointOf(chart, 'scalesubs')._quadrant, 'Precision');
    assert.strictEqual(pointOf(chart, 'bothcutscale')._quadrant, 'Cut candidate', 'no kill conversions reads as the high side');
    const plugin = chart.plugins.find((x) => x.id === 'confidence-quadrants');
    assert.ok(plugin, 'quadrant plugin');
    assert.ok(!chart.plugins.some((x) => x.id === 'confidence-lines'), 'no spend curve on the CPMr view');
    const calls = [];
    plugin.afterDraw(fakeChart(calls));
    assert.ok(calls.filter((c) => c === 'stroke').length === 2, 'two lines');
    ['Efficient growth', 'Reach play', 'Precision', 'Cut candidate'].forEach((l) => assert.ok(calls.includes('fillText:' + l), l));
    assert.ok(calls.includes('fillText:Median CPMr ' + ctx.sb.fmt$(12.5)));
  });

  await test('scale y axis uses the scale target for the horizontal line', async () => {
    const ctx = await bootReach();
    const y = ctx.doc.getElementById('cl-y-mode');
    y.value = 'scale';
    y.dispatch('change');
    await flush();
    assert.strictEqual(ctx.run('confidenceQuadState').target, SCALE_T);
    assert.strictEqual(scatterChart(ctx).options.scales.y.title.text, 'Cost per scale conversion');
    ctx.run("confidenceYMode = 'kill';");
  });

  await test('an ad with no reach row is listed under No reach data yet and not plotted', async () => {
    const ctx = await bootReach();
    const chart = scatterChart(ctx);
    assert.strictEqual(pointOf(chart, 'freshad'), undefined);
    const miss = ctx.doc.getElementById('prod-reach-missing').innerHTML;
    assert.strictEqual(miss, 'No reach data yet (1): freshad');
  });

  await test('the ad search filters the missing list and points but never moves the median', async () => {
    const ctx = await bootReach({ search: 'cutthree' });
    assert.strictEqual(ctx.doc.getElementById('prod-reach-missing').innerHTML, '');
    assert.strictEqual(ctx.run('confidenceQuadState').median, 12.5);
    ctx.run("adSearchTerm = '';");
  });

  await test('Product / Group set to All: CPMr points but no quadrants or markers', async () => {
    const ctx = await bootReach({ group: false });
    const chart = scatterChart(ctx);
    assert.strictEqual(chart.options.scales.x.title.text, 'Cost per 1,000 reached ($)');
    assert.strictEqual(ctx.run('confidenceQuadState'), null);
    assert.ok(!chart.data.datasets.some((d) => d.label === 'Cut, may be bringing in new people'));
    assert.strictEqual(pointOf(chart, 'cutthree')._set, 'Cut');
    const calls = [];
    chart.plugins.find((x) => x.id === 'confidence-quadrants').afterDraw(fakeChart(calls));
    assert.ok(!calls.includes('stroke'), 'nothing drawn');
  });

  await test('reach query failure is logged and the chart falls back to lifetime spend', async () => {
    const ctx = await bootReach({ reachFails: true });
    assert.ok(ctx.errors.some((e) => /Reach query error/.test(String(e[0]))), 'error logged');
    assert.strictEqual(ctx.doc.getElementById('prod-reach-note').textContent, 'Could not load reach data, so the chart shows lifetime spend.');
    assert.notStrictEqual(scatterChart(ctx).options.scales.x.title.text, 'Cost per 1,000 reached ($)');
  });

  await test('switching back to lifetime spend restores the spend chart and clears the notes', async () => {
    const ctx = await bootReach();
    const sel = ctx.doc.getElementById('cl-x-mode');
    sel.value = 'spend';
    sel.dispatch('change');
    await flush();
    const chart = scatterChart(ctx);
    assert.ok(chart.plugins.some((p) => p.id === 'confidence-lines'));
    assert.strictEqual(ctx.doc.getElementById('prod-reach-note').textContent, '');
    assert.strictEqual(ctx.doc.getElementById('prod-reach-missing').innerHTML, '');
    assert.strictEqual(reachQueries(ctx).length, 1, 'no second reach query');
  });

  await test('no em or en dashes in the US-007 code', async () => {
    const src = read('f10-monthly.js');
    const a = src.indexOf('Cost per 1,000 reached view (confidence-lines US-007)');
    const b = src.indexOf('function _confTargetField', a);
    assert.ok(a > 0 && b > a);
    assert.ok(!/[–—]/.test(src.slice(a, b)));
    const lay = read('f10-layout.js');
    const la = lay.indexOf('US-007: the Cost per 1,000 reached x axis');
    assert.ok(la > 0);
    assert.ok(!/[–—]/.test(lay.slice(la, lay.indexOf('function', la))));
  });

  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})();

function fakeChart(calls){
  const rec = (n) => (...a) => { calls.push(n === 'fillText' ? 'fillText:' + a[0] : n); };
  return {
    ctx: { save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), rect: rec('rect'), clip: rec('clip'),
      moveTo: rec('moveTo'), lineTo: rec('lineTo'), stroke: rec('stroke'), fillText: rec('fillText') },
    scales: { x: { getPixelForValue: (v) => v }, y: { getPixelForValue: (v) => v } },
    chartArea: { left: 0, top: 0, right: 100, bottom: 100 },
  };
}
