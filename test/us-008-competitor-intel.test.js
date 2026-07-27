/**
 * competitor-intel-rollup US-008 — the consolidated Competitor Intelligence surface.
 *
 * Pins the acceptance criteria that live in the dashboard layer:
 *   1. The consolidated tab registers on its own competitor-intel probe (and appears
 *      ONLY when that probe returns exists:true — no competitor-intel rows, no tab).
 *   2. The per-competitor card renders the human-readable page_name in its header
 *      (the recurring page_name/page_id drift fix: the frontend receives + shows
 *      page_name, falling back to page_id only when no name is present).
 *   3. The reworked visualisation renders movements (behaviour + theme), effort
 *      allocation, the behaviour archetype, the go-live staying-power winners, and
 *      the narrative — the "so what" / "now what", not a bare tag list.
 *   4. A went-dark competitor is a first-class state, not an error.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm
 * sandbox (mirrors us-009/010/011/013) and drives window.f10CompetitorIntel.
 *
 * Run: node test/us-008-competitor-intel.test.js
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
    querySelector(sel) {
      if (sel === '#sidebar nav') return slots['__nav'] || (slots['__nav'] = mkSlot('__nav'));
      return null;
    },
    querySelectorAll() { return []; },
  };
  return { document, slots };
}

/* Boot the module. `intelExists` decides what the competitor-intel probe returns;
 * every other probe returns exists:true so the intel gate is the only variable. */
