/**
 * US-014 — Tab 1: Status / Timeframe / Competitor filters + lazy per-page creatives.
 *
 * Verifies the filter bar and metadata/lazy-creatives split added to
 * f10-competitors.js:
 *   - default Status = Live → inactive ads are hidden until the status is changed;
 *   - toggling Status to All / Inactive re-filters the cached list WITHOUT a new
 *     metadata fetch;
 *   - the Competitor dropdown narrows to one competitor WITHOUT a refetch;
 *   - a Timeframe change RE-FETCHES metadata with the right `days` (All time = the
 *     field omitted);
 *   - the page size caps at 20 (COMP_PER_PAGE default);
 *   - creatives are fetched ONLY for the visible page — the competitor-creatives
 *     action is called with the visible page's ids and NOT the hidden page's ids.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm
 * sandbox with a tiny auto-slotting DOM stub and a fetch stub standing in for the
 * Netlify function (branching on body.action), then drives the exported filter +
 * lazy-creatives internals (window.f10CompetitorSearch) exactly as the UI wiring
 * does. Mirrors us-008 / us-013.
 *
 * Run: node test/us-014-competitor-filters.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const COMPETITORS = fs.readFileSync(path.join(ROOT, 'f10-competitors.js'), 'utf8');

/* Tiny DOM stub: getElementById auto-creates a slot on first ask, so
 * compRenderSection can write into comp-grid-N slots just like a real DOM. */
function makeDom() {
  const slots = {};
  function mkSlot(id) {
    return {
      id, innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener() {}, insertAdjacentHTML(_pos, html) { this.innerHTML += html; }, scrollIntoView() {},
    };
  }
  const document = {
    getElementById(id) { return slots[id] || (slots[id] = mkSlot(id)); },
    querySelector() { return null; },
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
  window.F10A = { track: (event, props) => tracked.push({ event, props }) };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
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

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* Metadata ad row (no creatives). */
function ad(id, page, live) {
  return {
    ad_archive_id: id, page_name: page, display_format: 'Image', cta_type: 'SHOP_NOW',
    ad_creative_bodies: ['copy'], ad_delivery_start_time: '2026-05-01',
    is_active: live, still_active: live,
  };
}

/* Fixture: CompA has 22 live ads (A0..A21 → page 0 = A0..A19, page 1 = A20,A21);
 * CompB has 2 live (B0,B1) + 1 inactive (B2). */
function fixtureAds() {
  const ads = [];
  for (let i = 0; i < 22; i++) ads.push(ad('A' + i, 'CompA', true));
  ads.push(ad('B0', 'CompB', true));
  ads.push(ad('B1', 'CompB', true));
  ads.push(ad('B2', 'CompB', false));
  return ads;
}

/* Build a fetch stub that records metadata + creatives calls and serves the
 * fixture. Returns { fetchImpl, metaCalls, creativeCalls, requestedIds }. */
function makeFetch() {
  const metaCalls = [];
  const creativeCalls = [];
  const requestedIds = new Set();
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action === 'competitor-creatives') {
      creativeCalls.push(body);
      (body.adIds || []).forEach((id) => requestedIds.add(id));
      const creativesByAd = {};
      (body.adIds || []).forEach((id) => {
        creativesByAd[String(id)] = [{ media_type: 'image', idx: 0, url: 'https://signed.example/' + id + '.jpg' }];
      });
      return jsonResponse({ creativesByAd });
    }
    // competitor (metadata) action.
    metaCalls.push(body);
    return jsonResponse({ ads: fixtureAds(), ageMetrics: { client: null, byPage: {} }, days: body.days != null ? body.days : null });
  };
  return { fetchImpl, metaCalls, creativeCalls, requestedIds };
}

