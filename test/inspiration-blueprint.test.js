/**
 * US-011 / US-012 / US-022 - inspiration source: detected-structure confirmation
 * (f10-brief-editor.js).
 *
 * Phase 3 (US-022) retires the reference-blueprint editor. An inspiration source now
 * COMPILES to the reference ad's DETECTED structure; before generating, the operator
 * confirms that structure (a wireframe + a confidence), or — below the confidence
 * threshold — uses the preset fallback the backend offers. No picker-derived layout is
 * ever applied in inspiration mode. Confirming reveals the single per-region editor (the
 * one that replaced the blueprint editor), and /submit carries the edited structure +
 * region_copy. The picker still marks which statics carry a structural row (US-011).
 *
 * Fully offline (a tiny DOM + injected store + the shared wireframe util).
 * Run: node test/inspiration-blueprint.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'f10-brief-editor.js'), 'utf8');
const UTILS_SRC = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');

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
    head: { appendChild() {} }, createElement() { return {}; },
  };
  return { document, slots };
}

function makeBrowserCtx() {
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { events: [], track(e, p) { this.events.push({ e: e, p: p }); } };
  window.BRIEF_FUNCTION = 'https://fn.example/.netlify/functions/brief';
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801', DATASET: 'moshy_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: async () => { throw new Error('no network in tests'); },
    setTimeout, clearTimeout, _slots: slots,
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS_SRC, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(EDITOR_SRC, sandbox, { filename: 'f10-brief-editor.js' });
  return sandbox;
}

// A LayoutStructure in the fixed contract shape (flat regions + repeats).
function structure(over) {
  return Object.assign({
    layout_family: 'testimonial-quote-card', aspect_ratios: '4:5',
    regions: [
      { id: 'quote', role: 'quote', box: { x: 0.1, y: 0.3, w: 0.8, h: 0.3 }, copy_need: true },
      { id: 'attribution', role: 'attribution', box: { x: 0.1, y: 0.64, w: 0.8, h: 0.05 }, copy_need: true },
      { id: 'cta', role: 'cta', box: { x: 0.3, y: 0.8, w: 0.4, h: 0.07 }, copy_need: true },
    ],
    repeats: [],
  }, over || {});
}

function sourcesResponse() {
  return {
    client: 'moshy',
    sources: {
      winners: [{ archetype_id: 'w1', name: 'Hero', layout_family: 'product-hero-card', source_ad_count: 5, default_render: 'scene', structure: structure() }],
      explore: [], inspiration: { available: true },
    },
    renders: ['scene', 'typeset'], explore_prefix: 'family:',
  };
}

// An inspiration /compile response: the DETECTED structure + confidence, a preset
// fallback (offered below threshold), and one variant carrying the detected structure.
function inspirationCompile(over) {
  const detected = structure({ structure_confidence: 0.58 });
  return Object.assign({
    ok: true, client: 'moshy', variant_count: 1,
    detected_structure: detected, structure_confidence: 0.58,
    preset_fallback: { preset_id: 'quote-card', structure: structure({ layout_family: 'testimonial-quote-card' }), region_copy: { quote: 'Preset quote', attribution: '', cta: 'Learn more' } },
    variants: [{
      brief_id: 'i1', source: { kind: 'inspiration', ref: 'gs://insp/a.png' }, render: 'scene',
      layout_family: 'testimonial-quote-card', structure: detected,
      region_copy: { quote: 'Real customer quote', attribution: 'Sam R.', cta: 'Try it' },
    }],
    sizes: [[1080, 1350]], warnings: [],
    cost_estimate: { files_produced: 1, unique_image_generations: 1, estimated_usd: 0.07, remaining_cap_usd: 25, exceeds_cap: false },
  }, over || {});
}

function compiledHtmlOf(ctx) { return (ctx._slots['be-compiled'] && ctx._slots['be-compiled'].innerHTML) || ''; }

async function run() {
  console.log('US-011/US-022 inspiration source: detected-structure confirmation');

  // ---- US-011: the picker marks which statics carry a structural row ------------
  await check('thumbHtml marks a structural static vs an on-demand one (inspiration source)', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('inspiration');
    const s = be.thumbHtml({ gcs_uri: 'gs://x/a.png', has_structure: true, thumb_url: 't', label: 'A' });
    const p = be.thumbHtml({ gcs_uri: 'gs://x/b.png', has_structure: false, thumb_url: 't', label: 'B' });
    assert.ok(/ has-structure/.test(s) && /data-has-structure="1"/.test(s), 'structural marked');
    assert.ok(/be-struct-badge/.test(s) && /structure</.test(s), 'structural badge');
    assert.ok(/ no-structure/.test(p) && /data-has-structure="0"/.test(p), 'non-structural marked');
    assert.ok(/be-struct-pending/.test(p) && /on-demand</.test(p), 'on-demand badge');
  });

  // ---- US-022: an inspiration source applies NO picker-derived layout -----------
  await check('an inspiration source sends source{kind:inspiration, ref:<chosen ad>} and no picker layout', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('inspiration');
    be.selectRef({ gcs_uri: 'gs://insp/a.png', thumb_url: 't' });
    const req = be.buildCompileRequest();
    assert.strictEqual(req.source.kind, 'inspiration', 'source.kind inspiration');
    assert.strictEqual(req.source.ref, 'gs://insp/a.png', 'the ref is the chosen inspiration ad');
    assert.ok(!('archetypeId' in req), 'no picker-derived archetypeId');
  });

  // ---- US-022: compile shows the detected-structure confirmation gate -----------
  await check('a from-inspiration compile shows the detected-structure confirmation (wireframe + confidence + preset)', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() { return inspirationCompile(); },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('inspiration');
    be.selectRef({ gcs_uri: 'gs://insp/a.png', thumb_url: 't' });
    await be.compileBrief();
    const html = compiledHtmlOf(ctx);
    assert.ok(/id="be-insp-confirm"/.test(html), 'the confirmation gate is present');
    assert.ok(/data-region-id="quote"/.test(html), 'the detected structure is drawn as a wireframe');
    assert.ok(/58%/.test(html), 'the detection confidence is shown');
    assert.ok(/id="be-insp-usepreset"/.test(html), 'a preset fallback is offered below threshold');
    assert.strictEqual(ctx._slots['be-submit-bar'].style.display, 'none', 'the submit bar is hidden until confirmed');
    assert.strictEqual(JSON.stringify(be.getInspirationStructure()), JSON.stringify(structure({ structure_confidence: 0.58 })), 'the detected structure is captured');
    assert.ok(be.getInspirationConfidence() === 0.58, 'the confidence is captured');
    assert.strictEqual(be.isInspirationConfirmed(), false, 'not confirmed yet');
  });

  // ---- US-022: confirming reveals the per-region editor, edits go to /submit ----
  await check('confirming the detected structure reveals the per-region editor; edits round-trip to /submit', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let submitted = null;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() { return inspirationCompile(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'j1', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'completed', asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('inspiration');
    be.selectRef({ gcs_uri: 'gs://insp/a.png', thumb_url: 't' });
    await be.compileBrief();
    be.confirmInspiration();
    assert.strictEqual(be.isInspirationConfirmed(), true, 'confirmed');
    const html = compiledHtmlOf(ctx);
    assert.ok(/be-region/.test(html), 'the per-region editor is shown after confirm');
    assert.strictEqual(ctx._slots['be-submit-bar'].style.display, '', 'the submit bar is revealed');
    // Edit the quote copy and submit.
    ctx.document.getElementById('be-rc-0-0').value = 'A better quote';
    await be.submitCompiled();
    be.stopPolling();
    assert.ok(submitted && submitted.compiledBrief, 'submit carries the compiled brief');
    const v = submitted.compiledBrief.variants[0];
    assert.ok(v.structure && v.region_copy, 'submit carries the edited structure + region_copy');
    assert.strictEqual(v.region_copy.quote, 'A better quote', 'the edited quote round-tripped');
    assert.strictEqual(submitted.source.kind, 'inspiration', 'submit keeps the inspiration source');
    assert.ok(ctx.window.F10A.events.some(function (e) { return e.e === 'inspiration_structure_confirmed'; }), 'confirm event tracked');
  });

  // ---- US-022: the preset fallback replaces the detected structure and re-sources -
  await check('using the preset fallback adopts the preset structure and submits it as an explore source', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let submitted = null;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() { return inspirationCompile(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'j2', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'completed', asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('inspiration');
    be.selectRef({ gcs_uri: 'gs://insp/a.png', thumb_url: 't' });
    await be.compileBrief();
    be.useInspirationPreset();
    assert.ok(/be-region/.test(compiledHtmlOf(ctx)), 'the per-region editor is shown after choosing the preset');
    await be.submitCompiled();
    be.stopPolling();
    assert.strictEqual(submitted.source.kind, 'explore', 'the preset fallback submits as an explore source');
    assert.strictEqual(submitted.source.ref, 'quote-card', 'the preset id rides source.ref');
    assert.ok(ctx.window.F10A.events.some(function (e) { return e.e === 'inspiration_preset_used'; }), 'preset event tracked');
  });

  // ---- A winner / explore source shows NO confirmation gate --------------------
  await check('a winner source compiles straight to the per-region editor (no confirmation gate)', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() {
        return {
          ok: true, client: 'moshy',
          variants: [{ brief_id: 'w', source: { kind: 'winner', ref: '' }, render: 'scene', layout_family: 'product-hero-card',
            structure: structure(), region_copy: { quote: 'q', attribution: 'a', cta: 'c' } }],
          sizes: [[1080, 1080]], cost_estimate: { files_produced: 1, unique_image_generations: 1, estimated_usd: 0.02, remaining_cap_usd: 25, exceeds_cap: false },
        };
      },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('winner:w1');
    await be.compileBrief();
    const html = compiledHtmlOf(ctx);
    assert.ok(!/id="be-insp-confirm"/.test(html), 'no confirmation gate for a winner source');
    assert.ok(/be-region/.test(html), 'the per-region editor renders directly');
    assert.strictEqual(ctx._slots['be-submit-bar'].style.display, '', 'the submit bar is revealed directly');
  });

  console.log('\nAll ' + passed + ' checks passed.');
}

run().catch(function (err) { console.error(err && err.stack ? err.stack : err); process.exit(1); });
