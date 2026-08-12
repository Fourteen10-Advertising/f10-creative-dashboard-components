/**
 * Creative Score column + badge acceptance test (US-002).
 *
 * Proves, dependency-free, the three things US-002 adds to the per-ad tables:
 *   1. RENDER: creativeScoreBadge() turns an SQL-produced score into a colour
 *      badge whose class comes from the framework palette bands (strong/mid/weak)
 *      and whose visible text is the BARE integer.
 *   2. SORT: because the badge text is a bare number, the universal table sort
 *      (cellSortValue / defaultAscending) reads the cell as numeric and sorts it
 *      high -> low on the first click. A missing score is blank and sinks last.
 *   3. WIRING: both Meta tabs (loadProduction, loadCreativeEffectiveness) and both
 *      TikTok tabs compute creative_score IN THE QUERY via creativeScoreSQL and
 *      render it verbatim via creativeScoreBadge; both f10-layout.js theads and
 *      the TikTok theads carry a Creative Score column; the band styles live in
 *      f10-shared.css. Production and Creative Effectiveness use the IDENTICAL
 *      creativeScoreSQL call, so the same ad+window scores the same on both.
 *
 * The badge/sort logic is exercised against the REAL f10-utils.js loaded into a
 * vm sandbox (no DOM needed -- cellSortValue only reads cell.textContent, which we
 * supply as a plain object). The wiring is asserted against the source text so no
 * BigQuery or browser is required. Run: node test/us-002-score-column.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UTILS = read('f10-utils.js');
const MONTHLY = read('f10-monthly.js');
const TIKTOK = read('f10-tiktok.js');
const LAYOUT = read('f10-layout.js');
const CSS = read('f10-shared.css');

function makeCtx(targetMetric){
  const sandbox = { window: {}, console: console };
  if (targetMetric !== undefined) sandbox.TARGET_METRIC = targetMetric;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  return sandbox;
}
const stripTags = (html) => html.replace(/<[^>]*>/g, '');

let passed = 0;
function check(name, fn){
  try { fn(); console.log('  ok - ' + name); passed++; }
  catch (e){ console.error('  FAIL - ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

console.log('Creative Score column + badge (US-002)');

// -- 1. RENDER: badge class from palette band, bare-number text -----------------
check('creativeScoreBadge renders a palette-band badge with bare-number text', () => {
  const ctx = makeCtx(undefined);
  const cases = [ [82, 'score-strong'], [55, 'score-mid'], [20, 'score-weak'], [70, 'score-strong'], [40, 'score-mid'] ];
  cases.forEach(([score, cls]) => {
    const html = ctx.creativeScoreBadge(score);
    assert.ok(html.indexOf('class="badge ' + cls + '"') !== -1, score + ' should map to ' + cls + ', got: ' + html);
    assert.strictEqual(stripTags(html), String(score), 'badge text must be the bare number ' + score);
    /* band class agrees with the standalone band mapper */
    assert.strictEqual(ctx.creativeScoreBand(score).cls, cls);
  });
});

check('creativeScoreBadge rounds and accepts raw BigQuery value shapes', () => {
  const ctx = makeCtx(undefined);
  assert.strictEqual(stripTags(ctx.creativeScoreBadge(81.6)), '82', 'float should round');
  assert.strictEqual(stripTags(ctx.creativeScoreBadge('73')), '73', 'string number should parse');
  assert.strictEqual(stripTags(ctx.creativeScoreBadge({ value: '64' })), '64', '{value} wrapper should unwrap');
});

check('creativeScoreBadge renders an empty cell for a missing score (sinks in sort)', () => {
  const ctx = makeCtx(undefined);
  [null, undefined, '', NaN, 'n/a'].forEach((v) => {
    assert.strictEqual(ctx.creativeScoreBadge(v), '', JSON.stringify(v) + ' should render empty');
  });
});

check('creativeScoreBadge output carries no em-dash or en-dash (policy)', () => {
  const ctx = makeCtx(undefined);
  [0, 50, 100].forEach((s) => {
    const html = ctx.creativeScoreBadge(s);
    assert.ok(html.indexOf('—') === -1 && html.indexOf('–') === -1, 'no long dashes in badge');
  });
});

