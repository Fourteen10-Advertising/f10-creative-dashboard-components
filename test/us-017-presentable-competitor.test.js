/**
 * competitor-intel-noise-gate — isPresentableCompetitor.
 *
 * Pins the TIGHTENED noise gate for the consolidated Competitor Intelligence
 * surface. A nameless page is presentable ONLY on genuine CURRENT activity -
 * live creative this period - not on stale/leftover rows:
 *   - A NAMED competitor is presentable (shows a card + a chart series),
 *     including a named competitor that went dark (US-007: a competitor that WAS
 *     active and went dark is a first-class signal - it keeps its resolved name).
 *   - A NAMELESS page is kept ONLY with live creative NOW: behaviour
 *     creative_volume > 0, or live ads > 0 in the latest age-series point.
 *   - A NAMELESS page is DROPPED when its only "signal" is stale: a zero-valued
 *     behaviour row, a went-dark narrative, faded/abandoned-only theme movements,
 *     or historical-only age points (no live ads this period). That is exactly
 *     the raw page_id noise the user sees.
 *   - The filter also runs inside compiRender: a nameless zero-live competitor
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

  // ── Nameless WITH live creative this period (behaviour) IS kept. ──
  await check('a nameless competitor with live creative this period is kept', async () => {
    assert.strictEqual(isPresentable({
      page_id: '999', behaviour: { creative_volume: 12 },
    }), true, 'nameless + live volume shows');
  });

  // ── Nameless with a CURRENT age-series point (live ads > 0 now) IS kept. ──
  await check('a nameless competitor with live ads in the latest age point is kept', async () => {
    assert.strictEqual(isPresentable({
      page_id: '999',
      series: [
        { period_month: '2026-06-01', ads_live: 5, avg_age_live_days: 40 },
        { period_month: '2026-07-01', ads_live: 7, avg_age_live_days: 44 },
      ],
    }), true, 'nameless + current live ads shows');
  });

  // ── Nameless with HISTORICAL-ONLY age points (no live ads now) is HIDDEN. ──
  await check('a nameless competitor with historical-only age points is hidden', async () => {
    assert.strictEqual(isPresentable({
      page_id: '999',
      series: [{ period_month: '2026-06-01', ads_live: 0, avg_age_live_days: 40 }],
    }), false, 'nameless + no current live ads is dropped');
  });

  // ── Nameless with ONLY theme movements (no live creative) is HIDDEN. ──
  await check('a nameless competitor with only theme movements is hidden', async () => {
    assert.strictEqual(isPresentable({
      page_id: '999', theme_movements: [{ theme_name: 'Price comparison', movement: 'faded' }],
    }), false, 'nameless + theme-movements-only is dropped');
  });

  // ── The exact FastCover noise shape: a nameless, went-dark page with a zero-valued
  //    behaviour row AND leftover faded theme movements is NOW hidden (real data). ──
  await check('a nameless zero-live went-dark page with leftover behaviour/theme rows is hidden', async () => {
    assert.strictEqual(isPresentable({
      page_id: '101529575528208',
      behaviour: { creative_volume: 0, avg_age_live_days: 0, turnover_rate: 0 },
      theme_movements: [
        { theme_name: 'Travel cover', movement: 'faded', theme_share: 0, prior_share: 0.3 },
        { theme_name: 'Price', movement: 'abandoned', theme_share: 0, prior_share: 0.2 },
      ],
      narrative: { went_dark: true, dominant_bet: 'Watch for a relaunch.' },
    }), false, 'nameless zero-live leftover-rows page is dropped');
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
