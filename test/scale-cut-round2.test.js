/**
 * Scale & Cut round 2 (2026-11-04).
 *
 * Boots f10-utils.js, f10-weekly.js, f10-layout.js and f10-monthly.js in a vm
 * and checks each round 2 item:
 *   1. Launch date range: default is the 90 days to the window end, typed dates
 *      are kept, reversed dates swap, and the per-ad SQL filters on launch date
 *      (first day with spend) while sums stay cumulative from launch.
 *   2. Live or paused: is_active from the newest row, the Status column and the
 *      two mismatch flags.
 *   3. Maturity playback: the per-day verdict is confidenceVerdictSQL over
 *      running sums, capped at 600 ads with a note.
 *   4. New ad flow: one row per launch week that sums to the ads in range.
 *   5. Older ads lens on the Movement Map.
 *   Plus the removals and no-config parity (the pinned layout and SQL are in
 *   confidence-baseline.test.js).
 *
 * Dependency-free. Run: node test/scale-cut-round2.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { evalVerdictSQL } = require('./helpers/confidence-sql');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CONFIG = {
  KILL_CONV_EXPR: 'plan_assigned',
  SCALE_CONV_EXPR: 'subscriptions',
  SEGMENT_EXPR: "CASE WHEN campaign_name LIKE '%_Prospecting%' THEN 'Prospecting' ELSE 'Unmatched' END",
  BASELINE_DAYS: 90,
  CONFIDENCE: 0.9,
};

function makeDom(){
  const els = {};
  function makeEl(id){
    return {
      id: id || '', value: '', textContent: '', style: {}, dataset: {}, children: [], _listeners: {}, innerHTML: '',
      classList: { _s: new Set(), add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); }, contains(c){ return this._s.has(c); }, toggle(){} },
      addEventListener(t, fn){ (this._listeners[t] || (this._listeners[t] = [])).push(fn); }, removeEventListener(){},
      appendChild(c){ return c; }, insertAdjacentHTML(){}, setAttribute(k, v){ this[k] = v; }, getAttribute(k){ return this[k]; },
      querySelector(){ return null; }, querySelectorAll(){ return []; }, closest(){ return null; }, getContext(){ return {}; },
      remove(){}, focus(){}, getBoundingClientRect(){ return { top: 0, left: 0, width: 0, height: 0 }; },
    };
  }
  const doc = { els, getElementById(id){ return els[id] || (els[id] = makeEl(id)); }, createElement(){ return makeEl(); },
    querySelector(){ return null; }, querySelectorAll(){ return []; }, addEventListener(){}, documentElement: { style: {} } };
  doc.body = makeEl('body'); doc.head = makeEl('head');
  return doc;
}
function boot(config){
  const doc = makeDom();
  const F10A = { init(){}, track(){}, page(){}, identify(){} };
  const sb = {
    window: { F10A, f10MediaMarkup: () => '', addEventListener(){}, location: { search: '', hash: '' } },
    document: doc, console: { log(){}, warn(){}, error(){}, info(){} }, F10A,
    PROJECT: 'p', DATASET: 'd', TABLE: 't', CONV_EXPR: 'purchase', CLIENT_NAME: 'Acme', BQ_FUNCTION: '/bq',
    GROUP_FILTERS: [{ col: 'group_name', label: 'Product' }],
    fetch: async () => { throw new Error('no fetch'); }, setTimeout: () => 0, clearTimeout(){},
    Chart: function(){ return { destroy(){}, update(){} }; }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem(){ return null; }, setItem(){} }, sessionStorage: { getItem(){ return null; }, setItem(){} },
    requestAnimationFrame: () => 0, navigator: { userAgent: 'node' },
  };
  if (config) sb.CONFIDENCE_LINES = config;
  vm.createContext(sb);
  ['f10-utils.js', 'f10-weekly.js', 'f10-layout.js', 'f10-monthly.js'].forEach((f) => vm.runInContext(read(f), sb, { filename: f }));
  sb.runQuery = async () => [];
  return { sb, doc, run: (code) => vm.runInContext(code, sb) };
}

let passed = 0, failed = 0;
function test(name, fn){
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e){ failed++; console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const RANGE = { from: '2026-08-02', to: '2026-10-31' };

// 1. Launch date range
test('launch range defaults to the 90 days to the window end', () => {
  const { sb, doc } = boot(CONFIG);
  doc.getElementById('ctrl-enddate').value = '2026-10-31';
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.scaleCutLaunchRange())), RANGE);
  assert.strictEqual(doc.getElementById('sc-launch-from').value, '2026-08-02');
  assert.strictEqual(doc.getElementById('sc-launch-to').value, '2026-10-31');
});
test('typed dates are kept and reversed dates swap', () => {
  const { sb, doc, run } = boot(CONFIG);
  doc.getElementById('ctrl-enddate').value = '2026-10-31';
  run('scaleCutRangeTouched = true');
  doc.getElementById('sc-launch-from').value = '2026-10-01';
  doc.getElementById('sc-launch-to').value = '2026-06-01';
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.scaleCutLaunchRange())), { from: '2026-06-01', to: '2026-10-01' });
  assert.strictEqual(doc.getElementById('sc-launch-from').value, '2026-06-01');
});
test('per-ad SQL filters on launch date and keeps lifetime sums', () => {
  const { sb } = boot(CONFIG);
  const sql = sb.scaleCutSQL(RANGE);
  assert.ok(sql.includes("HAVING MIN(IF(spend > 0, date_start, NULL)) BETWEEN DATE '2026-08-02' AND DATE '2026-10-31'"), sql);
  const where = sql.slice(sql.indexOf('FROM `p.d.t`'), sql.indexOf('GROUP BY 1'));
  assert.ok(!/date_start\s*(>=|BETWEEN)/.test(where), 'no date filter on the rows, so evidence stays cumulative from launch: ' + where);
  assert.ok(!sb.scaleCutSQL(null).includes('HAVING'), 'no range, no launch filter');
});

// 2. Live or paused
test('is_active comes from the newest row and drives the mismatch flags', () => {
  const { sb, run } = boot(CONFIG);
  assert.ok(sb.scaleCutSQL(RANGE).includes('ARRAY_AGG(is_active IGNORE NULLS ORDER BY date_start DESC LIMIT 1)[SAFE_OFFSET(0)] AS is_live'));
  assert.strictEqual(sb.confidenceIsLive({ is_live: true }), true);
  assert.strictEqual(sb.confidenceIsLive({ is_live: 'false' }), false);
  assert.strictEqual(sb.confidenceIsLive({ is_live: null }), null);
  assert.strictEqual(sb.scaleCutMismatch(false, 'Testing'), 'Paused while Testing');
  assert.strictEqual(sb.scaleCutMismatch(true, 'Cut'), 'Live in Cut');
  assert.strictEqual(sb.scaleCutMismatch(true, 'Testing'), null);
  assert.strictEqual(sb.scaleCutMismatch(false, 'Cut'), null);
  assert.strictEqual(sb.scaleCutMismatch(null, 'Cut'), null, 'unknown status is never flagged');
  assert.strictEqual(sb.confidenceStatusText(true), 'Live');
  assert.strictEqual(sb.confidenceStatusText(false), 'Paused');
  const html = run('scaleCutPanelHTML()');
  ['sc-count-paused-testing', 'sc-count-live-cut', 'Paused while Testing', 'Live in Cut', '>Status</th>'].forEach((s) => assert.ok(html.includes(s), s));
});

// 3. Maturity playback
test('per-day verdict is the SQL verdict over running sums since launch', () => {
  const { sb } = boot(CONFIG);
  const sql = sb.scaleCutPlaybackSQL(RANGE);
  assert.ok(sql.includes('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW'));
  const expr = sb.confidenceVerdictSQL('cum_spend', 'cum_kill', 'kill_target', { conf: 0.9, scaleConvCol: 'cum_scale', scaleTargetCol: 'scale_target' });
  assert.ok(sql.includes(expr), 'day_verdict uses confidenceVerdictSQL');
  const at = (spend, conv) => evalVerdictSQL(expr, { cum_spend: spend, cum_kill: conv, kill_target: 50, cum_scale: conv, scale_target: 50 });
  assert.strictEqual(at(1000, 12), 'Cut');
  assert.strictEqual(at(1000, 28), 'Scale');
  assert.strictEqual(at(50, 1), 'Testing');
  assert.ok(sql.includes('ORDER BY lifetime_spend DESC LIMIT 600'), 'capped at 600 ads');
  assert.ok(!/ad_window_reach|cost_per_kill|FROM per_ad\b/.test(sql));
});
test('playback cap note shows only above 600 ads', () => {
  const { sb, doc } = boot(CONFIG);
  doc.getElementById('ctrl-enddate').value = '2026-10-31';
  sb.setupScaleCutPlay([], { maxY: 100, maxSpend: 10 }, RANGE, 766);
  assert.strictEqual(doc.getElementById('sc-play-cap').textContent, 'Playback shows the top 600 of 766 ads by spend. Narrow the launch range to see them all.');
  sb.setupScaleCutPlay([], { maxY: 100, maxSpend: 10 }, RANGE, 600);
  assert.strictEqual(doc.getElementById('sc-play-cap').textContent, '');
});
test('a frame shows each launched ad at its latest running position, with trails', () => {
  const { sb, run } = boot(CONFIG);
  const byAd = sb.scaleCutHistoryIndex([
    { ad_id: '1', day: '2026-09-02', cum_spend: 300, cum_kill: 3, cum_scale: 1, day_verdict: 'Scale' },
    { ad_id: '1', day: '2026-09-01', cum_spend: 100, cum_kill: 0, cum_scale: 0, day_verdict: 'Testing' },
    { ad_id: '2', day: '2026-09-05', cum_spend: 50, cum_kill: 0, cum_scale: 0, day_verdict: 'Testing' },
  ]);
  run('scaleCutPlay.fixed = { maxY: 400, maxSpend: 300 }');
  const rows = [{ ad_id: '1', ad_name: 'a' }, { ad_id: '2', ad_name: 'b' }];
  const f = sb.scaleCutFrameRows(rows, byAd, '2026-09-01', true, { which: 'kill', logMin: 1 });
  assert.strictEqual(f.length, 1, 'ad 2 not launched yet');
  assert.strictEqual(f[0].verdict, 'Testing');
  assert.strictEqual(f[0].lifetime_spend, 100);
  const g = sb.scaleCutFrameRows(rows, byAd, '2026-09-03', true, { which: 'kill', logMin: 1 });
  assert.strictEqual(g[0].verdict, 'Scale');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g[0]._trail)), [{ x: 100, y: 400 }, { x: 300, y: 100 }]);
  const html = run('scaleCutPanelHTML()');
  ['id="sc-play-date"', 'id="sc-play"', 'id="sc-play-speed"', 'id="sc-trails"', 'id="sc-play-cap"'].forEach((s) => assert.ok(html.includes(s), s));
  ['value="1"', 'value="2"', 'value="4"'].forEach((s) => assert.ok(html.includes(s), 'speed ' + s));
});

// 4. New ad flow
test('flow rows: one per launch week, summing to the ads in range', () => {
  const { sb } = boot(CONFIG);
  const rows = [
    { ad_id: 1, launch_date: '2026-10-26', verdict: 'Scale', lifetime_spend: 100 },
    { ad_id: 2, launch_date: '2026-10-28', verdict: 'Cut', lifetime_spend: 250 },
    { ad_id: 3, launch_date: '2026-11-01', verdict: 'Testing', lifetime_spend: 40 },
    { ad_id: 4, launch_date: '2026-10-20', verdict: 'No baseline', lifetime_spend: 10 },
    { ad_id: 5, launch_date: '2026-10-19', verdict: 'Cut', lifetime_spend: 90 },
  ];
  const flow = [
    { ad_id: '1', first_verdict_date: '2026-10-30', days_to_verdict: 4, spend_to_verdict: 80 },
    { ad_id: '2', first_verdict_date: '2026-10-28', days_to_verdict: 0, spend_to_verdict: 60 },
    { ad_id: '3', first_verdict_date: null, days_to_verdict: null, spend_to_verdict: null },
    { ad_id: '5', first_verdict_date: '2026-10-25', days_to_verdict: 6, spend_to_verdict: 70 },
  ];
  const out = JSON.parse(JSON.stringify(sb.scaleCutFlowRows(rows, flow)));
  assert.deepStrictEqual(out.map((w) => w.week), ['2026-10-26', '2026-10-19']);
  assert.strictEqual(out.reduce((s, w) => s + w.ads, 0), rows.length);
  assert.deepStrictEqual(out[0], { week: '2026-10-26', ads: 3, scale: 1, testing: 1, cut: 1, ungraded: 0, withVerdict: 2 / 3, cutSpend: 250, medianDays: 2, medianSpend: 70 });
  assert.deepStrictEqual(out[1], { week: '2026-10-19', ads: 2, scale: 0, testing: 0, cut: 1, ungraded: 1, withVerdict: 0.5, cutSpend: 90, medianDays: 6, medianSpend: 70 });
  const sql = sb.scaleCutFlowSQL(RANGE);
  assert.ok(!/LIMIT 600/.test(sql), 'flow is not capped');
  assert.ok(sql.includes("ARRAY_AGG(IF(day_verdict IN ('Scale', 'Cut'), cum_spend, NULL) IGNORE NULLS"));
});

// 5. Older ads lens
test('older lens SQL: launched over 90 days before the end, spend in the last 14 days', () => {
  const { sb } = boot(CONFIG);
  const sql = sb.mapOlderSQL('2026-10-31');
  assert.ok(sql.includes("HAVING MIN(IF(spend > 0, date_start, NULL)) < DATE '2026-08-02'"), sql);
  assert.ok(sql.includes("BETWEEN DATE '2026-10-18' AND DATE '2026-10-31'"), sql);
  assert.ok(sql.includes("WHERE date_start <= DATE '2026-10-31'"));
  assert.ok(sql.includes(sb.confidenceVerdictSQL('recent_spend', 'recent_conv', 'SAFE_DIVIDE(life_spend, NULLIF(life_conv, 0))', { conf: 0.9 }) + " = 'Cut' AS wearing_out"));
  assert.ok(sql.includes('WHERE recent_spend > 0'));
  assert.strictEqual(sb.mapOlderSQL(''), null);
});
test('older lens view: wearing out vs holding up, no-conversion ads at the top edge', () => {
  const { sb } = boot(CONFIG);
  const v = sb.mapOlderView([
    { ad_name: 'worn', life_spend: 1000, life_conv: 20, recent_spend: 400, recent_conv: 2, wearing_out: true },
    { ad_name: 'fine', life_spend: 1000, life_conv: 20, recent_spend: 100, recent_conv: 2, wearing_out: false },
    { ad_name: 'dry', life_spend: 500, life_conv: 10, recent_spend: 50, recent_conv: 0, wearing_out: 'false' },
    { ad_name: 'nolife', life_spend: 500, life_conv: 0, recent_spend: 50, recent_conv: 0, wearing_out: false },
  ]);
  assert.strictEqual(v.pts.length, 3, 'ads with no lifetime conversions have no baseline to compare');
  assert.strictEqual(v.wearing, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(v.datasets.map((d) => d.label))), ['Wearing out', 'Holding up']);
  const worn = v.pts.find((p) => p._name === 'worn');
  assert.strictEqual(worn.yRaw, 400, 'recent $200 per conversion vs lifetime $50 is 400%');
  const fine = v.pts.find((p) => p._name === 'fine');
  assert.strictEqual(fine.y, 100);
  const dry = v.pts.find((p) => p._name === 'dry');
  assert.strictEqual(dry._noConv, true);
  assert.strictEqual(dry.y, v.yMax);
  assert.ok(v.yMax >= 200);
});
test('older lens is only on the Movement Map when CONFIDENCE_LINES is set', () => {
  const plain = boot(null), conf = boot(CONFIG);
  assert.strictEqual(plain.sb.mapLensHTML(), '');
  const h = conf.sb.mapLensHTML();
  assert.ok(h.includes('<option value="all" selected>All ads</option>') && h.includes('<option value="older">Older ads (launched over 90 days ago)</option>'));
});

// Removals and no-config
test('removed: reach window select, Show names list, At these targets line', () => {
  const { run } = boot(CONFIG);
  const html = run('scaleCutPanelHTML()');
  ['sc-reach-window', 'Reach window', 'sc-baseline-verdicts', 'At these targets', 'Show names', 'sc-reach-missing-list'].forEach((s) => assert.ok(!html.includes(s), s));
  assert.strictEqual(run('typeof toggleConfidenceReachMissing'), 'undefined');
  assert.strictEqual(run('confidenceReachWindow()'), 'lifetime');
});
test('kept: baseline panel, y-axis toggle and the verdict logic', () => {
  const { sb, run } = boot(CONFIG);
  const html = run('scaleCutPanelHTML()');
  ['id="sc-baseline-controls"', 'id="sc-baseline-body"', 'id="cl-y-mode"'].forEach((s) => assert.ok(html.includes(s), s));
  assert.ok(sb.scaleCutSQL(RANGE).includes('per_ad_conf'));
});
test('no CONFIDENCE_LINES: no Scale & Cut SQL, panel or lens', () => {
  const { sb, run } = boot(null);
  assert.strictEqual(sb.scaleCutSQL(RANGE), null);
  assert.strictEqual(sb.scaleCutPlaybackSQL(RANGE), null);
  assert.strictEqual(sb.scaleCutFlowSQL(RANGE), null);
  assert.strictEqual(run('scaleCutPanelHTML()'), '');
  assert.strictEqual(run('scaleCutNavHTML()'), '');
});
test('no em or en dashes in the round 2 code or its output', () => {
  // Older dashes elsewhere in these files predate round 2 and show on other
  // dashboards, so only the round 2 functions and markup are checked.
  const DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  const { sb, run } = boot(CONFIG);
  const fns = ['scaleCutLaunchRange', 'scaleCutSQL', 'scaleCutDailyCTE', 'scaleCutPlaybackSQL', 'scaleCutFlowSQL',
    'confidenceIsLive', 'scaleCutMismatch', 'confidenceStatusText', 'scaleCutHistoryIndex', 'scaleCutFrameRows',
    'setupScaleCutPlay', 'scaleCutFlowRows', 'renderScaleCutFlow', 'loadScaleCutHistory',
    'mapOlderSQL', 'mapOlderView', 'renderMapOlder', 'mapLensHTML', 'scaleCutPanelHTML'];
  fns.forEach((f) => {
    assert.strictEqual(typeof sb[f], 'function', f);
    assert.ok(!DASH.test(sb[f].toString()), f);
  });
  assert.ok(!DASH.test(run('scaleCutPanelHTML()') + sb.mapLensHTML()), 'panel markup');
  assert.ok(!DASH.test(read('test/scale-cut-round2.test.js')), 'this test file');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
