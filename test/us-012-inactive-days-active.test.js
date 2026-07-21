/**
 * US-012 — "days active" badge honours Meta's stop date for inactive ads.
 *
 * Regression for the competitor-tab card badge (f10-competitors.js). Meta shows a
 * single start date for a live ad ("9 Jan 2026") and a start–stop RANGE for a
 * stopped ad ("9 Jan 2026 - 15 Jan 2026"). The badge used to compute
 * (today - start) for every ad, so a stopped ad's "Nd active" kept climbing to
 * today instead of freezing at its real run length. It must now count:
 *   - LIVE ad      -> today - start (still running);
 *   - STOPPED ad   -> stop - start  when Meta gives a stop date;
 *   - STOPPED, no stop date -> falls back to today - start.
 *
 * Dependency-free: loads the real f10-utils.js + f10-competitors.js into a vm
 * sandbox with a tiny DOM/media stub (mirrors us-008) and drives the exported
 * card renderer window.f10CompetitorSearch.cardHtml exactly as the grid does.
 *
 * Run: node test/us-012-inactive-days-active.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const COMPETITORS = fs.readFileSync(path.join(ROOT, 'f10-competitors.js'), 'utf8');

/* Minimal sandbox: utils + competitors with a media stub. cardHtml touches no
 * DOM, so no document stub is needed for these assertions. */
function makeCtx() {
  const window = {
    f10MediaMarkup: (media, opts) =>
      `<img class="${(opts && opts.className) || ''}" src="${media && media.url}">`,
  };
  const sandbox = { window, console };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  return window.f10CompetitorSearch;
}

/* Whole days between two YYYY-MM-DD dates, UTC — the expected badge value. */
function daysBetween(startStr, endStr) {
  const p = (s) => { const [y, mo, d] = s.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
  return Math.floor((p(endStr) - p(startStr)) / 86400000);
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

function ad(over) {
  return Object.assign({
    ad_archive_id: 'A1', page_name: 'CompA', display_format: 'Image', cta_type: 'SHOP_NOW',
    ad_creative_bodies: ['copy'], creatives: [{ media_type: 'image', url: 'https://signed.example/x.jpg' }],
  }, over);
}
function badge(html) {
  const m = html.match(/(\d+)d active/);
  return m ? Number(m[1]) : null;
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

console.log('US-012 inactive days-active badge');
const CS = makeCtx();

// ── The bug: a STOPPED ad freezes at stop - start, not today - start ──
check('stopped ad with a stop date shows stop - start (frozen), not today - start', () => {
  const html = CS.cardHtml(ad({
    ad_delivery_start_time: '2020-01-01', ad_delivery_stop_time: '2020-01-07',
    is_active: false, still_active: false,
  }));
  assert.strictEqual(badge(html), 6, 'range 1 Jan–7 Jan 2020 = 6 days');
  assert.ok(/comp-tag off/.test(html), 'labelled stopped');
  // Must NOT be the (today - start) value, which is the old broken behaviour.
  assert.notStrictEqual(badge(html), daysBetween('2020-01-01', todayStr()));
});

// ── still_active is honoured over is_active (registry sweep wins) ──
check('still_active=false overrides is_active=true and freezes at the stop date', () => {
  const html = CS.cardHtml(ad({
    ad_delivery_start_time: '2020-01-01', ad_delivery_stop_time: '2020-01-11',
    is_active: true, still_active: false,
  }));
  assert.strictEqual(badge(html), 10, 'swept-inactive ad freezes at stop - start');
});

// ── A LIVE ad still counts to today (unchanged behaviour) ──
check('live ad still counts start -> today', () => {
  const html = CS.cardHtml(ad({
    ad_delivery_start_time: '2020-01-01', is_active: true, still_active: true,
  }));
  assert.strictEqual(badge(html), daysBetween('2020-01-01', todayStr()));
  assert.ok(/comp-tag live/.test(html), 'labelled live');
});

// ── A stopped ad with NO stop date falls back to today (best available) ──
check('stopped ad without a stop date falls back to today - start', () => {
  const html = CS.cardHtml(ad({
    ad_delivery_start_time: '2020-01-01', ad_delivery_stop_time: null,
    is_active: false, still_active: false,
  }));
  assert.strictEqual(badge(html), daysBetween('2020-01-01', todayStr()));
});

// ── A missing start date yields no badge at all ──
check('no start date -> no days badge', () => {
  const html = CS.cardHtml(ad({ ad_delivery_start_time: null, is_active: true, still_active: true }));
  assert.strictEqual(badge(html), null);
});

console.log(`\nUS-012 OK — ${passed} checks passed`);
