/**
 * TikTok ROAS + noise-floor metric-awareness acceptance test.
 *
 * Covers the two regression-gate findings on top of the ROAS branch:
 *   1. The TikTok section (dropdown, Ad Production benchmark, scatter title,
 *      classification table header, Creative Effectiveness copy) is metric-aware
 *      instead of hardcoding "CPA".
 *   2. The Weekly noise-floor "× target CPA" control relabels in ROAS mode.
 *
 * The load-bearing guarantee is CPA byte-equivalence: in CPA mode every string
 * the ROAS work touches must be byte-for-byte the legacy copy, so existing
 * dashboards are unchanged. Dependency-free: loads the real f10-utils.js +
 * f10-layout.js into a vm sandbox with a minimal DOM stub, then exercises the
 * exported globals directly (no browser, no BigQuery).
 *
 * Run: node test/tiktok-roas-metric.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const LAYOUT = fs.readFileSync(path.join(ROOT, 'f10-layout.js'), 'utf8');

/* Same default TikTok thresholds the layout seeds in renderLayout, including the
 * ROAS bands added by this change. */
const TT_TH = { HR_SPEND: 5000, HR_CPA: 70, OB_SPEND: 1000, OB_CPA: 100, SO_SPEND: 500, SO_CPA: 140, HR_ROAS: 4, OB_ROAS: 2, SO_ROAS: 1 };

function makeCtx(targetMetric){
  const slots = {};
  const sandbox = {
    window: {},
    console: console,
    document: { getElementById(id){ return (slots[id] = slots[id] || { innerHTML: '' }); } },
    _slots: slots,
  };
  if (targetMetric !== undefined) sandbox.TARGET_METRIC = targetMetric;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  return sandbox;
}

