/**
 * US-004 - Canonical-constrained brief editor (f10-brief-editor.js).
 *
 * The editor is a dual-mode module. This suite proves both halves fully offline,
 * dependency-free (no jsdom, no @google-cloud, no network), covering exactly the
 * US-004 acceptance criteria and e2e tests:
 *
 * PART 1 - NODE persistence (injectable writer seam):
 *   - canonical enforcement: validate() and saveRevision() reject a non-canonical axis
 *     value before anything is written (AC3);
 *   - load-existing + save-new via a FAKE object-store + registry (no Google): a saved
 *     revision lands as the US-003 GCS JSON at brief-revisions/{client}/{id}.json plus a
 *     brief_revisions registry row, and loads back (AC2);
 *   - the GCS path + registry row match the US-003 contract, and the canonical
 *     vocabularies stay in lockstep with the pipeline schema.
 *
 * PART 2 - BROWSER panel (probe-gated self-registration):
 *   - probe true injects the nav link + panel; probe false and a probe error both fail
 *     closed with zero DOM trace (AC1, module pattern);
 *   - the five axes are <select> dropdowns whose options are exactly the canonical enums,
 *     and there is no free-text axis input (AC1/AC3, e2e 2);
 *   - loading a revision, changing the hook and saving writes a NEW revision through a
 *     fake store and shows its id + the CLI next step (AC2/AC4, e2e 1);
 *   - the save path refuses a tampered non-canonical axis (defence in depth, AC3).
 *
 * Run: node test/us-004-brief-editor.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const EDITOR_PATH = path.join(ROOT, 'f10-brief-editor.js');
const EDITOR_SRC = fs.readFileSync(EDITOR_PATH, 'utf8');
const BE = require('../f10-brief-editor.js'); // Node half (module.exports)

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

/* A canonical sample revision record (all five axes canonical). */
function sampleRecord(overrides) {
  return Object.assign({
    revision_id: 'rev_moshy_seed',
    client: 'moshy',
    bundle_id: 'brief_moshy_hero_abc123',
    visual_style: 'aspirational-premium',
    hook_type: 'question',
    message_angle: 'social-proof',
    cta_type: 'shop-now',
    format: 'static-photo',
    copy_blocks: [{ role: 'headline', text: 'Sleep better tonight' }, { role: 'body', text: 'Clinically formulated.' }],
    evidence_source: 'component_scoreboard_2026_08',
    winning_values: { visual_style_canonical: 'aspirational-premium', extra_axis: 'keep-me' },
    created_by: 'zac@fourteen10',
  }, overrides || {});
}

/* In-memory object store + registry, faithful to the US-003 seams (put/get,
 * register/lookup/listByClient). No Google, no network. */
function makeFakeStore() {
  const objects = {};
  const rows = {};
  return {
    objects, rows,
    objectStore: {
      async put(uri, data, contentType) { objects[uri] = { data: String(data), contentType }; return uri; },
      async get(uri) {
        if (!(uri in objects)) throw new Error('not found: ' + uri);
        return objects[uri].data;
      },
    },
    registry: {
      async register(row) { rows[row.revision_id] = Object.assign({}, row); },
      async lookup(id) { return rows[id] ? Object.assign({}, rows[id]) : null; },
      async listByClient(client) {
        return Object.keys(rows).map((k) => rows[k]).filter((r) => r.client === client);
      },
    },
  };
}

/* ========================================================================== *
 * PART 1 - NODE persistence (injectable writer seam)
 * ========================================================================== */