function countCards(html) {
  return (String(html).match(/class="comp-card"/g) || []).length;
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('US-014 competitor filters + lazy creatives');

  // ── Page size default is 20. ──
  await check('COMP_PER_PAGE default is 20', async () => {
    const { fetchImpl } = makeFetch();
    const ctx = makeCtx(fetchImpl);
    assert.strictEqual(ctx.CS.PER_PAGE, 20, 'page size caps at 20');
  });

  // ── Default Status = Live hides inactive; creatives fetched only for the visible page. ──
  await check('default load: Live-only, page caps at 20, creatives fetched only for the visible page', async () => {
    const { fetchImpl, metaCalls, creativeCalls, requestedIds } = makeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.CS.setClient('mosh');

    await ctx.CS.load();

    // One metadata fetch, default timeframe 90.
    assert.strictEqual(metaCalls.length, 1, 'one metadata fetch on load');
    assert.strictEqual(metaCalls[0].days, 90, 'default timeframe is 90 days');

    // Default status Live → CompA (22 live) + CompB (2 live); the inactive B2 hidden.
    const sections = ctx.CS.getSections();
    assert.strictEqual(sections.length, 2, 'two competitors with live ads');
    const compA = sections.find((s) => s.page_name === 'CompA');
    const compB = sections.find((s) => s.page_name === 'CompB');
    assert.strictEqual(compA.ads.length, 22, 'CompA keeps all 22 live ads');
    assert.strictEqual(compB.ads.length, 2, 'CompB shows only its 2 live ads (inactive hidden)');

    // Page size: only 20 cards mount for CompA's first page.
    const gridA = ctx._slots['comp-grid-0'].innerHTML;
    assert.strictEqual(countCards(gridA), 20, 'first page caps at 20 cards');

    // Creatives fetched ONLY for the visible page: CompA A0..A19 + CompB B0,B1,
    // never the hidden page-2 ads A20/A21.
    assert.ok(requestedIds.has('A0') && requestedIds.has('A19'), 'visible CompA page-0 ids requested');
    assert.ok(requestedIds.has('B0') && requestedIds.has('B1'), 'visible CompB ids requested');
    assert.ok(!requestedIds.has('A20') && !requestedIds.has('A21'), 'hidden page ids NOT requested');
    // The B2 inactive ad is filtered out and never requested.
    assert.ok(!requestedIds.has('B2'), 'filtered-out inactive ad not requested');
    // The signed media landed on the cards.
    assert.ok(/https:\/\/signed\.example\/A0\.jpg/.test(gridA), 'lazily-loaded creative URL rendered');
    assert.ok(creativeCalls.length >= 1, 'competitor-creatives called at least once');
  });

  // ── Status toggle re-filters WITHOUT a new metadata fetch. ──
  await check('status All then Inactive re-filters client-side with no refetch', async () => {
    const { fetchImpl, metaCalls } = makeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.CS.setClient('mosh');
    await ctx.CS.load();
    assert.strictEqual(metaCalls.length, 1);

    // All → CompB now shows all 3 (including the inactive B2).
    await ctx.CS.onStatus('all');
    assert.strictEqual(metaCalls.length, 1, 'status change must NOT refetch metadata');
    let compB = ctx.CS.getSections().find((s) => s.page_name === 'CompB');
    assert.strictEqual(compB.ads.length, 3, 'All shows the inactive ad too');

    // Inactive → only B2; CompA (all live) disappears entirely.
    await ctx.CS.onStatus('inactive');
    assert.strictEqual(metaCalls.length, 1, 'still no refetch');
    const sections = ctx.CS.getSections();
    assert.strictEqual(sections.length, 1, 'only CompB has an inactive ad');
    assert.strictEqual(sections[0].page_name, 'CompB');
    assert.strictEqual(sections[0].ads.length, 1, 'exactly the one inactive ad');
    assert.strictEqual(sections[0].ads[0].ad_archive_id, 'B2');
  });

  // ── Competitor dropdown filters to one page WITHOUT a refetch. ──
  await check('competitor dropdown narrows to one competitor with no refetch', async () => {
    const { fetchImpl, metaCalls } = makeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.CS.setClient('mosh');
    await ctx.CS.load();
    assert.strictEqual(metaCalls.length, 1);

    await ctx.CS.onCompetitor('CompB');
    assert.strictEqual(metaCalls.length, 1, 'competitor change must NOT refetch metadata');
    const sections = ctx.CS.getSections();
    assert.strictEqual(sections.length, 1, 'narrowed to a single competitor');
    assert.strictEqual(sections[0].page_name, 'CompB');
  });

  // ── Timeframe change RE-FETCHES with the right days. ──
  await check('timeframe change refetches metadata with the new days (All time = omitted)', async () => {
    const { fetchImpl, metaCalls } = makeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.CS.setClient('mosh');
    await ctx.CS.load();
    assert.strictEqual(metaCalls.length, 1);
    assert.strictEqual(metaCalls[0].days, 90);

    await ctx.CS.onTimeframe('30');
    assert.strictEqual(metaCalls.length, 2, 'timeframe change refetches');
    assert.strictEqual(metaCalls[1].days, 30, 'refetched with days=30');

    await ctx.CS.onTimeframe('all');
    assert.strictEqual(metaCalls.length, 3, 'all-time also refetches');
    assert.ok(!('days' in metaCalls[2]), 'all time omits the days field (full history)');
  });

  // ── Returning to a cached page does not re-fetch its creatives. ──
  await check('creative cache prevents re-fetching an already-loaded page', async () => {
    const { fetchImpl, creativeCalls } = makeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.CS.setClient('mosh');
    await ctx.CS.load();
    const firstRoundCalls = creativeCalls.length;
    // Re-apply the same filters (re-render): visible ids are already cached, so no
    // new competitor-creatives request is issued.
    await ctx.CS.renderFiltered();
    assert.strictEqual(creativeCalls.length, firstRoundCalls, 'no re-fetch for cached creatives');
  });

  console.log(`\nUS-014: ${passed} checks passed.`);
})().catch((e) => { console.error('\nUS-014 FAILED:', e && e.stack || e); process.exit(1); });
