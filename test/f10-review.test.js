/**
 * US-007 - Interactive preview module (f10-review.js): discovery-gated, live-path safe.
 *
 * PART 1 (unit): loads the real f10-review.js into a vm sandbox with a tiny DOM stub and
 * a fetch stub / injectable store standing in for the Netlify bq function, and covers:
 *   - discovery-gated registration: the Review tab appears only when the backend
 *     list-bundles discovery returns at least one bundle for the client; an empty
 *     discovery and a discovery error both fail closed with zero DOM trace;
 *   - LIVE-PATH SAFETY: with no BQ_FUNCTION endpoint AND no injected store the module
 *     injects nothing AND never touches the network - strictly additive;
 *   - render: given faked list-bundles + generated-preview + coherence responses, each
 *     new ad renders with its preview image, coherence flags and held dimensions;
 *   - the generation-date filter lists the distinct dates newest-first, defaults to the
 *     most recent, and re-filters the visible bundles on change.
 *
 * PART 2 (live-path canary, functional DOM): boots the REAL base Meta engine (f10-weekly)
 * alongside the layout dispatcher (f10-layout) and the new module (f10-review), then
 * asserts every pre-existing tab still switches to exactly one visible panel after the
 * module registers, that the Review tab activates to exactly one panel through the single
 * generic dispatcher (two panels can never both be active), and that a client whose
 * discovery finds no bundles boots with the base nav completely unchanged (no Review nav
 * or panel).
 *
 * Dependency-free (no jsdom): the DOM stubs implement just enough for the real activation
 * code to run unchanged. Run: node test/f10-review.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UTILS = readSrc('f10-utils.js');
const WEEKLY = readSrc('f10-weekly.js');
const LAYOUT = readSrc('f10-layout.js');
const REVIEW = readSrc('f10-review.js');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }
function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* One discovered generated bundle, in the shape list-bundles returns (plus the fuller
 * component metadata a test store may echo). `date` is the generation date the tab groups
 * and filters on. */
function sampleBundle(overrides) {
  return Object.assign({
    bundle_id: 'brief_moshy_founder_ab12cd',
    platform: 'meta',
    date: '2026-08-20',
    label: 'Founder story - bold typographic',
    components: { hook_type: 'Founder story', format_canonical: 'Bold typographic' },
    coherence_flags: ['visual_style held for review'],
    held_dimensions: ['visual_style_canonical'],
    new_ad: { headline: 'Meet the founder', body: 'Why we built this' },
  }, overrides || {});
}

/* A representative coherence scorecard, per the roadmap #5 contract. */
function scorecard(verdict, overall) {
  return {
    found: true,
    overall_verdict: verdict,
    overall_score: overall,
    dimensions: {
      client_fit: { score: 0.9, verdict: 'pass', reason: 'on-brief audience' },
      component_fidelity: { score: 0.8, verdict: 'pass', reason: 'proven components', matched: 3, total: 4 },
      brand_compliance: { score: 0.85, verdict: 'pass', reason: 'palette + logo ok' },
    },
    flags: [],
  };
}

/* ========================================================================== *
 * PART 1 - unit coverage (tiny DOM stub)
 * ========================================================================== */

function makeTinyDom() {
  const slots = {};
  function mkSlot(id) {
    return {
      id, innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener() {}, getAttribute() { return null; },
      insertAdjacentHTML(_pos, html) { this.innerHTML += html; }, scrollIntoView() {},
    };
  }
  const document = {
    // Deliberately NO readyState / addEventListener: f10-review's autoBoot becomes a
    // no-op, so each test drives initReview() explicitly and deterministically.
    getElementById(id) { return slots[id] || (slots[id] = mkSlot(id)); },
    querySelector(sel) {
      if (sel === '#sidebar nav') return slots['__nav'] || (slots['__nav'] = mkSlot('__nav'));
      return null;
    },
    querySelectorAll() { return []; },
  };
  return { document, slots };
}

function makeUnitCtx(fetchImpl, reviewConfig, opts) {
  opts = opts || {};
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'moshy_marts',
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    _slots: slots,
  };
  // Live-path safety is now "no endpoint AND no injected store". opts.noBqFunction omits
  // BQ_FUNCTION so a test can exercise that no-op path.
  if (!opts.noBqFunction) sandbox.BQ_FUNCTION = 'https://fn.example/.netlify/functions/bq';
  if (reviewConfig !== undefined) sandbox.REVIEW = reviewConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(REVIEW, sandbox, { filename: 'f10-review.js' });
  return sandbox;
}

