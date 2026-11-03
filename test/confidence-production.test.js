'use strict';
/* Confidence lines US-003: the Verdict column and the lines on the Ad
 * Production scatter. The verdict is computed in SQL; the fake BigQuery here
 * evaluates that SQL (test/helpers/confidence-sql.js), so these tests check the
 * emitted query and what the page does with its answer. */
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
const CONFIG = {
  KILL_CONV_EXPR: 'plan_assigned',
  SCALE_CONV_EXPR: 'subscriptions',
  SEGMENT_EXPR,
  BASELINE_DAYS: 90,
  CONFIDENCE: 0.9,
};
const GROUPS = [{ col: 'group_name', label: 'Product' }];
const KILL_T = 766;
const SCALE_T = 1500;

function makeDom(){
  const els = {};
  function makeEl(id){
    const el = {
      id: id || '', value: '', checked: false, textContent: '', style: {}, dataset: {}, children: [], _listeners: {}, _html: '',
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

/* Ads in the Hair x Prospecting cell. */
const AD = (name, spend, kill, scale) => ({
  ad_name: name, campaign_name: 'Mosh_Hair_Prospecting', adset_name: 'set', lifetime_spend: spend,
  conf_group: 'Hair', conf_segment: 'Prospecting', kill_conv: kill, scale_conv: scale,
  classification: 'On Base', creative_score: 50, lifetime_metric: spend / Math.max(1, kill),
});
const ADS = [
  AD('cutthree', 7.5 * KILL_T, 3, 0),        // 3 plan assigned, spend 7.5x the lead target
  AD('twoxlead', 2 * KILL_T, 3, 0),          // the brief's literal case: 2x the lead target
  AD('bothcutscale', 6000, 0, 10),           // Cut on plan assigned, Scale on subs
  AD('scalesubs', 2000, 20, 8),
  AD('freshad', 300, 0, 0),
  AD('steady', 4000, 6, 2),
];

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
    PROJECT: 'mcc-poc-477801', DATASET: 'acme_marts', TABLE: 'creative_reporting', CONV_EXPR: 'purchase',
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
    if (/cost_per_kill/.test(sql)) return baseline;
    if (/SELECT DISTINCT/.test(sql) && /AS segment/.test(sql)) return [{ segment: 'Prospecting' }, { segment: 'Retargeting' }];
    if (/FROM per_ad/.test(sql) || /per_ad_conf/.test(sql)) return withSqlVerdicts(sql, ADS);
    return [];
  };
  const run = (code) => vm.runInContext(code, sb);
  return { sb, doc, queries, charts, errors, run };
}

async function flush(){ for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

async function bootEnabled(opts){
  opts = opts || {};
  const ctx = boot({ config: CONFIG });
  ctx.sb.renderLayout();
  ctx.doc.getElementById('ctrl-enddate').value = '2026-10-31';
  if (opts.group !== false) ctx.run("groupSelections['group_name'] = 'Hair';");
  ctx.sb.setSegmentSelection(opts.segment || 'Prospecting');
  if (opts.search) ctx.run(`adSearchTerm = ${JSON.stringify(opts.search)};`);
  await ctx.sb.loadProduction();
  await flush();
  return ctx;
}

const scatterChart = (ctx) => { const c = ctx.charts.filter((x) => x.el && x.el.id === 'scatter-chart'); return c[c.length - 1]; };
const tableBody = (ctx) => ctx.doc.getElementById('scatter-table-body').innerHTML;
/* Verdict cell for one ad: the last <td> of its row. */
function verdictOf(ctx, name){
  const rows = tableBody(ctx).split('</tr>');
  const row = rows.find((r) => r.includes(`data-adname="${name}|`));
  assert.ok(row, 'row for ' + name);
  const m = /<td><span class="badge badge-(scale|testing|cut)">(Scale|Testing|Cut)<\/span><\/td>$/.exec(row);
  return m ? m[2] : null;
}
const scatterPoints = (ctx) => scatterChart(ctx).data.datasets.reduce((a, d) => a.concat(d.data), []);

let failures = 0;
async function test(name, fn){
  try { await fn(); console.log('ok - ' + name); }
  catch (e) { failures++; console.log('not ok - ' + name); console.log(e && e.stack ? e.stack : e); }
}

(async () => {
  await test('3 plan assigned at 7.5x the lead target and 0 subs: Cut; at 2x it is still Testing', async () => {
    const ctx = await bootEnabled();
    assert.strictEqual(verdictOf(ctx, 'cutthree'), 'Cut');
    /* The brief's literal 2x case: 3 conversions need spend above 6.68x the
     * target before the 90% test says Cut, so 2x reads Testing. */
    assert.strictEqual(verdictOf(ctx, 'twoxlead'), 'Testing');
    assert.strictEqual(verdictOf(ctx, 'freshad'), 'Testing');
    assert.deepStrictEqual(ctx.errors, []);
  });

  await test('Cut on plan assigned and Scale on subs: Scale wins', async () => {
    const ctx = await bootEnabled();
    const sb = ctx.sb;
    assert.strictEqual(sb.confidenceVerdict(6000, 0, KILL_T, { conf: 0.9 }), 'Cut', 'Cut on plan assigned alone');
    assert.strictEqual(sb.confidenceVerdict(6000, 0, KILL_T, { conf: 0.9, scaleConv: 10, scaleTarget: SCALE_T }), 'Scale', 'Scale tested first');
    assert.strictEqual(verdictOf(ctx, 'bothcutscale'), 'Scale');
  });

  await test('the verdict is one SQL column, read by the table and the counts', async () => {
    const ctx = await bootEnabled();
    const sql = ctx.queries.find((q) => /per_ad_conf/.test(q));
    assert.ok(sql, 'scatter query carries per_ad_conf');
    assert.ok(sql.includes(`WHEN IFNULL(conf_group, '') = 'Hair' AND conf_segment = 'Prospecting' THEN ${KILL_T}`), sql);
    assert.ok(sql.includes(`THEN ${SCALE_T}`));
    assert.ok(/ AS verdict\n\s*FROM per_ad_conf ORDER BY lifetime_spend DESC/.test(sql), sql);
    assert.ok(sql.includes(ctx.sb.confidenceVerdictSQL('lifetime_spend', 'kill_conv', 'kill_target', { conf: 0.9, scaleConvCol: 'scale_conv', scaleTargetCol: 'scale_target' })));
    const src = read('f10-monthly.js');
    assert.ok(!/confidenceGradeAd\(/.test(src.slice(src.indexOf('async function loadProduction'))), 'display never re-grades');
    const counts = ctx.doc.getElementById('prod-baseline-verdicts').innerHTML;
    const want = { Scale: 0, Testing: 0, Cut: 0 };
    ['cutthree', 'twoxlead', 'bothcutscale', 'scalesubs', 'freshad', 'steady'].forEach((n) => { want[verdictOf(ctx, n)]++; });
    assert.ok(counts.includes(`<strong>${want.Scale}</strong> Scale, <strong>${want.Testing}</strong> Testing, <strong>${want.Cut}</strong> Cut`), counts);
  });

  await test('Verdict header is sortable and its hover explains the test', async () => {
    const ctx = await bootEnabled();
    const html = ctx.doc.getElementById('app').innerHTML;
    const hover = 'Judged against your last 90 days for this product and campaign type, using Meta-reported results, at 90% confidence.';
    const i = html.indexOf('>Verdict</th>');
    assert.ok(i > 0, 'Verdict header renders');
    const th = html.slice(html.lastIndexOf('<th', i), i);
    assert.ok(th.includes(hover), th);
    assert.ok(html.slice(i - 2000, i).includes('<th>Creative Score</th>'), 'Verdict follows Creative Score');
    assert.ok(!/<th[^>]*no-sort/.test(th), 'header is sortable like the rest');
  });

  await test('Product / Group set to All: verdicts show, no curve, note visible', async () => {
    const ctx = await bootEnabled({ group: false });
    assert.strictEqual(ctx.sb.confidenceSelectedKey(), null);
    assert.strictEqual(ctx.run('confidenceCurveState'), null);
    assert.strictEqual(ctx.doc.getElementById('prod-conf-lines-note').textContent, 'Pick a product and campaign type to see the lines');
    assert.strictEqual(verdictOf(ctx, 'cutthree'), 'Cut', 'the column still shows');
    const plugin = scatterChart(ctx).plugins.find((p) => p.id === 'confidence-lines');
    const calls = [];
    plugin.afterDraw(fakeChart(calls));
    assert.ok(!calls.includes('stroke'), 'nothing drawn');
  });

  await test('hair and Prospecting, log toggle on: kill curve drawn from the hair prospecting lead target', async () => {
    const ctx = await bootEnabled();
    assert.strictEqual(ctx.doc.getElementById('prod-conf-lines-note').textContent, '');
    const box = ctx.doc.getElementById('cl-log-toggle');
    box.checked = true;
    box.dispatch('change');
    await flush();
    const chart = scatterChart(ctx);
    assert.strictEqual(chart.options.scales.x.type, 'logarithmic');
    assert.ok(chart.options.scales.x.min > 0);
    const st = ctx.run('confidenceCurveState');
    assert.strictEqual(st.which, 'kill');
    assert.strictEqual(st.target, KILL_T);
    assert.strictEqual(st.key, 'Hair|Prospecting');
    assert.strictEqual(st.log, true);
    const p = st.points[st.points.length - 1];
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), JSON.parse(JSON.stringify(ctx.sb.confidenceCurvePoints(KILL_T, p.spend, p.spend, 0.9)[0])));
    assert.strictEqual(chart.options.scales.y.title.text, 'Cost per kill conversion');
    const calls = [];
    chart.plugins.find((x) => x.id === 'confidence-lines').afterDraw(fakeChart(calls));
    assert.ok(calls.includes('stroke') && calls.includes('lineTo'), 'curve drawn');
    assert.ok(calls.includes('fillText:Cut line'));
    assert.ok(ctx.doc.getElementById('app').innerHTML.includes('Log spend axis'));
  });

  await test('y-axis toggle: cost per scale conversion and the scale curve', async () => {
    const ctx = await bootEnabled();
    const sel = ctx.doc.getElementById('cl-y-mode');
    sel.value = 'scale';
    sel.dispatch('change');
    await flush();
    const chart = scatterChart(ctx);
    assert.strictEqual(chart.options.scales.y.title.text, 'Cost per scale conversion');
    assert.notStrictEqual(chart.options.scales.x.type, 'logarithmic');
    const st = ctx.run('confidenceCurveState');
    assert.strictEqual(st.which, 'scale');
    assert.strictEqual(st.target, SCALE_T);
    const pts = scatterPoints(ctx);
    const scale = pts.find((x) => x.label === 'scalesubs');
    assert.strictEqual(scale.y, 2000 / 8, 'y is spend per sub');
    const none = pts.find((x) => x.label === 'freshad');
    assert.ok(none._noConv && none.y === chart.options.scales.y.max, 'no-conversion ads sit on the top edge');
    const calls = [];
    chart.plugins.find((x) => x.id === 'confidence-lines').afterDraw(fakeChart(calls));
    assert.ok(calls.includes('fillText:Scale line'));
    ctx.run("confidenceYMode = 'kill'; confidenceLogAxis = false;");
  });

  await test('an ad search for one ad name: the verdict table and the scatter show only that ad', async () => {
    const ctx = await bootEnabled({ search: 'cutthree' });
    const rows = tableBody(ctx).split('data-adname="').length - 1;
    assert.strictEqual(rows, 1, tableBody(ctx));
    assert.strictEqual(verdictOf(ctx, 'cutthree'), 'Cut');
    const pts = scatterPoints(ctx);
    assert.deepStrictEqual(pts.map((p) => p.label), ['cutthree']);
    assert.ok(ctx.run('confidenceCurveState'), 'the line stays');
    ctx.run("adSearchTerm = '';");
  });

  await test('status filters scope the verdict query', async () => {
    const ctx = await bootEnabled();
    const sql = ctx.queries.find((q) => /per_ad_conf/.test(q));
    assert.ok(sql.includes(ctx.sb.scopeWhere('WHERE')), 'scatter query carries the page scope');
  });

  await test('tiers, Creative Score and the threshold panel keep working alongside the verdict', async () => {
    const ctx = await bootEnabled();
    const body = tableBody(ctx);
    assert.ok(body.includes('badge-ob') && body.includes('On Base'));
    const sql = ctx.queries.find((q) => /per_ad_conf/.test(q));
    assert.ok(sql.includes('AS classification') && sql.includes('AS creative_score'));
    assert.ok(ctx.doc.getElementById('app').innerHTML.includes('id="prod-baseline-body"'));
  });

  await test('no config: no verdict cell, controls, note, log axis or curve plugin', async () => {
    const ctx = boot();
    ctx.sb.renderLayout();
    await ctx.sb.loadProduction();
    await flush();
    const html = ctx.doc.getElementById('app').innerHTML;
    ['>Verdict</th>', 'cl-log-toggle', 'cl-y-mode', 'prod-conf-lines-note'].forEach((s) => assert.ok(!html.includes(s), s));
    const body = tableBody(ctx);
    assert.ok(!body.includes('No baseline') && !body.includes('badge-cut') && !body.includes('badge-testing'));
    const chart = scatterChart(ctx);
    if (chart){
      assert.notStrictEqual(chart.options.scales.x.type, 'logarithmic');
      assert.ok(!chart.plugins.some((p) => p.id === 'confidence-lines'));
    }
    assert.ok(!ctx.queries.some((q) => /per_ad_conf| AS verdict/.test(q)));
  });

  await test('no em or en dashes in the US-003 code and CSS', async () => {
    const src = read('f10-monthly.js');
    const a = src.indexOf('Verdict column and confidence lines (confidence-lines US-003)');
    const b = src.indexOf('function _confTargetField', a);
    assert.ok(a > 0 && b > a);
    assert.ok(!/[\u2013\u2014]/.test(src.slice(a, b)));
    const lay = read('f10-layout.js');
    const la = lay.indexOf('function confidenceVerdictHover');
    assert.ok(!/[\u2013\u2014]/.test(lay.slice(la, lay.indexOf('function prodThresholdLegendHTML', la))));
    const css = read('f10-shared.css');
    const ca = css.indexOf('confidence-lines US-003');
    assert.ok(!/[\u2013\u2014]/.test(css.slice(ca, css.indexOf('.cl-lines-note', ca))));
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
