/**
 * Roadmap #5 - Scored batch review: the Creative Review tab as a RANKED GRID of scorecards
 * (f10-review.js).
 *
 * Extends the US-007 / US-009 Creative Review module: when more than one bundle is under
 * review the DEFAULT view is a ranked grid of cards, best-first, each carrying its coherence
 * scorecard. For each bundle the module fetches a scorecard from the backend via a new store
 * method `coherence(client, bundleId, platform)` that posts { action:'coherence', client,
 * bundleId, platform } to BQ_FUNCTION, and consumes this response contract (fail-closed on any
 * error -> unscored):
 *   { found:bool,
 *     overall_verdict:'pass'|'flag', overall_score:number(0..1),
 *     dimensions:{
 *       client_fit:{ score, verdict, reason },
 *       component_fidelity:{ score, verdict, reason, matched, total },
 *       brand_compliance:{ score, verdict, reason } },
 *     flags:[string] }
 *
 * Fully offline and dependency-free (no jsdom): the real f10-review.js is loaded into a vm
 * sandbox with a tiny DOM stub, and BOTH the winners/preview/coherence store and the feedback
 * client are injected fakes. Covers:
 *   - the default store's coherence method posts the exact request contract;
 *   - the grid renders N cards sorted by (pass, overall_score desc), unscored last, with a
 *     rank / among-N indicator;
 *   - a card shows the three dimension scores + flags + verdict when the store returns a
 *     scorecard, and renders "not scored" when found:false OR on a coherence fetch error;
 *   - approve / decline + persisted-state still work per card through the existing feedback seam;
 *   - the single-bundle winners comparison (US-006) stays reachable by expanding a card;
 *   - a single bundle still renders the original detail view (not a grid).
 *
 * Run: node test/f10-review-grid.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UTILS = readSrc('f10-utils.js');
const REVIEW = readSrc('f10-review.js');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }
function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* A representative coherence scorecard, per the consumed contract. */
function scorecard(verdict, overall, opts) {
  opts = opts || {};
  return {
    found: true,
    overall_verdict: verdict,
    overall_score: overall,
    dimensions: {
      client_fit: { score: opts.cf != null ? opts.cf : 0.9, verdict: opts.cfV || 'pass', reason: 'on-brief audience' },
      component_fidelity: {
        score: opts.compScore != null ? opts.compScore : 0.8, verdict: opts.compV || 'pass',
        reason: 'proven components reused', matched: opts.matched != null ? opts.matched : 3, total: opts.total != null ? opts.total : 4,
      },
      brand_compliance: { score: opts.bc != null ? opts.bc : 0.85, verdict: opts.bcV || 'pass', reason: 'palette + logo ok' },
    },
    flags: opts.flags || [],
  };
}

function sampleWinners() {
  return {
    client: 'moshy',
    metric: 'cpa',
    winners: [
      { ad_id: '111', ad_name: 'Founder hero v3', metric_type: 'cpa', metric_value: 42, spend: 52000, conversions: 900, image_url: 'https://signed.example/win1.jpg', creative_link: null },
    ],
    comparison: { so_what: 'reuses a proven winner', now_what: 'hold one unproven dimension' },
  };
}

/* Four bundles: makes the sort observable (pass-high, pass-low, flag-high, unscored). */
function bundle(id, label) {
  return {
    bundle_id: id, platform: 'meta', label: label || id,
    components: { hook_type: 'Founder story' },
    coherence_flags: ['visual_style held for review'],
    held_dimensions: ['visual_style_canonical'],
    new_ad: { headline: 'Meet the founder' },
  };
}

/* Build a store whose coherence() serves a per-bundle map, and records every coherence
 * request so the exact posted contract can be asserted. `cohThrows` forces a fetch error. */
function makeStore(scoreMap, opts) {
  opts = opts || {};
  const coherenceCalls = [];
  return {
    coherenceCalls,
    store: {
      async probe() { return true; },
      async winners() { return sampleWinners(); },
      async preview(client, id) { return { url: 'https://signed.example/' + id + '.png' }; },
      async coherence(client, id, platform) {
        coherenceCalls.push({ client, id, platform });
        if (opts.cohThrows) throw new Error('coherence endpoint 500');
        const sc = Object.prototype.hasOwnProperty.call(scoreMap, id) ? scoreMap[id] : { found: false };
        return sc;
      },
    },
  };
}