async function runUnit() {
  console.log('US-007 Creative Review tab - unit');

  // ── A preview image whose signed url failed to load degrades to the placeholder. ──
  await check('a preview image that fails to load is swapped for the placeholder (never a broken img)', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({}));
    const R = ctx.window.f10Review;
    let replaced = null;
    const parent = { replaceChild(nw, old) { replaced = { nw, old }; } };
    const img = {
      tagName: 'IMG', className: 'rev-img rev-card-thumb', parentNode: parent, _a: {},
      classList: { contains(c) { return 'rev-img rev-card-thumb'.split(' ').indexOf(c) >= 0; } },
      getAttribute(k) { return this._a[k] || null; },
    };
    const doc = { createElement() { return { _a: {}, setAttribute(k, v) { this._a[k] = v; } }; } };

    const ok = R.swapFailedPreviewImg(img, doc);
    assert.strictEqual(ok, true, 'it reports a swap');
    assert.ok(replaced && replaced.old === img, 'the failed img was replaced');
    assert.ok(/rev-img\b/.test(replaced.nw.className) && /rev-img-empty/.test(replaced.nw.className),
      'the placeholder keeps rev-img sizing and adds rev-img-empty');
    assert.strictEqual(replaced.nw.textContent, 'Preview not available', 'placeholder shows the copy');
    assert.strictEqual(replaced.nw._a['data-rev-fallback'], '1', 'placeholder is flagged so it never re-swaps');

    // A non-preview element (or a non-IMG) is left alone.
    assert.strictEqual(R.swapFailedPreviewImg({ tagName: 'DIV' }, doc), false, 'ignores non-img targets');
    const plain = { tagName: 'IMG', className: 'other', classList: { contains() { return false; } } };
    assert.strictEqual(R.swapFailedPreviewImg(plain, doc), false, 'ignores images that are not previews');
  });

  // ── A review-app context (BQ_FUNCTION + a REVIEW block) with >=1 discovered bundle registers. ──
  await check('a review-app context with >=1 discovered bundle registers the Review nav link + panel', async () => {
    let listBody = null;
    const ctx = makeUnitCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'list-bundles') { listBody = body; return jsonResponse({ bundles: [sampleBundle()] }); }
      return jsonResponse({});
    }, {});
    await ctx.window.initReview();
    assert.ok(listBody, 'the list-bundles discovery was called');
    assert.strictEqual(listBody.action, 'list-bundles', 'discovery uses the list-bundles action');
    assert.strictEqual(listBody.client, 'moshy', 'discovery scopes to the resolved client slug');
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(/review-nav-link/.test(nav), 'Review nav link injected');
    assert.ok(/nav-section">Creative Review/.test(nav), 'Creative Review nav section injected');
    assert.ok(/id="panel-review"/.test(content), 'Review panel injected');
    assert.ok(/class="tab-panel review-tab-panel"/.test(content), 'panel carries the shared tab-panel class');
  });

  // ── REGRESSION (chicken-and-egg): in a review-app context the tab ALWAYS registers, even
  //    when discovery finds NO bundles. Discovery no longer HIDES the tab; it decides only the
  //    inner state - here the friendly "No generated ads yet" empty state, never a blank page. ──
  await check('a review-app context with NO discovered bundles still registers the tab and shows the empty state', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({ bundles: [] }), {});
    await ctx.window.initReview();
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(/review-nav-link/.test(nav), 'Review nav link injected even with zero bundles');
    assert.ok(/id="panel-review"/.test(content), 'Review panel injected even with zero bundles');
    // Activating the tab renders the "No generated ads yet" empty state, never a blank panel.
    await ctx.window.f10Review.load();
    const bodyHtml = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    assert.ok(/No generated ads yet/.test(bodyHtml), 'the empty state is rendered when there are no bundles');
    assert.ok(/rev-empty/.test(bodyHtml), 'the empty state uses the rev-empty block');
  });

  // ── REGRESSION: in a review-app context a discovery error still registers the tab (never
  //    hides it), so a transient backend hiccup can never strand the operator on a blank page. ──
  await check('a discovery error in a review-app context still registers the tab', async () => {
    const ctx = makeUnitCtx(async () => { throw new Error('endpoint 500'); }, {});
    await ctx.window.initReview();
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(/review-nav-link/.test(nav), 'Review nav link injected despite the discovery error');
    assert.ok(/id="panel-review"/.test(content), 'Review panel injected despite the discovery error');
  });

  // ── LIVE-PATH SAFETY: no BQ_FUNCTION AND no injected store => no network, no DOM. ──
  await check('no BQ_FUNCTION and no injected store injects nothing and never touches the network', async () => {
    let fetched = 0;
    const ctx = makeUnitCtx(async () => { fetched += 1; return jsonResponse({ bundles: [sampleBundle()] }); }, undefined, { noBqFunction: true });
    await ctx.window.initReview();
    assert.strictEqual(fetched, 0, 'the discovery network call was never made without an endpoint or store');
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link on the live path');
    assert.ok(!/panel-review/.test(content), 'no Review panel on the live path');
  });

  // ── REGRESSION (live-path safety): a LIVE client dashboard has BQ_FUNCTION (it powers the
  //    dashboard) but NO REVIEW block, so it is NOT a review-app context: the module registers
  //    NEITHER tab and makes NO discovery call. Keying "always show" off BQ_FUNCTION/DATASET
  //    alone would regress this and leak the review surface onto a client-facing dashboard. ──
  await check('a live client dashboard (BQ_FUNCTION but no REVIEW block) registers no tab and makes no network call', async () => {
    let fetched = 0;
    const ctx = makeUnitCtx(async () => { fetched += 1; return jsonResponse({ bundles: [sampleBundle()] }); }); // no REVIEW config
    await ctx.window.initReview();
    assert.strictEqual(fetched, 0, 'no discovery call without a REVIEW block, even though BQ_FUNCTION is present');
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link on a live client dashboard');
    assert.ok(!/panel-review/.test(content), 'no Review panel on a live client dashboard');
  });

  // ── REGRESSION (live-path safety): even an injected store cannot force the tab onto a host
  //    with no REVIEW block - the store's discovery is never called. ──
  await check('an injected store with no REVIEW block registers no tab and never calls discovery', async () => {
    let listCalls = 0;
    const ctx = makeUnitCtx(async () => jsonResponse({}));
    ctx.window.f10Review.setStore({ async listBundles() { listCalls += 1; return { bundles: [sampleBundle()] }; } });
    await ctx.window.initReview();
    assert.strictEqual(listCalls, 0, 'discovery is never called without a REVIEW block');
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link without a REVIEW block');
  });

  // ── Render: each new ad renders with its preview, coherence flags and held dimensions. ──
  await check('renders each new ad with its preview image, coherence flags and held dimensions', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({}));
    const previewUrl = 'https://signed.example/new-composite.png';
    ctx.window.f10Review.setStore({
      async listBundles() { return { bundles: [sampleBundle()] }; },
      async preview() { return { url: previewUrl }; },
      async coherence() { return scorecard('pass', 0.9); },
    });
    ctx.window.f10Review.setClient('moshy');
    await ctx.window.f10Review.load();
    const html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    // New generated ad preview image is shown.
    assert.ok(html.indexOf(previewUrl) !== -1, 'the new ad preview image (US-005) is rendered');
    // Coherence flags + held dimensions shown in context.
    assert.ok(/visual_style held for review/.test(html), 'coherence flag rendered');
    assert.ok(/visual_style_canonical/.test(html), 'held dimension rendered');
    // A single discovered bundle renders the detail view, not a grid.
    assert.ok(/rev-bundle"/.test(html) && !/rev-cards/.test(html), 'single bundle renders the detail view');
  });

  // ── Render: a missing preview composite falls back to a labelled placeholder. ──
  await check('a missing preview composite falls back to a labelled placeholder, never a broken img', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({}));
    ctx.window.f10Review.setStore({
      async listBundles() { return { bundles: [sampleBundle()] }; },
      async preview() { return { url: null, reason: 'not-found' }; },
      async coherence() { return null; },
    });
    ctx.window.f10Review.setClient('moshy');
    await ctx.window.f10Review.load();
    const html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    assert.ok(/Preview not available/.test(html), 'missing composite falls back to a labelled placeholder');
  });

  /* ======================================================================== *
   * PHASE 3 (US-022): provenance, region overlay, inspiration side-by-side,
   * and open-in-Figma.
   * ======================================================================== */

  // A LayoutStructure in the fixed contract shape.
  function structure(over) {
    return Object.assign({
      layout_family: 'split-screen', aspect_ratios: '4:5',
      regions: [
        { id: 'headline', role: 'headline', box: { x: 0.08, y: 0.06, w: 0.84, h: 0.1 }, copy_need: true },
        { id: 'hero', role: 'product-shot', box: { x: 0.1, y: 0.2, w: 0.8, h: 0.55 }, image_need: true },
        { id: 'cta', role: 'cta', box: { x: 0.3, y: 0.85, w: 0.4, h: 0.08 }, copy_need: true },
      ],
      repeats: [],
    }, over || {});
  }

  // ── Review shows what each ad was built from + a toggleable region overlay. ──
  await check('a generated ad shows its source / render / layout family and a toggleable region overlay', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({}));
    const previewUrl = 'https://signed.example/new-composite.png';
    const bundle = sampleBundle({
      source: { kind: 'winner', ref: 'moshy-split-screen' }, render: 'scene',
      layout_family: 'split-screen', structure: structure(),
    });
    ctx.window.f10Review.setStore({
      async listBundles() { return { bundles: [bundle] }; },
      async preview() { return { url: previewUrl }; },
      async coherence() { return scorecard('pass', 0.9); },
    });
    ctx.window.f10Review.setClient('moshy');
    await ctx.window.f10Review.load();
    const html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    assert.ok(/Source: winner \(moshy-split-screen\)/.test(html), 'the source is shown');
    assert.ok(/Render: scene/.test(html), 'the render is shown');
    assert.ok(/Layout: split-screen/.test(html), 'the layout family is shown');
    // A toggleable region overlay (the shared wireframe) over the preview.
    assert.ok(/data-rev-overlay-toggle/.test(html), 'the overlay toggle is present');
    assert.ok(/f10-wireframe-overlay/.test(html), 'the region overlay reuses the shared wireframe');
    assert.ok(/data-region-id="headline"/.test(html) && /data-region-id="cta"/.test(html), 'the overlay draws the ad regions');
    // Open-in-Figma affordance.
    assert.ok(/data-rev-figma/.test(html), 'the open-in-Figma affordance is present');
  });

  // ── e2e 2: an inspiration-sourced ad shows the inspiration's detected structure beside
  //     the generated ad's overlay, and no inspiration copy is shown. ──
  await check('an inspiration-sourced ad shows the detected inspiration structure beside the overlay and no inspiration copy', async () => {
    const R = makeUnitCtx(async () => jsonResponse({})).window.f10Review;
    R.setClient('moshy');
    const inspStructure = structure({ layout_family: 'testimonial-quote-card' });
    const bundle = {
      bundle_id: 'insp_ad', platform: 'meta', date: '2026-08-20',
      source: { kind: 'inspiration', ref: 'gs://insp/a.png' }, render: 'scene',
      layout_family: 'testimonial-quote-card', structure: structure(),
      inspiration_structure: inspStructure,
      new_ad: { headline: 'SENSITIVE INSPIRATION COPY' },
    };
    const html = R.newAdHtml(bundle, 'https://signed/x.png', '');
    assert.ok(/data-rev-insp-structure/.test(html), 'the inspiration structure column is shown');
    assert.ok(/Inspiration structure/.test(html), 'it is labelled');
    // Both the generated ad overlay AND the inspiration structure are drawn (two wireframes).
    assert.ok((html.match(/data-region-count/g) || []).length >= 2, 'both structures are drawn side by side');
    assert.ok(html.indexOf('SENSITIVE INSPIRATION COPY') === -1, 'no inspiration copy is shown for an inspiration-sourced ad');
  });

  // ── Open in Figma hands the bundle to the existing plugin path (no new backend). ──
  await check('open-in-Figma hands the bundle (structure + region copy + provenance) to the plugin path', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({}));
    const R = ctx.window.f10Review;
    R.setClient('moshy');
    const bundle = {
      bundle_id: 'fig_ad', platform: 'meta',
      source: { kind: 'winner', ref: 'w1' }, render: 'typeset', layout_family: 'before-after-comparison',
      structure: structure({ layout_family: 'before-after-comparison' }),
      region_copy: { headline: 'A', cta: 'B' },
    };
    // The existing plugin path: a hook the review app / plugin registers.
    let handed = null;
    ctx.window.f10FigmaPlugin = { open(payload) { handed = payload; } };
    const payload = R.openInFigma(bundle);
    assert.strictEqual(payload.schema, 'f10_figma_handoff', 'the handoff is a figma handoff payload');
    assert.ok(payload.structure && payload.region_copy, 'the handoff carries the structure + region copy');
    assert.strictEqual(payload.render, 'typeset', 'the handoff carries the render');
    assert.ok(payload.source && payload.source.kind === 'winner', 'the handoff carries the source');
    assert.ok(handed && handed.bundle_id === 'fig_ad', 'the existing plugin hook received the bundle');
    // With no plugin hook, it stages the payload for the plugin to pick up (no new backend).
    delete ctx.window.f10FigmaPlugin;
    R.openInFigma(bundle);
    assert.ok(ctx.window.F10_FIGMA_HANDOFF && ctx.window.F10_FIGMA_HANDOFF.bundle_id === 'fig_ad', 'the payload is staged for the plugin when no hook is present');
  });

  // ── Generation-date filter: distinct dates newest-first, default most recent, re-filter. ──
  await check('the generation-date filter lists distinct dates newest-first, defaults to the most recent, and re-filters on change', async () => {
    const bundles = [
      sampleBundle({ bundle_id: 'old_a', date: '2026-08-18', label: 'Old A' }),
      sampleBundle({ bundle_id: 'new_a', date: '2026-08-20', label: 'New A' }),
      sampleBundle({ bundle_id: 'new_b', date: '2026-08-20', label: 'New B' }),
    ];
    const ctx = makeUnitCtx(async () => jsonResponse({}));
    const R = ctx.window.f10Review;
    R.setStore({
      async listBundles() { return { bundles: bundles }; },
      async preview(client, id) { return { url: 'https://signed.example/' + id + '.png' }; },
      async coherence() { return scorecard('pass', 0.9); },
    });
    R.setClient('moshy');
    await R.load();

    // Distinct dates, newest first (join-compare to avoid a cross-realm array mismatch).
    assert.strictEqual(R.dates().join(','), '2026-08-20,2026-08-18', 'distinct dates listed newest-first');
    // Defaults to the most recent date.
    assert.strictEqual(R.getDate(), '2026-08-20', 'the filter defaults to the most recent generation date');
    // The panel dropdown markup carries the Generation control.
    const panel = R.panelMarkup();
    assert.ok(/<select id="rev-date">/.test(panel), 'the panel renders the generation-date select');
    assert.ok(/>Generation</.test(panel), 'the dropdown is labelled Generation');

    // First render shows only the most recent date's two bundles (as a grid).
    let html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    assert.ok(/data-bundle-id="new_a"/.test(html) && /data-bundle-id="new_b"/.test(html), 'both newest bundles visible');
    assert.ok(!/data-bundle-id="old_a"/.test(html), 'the older-date bundle is hidden by default');
    assert.ok(/rev-cards/.test(html), 'the most recent date with two bundles renders the grid');

    // Changing to the older date lazy-loads and shows that date's single bundle (detail view).
    // setDate is async under the lazy model (it loads the date's bundles on first selection).
    await R.setDate('2026-08-18');
    html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    assert.ok(/data-bundle-id="old_a"/.test(html), 'the older-date bundle appears after the filter change');
    assert.ok(!/data-bundle-id="new_a"/.test(html) && !/data-bundle-id="new_b"/.test(html), 'the newest-date bundles are hidden after the change');
    assert.ok(!/rev-cards/.test(html) && /rev-bundle"/.test(html), 'a date with one bundle renders the detail view');
  });

  // ── Lazy per-date load: only the most-recent date's bundles are fetched on open; an older
  //    date is fetched only when it is first selected, and a loaded date is cached (no refetch). ──
  await check('only the most-recent date loads on open; an older date lazy-loads on first selection and is then cached', async () => {
    const bundles = [
      sampleBundle({ bundle_id: 'old_a', date: '2026-08-18', label: 'Old A' }),
      sampleBundle({ bundle_id: 'old_b', date: '2026-08-18', label: 'Old B' }),
      sampleBundle({ bundle_id: 'new_a', date: '2026-08-20', label: 'New A' }),
      sampleBundle({ bundle_id: 'new_b', date: '2026-08-20', label: 'New B' }),
    ];
    const previewCalls = [];
    const coherenceCalls = [];
    const ctx = makeUnitCtx(async () => jsonResponse({}));
    const R = ctx.window.f10Review;
    R.setStore({
      async listBundles() { return { bundles: bundles }; },
      async preview(client, id) { previewCalls.push(id); return { url: 'https://signed.example/' + id + '.png' }; },
      async coherence(client, id) { coherenceCalls.push(id); return scorecard('pass', 0.9); },
    });
    R.setClient('moshy');
    await R.load();

    // Initial load fetched ONLY the most-recent date's two bundles, never the older date's.
    assert.deepStrictEqual(previewCalls.slice().sort(), ['new_a', 'new_b'], 'preview fetched only for the most-recent date on load');
    assert.deepStrictEqual(coherenceCalls.slice().sort(), ['new_a', 'new_b'], 'coherence fetched only for the most-recent date on load');
    assert.ok(previewCalls.indexOf('old_a') === -1 && previewCalls.indexOf('old_b') === -1, 'the older date is NOT loaded up front');

    // Selecting the older date now lazy-loads exactly that date's bundles.
    await R.setDate('2026-08-18');
    assert.deepStrictEqual(previewCalls.slice().sort(), ['new_a', 'new_b', 'old_a', 'old_b'], 'the older date is fetched only after it is selected');
    assert.deepStrictEqual(coherenceCalls.slice().sort(), ['new_a', 'new_b', 'old_a', 'old_b'], 'coherence for the older date fetched on selection');
    let html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    assert.ok(/data-bundle-id="old_a"/.test(html) && /data-bundle-id="old_b"/.test(html), 'the older date bundles render after selection');

    // Switching BACK to the already-loaded most-recent date renders from cache with no refetch.
    const previewCountBefore = previewCalls.length;
    await R.setDate('2026-08-20');
    assert.strictEqual(previewCalls.length, previewCountBefore, 'switching back to a loaded date does not re-fetch');
    html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    assert.ok(/data-bundle-id="new_a"/.test(html) && /data-bundle-id="new_b"/.test(html), 'the cached most-recent date renders instantly on switch back');
  });
}

