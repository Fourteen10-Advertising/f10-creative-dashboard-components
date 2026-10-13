/**
 * Generic tab dispatcher canary (f10-layout.js f10WireNavDispatcher +
 * f10RegisterModuleTab, and the tab-aware Meta controls-bar show path in f10-weekly.js).
 *
 * Boots the REAL base Meta engine (f10-weekly), TikTok engine (f10-tiktok) and
 * Competitor module (f10-competitors) on a functional DOM whose clicks bubble, then
 * registers a late module tab through f10RegisterModuleTab (the way a config-gated
 * channel tab such as YouTube registers) and asserts:
 *   - every tab, old and new, switches to exactly ONE visible panel and exactly ONE
 *     highlighted nav link, in any click order;
 *   - without the delegated dispatcher the old engines leave a late-registered tab's
 *     link highlighted (the bug the dispatcher fixes), so the canary is meaningful;
 *   - the dispatcher binds once (idempotent);
 *   - a late Meta re-render (applyControlsVisibility) does not re-show the Meta
 *     controls bar over a module tab, but still shows it on a Meta tab.
 *
 * Run: node test/tab-dispatcher.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { makeLiveDom } = require('./helpers/live-dom');

const ROOT = path.join(__dirname, '..');
const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UTILS = readSrc('f10-utils.js');
const WEEKLY = readSrc('f10-weekly.js');
const TIKTOK = readSrc('f10-tiktok.js');
const COMPETITORS = readSrc('f10-competitors.js');
const LAYOUT = readSrc('f10-layout.js');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }
function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

async function boot(opts) {
  opts = opts || {};
  const dom = makeLiveDom();
  const document = dom.document;
  const sidebar = document.createElement('div'); sidebar.id = 'sidebar';
  const nav = document.createElement('nav'); sidebar.appendChild(nav);
  const content = document.createElement('div'); content.id = 'content';
  const title = document.createElement('h1'); title.id = 'page-title'; content.appendChild(title);
  ['controls-bar', 'tt-controls-bar', 'weekly-controls'].forEach((id) => { const d = document.createElement('div'); d.id = id; content.appendChild(d); });

  function addNavLink(cls, key, val) { const a = document.createElement('a'); a.className = cls; a.dataset[key] = val; nav.appendChild(a); return a; }
  function addPanel(id, cls) { const p = document.createElement('div'); p.className = cls; p.id = id; content.appendChild(p); return p; }
  ['summary', 'board', 'map', 'powerlaw', 'production'].forEach((t, i) => {
    const l = addNavLink('nav-link', 'tab', t); const p = addPanel('tab-' + t, 'tab-panel');
    if (i === 0) { l.classList.add('active'); p.classList.add('active'); }
  });
  ['tt-summary', 'tt-board'].forEach((t) => { addNavLink('tt-nav-link', 'ttTab', t); addPanel('panel-' + t, 'tab-panel tt-tab-panel'); });

  const fetchImpl = async (url, o) => {
    const body = JSON.parse(o.body);
    if (body.action) {
      if (body.probe) return jsonResponse({ exists: body.action === 'competitor' });
      if (body.action === 'competitor') return jsonResponse({ ads: [], ageMetrics: { client: null, byPage: {} }, days: 90 });
      return jsonResponse({});
    }
    return jsonResponse([]);
  };
  const window = { f10MediaMarkup: () => '', F10A: { track() {} } };
  const sandbox = {
    window, document, console: { log() {}, warn() {}, error() {} }, F10A: window.F10A,
    PROJECT: 'mcc-poc-477801', DATASET: 'acme_marts', TABLE: 'creative_reporting', CONV_EXPR: 'purchase',
    CLIENT_NAME: 'Acme', TIKTOK: { TABLE: 'tiktok_creative_reporting' },
    BQ_FUNCTION: '/.netlify/functions/bq', fetch: fetchImpl, setTimeout, clearTimeout,
    Chart: function () { return { destroy() {} }; },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    competitorPanelMarkup: () => '<div class="tab-panel comp-tab-panel" id="panel-competitors"></div>',
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(WEEKLY, sandbox, { filename: 'f10-weekly.js' });
  vm.runInContext(TIKTOK, sandbox, { filename: 'f10-tiktok.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  sandbox.loadMonthlyTab = function () {};

  sandbox.wireControls();
  if (!opts.skipDispatcher) sandbox.f10WireNavDispatcher();
  await sandbox.window.initTikTok();
  await sandbox.window.initCompetitors();
  // A late, self-registering module tab (the shape the YouTube tab uses).
  let activations = 0;
  const modLink = sandbox.f10RegisterModuleTab({
    section: 'Module', linkClass: 'mod-nav-link', label: 'Module Tab', panelId: 'panel-mod',
    panelHtml: '<div class="tab-panel mod-tab-panel" id="panel-mod"></div>', onActivate: () => { activations++; },
  });
  return { document, sandbox, nav, modLink, activations: () => activations };
}

const activePanels = (d) => d.querySelectorAll('.tab-panel').filter((p) => p.classList.contains('active'));
const activeLinks = (d) => d.querySelectorAll('#sidebar nav a').filter((a) => a.classList.contains('active'));

function link(d, sel, pred) { const l = d.querySelectorAll(sel).find(pred || (() => true)); assert.ok(l, 'link ' + sel); return l; }

(async () => {
  console.log('Generic tab dispatcher');

  await check('renderLayout installs the delegated nav dispatcher', async () => {
    assert.ok(/function f10WireNavDispatcher\(/.test(LAYOUT));
    assert.ok(/function f10RegisterModuleTab\(/.test(LAYOUT));
    const body = LAYOUT.slice(LAYOUT.indexOf('function renderLayout('));
    assert.ok(/f10WireNavDispatcher\(\);/.test(body), 'renderLayout calls f10WireNavDispatcher()');
  });

  const { document, sandbox, nav, modLink, activations } = await boot();

  await check('f10RegisterModuleTab injects one nav link + one .tab-panel', async () => {
    assert.strictEqual(document.querySelectorAll('.mod-nav-link').length, 1);
    assert.ok(modLink && modLink.classList.contains('mod-nav-link'));
    assert.ok(document.getElementById('panel-mod').classList.contains('tab-panel'));
    assert.strictEqual(document.querySelectorAll('.comp-nav-link').length, 1, 'competitor tab registered too');
  });

  const tabs = [
    { label: 'Meta Weekly Summary', get: () => link(document, '.nav-link', (e) => e.dataset.tab === 'summary'), panel: 'tab-summary' },
    { label: 'Module tab', get: () => modLink, panel: 'panel-mod' },
    { label: 'Meta Movement Board', get: () => link(document, '.nav-link', (e) => e.dataset.tab === 'board'), panel: 'tab-board' },
    { label: 'Module tab (again)', get: () => modLink, panel: 'panel-mod' },
    { label: 'TikTok Weekly Summary', get: () => link(document, '.tt-nav-link', (e) => e.dataset.ttTab === 'tt-summary'), panel: 'panel-tt-summary' },
    { label: 'Module tab (from TikTok)', get: () => modLink, panel: 'panel-mod' },
    { label: 'Competitor Ads', get: () => link(document, '.comp-nav-link'), panel: 'panel-competitors' },
    { label: 'Meta Ad Production', get: () => link(document, '.nav-link', (e) => e.dataset.tab === 'production'), panel: 'tab-production' },
  ];
  for (const t of tabs) {
    await check('exactly one panel and one nav link after: ' + t.label, async () => {
      const l = t.get();
      l.click();
      const ap = activePanels(document);
      assert.strictEqual(ap.length, 1, 'one visible panel, got ' + ap.map((p) => p.id).join(','));
      assert.strictEqual(ap[0].id, t.panel);
      const al = activeLinks(document);
      assert.strictEqual(al.length, 1, 'one highlighted link, got ' + al.map((a) => a.className).join(' | '));
      assert.strictEqual(al[0], l, 'the clicked link is the highlighted one');
    });
  }

  await check('module onActivate fires through f10ActivateTab', async () => {
    assert.ok(activations() >= 3);
    modLink.click();
    assert.strictEqual(document.getElementById('page-title').textContent, 'Module Tab');
  });

  await check('a late Meta re-render does not re-show the Meta controls bar over a module tab', async () => {
    modLink.click();
    sandbox.applyControlsVisibility();
    assert.strictEqual(document.getElementById('controls-bar').style.display, 'none');
    link(document, '.nav-link', (e) => e.dataset.tab === 'summary').click();
    sandbox.applyControlsVisibility();
    assert.strictEqual(document.getElementById('controls-bar').style.display, 'flex', 'still shown on a Meta tab');
  });

  await check('dispatcher binds once (idempotent)', async () => {
    const before = (nav._listeners.click || []).length;
    sandbox.f10WireNavDispatcher();
    assert.strictEqual((nav._listeners.click || []).length, before);
  });

  await check('without the dispatcher the old engines leave the module link highlighted (bug reproduced)', async () => {
    const b = await boot({ skipDispatcher: true });
    b.modLink.click();
    link(b.document, '.comp-nav-link').click();
    const al = activeLinks(b.document);
    assert.ok(al.length > 1 && al.indexOf(b.modLink) !== -1, 'stale module highlight without the dispatcher');
  });

  console.log('\nTab dispatcher OK - ' + passed + ' checks passed.');
})().catch((e) => { console.error('\nTab dispatcher FAILED:', (e && e.stack) || e); process.exit(1); });