/* In-memory feedback fake mirroring the US-008 write + status.json read (see the US-009 test). */
function makeFeedbackFake() {
  const backing = {};
  const submissions = [];
  const key = (c, p, b) => c + '/' + p + '/' + b;
  return {
    submissions,
    client: {
      async submit(record) {
        submissions.push(record);
        const when = '2026-08-25T00:00:00.000Z';
        backing[key(record.client, record.platform, record.bundle_id)] = {
          client: record.client, bundle_id: record.bundle_id, platform: record.platform,
          state: record.state, comment: record.comment == null ? null : record.comment,
          actor: record.actor == null ? null : record.actor, updated_at: when,
        };
        return { ok: true, client: record.client, bundle_id: record.bundle_id, platform: record.platform, state: record.state, updated_at: when };
      },
      async read(client, id, platform) {
        const rec = backing[key(client, platform, id)];
        return rec ? Object.assign({}, rec) : null;
      },
    },
  };
}

function makeTinyDom() {
  const slots = {};
  function mkSlot(id) {
    return {
      id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener() {}, getAttribute() { return null; },
      insertAdjacentHTML(_pos, html) { this.innerHTML += html; }, scrollIntoView() {},
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

function makeCtx(reviewConfig, fetchImpl) {
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'moshy_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl || (async () => jsonResponse({})),
    setTimeout, clearTimeout,
    _slots: slots,
  };
  if (reviewConfig !== undefined) sandbox.REVIEW = reviewConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(REVIEW, sandbox, { filename: 'f10-review.js' });
  return sandbox;
}

/* Boot a loaded grid for the given bundles + injected store/feedback fakes. */
async function bootGrid(bundles, storeObj, feedbackFake) {
  const cfg = { CLIENT: 'moshy', ACTOR: 'zac@f10', BUNDLES: bundles };
  const ctx = makeCtx(cfg);
  const R = ctx.window.f10Review;
  R.setStore(storeObj);
  if (feedbackFake) R.setFeedbackClient(feedbackFake.client);
  R.setClient('moshy');
  await R.load();
  const body = () => (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
  return { ctx, R, body };
}

/* Ordered list of card bundle_ids as they appear in the rendered grid. */
function cardOrder(html) {
  const ids = [];
  const re = /class="rev-card(?:\s+rev-card-unscored)?"\s+data-bundle-id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) ids.push(m[1]);
  return ids;
}

async function run() {
  console.log('Roadmap #5 Scored batch review - ranked scorecard grid');

  // ── The default store's coherence method posts the exact request contract. ──
  await check('the default store posts { action:"coherence", client, bundleId, platform } to BQ_FUNCTION', async () => {
    let posted = null;
    const ctx = makeCtx({ CLIENT: 'moshy', BUNDLES: [bundle('b1'), bundle('b2')] }, async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'coherence') { posted = { url, body }; return jsonResponse(scorecard('pass', 0.9)); }
      if (body.probe) return jsonResponse({ exists: true });
      return jsonResponse({});
    });
    // Drive the coherence fetch through the real default store (no setStore).
    ctx.window.f10Review.setClient('moshy');
    const sc = await ctx.window.f10Review.fetchCoherence(bundle('b1'));
    assert.ok(posted, 'a coherence request was posted');
    assert.strictEqual(posted.url, 'https://fn.example/.netlify/functions/bq', 'posts to BQ_FUNCTION');
    assert.strictEqual(posted.body.action, 'coherence', 'action is coherence');
    assert.strictEqual(posted.body.client, 'moshy', 'client is scoped');
    assert.strictEqual(posted.body.bundleId, 'b1', 'bundleId sent');
    assert.strictEqual(posted.body.platform, 'meta', 'platform sent');
    assert.strictEqual(sc.overall_verdict, 'pass', 'the scorecard is returned to the caller');
  });

  // ── Grid renders N cards, sorted (pass, overall_score desc), unscored last. ──
  await check('the grid renders one card per bundle, sorted by (pass, overall_score desc) with unscored last', async () => {
    const bundles = [bundle('low_pass'), bundle('flag_high'), bundle('top_pass'), bundle('none')];
    const scoreMap = {
      low_pass: scorecard('pass', 0.72),
      flag_high: scorecard('flag', 0.95),          // high score but flagged -> below any pass
      top_pass: scorecard('pass', 0.91),
      none: { found: false },                       // unscored -> always last
    };
    const st = makeStore(scoreMap);
    const { body } = await bootGrid(bundles, st.store, makeFeedbackFake());
    const html = body();
    assert.ok(/rev-cards/.test(html), 'a grid container is rendered');
    const order = cardOrder(html);
    assert.strictEqual(order.length, 4, 'one card per bundle');
    assert.deepStrictEqual(order, ['top_pass', 'low_pass', 'flag_high', 'none'],
      'passing cards first by score desc, then flagged, then unscored last');
    // A rank / among-N indicator rides on the cards.
    assert.ok(/#1 of 4/.test(html), 'the top card shows a rank / among-N indicator');
    assert.ok(/Unscored/.test(html), 'the unscored card is labelled unscored');
  });

  // ── A card shows the three dimension scores + flags + verdict when scored. ──
  await check('a scored card shows the three dimension scores, flags list, and overall verdict + score', async () => {
    const sc = scorecard('flag', 0.66, {
      cf: 0.9, cfV: 'pass',
      compScore: 0.5, compV: 'flag', matched: 2, total: 5,
      bc: 0.8, bcV: 'pass',
      flags: ['brand palette drift on CTA', 'hook not proven for this client'],
    });
    const st = makeStore({ b1: sc, b2: scorecard('pass', 0.9) });
    const { body } = await bootGrid([bundle('b1', 'Founder story'), bundle('b2')], st.store, makeFeedbackFake());
    const html = body();
    // Overall verdict badge + score.
    assert.ok(/data-rev-verdict="flag"[^>]*>FLAG/.test(html), 'overall FLAG badge rendered');
    assert.ok(/rev-overall-score">66%/.test(html), 'overall score rendered as a percent');
    // Three dimensions.
    assert.ok(/Client fit/.test(html) && />90%</.test(html), 'client_fit score shown');
    assert.ok(/Component fidelity/.test(html) && />2\/5</.test(html), 'component_fidelity shown as matched/total');
    assert.ok(/Brand compliance/.test(html) && />80%</.test(html), 'brand_compliance score shown');
    // Per-dimension pass/flag chips.
    assert.ok(/rev-chip-pass/.test(html) && /rev-chip-flag/.test(html), 'pass and flag chips both present');
    // Flags list.
    assert.ok(/brand palette drift on CTA/.test(html), 'first flag rendered');
    assert.ok(/hook not proven for this client/.test(html), 'second flag rendered');
  });

  // ── found:false renders a clean "not scored" card, still approvable. ──
  await check('found:false renders a "not scored yet" card that is still approvable', async () => {
    const st = makeStore({ b1: { found: false }, b2: scorecard('pass', 0.9) });
    const fb = makeFeedbackFake();
    const { R, body } = await bootGrid([bundle('b1'), bundle('b2')], st.store, fb);
    let html = body();
    assert.ok(/rev-scorecard-unscored/.test(html), 'an unscored scorecard block is rendered');
    assert.ok(/Not scored yet/.test(html), 'the "not scored yet" label is shown');
    // Still approvable: the approve control is present for the unscored bundle and works.
    assert.ok(/data-bundle-id="b1"[\s\S]*?data-rev-action="approve"/.test(html), 'the unscored card has an approve control');
    await R.approve('b1');
    assert.strictEqual(R.statusOf('b1').state, 'approved', 'an unscored bundle can still be approved');
    assert.strictEqual(fb.submissions[0].bundle_id, 'b1', 'the decision posted for the unscored bundle');
  });

  // ── A coherence fetch error is fail-closed: the card renders unscored, tab intact. ──
  await check('a coherence fetch error renders an unscored card and never breaks the tab', async () => {
    const st = makeStore({}, { cohThrows: true });
    const { R, body } = await bootGrid([bundle('b1'), bundle('b2')], st.store, makeFeedbackFake());
    const html = body();
    assert.ok(/rev-cards/.test(html), 'the grid still renders on a coherence error');
    assert.strictEqual((html.match(/rev-scorecard-unscored/g) || []).length, 2, 'both cards fall back to unscored');
    assert.ok(!/rev-overall-pass|rev-overall-flag/.test(html), 'no invented verdict on a fetch error');
    // The tab is fully usable: decisions still work.
    await R.approve('b1');
    assert.strictEqual(R.statusOf('b1').state, 'approved', 'decisions still work after a coherence error');
  });

  // ── Approve / decline + persisted state work per card, and survive a reload. ──
  await check('approve / decline work per card and the persisted state survives a reload', async () => {
    const bundles = [bundle('b1'), bundle('b2'), bundle('b3')];
    const scoreMap = { b1: scorecard('pass', 0.9), b2: scorecard('flag', 0.6), b3: { found: false } };
    const st = makeStore(scoreMap);
    const fb = makeFeedbackFake();
    const { R, body } = await bootGrid(bundles, st.store, fb);

    await R.approve('b1');
    await R.decline('b2', '  off-brand tone  ');
    assert.strictEqual(R.statusOf('b1').state, 'approved', 'b1 approved');
    assert.strictEqual(R.statusOf('b2').state, 'declined', 'b2 declined');
    assert.strictEqual(fb.submissions.find((s) => s.bundle_id === 'b2').comment, 'off-brand tone', 'decline reason trimmed + recorded');
    const html = body();
    assert.ok(/data-bundle-id="b1"[\s\S]*?rev-state-approved/.test(html), 'b1 card shows approved');
    assert.ok(/data-bundle-id="b2"[\s\S]*?rev-state-declined/.test(html), 'b2 card shows declined');

    // Reload with a fresh module instance sharing only the persisted feedback backing store.
    const { R: R2, body: body2 } = await bootGrid(bundles, makeStore(scoreMap).store, fb);
    assert.strictEqual(R2.statusOf('b1').state, 'approved', 'reloaded grid shows b1 approved');
    assert.strictEqual(R2.statusOf('b2').state, 'declined', 'reloaded grid shows b2 declined');
    assert.ok(/off-brand tone/.test(body2()), 'the persisted decline reason is read back into the grid');
  });

  // ── The single-bundle winners comparison (US-006) stays reachable by expanding a card. ──
  await check('expanding a card reveals the US-006 winners comparison (so-what / now-what) inline', async () => {
    const st = makeStore({ b1: scorecard('pass', 0.9), b2: scorecard('flag', 0.5) });
    const { R, body } = await bootGrid([bundle('b1'), bundle('b2')], st.store, makeFeedbackFake());
    let html = body();
    // Collapsed by default: the winners comparison is not in the DOM yet.
    assert.ok(!/Founder hero v3/.test(html), 'winners are not shown until a card is expanded');
    assert.ok(/data-rev-action="expand"/.test(html), 'each card has an expand control');
    // Expand via the delegated click handler.
    const target = { getAttribute(k) { return k === 'data-rev-action' ? 'expand' : (k === 'data-bundle-id' ? 'b1' : null); }, parentNode: null };
    R.onDecisionClick({ target, preventDefault() {} });
    html = body();
    assert.ok(/Founder hero v3/.test(html), 'the winning historical ad appears when expanded');
    assert.ok(/\$42 CPA/.test(html), 'the winner policy metric is shown in the expanded detail');
    assert.ok(/So what/.test(html) && /Now what/.test(html), 'the so-what / now-what comparison is reachable');
    // Collapsing hides it again.
    R.collapse('b1');
    assert.ok(!/Founder hero v3/.test(body()), 'collapsing hides the winners comparison again');
  });

  // ── A single bundle still renders the original detail view, not a grid. ──
  await check('a single bundle renders the original detail view (not a grid)', async () => {
    const st = makeStore({ only: scorecard('pass', 0.9) });
    const { body } = await bootGrid([bundle('only', 'Solo concept')], st.store, makeFeedbackFake());
    const html = body();
    assert.ok(!/rev-cards/.test(html), 'no grid container for a single bundle');
    assert.ok(/rev-bundle"/.test(html), 'the single-bundle detail block is rendered');
    assert.ok(/Founder hero v3/.test(html), 'winners are shown inline in the single-bundle detail view');
  });

  // ── Live-path safety unchanged: no REVIEW config still injects nothing and never posts. ──
  await check('live-path safety preserved: no REVIEW config injects nothing and never posts a coherence request', async () => {
    let fetched = 0;
    const ctx = makeCtx(undefined, async () => { fetched += 1; return jsonResponse({ exists: true }); });
    await ctx.window.initReview();
    assert.strictEqual(fetched, 0, 'no probe and no coherence call without a REVIEW config');
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link on a live client dashboard');
  });
}

(async () => {
  await run();
  console.log('\nRoadmap #5 OK - ' + passed + ' checks passed.');
})().catch((e) => { console.error('\nRoadmap #5 FAILED:', (e && e.stack) || e); process.exit(1); });
