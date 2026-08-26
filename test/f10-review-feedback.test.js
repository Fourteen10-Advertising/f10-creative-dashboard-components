/**
 * US-009 - Approve / decline UI and approval state (f10-review.js).
 *
 * Extends the US-007 Creative Review module with a coarse concept-level decision gate:
 * each ad has an approve and a decline control (plus an optional comment on decline), the
 * decision is recorded via the US-008 feedback WRITE path, and the approval state
 * (approved / declined / pending) is visible in the panel and survives a reload because it
 * is read back from the feedback / status source. Refinement is a Figma designer pass after
 * approval - there is deliberately NO LLM regenerate / re-prompt loop.
 *
 * Fully offline and dependency-free (no jsdom, no live services): the real f10-review.js is
 * loaded into a vm sandbox with a tiny DOM stub, and BOTH the winners/preview store and the
 * feedback client are injected fakes. The feedback fake mirrors the US-008 contract exactly -
 * submit takes { client, platform, bundle_id, state, comment?, actor? } and returns the
 * endpoint's success payload (no actor field); read returns the persisted status.json sidecar
 * shape (with actor) or null when there is no decision yet - so this test pins the real
 * contract, not a convenient shape.
 *
 * Covers: approve sets approved + the UI reflects it; decline records the reason (with the
 * optional comment) and marks the ad not-servable; the three visible states render; the
 * persisted state survives a reload (re-read); the exact US-008 write contract is posted; a
 * write failure surfaces inline; and the panel makes the no-regenerate / Figma-refinement
 * rule explicit.
 *
 * Run: node test/f10-review-feedback.test.js
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

function sampleBundle() {
  return {
    bundle_id: 'brief_moshy_founder_ab12cd',
    platform: 'meta',
    date: '2026-08-20',
    label: 'Founder story - bold typographic',
    components: { hook_type: 'Founder story' },
    new_ad: { headline: 'Meet the founder' },
  };
}

/* The discovery/preview store standing in for list-bundles + generated-preview: it
 * discovers the one sample bundle and signs its preview. The decision gate does not
 * depend on the preview shape. */
function reviewStore() {
  return {
    async listBundles() { return { bundles: [sampleBundle()] }; },
    async preview() { return { url: 'https://signed.example/new-composite.png' }; },
  };
}

/* A fake feedback client that mirrors the US-008 endpoint + status.json sidecar EXACTLY,
 * with an in-memory backing store so a decision persists across a reload. Records every
 * submitted record so the test can assert the posted contract. */
function makeFeedbackFake(opts) {
  opts = opts || {};
  const store = {};            // key -> persisted status.json sidecar (incl. actor)
  const submissions = [];      // every record submitted, in order
  const VALID = ['approved', 'declined', 'pending'];
  const key = (r) => r.client + '/' + r.platform + '/' + r.bundle_id;
  return {
    submissions,
    store,
    client: {
      async submit(record) {
        submissions.push(record);
        if (opts.failSubmit) throw new Error(opts.failSubmit === true ? 'endpoint 502' : String(opts.failSubmit));
        // Mirror the endpoint's validation surface (fail closed on a bad state).
        assert.ok(VALID.indexOf(record.state) !== -1, 'endpoint only accepts valid states');
        const when = '2026-08-20T00:00:00.000Z';
        // The status.json sidecar the (future) bundle service reads: includes actor.
        store[key(record)] = {
          client: record.client,
          bundle_id: record.bundle_id,
          platform: record.platform,
          state: record.state,
          comment: record.comment == null ? null : record.comment,
          actor: record.actor == null ? null : record.actor,
          updated_at: when,
        };
        // The endpoint success payload: note there is NO actor field here (matches US-008).
        return {
          ok: true,
          client: record.client,
          bundle_id: record.bundle_id,
          platform: record.platform,
          state: record.state,
          status_path: 'gs://f10-creative-assets/components/' + record.platform + '/' + record.client + '/' + record.bundle_id + '/status.json',
          updated_at: when,
        };
      },
      async read(client, id, platform) {
        const rec = store[client + '/' + platform + '/' + id];
        return rec ? Object.assign({}, rec) : null;
      },
    },
  };
}

