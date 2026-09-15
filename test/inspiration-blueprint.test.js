/**
 * US-009 / US-011 / US-012 - from-inspiration blueprint editor + structural picker
 * (f10-brief-editor.js).
 *
 * The from-inspiration compile SEEDS a brand-safe reference blueprint (the reference's
 * reconstructed structure + strategy). This surfaces it as an editable panel above the
 * variants (mirroring the design layout-spec edit loop): the operator adjusts the slot
 * boxes, text blocks, layout family and declared strategy, gives a one-click faithful
 * rating, and generates. Submit sends the EDITED blueprint plus the seeded baseline and
 * the rating so the backend logs the success signal. The picker marks which statics
 * already carry a structural row (US-011) and shows a not-yet-available note for one
 * that must be analysed on demand (US-012).
 *
 * Fully offline (a tiny DOM + injected store), like us-009 / us-010.
 * Run: node test/inspiration-blueprint.test.js
 */
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
  vm.runInContext(EDITOR_SRC, sandbox, { filename: 'f10-brief-editor.js' });
  return sandbox;
}

function seededBlueprint() {
  return {
    client: 'moshy', source: 'upload', layout_family: 'hero-left-offer-badge', aspect_ratio: 'square',
    slots: { background: { x: 0, y: 0, w: 1, h: 1 }, hero: { x: 0.0, y: 0.1, w: 0.5, h: 0.8 } },
    text_blocks: [{ x: 0.55, y: 0.30, w: 0.40, h: 0.30 }],
    declared_strategy: { message_angle_canonical: 'offer-promo', visual_style_canonical: 'warm-natural' },
  };
}

function blueprintCompileResponse(over) {
  return Object.assign({
    ok: true, client: 'moshy', variant_count: 1,
    variants: [{
      brief_id: 'b1', archetype_id: 'a1', scene_only: true, winning_values: {},
      prompts: [{ component_role: 'background', prompt: 'P' }],
      copy: [{ role: 'headline', text: 'H' }], inspiration_images: [],
    }],
    sizes: [[1080, 1080]], warnings: [],
    cost_estimate: { files_produced: 1, unique_image_generations: 1, estimated_usd: 0.07, remaining_cap_usd: 25, exceeds_cap: false },
    reference_blueprint: seededBlueprint(),
    blueprint_status: 'ready',
  }, over || {});
}

function compiledHtmlOf(ctx) { return (ctx._slots['be-compiled'] && ctx._slots['be-compiled'].innerHTML) || ''; }

