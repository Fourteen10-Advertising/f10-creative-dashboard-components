/**
 * A person in the scene: drawn inside the background photo, directed in its own row.
 *
 * Regression coverage for the person-in-scene change. The backend now draws a hero or
 * person that sits in the scene inside the background photo and lists it in that
 * prompt's `covers`. The editor must:
 *
 *   1. keep a direction box on the covered region, with a note that it is drawn inside
 *      the background, and no prompt box of its own;
 *   2. label the background's prompt with what it includes;
 *   3. rebuild the background's prompt when the covered region's direction changes,
 *      even when the operator had typed into that prompt.
 *
 * Fully offline (no jsdom, no network): the backend is stubbed on the injectable store
 * and a tiny DOM stands in, like test/generation-wiring.test.js.
 *
 * Run: node test/person-in-scene.test.js
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
    DATASET: 'acme_marts',
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

function promptFor(req) {
  var who = ((req && req.regionDirection) || {}).person || 'a real, relatable person';
  return 'a calm kitchen. In the scene: ' + who + ', on the right of the frame. No other people in the image.';
}

function compileFor(req) {
  return {
    ok: true, client: 'acme', variant_count: 1, sizes: [[1080, 1350]], warnings: [],
    variants: [{
      brief_id: 'brief_p', source: { kind: 'winner', ref: 'arch1' }, render: 'scene',
      layout_family: 'split-screen',
      structure: {
        layout_family: 'split-screen',
        regions: [
          { id: 'background', role: 'background', box: { x: 0, y: 0, w: 1, h: 1 }, image_need: true },
          { id: 'person', role: 'person', box: { x: 0.32, y: 0.27, w: 0.5, h: 0.6 }, image_need: true },
          { id: 'headline', role: 'headline', box: { x: 0.1, y: 0.43, w: 0.51, h: 0.24 }, copy_need: true },
        ],
        repeats: [],
      },
      region_copy: { headline: 'Real support, made simple' },
      scene_prompts: [{ region_id: 'background', role: 'background', prompt: promptFor(req), covers: ['person'] }],
      inspiration_images: [],
    }],
    cost_estimate: {
      files_produced: 1, unique_image_generations: 1, per_image_usd: 0.07,
      estimated_usd: 0.07, remaining_cap_usd: 25, exceeds_cap: false, generation_hard_cap_usd: 25,
    },
  };
}

function makeStore(log) {
  return {
    async probe() { return true; }, async load() {}, async save() {},
    async compile(req) { log.compiles.push(JSON.parse(JSON.stringify(req))); return compileFor(req); },
    async submit(req) { log.submits.push(JSON.parse(JSON.stringify(req))); return { ok: true, job_id: 'job_p', status: 'running' }; },
    async status() { return { ok: true, job: { status: 'running', bundles_total: 1, bundles_completed: 0, asset_uris: [] } }; },
  };
}

async function compiled() {
  const ctx = makeBrowserCtx();
  const log = { compiles: [], submits: [] };
  const be = ctx.window.f10BriefEditor;
  be.setStore(makeStore(log));
  await ctx.window.initBriefEditor();
  await be.compileBrief();
  return { ctx, be, log };
}

const PERSON = 1; // the person's row index in the stub structure

async function run() {
  console.log('Person in the scene: directed in its own row, drawn in the background photo');

  await check('the covered person keeps a direction box and says where it is drawn', async () => {
    const { ctx } = await compiled();
    const html = compiledHtml(ctx);
    assert.ok(/id="be-rd-0-1"/.test(html), 'the person takes a direction');
    assert.ok(/Drawn inside the background photo/.test(html), 'and says it is drawn inside the background');
    assert.strictEqual((html.match(/data-be-edit="scene-prompt"/g) || []).length, 1, 'one prompt box: the photo');
    assert.ok(/Prompt sent to the image model: background \(with person\)/.test(html), 'labelled with what it includes');
  });

  await check('a person direction rebuilds the background prompt, even a typed one', async () => {
    const { ctx, be, log } = await compiled();
    be.applyScenePromptEdit(0, 'background', 'OPERATOR PROMPT');
    ctx.document.getElementById('be-rd-0-' + PERSON).value = 'a man in his 50s smiling';
    await be.onDirectionChanged('person');
    assert.strictEqual(log.compiles[1].regionDirection.person, 'a man in his 50s smiling');
    await be.submitCompiled();
    be.stopPolling();
    assert.ok(!('scene_prompts' in log.submits[0].compiledBrief.variants[0]),
      'the typed background prompt was unpinned, so the backend rebuilds it from the direction');
    assert.strictEqual(log.submits[0].regionDirection.person, 'a man in his 50s smiling');
  });

  console.log('\n' + passed + ' checks passed.');
}

run().catch(function (err) { console.error(err); process.exit(1); });
