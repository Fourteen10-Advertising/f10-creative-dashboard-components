/**
 * Creative Review batch grid (f10-review.js).
 *
 * Extends the US-007 / US-009 Creative Review module: when more than one bundle is visible
 * the DEFAULT view is a grid of cards in discovery order, so a human reviewer can look over a
 * whole batch at once. Bundles are auto-discovered through the store's list-bundles method.
 * There is no automated score or rank on the cards.
 *
 * Fully offline and dependency-free (no jsdom): the real f10-review.js is loaded into a vm
 * sandbox with a tiny DOM stub, and BOTH the discovery/preview store and the feedback client
 * are injected fakes. Covers:
 *   - the grid renders one card per bundle in discovery order, each with its thumbnail and
 *     decision gate, and no rank badge or scorecard;
 *   - approve / decline + persisted-state still work per card through the existing feedback seam;
 *   - a single visible bundle renders the detail view (not a grid);
 *   - live-path safety: no endpoint and no store means no network and no tab.
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

/* A discovered bundle. Bundles in one test share a generation date so the grid shows
 * them together; the date-filter behaviour is covered in f10-review.test.js. */
function bundle(id, label, date) {
  return {
    bundle_id: id, platform: 'meta', label: label || id, date: date || '2026-08-20',
    components: { hook_type: 'Founder story' },
    held_dimensions: ['visual_style_canonical'],
    new_ad: { headline: 'Meet the founder' },
  };
}

/* Build a store that serves a signed preview per bundle. The list-bundles discovery is
 * wired per-boot in bootGrid. */
function makeStore() {
  return {
    store: {
      async preview(client, id) { return { url: 'https://signed.example/' + id + '.png' }; },
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

/* Boot a loaded grid for the given bundles + injected store/feedback fakes. The bundles
 * are served through the store's list-bundles discovery, exactly as production loads them. */
async function bootGrid(bundles, storeObj, feedbackFake) {
  const cfg = { CLIENT: 'moshy', ACTOR: 'zac@f10' };
  const ctx = makeCtx(cfg);
  const R = ctx.window.f10Review;
  storeObj.listBundles = async () => ({ bundles: bundles });
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
  const re = /class="rev-card"\s+data-bundle-id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) ids.push(m[1]);
  return ids;
}

async function run() {
  console.log('Creative Review batch grid');

  // ── Grid renders one card per bundle, in discovery order, with no score or rank. ──
  await check('the grid renders one card per bundle in discovery order, with no rank badge or scorecard', async () => {
    const bundles = [bundle('first'), bundle('second'), bundle('third'), bundle('fourth')];
    const { body } = await bootGrid(bundles, makeStore().store, makeFeedbackFake());
    const html = body();
    assert.ok(/rev-cards/.test(html), 'a grid container is rendered');
    assert.deepStrictEqual(cardOrder(html), ['first', 'second', 'third', 'fourth'],
      'cards keep the discovery order');
    // Each card carries its thumbnail and its decision gate.
    assert.strictEqual((html.match(/rev-card-thumb"/g) || []).length, 4, 'one thumbnail per card');
    assert.ok(/src="https:\/\/signed\.example\/first\.png"/.test(html), 'the signed preview is the thumbnail');
    assert.strictEqual((html.match(/data-rev-action="approve"/g) || []).length, 4, 'one approve control per card');
    // No automated score, verdict or rank rides on the cards.
    assert.ok(!/rev-rank|rev-scorecard|data-rev-verdict|data-rev-scored/.test(html), 'no rank badge or scorecard');
  });

  // ── Approve / decline + persisted state work per card, and survive a reload. ──
  await check('approve / decline work per card and the persisted state survives a reload', async () => {
    const bundles = [bundle('b1'), bundle('b2'), bundle('b3')];
    const fb = makeFeedbackFake();
    const { R, body } = await bootGrid(bundles, makeStore().store, fb);

    await R.approve('b1');
    await R.decline('b2', '  off-brand tone  ');
    assert.strictEqual(R.statusOf('b1').state, 'approved', 'b1 approved');
    assert.strictEqual(R.statusOf('b2').state, 'declined', 'b2 declined');
    assert.strictEqual(fb.submissions.find((s) => s.bundle_id === 'b2').comment, 'off-brand tone', 'decline reason trimmed + recorded');
    const html = body();
    assert.ok(/data-bundle-id="b1"[\s\S]*?rev-state-approved/.test(html), 'b1 card shows approved');
    assert.ok(/data-bundle-id="b2"[\s\S]*?rev-state-declined/.test(html), 'b2 card shows declined');

    // Reload with a fresh module instance sharing only the persisted feedback backing store.
    const { R: R2, body: body2 } = await bootGrid(bundles, makeStore().store, fb);
    assert.strictEqual(R2.statusOf('b1').state, 'approved', 'reloaded grid shows b1 approved');
    assert.strictEqual(R2.statusOf('b2').state, 'declined', 'reloaded grid shows b2 declined');
    assert.ok(/off-brand tone/.test(body2()), 'the persisted decline reason is read back into the grid');
  });

  // ── A single visible bundle still renders the detail view, not a grid. ──
  await check('a single bundle renders the detail view (not a grid)', async () => {
    const { body } = await bootGrid([bundle('only', 'Solo concept')], makeStore().store, makeFeedbackFake());
    const html = body();
    assert.ok(!/rev-cards/.test(html), 'no grid container for a single bundle');
    assert.ok(/rev-bundle"/.test(html), 'the single-bundle detail block is rendered');
    assert.ok(/data-bundle-id="only"/.test(html), 'the discovered bundle is rendered in the detail view');
    assert.ok(/visual_style_canonical/.test(html), 'the bundle held dimensions render in the detail view');
  });

  // ── Live-path safety: no BQ_FUNCTION AND no injected store injects nothing and never posts. ──
  await check('live-path safety preserved: no endpoint and no store injects nothing and never posts', async () => {
    let fetched = 0;
    const { document, slots } = makeTinyDom();
    const window = {}; window.F10A = { track() {} };
    const sandbox = {
      window, document, console, F10A: window.F10A,
      PROJECT: 'mcc-poc-477801', DATASET: 'moshy_marts',
      fetch: async () => { fetched += 1; return jsonResponse({ bundles: [bundle('b1')] }); },
      setTimeout, clearTimeout, _slots: slots,
    };
    // No BQ_FUNCTION and no REVIEW config at all.
    vm.createContext(sandbox);
    vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
    vm.runInContext(REVIEW, sandbox, { filename: 'f10-review.js' });
    await sandbox.window.initReview();
    assert.strictEqual(fetched, 0, 'no discovery or preview call without an endpoint or store');
    const nav = (slots['__nav'] && slots['__nav'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link on the live path');
  });
}

(async () => {
  await run();
  console.log('\nCreative Review batch grid OK - ' + passed + ' checks passed.');
})().catch((e) => { console.error('\nCreative Review batch grid FAILED:', (e && e.stack) || e); process.exit(1); });