async function run() {
  console.log('US-009/011/012 from-inspiration blueprint editor + structural picker');

  // ---- US-011: the picker marks which statics carry a structural row ------------
  await check('thumbHtml marks a structural static vs an on-demand one (inspiration mode)', async () => {
    const be = makeBrowserCtx().window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    be.setMode('inspiration');
    const structural = be.thumbHtml({ gcs_uri: 'gs://x/a.png', has_structure: true, thumb_url: 't', label: 'A' });
    const pending = be.thumbHtml({ gcs_uri: 'gs://x/b.png', has_structure: false, thumb_url: 't', label: 'B' });
    assert.ok(/ has-structure/.test(structural) && /data-has-structure="1"/.test(structural), 'structural marked');
    assert.ok(/be-struct-badge/.test(structural) && /structure</.test(structural), 'structural badge');
    assert.ok(/ no-structure/.test(pending) && /data-has-structure="0"/.test(pending), 'non-structural marked');
    assert.ok(/be-struct-pending/.test(pending) && /on-demand</.test(pending), 'on-demand badge');
  });

  await check('buildCompileRequest sends referenceSource in inspiration mode, omits it in scratch', async () => {
    const be = makeBrowserCtx().window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    be.setMode('inspiration');
    assert.strictEqual(be.buildCompileRequest().referenceSource, 'upload', 'inspiration sends the picker tab (default upload)');
    be.setMode('scratch');
    assert.strictEqual(be.buildCompileRequest().referenceSource, undefined, 'scratch omits referenceSource');
  });

  // ---- US-009: compile seeds the editable blueprint panel -----------------------
  await check('a from-inspiration compile renders the editable blueprint panel', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return blueprintCompileResponse(); },
    });
    await ctx.window.initBriefEditor();
    be.setMode('inspiration');
    await be.compileBrief();
    const html = compiledHtmlOf(ctx);
    assert.ok(/id="be-blueprint-edit"/.test(html), 'blueprint panel present');
    assert.ok(/id="be-bp-layout-family"/.test(html), 'layout family field present');
    assert.ok(/id="be-bp-slot-hero-x"/.test(html), 'hero slot box field present');
    assert.ok(/id="be-bp-tb-0-x"/.test(html), 'text block box field present');
    assert.ok(/id="be-bp-ds-message_angle_canonical"/.test(html), 'declared strategy field present');
    assert.ok(/data-be-bp-faithful="yes"/.test(html) && /data-be-bp-faithful="no"/.test(html), 'faithful rating buttons present');
    assert.deepStrictEqual(be.getReferenceBlueprint(), seededBlueprint(), 'the seed is carried as the edit baseline');
  });

  // ---- US-009: an edited blueprint + rating flow to submit ----------------------
  await check('the edited blueprint, baseline and faithful rating are sent to submit', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let submitted = null;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return blueprintCompileResponse(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'j1', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'completed', asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    be.setMode('inspiration');
    await be.compileBrief();

    // The operator moves the copy column and renames the layout, then rates it faithful.
    ctx.document.getElementById('be-bp-tb-0-x').value = '0.20';
    ctx.document.getElementById('be-bp-layout-family').value = 'centered-hero-lower-text';
    be.setBlueprintFaithful(true);

    await be.submitCompiled();
    be.stopPolling();

    assert.ok(submitted, 'submit was called');
    assert.strictEqual(submitted.referenceSource, 'upload', 'the reference source is sent');
    assert.ok(submitted.referenceBlueprint, 'the edited blueprint is sent');
    assert.strictEqual(submitted.referenceBlueprint.text_blocks[0].x, 0.20, 'the moved copy column is in the edited blueprint');
    assert.strictEqual(submitted.referenceBlueprint.layout_family, 'centered-hero-lower-text', 'the edited layout family is sent');
    assert.deepStrictEqual(submitted.referenceBlueprintBaseline, seededBlueprint(), 'the seeded baseline rides along');
    assert.strictEqual(submitted.blueprintFaithful, true, 'the faithful rating is sent');
    // The rating also emits an analytics event.
    assert.ok(ctx.window.F10A.events.some(function (e) { return e.e === 'blueprint_faithful'; }), 'faithful event tracked');
  });

  // ---- US-012: a static with no structure shows a clear not-yet-available note --
  await check('an unavailable blueprint shows a clear not-yet-available note (no panel)', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return blueprintCompileResponse({ reference_blueprint: null, blueprint_status: 'unavailable' }); },
    });
    await ctx.window.initBriefEditor();
    be.setMode('inspiration');
    await be.compileBrief();
    const html = compiledHtmlOf(ctx);
    assert.ok(/be-bp-note/.test(html) && /analysed on demand/.test(html), 'a clear not-yet note is shown');
    assert.ok(!/id="be-blueprint-edit"/.test(html), 'no editable panel when there is no blueprint');
    assert.strictEqual(be.getReferenceBlueprint(), null, 'no blueprint carried');
  });

  await check('a scratch (holistic) compile renders no blueprint panel', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() { return blueprintCompileResponse({ reference_blueprint: null, blueprint_status: null }); },
    });
    await ctx.window.initBriefEditor();
    await be.compileBrief();
    const html = compiledHtmlOf(ctx);
    assert.ok(!/id="be-blueprint-edit"/.test(html) && !/be-bp-note/.test(html), 'no blueprint UI on the holistic path');
  });

  console.log('\nAll ' + passed + ' checks passed.');
}

run().catch(function (err) { console.error(err && err.stack ? err.stack : err); process.exit(1); });
