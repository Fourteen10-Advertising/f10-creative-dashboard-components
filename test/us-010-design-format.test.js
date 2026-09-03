/**
 * US-010 - Format picker: image vs typeset design ads (f10-brief-editor.js).
 *
 * The Brief Editor gains a Format picker: an Image ad (a generated scene, the
 * existing flow) or a typeset DESIGN ad (a comparison chart / native-UI note) the
 * strategist drafts from the client's substance. A design format generates
 * DIRECTLY (no compile/preview, no spend): it submits with archetypeId and no
 * compiledBrief, and the operator reviews the published result in the Review tab.
 *
 * Proven fully offline (no jsdom, no network) with a tiny DOM + injected store,
 * exactly like us-009:
 *   - the panel renders the Format picker (image + the two design formats) and the
 *     design Generate button;
 *   - buildCompileRequest() adds archetypeId for a design format and omits it for
 *     image (backend auto-picks the layout);
 *   - Generate submits a design one-shot: archetypeId set, NO compiledBrief, and the
 *     returned job id is tracked (progress polling starts).
 *
 * Run: node test/us-010-design-format.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'f10-brief-editor.js'), 'utf8');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

/* A tiny DOM: getElementById auto-vivifies a slot; enough to boot the panel and
 * drive setFormat / buildCompileRequest / generateDesign without jsdom. */
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