async function runNode() {
  console.log('US-004 brief editor - node persistence');

  // ── The canonical vocabularies mirror the pipeline schema exactly (lockstep). ──
  await check('canonical vocabularies match the US-003 brief_revision.schema.json enums', async () => {
    assert.deepStrictEqual(BE.CANONICAL.visual_style, [
      'minimal-clean', 'bold-graphic', 'warm-natural', 'aspirational-premium', 'authentic-raw',
      'playful-colorful', 'clinical-professional', 'dark-dramatic', 'illustrated', 'retro-nostalgic', 'other',
    ]);
    assert.deepStrictEqual(BE.CANONICAL.hook_type, [
      'question', 'stat', 'pattern-interrupt', 'bold-claim', 'problem-callout',
      'pov', 'testimonial-open', 'demo-open', 'other',
    ]);
    assert.deepStrictEqual(BE.CANONICAL.message_angle, [
      'problem-solution', 'ease-convenience', 'price-value', 'offer-promo', 'social-proof',
      'authority-clinical', 'empowerment-transformation', 'reassurance-trust', 'aspiration-lifestyle',
      'comparison-alternative', 'education-howitworks', 'humour-entertainment', 'other',
    ]);
    assert.deepStrictEqual(BE.CANONICAL.cta_type, [
      'shop-now', 'learn-more', 'sign-up', 'book', 'download', 'subscribe', 'contact', 'none',
    ]);
    assert.deepStrictEqual(BE.CANONICAL.format, ['static-photo', 'static-illustration']);
  });

  // ── The GCS path + gs:// uri match the US-003 contract, with the same slug rule. ──
  await check('GCS object path + gs:// uri match the US-003 brief-revisions contract', async () => {
    assert.strictEqual(BE.objectName('moshy', 'rev_moshy_seed'), 'brief-revisions/moshy/rev_moshy_seed.json');
    assert.strictEqual(BE.gcsUri('moshy', 'rev_moshy_seed'),
      'gs://f10-creative-assets/brief-revisions/moshy/rev_moshy_seed.json');
    // _safe() slug parity: non-slug chars collapse to _ and edges are trimmed.
    assert.strictEqual(BE.safeSeg('Mo shy!/x'), 'Mo_shy_x');
    assert.strictEqual(BE.safeSeg('  '), 'asset');
    assert.strictEqual(BE.TABLE, 'mcc-poc-477801.creative_pipeline.brief_revisions');
  });

  // ── AC3: a non-canonical axis value is rejected before any write. ──
  await check('validate() rejects a non-canonical visual_style (AC3)', async () => {
    const bad = BE.validate(sampleRecord({ visual_style: 'neon-chrome' }));
    assert.ok(bad.error, 'a non-canonical axis is an error');
    assert.ok(/non-canonical visual_style/.test(bad.error), 'the error names the offending axis');
    // Every axis is guarded, not just visual_style.
    assert.ok(BE.validate(sampleRecord({ hook_type: 'shock' })).error);
    assert.ok(BE.validate(sampleRecord({ cta_type: 'buy-it' })).error);
    assert.ok(BE.validate(sampleRecord({ format: 'carousel' })).error, 'carousel is not a canonical single-static format');
    assert.ok(!BE.validate(sampleRecord()).error, 'a fully canonical record validates');
  });

  await check('creative_direction + inspiration_image_uris round-trip through the doc (mirror to_dict)', async () => {
    const rec = BE.validate(sampleRecord({
      creative_direction: 'the people shown have a higher BMI, plus-size and warm',
      inspiration_image_uris: ['gs://f10-creative-assets/served/meta/acct_1/a.png', '', 7],
    })).record;
    const doc = BE.buildDoc(rec);
    // Persisted on the doc (free text + a cleaned string array), never as axes.
    assert.strictEqual(doc.creative_direction, 'the people shown have a higher BMI, plus-size and warm');
    assert.deepStrictEqual(doc.inspiration_image_uris, ['gs://f10-creative-assets/served/meta/acct_1/a.png']);
    // They are NOT part of the canonical axis validation (free-form).
    assert.ok(!BE.validate(sampleRecord({ creative_direction: 'anything at all' })).error);
    // Round-trips back through fromDoc.
    const back = BE.fromDoc(doc);
    assert.strictEqual(back.creative_direction, doc.creative_direction);
    assert.deepStrictEqual(back.inspiration_image_uris, doc.inspiration_image_uris);
    // A brief with neither field defaults them cleanly (empty string + []).
    const plain = BE.buildDoc(BE.validate(sampleRecord()).record);
    assert.strictEqual(plain.creative_direction, '');
    assert.deepStrictEqual(plain.inspiration_image_uris, []);
  });

  await check('saveRevision() refuses a non-canonical axis with 400 and writes NOTHING (AC3)', async () => {
    const store = makeFakeStore();
    const out = await BE.saveRevision({
      record: sampleRecord({ hook_type: 'not-a-hook' }),
      objectStore: store.objectStore, registry: store.registry,
    });
    assert.strictEqual(out.statusCode, 400);
    assert.deepStrictEqual(store.objects, {}, 'no GCS object written on a rejected save');
    assert.deepStrictEqual(store.rows, {}, 'no registry row written on a rejected save');
  });

  // ── AC2: save-new via the fake writer lands the US-003 JSON + registry row. ──
  await check('saveRevision() writes the US-003 GCS JSON + brief_revisions row via the fake writer (AC2)', async () => {
    const store = makeFakeStore();
    const out = await BE.saveRevision({
      record: sampleRecord(), objectStore: store.objectStore, registry: store.registry,
      now: new Date('2026-08-20T01:02:03Z'),
    });
    assert.strictEqual(out.statusCode, 200);
    assert.strictEqual(out.payload.ok, true);
    assert.strictEqual(out.payload.revision_id, 'rev_moshy_seed');

    const uri = 'gs://f10-creative-assets/brief-revisions/moshy/rev_moshy_seed.json';
    assert.ok(store.objects[uri], 'the JSON lands at the client-scoped brief-revisions key');
    assert.strictEqual(store.objects[uri].contentType, 'application/json');

    const doc = JSON.parse(store.objects[uri].data);
    assert.strictEqual(doc.schema, 'brief_revision');
    assert.strictEqual(doc.visual_style, 'aspirational-premium');
    assert.strictEqual(doc.provenance.evidence_source, 'component_scoreboard_2026_08');
    assert.strictEqual(doc.provenance.winning_values.extra_axis, 'keep-me', 'non-edited scoreboard axis preserved');
    assert.strictEqual(doc.gcs_uri, uri);
    assert.strictEqual(doc.created_at, '2026-08-20T01:02:03.000Z', 'created_at stamped when absent');

    const row = store.rows['rev_moshy_seed'];
    assert.ok(row, 'a registry row is registered');
    assert.strictEqual(row.client, 'moshy');
    assert.strictEqual(row.format, 'static-photo');
    assert.strictEqual(row.gcs_uri, uri);
    // Registry row carries exactly the contract columns (no copy, no provenance).
    assert.deepStrictEqual(Object.keys(row).sort(), [
      'bundle_id', 'client', 'created_at', 'created_by', 'cta_type', 'format', 'gcs_uri',
      'hook_type', 'message_angle', 'revision_id', 'visual_style',
    ]);
  });

  // ── AC2: load-existing reads the saved revision back through the fake writer. ──
  await check('loadRevision() reads a saved revision back through the registry + object store (AC2)', async () => {
    const store = makeFakeStore();
    await BE.saveRevision({ record: sampleRecord(), objectStore: store.objectStore, registry: store.registry });

    const loaded = await BE.loadRevision({
      revisionId: 'rev_moshy_seed', objectStore: store.objectStore, registry: store.registry,
    });
    assert.strictEqual(loaded.statusCode, 200);
    assert.strictEqual(loaded.payload.revision.revision_id, 'rev_moshy_seed');
    assert.strictEqual(loaded.payload.revision.hook_type, 'question');
    assert.deepStrictEqual(loaded.payload.revision.copy_blocks,
      [{ role: 'headline', text: 'Sleep better tonight' }, { role: 'body', text: 'Clinically formulated.' }]);
  });

  await check('loadRevision() returns 404 for an unknown revision id', async () => {
    const store = makeFakeStore();
    const out = await BE.loadRevision({ revisionId: 'nope', objectStore: store.objectStore, registry: store.registry });
    assert.strictEqual(out.statusCode, 404);
  });

  // ── The full edit->save->load round-trip preserves the changed axis (e2e 1, node level). ──
  await check('edit-then-save writes a NEW revision that loads back with the changed hook (e2e 1)', async () => {
    const store = makeFakeStore();
    await BE.saveRevision({ record: sampleRecord(), objectStore: store.objectStore, registry: store.registry });

    // Operator changes the hook and saves as a new revision id.
    const edited = sampleRecord({ revision_id: 'rev_moshy_edited', hook_type: 'stat' });
    const saved = await BE.saveRevision({ record: edited, objectStore: store.objectStore, registry: store.registry });
    assert.strictEqual(saved.statusCode, 200);
    assert.notStrictEqual(saved.payload.revision_id, 'rev_moshy_seed', 'a NEW revision id, not an overwrite');
    assert.ok(store.rows['rev_moshy_seed'] && store.rows['rev_moshy_edited'], 'both revisions coexist');

    const back = await BE.loadRevision({
      revisionId: 'rev_moshy_edited', objectStore: store.objectStore, registry: store.registry,
    });
    assert.strictEqual(back.payload.revision.hook_type, 'stat', 'the changed hook is persisted');
  });

  // ── processRequest dispatch (the handler core), fully injected. ──
  await check('processRequest dispatches probe / load / save on the injected seams', async () => {
    const store = makeFakeStore();
    let out = await BE.processRequest({ body: { action: 'probe', client: 'moshy' }, registry: store.registry });
    assert.strictEqual(out.payload.has_data, false, 'no revisions yet -> probe false (fail closed)');

    await BE.processRequest({
      body: { action: 'save', revision: sampleRecord() },
      objectStore: store.objectStore, registry: store.registry,
    });
    out = await BE.processRequest({ body: { action: 'probe', client: 'moshy' }, registry: store.registry });
    assert.strictEqual(out.payload.has_data, true, 'after a save the client has data -> probe true');

    out = await BE.processRequest({ body: { action: 'nonsense' } });
    assert.strictEqual(out.statusCode, 400, 'unknown action is rejected');
  });
}

