/**
 * US-009 - In-app compile, review, tweak and submit surface (f10-brief-editor.js).
 *
 * The Brief Editor gains a compile/review/tweak/submit surface that lives on one
 * screen. This suite proves it fully offline, dependency-free (no jsdom, no
 * network, no real backend): the compile/submit/status backend responses are
 * STUBBED on the injectable store, exactly as US-004 stubs probe/load/save.
 *
 * It covers the US-009 acceptance criteria + e2e tests:
 *   - Compile renders the compiled brief inline: per-variant resolved prompt(s),
 *     the copy, inspiration thumbnails with any warnings, the size set, and the
 *     cost estimate (files, generations, estimated USD, remaining cap) (AC1, e2e 1);
 *   - the resolved prompt text + copy are EDITABLE, and the edits are what get
 *     submitted - a round-trip asserts an edited prompt is the prompt sent to
 *     submit (AC2, e2e 2);
 *   - Submit starts generation, shows live progress, and drops in results as they
 *     land through /status polling (AC3);
 *   - when the estimate exceeds the remaining cap, Submit is disabled with a clear
 *     message and is a no-op guard (AC4, e2e 3);
 *   - the compile/submit/status endpoints derive off the brief endpoint, and a
 *     store that only stubs probe/load/save still has them backed by the default.
 *
 * Run: node test/us-009-compile-submit.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'f10-brief-editor.js'), 'utf8');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

/* The tiny DOM from the US-004 suite: getElementById caches a slot per id (so a
 * value or innerHTML written by the module is read back), insertAdjacentHTML
 * appends, and querySelector resolves the sidebar nav. Enough to drive compile ->
 * edit -> submit -> poll without jsdom. */
