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
 * PART 2 - BROWSER panel (review-app-gated self-registration):
 *   - a review-app context (window.BRIEF_FUNCTION set) ALWAYS injects the nav link + panel,
 *     even with zero data; a plain client dashboard (no brief backend) registers nothing and
 *     makes no network call (AC1, module pattern, chicken-and-egg regression);
 *   - the editable axes are <select> dropdowns whose options are exactly the canonical
 *     enums, the dead format axis is gone, and there is no free-text axis input
 *     (AC1/AC3, e2e 2);
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
// f10-utils.js carries the SHARED structure wireframe (built once, used by the brief
// editor AND the Review overlay). The browser panel calls window.f10RenderWireframe, so
// the harness loads utils into the sandbox first, exactly as the review test composes
// UTILS + REVIEW.
const UTILS_SRC = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const BE = require('../f10-brief-editor.js'); // Node half (module.exports)

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

/* A canonical sample revision record (all editable axes canonical). It also carries a
 * stored format value: US-004 retired format as an editable axis, but the field and the
 * BigQuery column are kept for backward compatibility, so a legacy format rides along on
 * the persisted doc and registry row and is ignored gracefully by validation. */
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
    // US-004: the dead format axis is gone from the editor. It has no canonical
    // vocabulary and is not one of the editable axes.
    assert.strictEqual(BE.CANONICAL.format, undefined, 'no format canonical vocabulary');
    assert.deepStrictEqual(
      BE.AXES.map((a) => a.key),
      ['visual_style', 'hook_type', 'message_angle', 'cta_type'],
      'the format axis is gone from the editable axes',
    );
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
    // Every editable axis is guarded, not just visual_style.
    assert.ok(BE.validate(sampleRecord({ hook_type: 'shock' })).error);
    assert.ok(BE.validate(sampleRecord({ cta_type: 'buy-it' })).error);
    // US-004: format is a dead axis, no longer gated. Even a value that used to be
    // rejected (carousel) or an empty/absent format is now accepted gracefully; the
    // stored value simply rides along on the backward-compatible column.
    assert.ok(!BE.validate(sampleRecord({ format: 'carousel' })).error, 'a stored format is ignored, not rejected');
    assert.ok(!BE.validate(sampleRecord({ format: '' })).error, 'an empty format validates');
    const noFmt = sampleRecord();
    delete noFmt.format;
    assert.ok(!BE.validate(noFmt).error, 'an absent format validates');
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
 * PART 2 - BROWSER panel (review-app-gated self-registration)
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

function makeBrowserCtx(config, opts) {
  opts = opts || {};
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { track() {} };
  // The review app injects window.BRIEF_FUNCTION (the brief backend); the browser panel only
  // surfaces in that review-app context. Default the harness to it so the editor registers;
  // pass { reviewApp: false } to simulate a plain client dashboard (a DATASET but no backend).
  if (opts.reviewApp !== false) window.BRIEF_FUNCTION = 'https://fn.example/.netlify/functions/brief';
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'moshy_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: opts.fetch || (async () => { throw new Error('no network in tests'); }),
    setTimeout, clearTimeout,
    _slots: slots,
  };
  if (config !== undefined) sandbox.BRIEF_EDITOR = config;
  vm.createContext(sandbox);
  vm.runInContext(UTILS_SRC, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(EDITOR_SRC, sandbox, { filename: 'f10-brief-editor.js' });
  return sandbox;
}

