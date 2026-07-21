/**
 * US-011 — Tab 4: Meta Maturity Score (+ leaderboard, cadence, net-new).
 *
 * Verifies the fourth competitor sub-tab added to f10-competitors.js (+ its panel
 * markup in f10-layout.js): an explainable 0-100 Meta maturity score that ranks every
 * tracked competitor AND the client, from the US-007 `maturity` action
 * (competitor_meta_maturity mart). It checks that competitors + the client are ranked
 * high-to-low by score with the client's row highlighted and its rank shown, that the
 * composite is shown ALONGSIDE all six labelled component sub-scores (the explainable
 * breakdown — insight-ladder-l4-l5-gate), that the data-owned maturity_tier is rendered
 * verbatim and never re-banded in the frontend (hq-classifier-own-labels-single-source),
 * that the same panel surfaces the longevity leaderboard (`leaderboard`), the refresh
 * cadence + net-new alerts (`net-new`), that the tab registers via the same runtime
 * nav+panel probe pattern as the ads/themes/age tabs, is absent-safe (hidden with no
 * DOM trace when there is no maturity data), and emits competitor.tab.maturity on
 * activation.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm sandbox
 * with a tiny DOM stub, a fetch stub standing in for the Netlify function, and stub
 * panel-markup fns, then drives the exported internals (window.f10CompetitorMaturity)
 * exactly as the UI does. The layout panel markup is verified directly against
 * f10-layout.js source.
 *
 * Run: node test/us-011-maturity-tab.test.js
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
    competitorMaturityPanelMarkup: () => '<div class="tab-panel comp-tab-panel" id="panel-competitor-maturity"><div id="compm-loading"></div><div id="compm-body"></div></div>',
    _slots: slots,
    _tracked: tracked,
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  sandbox.CM = window.f10CompetitorMaturity;
  return sandbox;
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* Sample maturity payload, mirroring the US-007 `maturity` action shape: a client row
 * + one row per competitor, each carrying the composite score, the data-owned
 * maturity_tier + maturity_rank, and all six component sub-scores. The set is CompA
 * (rank 1, Leading, 82.4), the client (rank 2, Developing, 55.1), CompC (rank 3,
 * Emerging, 40.0) — so the client ranks #2 of 3 and its row sits between the two. */
function sampleMaturity() {
  const subs = (a, b, c, d, e, f) => ({
    longevity: a, cadence: b, volume: c, active_ratio: d, format_diversity: e, platform_spread: f,
  });
  return {
    client: {
      entity_type: 'client', entity_id: 'mosh', page_id: 'PC', page_name: 'Mosh',
      composite_score: 55.1, maturity_tier: 'Developing', maturity_rank: 2, set_size: 3,
      sub_scores: subs(50, 60, 45, 70, 40, 66),
      raw_signals: { volume: 12, longevity: 30, active_ratio: 0.7, cadence: 4, format: 3, platform: 2 },
    },
    competitors: [
      {
        entity_type: 'competitor', entity_id: 'P1', page_id: 'P1', page_name: 'CompA',
        composite_score: 82.4, maturity_tier: 'Leading', maturity_rank: 1, set_size: 3,
        sub_scores: subs(90, 85, 80, 88, 75, 76),
        raw_signals: { volume: 40, longevity: 120, active_ratio: 0.9, cadence: 8, format: 5, platform: 3 },
      },
      {
        entity_type: 'competitor', entity_id: 'P3', page_id: 'P3', page_name: 'CompC',
        composite_score: 40.0, maturity_tier: 'Emerging', maturity_rank: 3, set_size: 3,
        sub_scores: subs(30, 35, 28, 50, 20, 44),
        raw_signals: { volume: 6, longevity: 15, active_ratio: 0.5, cadence: 1, format: 1, platform: 1 },
      },
    ],
    set_size: 3,
  };
}

function sampleLeaderboard() {
  return {
    ads: [
      { rank: 1, ad_archive_id: 'A1', page_id: 'P1', page_name: 'CompA', display_format: 'video', snapshot_url: 'https://www.facebook.com/ads/library/?id=A1', first_seen_date: { value: '2026-01-01' }, days_active_observed: 180, live_age_days: 197 },
      { rank: 2, ad_archive_id: 'A2', page_id: 'P3', page_name: 'CompC', display_format: 'image', snapshot_url: 'https://www.facebook.com/ads/library/?id=A2', first_seen_date: { value: '2026-03-01' }, days_active_observed: 90, live_age_days: 120 },
    ],
  };
}

