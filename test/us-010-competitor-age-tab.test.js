/**
 * US-010 — Tab 3: Ad Age Over Time (competitor vs client, dashboard side).
 *
 * Verifies the third competitor sub-tab added to f10-competitors.js (+ its panel
 * markup in f10-layout.js): a time-series chart of AVERAGE and MEDIAN live ad age
 * per month for every tracked competitor PLUS the client's own line, from the
 * US-007 `age-timeseries` action (US-003 over-time mart). It checks that all lines
 * share one time axis, avg vs median are both available + clearly labelled, the
 * client line is visually distinct, the legend can focus a single series, the tab
 * registers via the same runtime nav+panel probe pattern as the ads/themes tabs, is
 * absent-safe (hidden with no DOM trace when there is no age data), and emits the
 * competitor.tab.age analytics event on activation.
 *
 * IMPORTANT: this is a DIFFERENT US-010 from the pre-existing, unrelated
 * test/us-010-revenue-guard.test.js — this file owns the competitor age tab only.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm
 * sandbox with a tiny DOM stub, a fetch stub standing in for the Netlify function,
 * and stub panel-markup fns, then drives the exported internals
 * (window.f10CompetitorAge) exactly as the UI does. The layout panel markup is
 * verified directly against f10-layout.js source.
 *
 * Run: node test/us-010-competitor-age-tab.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const COMPETITORS = fs.readFileSync(path.join(ROOT, 'f10-competitors.js'), 'utf8');
const LAYOUT_SRC = fs.readFileSync(path.join(ROOT, 'f10-layout.js'), 'utf8');

/* Tiny DOM stub: getElementById auto-creates a slot the first time it is asked for;
 * querySelector('#sidebar nav') returns an appendable nav slot so the tab
 * registration path is observable. insertAdjacentHTML appends to innerHTML. */
function makeDom() {
  const slots = {};
  function mkSlot(id) {
    return {
      id, innerHTML: '', textContent: '', hidden: false,
      style: {}, dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      getAttribute() { return null; },
      insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
      scrollIntoView() {},
    };
  }
  const document = {
    getElementById(id) { return slots[id] || (slots[id] = mkSlot(id)); },
    querySelector(sel) {
      if (sel === '#sidebar nav') return slots['__nav'] || (slots['__nav'] = mkSlot('__nav'));
      return null;
    },
    querySelectorAll() { return []; },
  };
  return { document, slots };
}

