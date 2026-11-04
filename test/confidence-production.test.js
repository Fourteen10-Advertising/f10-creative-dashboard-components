'use strict';
/* Confidence lines US-003, moved to the Scale & Cut tab in US-008: the Verdict
 * column, the kill and scale lines chart and the verdict counts. The verdict is
 * computed in SQL; the fake BigQuery here evaluates that SQL
 * (test/helpers/confidence-sql.js), so these tests check the emitted query and
 * what the page does with its answer. */
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
  await ctx.sb.loadScaleCut();
  await flush();
  return ctx;
}

const chartOn = (ctx, id) => { const c = ctx.charts.filter((x) => x.el && x.el.id === id); return c[c.length - 1]; };
const linesChart = (ctx) => chartOn(ctx, 'sc-lines-chart');
const tableBody = (ctx) => ctx.doc.getElementById('sc-table-body').innerHTML;
/* Verdict cell for one ad: the last <td> of its row. */
function verdictOf(ctx, name){
  const rows = tableBody(ctx).split('</tr>');
  const row = rows.find((r) => r.includes(`data-adname="${name}|`));
  assert.ok(row, 'row for ' + name);
  const m = /<td><span class="badge badge-(scale|testing|cut)">(Scale|Testing|Cut)<\/span><\/td>$/.exec(row);
  return m ? m[2] : null;
}
const linePoints = (ctx) => linesChart(ctx).data.datasets.reduce((a, d) => a.concat(d.data), []);
const linesPlugin = (ctx) => linesChart(ctx).plugins.find((p) => p.id === 'confidence-lines');

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

  await test('the verdict is one SQL column, read by the table, the counts, the chips and the dots', async () => {
    const ctx = await bootEnabled();
    const sqls = ctx.queries.filter((q) => /per_ad_conf/.test(q));
    assert.strictEqual(sqls.length, 1, 'one verdict query per load');
    const sql = sqls[0];
    assert.ok(sql.includes(`WHEN IFNULL(conf_group, '') = 'Hair' AND conf_segment = 'Prospecting' THEN ${KILL_T}`), sql);
    assert.ok(sql.includes(`THEN ${SCALE_T}`));
    assert.ok(/ AS verdict FROM per_ad_conf ORDER BY lifetime_spend DESC/.test(sql.replace(/\s+/g, ' ')), sql);
    assert.ok(sql.includes(ctx.sb.confidenceVerdictSQL('lifetime_spend', 'kill_conv', 'kill_target', { conf: 0.9, scaleConvCol: 'scale_conv', scaleTargetCol: 'scale_target' })));
    const src = read('f10-monthly.js');
    const block = src.slice(src.indexOf('/* ── Scale & Cut tab'), src.indexOf('/* ── Ad Power Law'));
    assert.ok(block.length > 1000, 'Scale & Cut block found');
    assert.ok(!/confidenceGradeAd\(|confidenceVerdict\(/.test(block), 'display never re-grades');
    const want = { Scale: 0, Testing: 0, Cut: 0 };
    ['cutthree', 'twoxlead', 'bothcutscale', 'scalesubs', 'freshad', 'steady'].forEach((n) => { want[verdictOf(ctx, n)]++; });
    assert.ok(!ctx.doc.getElementById('app').innerHTML.includes('sc-baseline-verdicts'), 'the At these targets line is removed; the legend chips carry the counts');
    assert.strictEqual(ctx.doc.getElementById('sc-count-scale').textContent, String(want.Scale));
    assert.strictEqual(ctx.doc.getElementById('sc-count-testing').textContent, String(want.Testing));
    assert.strictEqual(ctx.doc.getElementById('sc-count-cut').textContent, String(want.Cut));
    linePoints(ctx).forEach((p) => {
      if (['cutthree', 'twoxlead', 'bothcutscale', 'scalesubs', 'freshad', 'steady'].includes(p.label)) assert.strictEqual(p._verdict, verdictOf(ctx, p.label), p.label);
    });
  });

  await test('Verdict header is sortable, follows the cost column and its hover explains the test', async () => {
    const ctx = await bootEnabled();
    const html = ctx.doc.getElementById('app').innerHTML;
    const hover = 'Judged against your last 90 days for this product and campaign type, using Meta-reported results, at 90% confidence.';
    const panel = html.slice(html.indexOf('id="tab-scalecut"'));
    const i = panel.indexOf('>Verdict</th>');
    assert.ok(i > 0, 'Verdict header renders in the Scale & Cut tab');
    const th = panel.slice(panel.lastIndexOf('<th', i), i);
    assert.ok(th.includes(hover), th);
    const before = panel.slice(panel.lastIndexOf('<thead', i), i);
    ['>Ad</th>', '>Campaign</th>', '>Campaign type</th>', '>Lifetime spend</th>', 'id="sc-th-conv"', 'id="sc-th-cpa"'].forEach((s) => assert.ok(before.includes(s), s));
    assert.ok(before.indexOf('id="sc-th-cpa"') > before.indexOf('id="sc-th-conv"'));
    assert.ok(!/<th[^>]*no-sort/.test(th), 'header is sortable like the rest');
  });

  await test('Product set to All: dots and verdicts show, no lines, note visible', async () => {
    const ctx = await bootEnabled({ group: false });
    assert.strictEqual(ctx.sb.confidenceSelectedKey(), null);
    assert.strictEqual(ctx.run('confidenceCurveState'), null);
    assert.strictEqual(ctx.doc.getElementById('sc-lines-note').textContent, 'Pick a product and campaign type to see the lines');
    assert.strictEqual(verdictOf(ctx, 'cutthree'), 'Cut', 'the column still shows');
    assert.ok(linePoints(ctx).length > 0, 'dots still drawn');
    const calls = [];
    linesPlugin(ctx).beforeDatasetsDraw(fakeChart(calls));
    assert.ok(!calls.includes('stroke') && !calls.some((c) => c.startsWith('fillText:')), 'nothing drawn');
  });

  await test('Campaign type set to All: dots only and the same note', async () => {
    const ctx = await bootEnabled({ segment: '__all__' });
    assert.strictEqual(ctx.sb.confidenceSelectedKey(), null);
    assert.strictEqual(ctx.run('confidenceCurveState'), null);
    assert.strictEqual(ctx.doc.getElementById('sc-lines-note').textContent, 'Pick a product and campaign type to see the lines');
    assert.ok(linePoints(ctx).length > 0);
  });

  await test('hair and Prospecting: kill curves from the hair prospecting lead target on a log spend axis', async () => {
    const ctx = await bootEnabled();
    const chart = linesChart(ctx);
    assert.strictEqual(chart.options.scales.x.type, 'logarithmic');
    assert.strictEqual(chart.options.scales.x.title.text, 'Spend per ad (log)');
    assert.ok(chart.options.scales.x.min > 0);
    assert.strictEqual(chart.options.scales.y.min, 0);
    assert.strictEqual(chart.options.scales.y.max, Math.ceil(KILL_T * 4), 'y runs to about 4x target');
    assert.strictEqual(chart.options.scales.y.title.text, 'Cost per kill conversion');
    assert.strictEqual(ctx.doc.getElementById('sc-lines-sub').textContent, 'Spend (log) against cost per kill conversion');
    const st = ctx.run('confidenceCurveState');
    assert.strictEqual(st.which, 'kill');
    assert.strictEqual(st.target, KILL_T);
    assert.strictEqual(st.key, 'Hair|Prospecting');
    const b3 = ctx.sb.confidenceBounds(3, 0.9);
    const c3 = st.cut.find((p) => p.conv === 3), s3 = st.scale.find((p) => p.conv === 3);
    assert.ok(Math.abs(c3.spend - KILL_T * b3.kill) < 1e-6 && Math.abs(c3.cpa - KILL_T * b3.kill / 3) < 1e-6, 'Cut curve point at 3 conversions');
    assert.ok(Math.abs(s3.spend - KILL_T * b3.scale) < 1e-6, 'Scale curve point at 3 conversions');
    assert.ok(st.cut[st.cut.length - 1].cpa < st.cut[0].cpa, 'Cut curve falls towards target');
    assert.ok(st.scale[st.scale.length - 1].cpa > st.scale[0].cpa, 'Scale curve rises towards target');
    const ticks = ctx.sb.confidenceLogTicks(100, 100000).map((v) => ctx.sb.confidenceShortMoney(v));
    assert.strictEqual(JSON.stringify(ticks), JSON.stringify(['$100', '$1k', '$10k', '$100k']));
    const calls = [];
    linesPlugin(ctx).beforeDatasetsDraw(fakeChart(calls));
    assert.ok(calls.includes('stroke') && calls.includes('lineTo') && calls.includes('fill'), 'curves and shading drawn');
    assert.ok(calls.includes('setLineDash'), 'dashed target line');
    ['CUT', '90% sure it misses target', 'SCALE', '90% sure it beats target', 'TESTING', 'keep spending', 'target $766'].forEach((t) => {
      assert.ok(calls.includes('fillText:' + t), t + ' in ' + calls.filter((c) => c.startsWith('fillText')).join(', '));
    });
    assert.deepStrictEqual(ctx.errors, []);
  });

  await test('dots are coloured by verdict, sized by spend and clamped to the top', async () => {
    const ctx = await bootEnabled();
    const chart = linesChart(ctx);
    const labels = chart.data.datasets.map((d) => d.label);
    labels.forEach((l) => assert.ok(['Scale', 'Testing', 'Cut', 'No baseline'].includes(l), l));
    const pts = linePoints(ctx);
    const big = pts.find((p) => p.label === 'cutthree'), small = pts.find((p) => p.label === 'freshad');
    assert.ok(big._r > small._r, 'bigger spend, bigger dot');
    assert.ok(small._clamped && small.y === chart.options.scales.y.max, 'no conversions sits on the top edge');
    const tip = ctx.sb.confidenceLinesTooltip(big, ctx.run('scaleCutState').mode);
    assert.ok(tip.includes('Verdict: Cut') && tip.some((t) => t.startsWith('Spend: ')), tip.join(' / '));
  });

  await test('Judge on Subs: cost per scale conversion and the scale target', async () => {
    const ctx = await bootEnabled();
    ctx.doc.getElementById('sc-judge-scale').dispatch('click');
    await flush();
    const chart = linesChart(ctx);
    assert.strictEqual(chart.options.scales.y.title.text, 'Cost per scale conversion');
    assert.strictEqual(chart.options.scales.x.type, 'logarithmic');
    const st = ctx.run('confidenceCurveState');
    assert.strictEqual(st.which, 'scale');
    assert.strictEqual(st.target, SCALE_T);
    const pts = linePoints(ctx);
    assert.strictEqual(pts.find((x) => x.label === 'scalesubs').y, 2000 / 8, 'y is spend per sub');
    assert.strictEqual(ctx.doc.getElementById('sc-lines-note').textContent,
      'Scale line is exact. Switch Judge on to Kill conversions to see the exact Cut line.');
    assert.strictEqual(ctx.run('confidenceConvNoun(confidenceLinesConfig().killLabel)'), 'Kill conversions', 'note names the Judge on button');
    ctx.run("confidenceYMode = 'kill';");
  });

  await test('an ad search for one ad name: the table, the dots and the chips show only that ad', async () => {
    const ctx = await bootEnabled({ search: 'cutthree' });
    const rows = tableBody(ctx).split('data-adname="').length - 1;
    assert.strictEqual(rows, 1, tableBody(ctx));
    assert.strictEqual(verdictOf(ctx, 'cutthree'), 'Cut');
    assert.deepStrictEqual(linePoints(ctx).map((p) => p.label), ['cutthree']);
    assert.ok(ctx.run('confidenceCurveState'), 'the lines stay');
    assert.strictEqual(ctx.doc.getElementById('sc-count-cut').textContent, '1');
    assert.strictEqual(ctx.doc.getElementById('sc-count-scale').textContent, '0');
    ctx.run("adSearchTerm = '';");
  });

  await test('status and Campaign type filters scope the verdict query', async () => {
    const ctx = await bootEnabled();
    const sql = ctx.queries.find((q) => /per_ad_conf/.test(q));
    const scope = ctx.sb.scaleCutScopeWhere('WHERE');
    assert.ok(scope.includes('Prospecting'), scope);
    assert.ok(sql.includes(scope), 'verdict query carries the tab scope');
  });

  await test('no config: no Scale & Cut nav, panel or verdict query', async () => {
    const ctx = boot();
    ctx.sb.renderLayout();
    const html = ctx.doc.getElementById('app').innerHTML;
    ['data-tab="scalecut"', 'tab-scalecut', '>Verdict</th>', 'sc-judge', 'sc-controls', 'sc-lines-note'].forEach((s) => assert.ok(!html.includes(s), s));
    await ctx.sb.loadScaleCut();
    await ctx.sb.loadProduction();
    await flush();
    assert.ok(!ctx.queries.some((q) => /per_ad_conf| AS verdict/.test(q)));
    assert.ok(!ctx.charts.some((c) => c.el && c.el.id === 'sc-lines-chart'));
  });

  await test('with config the Scale & Cut nav sits after Ad Production', async () => {
    const ctx = boot({ config: CONFIG });
    ctx.sb.renderLayout();
    const html = ctx.doc.getElementById('app').innerHTML;
    const prod = html.indexOf('data-tab="production"'), sc = html.indexOf('data-tab="scalecut"');
    assert.ok(prod > 0 && sc > prod, 'Scale & Cut after Ad Production');
    assert.ok(html.includes('Scale &amp; Cut'));
  });

  await test('no em or en dashes in the Scale & Cut code and CSS', async () => {
    const src = read('f10-monthly.js');
    const a = src.indexOf('/* ── Scale & Cut tab');
    const b = src.indexOf('/* ── Ad Power Law', a);
    assert.ok(a > 0 && b > a);
    assert.ok(!/[\u2013\u2014]/.test(src.slice(a, b)));
    const css = read('f10-shared.css');
    const ca = css.indexOf('Scale & Cut tab cards');
    assert.ok(ca > 0);
    assert.ok(!/[\u2013\u2014]/.test(css.slice(ca, css.indexOf('.cl-reach-empty', ca) + 80)));
  });

  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})();


function fakeChart(calls){
  const rec = (n) => (...a) => { calls.push(n === 'fillText' ? 'fillText:' + a[0] : n); };
  return {
    ctx: { save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), rect: rec('rect'), clip: rec('clip'),
      moveTo: rec('moveTo'), lineTo: rec('lineTo'), stroke: rec('stroke'), fillText: rec('fillText'), fill: rec('fill'),
      closePath: rec('closePath'), fillRect: rec('fillRect'), setLineDash: rec('setLineDash'), roundRect: rec('roundRect'),
      measureText: (t) => ({ width: String(t).length * 6 }) },
    scales: { x: { getPixelForValue: (v) => Math.log10(Math.max(1, v)) * 20 }, y: { getPixelForValue: (v) => 300 - v / 10 } },
    chartArea: { left: 0, top: 0, right: 400, bottom: 300 },
    height: 340,
  };
}
