/**
 * Campaign type segment and moveable baseline acceptance test
 * (creative-dashboard-confidence-lines US-002).
 *
 * Boots f10-utils.js, f10-weekly.js, f10-layout.js and f10-monthly.js together
 * in a vm with a small auto-creating DOM stub, renders the layout, runs
 * loadProduction() against a fake runQuery and checks:
 *   1. No CONFIDENCE_LINES: the rendered layout HTML and every SQL string
 *      loadProduction() sends are byte-identical to the build before US-002
 *      (pinned SHA-256 below), with no dropdown, panel or target input.
 *   2. BASELINE_DAYS 90 with window end 2026-10-31 queries
 *      date_start BETWEEN '2026-08-01' AND '2026-10-30' ... GROUP BY 1, 2.
 *   3. Editing the kill target 766 -> 600 re-grades the page; Reset to
 *      baseline restores 766.
 *   4. 40 conversions: 'Not enough data for a baseline' and no inputs.
 *   Plus the segment dropdown, the segment scope clause and the Unmatched flag.
 *
 * Regenerating the pins: they are the output of this same harness run against
 * the US-001 commit (8c00fb8) sources. Check those four files out into a
 * directory and run: node test/confidence-baseline.test.js --print-pins <dir>
 *
 * Dependency-free. Run: node test/confidence-baseline.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');
const { withSqlVerdicts } = require('./helpers/confidence-sql');

const ROOT = path.join(__dirname, '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* Pre-US-002 output with GROUP_FILTERS = [{ col: 'group_name', label: 'Product' }]
 * and no CONFIDENCE_LINES. */
const PINS = {
  layout: '69efa0896a3d1dd566865fe0453a99daa338c3ad3b77ff22ed1867d986dda412',
  productionSql: [
    '79318c7a5a364414a557a7ff9ae12ac42098d8b6de2186953bf6a47c74eb5d80',
    '8185862b6c3405f41b9b06a08907f0afe39836f6ceaef57b99d9bb10fa71b844',
  ],
};

/* Mosh-style SEGMENT_EXPR: Reach retargeting types collapse into Retargeting,
 * Awareness is excluded (NULL), anything else is Unmatched. */
const SEGMENT_EXPR = `CASE
  WHEN campaign_name LIKE '%_Awareness%' THEN NULL
  WHEN campaign_name LIKE '%_Prospecting_Web-Visit-Retargeting_%' THEN 'Retargeting'
  WHEN campaign_name LIKE '%_Retargeting_Reach%' OR campaign_name LIKE '%_Post-Quiz_Retargeting_%' OR campaign_name LIKE '%_Web-Visit_Retargeting_Reach%' THEN 'Retargeting'
  WHEN campaign_name LIKE '%_Prospecting%' OR campaign_name LIKE '%ASC+%' THEN 'Prospecting'
  ELSE 'Unmatched' END`;
const CONFIG = {
  KILL_CONV_EXPR: 'plan_assigned',
  SCALE_CONV_EXPR: 'subscriptions',
  SEGMENT_EXPR,
  BASELINE_DAYS: 90,
  CONFIDENCE: 0.9,
};
const GROUPS = [{ col: 'group_name', label: 'Product' }];

/* ── DOM stub. getElementById auto-creates; setting innerHTML drops any element
 * whose id appears in the new markup, so it is fresh (no stale listeners), as
 * in a browser. ── */
