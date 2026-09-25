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

  // US-024: two presets in ONE family are distinct, labelled rows (no duplicate text),
  // and a sub-format of a WINNING family stays explorable while the canonical is hidden.
  function namedSourcesResponse() {
    return {
      client: 'moshy',
      sources: {
        // The client already wins with app-phone-mockup, so its CANONICAL preset is hidden
        // from explore, but the alternate app-search sub-format is not.
        winners: [
          { archetype_id: 'moshy-phone', name: 'App Phone Mockup', layout_family: 'app-phone-mockup',
            source_ad_count: 27, default_render: 'typeset', structure: presetStructure({ family: 'app-phone-mockup' }) },
        ],
        explore: [
          // Same family (checklist-feature-ui), two presets, two distinct names.
          { family: 'checklist-feature-ui', preset_id: 'checklist', name: 'Checklist',
            is_family_default: true, default_render: 'typeset', structure: presetStructure({ family: 'checklist-feature-ui' }) },
          { family: 'checklist-feature-ui', preset_id: 'faq_card', name: 'FAQ Card',
            is_family_default: false, default_render: 'typeset', structure: presetStructure({ family: 'checklist-feature-ui' }) },
          // A winning family: canonical hidden, sub-format kept.
          { family: 'app-phone-mockup', preset_id: 'native_ui', name: 'App Chat Mockup',
            is_family_default: true, default_render: 'typeset', structure: presetStructure({ family: 'app-phone-mockup' }) },
          { family: 'app-phone-mockup', preset_id: 'native_ui_search', name: 'App Search Mockup',
            is_family_default: false, default_render: 'typeset', structure: presetStructure({ family: 'app-phone-mockup' }) },
        ],
        inspiration: { available: true },
      },
      renders: ['scene', 'typeset'], explore_prefix: 'family:',
    };
  }

  await check('two presets in one family render as distinct, non-duplicate labelled rows', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {}, async sources() { return namedSourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    const html = ctx._slots['be-source'].innerHTML;
    // Both same-family presets appear with their OWN distinct label.
    assert.ok(/>Checklist \(untested\)</.test(html), 'the checklist preset is labelled "Checklist"');
    assert.ok(/>FAQ Card \(untested\)</.test(html), 'the faq preset is labelled "FAQ Card"');
    assert.ok(/value="explore:checklist"/.test(html) && /value="explore:faq_card"/.test(html), 'both are selectable by their own preset id');
    // The old family-only label that produced the duplicate row is gone.
    assert.ok(!/Checklist Feature Ui/.test(html), 'no family-titleized duplicate label');
  });

  await check('a winning family hides only its canonical preset; the sub-format stays explorable', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {}, async sources() { return namedSourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    const html = ctx._slots['be-source'].innerHTML;
    // app-phone-mockup is a winner: its canonical native_ui explore row is hidden.
    assert.ok(!/value="explore:native_ui"/.test(html), 'the canonical preset of a winning family is hidden from explore');
    assert.ok(!/>App Chat Mockup \(untested\)</.test(html), 'the canonical label is not offered as untested');
    // ...but the alternate sub-format stays available to explore.
    assert.ok(/value="explore:native_ui_search"/.test(html), 'the sub-format of a winning family stays explorable');
    assert.ok(/>App Search Mockup \(untested\)</.test(html), 'the sub-format keeps its own untested label');
  });

  // An explore pick compiles as its design FORMAT: a variant with a design_spec (the
  // drafted format) and editable copy, and no structure.
  function designCompileResponse() {
    return {
      ok: true, client: 'moshy', variant_count: 1,
      variants: [{
        brief_id: 'brief_search', archetype_id: 'native-search-v1',
        source: { kind: 'explore', ref: 'native_ui_search' }, render: 'typeset',
        layout_family: 'app-phone-mockup', prompts: [],
        copy: [
          { role: 'headline', text: 'The search that started it.' },
          { role: 'search.query', text: 'moshy weight loss program' },
        ],
        design_spec: {
          schema: 'layout_spec', archetype_id: 'native-search-v1',
          components: [{ kind: 'design', component_type: 'native_ui', spec: { variant: 'search_result' } }],
          copy_blocks: [
            { role: 'headline', text: 'The search that started it.' },
            { role: 'search.query', text: 'moshy weight loss program' },
          ],
        },
      }],
      sizes: [[1080, 1350]], warnings: [],
      cost_estimate: { files_produced: 1, unique_image_generations: 0, estimated_usd: 0, remaining_cap_usd: 25, exceeds_cap: false },
    };
  }

  await check('a design-format variant submits its compiled design_spec with the edited copy', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let submitted = null;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async sources() { return namedSourcesResponse(); },
      async compile() { return designCompileResponse(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'job-fmt', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'completed', asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('explore:native_ui_search');
    await be.compileBrief();
    be.applyCompiledEdit('copy', 0, 0, 'AN EDITED HEADLINE');
    await be.submitCompiled();
    be.stopPolling();
    const v = submitted && submitted.compiledBrief && submitted.compiledBrief.variants[0];
    assert.ok(v, 'submit carries the compiled variant');
    assert.deepStrictEqual(v.design_spec, designCompileResponse().variants[0].design_spec,
      'the compiled design_spec rides back unchanged (the backend lays the edited copy over it)');
    assert.strictEqual(v.copy[0].text, 'AN EDITED HEADLINE', 'the copy edit is submitted');
    assert.strictEqual(submitted.source.kind, 'explore', 'the source kind rides submit');
    assert.strictEqual(submitted.source.ref, 'native_ui_search', 'the source ref rides submit');
  });

  await check('changing the render or layout after compiling drops the stale compiled result', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async sources() { return namedSourcesResponse(); },
      async compile() { return designCompileResponse(); },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('explore:native_ui_search');
    await be.compileBrief();
    assert.ok(be.readCompiledBrief(), 'a compiled result is ready to submit');
    // Re-selecting the SAME layout at the same render (a picker re-populate) keeps it.
    be.setSource('explore:native_ui_search');
    assert.ok(be.readCompiledBrief(), 're-selecting the same choice keeps the compiled result');
    // Switching the render makes it stale: it no longer matches what Generate would publish.
    be.setRender('scene');
    assert.strictEqual(be.readCompiledBrief(), null, 'a render change drops the compiled result');
    assert.strictEqual(ctx._slots['be-submit-bar'].style.display, 'none', 'the submit bar hides');
    // Same for a layout change.
    await be.compileBrief();
    assert.ok(be.readCompiledBrief(), 'recompiled');
    be.setSource('explore:faq_card');
    assert.strictEqual(be.readCompiledBrief(), null, 'a layout change drops the compiled result');
  });

  console.log('\n' + passed + ' checks passed.');
}

run().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
