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

  // A tiny helper: make querySelectorAll('#be-copy .be-copy-text') return copy nodes
  // (role via data-role, text via value), exactly what readCopy() reads. Anything
  // else resolves to [] like the tiny DOM default.
  function stubCopy(ctx, blocks) {
    const nodes = blocks.map(function (b) {
      return {
        value: b.text,
        getAttribute: function (a) { return a === 'data-role' ? b.role : null; },
      };
    });
    ctx.document.querySelectorAll = function (sel) {
      return sel === '#be-copy .be-copy-text' ? nodes : [];
    };
  }

  // ── US-009 FIX / e2e: Compile resolves the LIVE on-screen brief. The request
  //     carries the current axes AND the copy VERBATIM as an inline `brief`, so no
  //     Save/Load step is needed and "Book your consult" is not dropped to a
  //     default. ──
  await check('Compile sends the live on-screen brief as an inline brief: axes + verbatim copy', async () => {
    const ctx = makeBrowserCtx();
    let req = null;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile(p) { req = p; return compileResponse(); },
    });
    await ctx.window.initBriefEditor();
    // The operator sets each axis + drafts copy on screen (no Save first).
    ctx.document.getElementById('be-axis-visual_style').value = 'ugc-authentic';
    ctx.document.getElementById('be-axis-hook_type').value = 'question';
    ctx.document.getElementById('be-axis-message_angle').value = 'problem-solution';
    ctx.document.getElementById('be-axis-cta_type').value = 'book-now';
    ctx.document.getElementById('be-direction').value = 'warm, authentic, real people';
    stubCopy(ctx, [
      { role: 'headline', text: 'Sleep better tonight' },
      { role: 'cta', text: 'Book your consult' },
    ]);

    await ctx.window.f10BriefEditor.compileBrief();

    assert.ok(req && req.brief, 'the compile request carries an inline brief (the live form)');
    // The four axes are forwarded exactly as set on screen.
    assert.strictEqual(req.brief.visual_style, 'ugc-authentic', 'visual_style axis carried');
    assert.strictEqual(req.brief.hook_type, 'question', 'hook_type axis carried');
    assert.strictEqual(req.brief.message_angle, 'problem-solution', 'message_angle axis carried');
    assert.strictEqual(req.brief.cta_type, 'book-now', 'cta_type axis carried');
    // The copy is carried VERBATIM (US-003: "Book your consult" is not rewritten).
    // Compare via JSON: the brief is built inside the vm realm, so its objects have a
    // different prototype than a main-realm literal and deepStrictEqual would reject
    // them on prototype alone.
    assert.strictEqual(JSON.stringify(req.brief.copy_blocks), JSON.stringify([
      { role: 'headline', text: 'Sleep better tonight' },
      { role: 'cta', text: 'Book your consult' },
    ]), 'the drafted copy is carried verbatim in the inline brief');
    assert.strictEqual(req.brief.creative_direction, 'warm, authentic, real people',
      'creative direction carried on the inline brief');
    // Backward-compat fields still present alongside the inline brief.
    assert.strictEqual(req.creativeDirection, 'warm, authentic, real people',
      'creativeDirection still sent for backward compatibility');
    assert.strictEqual(req.client, 'moshy', 'client scope still sent at the top level');
    assert.strictEqual(req.brief.client, 'moshy',
      'the inline brief carries the client so the backend can enforce scope');
  });

  // ── US-009 FIX: two different on-screen brief states produce materially different
  //     compile payloads (the "same brief no matter what I change" bug is gone). ──
  await check('two different form states produce different compile payloads', async () => {
    const ctx = makeBrowserCtx();
    let req = null;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile(p) { req = p; return compileResponse(); },
    });
    await ctx.window.initBriefEditor();

    // Project only the operator-driven fields (revision_id is a random stamp).
    function project(b) {
      return JSON.stringify({
        visual_style: b.visual_style, hook_type: b.hook_type,
        message_angle: b.message_angle, cta_type: b.cta_type,
        creative_direction: b.creative_direction, copy_blocks: b.copy_blocks,
      });
    }

    // State A.
    ctx.document.getElementById('be-axis-visual_style').value = 'ugc-authentic';
    ctx.document.getElementById('be-axis-cta_type').value = 'book-now';
    ctx.document.getElementById('be-direction').value = 'warm and authentic';
    stubCopy(ctx, [{ role: 'cta', text: 'Book your consult' }]);
    await ctx.window.f10BriefEditor.compileBrief();
    const payloadA = project(req.brief);

    // State B: a different visual style, cta and copy.
    ctx.document.getElementById('be-axis-visual_style').value = 'bold-graphic';
    ctx.document.getElementById('be-axis-cta_type').value = 'learn-more';
    ctx.document.getElementById('be-direction').value = 'high contrast, punchy';
    stubCopy(ctx, [{ role: 'cta', text: 'Start your trial' }]);
    await ctx.window.f10BriefEditor.compileBrief();
    const payloadB = project(req.brief);

    assert.notStrictEqual(payloadA, payloadB, 'changing axes + copy changes the compile payload');
  });

  // ── US-009 FIX: Submit derives from the SAME live on-screen brief as Compile,
  //     so the job generates exactly what the operator saw. ──
  await check('Submit carries the same inline on-screen brief as Compile', async () => {
    const ctx = makeBrowserCtx();
    let submitted = null;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return compileResponse(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'j_live', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'completed', asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    ctx.document.getElementById('be-axis-visual_style').value = 'ugc-authentic';
    ctx.document.getElementById('be-axis-cta_type').value = 'book-now';
    stubCopy(ctx, [{ role: 'cta', text: 'Book your consult' }]);
    await ctx.window.f10BriefEditor.compileBrief();
    await ctx.window.f10BriefEditor.submitCompiled();
    ctx.window.f10BriefEditor.stopPolling();

    assert.ok(submitted && submitted.brief, 'submit carries the inline on-screen brief');
    assert.strictEqual(submitted.brief.visual_style, 'ugc-authentic', 'submit inline brief carries the live axis');
    assert.strictEqual(JSON.stringify(submitted.brief.copy_blocks),
      JSON.stringify([{ role: 'cta', text: 'Book your consult' }]),
      'submit inline brief carries the verbatim copy');
    // And it still sends the approved compiled brief (the edit-overlay path).
    assert.ok(submitted.compiledBrief && Array.isArray(submitted.compiledBrief.variants),
      'submit still sends the approved compiled brief');
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

  // ── Viewable results: a landed composite renders as an <img> thumbnail from the
  //     signed asset_previews[].url (a browser cannot open a gs:// uri), with the
  //     size as a label and a click-through that opens the full signed url. ──
  await check('landed composites render as <img> thumbnails from signed asset_previews', async () => {
    const ctx = makeBrowserCtx();
    const gcs = 'gs://f10-creative-assets/components/meta/Moshy/b1/composite_1080x1080.png';
    const signed = 'https://signed.example/composite_1080x1080.png?sig=abc';
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async status() {
        return { ok: true, job: {
          job_id: 'jobV', status: 'completed', bundles_total: 1, bundles_completed: 1, spend_usd: 0.03,
          asset_uris: [gcs],
          asset_previews: [{ gcs_uri: gcs, url: signed, size: '1080x1080' }],
        } };
      },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.pollStatusOnce('jobV');
    ctx.window.f10BriefEditor.stopPolling();
    const html = progressHtml(ctx);
    assert.ok(html.indexOf('<img') !== -1 && html.indexOf('src="' + signed + '"') !== -1,
      'the landed composite renders as an <img> from the signed preview url');
    assert.ok(html.indexOf('be-result-thumb') !== -1, 'uses the result-thumb thumbnail styling');
    assert.ok(html.indexOf('1080x1080') !== -1, 'shows the composite size as a label');
    assert.ok(/target="_blank"/.test(html), 'click-through opens the signed url in a new tab');
  });

  // ── Fallback: with no signed url, the result stays the raw gs:// text link. ──
  await check('results fall back to the gs:// text link when no signed preview url is available', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async status() {
        return { ok: true, job: {
          job_id: 'jobF', status: 'completed', bundles_total: 1, bundles_completed: 1,
          asset_uris: ['gs://out/moshy/1.png'],
          asset_previews: [{ gcs_uri: 'gs://out/moshy/1.png', url: null, size: null }],
        } };
      },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.pollStatusOnce('jobF');
    ctx.window.f10BriefEditor.stopPolling();
    const html = progressHtml(ctx);
    assert.ok(html.indexOf('<img') === -1, 'no <img> is rendered when there is no signed url');
    assert.ok(/<a href="gs:\/\/out\/moshy\/1\.png"/.test(html), 'falls back to the raw gs:// text link');
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