function sampleNetNew() {
  return {
    ads: [
      { ad_archive_id: 'N1', page_id: 'P1', page_name: 'CompA', first_seen_date: { value: '2026-07-12' }, last_seen_date: { value: '2026-07-16' }, window_start_date: { value: '2026-07-10' }, window_end_date: { value: '2026-07-16' } },
    ],
    byPage: [
      { page_id: 'P1', page_name: 'CompA', ads_total: 12, net_new_count: 3, window_start_date: { value: '2026-07-10' }, window_end_date: { value: '2026-07-16' } },
      { page_id: 'P3', page_name: 'CompC', ads_total: 8, net_new_count: 0, window_start_date: { value: '2026-07-10' }, window_end_date: { value: '2026-07-16' } },
    ],
    window: { start: { value: '2026-07-10' }, end: { value: '2026-07-16' } },
  };
}

function fullData() {
  return { maturity: sampleMaturity(), leaderboard: sampleLeaderboard(), netnew: sampleNetNew() };
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('US-011 competitor Meta maturity tab');

  // ── e2e 1: with maturity data → competitors ranked by score with component
  //           breakdowns and the client's rank highlighted. ──
  await check('render ranks the set high-to-low with component breakdowns and the client highlighted', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    ctx.CM.setClient('mosh');
    ctx.CM.render(fullData());
    const html = ctx._slots['compm-body'].innerHTML;
    // Every entity in the set has a row (both competitors + the client).
    assert.ok(/data-entity="page-P1"/.test(html), 'CompA row rendered');
    assert.ok(/data-entity="page-P3"/.test(html), 'CompC row rendered');
    assert.ok(/data-entity="client"/.test(html), 'client row rendered');
    // Ranked high-to-low: CompA (rank1) before the client (rank2) before CompC (rank3).
    const iA = html.indexOf('data-entity="page-P1"');
    const iClient = html.indexOf('data-entity="client"');
    const iC = html.indexOf('data-entity="page-P3"');
    assert.ok(iA < iClient && iClient < iC, 'rows are ordered by maturity rank (CompA, you, CompC)');
    // Composite score is shown (not hidden) — CompA 82.4, client 55.1.
    assert.ok(/82\.4/.test(html) && /55\.1/.test(html), 'composite scores are surfaced');
    // The client row is highlighted + marked "(you)".
    assert.ok(/\(you\)/.test(html), 'the client row is marked "(you)"');
    assert.ok(/border:2px solid var\(--young-blood\)/.test(html), 'the client row is highlighted with the brand accent');
    // No raw gs:// leak anywhere in the panel.
    assert.ok(!/gs:\/\//.test(html), 'no gs:// URI leaks into the panel');
  });

  // ── The score is explainable: all six component sub-scores are present + labelled
  //    so a user can see what drives a high/low score (insight-ladder). ──
  await check('all six component sub-scores are rendered and labelled (explainable breakdown)', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const row = ctx.CM.scoreRowHtml(Object.assign({ __isClient: false }, sampleMaturity().competitors[0]));
    for (const label of ['Longevity', 'Cadence', 'Volume', 'Active ratio', 'Format diversity', 'Platform spread']) {
      assert.ok(row.indexOf(label) !== -1, `component labelled: ${label}`);
    }
    // Each component has a data-comp bar so the breakdown is machine-addressable too.
    for (const key of ['longevity', 'cadence', 'volume', 'active_ratio', 'format_diversity', 'platform_spread']) {
      assert.ok(new RegExp(`data-comp="${key}"`).test(row), `component bar present: ${key}`);
    }
    // The composite is shown ALONGSIDE the components, not instead of them.
    assert.ok(/compm-score/.test(row) && /82\.4/.test(row), 'composite shown beside the component bars');
    // Exactly six component keys exported for the tab.
    assert.strictEqual(ctx.CM.components.length, 6, 'six components defined');
  });

  // ── The client's rank + tier headline: the "so what" before the "why". ──
  await check('the client rank + tier headline shows rank of set and the data tier', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const m = sampleMaturity();
    const head = ctx.CM.rankHeadlineHtml(m.client, m.set_size);
    assert.ok(/#2/.test(head), "client's rank shown");
    assert.ok(/of 3/.test(head), 'rank shown out of the set size');
    assert.ok(/Developing/.test(head), 'the data-owned tier is shown in the headline');
  });

  // ── hq-classifier-own-labels-single-source: the tier is rendered verbatim from the
  //    data layer and NEVER recomputed/re-banded from the composite in the frontend. ──
  await check('the maturity tier is rendered verbatim, never re-banded from the score', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    // A deliberately mismatched pair: a LOW composite but a data-owned tier of 'Leading'.
    // If the frontend re-banded from the score it would show something other than 'Leading'.
    const badge = ctx.CM.tierBadge('Leading');
    assert.ok(/data-tier="Leading"/.test(badge) && />Leading</.test(badge), 'tier label passed through verbatim');
    const row = ctx.CM.scoreRowHtml({ __isClient: false, page_name: 'CompX', composite_score: 3.0, maturity_tier: 'Leading', maturity_rank: 9, sub_scores: {} });
    assert.ok(/>Leading</.test(row), 'low score still shows the data tier (not recomputed)');
    // An arbitrary/unknown tier string is also passed through (proves pure passthrough).
    assert.ok(/>Custom Tier</.test(ctx.CM.tierBadge('Custom Tier')), 'unknown tier string rendered verbatim');
  });

  // ── The longevity leaderboard: live ads ranked by age, public snapshot_url only. ──
  await check('the longevity leaderboard ranks live ads by age with public links only', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const html = ctx.CM.leaderboardHtml(sampleLeaderboard().ads);
    assert.ok(/#1/.test(html) && /CompA/.test(html), 'top ad ranked #1');
    assert.ok(/197d/.test(html), 'live age rendered in days');
    assert.ok(/facebook\.com\/ads\/library/.test(html), 'public Ad Library snapshot link rendered');
    // A gs:// URI is never turned into a link.
    const guarded = ctx.CM.leaderboardHtml([{ rank: 1, page_name: 'X', display_format: 'video', snapshot_url: 'gs://bucket/x.mp4', live_age_days: 10 }]);
    assert.ok(!/href="gs:\/\//.test(guarded), 'a gs:// URI is never linked');
    // Absent-safe empty state.
    assert.ok(/No live competitor ads/.test(ctx.CM.leaderboardHtml([])), 'empty leaderboard shows a clean empty state');
  });

  // ── Refresh cadence + net-new alerts, from the net-new action. ──
  await check('the cadence + net-new section shows per-competitor counts, the window, and an alert', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    const html = ctx.CM.netNewHtml(sampleNetNew());
    assert.ok(/3 brand-new competitor ads this period/.test(html), 'net-new alert totals the new ads');
    assert.ok(/CompA/.test(html) && /CompC/.test(html), 'per-competitor cadence rows rendered');
    assert.ok(/2026-07-10/.test(html) && /2026-07-16/.test(html), 'the net-new window is shown');
    // Absent-safe: no new ads at all → clean empty state.
    assert.ok(/No net-new competitor ads/.test(ctx.CM.netNewHtml({ ads: [], byPage: [] })), 'empty net-new shows a clean empty state');
    // Zero-count competitor is shown as 0, not dropped.
    assert.ok(/CompC/.test(html), 'a zero-net-new competitor is still listed');
  });

  // ── Absent-safe render: no maturity data → a clean empty state, no throw. ──
  await check('no maturity data renders a clean empty state (absent-safe)', async () => {
    const ctx = makeCtx(async () => jsonResponse({}));
    ctx.CM.render({ maturity: { client: null, competitors: [] }, leaderboard: { ads: [] }, netnew: { ads: [], byPage: [] } });
    assert.ok(/No Meta maturity score/.test(ctx._slots['compm-body'].innerHTML), 'empty-state copy shown');
  });

  // ── selectTab emits competitor.tab.maturity and lazily loads (all three actions)
  //    once on first activation. ──
  await check('activating the tab emits competitor.tab.maturity and loads once', async () => {
    const calls = { maturity: 0, leaderboard: 0, 'net-new': 0 };
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'maturity') { calls.maturity++; return jsonResponse(sampleMaturity()); }
      if (body.action === 'leaderboard') { calls.leaderboard++; return jsonResponse(sampleLeaderboard()); }
      if (body.action === 'net-new') { calls['net-new']++; return jsonResponse(sampleNetNew()); }
      return jsonResponse({});
    });
    ctx.CM.setClient('mosh');
    ctx.CM.selectTab();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const ev = ctx._tracked.find((t) => t.event === 'competitor.tab.maturity');
    assert.ok(ev, 'competitor.tab.maturity analytics event emitted');
    assert.strictEqual(ev.props.client, 'mosh');
    assert.strictEqual(ctx.CM.isLoaded(), true, 'marked loaded');
    assert.strictEqual(calls.maturity, 1, 'maturity loaded exactly once');
    assert.strictEqual(calls.leaderboard, 1, 'leaderboard loaded exactly once');
    assert.strictEqual(calls['net-new'], 1, 'net-new loaded exactly once');
    // The rendered panel actually reflects the loaded data.
    assert.ok(/data-entity="client"/.test(ctx._slots['compm-body'].innerHTML), 'panel rendered from the loaded maturity data');
    ctx.CM.selectTab();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(calls.maturity, 1, 'no re-fetch on second activation');
  });

  // ── A secondary source (leaderboard) failing does not blank the tab; the maturity
  //    surface still renders and the failure is logged, never swallowed. ──
  await check('a leaderboard failure degrades to empty without blanking the maturity surface', async () => {
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'maturity') return jsonResponse(sampleMaturity());
      if (body.action === 'leaderboard') return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
      if (body.action === 'net-new') return jsonResponse(sampleNetNew());
      return jsonResponse({});
    });
    ctx.CM.setClient('mosh');
    ctx.CM.selectTab();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = ctx._slots['compm-body'].innerHTML;
    assert.ok(/data-entity="client"/.test(html), 'the maturity ranking still renders');
    assert.ok(/No live competitor ads/.test(html), 'the failed leaderboard degrades to its empty state');
  });

  // ── e2e 2: a client with NO maturity data → the tab stays hidden, no DOM trace. ──
  await check('maturity probe exists:false → no nav link and no panel injected', async () => {
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'competitor' && body.probe) return jsonResponse({ exists: true }); // ads exist (control)
      if (body.action === 'themes' && body.probe) return jsonResponse({ exists: false });
      if (body.action === 'age-timeseries' && body.probe) return jsonResponse({ exists: false });
      if (body.action === 'maturity' && body.probe) return jsonResponse({ exists: false });
      return jsonResponse({});
    });
    await ctx.window.initCompetitors();
    const navHtml = ctx._slots['__nav'].innerHTML;
    const contentHtml = ctx._slots['content'].innerHTML;
    // Tab 1 registered (control): proves the boot ran.
    assert.ok(/comp-nav-link/.test(navHtml) && /panel-competitors/.test(contentHtml), 'the ads sub-tab did register');
    // Tab 4 absent-safe: zero DOM trace.
    assert.ok(!/comp-maturity-nav-link/.test(navHtml), 'no Meta Maturity nav link');
    assert.ok(!/panel-competitor-maturity/.test(contentHtml), 'no Meta Maturity panel');
  });

  // ── Positive registration: maturity probe exists:true → tab 4 registers once. ──
  await check('maturity probe exists:true → Meta Maturity nav link and panel injected once', async () => {
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.probe) return jsonResponse({ exists: true }); // all four tabs exist
      return jsonResponse({ client: null, competitors: [] });
    });
    await ctx.window.initCompetitors();
    const navHtml = ctx._slots['__nav'].innerHTML;
    const contentHtml = ctx._slots['content'].innerHTML;
    assert.ok(/comp-maturity-nav-link/.test(navHtml), 'Meta Maturity nav link injected');
    assert.ok(/panel-competitor-maturity/.test(contentHtml), 'Meta Maturity panel injected');
    // The shared "Competitors" nav-section header is written exactly once across all tabs.
    assert.strictEqual((navHtml.match(/nav-section/g) || []).length, 1, 'one shared Competitors nav-section header');
    // Exactly one Meta Maturity nav link + one panel (no double registration).
    assert.strictEqual((navHtml.match(/comp-maturity-nav-link/g) || []).length, 1, 'exactly one Meta Maturity nav link');
    assert.strictEqual((contentHtml.match(/panel-competitor-maturity/g) || []).length, 1, 'exactly one Meta Maturity panel');
  });

  // ── The layout contribution: competitorMaturityPanelMarkup builds the panel scaffold. ──
  await check('f10-layout.js competitorMaturityPanelMarkup renders the panel scaffold', async () => {
    const m = LAYOUT_SRC.match(/function competitorMaturityPanelMarkup\(\)\{[\s\S]*?\n\}/);
    assert.ok(m, 'competitorMaturityPanelMarkup found in f10-layout.js');
    const fn = new Function(m[0] + '\nreturn competitorMaturityPanelMarkup;')();
    const html = fn();
    assert.ok(/id="panel-competitor-maturity"/.test(html), 'panel id present');
    assert.ok(/id="compm-loading"/.test(html) && /id="compm-body"/.test(html), 'loading + body slots present');
    assert.ok(/class="tab-panel comp-tab-panel"/.test(html), 'uses the shared competitor panel classes');
    assert.ok(/Meta Maturity Score/.test(html), 'insight box titled Meta Maturity Score');
  });

  console.log(`\nUS-011 (competitor maturity tab): ${passed} checks passed.`);
})().catch((e) => { console.error('\nUS-011 FAILED:', e && e.stack || e); process.exit(1); });
