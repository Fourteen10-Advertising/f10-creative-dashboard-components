/**
 * US-010 / US-022 - Render toggle + typeset (the successor to the design-format picker)
 * in f10-brief-editor.js.
 *
 * Phase 3 (US-022) retires the beFormat design-format picker AND the design draft/edit/
 * preview/publish loop. The ten typeset "design formats" survive as EXPLORE PRESETS on
 * list-sources, each with a default render of "typeset", and a typeset ad is now just a
 * source rendered with render:"typeset". This suite proves that reshaped surface, fully
 * offline (a tiny DOM + injected store), like the original:
 *   - list-sources exposes the former design formats as explore presets, each selectable;
 *   - choosing a typeset-default preset defaults the render to typeset, and the operator
 *     can override the render to scene;
 *   - buildCompileRequest emits source:{kind:"explore",ref} + render, never the retired
 *     archetypeId / format / wantImage;
 *   - a typeset compile response renders the per-region structure editor (the single editor
 *     that replaced the per-format design fields), and the edits round-trip to /submit.
 *
 * Run: node test/us-010-design-format.test.js
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

function makeBrowserCtx(config) {
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
  if (config !== undefined) sandbox.BRIEF_EDITOR = config;
  vm.createContext(sandbox);
  vm.runInContext(UTILS_SRC, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(EDITOR_SRC, sandbox, { filename: 'f10-brief-editor.js' });
  return sandbox;
}

function contentHtml(ctx) { return (ctx._slots['content'] && ctx._slots['content'].innerHTML) || ''; }

// The ten former design formats, now carried as explore presets on list-sources. Each
// maps a family + a preset id, exactly the migration table in the Phase 3 plan.
const DESIGN_PRESETS = [
  { family: 'before-after-comparison', preset_id: 'comparison-table' },
  { family: 'rate-card-finance', preset_id: 'feature-table' },
  { family: 'graphic-illustration-stat', preset_id: 'stat-card' },
  { family: 'testimonial-quote-card', preset_id: 'quote-card' },
  { family: 'hero-offer-badge', preset_id: 'offer-card' },
  { family: 'checklist-feature-ui', preset_id: 'checklist' },
  { family: 'checklist-feature-ui', preset_id: 'faq' },
  { family: 'app-phone-mockup', preset_id: 'phone-notes' },
  { family: 'app-phone-mockup', preset_id: 'browser-search' },
  { family: 'testimonial-quote-card', preset_id: 'review-card' },
];

function presetStructure(preset) {
  return {
    layout_family: preset.family, aspect_ratios: '1:1',
    regions: [
      { id: 'headline', role: 'headline', box: { x: 0.08, y: 0.06, w: 0.84, h: 0.12 }, copy_need: true },
      { id: 'body', role: 'body', box: { x: 0.08, y: 0.24, w: 0.84, h: 0.5 }, copy_need: true },
      { id: 'cta', role: 'cta', box: { x: 0.3, y: 0.82, w: 0.4, h: 0.08 }, copy_need: true },
    ],
    repeats: [],
  };
}

function sourcesResponse() {
  return {
    client: 'moshy',
    sources: {
      winners: [
        { archetype_id: 'moshy-hero', name: 'Hero', layout_family: 'product-hero-card',
          source_ad_count: 12, default_render: 'scene', structure: presetStructure({ family: 'product-hero-card' }) },
      ],
      explore: DESIGN_PRESETS.map(function (p) {
        return { family: p.family, preset_id: p.preset_id, default_render: 'typeset', structure: presetStructure(p) };
      }),
      inspiration: { available: true },
    },
    renders: ['scene', 'typeset'], explore_prefix: 'family:',
  };
}

function typesetCompileResponse() {
  return {
    ok: true, client: 'moshy', variant_count: 1,
    variants: [{
      brief_id: 'brief_ts', source: { kind: 'explore', ref: 'comparison-table' }, render: 'typeset',
      layout_family: 'before-after-comparison', structure: presetStructure({ family: 'before-after-comparison' }),
      region_copy: { headline: 'Us vs them', body: 'Cheaper, faster, kinder', cta: 'Compare' },
    }],
    sizes: [[1080, 1080]], warnings: [],
    cost_estimate: { files_produced: 1, unique_image_generations: 0, estimated_usd: 0, remaining_cap_usd: 25, exceeds_cap: false },
  };
}

async function run() {
  console.log('US-010/US-022 render toggle + typeset presets (the design-format successor)');

  await check('the panel renders the source picker + render toggle, and the old format/design panels are gone', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { return true; }, async load() {}, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    const html = contentHtml(ctx);
    assert.ok(/id="be-source"/.test(html), 'source picker present');
    assert.ok(/id="be-render-tabs"/.test(html), 'render toggle present');
    assert.ok(/data-be-render="scene"/.test(html) && /data-be-render="typeset"/.test(html), 'scene + typeset options present');
    // Retired surfaces are gone.
    assert.ok(!/id="be-format-tabs"/.test(html), 'no format picker');
    assert.ok(!/id="be-design"/.test(html), 'no design panel');
    assert.ok(!/id="be-design-fields"/.test(html), 'no per-format design fields');
    assert.ok(!/id="be-design-draft-btn"/.test(html), 'no design Draft button');
  });

  await check('every former design format is offered as a typeset explore preset', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    const html = ctx._slots['be-source'].innerHTML;
    DESIGN_PRESETS.forEach(function (p) {
      assert.ok(new RegExp('value="explore:' + p.preset_id + '"').test(html), p.preset_id + ' offered as an explore preset');
    });
  });

  await check('a typeset preset defaults the render to typeset; buildCompileRequest emits source + render, no archetypeId/format/wantImage', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('explore:comparison-table');
    assert.strictEqual(be.getRender(), 'typeset', 'a typeset-default preset defaults the render to typeset');
    let req = be.buildCompileRequest();
    assert.strictEqual(req.source.kind, 'explore', 'source.kind explore');
    assert.strictEqual(req.source.ref, 'comparison-table', 'source.ref is the preset id');
    assert.strictEqual(req.render, 'typeset', 'render typeset rides the request');
    assert.ok(!('archetypeId' in req), 'no retired archetypeId');
    assert.ok(!('format' in req), 'no retired format');
    assert.ok(!('wantImage' in req), 'no retired wantImage / design photo toggle');
    // The render is overridable to scene.
    be.setRender('scene');
    assert.strictEqual(be.buildCompileRequest().render, 'scene', 'the render can be overridden to scene');
  });

  await check('a winner source keeps its scene default independent of the presets', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('winner:moshy-hero');
    assert.strictEqual(be.getRender(), 'scene', 'a scene-default winner defaults to scene');
    assert.strictEqual(be.buildCompileRequest().source.kind, 'winner', 'source.kind winner');
  });

  await check('a typeset compile response renders the per-region editor and edits round-trip to /submit', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let submitted = null;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() { return typesetCompileResponse(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'job-ts', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'completed', asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('explore:comparison-table');
    await be.compileBrief();
    const html = ctx._slots['be-compiled'].innerHTML;
    assert.ok(/be-region/.test(html), 'the per-region editor rendered (not per-format design fields)');
    assert.ok(/be-rc-0-0/.test(html), 'the headline region is editable');
    // Edit the headline copy, then submit.
    ctx.document.getElementById('be-rc-0-0').value = 'AN EDITED HEADLINE';
    await be.submitCompiled();
    be.stopPolling();
    assert.ok(submitted && submitted.compiledBrief, 'submit carries the compiled brief');
    const v = submitted.compiledBrief.variants[0];
    assert.ok(v.structure && v.region_copy, 'submit carries the edited structure + region_copy (not a layoutSpec)');
    assert.strictEqual(v.region_copy.headline, 'AN EDITED HEADLINE', 'the edit is submitted verbatim');
    assert.strictEqual(submitted.render, 'typeset', 'the typeset render rides submit');
    assert.strictEqual(be.getJobId(), 'job-ts', 'the submit job id is tracked (polling started)');
  });

  console.log('\n' + passed + ' checks passed.');
}

run().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
