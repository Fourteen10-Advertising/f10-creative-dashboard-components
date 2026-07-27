/**
 * competitor-intel-noise-gate — isPresentableCompetitor.
 *
 * Pins the noise gate for the consolidated Competitor Intelligence surface:
 *   - A NAMED competitor with prior activity is presentable (shows a card + a
 *     chart series), including a named competitor that went dark (US-007: a
 *     competitor that WAS active and went dark is a first-class signal).
 *   - A NAMELESS, went-dark / no-signal competitor is NOT presentable (dropped
 *     from both the cards and the age-chart series/legend) — it is the raw
 *     page_id "went dark" noise card with nothing to say.
 *   - A nameless page that still carries a signal (behaviour / effort / theme
 *     movements / drawable age series) IS kept.
 *   - The filter also runs inside compiRender: a nameless went-dark competitor
 *     never renders a card, and an all-noise set degrades to the empty state.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm
 * sandbox (mirrors us-008) and drives window.f10CompetitorIntel.
 *
 * Run: node test/us-017-presentable-competitor.test.js
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
      addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
      insertAdjacentHTML(_pos, html) { this.innerHTML += html; }, scrollIntoView() {},
    };
  }
  const document = {
    getElementById(id) { return slots[id] || (slots[id] = mkSlot(id)); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return { document, slots };
}

function boot() {
  const { document, slots } = makeDom();
  const window = { f10MediaMarkup: () => '' };
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    DATASET: 'mosh_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ exists: true }), text: async () => '{}' }),
    competitorPanelMarkup: () => '<div id="panel-competitors"></div>',
    competitorIntelPanelMarkup: () => '<div id="panel-competitor-intel"></div>',
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  return { sandbox, slots };
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }

(async () => {
  console.log('US-017 isPresentableCompetitor noise gate');
  const { sandbox, slots } = boot();
  const CI = sandbox.window.f10CompetitorIntel;
  const isPresentable = CI.isPresentableCompetitor;

  // ── Named + active is presentable. ──
  await check('a named competitor with prior activity is presentable', async () => {
    assert.strictEqual(isPresentable({
      page_id: '123', page_name: 'Acme Insurance Pty Ltd',
      behaviour: { creative_volume: 24 },
      narrative: { dominant_bet: 'Leaning into price-comparison hooks.' },
    }), true, 'named + active shows');
  });

  // ── Named + went dark is STILL presentable (first-class went-dark signal). ──
  await check('a named competitor that went dark is kept (first-class signal)', async () => {
    assert.strictEqual(isPresentable({
      page_id: '123', page_name: 'Acme Insurance Pty Ltd',
      narrative: { went_dark: true, dominant_bet: 'Watch for a relaunch.' },
    }), true, 'named went-dark stays');
  });

  // ── Nameless + went dark + no signal is NOISE → hidden. ──
  await check('a nameless, went-dark, no-signal competitor is hidden', async () => {
    assert.strictEqual(isPresentable({
      page_id: '101529575528208',
      narrative: { went_dark: true, dominant_bet: 'Watch for a relaunch.' },
    }), false, 'nameless went-dark is dropped');
  });

  // ── page_name that is only the raw page_id echoed back is NOT a resolved name. ──
  await check('a page_name equal to the raw page_id does not count as resolved', async () => {
    assert.strictEqual(isPresentable({
      page_id: '101529575528208', page_name: '101529575528208',
      narrative: { went_dark: true },
    }), false, 'echoed page_id is not a name');
  });

  // ── Nameless but with a drawable age series IS kept (it was active over time). ──
  await check('a nameless competitor with a drawable age series is kept', async () => {
    assert.strictEqual(isPresentable({
      page_id: '999',
      series: [{ period_month: '2026-06-01', avg_age_live_days: 40 }],
    }), true, 'nameless + series shows');
  });

  // ── Nameless but with theme movements / effort is kept. ──
  await check('a nameless competitor with theme movements is kept', async () => {
    assert.strictEqual(isPresentable({
      page_id: '999', theme_movements: [{ theme_name: 'Price comparison', movement: 'intensified' }],
    }), true, 'nameless + theme movement shows');
  });

  // ── Non-object / empty input is not presentable (absent-safe). ──
  await check('non-object input is not presentable', async () => {
    assert.strictEqual(isPresentable(null), false, 'null dropped');
    assert.strictEqual(isPresentable({}), false, 'empty object dropped');
  });

  // ── compiRender filters the noise: a mixed set renders only the signal card. ──
  await check('compiRender drops the nameless went-dark card but keeps the named one', async () => {
    CI.render({
      competitors: [
        { page_id: '123', page_name: 'Acme Insurance', narrative: { dominant_bet: 'Price hooks.' } },
        { page_id: '101529575528208', narrative: { went_dark: true, dominant_bet: 'Watch for a relaunch.' } },
      ],
      winners: [],
    }, null);
    const body = slots['compi-body'];
    assert.ok(body, 'body slot exists');
    assert.ok(/Acme Insurance/.test(body.innerHTML), 'named competitor card rendered');
    assert.ok(!/101529575528208/.test(body.innerHTML), 'nameless went-dark noise card dropped');
    // Meta count reflects only the presentable competitor.
    const meta = slots['compi-meta'];
    assert.ok(meta && /^1 competitor /.test(meta.textContent), 'meta count reflects presentable only');
  });

  // ── An all-noise set degrades to the clean empty state (no crash). ──
  await check('an all-noise competitor set degrades to the empty state', async () => {
    CI.render({
      competitors: [
        { page_id: '101529575528208', narrative: { went_dark: true } },
        { page_id: '202020202020202', narrative: { went_dark: true } },
      ],
      winners: [],
    }, null);
    const body = slots['compi-body'];
    assert.ok(body && /No consolidated competitor intelligence/i.test(body.innerHTML), 'empty state shown');
  });

  console.log(`\nUS-017 OK — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