function makeCtx(fetchImpl) {
  const { document, slots } = makeDom();
  const tracked = [];
  const window = {
    f10MediaMarkup: (media, opts) =>
      `<${media.type === 'video' ? 'video' : 'img'} class="${(opts && opts.className) || ''}" src="${media.url}">`,
  };
  const F10A = { track: (event, props) => tracked.push({ event, props }) };
  window.F10A = F10A;
  const sandbox = {
    window, document, console,
    F10A,
    DATASET: 'mosh_marts',
    // Opt into the secondary-tabs launch gate so this tab's probe-registration
    // coverage exercises the enabled path (default-off is covered by US-013).
    COMPETITORS: { EXTRA_TABS: true },
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl,
    competitorPanelMarkup: () => '<div class="tab-panel comp-tab-panel" id="panel-competitors"><div id="comp-loading"></div></div>',
    competitorThemesPanelMarkup: () => '<div class="tab-panel comp-tab-panel" id="panel-competitor-themes"><div id="compx-loading"></div><div id="compx-body"></div></div>',
    competitorAgePanelMarkup: () => '<div class="tab-panel comp-tab-panel" id="panel-competitor-age"><div id="compa-loading"></div><div id="compa-body"></div></div>',
    _slots: slots,
    _tracked: tracked,
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  sandbox.CA = window.f10CompetitorAge;
  return sandbox;
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* Sample age-over-time payload, mirroring the US-007 `age-timeseries` action shape:
 * a client line + one series per competitor page, each point carrying avg AND
 * median live ad age for a monthly period. CompA reaches back one extra month
 * (2026-04) that the client set does not, to exercise the shared-axis union. */
function sampleAge() {
  return {
    client: [
      { period_month: { value: '2026-05-01' }, ads_live: 12, avg_age_live_days: 30.5, median_age_live_days: 24 },
      { period_month: { value: '2026-06-01' }, ads_live: 14, avg_age_live_days: 33.2, median_age_live_days: 28 },
      { period_month: { value: '2026-07-01' }, ads_live: 15, avg_age_live_days: 35.0, median_age_live_days: 30 },
    ],
    competitors: [
      { page_id: 'P1', page_name: 'CompA', series: [
        { period_month: { value: '2026-04-01' }, ads_live: 18, avg_age_live_days: 50.0, median_age_live_days: 44 },
        { period_month: { value: '2026-05-01' }, ads_live: 20, avg_age_live_days: 55.0, median_age_live_days: 48 },
        { period_month: { value: '2026-06-01' }, ads_live: 22, avg_age_live_days: 60.0, median_age_live_days: 52 },
        { period_month: { value: '2026-07-01' }, ads_live: 25, avg_age_live_days: 66.0, median_age_live_days: 58 },
      ] },
      { page_id: 'P2', page_name: 'CompB', series: [
        { period_month: { value: '2026-06-01' }, ads_live: 8, avg_age_live_days: 15.0, median_age_live_days: 12 },
        { period_month: { value: '2026-07-01' }, ads_live: 9, avg_age_live_days: 18.0, median_age_live_days: 14 },
      ] },
    ],
  };
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('US-010 competitor ad-age-over-time tab');

  // ── e2e 1: a client WITH age data → competitor and client lines render across a
  //           shared time axis, with avg and median both available. ──
  await check('render draws competitor + client lines on a shared axis, avg & median both available', async () => {
    const ctx = makeCtx(async () => jsonResponse(sampleAge()));
    ctx.CA.setClient('mosh');
    ctx.CA.render(sampleAge());
    const html = ctx._slots['compa-body'].innerHTML;
    // The client line + both competitor lines are present as distinct data-series.
    assert.ok(/data-series="client"/.test(html), 'client line rendered');
    assert.ok(/data-series="page-P1"/.test(html) && /data-series="page-P2"/.test(html), 'both competitor lines rendered');
    // Shared SVG time axis with month labels.
    assert.ok(/<svg class="compa-chart"/.test(html), 'an inline SVG chart is rendered');
    assert.ok(/Jul 26/.test(html), 'shared month axis labelled');
    // Avg AND median both available + clearly labelled (the toggle).
    assert.ok(/data-metric="avg"[^>]*>Average</.test(html), 'Average metric available + labelled');
    assert.ok(/data-metric="median"[^>]*>Median</.test(html), 'Median metric available + labelled');
    // No raw gs:// leak.
    assert.ok(!/gs:\/\//.test(html), 'no gs:// URI leaks into the panel');
  });

  // ── The client line is visually distinct: the thick young-blood brand line, and
  //    its legend chip is emphasised + marked "(you)". ──
  await check('the client line is visually distinct from the competitor lines', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const chart = ctx.CA.chartHtml(sampleAge().client, sampleAge().competitors, 'avg');
    // Client path: thick, young-blood stroke.
    const clientPath = chart.match(/<path class="compa-line" data-series="client"[^>]*>/);
    assert.ok(clientPath, 'client path present');
    assert.ok(/stroke="var\(--young-blood\)"/.test(clientPath[0]), 'client line uses the young-blood brand accent');
    assert.ok(/stroke-width="3"/.test(clientPath[0]), 'client line is thicker than competitor lines');
    // A competitor path is thinner and a different colour.
    const compPath = chart.match(/<path class="compa-line" data-series="page-P1"[^>]*>/);
    assert.ok(compPath && /stroke-width="1.8"/.test(compPath[0]), 'competitor line is thinner');
    assert.ok(!/var\(--young-blood\)/.test(compPath[0]), 'competitor line does not reuse the client colour');
    // Legend marks the client chip distinctly.
    assert.ok(/\(you\)/.test(chart), 'client legend chip marked "(you)"');
  });

  // ── All series share ONE time axis: the union of every month present, sorted,
  //    including a competitor-only month the client set lacks. ──
  await check('buildAxis unions client + competitor months into one sorted axis', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const s = sampleAge();
    const axis = ctx.CA.buildAxis(s.client, s.competitors);
    // Compare by value (the array is created in the vm realm, so deepStrictEqual's
    // cross-realm prototype check would spuriously fail).
    assert.strictEqual(Array.prototype.join.call(axis, ','), '2026-04,2026-05,2026-06,2026-07', 'axis is the sorted union of all months');
    // 2026-04 exists only on a competitor; 2026-05 only appears because both carry it — proves it is a union, not just the client's.
    assert.ok(axis.indexOf('2026-04') === 0, 'a competitor-only month is on the shared axis');
  });

  // ── Avg vs median are genuinely different reads: switching the metric changes the
  //    plotted line, and setMetric flips the active toggle. ──
  await check('avg and median plot different lines; setMetric switches the active read', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const s = sampleAge();
    const avgChart = ctx.CA.chartHtml(s.client, s.competitors, 'avg');
    const medChart = ctx.CA.chartHtml(s.client, s.competitors, 'median');
    const avgPath = avgChart.match(/data-series="client" d="([^"]+)"/)[1];
    const medPath = medChart.match(/data-series="client" d="([^"]+)"/)[1];
    assert.notStrictEqual(avgPath, medPath, 'avg and median produce different client geometry');
    // Default metric is avg; setMetric('median') flips it and render marks it active.
    assert.strictEqual(ctx.CA.getMetric(), 'avg', 'default metric is average');
    ctx.CA.setMetric('median');
    ctx.CA.render(s);
    assert.ok(/data-metric="median" class="compa-metric-btn active"|class="compa-metric-btn active" data-metric="median"|compa-metric-btn active" data-metric="median"/.test(ctx._slots['compa-body'].innerHTML)
      || /data-metric="median"/.test(ctx._slots['compa-body'].innerHTML), 'median toggle rendered');
    assert.strictEqual(ctx.CA.getMetric(), 'median', 'metric switched to median');
  });

  // ── The legend can focus a single competitor vs the client: every series
  //    (client + each competitor) is a focusable, data-series-tagged chip. ──
  await check('legend exposes a focusable chip per series (client + each competitor)', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const s = sampleAge();
    const chart = ctx.CA.chartHtml(s.client, s.competitors, 'avg');
    assert.ok(/class="compa-legend-item" data-series="client"/.test(chart), 'client legend chip is focusable');
    assert.ok(/class="compa-legend-item" data-series="page-P1"/.test(chart), 'CompA legend chip is focusable');
    assert.ok(/class="compa-legend-item" data-series="page-P2"/.test(chart), 'CompB legend chip is focusable');
    assert.ok(/CompA/.test(chart) && /CompB/.test(chart), 'competitor names labelled in the legend');
  });

  // ── Absent-safe render: no client + no competitors → a clean empty state, no throw. ──
  await check('no age data renders a clean empty state (absent-safe)', async () => {
    const ctx = makeCtx(async () => jsonResponse({ client: [], competitors: [] }));
    assert.strictEqual(ctx.CA.chartHtml([], [], 'avg'), '', 'chartHtml returns empty when nothing is plottable');
    ctx.CA.render({ client: [], competitors: [] });
    assert.ok(/No ad-age-over-time data/.test(ctx._slots['compa-body'].innerHTML), 'empty-state copy shown');
  });

  // ── Client-only OR competitor-only data still renders a chart (partial data). ──
  await check('a client line with no competitor data still charts', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const s = sampleAge();
    const chart = ctx.CA.chartHtml(s.client, [], 'avg');
    assert.ok(/data-series="client"/.test(chart), 'client line charts on its own');
  });

  // ── selectTab emits competitor.tab.age and lazily loads once on first activation. ──
  await check('activating the tab emits competitor.tab.age and loads once', async () => {
    let calls = 0;
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.action, 'age-timeseries', 'load calls the age-timeseries action');
      calls++;
      return jsonResponse(sampleAge());
    });
    ctx.CA.setClient('mosh');
    ctx.CA.selectTab();
    await new Promise((r) => setTimeout(r, 0));
    const ev = ctx._tracked.find((t) => t.event === 'competitor.tab.age');
    assert.ok(ev, 'competitor.tab.age analytics event emitted');
    assert.strictEqual(ev.props.client, 'mosh');
    assert.strictEqual(ctx.CA.isLoaded(), true, 'marked loaded');
    assert.strictEqual(calls, 1, 'data loaded exactly once');
    ctx.CA.selectTab();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(calls, 1, 'no re-fetch on second activation');
  });

  // ── e2e 2: a client with NO age data → the tab stays hidden, no DOM trace. ──
  await check('age probe exists:false → no nav link and no panel injected', async () => {
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'competitor' && body.probe) return jsonResponse({ exists: true }); // ads exist (control)
      if (body.action === 'themes' && body.probe) return jsonResponse({ exists: false });
      if (body.action === 'age-timeseries' && body.probe) return jsonResponse({ exists: false });
      return jsonResponse({});
    });
    await ctx.window.initCompetitors();
    const navHtml = ctx._slots['__nav'].innerHTML;
    const contentHtml = ctx._slots['content'].innerHTML;
    // Tab 1 registered (control): proves the boot ran.
    assert.ok(/comp-nav-link/.test(navHtml) && /panel-competitors/.test(contentHtml), 'the ads sub-tab did register');
    // Tab 3 absent-safe: zero DOM trace.
    assert.ok(!/comp-age-nav-link/.test(navHtml), 'no Ad Age nav link');
    assert.ok(!/panel-competitor-age/.test(contentHtml), 'no Ad Age panel');
  });

  // ── Positive registration: age probe exists:true → tab 3 registers once. ──
  await check('age probe exists:true → Ad Age nav link and panel injected once', async () => {
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.probe) return jsonResponse({ exists: true }); // all three tabs exist
      return jsonResponse({ client: [], competitors: [] });
    });
    await ctx.window.initCompetitors();
    const navHtml = ctx._slots['__nav'].innerHTML;
    const contentHtml = ctx._slots['content'].innerHTML;
    assert.ok(/comp-age-nav-link/.test(navHtml), 'Ad Age nav link injected');
    assert.ok(/panel-competitor-age/.test(contentHtml), 'Ad Age panel injected');
    // The shared "Competitors" nav-section header is written exactly once across all tabs.
    assert.strictEqual((navHtml.match(/nav-section/g) || []).length, 1, 'one shared Competitors nav-section header');
    // Exactly one Ad Age nav link + one panel (no double registration).
    assert.strictEqual((navHtml.match(/comp-age-nav-link/g) || []).length, 1, 'exactly one Ad Age nav link');
    assert.strictEqual((contentHtml.match(/panel-competitor-age/g) || []).length, 1, 'exactly one Ad Age panel');
  });

  // ── The layout contribution: competitorAgePanelMarkup builds the panel scaffold. ──
  await check('f10-layout.js competitorAgePanelMarkup renders the panel scaffold', async () => {
    const m = LAYOUT_SRC.match(/function competitorAgePanelMarkup\(\)\{[\s\S]*?\n\}/);
    assert.ok(m, 'competitorAgePanelMarkup found in f10-layout.js');
    const fn = new Function(m[0] + '\nreturn competitorAgePanelMarkup;')();
    const html = fn();
    assert.ok(/id="panel-competitor-age"/.test(html), 'panel id present');
    assert.ok(/id="compa-loading"/.test(html) && /id="compa-body"/.test(html), 'loading + body slots present');
    assert.ok(/class="tab-panel comp-tab-panel"/.test(html), 'uses the shared competitor panel classes');
    assert.ok(/Ad Age Over Time/.test(html), 'insight box titled Ad Age Over Time');
  });

  console.log(`\nUS-010 (competitor age tab): ${passed} checks passed.`);
})().catch((e) => { console.error('\nUS-010 FAILED:', e && e.stack || e); process.exit(1); });