function bootSandbox(intelExists) {
  const { document, slots } = makeDom();
  const window = { f10MediaMarkup: () => '' };
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    DATASET: 'mosh_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: async (_url, opts) => {
      const body = JSON.parse((opts && opts.body) || '{}');
      const exists = body.action === 'competitor-intel' ? !!intelExists : true;
      return { ok: true, status: 200, json: async () => ({ exists }), text: async () => '{}' };
    },
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
  console.log('US-008 consolidated Competitor Intelligence surface');

  // ── 1. Probe gating: the tab appears only when competitor-intel rows exist. ──
  await check('registers the consolidated tab when the competitor-intel probe says exists:true', async () => {
    const { sandbox, slots } = bootSandbox(true);
    await sandbox.window.initCompetitors();
    const nav = (slots['__nav'] && slots['__nav'].innerHTML) || '';
    const content = (slots['content'] && slots['content'].innerHTML) || '';
    assert.ok(/comp-intel-nav-link/.test(nav), 'Competitor Intelligence nav link present');
    assert.ok(/panel-competitor-intel/.test(content), 'Competitor Intelligence panel present');
  });

  await check('does NOT register the consolidated tab when competitor-intel probe says exists:false', async () => {
    const { sandbox, slots } = bootSandbox(false);
    await sandbox.window.initCompetitors();
    const nav = (slots['__nav'] && slots['__nav'].innerHTML) || '';
    const content = (slots['content'] && slots['content'].innerHTML) || '';
    assert.ok(!/comp-intel-nav-link/.test(nav), 'Competitor Intelligence nav link absent');
    assert.ok(!/panel-competitor-intel/.test(content), 'Competitor Intelligence panel absent');
    // Competitor Ads (its own probe true) still registers, so the surface still exists.
    assert.ok(/comp-nav-link/.test(nav), 'Competitor Ads still present');
  });

  // ── 2. page_name fix: the card header shows page_name, not a bare page_id. ──
  await check('renders page_name in the card header (page_name drift fix)', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.competitorCardHtml({
      page_id: '123456789', page_name: 'Acme Insurance Pty Ltd',
      narrative: { dominant_bet: 'Leaning hard into price-comparison hooks.' },
    });
    assert.ok(html.indexOf('Acme Insurance Pty Ltd') !== -1, 'shows page_name');
    assert.ok(html.indexOf('123456789') === -1, 'does not show the bare page_id when a name exists');
  });

  await check('falls back to page_id only when no page_name is present', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.competitorCardHtml({ page_id: '987654321', narrative: null });
    assert.ok(html.indexOf('987654321') !== -1, 'shows page_id fallback');
  });

  // ── 3. Reworked visualisation: narrative + effort + behaviour + themes + archetype. ──
  await check('renders the narrative in insight-ladder order (bet, changed, staying power, whitespace)', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.narrativeHtml({
      dominant_bet: 'Betting on urgency + discounting.',
      notable_movements: 'Video share up sharply.',
      staying_power: 'One evergreen testimonial ad running 140 days.',
      whitespace_read: 'You own the education angle they ignore.',
      confidence: 'high', coverage_caveat: 'Scraping misses some ads; longevity is a proxy.',
    });
    assert.ok(html.indexOf('Betting on urgency') !== -1, 'dominant bet shown');
    assert.ok(html.indexOf('What changed') !== -1 && html.indexOf('Video share up') !== -1, 'movements shown');
    assert.ok(html.indexOf('Staying power') !== -1, 'staying power shown');
    assert.ok(html.indexOf('Whitespace vs you') !== -1, 'whitespace shown');
    assert.ok(html.indexOf('longevity is a proxy') !== -1, 'coverage caveat shown');
  });

  await check('went-dark competitor is a first-class state, not an error', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.narrativeHtml({ went_dark: true, dominant_bet: 'No live ads this month.' });
    assert.ok(/gone dark/i.test(html), 'renders a went-dark state');
  });

  await check('effort allocation renders shares as movement bars with a trend', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.effortHtml([
      { dimension: 'format_canonical', dimension_value: 'video', share: 0.62, delta_share: 0.11, trend: 'up' },
      { dimension: 'format_canonical', dimension_value: 'image', share: 0.38, delta_share: -0.11, trend: 'down' },
    ]);
    assert.ok(html.indexOf('Format') !== -1, 'dimension label shown');
    assert.ok(html.indexOf('video') !== -1 && html.indexOf('62%') !== -1, 'top bucket + share shown');
    assert.ok(/betting on now/i.test(html), 'effort section titled');
  });

  await check('behaviour movements render stat tiles with values', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.behaviourHtml({
      creative_volume: 24, creative_volume_delta: 5, creative_volume_trend: 'up',
      turnover_rate: 0.3, turnover_rate_trend: 'flat', avg_age_live_days: 47, avg_age_live_days_trend: 'up',
    });
    assert.ok(html.indexOf('Live creative') !== -1 && html.indexOf('24') !== -1, 'volume tile');
    assert.ok(html.indexOf('47d') !== -1, 'avg live age tile');
    assert.ok(/how they’re moving/i.test(html), 'behaviour section titled');
  });

  await check('theme movements render honest emerged/intensified/genuine-faded labels only', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.themeMovesHtml([
      { theme_name: 'Price comparison', movement: 'intensified', theme_share: 0.4, prior_share: 0.2, longevity_avg_age_live_days: 60 },
      // Genuine decline: still present this period at a LOWER share than a real prior.
      { theme_name: 'Bundles', movement: 'faded', theme_share: 0.15, prior_share: 0.4 },
      // Absence-only: theme not seen this period (share 0) - NOT an observed strategic
      // fade, so honest rendering SUPPRESSES it rather than imply a retreat we did not see.
      { theme_name: 'Seasonal', movement: 'abandoned', theme_share: 0.0, prior_share: 0.3 },
    ]);
    assert.ok(html.indexOf('Price comparison') !== -1 && /intensified/i.test(html), 'intensified theme rendered');
    assert.ok(html.indexOf('Bundles') !== -1 && /faded/i.test(html), 'genuine (present + declining) fade rendered');
    assert.ok(!/abandoned/i.test(html) && html.indexOf('Seasonal') === -1, 'absence-only abandoned theme suppressed');
  });

  await check('archetype badge renders the data-owned label verbatim', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.archetypeBadge({ archetype: 'conviction', archetype_rationale: 'low churn, long go-live age' });
    assert.ok(/conviction/i.test(html), 'archetype label shown');
    assert.ok(html.indexOf('low churn') !== -1, 'rationale carried in tooltip');
  });

  await check('go-live staying-power winners render ranked by go-live age', async () => {
    const { sandbox } = bootSandbox(true);
    const html = sandbox.window.f10CompetitorIntel.winnersHtml([
      { page_name: 'Acme', display_format: 'video', live_age_days: 140, snapshot_url: 'https://facebook.com/ads/x' },
      { page_name: 'Beta', display_format: 'image', live_age_days: 90, snapshot_url: 'not-a-url' },
    ]);
    assert.ok(html.indexOf('Acme') !== -1 && html.indexOf('140d') !== -1, 'winner age shown');
    assert.ok(html.indexOf('#1') !== -1, 'ranked');
    assert.ok(html.indexOf('https://facebook.com/ads/x') !== -1, 'safe http(s) link rendered');
    assert.ok(html.indexOf('not-a-url') === -1, 'non-http url dropped');
  });

  // ── 4. Empty state: no rows anywhere → a clean empty state, no crash. ──
  await check('renders a clean empty state when there is no consolidated data', async () => {
    const { sandbox, slots } = bootSandbox(true);
    sandbox.window.f10CompetitorIntel.render({ competitors: [], winners: [] }, null);
    const body = slots['compi-body'];
    assert.ok(body && /No consolidated competitor intelligence/i.test(body.innerHTML), 'empty state shown');
  });

  console.log(`\nUS-008 OK — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