// -- 2. SORT: bare-number cell sorts numeric, high -> low on first click ---------
check('score cell sorts as a number, high to low on first click', () => {
  const ctx = makeCtx(undefined);
  const cellFor = (score) => ({ textContent: stripTags(ctx.creativeScoreBadge(score)) });
  const hi = ctx.cellSortValue(cellFor(82));
  const lo = ctx.cellSortValue(cellFor(20));
  assert.ok(hi.isNum && lo.isNum, 'score cells must be recognised as numeric');
  assert.strictEqual(hi.num, 82);
  /* first click on a numeric column defaults to descending (high -> low) */
  assert.strictEqual(ctx.defaultAscending(hi), false, 'numbers must sort high->low first');
  /* descending compare puts the higher score first */
  assert.ok(ctx.compareSortValues(hi, lo, false) < 0, '82 should sort before 20 descending');
});

check('a missing score cell is treated as blank and sinks to the bottom', () => {
  const ctx = makeCtx(undefined);
  const blank = ctx.cellSortValue({ textContent: '' });
  const num = ctx.cellSortValue({ textContent: '30' });
  assert.strictEqual(blank.empty, true, 'empty score cell must be blank');
  /* blanks sort last regardless of direction */
  assert.ok(ctx.compareSortValues(num, blank, false) < 0 && ctx.compareSortValues(num, blank, true) < 0);
});

// -- 3. WIRING: score computed in SQL, rendered verbatim, header + styles present -
check('Meta Production computes creative_score in SQL and renders it verbatim', () => {
  assert.ok(/creativeScoreSQL\('lifetime_spend', lifetimeMetricCol\(\), metaScoreOpts\(\)\)\} AS creative_score/.test(MONTHLY), 'Production must add creative_score via creativeScoreSQL');
  assert.ok(/DATE_DIFF\(COALESCE\(MAX\(max_date\), CURRENT_DATE\(\)\), MIN\(min_date\), DAY\) AS active_days/.test(MONTHLY), 'durability needs an active_days column');
  assert.ok(/creativeScoreBadge\(r\.creative_score\)/.test(MONTHLY), 'render must use the SQL score verbatim, not recompute it');
});

check('Meta Production and Creative Effectiveness use the IDENTICAL score expression', () => {
  const calls = MONTHLY.match(/creativeScoreSQL\('lifetime_spend', lifetimeMetricCol\(\), metaScoreOpts\(\)\)/g) || [];
  assert.strictEqual(calls.length, 2, 'both Meta tabs must call the same creativeScoreSQL so the same ad+window matches, found ' + calls.length);
  const badges = MONTHLY.match(/creativeScoreBadge\(r\.creative_score\)/g) || [];
  assert.strictEqual(badges.length, 2, 'both Meta tabs must render the score badge');
});

check('TikTok Production + Creative Effectiveness compute and render the score', () => {
  assert.ok(/creativeScoreSQL\('lifetime_spend', mCol, ttScoreOpts\(\)\)\} AS creative_score/.test(TIKTOK), 'TikTok Production must add creative_score');
  assert.ok(/creativeScoreSQL\('lifetime_spend', ttLifetimeMetricCol\(\), ttScoreOpts\(\)\)\} AS creative_score/.test(TIKTOK), 'TikTok Creative Effectiveness must add creative_score');
  const badges = TIKTOK.match(/creativeScoreBadge\(r\.creative_score\)/g) || [];
  assert.strictEqual(badges.length, 2, 'both TikTok tabs must render the score badge');
  assert.ok(/AS active_days/.test(TIKTOK), 'TikTok score needs an active_days column');
});

check('all four per-ad theads carry a Creative Score column', () => {
  const headers = LAYOUT.match(/<th>Creative Score<\/th>/g) || [];
  assert.strictEqual(headers.length, 4, 'expected 4 Creative Score headers (Meta+TikTok x Production+CE), found ' + headers.length);
});

check('score band styles live in f10-shared.css and reuse the stabilo vars', () => {
  assert.ok(/\.score-strong\s*\{/.test(CSS) && /\.score-mid\s*\{/.test(CSS) && /\.score-weak\s*\{/.test(CSS), 'all three band classes must be defined');
  assert.ok(/\.score-strong[^}]*var\(--stabilo\)/.test(CSS), 'strong band must reuse --stabilo');
  assert.ok(/\.score-weak[^}]*var\(--stabilo-red\)/.test(CSS), 'weak band must reuse --stabilo-red');
});

console.log('\nCreative Score column: ' + passed + ' checks passed.');
