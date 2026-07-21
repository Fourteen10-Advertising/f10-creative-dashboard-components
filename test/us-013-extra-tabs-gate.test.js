/**
 * US-013 — launch gate for the secondary competitor sub-tabs.
 *
 * Tab 1 (Competitor Ads) always ships. Tabs 2–4 (Vision & Text, Ad Age Over Time,
 * Meta Maturity Score) are held behind COMP_EXTRA_TABS: they register only when
 * the launch gate is on AND their own data probe says exists. This locks in the
 * v1.15.0 behaviour (extra tabs hidden by default) and the v1.15.1 release path
 * (flip the default / per-dashboard EXTRA_TABS:true), so nobody can un-hide them
 * by accident.
 *
 * All probes are stubbed exists:true here, so the ONLY thing deciding whether
 * tabs 2–4 appear is the gate — which is exactly what we want to pin.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm
 * sandbox (mirrors us-009/010/011) and boots window.initCompetitors().
 *
 * Run: node test/us-013-extra-tabs-gate.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const COMPETITORS = fs.readFileSync(path.join(ROOT, 'f10-competitors.js'), 'utf8');

function makeDom() {
  const slots = {};
  function mkSlot(id) {
    return {
      id, innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener() {}, insertAdjacentHTML(_pos, html) { this.innerHTML += html; }, scrollIntoView() {},
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

/* Boot the module with a given COMPETITORS config (or none) and all four probes
 * returning exists:true, then return the accumulated nav + content HTML. */
async function bootWith(competitorsConfig) {
  const { document, slots } = makeDom();
  const window = { f10MediaMarkup: () => '' };
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    DATASET: 'mosh_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    // Every probe says the data exists — so the gate is the only variable.
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ exists: true }), text: async () => '{}' }),
    competitorPanelMarkup: () => '<div id="panel-competitors"></div>',
    competitorThemesPanelMarkup: () => '<div id="panel-competitor-themes"></div>',
    competitorAgePanelMarkup: () => '<div id="panel-competitor-age"></div>',
    competitorMaturityPanelMarkup: () => '<div id="panel-competitor-maturity"></div>',
  };
  if (competitorsConfig !== undefined) sandbox.COMPETITORS = competitorsConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  await window.initCompetitors();
  return {
    nav: (slots['__nav'] && slots['__nav'].innerHTML) || '',
    content: (slots['content'] && slots['content'].innerHTML) || '',
  };
}

const EXTRA = [
  ['Vision & Text', 'comp-themes-nav-link', 'panel-competitor-themes'],
  ['Ad Age Over Time', 'comp-age-nav-link', 'panel-competitor-age'],
  ['Meta Maturity Score', 'comp-maturity-nav-link', 'panel-competitor-maturity'],
];

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('US-013 secondary competitor tabs launch gate');

  // ── Default (no config): tab 1 ships, tabs 2–4 stay hidden even though every probe says exists. ──
  await check('default (gate off) registers only Competitor Ads; extra tabs hidden despite exists:true', async () => {
    const { nav, content } = await bootWith(undefined);
    assert.ok(/comp-nav-link/.test(nav), 'Competitor Ads nav link present');
    assert.ok(/panel-competitors/.test(content), 'Competitor Ads panel present');
    for (const [label, navCls, panelId] of EXTRA) {
      assert.ok(!new RegExp(navCls).test(nav), `${label} nav link must be absent`);
      assert.ok(!new RegExp(panelId).test(content), `${label} panel must be absent`);
    }
  });

  // ── EXTRA_TABS:true previews all secondary tabs (the v1.15.1 released state). ──
  await check('EXTRA_TABS:true registers all four tabs', async () => {
    const { nav, content } = await bootWith({ EXTRA_TABS: true });
    assert.ok(/comp-nav-link/.test(nav), 'Competitor Ads still present');
    for (const [label, navCls, panelId] of EXTRA) {
      assert.ok(new RegExp(navCls).test(nav), `${label} nav link present`);
      assert.ok(new RegExp(panelId).test(content), `${label} panel present`);
    }
  });

  // ── EXTRA_TABS:false is an explicit hide (same as default). ──
  await check('EXTRA_TABS:false keeps the extra tabs hidden', async () => {
    const { nav } = await bootWith({ EXTRA_TABS: false });
    assert.ok(/comp-nav-link/.test(nav), 'Competitor Ads present');
    for (const [label, navCls] of EXTRA) {
      assert.ok(!new RegExp(navCls).test(nav), `${label} nav link must be absent`);
    }
  });

  console.log(`\nUS-013 OK — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