/* ========================================================================== *
 * PART 2 - BROWSER panel (probe-gated self-registration)
 * ========================================================================== */

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
    // getElementById caches by id, so a stub <select>'s .value set by populateForm is
    // read back by readForm - enough to drive load -> edit -> save without jsdom.
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

function navHtml(ctx) { return (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || ''; }
function contentHtml(ctx) { return (ctx._slots['content'] && ctx._slots['content'].innerHTML) || ''; }

async function runBrowser() {
  console.log('US-004 brief editor - browser panel');

  // ── AC1: probe true registers the nav section, link + panel. ──
  await check('probe true injects the Creative Briefs nav section, link + panel', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    assert.ok(/nav-section">Creative Briefs/.test(navHtml(ctx)), 'Creative Briefs nav section injected');
    assert.ok(/brief-editor-nav-link/.test(navHtml(ctx)), 'Brief Editor nav link injected');
    assert.ok(/id="panel-brief-editor"/.test(contentHtml(ctx)), 'brief editor panel injected');
    assert.ok(/class="tab-panel brief-editor-tab-panel"/.test(contentHtml(ctx)), 'panel carries the shared tab-panel class');
  });

  // ── AC1: probe false leaves ZERO DOM trace (fail closed). ──
  await check('probe false injects no nav link and no panel (fail closed)', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { return false; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    assert.ok(!/brief-editor-nav-link/.test(navHtml(ctx)), 'no nav link');
    assert.ok(!/panel-brief-editor/.test(contentHtml(ctx)), 'no panel');
  });

  // ── AC1: a probe error fails closed (e.g. the brief endpoint is not yet hosted). ──
  await check('a probe error fails closed with zero DOM trace', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { throw new Error('endpoint 404'); }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    assert.ok(!/brief-editor-nav-link/.test(navHtml(ctx)) && !/panel-brief-editor/.test(contentHtml(ctx)),
      'no tab on a probe error');
  });

  // ── AC1/AC3, e2e 2: the five axes are dropdowns of exactly the canonical enums,
  //     and there is no free-text axis input. ──
  await check('each axis is a <select> of the canonical enum only - no free-text axis input (e2e 2)', async () => {
    const ctx = makeBrowserCtx();
    const html = ctx.window.f10BriefEditor.panelMarkup();
    const CANON = ctx.window.f10BriefEditor.CANONICAL;
    ['visual_style', 'hook_type', 'message_angle', 'cta_type', 'format'].forEach((axis) => {
      assert.ok(new RegExp('id="be-axis-' + axis + '"').test(html), axis + ' is rendered as a select');
      assert.ok(new RegExp('<select[^>]*id="be-axis-' + axis + '"').test(html), axis + ' control is a <select>, not an input');
      CANON[axis].forEach((v) => {
        assert.ok(new RegExp('<option value="' + v + '">').test(html), axis + ' offers canonical option ' + v);
      });
    });
    // The only free-text inputs are the load-id field and copy textareas - never an axis.
    assert.ok(!/<input[^>]*be-axis/.test(html), 'no <input> is bound to any axis');
    assert.ok(!/<textarea[^>]*be-axis/.test(html), 'no <textarea> is bound to any axis');
    // A non-canonical value simply is not an option.
    assert.ok(!/<option value="neon-chrome">/.test(html), 'a non-canonical value is not selectable');
  });

  // ── AC2/AC4, e2e 1: load a revision, change the hook, save -> new revision + id shown. ──
  await check('load -> change hook -> save writes a new revision via the store and shows its id + CLI (e2e 1)', async () => {
    const ctx = makeBrowserCtx();
    const saved = [];
    const loadedDoc = {
      schema: 'brief_revision', revision_id: 'rev_seed', client: 'moshy', bundle_id: 'b1',
      visual_style: 'minimal-clean', hook_type: 'question', message_angle: 'price-value',
      cta_type: 'learn-more', format: 'static-photo',
      copy_blocks: [{ role: 'headline', text: 'Old headline' }],
      provenance: { evidence_source: 'scoreboard', winning_values: { keep: 'yes' } },
    };
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; },
      async load() { return loadedDoc; },
      async save(rec) { saved.push(rec); return { ok: true, revision_id: rec.revision_id, gcs_uri: 'gs://x' }; },
    });
    await ctx.window.initBriefEditor();

    // Load the seed revision into the form.
    await ctx.window.f10BriefEditor.loadRevisionById('rev_seed');
    assert.strictEqual(ctx._slots['be-axis-hook_type'].value, 'question', 'the loaded hook populates the select');

    // Operator changes the hook to another canonical value, then saves.
    ctx._slots['be-axis-hook_type'].value = 'stat';
    await ctx.window.f10BriefEditor.saveNewRevision();

    assert.strictEqual(saved.length, 1, 'exactly one revision written');
    const rec = saved[0];
    assert.strictEqual(rec.hook_type, 'stat', 'the changed hook is saved');
    assert.strictEqual(rec.visual_style, 'minimal-clean', 'unchanged axes are carried through');
    assert.notStrictEqual(rec.revision_id, 'rev_seed', 'a NEW revision id, never an overwrite');
    assert.strictEqual(rec.client, 'moshy');
    assert.strictEqual(rec.winning_values.keep, 'yes', 'provenance winning_values carried from the loaded revision');
    assert.strictEqual(rec.created_by, '', 'no ACTOR config -> created_by empty');

    // AC4: the saved revision id + a clear CLI next step are shown.
    const status = ctx._slots['be-status'].innerHTML;
    assert.ok(status.indexOf(rec.revision_id) !== -1, 'the new revision id is shown');
    assert.ok(/generate --revision/.test(status), 'the CLI generation next step is shown');
    assert.ok(/generation does not run from this app/i.test(status), 'it is clear generation is not run from the app');
  });

  // ── AC3 defence in depth: even a tampered non-canonical axis is refused at save. ──
  await check('the save path refuses a tampered non-canonical axis (defence in depth, AC3)', async () => {
    const ctx = makeBrowserCtx();
    const saved = [];
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; },
      async load() { return { schema: 'brief_revision', revision_id: 'r', client: 'moshy',
        visual_style: 'minimal-clean', hook_type: 'question', message_angle: 'price-value',
        cta_type: 'none', format: 'static-photo', copy_blocks: [] }; },
      async save(rec) { saved.push(rec); return { ok: true, revision_id: rec.revision_id }; },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.loadRevisionById('r');
    // Tamper the select value to something off-vocabulary, as a hostile DOM might.
    ctx._slots['be-axis-visual_style'].value = 'neon-chrome';
    await ctx.window.f10BriefEditor.saveNewRevision();
    assert.strictEqual(saved.length, 0, 'a non-canonical axis is never sent to the store');
    assert.ok(/non-canonical visual_style/.test(ctx._slots['be-status'].innerHTML), 'the operator sees why it was refused');
  });

  // ── The default endpoint derives from BQ_FUNCTION when nothing is configured. ──
  await check('default brief endpoint derives from BQ_FUNCTION (/bq -> /brief)', async () => {
    const ctx = makeBrowserCtx();
    assert.strictEqual(ctx.window.f10BriefEditor.endpoint(), 'https://fn.example/.netlify/functions/brief');
    const ctx2 = makeBrowserCtx({ ENDPOINT: '/api/brief' });
    assert.strictEqual(ctx2.window.f10BriefEditor.endpoint(), '/api/brief', 'explicit config wins');
  });

  // ── Inspiration picker: the panel carries the upload zone + library tabs. ──
  await check('the panel renders the inspiration picker (chips, tabs, upload zone, client + competitor panes)', async () => {
    const ctx = makeBrowserCtx();
    const html = ctx.window.f10BriefEditor.panelMarkup();
    assert.ok(/id="be-insp-chips"/.test(html), 'selected-references row is present');
    assert.ok(/data-insp-tab="upload"/.test(html), 'Upload tab is present');
    assert.ok(/data-insp-tab="client"/.test(html), 'Your-library tab is present');
    assert.ok(/data-insp-tab="competitor"/.test(html), 'Competitors tab is present');
    assert.ok(/id="be-file"/.test(html) && /type="file"/.test(html), 'a file input backs the drop zone');
    assert.ok(/id="be-thumbs"/.test(html), 'the client grid container is present');
    assert.ok(/id="be-client-more"/.test(html), 'the client "load more" control is present');
    assert.ok(/id="be-comp-groups"/.test(html), 'the competitor groups container is present');
  });

  // ── Client library: spend-ranked, paginated by 10, select carries through. ──
  await check('client library paginates by 10 (load more advances the offset) and selection carries through', async () => {
    const ctx = makeBrowserCtx();
    const calls = [];
    const page = (off) => Array.from({ length: 10 }, (_, i) => ({
      gcs_uri: `gs://f10-creative-assets/served/meta/acct_1/a${off + i}.png`,
      thumb_url: 'https://signed/t', source: 'client', label: `ad${off + i}`,
    }));
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async references(p) {
        calls.push(p);
        return { source: 'client', references: page(p.offset || 0), has_more: (p.offset || 0) < 10 };
      },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.switchInspTab('client');
    assert.strictEqual(calls[0].source, 'client', 'client tab loads the client source');
    assert.strictEqual(calls[0].limit, 10, 'requests a page of 10');
    assert.strictEqual(ctx.window.f10BriefEditor.getClientPage().offset, 10, 'offset advanced to 10');
    assert.strictEqual(ctx.window.f10BriefEditor.getClientPage().hasMore, true, 'more pages remain');
    // Load the next page → offset 20, has_more now false.
    await ctx.window.f10BriefEditor.loadClient(false);
    assert.strictEqual(calls[1].offset, 10, 'second page requested at offset 10');
    assert.strictEqual(ctx.window.f10BriefEditor.getClientPage().offset, 20, 'offset advanced to 20');
    assert.strictEqual(ctx.window.f10BriefEditor.getClientPage().hasMore, false, 'no more pages');
    // A picked image from either page carries through a save.
    ctx.window.f10BriefEditor.toggleThumb('gs://f10-creative-assets/served/meta/acct_1/a15.png');
    assert.deepStrictEqual(
      Array.from(ctx.window.f10BriefEditor.readForm().inspiration_image_uris),
      ['gs://f10-creative-assets/served/meta/acct_1/a15.png'], 'the picked ad carries through');
  });

  // ── Competitor library: grouped, ranked, each paginates independently. ──
  await check('competitor library groups by competitor and each competitor pages 5 more at a time', async () => {
    const ctx = makeBrowserCtx();
    const drill = [];
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async references(p) {
        if (p.competitor) {
          drill.push(p);
          return { source: 'competitor', competitor: p.competitor,
            references: [{ gcs_uri: `gs://adlib/${p.competitor}/x${p.offset}.jpg`, thumb_url: 't', source: 'competitor', label: 'Juniper' }],
            has_more: false };
        }
        return { source: 'competitor', per_competitor: 5, competitors: [
          { page_id: '106', name: 'Juniper', tier: 'Leading', score: 81.8, total: 8,
            images: [{ gcs_uri: 'gs://adlib/106/a.jpg', thumb_url: 't', source: 'competitor', label: 'Juniper' }] },
          { page_id: '722', name: 'OneMRI', tier: 'Advanced', score: 64.8, total: 1,
            images: [{ gcs_uri: 'gs://adlib/722/a.jpg', thumb_url: 't', source: 'competitor', label: 'OneMRI' }] },
        ] };
      },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.switchInspTab('competitor');
    const st = ctx.window.f10BriefEditor.getCompState();
    assert.deepStrictEqual(Object.keys(st).sort(), ['106', '722'], 'both competitors grouped');
    assert.strictEqual(st['106'].hasMore, true, 'Juniper (8 total, 1 shown) has more');
    assert.strictEqual(st['722'].hasMore, false, 'OneMRI (1 total, 1 shown) does not');
    // Selecting a competitor image carries through.
    ctx.window.f10BriefEditor.toggleThumb('gs://adlib/106/a.jpg');
    assert.deepStrictEqual(Array.from(ctx.window.f10BriefEditor.getInspiration(), (r) => r.gcs_uri), ['gs://adlib/106/a.jpg']);
    // Paging one competitor requests only that competitor at its current offset.
    await ctx.window.f10BriefEditor.loadCompetitorMore('106');
    assert.strictEqual(drill[0].competitor, '106', 'drill-in scoped to the one competitor');
    assert.strictEqual(drill[0].offset, 1, 'drill-in starts at the shown count');
    assert.strictEqual(ctx.window.f10BriefEditor.getCompState()['106'].hasMore, false, 'no more after the last page');
  });

  // ── Inspiration picker: an uploaded image is stored + selected. ──
  await check('an uploaded file is sent to the upload endpoint and its stored uri is selected', async () => {
    const ctx = makeBrowserCtx();
    // A minimal FileReader shim (Node has no DOM FileReader).
    ctx.FileReader = function () {
      this.readAsDataURL = function () { this.result = 'data:image/png;base64,aGVsbG8='; this.onload(); };
    };
    const stored = 'gs://f10-creative-assets/inspiration/moshy/deadbeef.png';
    let uploadedCT = '';
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; }, async load() {}, async save() {},
      async upload(payload) { uploadedCT = payload.contentType; return { ok: true, gcs_uri: stored, thumb_url: 'https://signed/up' }; },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.handleFile({ name: 'hero.png', type: 'image/png', size: 1234 });
    assert.strictEqual(uploadedCT, 'image/png', 'the file content type is forwarded');
    assert.deepStrictEqual(
      Array.from(ctx.window.f10BriefEditor.getInspiration(), (r) => r.gcs_uri), [stored],
      'the stored uri is selected after upload',
    );
  });

  // ── Inspiration picker: a loaded revision seeds the picker and carries through save. ──
  await check('loaded inspiration_image_uris seed the picker and survive a re-save', async () => {
    const ctx = makeBrowserCtx();
    const seedUri = 'gs://f10-creative-assets/inspiration/moshy/seed.png';
    const saved = [];
    ctx.window.f10BriefEditor.setStore({
      async probe() { return true; },
      async load() {
        return {
          schema: 'brief_revision', revision_id: 'rev_seed', client: 'moshy',
          visual_style: 'minimal-clean', hook_type: 'question', message_angle: 'price-value',
          cta_type: 'learn-more', format: 'static-photo', copy_blocks: [],
          creative_direction: 'higher BMI subjects', inspiration_image_uris: [seedUri],
        };
      },
      async save(rec) { saved.push(rec); return { ok: true, revision_id: rec.revision_id }; },
    });
    await ctx.window.initBriefEditor();
    await ctx.window.f10BriefEditor.loadRevisionById('rev_seed');
    assert.deepStrictEqual(
      Array.from(ctx.window.f10BriefEditor.getInspiration(), (r) => r.gcs_uri), [seedUri],
      'the loaded reference seeds the picker',
    );
    await ctx.window.f10BriefEditor.saveNewRevision();
    assert.strictEqual(saved.length, 1);
    assert.deepStrictEqual(Array.from(saved[0].inspiration_image_uris), [seedUri], 'the reference carries through the save');
    assert.strictEqual(saved[0].creative_direction, 'higher BMI subjects', 'creative direction carries too');
  });
}

(async () => {
  await runNode();
  await runBrowser();
  console.log(`\n${passed} checks passed.`);
})().catch((err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