/* ========================================================================== *
 * PART 2 - live-path canary (functional DOM, real base engine + dispatcher)
 * ========================================================================== */

function makeLiveDom() {
  const byId = {};
  const all = [];
  const VOID = { br: 1, img: 1, input: 1, hr: 1, meta: 1, link: 1 };

  function El(tag) {
    const self = {
      tagName: String(tag).toUpperCase(),
      _id: '', _classes: new Set(), dataset: {}, style: {},
      children: [], parent: null, _listeners: {}, _text: '', _html: '',
    };
    Object.defineProperty(self, 'id', { get() { return self._id; }, set(v) { self._id = v || ''; if (v) byId[v] = self; } });
    Object.defineProperty(self, 'className', {
      get() { return Array.from(self._classes).join(' '); },
      set(v) { self._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
    });
    Object.defineProperty(self, 'textContent', { get() { return self._text; }, set(v) { self._text = v == null ? '' : String(v); } });
    Object.defineProperty(self, 'innerHTML', { get() { return self._html; }, set(v) { self._html = v == null ? '' : String(v); } });
    self.classList = {
      add(c) { self._classes.add(c); },
      remove(c) { self._classes.delete(c); },
      contains(c) { return self._classes.has(c); },
      toggle(c, force) {
        const want = force === undefined ? !self._classes.has(c) : !!force;
        if (want) self._classes.add(c); else self._classes.delete(c);
        return want;
      },
    };
    self.setAttribute = function (k, v) {
      if (k === 'id') { self.id = v; return; }
      if (k === 'class') { self.className = v; return; }
      if (k.indexOf('data-') === 0) {
        self.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
        return;
      }
      self[k] = v;
    };
    self.getAttribute = function (k) { return k === 'id' ? self._id : (k === 'class' ? self.className : (self[k] != null ? self[k] : null)); };
    self.appendChild = function (child) { child.parent = self; self.children.push(child); return child; };
    self.addEventListener = function (type, fn) { (self._listeners[type] || (self._listeners[type] = [])).push(fn); };
    self.click = function () {
      const evt = { preventDefault() {}, target: self };
      (self._listeners.click || []).forEach((fn) => fn.call(self, evt));
    };
    self.querySelector = function (sel) { return document.querySelector(sel, self); };
    self.querySelectorAll = function (sel) { return document.querySelectorAll(sel, self); };
    self.insertAdjacentHTML = function (pos, html) { parseInto(self, pos, html); };
    self.scrollIntoView = function () {};
    all.push(self);
    return self;
  }

  function parseInto(target, pos, html) {
    let rest = String(html);
    for (;;) {
      rest = rest.replace(/^\s+/, '');
      while (/^<!--/.test(rest)) rest = rest.replace(/^<!--[\s\S]*?-->/, '').replace(/^\s+/, '');
      const open = /^<([a-zA-Z][\w-]*)((?:\s+[^\s/>]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/.exec(rest);
      if (!open) break;
      const tag = open[1], attrs = open[2], selfClose = open[3] === '/';
      const el = El(tag);
      const attrRe = /([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = attrRe.exec(attrs))) {
        const val = a[2] != null ? a[2] : (a[3] != null ? a[3] : (a[4] != null ? a[4] : ''));
        el.setAttribute(a[1], val);
      }
      let after = rest.slice(open[0].length);
      if (!selfClose && !VOID[tag.toLowerCase()]) {
        const re = new RegExp('<(/?)' + tag + '(?:\\s[^>]*)?>', 'gi');
        re.lastIndex = 0;
        let depth = 1, m, closeStart = -1, closeEnd = -1;
        while ((m = re.exec(after))) {
          if (m[1] === '/') { depth--; if (depth === 0) { closeStart = m.index; closeEnd = re.lastIndex; break; } }
          else { depth++; }
        }
        if (closeStart >= 0) { el.innerHTML = after.slice(0, closeStart); after = after.slice(closeEnd); }
        else { el.innerHTML = after; after = ''; }
      }
      if (pos === 'afterbegin') target.children.unshift(Object.assign(el, { parent: target }));
      else target.appendChild(el);
      rest = after;
    }
  }

  function isDescendant(el, ancestor) {
    let p = el.parent;
    while (p) { if (p === ancestor) return true; p = p.parent; }
    return false;
  }

  function matchOne(part, root) {
    part = part.trim();
    if (part === '#sidebar nav a') {
      const nav = document.querySelector('#sidebar nav');
      if (!nav) return [];
      return all.filter((e) => e.tagName === 'A' && isDescendant(e, nav));
    }
    if (part.charAt(0) === '.') {
      const cls = part.slice(1);
      return all.filter((e) => e._classes.has(cls) && (!root || isDescendant(e, root) || e === root));
    }
    if (/^[a-zA-Z][\w-]*$/.test(part)) {
      const tag = part.toUpperCase();
      return all.filter((e) => e.tagName === tag && (!root || isDescendant(e, root)));
    }
    return [];
  }

  const document = {
    createElement(tag) { return El(tag); },
    getElementById(id) { return byId[id] || (byId[id] = El('div'), byId[id].id = id, byId[id]); },
    querySelector(sel, root) {
      if (sel === '#sidebar nav') { const r = matchOne('nav', null).filter((n) => n.parent && n.parent._id === 'sidebar'); return r[0] || null; }
      const r = document.querySelectorAll(sel, root);
      return r[0] || null;
    },
    querySelectorAll(sel, root) {
      const out = [];
      String(sel).split(',').forEach((part) => {
        matchOne(part, root).forEach((e) => { if (out.indexOf(e) === -1) out.push(e); });
      });
      return out;
    },
  };
  return { document, El, byId, all };
}

/* Boot a functional dashboard: build the base Meta nav + panels (as renderLayout would),
 * wire the real base engine + layout dispatcher, then run initReview with the given
 * REVIEW config + store. Returns handles for the canary assertions. */
async function bootDashboard(reviewConfig, store) {
  const dom = makeLiveDom();
  const document = dom.document;

  const sidebar = document.createElement('div'); sidebar.id = 'sidebar';
  const nav = document.createElement('nav'); sidebar.appendChild(nav);
  const content = document.createElement('div'); content.id = 'content';
  const pageTitle = document.createElement('h1'); pageTitle.id = 'page-title'; content.appendChild(pageTitle);
  const controlsBar = document.createElement('div'); controlsBar.id = 'controls-bar'; content.appendChild(controlsBar);
  const ttControlsBar = document.createElement('div'); ttControlsBar.id = 'tt-controls-bar'; content.appendChild(ttControlsBar);

  function addNavLink(cls, dataKey, dataVal, label) {
    const a = document.createElement('a');
    a.className = cls; a.dataset[dataKey] = dataVal; a.textContent = label;
    nav.appendChild(a); return a;
  }
  function addPanel(id, cls) {
    const p = document.createElement('div'); p.className = cls; p.id = id;
    content.appendChild(p); return p;
  }

  const META_TABS = ['summary', 'board', 'map', 'production', 'creative'];
  META_TABS.forEach((t, i) => {
    const link = addNavLink('nav-link', 'tab', t, t);
    if (i === 0) link.classList.add('active');
    const panel = addPanel('tab-' + t, 'tab-panel');
    if (i === 0) panel.classList.add('active');
  });

  const fetchImpl = async () => jsonResponse([]);

  const window = { f10MediaMarkup: () => '' };
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'moshy_marts',
    TABLE: 'creative_reporting',
    CONV_EXPR: 'purchase',
    CLIENT_NAME: 'Moshy',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    Chart: function () { return { destroy() {} }; },
  };
  if (reviewConfig !== undefined) sandbox.REVIEW = reviewConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(WEEKLY, sandbox, { filename: 'f10-weekly.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  vm.runInContext(REVIEW, sandbox, { filename: 'f10-review.js' });

  // f10-monthly.js is not loaded (the canary is about tab switching): neutralise the one
  // symbol base selectTab calls for a monthly tab.
  sandbox.loadMonthlyTab = function () {};

  sandbox.wireControls();               // base Meta: binds .nav-link -> selectTab
  if (store) sandbox.window.f10Review.setStore(store);
  await sandbox.window.initReview();    // the NEW module: discovery gate -> register via f10ActivateTab

  return { dom, document, sandbox, nav, content };
}

function activePanels(document) {
  return document.querySelectorAll('.tab-panel').filter((p) => p.classList.contains('active'));
}

// A store whose discovery finds one bundle (registers the tab).
const REVIEW_STORE = {
  async listBundles() { return { bundles: [sampleBundle()] }; },
  async preview() { return { url: 'https://signed.example/new-composite.png' }; },
  async coherence() { return null; },
};

// A store whose discovery finds NO bundles (a client with no generated creative).
const EMPTY_STORE = {
  async listBundles() { return { bundles: [] }; },
};

async function runCanary() {
  console.log('US-007 Creative Review tab - live-path canary + dispatcher');

  const { document } = await bootDashboard({}, REVIEW_STORE);

  await check('the new Review module registered (nav link + panel present)', async () => {
    assert.strictEqual(document.querySelectorAll('.review-nav-link').length, 1, 'exactly one Review nav link');
    const panel = document.getElementById('panel-review');
    assert.ok(panel && panel.classList.contains('tab-panel'), 'the panel carries .tab-panel so existing dispatchers clear it');
  });

  // Every pre-existing base tab still switches to exactly one visible panel.
  const preExisting = [
    { label: 'Weekly Summary', tab: 'summary', panelId: 'tab-summary' },
    { label: 'Movement Board', tab: 'board', panelId: 'tab-board' },
    { label: 'Ad Production', tab: 'production', panelId: 'tab-production' },
    { label: 'Creative Effectiveness', tab: 'creative', panelId: 'tab-creative' },
  ];
  for (const t of preExisting) {
    await check('pre-existing tab still switches to exactly one visible panel: ' + t.label, async () => {
      const link = document.querySelectorAll('.nav-link').find((e) => e.dataset.tab === t.tab);
      assert.ok(link, 'nav link found for ' + t.label);
      link.click();
      const active = activePanels(document);
      assert.strictEqual(active.length, 1, 'exactly one panel visible after activating ' + t.label);
      assert.strictEqual(active[0].getAttribute('id'), t.panelId, 'the correct base panel is visible');
      const rev = document.getElementById('panel-review');
      assert.ok(!rev.classList.contains('active'), 'the Review panel is not stuck visible');
    });
  }

  // The Review tab activates to exactly one panel via the single generic dispatcher.
  await check('the Review tab activates to exactly one panel and clears all others', async () => {
    const link = document.querySelectorAll('.review-nav-link')[0];
    link.click();
    const active = activePanels(document);
    assert.strictEqual(active.length, 1, 'exactly one panel visible after activating Review');
    assert.strictEqual(active[0].getAttribute('id'), 'panel-review', 'the Review panel is the visible one');
    const activeLinks = document.querySelectorAll('#sidebar nav a').filter((a) => a.classList.contains('active'));
    assert.strictEqual(activeLinks.length, 1, 'exactly one nav link is active');
    assert.ok(activeLinks[0].classList.contains('review-nav-link'), 'the active nav link is Review');
    assert.strictEqual(document.getElementById('page-title').textContent, 'Creative Review', 'page title updated');
  });

  // Two panels can never both be active: switching back to a base tab clears Review.
  await check('switching back to a base tab clears the Review panel (two panels never both active)', async () => {
    const summary = document.querySelectorAll('.nav-link').find((e) => e.dataset.tab === 'summary');
    summary.click();
    const active = activePanels(document);
    assert.strictEqual(active.length, 1, 'exactly one panel visible');
    assert.strictEqual(active[0].getAttribute('id'), 'tab-summary', 'back on the Weekly Summary panel');
    assert.ok(!document.getElementById('panel-review').classList.contains('active'), 'Review panel cleared');
  });

  // LIVE-PATH: a live client dashboard (NO REVIEW block) boots with the base nav UNCHANGED,
  // regardless of any injected store. This is the safety property: the review surface never
  // leaks onto a client-facing dashboard.
  await check('a live client dashboard (no REVIEW block) is completely unaffected (no Review nav or panel)', async () => {
    const d2 = await bootDashboard(undefined, EMPTY_STORE);
    assert.strictEqual(d2.document.querySelectorAll('.review-nav-link').length, 0, 'no Review nav link injected without a REVIEW block');
    assert.strictEqual(d2.document.querySelectorAll('.review-tab-panel').length, 0, 'no Review panel injected without a REVIEW block');
    // The base nav + its active summary panel are exactly as booted.
    assert.strictEqual(d2.document.querySelectorAll('.nav-link').length, 5, 'the five base nav links are untouched');
    const active = activePanels(d2.document);
    assert.strictEqual(active.length, 1, 'exactly one base panel active');
    assert.strictEqual(active[0].getAttribute('id'), 'tab-summary', 'the base Weekly Summary panel is still the active one');
  });

  // REVIEW-APP, ZERO DATA: a review-app context (REVIEW block present) with NO generated
  // bundles STILL registers the Review tab, so a brand-new client is never a blank page.
  await check('a review-app context with no bundles still registers the Review tab (chicken-and-egg fix)', async () => {
    const d3 = await bootDashboard({}, EMPTY_STORE);
    assert.strictEqual(d3.document.querySelectorAll('.review-nav-link').length, 1, 'exactly one Review nav link even with zero bundles');
    const panel = d3.document.getElementById('panel-review');
    assert.ok(panel && panel.classList.contains('tab-panel'), 'the Review panel is present even with zero bundles');
  });
}

(async () => {
  await runUnit();
  await runCanary();
  console.log('\nUS-007 OK - ' + passed + ' checks passed.');
})().catch((e) => { console.error('\nUS-007 FAILED:', (e && e.stack) || e); process.exit(1); });
