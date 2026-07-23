/**
 * US-008 — Tab 1: search UI over the competitor ad grid (dashboard side).
 *
 * Verifies the search surface added to f10-competitors.js: a search bar sits
 * above the existing card grid; submitting a term calls the `competitor-search`
 * action (now metadata-only) and re-renders the SAME grouped card grid via the
 * shared lazy-per-page path — creatives are then loaded on demand through the
 * `competitor-creatives` action (reusing compCardHtml / f10MediaMarkup) with a
 * per-result "matched: …" indicator; an empty result is a clean empty state; and
 * clearing the search restores the cached full grid. An analytics
 * `competitor.search` event is emitted on submit.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm
 * sandbox with a tiny auto-slotting DOM stub, a fetch stub standing in for the
 * Netlify function, and an f10MediaMarkup stub, then drives the exported search
 * internals (window.f10CompetitorSearch) exactly as the UI does.
 *
 * Run: node test/us-008-competitor-search-ui.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const COMPETITORS = fs.readFileSync(path.join(ROOT, 'f10-competitors.js'), 'utf8');

/* Tiny DOM stub: getElementById auto-creates a slot the first time it is asked
 * for, so compRenderSection can write into comp-grid-N slots just like a real
 * DOM. insertAdjacentHTML appends to innerHTML so injection is observable. */
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
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return { document, slots };
}

/* Build a fresh sandbox with utils + competitors loaded and a fetch/analytics/
 * media stub wired in. `fetchImpl` receives (url, opts) and returns a Response-
 * like object. */
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
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl,
    _slots: slots,
    _tracked: tracked,
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  sandbox.CS = window.f10CompetitorSearch;
  return sandbox;
}

/* A JSON "Response" like the Netlify fetch returns. */
function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* Metadata-only ad row (no creatives — the search action no longer returns them;
 * the UI loads them lazily via competitor-creatives). */
function ad(over) {
  return Object.assign({
    ad_archive_id: 'A?', page_name: 'CompA', display_format: 'Image', cta_type: 'SHOP_NOW',
    ad_creative_bodies: ['copy'], ad_delivery_start_time: '2026-05-01',
    is_active: true, still_active: true, matched_fields: ['on_screen_text'],
  }, over);
}

/* Stand in for the competitor-creatives action: mint a deterministic signed URL
 * per requested ad id so the lazy loader has something to render. */
