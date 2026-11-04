'use strict';
/* Confidence lines US-007/US-008: the Reach cost chart on the Scale & Cut tab
 * (Cost per 1,000 reached against cost per conversion), read from the client's ad_window_reach mart. Fixtures
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
/* Ads that ran in each shorter window. Lifetime has a row for every ad in
 * CPMR; 105 'freshad' has no row in any window. */
const WINDOW_ADS = { last_28d: ['101', '102', '104', '108'], last_90d: ['101', '102', '103', '104', '106', '108'] };
function reachRowsFor(sql){
  const m = /`window` = '([a-z0-9_]+)'/.exec(sql);
  const win = m ? m[1] : null;
  return Object.keys(CPMR).filter((id) => !WINDOW_ADS[win] || WINDOW_ADS[win].includes(id))
    .map((id) => ({ ad_id: String(id), spend: 100, impressions: 50000, reach: 20000, cpmr: CPMR[id], as_of_date: AS_OF[win] }));
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
 * window and load the Scale & Cut tab. */
async function bootReach(opts){
  opts = opts || {};
  const ctx = boot({ config: opts.config || CONFIG, reachFails: opts.reachFails });
  ctx.sb.renderLayout();
  ctx.doc.getElementById('ctrl-enddate').value = '2026-10-31';
  ctx.doc.getElementById('ctrl-length').value = String(opts.days || 30);
  if (opts.group !== false) ctx.run("groupSelections['group_name'] = 'Hair';");
  ctx.sb.setSegmentSelection('Prospecting');
  if (opts.search) ctx.run(`adSearchTerm = ${JSON.stringify(opts.search)};`);
  await ctx.sb.loadScaleCut();
  await flush();
  return ctx;
}

const chartOn = (ctx, id) => { const c = ctx.charts.filter((x) => x.el && x.el.id === id); return c[c.length - 1]; };
const reachChart = (ctx) => chartOn(ctx, 'sc-reach-chart');
const linesChart = (ctx) => chartOn(ctx, 'sc-lines-chart');
const allPoints = (chart) => chart.data.datasets.reduce((a, d) => a.concat(d.data.map((p) => Object.assign({ _set: d.label }, p))), []);
const pointOf = (chart, name) => allPoints(chart).find((p) => p.label === name);
const reachQueries = (ctx) => ctx.queries.filter((q) => /ad_window_reach/.test(q));
const shown = (ctx, id) => ctx.doc.getElementById(id).style.display !== 'none';

let failures = 0;
async function test(name, fn){
  try { await fn(); console.log('ok - ' + name); }
  catch (e) { failures++; console.log('not ok - ' + name); console.log(e && e.stack ? e.stack : e); }
}

(async () => {
  await test('no REACH_TABLE: "Reach data is not loaded yet." and no reach query', async () => {
    const ctx = await bootReach({ config: BASE_CONFIG });
    assert.strictEqual(reachQueries(ctx).length, 0);
    assert.strictEqual(ctx.sb.confidenceLinesConfig().reachTable, null);
    assert.ok(shown(ctx, 'sc-reach-empty'));
    assert.strictEqual(ctx.doc.getElementById('sc-reach-empty').textContent || 'Reach data is not loaded yet.', 'Reach data is not loaded yet.');
    assert.ok(ctx.doc.getElementById('app').innerHTML.includes('id="sc-reach-empty">Reach data is not loaded yet.</div>'));
    assert.ok(!shown(ctx, 'sc-reach-wrapper'));
    assert.strictEqual(reachChart(ctx), undefined, 'no reach chart drawn');
    assert.ok(linesChart(ctx), 'the lines chart still draws');
    assert.deepStrictEqual(ctx.errors, []);
  });

  await test('a bad REACH_TABLE value is ignored', async () => {
    const ctx = boot({ config: Object.assign({}, BASE_CONFIG, { REACH_TABLE: 'x`; DROP TABLE y' }) });
    assert.strictEqual(ctx.sb.confidenceLinesConfig().reachTable, null);
    assert.strictEqual(ctx.sb.confidenceReachEnabled(), false);
  });

  await test('lifetime is the default reach window, whatever the dashboard window', async () => {
    for (const days of [7, 30, 90, 365]){
      const ctx = await bootReach({ days });
      const q = reachQueries(ctx);
      assert.strictEqual(q.length, 1, 'one reach query');
      const sql = q[0];
      assert.ok(sql.includes('FROM `mcc-poc-477801.mosh_marts.ad_window_reach`'), sql);
      assert.ok(sql.includes("`window` = 'lifetime'"), days + ' day window: ' + sql);
      assert.ok(/WHERE is_latest AND/.test(sql), sql);
      assert.ok(sql.includes('FROM `mcc-poc-477801.mosh_marts.creative_reporting`' + ctx.sb.scaleCutScopeWhere('WHERE')), 'scoped to the tab ads');
      assert.ok(!/all_clients_|staging/.test(sql), 'reads the mart only');
      assert.strictEqual(ctx.sb.confidenceReachWindow(), 'lifetime');
      const note = ctx.doc.getElementById('sc-reach-note').textContent;
      assert.ok(note.startsWith('Using lifetime reach (as of 2026-10-28). Cost per conversion is lifetime too.'), note);
      assert.ok(note.includes('Meta-reported') && note.includes('index'), note);
      assert.ok(!shown(ctx, 'sc-reach-empty'));
      assert.ok(shown(ctx, 'sc-reach-wrapper'));
      const names = allPoints(reachChart(ctx)).map((p) => p.label).sort();
      assert.deepStrictEqual(names, ['bothcutscale', 'cutpricey', 'cutthree', 'retarg', 'scalesubs', 'steady', 'twoxlead'],
        'every ad with spend and a lifetime row is plotted');
      assert.deepStrictEqual(ctx.errors, []);
    }
  });

  await test('round 2: the Reach window select is removed; reach is always lifetime', async () => {
    const ctx = await bootReach();
    const html = ctx.doc.getElementById('app').innerHTML;
    assert.ok(!html.includes('sc-reach-window') && !html.includes('Reach window'), 'no Reach window select');
    assert.strictEqual(ctx.sb.confidenceReachWindow(), 'lifetime');
    const q = reachQueries(ctx);
    assert.strictEqual(q.length, 1);
    assert.ok(q[0].includes("`window` = 'lifetime'") && !/last_28d|last_90d/.test(q[0]), q[0]);
    assert.deepStrictEqual(ctx.errors, []);
  });

  await test('chart first in the Reach cost card at the lines card height, notes under it', async () => {
    const ctx = await bootReach();
    const html = ctx.doc.getElementById('app').innerHTML;
    const card = html.slice(html.indexOf('<h3>Reach cost</h3>'));
    const at = (id) => card.indexOf('id="' + id + '"');
    assert.ok(at('sc-reach-wrapper') > 0);
    assert.ok(at('sc-reach-wrapper') < at('sc-reach-note'), 'note under the chart');
    assert.ok(at('sc-reach-note') < at('sc-reach-missing'), 'missing line under the note');
    const h = (id) => (new RegExp('id="' + id + '" style="[^"]*height:(\\d+)px').exec(html) || [])[1];
    assert.ok(h('sc-reach-wrapper'), 'fixed height');
    assert.strictEqual(h('sc-reach-wrapper'), h('sc-lines-wrapper'), 'same height as the Kill and scale lines chart');
  });

  await test('axes: x is cost per 1,000 reached from $0, y is the same cost per conversion as the lines chart', async () => {
    const ctx = await bootReach();
    const r = reachChart(ctx), l = linesChart(ctx);
    assert.strictEqual(r.options.scales.x.title.text, 'Cost per 1,000 reached');
    assert.strictEqual(r.options.scales.x.min, 0);
    assert.strictEqual(r.options.scales.y.title.text, 'Cost per kill conversion');
    assert.strictEqual(r.options.scales.y.title.text, l.options.scales.y.title.text);
    assert.strictEqual(r.options.scales.y.max, l.options.scales.y.max);
    assert.strictEqual(r.options.plugins.legend.display, false);
  });

  await test('Cut ad with cheap reach and high cost per conversion lands in Reach play with the marker', async () => {
    const ctx = await bootReach();
    const chart = reachChart(ctx);
    const p = pointOf(chart, 'cutthree');
    assert.strictEqual(p._verdict, 'Cut');
    assert.strictEqual(p.x, 4);
    assert.ok(Math.abs(p._cpa - 7.5 * KILL_T / 3) < 1e-9);
    assert.strictEqual(p._quadrant, 'Reach play');
    assert.strictEqual(p._newPeople, true);
    assert.strictEqual(p._set, 'Cut, may be bringing in new people');
    const marker = chart.data.datasets.find((d) => d.label === 'Cut, may be bringing in new people');
    assert.strictEqual(marker.pointStyle, 'triangle');
    assert.strictEqual(JSON.stringify(marker.data.map((x) => x.label)), '["cutthree"]');
    const lines = chart.options.plugins.tooltip.callbacks.label({ raw: p, dataset: marker });
    assert.ok(lines.some((l) => /may be bringing in new people/.test(l)), lines.join(' / '));
    assert.ok(lines.includes('Quadrant: Reach play'));
    const dear = pointOf(chart, 'cutpricey');
    assert.strictEqual(dear._verdict, 'Cut');
    assert.strictEqual(dear._quadrant, 'Cut candidate');
    assert.ok(!dear._newPeople);
    assert.strictEqual(dear._set, 'Cut candidate');
  });

  await test('quadrants split at the cell median CPMr and the median cost per conversion, not the target', async () => {
    const ctx = await bootReach();
    const st = ctx.run('confidenceQuadState');
    assert.strictEqual(st.median, 12.5, 'median of 4, 6, 10, 15, 20, 30; Retargeting ad excluded');
    const medCpa = 4000 / 6;
    assert.ok(Math.abs(st.medianCpa - medCpa) < 1e-9, 'median of 100, 511, 667, 1915, 1915 = ' + st.medianCpa);
    assert.notStrictEqual(st.medianCpa, KILL_T);
    assert.strictEqual(st.target, KILL_T, 'target kept for the faint reference line');
    const chart = reachChart(ctx);
    assert.strictEqual(pointOf(chart, 'twoxlead')._quadrant, 'Efficient growth');
    assert.strictEqual(pointOf(chart, 'steady')._quadrant, 'Efficient growth', 'a tie counts as the low side');
    assert.strictEqual(pointOf(chart, 'scalesubs')._quadrant, 'Precision');
    assert.strictEqual(pointOf(chart, 'bothcutscale')._quadrant, 'Cut candidate', 'no kill conversions reads as the high side');
    const plugin = chart.plugins.find((x) => x.id === 'confidence-quadrants');
    assert.ok(plugin, 'quadrant plugin');
    const calls = [];
    plugin.beforeDatasetsDraw(fakeChart(calls));
    assert.strictEqual(calls.filter((c) => c === 'fillRect').length, 4, 'four tinted quadrants');
    ['REACH PLAY', 'cheap reach, higher CPA', 'CUT CANDIDATE', 'pricey reach, higher CPA', 'EFFICIENT GROWTH', 'cheap reach, lower CPA',
      'PRECISION', 'pricey reach, lower CPA', 'cheaper reach'].forEach((l) => assert.ok(calls.includes('fillText:' + l), l));
    assert.ok(calls.includes('fillText:median ' + ctx.sb.fmt$(12.5)));
    assert.ok(calls.includes('fillText:median ' + ctx.sb.fmt$(medCpa)));
    assert.ok(calls.includes('fillText:target ' + ctx.sb.fmt$(KILL_T)), 'faint target line labelled');
  });

  await test('bubbles are translucent, outlined and sized by reach', async () => {
    const ctx = await bootReach();
    const chart = reachChart(ctx);
    const ds = chart.data.datasets.find((d) => d.label === 'Efficient growth');
    assert.ok(/55$/.test(ds.backgroundColor), ds.backgroundColor);
    assert.ok(ds.borderWidth > 0);
    assert.strictEqual(typeof ds.pointRadius, 'function');
  });

  await test('Judge on Subs: the reach chart uses the scale target for the reference line', async () => {
    const ctx = await bootReach();
    ctx.doc.getElementById('sc-judge-scale').dispatch('click');
    await flush();
    assert.strictEqual(ctx.run('confidenceQuadState').target, SCALE_T);
    assert.strictEqual(reachChart(ctx).options.scales.y.title.text, 'Cost per scale conversion');
    ctx.run("confidenceYMode = 'kill';");
  });

  await test('an ad with spend and no lifetime row shows as a one-line count, no names list', async () => {
    const ctx = await bootReach();
    assert.strictEqual(pointOf(reachChart(ctx), 'freshad'), undefined);
    const miss = () => ctx.doc.getElementById('sc-reach-missing').innerHTML;
    assert.ok(miss().includes('1 ad has no reach data yet.'), miss());
    assert.ok(!miss().includes('Show names') && !miss().includes('<button'), 'Show names toggle removed');
    assert.ok(!miss().includes('freshad'), 'names never listed');
    assert.strictEqual(ctx.run('typeof toggleConfidenceReachMissing'), 'undefined');
  });

  await test('the missing count is plural and names are never printed', async () => {
    const ctx = boot({ config: CONFIG });
    const view = { points: [], asOf: null, missing: [{ name: 'a<b', _key: 'a<b' }, { name: 'c', _key: 'c' }] };
    ctx.sb.renderLayout();
    ctx.sb.renderConfidenceReachNotes(view);
    const miss = () => ctx.doc.getElementById('sc-reach-missing').innerHTML;
    assert.ok(miss().includes('2 ads have no reach data yet.'), miss());
    assert.ok(!miss().includes('a<b') && !miss().includes('a&lt;b'), miss());
  });

  await test('the ad search filters the missing list but never moves the medians', async () => {
    const ctx = await bootReach({ search: 'cutthree' });
    assert.strictEqual(ctx.doc.getElementById('sc-reach-missing').innerHTML, '');
    assert.strictEqual(ctx.run('confidenceQuadState').median, 12.5);
    ctx.run("adSearchTerm = '';");
  });

  await test('Product set to All: medians over every ad with reach, no target line', async () => {
    const ctx = await bootReach({ group: false });
    const st = ctx.run('confidenceQuadState');
    assert.strictEqual(st.median, 15, 'median of 4, 6, 10, 15, 20, 30, 1000');
    assert.strictEqual(st.target, null);
  });

  await test('reach query with no rows shows the no-data message', async () => {
    const ctx = boot({ config: CONFIG });
    const orig = ctx.sb.runQuery;
    ctx.sb.runQuery = async (sql) => (/ad_window_reach/.test(sql) ? [] : orig(sql));
    ctx.sb.renderLayout();
    ctx.doc.getElementById('ctrl-enddate').value = '2026-10-31';
    ctx.run("groupSelections['group_name'] = 'Hair';");
    ctx.sb.setSegmentSelection('Prospecting');
    await ctx.sb.loadScaleCut();
    await flush();
    assert.ok(shown(ctx, 'sc-reach-empty'));
    assert.ok(!shown(ctx, 'sc-reach-wrapper'));
    assert.strictEqual(reachChart(ctx), undefined);
  });

  await test('reach query failure is logged and the chart is hidden', async () => {
    const ctx = await bootReach({ reachFails: true });
    assert.ok(ctx.errors.some((e) => /Reach data error/.test(String(e[0]))), 'error logged');
    assert.strictEqual(ctx.doc.getElementById('sc-reach-note').textContent, 'Could not load reach data.');
    assert.ok(!shown(ctx, 'sc-reach-wrapper'));
    assert.ok(linesChart(ctx), 'the lines chart still draws');
  });

  await test('no em or en dashes in the Scale & Cut code', async () => {
    const src = read('f10-monthly.js');
    const a = src.indexOf('/* \u2500\u2500 Scale & Cut tab');
    const b = src.indexOf('/* \u2500\u2500 Ad Power Law', a);
    assert.ok(a > 0 && b > a);
    assert.ok(!/[\u2013\u2014]/.test(src.slice(a, b)));
    const lay = read('f10-layout.js');
    const la = lay.indexOf('/* Scale & Cut tab');
    const lb = lay.indexOf('function prodThresholdLegendHTML', la);
    assert.ok(la > 0 && lb > la);
    assert.ok(!/[\u2013\u2014]/.test(lay.slice(la, lb)));
  });

  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})();

function fakeChart(calls){
  const rec = (n) => (...a) => { calls.push(n === 'fillText' ? 'fillText:' + a[0] : n); };
  return {
    ctx: { save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), rect: rec('rect'), clip: rec('clip'),
      moveTo: rec('moveTo'), lineTo: rec('lineTo'), stroke: rec('stroke'), fill: rec('fill'), closePath: rec('closePath'),
      fillRect: rec('fillRect'), setLineDash: rec('setLineDash'), fillText: rec('fillText'), roundRect: rec('roundRect'),
      measureText: (t) => ({ width: String(t).length * 5 }) },
    scales: { x: { getPixelForValue: (v) => v / 10 }, y: { getPixelForValue: (v) => 300 - v / 10 } },
    chartArea: { left: 0, top: 0, right: 300, bottom: 300 },
    height: 320,
  };
}