let passed = 0;
function check(name, fn){
  try { fn(); console.log('  ok - ' + name); passed++; }
  catch (e){ console.error('  FAIL - ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('TikTok ROAS + noise-floor metric-awareness');

/* The exact legacy CPA strings this change must preserve byte-for-byte. */
const LEGACY_CPA_OPTIONS = `<option value="CPA" selected>CPA (cost / conversion)</option><option value="CPC">CPC (cost / click)</option><option value="CPM">CPM (cost / 1k impr)</option><option value="CTR">CTR (clicks / impr)</option>`;
const LEGACY_CPA_BENCHMARK = `<span class="bm-item"><strong>Home Run:</strong> Spend &ge; $5,000 &amp; CPA &lt; $70</span><span class="bm-item"><strong>On Base:</strong> Spend &ge; $1,000 &amp; CPA &lt; $100</span><span class="bm-item"><strong>Strike Out:</strong> Spend &ge; $500 &amp; CPA &gt; $140</span>`;

// ── CPA mode: byte-equivalence ─────────────────────────────────────────────
check('CPA: efficiency-metric options are the legacy list, CPA-selected', () => {
  const ctx = makeCtx(undefined);
  assert.strictEqual(ctx.targetMetric(), 'cpa');
  assert.strictEqual(ctx.efficiencyMetricOptionsHTML(), LEGACY_CPA_OPTIONS);
});

check('CPA: TikTok controls dropdown selects CPA and offers no ROAS', () => {
  const ctx = makeCtx(undefined);
  const html = ctx.ttControlsMarkup();
  assert.ok(html.includes(`<select id="tt-ctrl-metric">${LEGACY_CPA_OPTIONS}</select>`), 'dropdown must be the legacy CPA list');
  assert.ok(!/ROAS/.test(html), 'CPA-mode TikTok controls must not mention ROAS');
});

check('CPA: TikTok Ad Production benchmark is byte-identical legacy copy', () => {
  const ctx = makeCtx(undefined);
  assert.strictEqual(ctx.ttProdBenchmarkHTML(TT_TH), LEGACY_CPA_BENCHMARK);
});

check('CPA: noise-floor labels are the legacy "target CPA" copy', () => {
  const l = makeCtx(undefined).noiseFloorMultLabels();
  assert.strictEqual(l.btn, '&times; target CPA');
  assert.strictEqual(l.label, 'Target CPA / Mult');
  assert.strictEqual(l.title, 'Target CPA ($)');
});

check('CPA: TikTok panels keep CPA wording and emit no revenue-guard slots', () => {
  const ctx = makeCtx(undefined);
  const html = ctx.ttPanelsMarkup(TT_TH);
  assert.ok(html.includes('Lifetime Spend vs CPA'), 'scatter title stays CPA');
  assert.ok(html.includes('<th>Lifetime CPA</th>'), 'classification table header stays CPA');
  assert.ok(html.includes('at an efficient CPA'), 'production insight copy stays CPA');
  assert.ok(html.includes('attention beyond CPA'), 'creative-effectiveness copy stays CPA');
  assert.ok(!html.includes('tt-production-revenue-guard'), 'no production guard slot in CPA mode');
  assert.ok(!html.includes('tt-summary-revenue-guard'), 'no summary guard slot in CPA mode');
});

// ── ROAS mode: metric-aware copy ───────────────────────────────────────────
check('ROAS: efficiency-metric options lead with ROAS, selected', () => {
  const ctx = makeCtx('roas');
  assert.strictEqual(ctx.targetMetric(), 'roas');
  const opts = ctx.efficiencyMetricOptionsHTML();
  assert.ok(opts.startsWith('<option value="ROAS" selected>ROAS (revenue / spend)</option>'), 'ROAS must lead and be selected');
  assert.ok(opts.includes('<option value="CPA">CPA (cost / conversion)</option>'), 'CPA remains available (not selected)');
});

check('ROAS: TikTok controls dropdown selects ROAS', () => {
  const ctx = makeCtx('roas');
  const html = ctx.ttControlsMarkup();
  assert.ok(html.includes('<option value="ROAS" selected>ROAS (revenue / spend)</option>'), 'TikTok dropdown must lead with ROAS');
});

check('ROAS: Ad Production benchmark flips to ROAS floors/ceiling', () => {
  const ctx = makeCtx('roas');
  const html = ctx.ttProdBenchmarkHTML(TT_TH);
  assert.ok(html.includes('ROAS &ge; 4.0x'), 'Home Run is a ROAS floor');
  assert.ok(html.includes('ROAS &ge; 2.0x'), 'On Base is a ROAS floor');
  assert.ok(html.includes('ROAS &lt; 1.0x'), 'Strike Out is a ROAS ceiling');
  assert.ok(!/&amp; CPA/.test(html), 'no CPA wording in ROAS benchmark');
});

check('ROAS: noise-floor labels relabel to a plain spend target', () => {
  const l = makeCtx('roas').noiseFloorMultLabels();
  assert.strictEqual(l.btn, '&times; spend target');
  assert.strictEqual(l.label, 'Spend target / Mult');
  assert.strictEqual(l.title, 'Spend target ($)');
});

check('ROAS: TikTok panels swap CPA copy for ROAS and emit guard slots', () => {
  const ctx = makeCtx('roas');
  const html = ctx.ttPanelsMarkup(TT_TH);
  assert.ok(html.includes('Lifetime Spend vs ROAS'), 'scatter title becomes ROAS');
  assert.ok(html.includes('<th>Lifetime ROAS</th>'), 'classification table header becomes ROAS');
  assert.ok(html.includes('at a strong ROAS'), 'production insight copy becomes ROAS');
  assert.ok(html.includes('attention beyond ROAS'), 'creative-effectiveness copy becomes ROAS');
  assert.ok(html.includes('id="tt-production-revenue-guard"'), 'production guard slot present in ROAS mode');
  assert.ok(html.includes('id="tt-summary-revenue-guard"'), 'summary guard slot present in ROAS mode');
  assert.ok(!html.includes('Lifetime Spend vs CPA'), 'no stale CPA scatter title');
  assert.ok(!html.includes('<th>Lifetime CPA</th>'), 'no stale CPA table header');
});

// ── The two dropdowns must never drift ─────────────────────────────────────
check('Meta and TikTok share one dropdown source in both modes', () => {
  for (const mode of [undefined, 'roas']){
    const ctx = makeCtx(mode);
    const opts = ctx.efficiencyMetricOptionsHTML();
    assert.ok(ctx.ttControlsMarkup().includes(`<select id="tt-ctrl-metric">${opts}</select>`), 'TikTok dropdown uses the shared option set (' + (mode || 'cpa') + ')');
  }
});

console.log(`\nTikTok ROAS + noise-floor: ${passed} checks passed.`);