function creativesResponse(adIds) {
  const creativesByAd = {};
  (adIds || []).forEach((id) => {
    creativesByAd[String(id)] = [{ media_type: 'image', idx: 0, url: 'https://signed.example/' + id + '.jpg' }];
  });
  return { creativesByAd };
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('US-008 competitor search UI');

  // ── Pure helper: matched-field indicator maps field names to human labels ──
  await check('matchedHtml maps matched_fields to a readable "matched: …" line', async () => {
    const ctx = makeCtx(async () => jsonResponse({ ads: [], term: '' }));
    const html = ctx.CS.matchedHtml({ matched_fields: ['on_screen_text', 'ad_creative_bodies'] });
    assert.ok(/matched:/.test(html), 'renders a matched line');
    assert.ok(/on-screen text/.test(html), 'on_screen_text -> "on-screen text"');
    assert.ok(/ad copy/.test(html), 'ad_creative_bodies -> "ad copy"');
    // A default-grid card (no matched_fields) renders nothing -> single card path.
    assert.strictEqual(ctx.CS.matchedHtml({}), '', 'no matched_fields -> empty');
  });

  // ── Pure helper: search bar markup is a real search input with Search + Clear ──
  await check('searchBarHtml renders a search input plus Search and Clear controls', async () => {
    const ctx = makeCtx(async () => jsonResponse({ ads: [], term: '' }));
    const bar = ctx.CS.searchBarHtml();
    assert.ok(/type="search"/.test(bar), 'a search input');
    assert.ok(/id="comp-search-input"/.test(bar), 'input id present');
    assert.ok(/comp-search-clear/.test(bar) && /hidden/.test(bar), 'clear control starts hidden');
    assert.ok(/pg-btn/.test(bar), 'reuses the existing .pg-btn button style');
  });

  // ── e2e 1: submit 'menopause' -> matching ads render, grouped by page, signed media ──
  await check("submitting 'menopause' renders only matches, grouped by page, with lazily-loaded signed media", async () => {
    const searchCalls = [];
    const creativeCalls = [];
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'competitor-creatives') {
        creativeCalls.push(body);
        assert.strictEqual(body.client, 'mosh', 'creatives call scoped to the client');
        return jsonResponse(creativesResponse(body.adIds));
      }
      searchCalls.push(body);
      assert.strictEqual(body.action, 'competitor-search', 'calls the search action');
      assert.strictEqual(body.term, 'menopause');
      assert.strictEqual(body.client, 'mosh', 'scoped to the client competitor set');
      // Metadata only — the search action no longer returns creatives.
      return jsonResponse({
        term: 'menopause',
        ads: [
          ad({ ad_archive_id: 'A1', page_name: 'CompA', ad_creative_bodies: ['Managing menopause'],
               on_screen_text: 'menopause relief', matched_fields: ['on_screen_text', 'ad_creative_bodies'] }),
          ad({ ad_archive_id: 'B1', page_name: 'CompB', matched_fields: ['ad_creative_bodies'] }),
        ],
      });
    });
    ctx.CS.setClient('mosh');

    await ctx.CS.runSearch('menopause');

    // Exactly one search action fetch, with the right shape.
    assert.strictEqual(searchCalls.length, 1, 'one search request issued');
    // Analytics: competitor.search emitted on submit.
    const ev = ctx._tracked.find((t) => t.event === 'competitor.search');
    assert.ok(ev, 'competitor.search analytics event emitted');
    assert.strictEqual(ev.props.term, 'menopause');

    // Grouped by competitor page: two sections in query order.
    const sections = ctx.CS.getSections();
    assert.strictEqual(sections.length, 2, 'two competitor groups');
    assert.strictEqual(sections.map((s) => s.page_name).join(','), 'CompA,CompB');

    // Creatives were loaded lazily for the visible pages via the creatives action.
    assert.ok(creativeCalls.length >= 1, 'competitor-creatives called for the visible page(s)');
    const requested = creativeCalls.reduce((acc, c) => acc.concat(c.adIds), []);
    assert.ok(requested.includes('A1') && requested.includes('B1'), 'visible ad ids requested');

    // The section scaffold (page headers) is written to comp-body.
    const bodyHtml = ctx._slots['comp-body'].innerHTML;
    assert.ok(/CompA/.test(bodyHtml) && /CompB/.test(bodyHtml), 'both page names rendered');

    // compRenderSection mounted the first page's cards into the grid slots:
    // lazily-signed media + matched indicator are present (reuses compCardHtml/f10MediaMarkup).
    const grid0 = ctx._slots['comp-grid-0'].innerHTML;
    assert.ok(/https:\/\/signed\.example\/A1\.jpg/.test(grid0), 'lazily-loaded signed creative URL rendered');
    assert.ok(/matched:/.test(grid0) && /on-screen text/.test(grid0), 'matched-field indicator on the card');
    assert.ok(!/gs:\/\//.test(grid0), 'no gs:// URI leaks into the grid');

    // Clear control is now visible.
    assert.strictEqual(ctx._slots['comp-search-clear'].hidden, false, 'clear shown during an active search');
    assert.strictEqual(ctx.CS.isSearchActive(), true);
  });

  // ── Empty result is a clean empty state, not an error ──
  await check('a term with no matches shows a clean empty state', async () => {
    const ctx = makeCtx(async () => jsonResponse({ ads: [], term: 'zzz' }));
    ctx.CS.setClient('mosh');
    await ctx.CS.runSearch('zzz');
    assert.strictEqual(ctx.CS.getSections().length, 0, 'no sections');
    assert.ok(/No competitor ads match/.test(ctx._slots['comp-body'].innerHTML), 'empty-state copy shown');
  });

  // ── e2e 2: clearing the search restores the cached full grid ──
  await check('clearing the search restores the full competitor grid', async () => {
    const ctx = makeCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'competitor-creatives') return jsonResponse(creativesResponse(body.adIds));
      return jsonResponse({
        term: 'menopause',
        ads: [ad({ ad_archive_id: 'A1', page_name: 'CompA', matched_fields: ['ad_creative_bodies'] })],
      });
    });
    ctx.CS.setClient('mosh');

    // Seed the cached default grid (three competitors), as compLoad would.
    const defaults = [
      ad({ ad_archive_id: 'D1', page_name: 'CompA', matched_fields: [] }),
      ad({ ad_archive_id: 'D2', page_name: 'CompB', matched_fields: [] }),
      ad({ ad_archive_id: 'D3', page_name: 'CompC', matched_fields: [] }),
    ];
    ctx.CS.setDefault(defaults, null);

    // Run a search that narrows to a single competitor…
    await ctx.CS.runSearch('menopause');
    assert.strictEqual(ctx.CS.getSections().length, 1, 'search view narrowed to one competitor');

    // …then clear it: the full three-competitor grid comes back.
    ctx.CS.clearSearch();
    const sections = ctx.CS.getSections();
    assert.strictEqual(sections.length, 3, 'full grid restored (all competitors)');
    assert.strictEqual(sections.map((s) => s.page_name).join(','), 'CompA,CompB,CompC');
    assert.strictEqual(ctx.CS.isSearchActive(), false, 'search no longer active');
    assert.strictEqual(ctx._slots['comp-search-clear'].hidden, true, 'clear control hidden again');
  });

  // ── groupByPage preserves query order and buckets Unknown ──
  await check('groupByPage groups by page_name, preserving order, Unknown-safe', async () => {
    const ctx = makeCtx(async () => jsonResponse({ ads: [], term: '' }));
    const groups = ctx.CS.groupByPage([
      { page_name: 'B', ad_archive_id: 1 },
      { page_name: 'A', ad_archive_id: 2 },
      { page_name: 'B', ad_archive_id: 3 },
      { page_name: '', ad_archive_id: 4 },
    ]);
    assert.strictEqual(groups.map((g) => g.page_name).join(','), 'B,A,Unknown');
    assert.strictEqual(groups[0].rows.length, 2, 'B keeps both of its ads');
  });

  console.log(`\nUS-008: ${passed} checks passed.`);
})().catch((e) => { console.error('\nUS-008 FAILED:', e && e.stack || e); process.exit(1); });