/* Tiny DOM stub: just enough for the real render/activation code to run unchanged. */
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

function makeCtx(reviewConfig) {
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'moshy_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: async () => jsonResponse({}),
    setTimeout, clearTimeout,
    _slots: slots,
  };
  if (reviewConfig !== undefined) sandbox.REVIEW = reviewConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(REVIEW, sandbox, { filename: 'f10-review.js' });
  return sandbox;
}

/* Boot a loaded review panel for one bundle with injected fakes, and return handles. */
async function bootLoaded(feedbackFake, config) {
  const cfg = Object.assign({ CLIENT: 'moshy', ACTOR: 'zac@f10', BUNDLES: [sampleBundle()] }, config || {});
  const ctx = makeCtx(cfg);
  const R = ctx.window.f10Review;
  R.setStore(reviewStore());
  R.setFeedbackClient(feedbackFake.client);
  R.setClient('moshy');
  await R.load();
  const body = () => (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
  return { ctx, R, body, id: sampleBundle().bundle_id };
}

async function run() {
  console.log('US-009 Approve / decline UI + approval state');

  // ── Pending is the initial visible state (no persisted decision yet). ──
  await check('a bundle with no persisted decision loads as pending, with approve + decline controls', async () => {
    const fb = makeFeedbackFake();
    const { R, body, id } = await bootLoaded(fb);
    assert.strictEqual(R.statusOf(id).state, 'pending', 'initial state is pending');
    const html = body();
    assert.ok(/rev-state-pending/.test(html), 'pending badge rendered');
    assert.ok(/Pending/.test(html), 'pending label shown');
    assert.ok(/data-rev-action="approve"/.test(html), 'approve control present');
    assert.ok(/data-rev-action="decline"/.test(html), 'decline control present');
    assert.ok(/<textarea[^>]*rev-comment/.test(html), 'an optional decline comment box is present');
  });

  // ── AC2: approve sets the approved flag via US-008 and the UI reflects it. ──
  await check('approve posts state=approved to the US-008 write path and the UI reflects approved', async () => {
    const fb = makeFeedbackFake();
    const { R, body, id } = await bootLoaded(fb);
    await R.approve(id);

    // Posted the exact US-008 contract.
    assert.strictEqual(fb.submissions.length, 1, 'one decision posted');
    const rec = fb.submissions[0];
    assert.deepStrictEqual(Object.keys(rec).sort(), ['actor', 'bundle_id', 'client', 'comment', 'platform', 'state'].sort(), 'posts exactly the US-008 fields');
    assert.strictEqual(rec.client, 'moshy');
    assert.strictEqual(rec.platform, 'meta');
    assert.strictEqual(rec.bundle_id, id);
    assert.strictEqual(rec.state, 'approved');
    assert.strictEqual(rec.comment, null, 'approve carries no decline comment');
    assert.strictEqual(rec.actor, 'zac@f10', 'the configured actor is recorded');

    // UI reflects the new state.
    assert.strictEqual(R.statusOf(id).state, 'approved', 'in-memory state is approved');
    const html = body();
    assert.ok(/rev-state-approved/.test(html), 'approved badge class rendered');
    assert.ok(/Approved/.test(html), 'approved label shown');
    assert.ok(/Servable/.test(html), 'approved ad is shown servable');
    assert.ok(/aria-pressed="true"[^>]*>Approve|rev-approve[^>]*aria-pressed="true"/.test(html), 'approve control shows the pressed state');
  });

  // ── AC1 + AC2: decline records the reason (optional comment) and marks not-servable. ──
  await check('decline posts state=declined with the optional comment and marks the ad not-servable', async () => {
    const fb = makeFeedbackFake();
    const { R, body, id } = await bootLoaded(fb);
    await R.decline(id, '  off-brand tone  ');

    const rec = fb.submissions[0];
    assert.strictEqual(rec.state, 'declined');
    assert.strictEqual(rec.comment, 'off-brand tone', 'the decline reason is trimmed and recorded');

    assert.strictEqual(R.statusOf(id).state, 'declined', 'in-memory state is declined');
    assert.strictEqual(R.statusOf(id).comment, 'off-brand tone', 'the reason is kept for display');
    const html = body();
    assert.ok(/rev-state-declined/.test(html), 'declined badge class rendered');
    assert.ok(/Declined/.test(html), 'declined label shown');
    assert.ok(/Not servable/.test(html), 'declined ad is marked not-servable');
    assert.ok(/off-brand tone/.test(html), 'the decline reason is visible');
  });

  // ── AC1: decline with NO comment is allowed (the comment is optional). ──
  await check('decline with no comment is allowed and posts a null comment', async () => {
    const fb = makeFeedbackFake();
    const { R, id } = await bootLoaded(fb);
    await R.decline(id, '');
    assert.strictEqual(fb.submissions[0].state, 'declined');
    assert.strictEqual(fb.submissions[0].comment, null, 'an empty reason posts as null (optional)');
    assert.strictEqual(R.statusOf(id).state, 'declined');
  });

  // ── AC3: all three visible states render distinctly. ──
  await check('the three visible states (approved / declined / pending) each render with their own badge', async () => {
    const fb = makeFeedbackFake();
    const { R } = await bootLoaded(fb);
    const id = sampleBundle().bundle_id;
    // pending
    assert.ok(/rev-state-pending"[^>]*>Pending/.test(R.decisionHtml(sampleBundle())), 'pending renders');
    await R.approve(id);
    assert.ok(/rev-state-approved"[^>]*>Approved/.test(R.decisionHtml(sampleBundle())), 'approved renders');
    await R.decline(id, 'changed our mind');
    assert.ok(/rev-state-declined"[^>]*>Declined/.test(R.decisionHtml(sampleBundle())), 'declined renders');
  });

  // ── AC3 (the key one): the persisted state survives a reload (re-read from the source). ──
  await check('persisted state survives a reload: a re-read shows the stored decision (with actor + comment)', async () => {
    const fb = makeFeedbackFake();
    const { R, id } = await bootLoaded(fb);
    await R.decline(id, 'wrong hero shot');
    assert.strictEqual(R.statusOf(id).state, 'declined');

    // Simulate reloading the surface with a FRESH module instance that shares only the
    // persisted feedback backing store (as a real page reload would re-read status.json).
    const ctx2 = makeCtx({ CLIENT: 'moshy', ACTOR: 'someone-else', BUNDLES: [sampleBundle()] });
    const R2 = ctx2.window.f10Review;
    R2.setStore(reviewStore());
    R2.setFeedbackClient(fb.client);   // same backing store (the persisted source)
    R2.setClient('moshy');
    await R2.load();

    const st = R2.statusOf(id);
    assert.strictEqual(st.state, 'declined', 'the reloaded surface shows the persisted declined state');
    assert.strictEqual(st.comment, 'wrong hero shot', 'the persisted reason is read back');
    assert.strictEqual(st.actor, 'zac@f10', 'the actor from the persisted sidecar is read back (not the reader identity)');
    const html2 = (ctx2._slots['rev-body'] && ctx2._slots['rev-body'].innerHTML) || '';
    assert.ok(/rev-state-declined/.test(html2) && /wrong hero shot/.test(html2), 'the reloaded panel renders the persisted decision');
  });

  // ── Reload reflects an approval too, and a later reload with no store change stays put. ──
  await check('reload reflects a persisted approval read back from the source', async () => {
    const fb = makeFeedbackFake();
    const { R, id } = await bootLoaded(fb);
    await R.approve(id);
    const ctx2 = makeCtx({ CLIENT: 'moshy', BUNDLES: [sampleBundle()] });
    const R2 = ctx2.window.f10Review;
    R2.setStore(reviewStore());
    R2.setFeedbackClient(fb.client);
    R2.setClient('moshy');
    await R2.load();
    assert.strictEqual(R2.statusOf(id).state, 'approved', 'reload shows approved');
  });

  // ── Delegated click wiring: onDecisionClick approves the right bundle. ──
  await check('the delegated click handler routes an approve click to the right bundle', async () => {
    const fb = makeFeedbackFake();
    const { ctx, R, id } = await bootLoaded(fb);
    // Fake a click on the approve button for this bundle.
    const target = {
      getAttribute(k) { return k === 'data-rev-action' ? 'approve' : (k === 'data-bundle-id' ? id : null); },
      parentNode: null,
    };
    const evt = { target, preventDefault() {} };
    await R.onDecisionClick(evt);
    // onDecisionClick is not awaitable end-to-end (it fires submitDecision), so drain microtasks.
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fb.submissions.length, 1, 'the click posted one decision');
    assert.strictEqual(fb.submissions[0].state, 'approved');
    assert.strictEqual(R.statusOf(id).state, 'approved');
    assert.ok(ctx, 'context intact');
  });

  // ── The delegated decline click reads the reason from the bundle's comment box. ──
  await check('a decline click reads the optional reason from the comment textarea', async () => {
    const fb = makeFeedbackFake();
    const { ctx, R, id } = await bootLoaded(fb);
    // Stub the comment box the handler will read.
    ctx._slots['rev-comment-' + id] = { value: 'too much text' };
    const target = {
      getAttribute(k) { return k === 'data-rev-action' ? 'decline' : (k === 'data-bundle-id' ? id : null); },
      parentNode: null,
    };
    await R.onDecisionClick({ target, preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fb.submissions[0].state, 'declined');
    assert.strictEqual(fb.submissions[0].comment, 'too much text', 'the reason came from the textarea');
  });

  // ── A write failure surfaces inline and does not corrupt state. ──
  await check('a failed decision surfaces inline and leaves the state unchanged (fails loud, not silent)', async () => {
    const fb = makeFeedbackFake({ failSubmit: 'network down' });
    const { R, body, id } = await bootLoaded(fb);
    await R.approve(id);
    assert.strictEqual(R.statusOf(id).state, 'pending', 'the state did not change on a failed write');
    assert.ok(/network down/.test(R.decisionError(id)), 'the error is recorded for the bundle');
    assert.ok(/Could not save decision/.test(body()), 'the panel shows the failure inline');
  });

  // ── AC4: no LLM regenerate / re-prompt loop; refinement is a Figma pass after approval. ──
  await check('the panel states refinement is a Figma pass and exposes NO regenerate / re-prompt control', async () => {
    const fb = makeFeedbackFake();
    const { ctx, body } = await bootLoaded(fb);
    const decision = body();
    const panel = ctx.window.f10Review.panelMarkup();
    assert.ok(/Figma/.test(decision) || /Figma/.test(panel), 'the Figma-refinement rule is stated');
    // There must be no regenerate / re-prompt / re-run affordance anywhere in the surface.
    const combined = decision + panel;
    assert.ok(!/regenerate/i.test(combined) || /no regenerate/i.test(combined), 'no regenerate control (only the explicit "no regenerate" note is allowed)');
    assert.ok(!/data-rev-action="(regenerate|reprompt|re-prompt|rerun)"/i.test(combined), 'no regenerate/re-prompt action control');
    assert.ok(!/re-?prompt/i.test(decision) || /no .*re-?prompt|re-?prompt (step|loop)/i.test(decision), 'no re-prompt affordance beyond the explanatory note');
  });

  // ── Live-path safety is unchanged: no BQ_FUNCTION AND no injected store injects nothing. ──
  await check('live-path safety preserved: no endpoint and no store still injects nothing and never posts', async () => {
    let fetched = 0;
    const { document, slots } = makeTinyDom();
    const window = {}; window.F10A = { track() {} };
    const sandbox = {
      window, document, console, F10A: window.F10A,
      PROJECT: 'mcc-poc-477801', DATASET: 'moshy_marts',
      fetch: async () => { fetched += 1; return jsonResponse({ bundles: [sampleBundle()] }); },
      setTimeout, clearTimeout, _slots: slots,
    };
    // No BQ_FUNCTION and no REVIEW config at all.
    vm.createContext(sandbox);
    vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
    vm.runInContext(REVIEW, sandbox, { filename: 'f10-review.js' });
    await sandbox.window.initReview();
    assert.strictEqual(fetched, 0, 'no discovery and no feedback call without an endpoint or store');
    const nav = (slots['__nav'] && slots['__nav'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link on the live path');
  });
}

(async () => {
  await run();
  console.log('\nUS-009 OK - ' + passed + ' checks passed.');
})().catch((e) => { console.error('\nUS-009 FAILED:', (e && e.stack) || e); process.exit(1); });