async function run() {
  console.log('US-010 format picker (image vs design)');

  await check('the panel renders the Format picker (image + two design formats) and Generate', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    const html = contentHtml(ctx);
    assert.ok(/id="be-format-tabs"/.test(html), 'format tabs present');
    assert.ok(/data-be-format="image"/.test(html), 'image format button present');
    // Every design format (three chassis + native surfaces) has a picker button.
    ['comparison', 'feature_table', 'stat_card', 'testimonial_card', 'offer_card',
      'checklist', 'faq_card', 'native_ui', 'native_ui_search',
      'native_ui_review'].forEach(function (key) {
      assert.ok(
        new RegExp('data-be-format="' + key + '"').test(html),
        key + ' format button present'
      );
    });
    assert.ok(/id="be-design"/.test(html), 'design panel present');
    assert.ok(/id="be-design-draft-btn"/.test(html), 'design Draft button present');
    assert.ok(/id="be-design-direction"/.test(html), 'design-mode creative-direction field present');
    assert.ok(/id="be-design-photo"/.test(html), 'design-mode photo toggle present');
    // Phase 2 edit loop: the edit panel, preview + publish controls, and containers.
    assert.ok(/id="be-design-edit"/.test(html), 'design edit panel present');
    assert.ok(/id="be-design-fields"/.test(html), 'design edit fields container present');
    assert.ok(/id="be-design-preview-btn"/.test(html), 'design Preview button present');
    assert.ok(/id="be-design-publish-btn"/.test(html), 'design Publish button present');
    assert.ok(/id="be-design-preview"/.test(html), 'design preview container present');
    assert.ok(/id="be-design-issues"/.test(html), 'design compliance-issues container present');
  });

  await check('a design format adds archetypeId to the request; image omits it', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();

    assert.strictEqual(be.getFormat(), 'image', 'defaults to image');
    assert.strictEqual(be.buildCompileRequest().archetypeId, undefined, 'image omits archetypeId');

    be.setFormat('comparison');
    assert.strictEqual(be.getFormat(), 'comparison');
    assert.strictEqual(be.buildCompileRequest().archetypeId, 'comparison', 'comparison sends archetypeId');

    be.setFormat('native_ui');
    assert.strictEqual(be.buildCompileRequest().archetypeId, 'native_ui', 'native_ui sends archetypeId');

    be.setFormat('image');
    assert.strictEqual(be.buildCompileRequest().archetypeId, undefined, 'back to image omits it again');
  });

  await check('every design format sends its archetypeId; image omits it', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    ['comparison', 'feature_table', 'stat_card', 'testimonial_card', 'offer_card',
      'checklist', 'faq_card', 'native_ui', 'native_ui_search',
      'native_ui_review'].forEach(function (key) {
      be.setFormat(key);
      assert.strictEqual(be.getFormat(), key, key + ' is selected');
      assert.strictEqual(be.buildCompileRequest().archetypeId, key, key + ' sends its archetypeId');
    });
    be.setFormat('image');
    assert.strictEqual(be.buildCompileRequest().archetypeId, undefined, 'image omits archetypeId');
  });

  await check('the photo toggle sends wantImage only for a design format', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    // off by default: no wantImage
    be.setFormat('stat_card');
    assert.strictEqual(be.buildCompileRequest().wantImage, undefined, 'off by default');
    // toggle on -> a design request carries wantImage
    ctx.document.getElementById('be-design-photo').checked = true;
    assert.strictEqual(be.buildCompileRequest().wantImage, true, 'design format sends wantImage');
    // image ads always generate; the design photo toggle does not apply to them
    be.setFormat('image');
    assert.strictEqual(be.buildCompileRequest().wantImage, undefined, 'image omits wantImage');
  });

  await check('the design-mode creative direction flows to the request as a soft steer', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    // Vivify + fill the design-mode direction field, then a design request carries it.
    ctx.document.getElementById('be-design-direction').value = 'lean warm and personal';
    be.setFormat('stat_card');
    assert.strictEqual(
      be.buildCompileRequest().creativeDirection,
      'lean warm and personal',
      'a design format reads the design-mode creative-direction field'
    );
    // Image mode ignores the design field (uses the image build form field instead).
    be.setFormat('image');
    assert.strictEqual(
      be.buildCompileRequest().creativeDirection,
      '',
      'image mode does not read the design-mode field'
    );
  });

  // A minimal drafted design spec (schema-shaped: copy_blocks by role + a component).
  function fakeDesignSpec(archetypeId) {
    return {
      schema: 'layout_spec', archetype_id: archetypeId,
      copy_blocks: [
        { role: 'headline', text: 'Drafted headline', slot_index: null },
        { role: 'cta', text: 'Start now', slot_index: null },
      ],
      components: [{ kind: 'design', component_type: 'stat_card', spec: {} }],
    };
  }

  await check('Draft compiles the design and renders editable fields (no submit)', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let compiled = null, submitted = null, previewed = null;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile(req) {
        compiled = req;
        return { ok: true, variants: [{ archetype_id: 'stat_card', design_spec: fakeDesignSpec('stat_card') }],
          cost_estimate: { unique_image_generations: 0, estimated_usd: 0 } };
      },
      async designPreview(req) { previewed = req; return { ok: true, png_data_uri: 'data:image/png;base64,AAAA', pending_image_generations: 0 }; },
      async submit(req) { submitted = req; return { ok: true, job_id: 'x' }; },
    });
    await ctx.window.initBriefEditor();

    be.setFormat('stat_card');
    await be.draftDesign();

    assert.ok(compiled, 'draft calls compile');
    assert.strictEqual(compiled.archetypeId, 'stat_card', 'compile carries the design archetype');
    assert.ok(be.getDesignSpec(), 'the drafted spec is held for editing');
    assert.strictEqual(submitted, null, 'draft does NOT submit');
    assert.ok(previewed, 'draft auto-previews the drafted spec');
    // The editable fields were rendered from the spec's copy blocks.
    const fields = ctx._slots['be-design-fields'];
    assert.ok(/id="be-df-0"/.test(fields.innerHTML) && /id="be-df-1"/.test(fields.innerHTML),
      'a field per copy block is rendered');
  });

  await check('Publish submits the EDITED spec verbatim as layoutSpec', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let submitted = null;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() {
        return { ok: true, variants: [{ archetype_id: 'stat_card', design_spec: fakeDesignSpec('stat_card') }],
          cost_estimate: { unique_image_generations: 0, estimated_usd: 0 } };
      },
      async designPreview() { return { ok: true, png_data_uri: 'data:image/png;base64,AAAA' }; },
      async submit(req) { submitted = req; return { ok: true, job_id: 'job-design-2', status: 'running' }; },
    });
    await ctx.window.initBriefEditor();

    be.setFormat('stat_card');
    await be.draftDesign();
    // Edit the headline field, then publish.
    ctx.document.getElementById('be-df-0').value = 'AN EDITED HEADLINE';
    await be.publishDesign();

    assert.ok(submitted, 'publish calls submit');
    assert.ok(submitted.layoutSpec, 'submit carries the edited layoutSpec');
    const headline = submitted.layoutSpec.copy_blocks.find(function (c) { return c.role === 'headline'; });
    assert.strictEqual(headline.text, 'AN EDITED HEADLINE', 'the edit is published verbatim');
    assert.strictEqual(be.getJobId(), 'job-design-2', 'the publish job id is tracked (polling started)');
    be.stopPolling();
  });

  await check('Preview surfaces a compliance rejection inline (422) and renders nothing', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async compile() {
        return { ok: true, variants: [{ archetype_id: 'stat_card', design_spec: fakeDesignSpec('stat_card') }],
          cost_estimate: { unique_image_generations: 0, estimated_usd: 0 } };
      },
      // First call (auto-preview after draft) is clean; after editing in a claim it fails.
      async designPreview(req) {
        var h = req.layoutSpec.copy_blocks.find(function (c) { return c.role === 'headline'; });
        if (h && /10kg/.test(h.text)) return { error: 'blocked', issues: ['quantified results claim in visible copy'] };
        return { ok: true, png_data_uri: 'data:image/png;base64,AAAA' };
      },
      async submit() { throw new Error('should not submit'); },
    });
    await ctx.window.initBriefEditor();

    be.setFormat('stat_card');
    await be.draftDesign();
    ctx.document.getElementById('be-df-0').value = 'Lose 10kg fast';
    await be.previewDesign();

    const issues = ctx._slots['be-design-issues'];
    assert.ok(/results claim/.test(issues.innerHTML), 'the compliance issue is shown inline');
    const preview = ctx._slots['be-design-preview'];
    assert.ok(!/<img/.test(preview.innerHTML), 'no preview image is shown for a blocked edit');
  });

  await check('designRoleLabel humanizes copy-block roles', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    assert.strictEqual(be.designRoleLabel('headline'), 'Headline');
    assert.strictEqual(be.designRoleLabel('card.quote'), 'Quote');
    assert.strictEqual(be.designRoleLabel('list.item.0.text'), 'Item 1');
    assert.strictEqual(be.designRoleLabel('list.item.2.text'), 'Item 3');
  });

  console.log('\n' + passed + ' checks passed.');
}

run().catch((e) => { console.error(e); process.exit(1); });
