/**
 * Every operator input reaches generation: the editor never freezes a stale prompt.
 *
 * Regression coverage for the generation-wiring sweep:
 *
 *   1. A direction typed AFTER compile reaches generation. The editor used to send
 *      every compiled prompt back as an override, so the compile-time text (built
 *      before the direction existed) was generated verbatim and the direction was
 *      ignored. Now only a prompt the operator typed in is sent, and a direction
 *      change rebuilds the shown prompts with a no-spend compile.
 *   2. A typed-in prompt is pinned (sent) until the direction for it changes.
 *   3. Direction boxes follow the backend's list of generated regions, so a logo or
 *      avatar never offers a direction the pipeline cannot honour.
 *   4. A compile made for a different render, axes or inspiration is dropped rather
 *      than submitted.
 *
 * Fully offline (no jsdom, no network): the backend is stubbed on the injectable store
 * and a tiny DOM stands in, like test/structured-scene-prompt-editor.test.js.
 *
 * Run: node test/generation-wiring.test.js
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

/* The prompt the stub backend builds: it leads with the background direction when the
 * request carries one, like the real composer. */
function promptFor(req) {
  const dir = (req && req.regionDirection && req.regionDirection.background) || '';
  return dir ? dir + '. full-frame background photograph' : 'default editorial scene. full-frame background photograph';
}

/* A structured scene compile: background (generated), headline (copy), logo (brand). */
function compileFor(req) {
  return {
    ok: true, client: 'acme', variant_count: 1, sizes: [[1080, 1350]], warnings: [],
    variants: [{
      brief_id: 'brief_w', source: { kind: 'winner', ref: 'arch1' }, render: 'scene',
      layout_family: 'full-bleed-lifestyle-photo',
      structure: {
        layout_family: 'full-bleed-lifestyle-photo',
        regions: [
          { id: 'background', role: 'background', box: { x: 0, y: 0, w: 1, h: 1 }, image_need: true },
          { id: 'headline', role: 'headline', box: { x: 0.1, y: 0.05, w: 0.8, h: 0.1 }, copy_need: true },
          { id: 'logo', role: 'logo', box: { x: 0.4, y: 0.9, w: 0.2, h: 0.05 }, image_need: true },
        ],
        repeats: [],
      },
      region_copy: { headline: 'Real support, made simple' },
      scene_prompts: [{ region_id: 'background', role: 'background', prompt: promptFor(req) }],
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
    async submit(req) { log.submits.push(JSON.parse(JSON.stringify(req))); return { ok: true, job_id: 'job_w', status: 'running' }; },
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

const BURGER = 'a man in a busy restaurant eating the juiciest burger';

async function run() {
  console.log('Generation wiring: the editor carries every input to generation');

  await check('a direction typed after compile rebuilds the shown prompt and is what generates', async () => {
    const { ctx, be, log } = await compiled();
    assert.ok(/default editorial scene/.test(compiledHtml(ctx)), 'the compiled prompt is shown');
    // The operator types a background direction (row ri0) after compiling, then leaves the field.
    ctx.document.getElementById('be-rd-0-0').value = BURGER;
    await be.onDirectionChanged('background');
    assert.strictEqual(log.compiles.length, 2, 'a no-spend compile rebuilt the prompt');
    assert.strictEqual(log.compiles[1].regionDirection.background, BURGER, 'the rebuild carried the direction');
    assert.ok(ctx.document.getElementById('be-sp-0-0').value.indexOf(BURGER) === 0,
      'the prompt box now shows the prompt that will generate');
    await be.submitCompiled();
    be.stopPolling();
    const sent = log.submits[0];
    assert.strictEqual(sent.regionDirection.background, BURGER, 'submit carries the direction');
    assert.ok(!('scene_prompts' in sent.compiledBrief.variants[0]),
      'no compiled prompt is sent, so the backend generates from the direction');
  });

  await check('a typed-in prompt is sent; a later direction change unpins it', async () => {
    const { ctx, be, log } = await compiled();
    ctx.document.getElementById('be-sp-0-0').value = 'OPERATOR PROMPT: a rooftop garden at dusk';
    await be.submitCompiled();
    be.stopPolling();
    const pinned = log.submits[0].compiledBrief.variants[0].scene_prompts;
    assert.strictEqual(pinned.length, 1, 'the typed-in prompt is sent');
    assert.strictEqual(pinned[0].prompt, 'OPERATOR PROMPT: a rooftop garden at dusk', 'verbatim');
    assert.strictEqual(pinned[0].region_id, 'background', 'keyed by region id');

    ctx.document.getElementById('be-rd-0-0').value = BURGER;
    await be.onDirectionChanged('background');
    assert.ok(ctx.document.getElementById('be-sp-0-0').value.indexOf(BURGER) === 0,
      'the newer direction replaces the typed prompt');
    await be.submitCompiled();
    be.stopPolling();
    assert.ok(!('scene_prompts' in log.submits[1].compiledBrief.variants[0]), 'the unpinned prompt is not sent');
  });

  await check('a Creative direction change rebuilds every prompt', async () => {
    const { ctx, be, log } = await compiled();
    be.applyScenePromptEdit(0, 'background', 'OPERATOR PROMPT');
    ctx.document.getElementById('be-direction').value = 'warm, candid, higher-BMI subjects';
    await be.onDirectionChanged(null);
    assert.strictEqual(log.compiles[1].creativeDirection, 'warm, candid, higher-BMI subjects', 'the rebuild carried it');
    await be.submitCompiled();
    be.stopPolling();
    assert.ok(!('scene_prompts' in log.submits[0].compiledBrief.variants[0]), 'the global change unpinned the prompt');
  });

  await check('direction boxes appear only on regions the backend generates', async () => {
    const { ctx } = await compiled();
    const html = compiledHtml(ctx);
    assert.ok(/id="be-rd-0-0"/.test(html), 'the generated background takes a direction');
    assert.ok(!/id="be-rd-0-2"/.test(html), 'the logo (a brand asset) offers no direction');
    assert.ok(/Not generated: drawn from the brand kit/.test(html), 'the logo says why');
    assert.ok(/Prompt sent to the image model: background/.test(html), 'the prompt sits with its region');
  });

  await check('a compile made for a different render, axes or inspiration is dropped, not submitted', async () => {
    let r = await compiled();
    r.be.setRender('typeset');
    assert.strictEqual(r.be.getCompiled(), null, 'a render change drops the compile');
    assert.ok(/Compile again/.test(compiledHtml(r.ctx)), 'and says to compile again');

    r = await compiled();
    r.ctx.document.getElementById('be-axis-visual_style').value = 'dark-dramatic';
    await r.be.submitCompiled();
    assert.strictEqual(r.log.submits.length, 0, 'an axis change blocks the stale submit');
    assert.strictEqual(r.be.getCompiled(), null, 'and drops the compile');

    r = await compiled();
    r.be.selectRef({ gcs_uri: 'gs://insp/new.png', thumb_url: 't', source: 'client' });
    assert.strictEqual(r.be.getCompiled(), null, 'attaching an inspiration image drops the compile');
  });

  console.log('\n' + passed + ' checks passed.');
}

run().catch(function (err) { console.error(err); process.exit(1); });
