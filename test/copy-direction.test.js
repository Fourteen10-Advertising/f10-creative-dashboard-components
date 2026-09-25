/**
 * Copy direction: each copy region takes a direction the copy writer follows.
 *
 * Regression coverage for the live copy writer. A copy region used to have no
 * direction field, so the only way to change its words was to retype them. Now:
 *
 *   1. Each copy region (and repeat group) has a "Direction (what to say)" field;
 *      image rows say why they are not generated (brand kit, or a typeset render).
 *   2. Changing a copy region's direction runs a no-spend compile and rewrites that
 *      region's copy only; copy the operator typed elsewhere is kept.
 *   3. Changing the whole-ad direction rewrites all copy.
 *   4. Submit sends the refreshed copy, so what the operator saw is what generates.
 *
 * Fully offline (no jsdom, no network): the backend is stubbed on the injectable store
 * and a tiny DOM stands in, like test/generation-wiring.test.js.
 *
 * Run: node test/copy-direction.test.js
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

/* The stub copy writer: a region's copy follows its own direction, else the whole-ad
 * direction, else a default line. */
function copyFor(req, id, fallback) {
  var rd = (req && req.regionDirection) || {};
  if (rd[id]) return 'About: ' + rd[id];
  if (req && req.creativeDirection) return 'Overall: ' + req.creativeDirection;
  return fallback;
}

function compileFor(req) {
  return {
    ok: true, client: 'acme', variant_count: 1, sizes: [[1080, 1350]], warnings: [],
    variants: [{
      brief_id: 'brief_c', source: { kind: 'winner', ref: 'arch1' }, render: 'scene',
      layout_family: 'full-bleed-lifestyle-photo',
      structure: {
        layout_family: 'full-bleed-lifestyle-photo',
        regions: [
          { id: 'background', role: 'background', box: { x: 0, y: 0, w: 1, h: 1 }, image_need: true },
          { id: 'headline', role: 'headline', box: { x: 0.1, y: 0.05, w: 0.8, h: 0.1 }, copy_need: true },
          { id: 'body', role: 'body', box: { x: 0.1, y: 0.7, w: 0.8, h: 0.1 }, copy_need: true },
          { id: 'logo', role: 'logo', box: { x: 0.4, y: 0.9, w: 0.2, h: 0.05 }, image_need: true },
        ],
        repeats: [],
      },
      region_copy: {
        headline: copyFor(req, 'headline', 'Real support, made simple'),
        body: copyFor(req, 'body', 'Care that fits your week.'),
      },
      scene_prompts: [{ region_id: 'background', role: 'background', prompt: 'default editorial scene' }],
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
    async submit(req) { log.submits.push(JSON.parse(JSON.stringify(req))); return { ok: true, job_id: 'job_c', status: 'running' }; },
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

// Row indexes in the stub structure.
const HEADLINE = 1, BODY = 2;

async function run() {
  console.log('Copy direction: the copy writer follows each region');

  await check('each copy region takes a direction; image rows say why they are not generated', async () => {
    const { ctx } = await compiled();
    const html = compiledHtml(ctx);
    assert.ok(/id="be-rd-0-1"/.test(html) && /id="be-rd-0-2"/.test(html), 'headline and body take a direction');
    assert.ok(/Direction \(what to say\)/.test(html), 'labelled as copy direction');
    assert.ok(!/id="be-rd-0-3"/.test(html), 'the logo offers no direction');
    assert.ok(/Not generated: drawn from the brand kit/.test(html), 'the logo says why');
  });

  await check('a typeset render says no imagery is drawn, not that it comes from the brand kit', async () => {
    const { ctx, be } = await compiled();
    be.setRender('typeset');
    await be.compileBrief();
    const html = compiledHtml(ctx);
    assert.ok(/Not generated: a typeset render draws no imagery/.test(html));
    assert.ok(!/drawn from the brand kit/.test(html));
  });

  await check('a copy direction rewrites that region only and keeps typed copy elsewhere', async () => {
    const { ctx, be, log } = await compiled();
    ctx.document.getElementById('be-rc-0-' + BODY).value = 'My own body line';
    ctx.document.getElementById('be-rd-0-' + HEADLINE).value = 'no lock-in';
    await be.onDirectionChanged('headline');
    assert.strictEqual(log.compiles.length, 2, 'a no-spend compile rewrote the copy');
    assert.strictEqual(log.compiles[1].regionDirection.headline, 'no lock-in', 'it carried the direction');
    await be.submitCompiled();
    be.stopPolling();
    const rc = log.submits[0].compiledBrief.variants[0].region_copy;
    assert.strictEqual(rc.headline, 'About: no lock-in', 'the headline follows its direction');
    assert.strictEqual(rc.body, 'My own body line', 'the typed body line is kept');
    assert.strictEqual(log.submits[0].regionDirection.headline, 'no lock-in');
  });

  await check('a whole-ad direction rewrites all copy', async () => {
    const { ctx, be, log } = await compiled();
    ctx.document.getElementById('be-direction').value = 'lead with the price match';
    await be.onDirectionChanged(null);
    await be.submitCompiled();
    be.stopPolling();
    const rc = log.submits[0].compiledBrief.variants[0].region_copy;
    assert.strictEqual(rc.headline, 'Overall: lead with the price match');
    assert.strictEqual(rc.body, 'Overall: lead with the price match');
  });

  console.log('\n' + passed + ' checks passed.');
}

run().catch(function (err) { console.error(err); process.exit(1); });