function navHtml(ctx) { return (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || ''; }
function contentHtml(ctx) { return (ctx._slots['content'] && ctx._slots['content'].innerHTML) || ''; }

async function runBrowser() {
  console.log('US-004 brief editor - browser panel');

  // ── A review-app context registers the nav section, link + panel. ──
  await check('a review-app context injects the Creative Briefs nav section, link + panel', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { return true; }, async load() {}, async save() {} });
    await ctx.window.initBriefEditor();
    assert.ok(/nav-section">Creative Briefs/.test(navHtml(ctx)), 'Creative Briefs nav section injected');
    assert.ok(/brief-editor-nav-link/.test(navHtml(ctx)), 'Brief Editor nav link injected');
    assert.ok(/id="panel-brief-editor"/.test(contentHtml(ctx)), 'brief editor panel injected');
    assert.ok(/class="tab-panel brief-editor-tab-panel"/.test(contentHtml(ctx)), 'panel carries the shared tab-panel class');
  });

  // ── REGRESSION (chicken-and-egg): in a review-app context the tab ALWAYS registers,
  //    even with ZERO existing data. The probe/discovery result must no longer HIDE the tab -
  //    the editor is the surface used to author the FIRST brief for a brand-new client. ──
  await check('a review-app context with NO existing data still registers the tab (probe no longer gates)', async () => {
    const ctx = makeBrowserCtx();
    // probe false AND load returns nothing: a brand-new client with no brief revision yet.
    ctx.window.f10BriefEditor.setStore({ async probe() { return false; }, async load() { return null; }, async save() {} });
    await ctx.window.initBriefEditor();
    assert.ok(/nav-section">Creative Briefs/.test(navHtml(ctx)), 'Creative Briefs nav section still injected with zero data');
    assert.ok(/brief-editor-nav-link/.test(navHtml(ctx)), 'Brief Editor nav link still injected with zero data');
    assert.ok(/id="panel-brief-editor"/.test(contentHtml(ctx)), 'brief editor panel still injected with zero data');
    assert.ok(/id="be-form"/.test(contentHtml(ctx)), 'the blank new-brief form is present');
    assert.ok(!/be-err/.test((ctx._slots['be-status'] && ctx._slots['be-status'].innerHTML) || ''), 'no error on the empty panel');
  });

  // ── REGRESSION (live-path safety): a plain client dashboard has a DATASET but NO brief
  //    backend (no window.BRIEF_FUNCTION). It must register NEITHER tab and make NO network call
  //    - the review surface must never leak onto a client-facing dashboard. ──
  await check('a plain client dashboard (no BRIEF_FUNCTION) registers no tab and makes no network call', async () => {
    let fetched = 0;
    const ctx = makeBrowserCtx(undefined, { reviewApp: false, fetch: async () => { fetched += 1; throw new Error('unexpected network'); } });
    await ctx.window.initBriefEditor();
    assert.strictEqual(fetched, 0, 'no network call on a plain client dashboard');
    assert.ok(!/brief-editor-nav-link/.test(navHtml(ctx)), 'no Brief Editor nav link on a plain dashboard');
    assert.ok(!/panel-brief-editor/.test(contentHtml(ctx)), 'no Brief Editor panel on a plain dashboard');
  });

  // ── REGRESSION: a missing configured seed REVISION_ID must NOT error the panel - the
  //    blank new-brief form is the correct empty state. The operator-initiated Load path still
  //    surfaces the "not found" message (so the silent seam did not gut error reporting). ──
  await check('a missing seed REVISION_ID shows a blank form with NO error (silent seed auto-load)', async () => {
    const ctx = makeBrowserCtx();
    ctx.window.f10BriefEditor.setStore({ async probe() { return false; }, async load() { return null; }, async save() {} });
    ctx.window.f10BriefEditor.registerTab();
    const statusEl = () => (ctx._slots['be-status'] && ctx._slots['be-status'].innerHTML) || '';
    // The silent seed auto-load leaves the panel blank, with no error status.
    await ctx.window.f10BriefEditor.loadRevisionById('does-not-exist', { silent: true });
    assert.strictEqual(statusEl(), '', 'a missing seed revision leaves an empty status (no error)');
    // An operator-initiated Load of the same missing id DOES surface the not-found error.
    await ctx.window.f10BriefEditor.loadRevisionById('does-not-exist');
    assert.ok(/be-err/.test(statusEl()) && /No brief revision found/.test(statusEl()), 'an explicit Load still reports the missing revision');
  });

  // ── REGRESSION: the boot path wires a configured REVISION_ID through the SILENT auto-load,
  //    so a brand-new client whose seed does not resolve still gets a registered, error-free panel. ──
  await check('a configured but missing REVISION_ID auto-loads silently on boot (no error, panel present)', async () => {
    const ctx = makeBrowserCtx({ REVISION_ID: 'ghost' });
    ctx.window.f10BriefEditor.setStore({ async probe() { return false; }, async load() { return null; }, async save() {} });
    await ctx.window.initBriefEditor();
    await new Promise((r) => setTimeout(r, 0)); // let the un-awaited silent auto-load settle
    assert.ok(/id="panel-brief-editor"/.test(contentHtml(ctx)), 'the panel registered despite the missing seed');
    assert.strictEqual((ctx._slots['be-status'] && ctx._slots['be-status'].innerHTML) || '', '', 'the missing seed did not error the panel');
  });

  // ── AC1/AC3, e2e 2: the editable axes are dropdowns of exactly the canonical
  //     enums, and there is no free-text axis input. The dead format axis (US-004)
  //     is gone: no Format dropdown appears in the editor. ──
  await check('each editable axis is a <select> of the canonical enum only, and the format axis is gone (e2e 2)', async () => {
    const ctx = makeBrowserCtx();
    const html = ctx.window.f10BriefEditor.panelMarkup();
    const CANON = ctx.window.f10BriefEditor.CANONICAL;
    ['visual_style', 'hook_type', 'message_angle', 'cta_type'].forEach((axis) => {
      assert.ok(new RegExp('id="be-axis-' + axis + '"').test(html), axis + ' is rendered as a select');
      assert.ok(new RegExp('<select[^>]*id="be-axis-' + axis + '"').test(html), axis + ' control is a <select>, not an input');
      CANON[axis].forEach((v) => {
        assert.ok(new RegExp('<option value="' + v + '">').test(html), axis + ' offers canonical option ' + v);
      });
    });
    // US-004 (e2e 2, AC1): the Format axis no longer appears in the editor at all.
    assert.ok(!/id="be-axis-format"/.test(html), 'no Format dropdown is rendered');
    assert.ok(!/<option value="static-photo">/.test(html), 'no static-photo format option is rendered');
    assert.ok(!/<option value="static-illustration">/.test(html), 'no static-illustration format option is rendered');
    assert.strictEqual(ctx.window.f10BriefEditor.AXES.map((a) => a.key).indexOf('format'), -1,
      'format is not one of the editable axes');
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
    assert.ok(/generate --from-revision/.test(status), 'the CLI generation next step is shown');
    assert.ok(!/generate --revision\b/.test(status), 'uses --from-revision, not the non-existent --revision flag');
    assert.ok(/python3 -m f10_creative_pipeline\.generate/.test(status), 'uses python3, not python');
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

  /* ======================================================================== *
   * PHASE 3 (US-022): source + render picker, structure wireframe, per-region
   * editor, and inspiration confirmation. These replace the retired beMode /
   * beFormat / beLayout pickers and the design / blueprint edit loops.
   * ======================================================================== */

  // A LayoutStructure doc in the FIXED contract shape (flat regions + a separate
  // repeats array, normalised 0..1 boxes).
  function sampleStructure(over) {
    return Object.assign({
      layout_family: 'app-phone-mockup', aspect_ratios: '4:5',
      regions: [
        { id: 'headline', role: 'headline', box: { x: 0.08, y: 0.06, w: 0.84, h: 0.1 }, ordinal: 0, copy_need: true },
        { id: 'thread', role: 'group.thread', box: { x: 0.1, y: 0.2, w: 0.8, h: 0.55 }, ordinal: 1, container: true },
        { id: 'hero', role: 'product-shot', box: { x: 0.1, y: 0.2, w: 0.8, h: 0.55 }, ordinal: 2, image_need: true },
        { id: 'cta', role: 'cta', box: { x: 0.3, y: 0.85, w: 0.4, h: 0.08 }, ordinal: 3, copy_need: true },
      ],
      repeats: [{ group: 'thread', item_role: 'message-bubble', min: 2, max: 6, observed: 3 }],
    }, over || {});
  }

  // A list-sources response in the FIXED contract shape.
  function sourcesResponse() {
    return {
      client: 'moshy',
      sources: {
        winners: [
          { archetype_id: 'moshy-split-screen', name: 'Split Screen', layout_family: 'split-screen',
            source_ad_count: 23, default_render: 'scene', structure: sampleStructure({ layout_family: 'split-screen' }) },
        ],
        explore: [
          { family: 'before-after-comparison', preset_id: 'comparison-table', default_render: 'typeset',
            structure: sampleStructure({ layout_family: 'before-after-comparison' }) },
        ],
        inspiration: { available: true },
      },
      renders: ['scene', 'typeset'], explore_prefix: 'family:',
    };
  }

  // A /compile response whose single variant carries a structure + region_copy.
  function structuredCompileResponse(over) {
    return Object.assign({
      ok: true, client: 'moshy', variant_count: 1,
      variants: [{
        brief_id: 'brief_a', source: { kind: 'winner', ref: 'moshy-split-screen' }, render: 'scene',
        layout_family: 'app-phone-mockup', structure: sampleStructure(),
        region_copy: { headline: 'Sleep better', thread: ['Hey!', 'Does it work?', 'Yes, love it'], cta: 'Shop now' },
      }],
      sizes: [[1080, 1350]], warnings: [],
      cost_estimate: { files_produced: 1, unique_image_generations: 1, estimated_usd: 0.02, remaining_cap_usd: 25, exceeds_cap: false },
    }, over || {});
  }

  // ── AC1: list-sources populates the picker with winners + explore + inspiration,
  //     and buildCompileRequest emits source + render (never archetypeId/format/beLayout). ──
  await check('list-sources populates the source picker (winners + explore + inspiration); buildCompileRequest emits source + render', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() { return null; }, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    const html = ctx._slots['be-source'].innerHTML;
    assert.ok(/Auto \(top performer\)/.test(html), 'the Auto default is present');
    assert.ok(/value="winner:moshy-split-screen"/.test(html), 'a mined winner is listed');
    assert.ok(/winning layouts/i.test(html), 'the winning-layouts group is labelled');
    assert.ok(/value="explore:comparison-table"/.test(html), 'an explore preset is offered');
    assert.ok(/value="inspiration"/.test(html), 'the inspiration option is offered');
    // The old format + layout pickers are gone.
    assert.ok(!/id="be-format-tabs"/.test(ctx._slots['content'].innerHTML), 'no format picker');
    assert.ok(!/id="be-layout"/.test(ctx._slots['content'].innerHTML), 'no layout picker');
    assert.ok(!/id="be-mode-tabs"/.test(ctx._slots['content'].innerHTML), 'no mode toggle');

    be.setSource('winner:moshy-split-screen');
    let req = be.buildCompileRequest();
    assert.strictEqual(JSON.stringify(req.source), JSON.stringify({ kind: 'winner', ref: 'moshy-split-screen' }), 'a winner rides source{kind,ref}');
    assert.strictEqual(req.render, 'scene', 'render rides the request');
    assert.ok(!('archetypeId' in req), 'no legacy archetypeId');
    assert.ok(!('format' in req), 'no legacy format');
    assert.ok(!('beLayout' in req) && !('mode' in req), 'no legacy beLayout / mode');

    be.setSource('explore:comparison-table');
    req = be.buildCompileRequest();
    assert.strictEqual(req.source.kind, 'explore', 'an explore preset rides source.kind');
    assert.strictEqual(req.source.ref, 'comparison-table', 'the preset id rides source.ref');

    be.setSource(''); // Auto
    req = be.buildCompileRequest();
    assert.strictEqual(JSON.stringify(req.source), JSON.stringify({ kind: 'winner', ref: '' }), 'Auto is winner with an empty ref');
  });

  // ── AC1: the render toggle defaults from the source's default_render and overrides. ──
  await check('setRender / setSource: render defaults from the source default_render and is overridable', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({ async probe() { return true; }, async load() { return null; }, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('winner:moshy-split-screen');
    assert.strictEqual(be.getRender(), 'scene', 'a scene-default winner defaults the render to scene');
    be.setSource('explore:comparison-table');
    assert.strictEqual(be.getRender(), 'typeset', 'a typeset-default explore preset defaults the render to typeset');
    be.setRender('scene');
    assert.strictEqual(be.getRender(), 'scene', 'the operator can override the render');
    assert.strictEqual(be.buildCompileRequest().render, 'scene', 'the override rides the request');
  });

  // ── AC2: the shared wireframe draws one labelled box per region, incl. the repeat range. ──
  await check('renderWireframe draws one box per region of a fixture structure incl. the repeat range', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    const st = sampleStructure();
    const html = be.renderWireframe(st, { title: 'Layout structure' });
    const boxes = (html.match(/data-region-id=/g) || []).length;
    assert.strictEqual(boxes, st.regions.length, 'one box per region');
    assert.ok(/data-region-id="headline"/.test(html) && /data-region-id="cta"/.test(html), 'regions are labelled by id');
    assert.ok(/message-bubble x2-6/.test(html), 'the repeat range is shown on the group box');
    assert.ok(/f10-wf-image/.test(html), 'an image region is marked');
    // The picker also draws the chosen source structure under it before compile.
    be.setStore({ async probe() { return true; }, async load() { return null; }, async save() {}, async sources() { return sourcesResponse(); } });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('winner:moshy-split-screen');
    assert.ok(/data-region-id=/.test(ctx._slots['be-wireframe'].innerHTML), 'the source structure is drawn under the picker before compile');
  });

  // ── AC2 / e2e 1: the per-region editor renders a compile response; an edit to a region's
  //     text and a repeat add + remove round-trip into the /submit payload. ──
  await check('the per-region editor renders a compile response and edits + a repeat add/remove round-trip into /submit', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    let submitted = null;
    be.setStore({
      async probe() { return true; }, async load() { return null; }, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() { return structuredCompileResponse(); },
      async submit(p) { submitted = p; return { ok: true, job_id: 'j1', status: 'running' }; },
      async status() { return { ok: true, job: { status: 'completed', asset_uris: [] } }; },
    });
    await ctx.window.initBriefEditor();
    await be.compileBrief();
    const html = ctx._slots['be-compiled'].innerHTML;
    assert.ok(/be-region/.test(html), 'the per-region editor rendered');
    assert.ok(/data-region-id=/.test(html), 'the structure wireframe rendered in the card');
    assert.ok(/be-rc-0-3/.test(html), 'the cta copy region is an editable field');
    assert.ok(/be-ri-0-1-0/.test(html) && /be-ri-0-1-2/.test(html), 'the repeat group renders its 3 observed items');
    assert.ok(/be-repeat-add/.test(html), 'the repeat group has an add control');
    // Edit the CTA copy and a thread bubble.
    ctx.document.getElementById('be-rc-0-3').value = 'Book now';
    ctx.document.getElementById('be-ri-0-1-0').value = 'Hello there';
    // Add then remove a thread item (round-trips within [min,max]).
    assert.strictEqual(be.addRepeatItem(0, 'thread'), true, 'add succeeds within max');
    assert.strictEqual(be.getVariantRegionCopy(0).thread.length, 4, 'the thread grew to 4');
    assert.strictEqual(be.removeRepeatItem(0, 'thread', 3), true, 'remove succeeds above min');
    assert.strictEqual(be.getVariantRegionCopy(0).thread.length, 3, 'the thread is back to 3');
    // Nudge the CTA box.
    ctx.document.getElementById('be-rb-0-3-x').value = '0.25';
    await be.submitCompiled();
    be.stopPolling();
    assert.ok(submitted && submitted.compiledBrief, 'submit carries the compiled brief');
    const v = submitted.compiledBrief.variants[0];
    assert.ok(v.structure && v.region_copy, 'submit carries the edited structure + region_copy');
    assert.strictEqual(v.region_copy.cta, 'Book now', 'the edited CTA copy round-tripped');
    assert.strictEqual(v.region_copy.thread[0], 'Hello there', 'the edited bubble round-tripped');
    assert.strictEqual(v.region_copy.thread.length, 3, 'the repeat add + remove round-tripped');
    assert.strictEqual(v.structure.regions[3].box.x, 0.25, 'the nudged box round-tripped');
    assert.strictEqual(JSON.stringify(submitted.source), JSON.stringify({ kind: 'winner', ref: '' }), 'submit carries the source');
    assert.strictEqual(submitted.render, 'scene', 'submit carries the render');
  });

  // ── e2e 1 (repeat bounds): add stops at max, remove stops at min. ──
  await check('repeat add/remove respects [min,max]', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() { return null; }, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() {
        return structuredCompileResponse({
          variants: [{
            brief_id: 'b', source: { kind: 'winner', ref: '' }, render: 'scene', layout_family: 'x',
            structure: sampleStructure(), region_copy: { headline: 'h', thread: ['a', 'b'], cta: 'c' },
          }],
        });
      },
    });
    await ctx.window.initBriefEditor();
    await be.compileBrief();
    // At min (2): remove is refused.
    assert.strictEqual(be.removeRepeatItem(0, 'thread', 0), false, 'cannot remove below min');
    assert.strictEqual(be.getVariantRegionCopy(0).thread.length, 2, 'still at min');
    // Grow to max (6): the 5th add is refused.
    assert.strictEqual(be.addRepeatItem(0, 'thread'), true);
    assert.strictEqual(be.addRepeatItem(0, 'thread'), true);
    assert.strictEqual(be.addRepeatItem(0, 'thread'), true);
    assert.strictEqual(be.addRepeatItem(0, 'thread'), true);
    assert.strictEqual(be.getVariantRegionCopy(0).thread.length, 6, 'reached max');
    assert.strictEqual(be.addRepeatItem(0, 'thread'), false, 'cannot add above max');
  });

  // ── AC3 / inspiration e2e: an inspiration source shows the detected-structure
  //     confirmation with confidence and applies NO picker-derived layout. ──
  await check('inspiration mode shows the detected-structure confirmation and applies no picker layout', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    const detected = sampleStructure({ layout_family: 'testimonial-quote-card', structure_confidence: 0.58 });
    be.setStore({
      async probe() { return true; }, async load() { return null; }, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() {
        return structuredCompileResponse({
          detected_structure: detected, structure_confidence: 0.58,
          preset_fallback: { preset_id: 'quote-card', structure: sampleStructure({ layout_family: 'testimonial-quote-card' }), region_copy: {} },
          variants: [{ brief_id: 'i1', source: { kind: 'inspiration', ref: 'gs://insp/a.png' }, render: 'scene',
            layout_family: 'testimonial-quote-card', structure: detected, region_copy: { headline: 'x', thread: ['a', 'b'], cta: 'y' } }],
        });
      },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    be.setSource('inspiration');
    be.selectRef({ gcs_uri: 'gs://insp/a.png', thumb_url: 't' });
    // No picker-derived layout: the request is source.kind inspiration with the chosen ad ref.
    const req = be.buildCompileRequest();
    assert.strictEqual(req.source.kind, 'inspiration', 'inspiration source.kind');
    assert.strictEqual(req.source.ref, 'gs://insp/a.png', 'the ref is the chosen inspiration ad, not a winner/explore layout');
    assert.ok(!('archetypeId' in req), 'no picker-derived archetypeId in inspiration mode');
    await be.compileBrief();
    const html = ctx._slots['be-compiled'].innerHTML;
    assert.ok(/be-insp-confirm/.test(html), 'the confirmation gate is shown');
    assert.ok(/data-region-id=/.test(html), 'the detected structure is drawn as a wireframe');
    assert.ok(/58%/.test(html), 'the detection confidence is shown');
    assert.ok(/be-insp-usepreset/.test(html), 'a preset fallback is offered below threshold');
    assert.strictEqual(ctx._slots['be-submit-bar'].style.display, 'none', 'the submit bar is hidden until confirmed');
    assert.strictEqual(JSON.stringify(be.getInspirationStructure()), JSON.stringify(detected), 'the detected structure is captured');
    // Confirming reveals the per-region editor + submit bar.
    be.confirmInspiration();
    assert.ok(/be-region/.test(ctx._slots['be-compiled'].innerHTML), 'confirming reveals the per-region editor');
    assert.strictEqual(ctx._slots['be-submit-bar'].style.display, '', 'the submit bar is revealed after confirm');
  });

  // ── Degradation: a failed list-sources read never crashes; the picker stays Auto-only. ──
  await check('the source picker degrades to Auto-only when list-sources fails', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() { return null; }, async save() {},
      async sources() { throw new Error('backend down'); },
    });
    await ctx.window.initBriefEditor();
    await be.populateSources();
    const req = be.buildCompileRequest();
    assert.strictEqual(JSON.stringify(req.source), JSON.stringify({ kind: 'winner', ref: '' }), 'a failed read leaves Auto (winner, empty ref)');
    assert.strictEqual(req.render, 'scene', 'and a scene render');
  });

  // ── Legacy fall-through: a compile response with no structure still renders the flat
  //     prompt/copy editor (backward compatibility). ──
  await check('a legacy compile response with no structure falls through to the flat prompt/copy editor', async () => {
    const ctx = makeBrowserCtx();
    const be = ctx.window.f10BriefEditor;
    be.setStore({
      async probe() { return true; }, async load() { return null; }, async save() {},
      async sources() { return sourcesResponse(); },
      async compile() {
        return {
          ok: true, client: 'moshy', variants: [{ brief_id: 'b', prompts: [{ component_role: 'background', prompt: 'A scene' }],
            copy: [{ role: 'headline', text: 'Hi' }] }],
          sizes: [[1080, 1080]], cost_estimate: { files_produced: 1, unique_image_generations: 1, estimated_usd: 0.02, remaining_cap_usd: 25, exceeds_cap: false },
        };
      },
    });
    await ctx.window.initBriefEditor();
    await be.compileBrief();
    const html = ctx._slots['be-compiled'].innerHTML;
    assert.ok(/data-be-edit="prompt"/.test(html) && /data-be-edit="copy"/.test(html), 'the legacy flat editor renders when no structure is present');
    assert.ok(!/be-region\b/.test(html), 'no per-region editor for a legacy response');
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