function makeTinyDom() {
  const slots = {};
  function mkSlot(id) {
    return {
      id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false, style: {}, dataset: {},
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

function makeBrowserCtx(config) {
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'moshy_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: async () => { throw new Error('no network in tests'); },
    setTimeout, clearTimeout,
    _slots: slots,
  };
  if (config !== undefined) sandbox.BRIEF_EDITOR = config;
  vm.createContext(sandbox);
  vm.runInContext(EDITOR_SRC, sandbox, { filename: 'f10-brief-editor.js' });
  return sandbox;
}

function contentHtml(ctx) { return (ctx._slots['content'] && ctx._slots['content'].innerHTML) || ''; }
function compiledHtml(ctx) { return (ctx._slots['be-compiled'] && ctx._slots['be-compiled'].innerHTML) || ''; }
function progressHtml(ctx) { return (ctx._slots['be-progress'] && ctx._slots['be-progress'].innerHTML) || ''; }

/* A realistic /compile response (US-007 handle_compile shape). exceeds_cap false. */
function compileResponse(overrides) {
  return Object.assign({
    ok: true,
    client: 'moshy',
    variant_count: 2,
    sizes: [[1080, 1080], [1080, 1350], [1080, 1920]],
    variants: [
      {
        brief_id: 'brief_a', archetype_id: 'arch1', scene_only: false, winning_values: {},
        prompts: [{ component_role: 'background', prompt: 'A calm minimal studio scene, one person' }],
        copy: [{ role: 'headline', text: 'Sleep better tonight' }, { role: 'body', text: 'Clinically formulated.' }],
        inspiration_images: [
          { uri: 'gs://f10-creative-assets/served/meta/a.png', warning: null },
          { uri: 'gs://f10-creative-assets/served/meta/b.png', warning: 'unreadable: not an image' },
        ],
      },
      {
        brief_id: 'brief_b', archetype_id: 'arch1', scene_only: false, winning_values: {},
        prompts: [{ component_role: 'background', prompt: 'A bold graphic hero, high contrast' }],
        copy: [{ role: 'headline', text: 'Wake up ready' }],
        inspiration_images: [],
      },
    ],
    warnings: ['1 inspiration image could not be read and was skipped.'],
    cost_estimate: {
      files_produced: 6, unique_image_generations: 2, per_image_usd: 0.02,
      estimated_usd: 0.04, remaining_cap_usd: 25, exceeds_cap: false, generation_hard_cap_usd: 25,
    },
  }, overrides || {});
}

async function run() {
  console.log('US-009 compile / review / tweak / submit surface');

  // ── The panel carries the compile controls, compiled container, submit bar +
  //     progress area (static markup, probe-gated like the rest of the panel). ──
  await check('the panel renders the compile button, compiled container, submit bar + progress area', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    const html = contentHtml(ctx);
    assert.ok(/id="be-compile-btn"/.test(html), 'Compile button present');
    assert.ok(/id="be-compiled"/.test(html), 'compiled-brief container present');
    assert.ok(/id="be-submit-bar"/.test(html), 'submit bar present');
    assert.ok(/id="be-submit-btn"/.test(html), 'Submit button present');
    assert.ok(/id="be-progress"/.test(html), 'progress area present');
  });

  // ── AC1 / e2e 1: Compile renders per-variant resolved prompts, copy, inspiration
  //     thumbnails + warnings, the size set and the cost estimate, all inline. ──
  await check('Compile renders resolved prompts, copy, inspiration warnings, sizes and cost inline (e2e 1)', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return compileResponse(); },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief();
    const html = compiledHtml(ctx);

    // Per-variant resolved prompts + copy (both variants).
    assert.ok(html.indexOf('A calm minimal studio scene, one person') !== -1, 'variant A prompt rendered');
    assert.ok(html.indexOf('A bold graphic hero, high contrast') !== -1, 'variant B prompt rendered');
    assert.ok(html.indexOf('Sleep better tonight') !== -1, 'variant A headline copy rendered');
    assert.ok(html.indexOf('Clinically formulated.') !== -1, 'variant A body copy rendered');
    assert.ok(/Variant 1/.test(html) && /Variant 2/.test(html), 'both variants labelled');

    // The prompt + copy fields are EDITABLE textareas (not static text).
    assert.ok(/<textarea[^>]*data-be-edit="prompt"/.test(html), 'prompts are editable textareas');
    assert.ok(/<textarea[^>]*data-be-edit="copy"/.test(html), 'copy is editable textareas');

    // Inspiration + warnings (per-image warning and the top-level warning).
    assert.ok(html.indexOf('unreadable: not an image') !== -1, 'per-image inspiration warning shown');
    assert.ok(html.indexOf('1 inspiration image could not be read and was skipped.') !== -1, 'top-level warning shown');

    // The size set.
    assert.ok(/1080x1080/.test(html) && /1080x1350/.test(html) && /1080x1920/.test(html), 'the three Meta sizes shown');

    // The cost estimate: files, generations, estimated USD, remaining cap.
    assert.ok(/Files:\s*6/.test(html), 'files produced shown');
    assert.ok(/Generations:\s*2/.test(html), 'unique generations shown');
    assert.ok(/Estimated:\s*\$0\.04/.test(html), 'estimated USD shown');
    assert.ok(/Remaining cap:\s*\$25\.00/.test(html), 'remaining cap shown');

    // Under cap -> submit bar revealed, Submit enabled with a ready message.
    assert.strictEqual(ctx._slots['be-submit-bar'].style.display, '', 'submit bar revealed after compile');
    assert.strictEqual(ctx._slots['be-submit-btn'].disabled, false, 'Submit enabled under cap');
    assert.ok(/Ready to generate/.test(ctx._slots['be-submit-note'].textContent), 'a ready-to-generate note is shown');
  });

  // ── AC1: compile carries the seed inputs (revision id, creative direction,
  //     inspiration) so what compiles reflects the current brief context. ──
  await check('Compile sends the current revision id, creative direction and inspiration as the seed', async () => {
    const ctx = makeBrowserCtx();
    let req = null;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile(p) { req = p; return compileResponse(); },
    });
    await ctx.window.initBriefEditor();
    ctx.document.getElementById('be-direction').value = 'higher BMI subjects, warm and authentic';
    ctx.document.getElementById('be-load-id').value = 'rev_seed_123';
    ctx.window.f10BriefEditor.selectRef({ gcs_uri: 'gs://f10-creative-assets/served/meta/pick.png', thumb_url: 't' });
    await ctx.window.f10BriefEditor.compileBrief();

    assert.ok(req, 'compile was called');
    assert.strictEqual(req.creativeDirection, 'higher BMI subjects, warm and authentic', 'creative direction forwarded');
    assert.strictEqual(req.revisionId, 'rev_seed_123', 'the revision id to seed from is forwarded');
    assert.deepStrictEqual(Array.from(req.baseInspirationImageUris),
      ['gs://f10-creative-assets/served/meta/pick.png'], 'selected inspiration is forwarded');
    assert.strictEqual(req.client, 'moshy', 'the resolved client is forwarded');
  });

  // ── AC2 / e2e 2: edit a resolved prompt, submit, and the EDITED prompt is the one
  //     sent to the backend (the round-trip that proves edits are what generate). ──
  await check('an edited prompt is the prompt sent to submit; unedited copy carries through (e2e 2)', async () => {
    const ctx = makeBrowserCtx();
    let submitted = null;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() {
        return compileResponse({
          variant_count: 1,
          variants: [{
            brief_id: 'brief_only', archetype_id: 'arch1', scene_only: false, winning_values: {},
            prompts: [{ component_role: 'background', prompt: 'ORIGINAL PROMPT' }],
            copy: [{ role: 'headline', text: 'ORIGINAL HEADLINE' }],
            inspiration_images: [],
          }],
          warnings: [],
        });
      },
      async submit(p) { submitted = p; return { ok: true, job_id: 'job_rt', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'running', bundles_total: 1, bundles_completed: 0, asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief();

    // The operator edits the resolved prompt in the textarea. applyCompiledEdit is
    // exactly what the delegated textarea `input` handler calls, so this is the DOM
    // edit path, not a shortcut around it.
    ctx.window.f10BriefEditor.applyCompiledEdit('prompt', 0, 0, 'EDITED PROMPT XYZ');

    await ctx.window.f10BriefEditor.submitCompiled();
    ctx.window.f10BriefEditor.stopPolling(); // clear the auto-poll timer so the test exits

    assert.ok(submitted, 'submit was called');
    const cb = submitted.compiledBrief;
    assert.ok(cb && Array.isArray(cb.variants) && cb.variants.length === 1, 'the approved compiled brief was sent');
    assert.strictEqual(cb.variants[0].prompts[0].prompt, 'EDITED PROMPT XYZ', 'the EDITED prompt is what is submitted');
    assert.strictEqual(cb.variants[0].brief_id, 'brief_only', 'brief_id carried so the backend matches the edit');
    assert.strictEqual(cb.variants[0].copy[0].text, 'ORIGINAL HEADLINE', 'an unedited copy block carries through unchanged');
    // Submit re-sends the same seed inputs so the backend re-resolves identical briefs.
    assert.deepStrictEqual(cb.sizes, [[1080, 1080], [1080, 1350], [1080, 1920]], 'the compiled size set is submitted');
  });

  // ── AC2: an edited copy block is also what gets submitted. ──
  await check('an edited copy block is the copy sent to submit', async () => {
    const ctx = makeBrowserCtx();
    let submitted = null;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return compileResponse(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'j', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'completed', asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief();
    ctx.window.f10BriefEditor.applyCompiledEdit('copy', 0, 0, 'EDITED HEADLINE!');
    await ctx.window.f10BriefEditor.submitCompiled();
    ctx.window.f10BriefEditor.stopPolling();
    assert.strictEqual(submitted.compiledBrief.variants[0].copy[0].text, 'EDITED HEADLINE!', 'the edited copy is submitted');
    assert.strictEqual(submitted.compiledBrief.variants[0].copy[1].text, 'Clinically formulated.', 'the other copy block is unchanged');
  });

  // ── AC4 / e2e 3: an over-cap estimate disables Submit with a clear message, and
  //     Submit is a no-op guard even if forced. ──
  await check('an over-cap estimate disables Submit with a message and blocks generation (e2e 3)', async () => {
    const ctx = makeBrowserCtx();
    let submitCalls = 0;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() {
        return compileResponse({
          cost_estimate: {
            files_produced: 27, unique_image_generations: 9, per_image_usd: 3.4,
            estimated_usd: 30.6, remaining_cap_usd: 25, exceeds_cap: true, generation_hard_cap_usd: 25,
          },
        });
      },
      async submit() { submitCalls += 1; return { ok: true, job_id: 'nope' }; },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief();

    assert.strictEqual(ctx._slots['be-submit-btn'].disabled, true, 'Submit is disabled over cap');
    const note = ctx._slots['be-submit-note'].textContent;
    assert.ok(/exceeds the remaining cap/.test(note), 'the message explains the estimate exceeds the cap');
    assert.ok(/\$30\.60/.test(note) && /\$25\.00/.test(note), 'the message shows the estimate and the cap');

    // Even if a click reaches submitCompiled, it is a no-op guard - nothing is sent.
    await ctx.window.f10BriefEditor.submitCompiled();
    assert.strictEqual(submitCalls, 0, 'no submit is sent while over cap');
  });

  // ── AC3: Submit starts generation and drops in results as they land via /status. ──
  await check('Submit starts generation, shows live progress, and drops in results as they land (AC3)', async () => {
    const ctx = makeBrowserCtx();
    let statusCalls = 0;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return compileResponse(); },
      async submit() { return { ok: true, job_id: 'job9', status: 'running', variant_count: 2 }; },
      async status() {
        statusCalls += 1;
        if (statusCalls === 1) {
          return { ok: true, job: { job_id: 'job9', status: 'running', bundles_total: 2, bundles_completed: 1,
            spend_usd: 0.02, asset_uris: ['gs://out/moshy/1.png'] } };
        }
        return { ok: true, job: { job_id: 'job9', status: 'completed', bundles_total: 2, bundles_completed: 2,
          spend_usd: 0.04, asset_uris: ['gs://out/moshy/1.png', 'gs://out/moshy/2.png'] } };
      },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief();
    await ctx.window.f10BriefEditor.submitCompiled();
    ctx.window.f10BriefEditor.stopPolling(); // drive polling by hand instead of the timer

    // Initial running state is shown immediately after submit.
    assert.ok(/Generation:\s*running/.test(progressHtml(ctx)), 'live progress shows the job is running');
    assert.strictEqual(ctx.window.f10BriefEditor.getJobId(), 'job9', 'the job id is tracked for polling');

    // First poll: one result has landed.
    await ctx.window.f10BriefEditor.pollStatusOnce('job9');
    let html = progressHtml(ctx);
    assert.ok(/1\/2 bundles/.test(html), 'progress counter updates as bundles complete');
    assert.ok(html.indexOf('gs://out/moshy/1.png') !== -1, 'the first result is dropped in as it lands');

    // Second poll: the job completes and both results are shown.
    await ctx.window.f10BriefEditor.pollStatusOnce('job9');
    html = progressHtml(ctx);
    assert.ok(/Generation:\s*completed/.test(html), 'the job reaches completed');
    assert.ok(/2\/2 bundles/.test(html), 'all bundles counted');
    assert.ok(html.indexOf('gs://out/moshy/1.png') !== -1 && html.indexOf('gs://out/moshy/2.png') !== -1,
      'both results are shown as they land');
  });

  // ── The compile/submit/status endpoints derive off the brief endpoint. ──
  await check('compile / submit / status endpoints derive off the brief endpoint', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    assert.strictEqual(be.compileEndpoint(), 'https://fn.example/.netlify/functions/compile');
    assert.strictEqual(be.submitEndpoint(), 'https://fn.example/.netlify/functions/submit');
    assert.strictEqual(be.statusEndpoint(), 'https://fn.example/.netlify/functions/status');
    // Explicit brief endpoint config still derives the siblings from it.
    const ctx2 = makeBrowserCtx({ ENDPOINT: '/api/brief' });
    assert.strictEqual(ctx2.window.f10BriefEditor.compileEndpoint(), '/api/compile');
    assert.strictEqual(ctx2.window.f10BriefEditor.submitEndpoint(), '/api/submit');
    assert.strictEqual(ctx2.window.f10BriefEditor.statusEndpoint(), '/api/status');
  });

  // ── A store that only stubs probe/load/save still has compile backed by the
  //     default network store (it fails closed on the no-network test fetch, proving
  //     the method was wired rather than missing). ──
  await check('an injected store missing compile is backed by the default (fails closed, not undefined)', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief(); // hits the net default -> throws no-network -> handled
    assert.ok(/Failed to compile/.test(compiledHtml(ctx)), 'compile is backed by the default and fails closed, not "undefined is not a function"');
  });
}

(async () => {
  await run();
  console.log(`\n${passed} checks passed.`);
})().catch((err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
