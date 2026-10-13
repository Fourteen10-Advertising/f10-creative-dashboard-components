/**
 * YouTube video tab (f10-youtube.js).
 *
 *   1. CONFIG GATE: no YOUTUBE config (or no TABLE) -> total no-op, zero trace.
 *   2. METRIC MATHS: format parsing (configurable regex), skippable classification by
 *      name (configurable regex), aggregation by ad_id (not ad name), completion rate
 *      (p100 / impressions), CPCV (spend / p100), viewability (viewable / measurable),
 *      CPM, and views + view rate over skippable ads only ('n/a' when none).
 *   3. SQL SHAPE: network filter, date window, grouping, no conversion columns.
 *   4. LIVE PATH: boots the real Meta / TikTok engines + layout dispatcher + the
 *      YouTube module on a functional DOM, clicks the tab, and checks one visible
 *      panel, the rendered KPI values, the empty state and the visible error state.
 *
 * Fixture numbers are the Beyond Bank Brand flight (9-12 Oct 2026) as read from
 * beyond_bank_marts.gads_video_ad_daily.
 *
 * Run: node test/youtube-tab.test.js
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
const LAYOUT = readSrc('f10-layout.js');
const YT = readSrc('f10-youtube.js');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < (eps || 1e-9), (msg || '') + ' expected ' + b + ' got ' + a);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function unitCtx(youtube) {
  const sandbox = {
    window: {}, console: { log() {}, warn() {}, error() {} },
    document: { getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    PROJECT: 'mcc-poc-477801', DATASET: 'beyond_bank_marts',
  };
  if (youtube !== undefined) sandbox.YOUTUBE = youtube;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(YT, sandbox, { filename: 'f10-youtube.js' });
  return sandbox;
}

const BB = { TABLE: 'gads_video_ad_daily' };
const NS = 'BR | Brand Prospecting National | Non-Skippable Campaign Oct-Nov 2026 | GL 5500001';
const SK = 'BR | Brand Prospecting National | Skippable Campaign Oct-Nov 2026 | GL 5500001';

/* One row per ad (whole flight) - totals match BigQuery for 2026-10-09..2026-10-12. */
function bbRows() {
  return [
    { date: '2026-10-12', ad_id: '827507013551', ad_name: 'BR | Brand Prospecting National | Bumpers 6"', campaign_name: NS, spend: 1083.12, impressions: 102106, video_views: 0, video_p25: 100000, video_p50: 97000, video_p75: 95000, video_p100: 92697.4, viewable_impressions: 92764, measurable_impressions: 101890, engagements: 0 },
    { date: '2026-10-12', ad_id: '827382592458', ad_name: 'BR | Brand Prospecting National | Non-Skippable 15"', campaign_name: NS, spend: 2272.57, impressions: 148819, video_views: 0, video_p25: 145000, video_p50: 138000, video_p75: 131000, video_p100: 124156.0, viewable_impressions: 131539, measurable_impressions: 148460, engagements: 0 },
    { date: '2026-10-12', ad_id: '827382609774', ad_name: 'BR | Brand Prospecting National | Non-Skippable CTV 30"', campaign_name: NS, spend: 684.32, impressions: 21561, video_views: 0, video_p25: 21000, video_p50: 19500, video_p75: 18200, video_p100: 17011.2, viewable_impressions: 18737, measurable_impressions: 21509, engagements: 0 },
    { date: '2026-10-12', ad_id: '827425924519', ad_name: 'BR | Brand National Prospecting | Skippable 15"', campaign_name: SK, spend: 1386.93, impressions: 130804, video_views: 35338, video_p25: 80000, video_p50: 60000, video_p75: 48000, video_p100: 39369.5, viewable_impressions: 79467, measurable_impressions: 127582, engagements: 40559 },
  ];
}