function makeDom(){
  const els = {};
  function makeEl(id){
    const el = {
      id: id || '', value: '', textContent: '', style: {}, dataset: {}, children: [], _listeners: {}, _html: '',
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

function boot(dir, opts){
  opts = opts || {};
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const doc = makeDom();
  const queries = [];
  const F10A = { init(){}, track(){}, page(){}, identify(){} };
  const quiet = { log(){}, warn(){}, error: (...a) => { if (opts.errors) opts.errors.push(a); }, info(){} };
  const sb = {
    window: { F10A, f10MediaMarkup: () => '', addEventListener(){}, location: { search: '', hash: '' } },
    document: doc, console: quiet, F10A,
    PROJECT: 'mcc-poc-477801', DATASET: 'acme_marts', TABLE: 'creative_reporting', CONV_EXPR: 'purchase',
    CLIENT_NAME: 'Acme', BQ_FUNCTION: '/bq', GROUP_FILTERS: GROUPS,
    fetch: async () => { throw new Error('no fetch'); }, setTimeout: () => 0, clearTimeout(){},
    Chart: function(){ return { destroy(){}, update(){} }; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem(){ return null; }, setItem(){} }, sessionStorage: { getItem(){ return null; }, setItem(){} },
    requestAnimationFrame: () => 0, navigator: { userAgent: 'node' },
  };
  if (opts.config) sb.CONFIDENCE_LINES = opts.config;
  vm.createContext(sb);
  ['f10-utils.js', 'f10-weekly.js', 'f10-layout.js', 'f10-monthly.js']
    .forEach((f) => vm.runInContext(read(f), sb, { filename: f }));
  sb.runQuery = async (sql) => { queries.push(sql); return opts.answer ? (opts.answer(sql) || []) : []; };
  const run = (code) => vm.runInContext(code, sb);
  return { sb, doc, queries, run };
}

async function flush(){ for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

async function noConfigOutput(dir){
  const { sb, doc, queries, run } = boot(dir);
  sb.renderLayout();
  const html = doc.getElementById('app').innerHTML;
  await sb.loadProduction();
  return { html, queries, sb, run };
}

let failures = 0;
async function test(name, fn){
  try { await fn(); console.log('ok - ' + name); }
  catch (e) { failures++; console.log('not ok - ' + name); console.log(e && e.stack ? e.stack : e); }
}

/* Baseline rows and ads for the Hair x Prospecting cell. */
function baselineRows(killConv, scaleConv){
  return [
    { grp: 'Hair', segment: 'Prospecting', spend: 766 * killConv, kill_conv: killConv, scale_conv: scaleConv,
      cost_per_kill: 766, cost_per_scale: 1500 },
    { grp: 'Hair', segment: 'Retargeting', spend: 9000, kill_conv: 80, scale_conv: 70, cost_per_kill: 112.5, cost_per_scale: 128.57 },
    { grp: 'Hair', segment: 'Unmatched', spend: 1234.5, kill_conv: 3, scale_conv: 1, cost_per_kill: 411.5, cost_per_scale: 1234.5 },
  ];
}
/* Spend / kill conversions chosen around the 766 and 600 lines. */
const ADS = [
  [6000, 2], [5000, 3], [4500, 4], [3500, 2], [8000, 6], [2600, 1], [12000, 30], [400, 0], [7000, 9], [3000, 3],
].map(([spend, kc], i) => ({
  ad_name: 'ad' + i, campaign_name: 'Mosh_Hair_Prospecting', adset_name: 'set', lifetime_spend: spend,
  conf_group: 'Hair', conf_segment: 'Prospecting', kill_conv: kc, scale_conv: 0, classification: 'On Base',
}));

function answerFor(rows){
  return (sql) => {
    if (/cost_per_kill/.test(sql)) return rows;
    if (/SELECT DISTINCT/.test(sql) && /AS segment/.test(sql)) return [{ segment: 'Prospecting' }, { segment: 'Retargeting' }, { segment: 'Unmatched' }];
    if (/conf_segment/.test(sql)) return withSqlVerdicts(sql, ADS);
    return [];
  };
}

async function bootEnabled(rows){
  const errors = [];
  const ctx = boot(ROOT, { config: CONFIG, answer: answerFor(rows), errors });
  ctx.errors = errors;
  ctx.sb.renderLayout();
  ctx.doc.getElementById('ctrl-enddate').value = '2026-10-31';
  ctx.run("groupSelections['group_name'] = 'Hair';");
  ctx.sb.setSegmentSelection('Prospecting');
  await ctx.sb.loadProduction();
  await flush();
  return ctx;
}
function expectedCounts(sb, target){
  const out = { Scale: 0, Testing: 0, Cut: 0 };
  ADS.forEach((a) => { out[sb.confidenceVerdict(a.lifetime_spend, a.kill_conv, target, { conf: 0.9, scaleConv: 0, scaleTarget: 1500 })]++; });
  return out;
}
const countsText = (c) => `<strong>${c.Scale}</strong> Scale, <strong>${c.Testing}</strong> Testing, <strong>${c.Cut}</strong> Cut`;

(async () => {
  if (process.argv[2] === '--print-pins'){
    const o = await noConfigOutput(process.argv[3]);
    console.log(JSON.stringify({ layout: sha(o.html), productionSql: o.queries.map(sha) }, null, 2));
    return;
  }

  await test('no config: layout HTML and production SQL are byte-identical to the pre-US-002 build', async () => {
    const a = await noConfigOutput(ROOT);
    const b = await noConfigOutput(ROOT);
    assert.strictEqual(a.html, b.html, 'layout render is deterministic');
    assert.deepStrictEqual(a.queries, b.queries, 'production SQL is deterministic');
    assert.strictEqual(sha(a.html), PINS.layout, 'layout HTML changed without CONFIDENCE_LINES');
    assert.deepStrictEqual(a.queries.map(sha), PINS.productionSql, 'production SQL changed without CONFIDENCE_LINES');
  });

  await test('no config: no dropdown, panel, input or extra query', async () => {
    const o = await noConfigOutput(ROOT);
    ['ctrl-segment', 'prod-baseline-controls', 'cl-reset', 'cl-target-kill', 'Campaign type', 'Meta-reported']
      .forEach((s) => assert.ok(!o.html.includes(s), s + ' must not render'));
    assert.strictEqual(o.sb.confidenceLinesEnabled(), false);
    assert.strictEqual(o.sb.confidenceAdSelect(), '');
    assert.strictEqual(o.sb.confidenceBaselineSQL('2026-10-31'), null);
    const before = o.sb.scopeWhere('WHERE');
    o.sb.setSegmentSelection('Prospecting');
    assert.strictEqual(o.sb.scopeWhere('WHERE'), before, 'segment selection is inert without config');
    assert.ok(!o.queries.some((q) => /cost_per_kill|conf_segment/.test(q)));
  });

  await test('days 90, end 2026-10-31: one baseline query over 2026-08-01..2026-10-30, GROUP BY 1, 2', async () => {
    const ctx = await bootEnabled(baselineRows(100, 60));
    const sql = ctx.sb.confidenceBaselineSQL('2026-10-31');
    assert.ok(sql.includes("date_start BETWEEN '2026-08-01' AND '2026-10-30'"), sql);
    assert.ok(/GROUP BY 1, 2\s*$/.test(sql), sql);
    assert.ok(sql.includes('CAST(group_name AS STRING) AS grp'));
    assert.ok(sql.includes('SUM(plan_assigned)') && sql.includes('SUM(subscriptions)'));
    assert.ok(sql.includes(`(${SEGMENT_EXPR}) IS NOT NULL`), 'excluded (NULL) campaigns drop out');
    const baselineQueries = ctx.queries.filter((q) => /cost_per_kill/.test(q));
    assert.strictEqual(baselineQueries.length, 1, 'exactly one baseline query');
    assert.strictEqual(baselineQueries[0], sql);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.sb.confidenceBaselineWindow('2026-03-01', 1))), { start: '2026-02-27', end: '2026-02-28' });
    assert.deepStrictEqual(ctx.errors, []);
  });

  await test('segment dropdown sits next to Product and scopes every query', async () => {
    const ctx = await bootEnabled(baselineRows(100, 60));
    const html = ctx.doc.getElementById('app').innerHTML;
    const gi = html.indexOf('id="ctrl-groups"'), si = html.indexOf('id="ctrl-segment"');
    assert.ok(gi > 0 && si > gi && html.slice(gi, si).split('<div').length <= 4, 'dropdown follows the Product filter');
    assert.ok(html.includes('Your last 90 days (Meta-reported)'));
    const opts = ctx.doc.getElementById('ctrl-segment').innerHTML;
    assert.ok(opts.includes('value="Prospecting"') && opts.includes('value="Retargeting"'));
    assert.ok(opts.includes('Unmatched (check naming)'));
    const scatter = ctx.queries.find((q) => /conf_segment/.test(q));
    assert.ok(scatter.includes(`(${SEGMENT_EXPR}) = 'Prospecting'`), 'scatter is scoped to the segment');
    assert.ok(scatter.includes("group_name = 'Hair'"));
    ctx.sb.setSegmentSelection('__all__');
    assert.ok(!ctx.sb.scopeWhere('WHERE').includes('Unmatched'));
  });

  await test('target 766 -> 600 re-grades the page; Reset restores 766', async () => {
    const ctx = await bootEnabled(baselineRows(100, 60));
    const { doc, sb } = ctx;
    const body = () => doc.getElementById('prod-baseline-body').innerHTML;
    const counts = () => doc.getElementById('prod-baseline-verdicts').innerHTML;
    assert.ok(body().includes('id="cl-target-kill"') && body().includes('value="766"'), body());
    const at766 = expectedCounts(sb, 766), at600 = expectedCounts(sb, 600);
    assert.notDeepStrictEqual(at766, at600, 'fixture ads straddle the two lines');
    assert.ok(counts().includes(countsText(at766)), counts());
    assert.ok(!counts().includes('edited'));
    assert.notStrictEqual(doc.getElementById('cl-reset').style.display, 'none');

    const input = doc.getElementById('cl-target-kill');
    input.value = '600';
    input.dispatch('change');
    await flush();
    assert.ok(body().includes('value="600"'), body());
    assert.ok(counts().includes(countsText(at600)), counts());
    assert.ok(counts().includes('(edited for this session)'));
    assert.strictEqual(sb.getConfidenceTargets('Hair|Prospecting').kill, 600);
    assert.strictEqual(sb.getConfidenceTargets('Hair|Prospecting').killBaseline, 766);
    assert.strictEqual(ctx.queries.filter((q) => /cost_per_kill/.test(q)).length, 1, 'an edit does not re-query the baseline');

    const bad = doc.getElementById('cl-target-kill');
    bad.value = '-5';
    bad.dispatch('change');
    await flush();
    assert.strictEqual(sb.getConfidenceTargets('Hair|Prospecting').kill, 600, 'non-positive edits are rejected');

    doc.getElementById('cl-reset').click();
    await flush();
    assert.ok(body().includes('value="766"'), body());
    assert.ok(counts().includes(countsText(at766)), counts());
    assert.ok(!counts().includes('edited'));
    assert.strictEqual(sb.getConfidenceTargets('Hair|Prospecting').kill, 766);
    assert.deepStrictEqual(ctx.errors, []);
  });

  await test('40 conversions: Not enough data for a baseline, no inputs, no lines', async () => {
    const ctx = await bootEnabled(baselineRows(40, 20));
    const body = ctx.doc.getElementById('prod-baseline-body').innerHTML;
    assert.ok(body.includes('Not enough data for a baseline'), body);
    assert.ok(!body.includes('<input'), 'no target inputs');
    assert.strictEqual(ctx.doc.getElementById('prod-baseline-verdicts').innerHTML, '');
    assert.strictEqual(ctx.doc.getElementById('cl-reset').style.display, 'none');
    const t = ctx.sb.getConfidenceTargets('Hair|Prospecting');
    assert.strictEqual(t.kill, null); assert.strictEqual(t.scale, null);
    assert.strictEqual(ctx.sb.confidenceGradeAd({ group: 'Hair', segment: 'Prospecting', spend: 9000, killConv: 0 }), null);
    assert.strictEqual(ctx.sb.setConfidenceTarget('Hair|Prospecting', 'kill', 600), false);
  });

  await test('50 kill conversions but 49 scale: kill line only', async () => {
    const ctx = await bootEnabled(baselineRows(50, 49));
    const body = ctx.doc.getElementById('prod-baseline-body').innerHTML;
    assert.ok(body.includes('id="cl-target-kill"'));
    assert.ok(!body.includes('id="cl-target-scale"'));
    assert.ok(body.includes('Not enough data for a baseline (49 conversions, needs 50)'), body);
  });

  await test('unmatched campaigns are flagged with their spend', async () => {
    const ctx = await bootEnabled(baselineRows(100, 60));
    const flag = ctx.doc.getElementById('prod-baseline-unmatched').innerHTML;
    assert.ok(flag.includes('id="cl-unmatched-flag"'), flag);
    assert.ok(flag.includes('match no campaign type'));
    assert.strictEqual(ctx.sb.confidenceUnmatchedSpend(), 1234.5);
    const clean = await bootEnabled(baselineRows(100, 60).filter((r) => r.segment !== 'Unmatched'));
    assert.strictEqual(clean.doc.getElementById('prod-baseline-unmatched').innerHTML, '');
  });

  await test('All selected: asks for a product and campaign type, no inputs', async () => {
    const ctx = await bootEnabled(baselineRows(100, 60));
    ctx.sb.setSegmentSelection('__all__');
    await ctx.sb.loadProduction();
    const body = ctx.doc.getElementById('prod-baseline-body').innerHTML;
    assert.ok(body.includes('Pick a product and campaign type'), body);
    assert.ok(!body.includes('<input'));
  });

  if (failures){ console.log(failures + ' failed'); process.exit(1); }
  console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
