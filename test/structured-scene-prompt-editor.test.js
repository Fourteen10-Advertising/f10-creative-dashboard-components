/**
 * Structured (scene) variant surfaces the generation prompt for review + edit.
 *
 * The gap: after confirming a structure, the operator could edit region copy and type
 * creative direction, but the actual image generation prompt was never shown; a
 * structured brief drafts no prompt; the scene prompt is built at generation time. The
 * backend now computes it at compile and returns it per generated image region as
 * `variant.scene_prompts` ([{region_id, role, prompt}]). This suite proves the editor:
 *
 *   1. renders each scene prompt as an EDITABLE textarea in the structured card;
 *   2. sends the operator's edited prompt back on submit as variant.scene_prompts
 *      (which the backend overlays onto brief.scene_prompt_overrides and generates from);
 *   3. shows nothing and sends nothing for a typeset variant (no scene_prompts).
 *
 * Fully offline (no jsdom, no network): the compile/submit backend is stubbed on the
 * injectable store and a tiny DOM stands in, exactly like test/us-009-compile-submit.test.js.
 *
 * Run: node test/structured-scene-prompt-editor.test.js
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

function makeBrowserCtx() {
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { track() {} };
  window.BRIEF_FUNCTION = 'https://fn.example/.netlify/functions/brief';
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
  vm.createContext(sandbox);
  vm.runInContext(EDITOR_SRC, sandbox, { filename: 'f10-brief-editor.js' });
  return sandbox;
}

function compiledHtml(ctx) { return (ctx._slots['be-compiled'] && ctx._slots['be-compiled'].innerHTML) || ''; }

/* A structured SCENE /compile response: one variant carrying the copy-free structure,
 * the region copy overlay, the source, the render, AND the surfaced scene prompt(s).
 * Default source `winner`, so no inspiration confirm gate stands in the way. */
function structuredResponse(overrides) {
  const variant = Object.assign({
    brief_id: 'brief_s', archetype_id: 'arch1', scene_only: true, winning_values: {},
    render: 'scene', layout_family: 'split-screen',
    source: { kind: 'winner', ref: 'arch1' },
    scene_prompts: [
      { region_id: 'background', role: 'background', prompt: 'ORIGINAL SCENE PROMPT: calm studio, one person' },
    ],
    copy: [{ role: 'headline', text: 'Sleep better tonight' }],
    structure: {
      layout_family: 'split-screen',
      regions: [
        { id: 'background', role: 'background', box: { x: 0, y: 0, w: 1, h: 1 }, image_need: true },
        { id: 'headline', role: 'headline', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 } },
      ],
      repeats: [],
    },
    region_copy: { headline: 'Sleep better tonight' },
    inspiration_images: [],
  }, (overrides && overrides.variant) || {});
  return Object.assign({
    ok: true, client: 'moshy', variant_count: 1,
    sizes: [[1080, 1080]],
    variants: [variant],
    warnings: [],
    cost_estimate: {
      files_produced: 1, unique_image_generations: 1, per_image_usd: 0.07,
      estimated_usd: 0.07, remaining_cap_usd: 25, exceeds_cap: false, generation_hard_cap_usd: 25,
    },
  }, (overrides && overrides.top) || {});
}

async function run() {
  console.log('Structured variant surfaces the generation prompt for edit');

  // ── 1: the structured scene card renders the generation prompt as an editable
  //     textarea, alongside the per-region editor. ──
  await check('a structured scene variant renders its generation prompt as an editable textarea', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return structuredResponse(); },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief();
    const html = compiledHtml(ctx);

    assert.ok(/be-variant-structured/.test(html), 'the structured variant card is rendered');
    assert.ok(html.indexOf('Prompt sent to the image model') !== -1, 'the generation prompt is labelled');
    assert.ok(html.indexOf('ORIGINAL SCENE PROMPT: calm studio, one person') !== -1, 'the resolved prompt text is shown');
    assert.ok(/<textarea[^>]*class="be-scene-prompt"[^>]*data-be-edit="scene-prompt"/.test(html),
      'the prompt is an editable textarea wired to data-be-edit="scene-prompt"');
    assert.ok(html.indexOf('Sleep better tonight') !== -1, 'the per-region copy editor still renders');
  });

  // ── 2: an edited generation prompt is what /submit sends on the structured variant,
  //     alongside the structure + region_copy. ──
  await check('an edited generation prompt is submitted as variant.scene_prompts, with structure + region_copy', async () => {
    const ctx = makeBrowserCtx();
    let submitted = null;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return structuredResponse(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'job_s', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'running', bundles_total: 1, bundles_completed: 0, asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief();

    // The operator edits the generation prompt textarea (id is be-sp-<vi>-<n>).
    ctx.document.getElementById('be-sp-0-0').value = 'EDITED SCENE PROMPT: neon night market, wide';

    await ctx.window.f10BriefEditor.submitCompiled();
    ctx.window.f10BriefEditor.stopPolling();

    assert.ok(submitted, 'submit was called');
    const v0 = submitted.compiledBrief && submitted.compiledBrief.variants && submitted.compiledBrief.variants[0];
    assert.ok(v0, 'the approved compiled brief was sent with a variant');
    assert.ok(Array.isArray(v0.scene_prompts) && v0.scene_prompts.length === 1, 'the variant carries its scene prompt(s)');
    assert.strictEqual(v0.scene_prompts[0].prompt, 'EDITED SCENE PROMPT: neon night market, wide', 'the EDITED prompt is submitted');
    assert.strictEqual(v0.scene_prompts[0].region_id, 'background', 'the prompt keeps its region id for the backend overlay');
    assert.strictEqual(v0.scene_prompts[0].role, 'background', 'the prompt keeps its role');
    assert.ok(v0.structure && typeof v0.structure === 'object', 'the edited structure is still submitted');
    assert.ok(v0.region_copy && typeof v0.region_copy === 'object', 'the edited region copy is still submitted');
    assert.strictEqual(v0.brief_id, 'brief_s', 'brief_id carried so the backend matches the edit');
  });

  // ── 3: a typeset variant has no image prompt, so none is shown and none is sent. ──
  await check('a typeset variant shows no generation prompt and submits none', async () => {
    const ctx = makeBrowserCtx();
    let submitted = null;
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return structuredResponse({ variant: { render: 'typeset', scene_prompts: [] } }); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'job_t', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'running', bundles_total: 1, bundles_completed: 0, asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.compileBrief();
    const html = compiledHtml(ctx);
    assert.ok(html.indexOf('Prompt sent to the image model') === -1, 'no generation prompt label on a typeset variant');
    assert.ok(!/be-scene-prompt/.test(html), 'no prompt textarea on a typeset variant');

    await ctx.window.f10BriefEditor.submitCompiled();
    ctx.window.f10BriefEditor.stopPolling();
    const v0 = submitted.compiledBrief.variants[0];
    assert.ok(!('scene_prompts' in v0), 'a typeset variant submits no scene_prompts key');
    assert.ok(v0.structure && v0.region_copy, 'the typeset variant still submits its structure + region copy');
  });

  console.log('\n' + passed + ' checks passed.');
}

run().catch(function (err) { console.error(err); process.exit(1); });