(async () => {
  console.log('YouTube tab - unit');

  await check('no YOUTUBE config: total no-op', async () => {
    const ctx = unitCtx();
    assert.strictEqual(typeof ctx.window.initYouTube, 'undefined');
    assert.strictEqual(typeof ctx.window.f10YouTubeInternals, 'undefined');
    const ctx2 = unitCtx({ DATASET: 'x' }); // no TABLE
    assert.strictEqual(typeof ctx2.window.initYouTube, 'undefined');
  });

  const I = unitCtx(BB).window.f10YouTubeInternals;

  await check('format parsing: default regex reads the trailing duration, else Other', async () => {
    assert.strictEqual(I.parseFormat('BR | Brand Prospecting National | Bumpers 6"'), '6"');
    assert.strictEqual(I.parseFormat('BR | Brand National Prospecting | Skippable 15"'), '15"');
    assert.strictEqual(I.parseFormat('BR | Brand Prospecting National | Non-Skippable CTV 30"'), '30"');
    assert.strictEqual(I.parseFormat('Spot 20 "'), '20"');
    assert.strictEqual(I.parseFormat('Community Owned | Prop 1'), 'Other');
    assert.strictEqual(I.parseFormat(''), 'Other');
  });

  await check('format parsing: configurable regex, capture group wins', async () => {
    const C = unitCtx({ TABLE: 't', FORMAT_REGEX: '_(\\d+)s$' }).window.f10YouTubeInternals;
    assert.strictEqual(C.parseFormat('brand_hero_15s'), '15');
    assert.strictEqual(C.parseFormat('Skippable 15"'), 'Other');
  });

  await check('skippable classification by campaign / ad name, not by views', async () => {
    assert.strictEqual(I.isNonSkippable(NS, 'BR | Brand Prospecting National | Non-Skippable 15"'), true);
    assert.strictEqual(I.isNonSkippable(SK, 'BR | Brand Prospecting National | Bumpers 6"'), true, 'bumper is non-skippable');
    assert.strictEqual(I.isNonSkippable(SK, 'BR | Brand National Prospecting | Skippable 15"'), false);
    assert.strictEqual(I.isNonSkippable('Video | Brand 2025/26', 'Community Owned | Prop 1'), false);
    assert.strictEqual(I.isNonSkippable('NON SKIPPABLE x', 'a'), true, 'case-insensitive, space variant');
    const C = unitCtx({ TABLE: 't', NON_SKIPPABLE_REGEX: 'NSK' }).window.f10YouTubeInternals;
    assert.strictEqual(C.isNonSkippable('Brand NSK', 'ad'), true);
    assert.strictEqual(C.isNonSkippable(NS, 'Bumpers 6"'), false, 'custom regex replaces the default');
    // A skippable ad with zero views in the window is still skippable.
    const ads = I.aggregateByAd([{ date: '2026-10-09', ad_id: '1', ad_name: 'Skippable 15"', campaign_name: SK, spend: 10, impressions: 100, video_views: 0, video_p100: 10 }]);
    assert.strictEqual(ads[0].skippable, true);
    assert.strictEqual(I.computeKpis(ads).views, 0, 'views 0, not n/a');
  });

  await check('aggregation is by ad_id (latest name wins), sorted by spend', async () => {
    const rows = [
      { date: '2026-10-09', ad_id: '1', ad_name: 'Old name 15"', campaign_name: SK, spend: 10, impressions: 100, video_p100: 20, video_views: 5 },
      { date: '2026-10-10', ad_id: '1', ad_name: 'New name 15"', campaign_name: SK, spend: 15, impressions: 200, video_p100: 30, video_views: 7 },
      { date: '2026-10-10', ad_id: '2', ad_name: 'New name 15"', campaign_name: SK, spend: 40, impressions: 50, video_p100: 5, video_views: 1 },
      { date: '2026-10-11', ad_id: '3', ad_name: 'Bumpers 6"', campaign_name: NS, spend: { value: '1.5' }, impressions: '10', video_p100: null },
    ];
    const ads = I.aggregateByAd(rows);
    assert.strictEqual(ads.length, 3, 'two ads sharing a name stay separate');
    same(ads.map((a) => a.ad_id), ['2', '1', '3'], 'spend desc');
    const a1 = ads.find((a) => a.ad_id === '1');
    assert.strictEqual(a1.ad_name, 'New name 15"');
    assert.strictEqual(a1.spend, 25); assert.strictEqual(a1.impressions, 300); assert.strictEqual(a1.video_p100, 50); assert.strictEqual(a1.video_views, 12);
    const a3 = ads.find((a) => a.ad_id === '3');
    assert.strictEqual(a3.spend, 1.5, 'BigQuery {value} numerics coerced'); assert.strictEqual(a3.video_p100, 0, 'null treated as 0');
    assert.strictEqual(a3.format, '6"'); assert.strictEqual(a3.skippable, false);
  });

  await check('KPI maths on the Beyond Bank flight', async () => {
    const ads = I.aggregateByAd(bbRows());
    const k = I.computeKpis(ads);
    const spend = 1083.12 + 2272.57 + 684.32 + 1386.93;
    const impr = 102106 + 148819 + 21561 + 130804;
    const p100 = 92697.4 + 124156.0 + 17011.2 + 39369.5;
    close(k.spend, spend, 1e-6, 'spend');
    assert.strictEqual(k.impressions, impr);
    close(k.cpm, spend / impr * 1000, 1e-9, 'cpm');
    close(k.completion, p100 / impr, 1e-12, 'completion = p100 / impressions');
    close(k.cpcv, spend / p100, 1e-12, 'cpcv = spend / p100');
    close(k.viewability, (92764 + 131539 + 18737 + 79467) / (101890 + 148460 + 21509 + 127582), 1e-12, 'viewability');
    assert.strictEqual(k.engagements, 40559);
    assert.strictEqual(k.skippableAds, 1);
    assert.strictEqual(k.views, 35338, 'views from the skippable ad only');
    close(k.viewRate, 35338 / 130804, 1e-12, 'view rate over skippable impressions only');
    // Spot-check the rendered rounding the tab shows.
    assert.strictEqual((k.completion * 100).toFixed(1), '67.8');
    assert.strictEqual((k.cpcv).toFixed(4), '0.0199');
  });

  await check('views / view rate are n/a (null) when no skippable ads', async () => {
    const ads = I.aggregateByAd(bbRows().filter((r) => r.campaign_name === NS));
    const k = I.computeKpis(ads);
    assert.strictEqual(k.views, null); assert.strictEqual(k.viewRate, null);
    const r = I.adRates(ads[0]);
    assert.strictEqual(r.views, null); assert.strictEqual(r.viewRate, null);
  });

  await check('zero denominators give null, never NaN or Infinity', async () => {
    const k = I.computeKpis(I.aggregateByAd([{ date: '2026-10-09', ad_id: '9', ad_name: 'x', campaign_name: 'y', spend: 5 }]));
    ['cpm', 'viewability', 'completion', 'cpcv', 'viewRate'].forEach((key) => assert.strictEqual(k[key], null, key));
  });

  await check('per-ad drop-off is each quartile count over impressions', async () => {
    const ad = I.aggregateByAd(bbRows()).find((a) => a.ad_id === '827425924519');
    const d = I.adRates(ad).dropoff;
    close(d[0], 80000 / 130804); close(d[3], 39369.5 / 130804);
  });

  await check('daily series sums by date with completion rate', async () => {
    const s = I.dailySeries([
      { date: '2026-10-10', ad_id: '1', spend: 2, impressions: 10, video_p100: 5 },
      { date: '2026-10-09', ad_id: '1', spend: 1, impressions: 10, video_p100: 1 },
      { date: '2026-10-10', ad_id: '2', spend: 3, impressions: 10, video_p100: 5 },
    ]);
    same(s.map((x) => x.date), ['2026-10-09', '2026-10-10']);
    assert.strictEqual(s[1].spend, 5); close(s[1].completion, 0.5);
  });

  await check('filters: campaign, ad type, format', async () => {
    const rows = bbRows();
    assert.strictEqual(I.filterRows(rows, { campaign: SK }).length, 1);
    assert.strictEqual(I.filterRows(rows, { adType: 'skippable' }).length, 1);
    assert.strictEqual(I.filterRows(rows, { adType: 'nonskippable' }).length, 3);
    assert.strictEqual(I.filterRows(rows, { format: '15"' }).length, 2);
    assert.strictEqual(I.filterRows(rows, { campaign: I.ALL, adType: I.ALL, format: I.ALL }).length, 4);
  });

  await check('SQL: table, network filter, date window, grouping, no conversion columns', async () => {
    const sql = I.rowsSQL('2026-10-09', '2026-10-12');
    assert.ok(sql.indexOf('`mcc-poc-477801.beyond_bank_marts.gads_video_ad_daily`') !== -1);
    assert.ok(/ad_network_type = 'YOUTUBE'/.test(sql));
    assert.ok(/date_start BETWEEN DATE '2026-10-09' AND DATE '2026-10-12'/.test(sql));
    assert.ok(/GROUP BY date, ad_id/.test(sql));
    assert.ok(!/conversion/i.test(sql), 'no conversion columns');
    assert.throws(() => I.rowsSQL("2026-10-09' OR 1=1 --", '2026-10-12'), /Invalid date range/);
    assert.ok(/MAX\(date_start\)/.test(I.boundsSQL()) && /ad_network_type = 'YOUTUBE'/.test(I.boundsSQL()));
    const C = unitCtx({ TABLE: 'v`x', DATASET: 'other_marts', NETWORK: "YOU'TUBE" }).window.f10YouTubeInternals;
    assert.strictEqual(C.tableRef(), '`mcc-poc-477801.other_marts.vx`', 'identifiers sanitised');
    assert.ok(/ad_network_type = 'YOU\\'TUBE'/.test(C.boundsSQL()), 'network literal escaped');
  });

  await check('panel markup carries .tab-panel and the notes box', async () => {
    const m = I.panelMarkup();
    assert.ok(/class="tab-panel yt-tab-panel" id="panel-yt"/.test(m));
    assert.ok(/always report 0 views/.test(m) && /Google estimates/.test(m) && /no CPA/.test(m));
  });

  console.log('YouTube tab - live path');

  async function bootLive(fetchImpl) {
    const dom = makeLiveDom();
    const document = dom.document;
    const sidebar = document.createElement('div'); sidebar.id = 'sidebar';
    const nav = document.createElement('nav'); sidebar.appendChild(nav);
    const content = document.createElement('div'); content.id = 'content';
    const title = document.createElement('h1'); title.id = 'page-title'; content.appendChild(title);
    ['controls-bar', 'tt-controls-bar'].forEach((id) => { const d = document.createElement('div'); d.id = id; content.appendChild(d); });
    const addLink = (cls, key, val) => { const a = document.createElement('a'); a.className = cls; a.dataset[key] = val; nav.appendChild(a); return a; };
    const addPanel = (id, cls) => { const p = document.createElement('div'); p.className = cls; p.id = id; content.appendChild(p); return p; };
    ['summary', 'production'].forEach((t, i) => { const l = addLink('nav-link', 'tab', t); const p = addPanel('tab-' + t, 'tab-panel'); if (!i) { l.classList.add('active'); p.classList.add('active'); } });
    addLink('tt-nav-link', 'ttTab', 'tt-summary'); addPanel('panel-tt-summary', 'tab-panel tt-tab-panel');
    const queries = [];
    const window = { F10A: { track() {} } };
    const charts = [];
    const sandbox = {
      window, document, console: { log() {}, warn() {}, error() {} }, F10A: window.F10A,
      PROJECT: 'mcc-poc-477801', DATASET: 'beyond_bank_marts', TABLE: 'creative_reporting', CONV_EXPR: 'x',
      TIKTOK: { TABLE: 't' }, YOUTUBE: BB, BQ_FUNCTION: '/.netlify/functions/bq',
      fetch: async (u, o) => { const q = JSON.parse(o.body).query; queries.push(q); return fetchImpl(q); },
      setTimeout, clearTimeout, getComputedStyle: () => ({ getPropertyValue: () => '' }),
      Chart: function (el, cfg) { charts.push(cfg); return { destroy() {} }; },
    };
    vm.createContext(sandbox);
    vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
    vm.runInContext(WEEKLY, sandbox, { filename: 'f10-weekly.js' });
    vm.runInContext(TIKTOK, sandbox, { filename: 'f10-tiktok.js' });
    vm.runInContext(YT, sandbox, { filename: 'f10-youtube.js' });
    vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
    sandbox.loadMonthlyTab = function () {};
    sandbox.wireControls();
    sandbox.f10WireNavDispatcher();
    await sandbox.window.initTikTok();
    sandbox.window.initYouTube();
    return { document, sandbox, queries, charts };
  }
  const ok = (p) => ({ ok: true, status: 200, json: async () => p, text: async () => JSON.stringify(p) });
  const dataFetch = (q) => /MAX\(date_start\)/.test(q) ? ok([{ min_date: '2026-01-27', max_date: '2026-10-12' }]) : ok(bbRows());
  const activePanels = (d) => d.querySelectorAll('.tab-panel').filter((p) => p.classList.contains('active'));
  const activeLinks = (d) => d.querySelectorAll('#sidebar nav a').filter((a) => a.classList.contains('active'));

  await check('layout dispatches initYouTube from the renderLayout tail', async () => {
    assert.ok(/if \(typeof initYouTube === 'function'\) initYouTube\(\);/.test(LAYOUT));
  });

  const live = await bootLive(dataFetch);
  const d = live.document;

  await check('registration: one YouTube nav link + panel, no query until opened', async () => {
    assert.strictEqual(d.querySelectorAll('.yt-nav-link').length, 1);
    assert.ok(d.getElementById('panel-yt').classList.contains('tab-panel'));
    assert.strictEqual(live.queries.filter((q) => /gads_video_ad_daily/.test(q)).length, 0, 'lazy');
  });

  await check('opening the tab shows exactly one panel and renders real KPI values', async () => {
    d.querySelectorAll('.yt-nav-link')[0].click();
    await flush();
    const ap = activePanels(d);
    assert.strictEqual(ap.length, 1); assert.strictEqual(ap[0].id, 'panel-yt');
    assert.strictEqual(activeLinks(d).length, 1);
    const q = live.queries.find((x) => /gads_video_ad_daily/.test(x) && /BETWEEN/.test(x)) || '';
    assert.ok(/BETWEEN DATE '2026-09-13' AND DATE '2026-10-12'/.test(q), 'default 30-day window ending at max date: ' + q);
    assert.strictEqual(d.getElementById('yt-body').style.display, '');
    const kpis = d.getElementById('yt-kpis').innerHTML;
    assert.ok(kpis.indexOf('$5,427') !== -1, 'spend ' + kpis);
    assert.ok(kpis.indexOf('403,290') !== -1, 'impressions');
    assert.ok(kpis.indexOf('$13.46') !== -1, 'cpm');
    assert.ok(kpis.indexOf('67.8%') !== -1, 'completion');
    assert.ok(kpis.indexOf('$0.02') !== -1, 'cpcv');
    assert.ok(kpis.indexOf('80.7%') !== -1, 'viewability');
    assert.ok(kpis.indexOf('35,338') !== -1 && kpis.indexOf('27.0%') !== -1, 'views + view rate (skippable)');
    const body = d.getElementById('yt-table-body').innerHTML;
    assert.strictEqual((body.match(/<tr>/g) || []).length, 4, 'one row per ad_id');
    assert.strictEqual((body.match(/>n\/a</g) || []).length, 6, 'views + view rate n/a for the 3 non-skippable ads');
    assert.ok(live.charts.length >= 2, 'daily + drop-off charts drawn');
    const daily = live.charts.find((c) => c.data && c.data.datasets && c.data.datasets.some((s) => s.label === 'Completion rate'));
    same(daily.data.datasets.map((s) => s.type), ['bar', 'line']);
  });

  await check('switching to Meta and TikTok leaves exactly one panel', async () => {
    d.querySelectorAll('.nav-link')[0].click();
    same(activePanels(d).map((p) => p.id), ['tab-summary']);
    assert.strictEqual(activeLinks(d).length, 1);
    d.querySelectorAll('.tt-nav-link')[0].click();
    same(activePanels(d).map((p) => p.id), ['panel-tt-summary']);
    assert.strictEqual(activeLinks(d).length, 1);
    d.querySelectorAll('.yt-nav-link')[0].click();
    same(activePanels(d).map((p) => p.id), ['panel-yt']);
    assert.strictEqual(d.getElementById('controls-bar').style.display, 'none', 'Meta controls hidden on YouTube');
  });

  await check('empty state when the window has no rows', async () => {
    const e = await bootLive((q) => /MAX\(date_start\)/.test(q) ? ok([{ min_date: '2026-10-09', max_date: '2026-10-12' }]) : ok([]));
    e.document.querySelectorAll('.yt-nav-link')[0].click(); await flush();
    assert.strictEqual(e.document.getElementById('yt-empty').style.display, '');
    assert.ok(/No YouTube data/.test(e.document.getElementById('yt-empty').innerHTML));
    assert.strictEqual(e.document.getElementById('yt-body').style.display, 'none');
  });

  await check('a query failure renders a visible panel error with the message', async () => {
    const e = await bootLive(() => ({ ok: false, status: 500, json: async () => ({}), text: async () => '{"error":"Unrecognized name: video_p100"}' }));
    e.document.querySelectorAll('.yt-nav-link')[0].click(); await flush();
    const el = e.document.getElementById('yt-error');
    assert.strictEqual(el.style.display, '');
    assert.ok(/Unrecognized name: video_p100/.test(el.innerHTML));
    assert.strictEqual(e.document.getElementById('yt-loading').style.display, 'none');
  });

  console.log('\nYouTube tab OK - ' + passed + ' checks passed.');
})().catch((e) => { console.error('\nYouTube tab FAILED:', (e && e.stack) || e); process.exit(1); });
