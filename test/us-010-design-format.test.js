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
    assert.ok(/id="be-design-generate-btn"/.test(html), 'design Generate button present');
    assert.ok(/id="be-design-direction"/.test(html), 'design-mode creative-direction field present');
    assert.ok(/id="be-design-photo"/.test(html), 'design-mode photo toggle present');
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

  await check('Generate submits a design one-shot: archetypeId set, NO compiledBrief', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let submitted = null;
    be.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async submit(req) { submitted = req; return { ok: true, job_id: 'job-design-1', status: 'running' }; },
    });
    await ctx.window.initBriefEditor();

    be.setFormat('comparison');
    await be.generateDesign();

    assert.ok(submitted, 'submit was called');
    assert.strictEqual(submitted.archetypeId, 'comparison', 'submit carries the design archetype');
    assert.strictEqual(submitted.compiledBrief, undefined, 'a design one-shot sends no compiledBrief');
    assert.strictEqual(be.getJobId(), 'job-design-1', 'the design job id is tracked (polling started)');
    be.stopPolling();
  });

  console.log('\n' + passed + ' checks passed.');
}

run().catch((e) => { console.error(e); process.exit(1); });
