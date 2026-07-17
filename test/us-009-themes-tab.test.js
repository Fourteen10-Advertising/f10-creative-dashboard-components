/**
 * US-009 — Tab 2: Vision & Text Analysis (per-competitor themes, dashboard side).
 *
 * Verifies the second competitor sub-tab added to f10-competitors.js (+ its panel
 * markup in f10-layout.js): a per-competitor render of the US-007 `themes` action
 * that leads with the dominant angle/narrative + confidence (the "so what",
 * insight-ladder-l4-l5-gate), shows named vision themes and text/OCR phrases
 * visually distinguished but together, surfaces run_date freshness, registers via
 * the same runtime nav+panel injection pattern as the ads tab, is absent-safe
 * (hidden with no DOM trace when there is no theme data), and emits the
 * competitor.tab.themes analytics event on activation.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm
 * sandbox with a tiny DOM stub, a fetch stub standing in for the Netlify function,
 * and stub panel-markup fns, then drives the exported internals
 * (window.f10CompetitorThemes) exactly as the UI does. The layout panel markup is
 * verified directly against f10-layout.js source.
 *
 * Run: node test/us-009-themes-tab.test.js
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

/* Tiny DOM stub: getElementById auto-creates a slot the first time it is asked
 * for; querySelector('#sidebar nav') returns an appendable nav slot so the tab
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

/* Build a fresh sandbox with utils + competitors loaded and fetch/analytics/media
 * + stub panel-markup fns wired in. `fetchImpl` receives (url, opts). */
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
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl,
    // Stub panel-markup fns (the real ones live in f10-layout.js, verified
    // separately). Registration only needs them to be callable functions.
    competitorPanelMarkup: () => '<div class="tab-panel comp-tab-panel" id="panel-competitors"><div id="comp-loading"></div></div>',
    competitorThemesPanelMarkup: () => '<div class="tab-panel comp-tab-panel" id="panel-competitor-themes"><div id="compx-loading"></div><div id="compx-body"></div></div>',
    _slots: slots,
    _tracked: tracked,
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  sandbox.CT = window.f10CompetitorThemes;
  return sandbox;
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* Sample competitor theme summaries, mirroring the US-007 `themes` action shape. */
function sampleCompetitors() {
  return [
    {
      page_id: 'P1', page_name: 'CompA', run_date: { value: '2026-07-01' },
      themes: [
        { name: 'Menopause relief', description: 'symptom relief angle', type: 'vision', example_phrases: ['hot flush'] },
        { name: 'Doctor-backed', description: 'clinical authority framing', type: 'text', example_phrases: ['clinically proven'] },
      ],
      dominant_narrative: 'Leans hard on symptom-relief, doctor-backed framing to justify a premium price.',
      format_mix: { video: 8, image: 3 },
      common_phrases: ['clinically proven', 'as seen on'],
      analysis_confidence: 'high', vision_rows_summarised: 11, summary_model: 'gemini-2.5-pro',
    },
    {
      page_id: 'P2', page_name: 'CompB', run_date: { value: '2026-06-15' },
      themes: [{ name: 'Price-led', description: 'discount-driven', example_phrases: [] }],
      dominant_narrative: 'Almost entirely price-led — repeated discount hooks, little brand story.',
      format_mix: { image: 6 },
      common_phrases: ['50% off'],
      analysis_confidence: 'medium', vision_rows_summarised: 6, summary_model: 'gemini-2.5-pro',
    },
  ];
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('US-009 competitor vision & text (themes) tab');

  // ── e2e 1: a client WITH theme summaries → each competitor shows themes,
  //           narrative, and format mix (the core acceptance criterion). ──
  await check('render shows, per competitor, its narrative, themes, format mix and phrases', async () => {
    const ctx = makeCtx(async () => jsonResponse({ competitors: sampleCompetitors() }));
    ctx.CT.render(sampleCompetitors());
    const html = ctx._slots['compx-body'].innerHTML;

    // Both competitors present.
    assert.ok(/CompA/.test(html) && /CompB/.test(html), 'both competitor names rendered');
    // Named themes.
    assert.ok(/Menopause relief/.test(html) && /Doctor-backed/.test(html), 'named themes rendered');
    // Dominant narrative (the "so what").
    assert.ok(/doctor-backed framing to justify a premium price/.test(html), 'dominant narrative rendered');
    // Format mix (per competitor).
    assert.ok(/video <b>8<\/b>/.test(html) && /image <b>3<\/b>/.test(html), 'format mix counts rendered');
    // Common on-screen/copy phrases (text/OCR side).
    assert.ok(/clinically proven/.test(html) && /On-screen &amp; copy phrases/.test(html), 'text/OCR phrases block rendered');
    // Confidence + freshness surfaced.
    assert.ok(/High confidence/.test(html), 'analysis confidence surfaced');
    assert.ok(/as of/.test(html), 'run_date freshness surfaced');
    // No raw gs:// leak.
    assert.ok(!/gs:\/\//.test(html), 'no gs:// URI leaks into the panel');
  });

  // ── Insight-ladder: the narrative (the decision "so what") comes BEFORE the
  //    structured theme chips — not a bare tag list. ──
  await check('the dominant narrative is rendered ahead of the raw theme cards (L4/L5 order)', async () => {
    const ctx = makeCtx(async () => jsonResponse({ competitors: sampleCompetitors() }));
    const section = ctx.CT.themesSectionHtml(sampleCompetitors()[0]);
    const narrativeIdx = section.indexOf('compx-narrative');
    const themesIdx = section.indexOf('compx-themes');
    assert.ok(narrativeIdx > -1, 'narrative present');
    assert.ok(themesIdx > -1, 'theme cards present');
    assert.ok(narrativeIdx < themesIdx, 'narrative appears before the theme cards');
    // Confidence badge sits in the header, not buried.
    assert.ok(section.indexOf('confidence') < themesIdx, 'confidence surfaced up top');
  });

  // ── Vision themes and text themes are visually distinguished but shown together. ──
  await check('vision and text themes are badged distinctly within one section', async () => {
    const ctx = makeCtx(async () => jsonResponse({ competitors: [] }));
    const visionCard = ctx.CT.themeCardHtml({ name: 'V', description: 'd', type: 'vision', example_phrases: [] });
    const textCard = ctx.CT.themeCardHtml({ name: 'T', description: 'd', type: 'text', example_phrases: [] });
    assert.ok(/>vision</.test(visionCard), 'vision theme carries a vision badge');
    assert.ok(/>text</.test(textCard), 'text theme carries a text badge');
    // Distinct treatment: vision badge is solid young-blood, text badge is outlined.
    assert.ok(/var\(--young-blood\)/.test(visionCard), 'vision badge uses the young-blood accent');
    assert.ok(/border:1px solid var\(--paper-dark\)/.test(textCard), 'text badge is outlined');
    // A modality-less theme still renders (no badge, no throw).
    const plain = ctx.CT.themeCardHtml({ name: 'Plain', description: 'x' });
    assert.ok(/Plain/.test(plain) && !/>vision</.test(plain) && !/>text</.test(plain), 'plain theme renders without a badge');
  });

  // ── Confidence helper maps each level to an F10 accent. ──
  await check('confidence badge maps high/medium/low to distinct accents', async () => {
    const ctx = makeCtx(async () => jsonResponse({ competitors: [] }));
    assert.ok(/High confidence/.test(ctx.CT.confHtml('high')) && /var\(--good\)/.test(ctx.CT.confHtml('high')), 'high → good');
    assert.ok(/Medium confidence/.test(ctx.CT.confHtml('medium')) && /var\(--stabilo\)/.test(ctx.CT.confHtml('medium')), 'medium → stabilo');
    assert.ok(/Low confidence/.test(ctx.CT.confHtml('low')) && /var\(--stabilo-red\)/.test(ctx.CT.confHtml('low')), 'low → stabilo-red');
    assert.ok(/Unrated confidence/.test(ctx.CT.confHtml(null)), 'missing → Unrated');
  });

  // ── Empty competitors array → clean empty state, not an error. ──
  await check('no theme rows renders a clean empty state', async () => {
    const ctx = makeCtx(async () => jsonResponse({ competitors: [] }));
    ctx.CT.render([]);
    assert.ok(/No vision &amp; text theme summaries/.test(ctx._slots['compx-body'].innerHTML), 'empty-state copy shown');
  });

  // ── selectTab emits competitor.tab.themes and lazily loads on first activation. ──
  await check('activating the tab emits competitor.tab.themes and loads once', async () => {
    let calls = 0;
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.action, 'themes', 'load calls the themes action');
      calls++;
      return jsonResponse({ competitors: sampleCompetitors() });
    });
    ctx.CT.setClient('mosh');
    ctx.CT.selectTab();
    await new Promise((r) => setTimeout(r, 0)); // let the async load settle
    const ev = ctx._tracked.find((t) => t.event === 'competitor.tab.themes');
    assert.ok(ev, 'competitor.tab.themes analytics event emitted');
    assert.strictEqual(ev.props.client, 'mosh');
    assert.strictEqual(ctx.CT.isLoaded(), true, 'marked loaded');
    assert.strictEqual(calls, 1, 'data loaded exactly once');
    // Second activation must NOT re-fetch.
    ctx.CT.selectTab();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(calls, 1, 'no re-fetch on second activation');
  });

  // ── e2e 2: a client with NO theme data → the tab stays hidden, no DOM trace. ──
  await check('themes probe exists:false → no nav link and no panel injected', async () => {
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      // Ads exist (tab 1 registers) but themes do NOT (tab 2 must stay hidden).
      if (body.action === 'competitor' && body.probe) return jsonResponse({ exists: true });
      if (body.action === 'themes' && body.probe) return jsonResponse({ exists: false });
      return jsonResponse({});
    });
    await ctx.window.initCompetitors();
    const navHtml = ctx._slots['__nav'].innerHTML;
    const contentHtml = ctx._slots['content'].innerHTML;
    // Tab 1 registered (control): proves the boot ran.
    assert.ok(/comp-nav-link/.test(navHtml) && /panel-competitors/.test(contentHtml), 'the ads sub-tab did register');
    // Tab 2 absent-safe: zero DOM trace.
    assert.ok(!/comp-themes-nav-link/.test(navHtml), 'no Vision & Text nav link');
    assert.ok(!/panel-competitor-themes/.test(contentHtml), 'no Vision & Text panel');
  });

  // ── Positive registration: themes probe exists:true → tab 2 registers. ──
  await check('themes probe exists:true → Vision & Text nav link and panel injected once', async () => {
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.probe) return jsonResponse({ exists: true }); // both tabs exist
      return jsonResponse({ competitors: [] });
    });
    await ctx.window.initCompetitors();
    const navHtml = ctx._slots['__nav'].innerHTML;
    const contentHtml = ctx._slots['content'].innerHTML;
    assert.ok(/comp-themes-nav-link/.test(navHtml), 'Vision & Text nav link injected');
    assert.ok(/panel-competitor-themes/.test(contentHtml), 'Vision & Text panel injected');
    // The shared "Competitors" section header is written exactly once for both tabs.
    assert.strictEqual((navHtml.match(/nav-section/g) || []).length, 1, 'one shared Competitors nav-section header');
  });

  // ── The layout contribution: competitorThemesPanelMarkup builds the panel. ──
  await check('f10-layout.js competitorThemesPanelMarkup renders the panel scaffold', async () => {
    const m = LAYOUT_SRC.match(/function competitorThemesPanelMarkup\(\)\{[\s\S]*?\n\}/);
    assert.ok(m, 'competitorThemesPanelMarkup found in f10-layout.js');
    const fn = new Function(m[0] + '\nreturn competitorThemesPanelMarkup;')();
    const html = fn();
    assert.ok(/id="panel-competitor-themes"/.test(html), 'panel id present');
    assert.ok(/id="compx-loading"/.test(html) && /id="compx-body"/.test(html), 'loading + body slots present');
    assert.ok(/class="tab-panel comp-tab-panel"/.test(html), 'uses the shared competitor panel classes');
    assert.ok(/Vision &amp; Text Analysis/.test(html), 'insight box titled Vision & Text Analysis');
  });

  console.log(`\nUS-009: ${passed} checks passed.`);
})().catch((e) => { console.error('\nUS-009 FAILED:', e && e.stack || e); process.exit(1); });
