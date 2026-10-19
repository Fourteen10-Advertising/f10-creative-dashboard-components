/**
 * f10-youtube.js - F10 Creative Dashboard YouTube video tab (config-gated)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@TAG/f10-youtube.js"></script>
 *
 * Load AFTER f10-utils.js (it reuses runQuery, fmt$, fmtDate, isoOffset and the chart
 * palette) and BEFORE f10-layout.js, so the one-line initYouTube() call at the tail of
 * renderLayout() can register the tab.
 *
 * CONFIG GATE: the module is a total no-op unless the dashboard defines a YOUTUBE
 * object with a TABLE. No YOUTUBE config -> no initYouTube, no nav entry, no panel, no
 * query, so every other client dashboard that loads the script is unaffected.
 *
 *   const YOUTUBE = {
 *     DATASET:             'acme_marts',          // optional; defaults to DATASET
 *     TABLE:               'gads_video_ad_daily', // required
 *     NETWORK:             'YOUTUBE',             // optional ad_network_type filter (default 'YOUTUBE')
 *     FORMAT_REGEX:        '\\d+\\s*"\\s*$',      // optional; matched against ad_name. The first
 *                                                 // capture group (or the whole match) is the
 *                                                 // format label; no match -> 'Other'
 *     NON_SKIPPABLE_REGEX: 'non[- ]?skippable|bumper', // optional; case-insensitive, tested
 *                                                 // against campaign_name + ad_name. A match marks
 *                                                 // the ad non-skippable (Google never counts views)
 *     DEFAULT_DAYS:        30,                    // optional; default window ends at the latest date
 *   };
 *
 * DATA: reads one row per ad per day from a Google Ads video mart (f10-dataform
 * gads_video_ad_daily). Quartile columns (video_p25..video_p100) are Google's
 * estimated completed-play COUNTS, so a rate is the count divided by impressions.
 * The tab carries no CPA or conversion metric: YouTube brand buying is delivery only.
 *
 * TAB ACTIVATION goes through f10RegisterModuleTab / f10ActivateTab (f10-layout.js),
 * so this module never names another tab's classes. Filters live inside the panel,
 * so they hide with it. Every query goes through runQuery (f10-utils.js) and the
 * shared bq function guardrails. Errors render in the panel; they are never swallowed.
 */
(function () {
  'use strict';

  var CFG = (typeof YOUTUBE !== 'undefined' && YOUTUBE && YOUTUBE.TABLE) ? YOUTUBE : null;
  if (!CFG) return; // config gate: zero trace for every dashboard without a YOUTUBE block

  var DEFAULT_FORMAT_REGEX = '\\d+\\s*"\\s*$';
  var DEFAULT_NON_SKIPPABLE_REGEX = 'non[- ]?skippable|bumper';
  var ALL = '__all__';

  /* ---------------------------------------------------------------- config */

  function ident(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_\-]/g, ''); }
  function sqlStr(v) { return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

  function tableRef() {
    var project = ident(typeof PROJECT !== 'undefined' ? PROJECT : '');
    var dataset = ident(CFG.DATASET || (typeof DATASET !== 'undefined' ? DATASET : ''));
    return '`' + project + '.' + dataset + '.' + ident(CFG.TABLE) + '`';
  }
  function network() { return CFG.NETWORK === undefined ? 'YOUTUBE' : CFG.NETWORK; }
  function networkWhere() { var n = network(); return n ? 'ad_network_type = ' + sqlStr(n) : 'TRUE'; }
  function defaultDays() { var d = Number(CFG.DEFAULT_DAYS); return d > 0 ? Math.floor(d) : 30; }

  /* Compiled lazily so an invalid regex in config surfaces as a visible panel error. */
  function formatRegex() { return new RegExp(CFG.FORMAT_REGEX || DEFAULT_FORMAT_REGEX, 'i'); }
  function nonSkippableRegex() { return new RegExp(CFG.NON_SKIPPABLE_REGEX || DEFAULT_NON_SKIPPABLE_REGEX, 'i'); }

  /* ---------------------------------------------------------------- pure maths */

  function num(v) {
    if (v == null) return 0;
    if (typeof v === 'object' && v.value !== undefined) v = v.value;
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function str(v) {
    if (v == null) return '';
    if (typeof v === 'object' && v.value !== undefined) return String(v.value);
    return String(v);
  }
  /* Ratio, or null when the denominator is zero (rendered as a dash, never 0 or NaN). */
  function ratio(n, d) { return d > 0 ? n / d : null; }

  /* Format label parsed from the ad name, e.g. 'Skippable 15"' -> '15"'. */
  function parseFormat(adName, re) {
    re = re || formatRegex();
    var m = re.exec(String(adName || ''));
    if (!m) return 'Other';
    var label = (m[1] !== undefined ? m[1] : m[0]).replace(/\s+/g, '').trim();
    return label || 'Other';
  }

  /* Non-skippable ads (in-stream non-skip, bumpers) never record a Google view, so they
   * are excluded from the views / view-rate maths by NAME, not by whether views > 0. */
  function isNonSkippable(campaignName, adName, re) {
    re = re || nonSkippableRegex();
    return re.test(String(campaignName || '') + ' | ' + String(adName || ''));
  }

  var SUM_KEYS = ['spend', 'impressions', 'video_views', 'video_p25', 'video_p50', 'video_p75',
    'video_p100', 'viewable_impressions', 'measurable_impressions', 'engagements'];

  function emptyTotals() { var t = {}; SUM_KEYS.forEach(function (k) { t[k] = 0; }); return t; }
  function addInto(t, r) { SUM_KEYS.forEach(function (k) { t[k] += num(r[k]); }); }

  /* One entry per ad_id (never per ad name: two ads can share a name). The displayed
   * name / campaign come from the ad's most recent day in the window. */
  function aggregateByAd(rows, fmtRe, skipRe) {
    fmtRe = fmtRe || formatRegex(); skipRe = skipRe || nonSkippableRegex();
    var byId = {}, order = [];
    (rows || []).forEach(function (r) {
      var id = str(r.ad_id);
      var a = byId[id];
      if (!a) { a = byId[id] = emptyTotals(); a.ad_id = id; a._last = ''; order.push(id); }
      addInto(a, r);
      var d = str(r.date);
      if (d >= a._last) { a._last = d; a.ad_name = str(r.ad_name); a.campaign_name = str(r.campaign_name); }
    });
    return order.map(function (id) {
      var a = byId[id];
      a.format = parseFormat(a.ad_name, fmtRe);
      a.skippable = !isNonSkippable(a.campaign_name, a.ad_name, skipRe);
      delete a._last;
      return a;
    }).sort(function (x, y) { return y.spend - x.spend; });
  }

  /* Headline KPIs over a set of aggregated ads. Views and view rate cover skippable
   * ads only and are null (shown 'n/a') when the set has no skippable ad. */
  function computeKpis(ads) {
    var t = emptyTotals(), sk = { views: 0, impressions: 0, count: 0 };
    (ads || []).forEach(function (a) {
      addInto(t, a);
      if (a.skippable) { sk.count++; sk.views += a.video_views; sk.impressions += a.impressions; }
    });
    return {
      spend: t.spend,
      impressions: t.impressions,
      cpm: t.impressions > 0 ? t.spend / t.impressions * 1000 : null,
      viewability: ratio(t.viewable_impressions, t.measurable_impressions),
      completion: ratio(t.video_p100, t.impressions),
      cpcv: ratio(t.spend, t.video_p100),
      engagements: t.engagements,
      views: sk.count ? sk.views : null,
      viewRate: sk.count ? ratio(sk.views, sk.impressions) : null,
      skippableAds: sk.count,
      totals: t,
    };
  }

  /* Per-ad derived rates for the table and the drop-off chart. */
  function adRates(a) {
    return {
      cpm: a.impressions > 0 ? a.spend / a.impressions * 1000 : null,
      viewability: ratio(a.viewable_impressions, a.measurable_impressions),
      completion: ratio(a.video_p100, a.impressions),
      cpcv: ratio(a.spend, a.video_p100),
      views: a.skippable ? a.video_views : null,
      viewRate: a.skippable ? ratio(a.video_views, a.impressions) : null,
      dropoff: [a.video_p25, a.video_p50, a.video_p75, a.video_p100].map(function (q) { return ratio(q, a.impressions); }),
    };
  }

  /* Daily series: spend and completion rate per date across the filtered ads. */
  function dailySeries(rows) {
    var byDate = {};
    (rows || []).forEach(function (r) {
      var d = str(r.date);
      var t = byDate[d] || (byDate[d] = emptyTotals());
      addInto(t, r);
    });
    return Object.keys(byDate).sort().map(function (d) {
      var t = byDate[d];
      return { date: d, spend: t.spend, completion: ratio(t.video_p100, t.impressions) };
    });
  }

  /* Apply the in-panel campaign / ad type / format filters to the raw daily rows. */
  function filterRows(rows, f, fmtRe, skipRe) {
    fmtRe = fmtRe || formatRegex(); skipRe = skipRe || nonSkippableRegex();
    f = f || {};
    return (rows || []).filter(function (r) {
      if (f.campaign && f.campaign !== ALL && str(r.campaign_name) !== f.campaign) return false;
      if (f.adType && f.adType !== ALL) {
        var skippable = !isNonSkippable(r.campaign_name, r.ad_name, skipRe);
        if ((f.adType === 'skippable') !== skippable) return false;
      }
      if (f.format && f.format !== ALL && parseFormat(r.ad_name, fmtRe) !== f.format) return false;
      return true;
    });
  }

  /* ---------------------------------------------------------------- SQL */

  function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

  function boundsSQL() {
    return 'SELECT CAST(MIN(date_start) AS STRING) AS min_date, CAST(MAX(date_start) AS STRING) AS max_date\n'
      + 'FROM ' + tableRef() + '\nWHERE ' + networkWhere();
  }

  function rowsSQL(start, end) {
    if (!isIsoDate(start) || !isIsoDate(end)) throw new Error('Invalid date range: ' + start + ' to ' + end);
    return 'SELECT CAST(date_start AS STRING) AS date, CAST(ad_id AS STRING) AS ad_id,\n'
      + '  ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name,\n'
      + '  SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(video_views) AS video_views,\n'
      + '  SUM(video_p25) AS video_p25, SUM(video_p50) AS video_p50, SUM(video_p75) AS video_p75, SUM(video_p100) AS video_p100,\n'
      + '  SUM(viewable_impressions) AS viewable_impressions, SUM(measurable_impressions) AS measurable_impressions,\n'
      + '  SUM(engagements) AS engagements\n'
      + 'FROM ' + tableRef() + '\n'
      + 'WHERE ' + networkWhere() + " AND date_start BETWEEN DATE '" + start + "' AND DATE '" + end + "'\n"
      + 'GROUP BY date, ad_id\nORDER BY date, ad_id';
  }

  /* ---------------------------------------------------------------- formatting */

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(n) { return (typeof fmt$ === 'function') ? fmt$(n) : '$' + Math.round(n).toLocaleString('en-AU'); }
  /* Unit costs (CPM, CPCV) always show cents (fmt$ drops them at $10+), and a third
   * decimal below $1 so a typical CPCV of ~2c is not flattened to "$0.02" for every ad. */
  function money2(n) {
    if (n == null || !isFinite(n)) return '–';
    var dp = Math.abs(n) < 1 ? 3 : 2;
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function count(n) { return (n == null) ? 'n/a' : Number(n).toLocaleString('en-AU', { maximumFractionDigits: 0 }); }
  function pct(r) { return (r == null || !isFinite(r)) ? '–' : (r * 100).toFixed(1) + '%'; }
  function dateLabel(s) { return (typeof fmtDate === 'function') ? fmtDate(s) : s; }

  /* ---------------------------------------------------------------- state + DOM */

  var state = { loaded: false, bounds: null, start: null, end: null, rows: [], filters: { campaign: ALL, adType: ALL, format: ALL } };
  var charts = { daily: null, dropoff: null };
  var navLink = null;

  function $(id) { return document.getElementById(id); }
  function show(id, on) { var el = $(id); if (el) el.style.display = on ? '' : 'none'; }

  function selectHtml(id, label, opts) {
    return '<div class="ctrl"><label for="' + id + '">' + label + '</label><select id="' + id + '">'
      + opts.map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; }).join('')
      + '</select></div>';
  }

  function panelMarkup() {
    return '<div class="tab-panel yt-tab-panel" id="panel-yt">'
      + '<div class="insight-box"><strong>YouTube video:</strong> delivery and attention for the YouTube ads in the '
      + 'selected window. Judge non-skippable ads on completion rate and viewability; views only exist for skippable ads. '
      + 'These are brand campaigns, so the tab shows no CPA or conversion figures.</div>'
      + '<div class="controls-bar" id="yt-controls" style="position:static;margin:0 0 18px;padding:14px 0;border:0;background:transparent;">'
      + '<div class="ctrl"><label for="yt-start">From</label><input type="date" id="yt-start" /></div>'
      + '<div class="ctrl"><label for="yt-end">To</label><input type="date" id="yt-end" /></div>'
      + selectHtml('yt-campaign', 'Campaign', [{ value: ALL, label: 'All campaigns' }])
      + selectHtml('yt-adtype', 'Ad type', [{ value: ALL, label: 'All ad types' }, { value: 'skippable', label: 'Skippable' }, { value: 'nonskippable', label: 'Non-skippable' }])
      + selectHtml('yt-format', 'Format', [{ value: ALL, label: 'All formats' }])
      + '</div>'
      + '<div class="window-note" id="yt-window-note"></div>'
      + '<div id="yt-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>'
      + '<div id="yt-error" class="insight-box" style="display:none;border-color:var(--stabilo-red);"></div>'
      + '<div id="yt-empty" class="insight-box" style="display:none;"></div>'
      + '<div id="yt-body" style="display:none;">'
      + '<div class="scorecard-grid" id="yt-kpis"></div>'
      + '<div class="chart-card"><h3>Daily Spend &amp; Completion Rate</h3><div class="chart-wrapper" style="height:300px;"><canvas id="yt-daily-chart"></canvas></div></div>'
      + '<div class="table-card"><h3>Ads &mdash; Sorted by Spend</h3><div class="table-scroll"><table id="yt-table">'
      + '<thead><tr><th>Ad</th><th>Campaign</th><th>Format</th><th>Type</th><th class="num">Spend</th><th class="num">Impr.</th>'
      + '<th class="num">CPM</th><th class="num">Viewability</th><th class="num">Completion</th><th class="num">CPCV</th>'
      + '<th class="num">Views</th><th class="num">View rate</th></tr></thead><tbody id="yt-table-body"></tbody></table></div></div>'
      + '<div class="chart-card"><h3>Drop-off &mdash; % of Impressions Reaching Each Quartile</h3><div class="chart-wrapper" style="height:320px;"><canvas id="yt-dropoff-chart"></canvas></div></div>'
      + '</div>'
      + '<div class="insight-box" id="yt-notes"><strong>Reading these numbers:</strong><ul style="margin:6px 0 0 18px;">'
      + '<li>Non-skippable ads (non-skip in-stream and bumpers) always report 0 views, because Google only counts a view on skippable ads. Their views and view rate show n/a; judge them on completion rate and viewability.</li>'
      + '<li>Quartile figures (25/50/75/100%) are Google estimates: Google&rsquo;s completion rate multiplied by impressions, not counted plays.</li>'
      + '<li>Brand campaigns carry no product conversions, so there is no CPA here.</li>'
      + '<li>Completion rate = 100% plays &divide; impressions. Viewability = viewable &divide; measurable impressions. CPCV = spend &divide; 100% plays. View rate = views &divide; impressions, skippable ads only.</li>'
      + '</ul></div>'
      + '</div>';
  }

  function setOptions(id, first, values, current) {
    var sel = $(id); if (!sel) return current;
    var keep = values.indexOf(current) !== -1 ? current : ALL;
    sel.innerHTML = '<option value="' + ALL + '">' + esc(first) + '</option>'
      + values.map(function (v) { return '<option value="' + esc(v) + '"' + (v === keep ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
    sel.value = keep;
    return keep;
  }

  function renderError(err) {
    var msg = (err && err.message) ? err.message : String(err);
    console.error('YouTube tab error:', err);
    if (window.F10A) F10A.track('data_error', { view: 'youtube', message: msg });
    show('yt-loading', false); show('yt-body', false); show('yt-empty', false);
    var el = $('yt-error');
    if (el) { el.innerHTML = '<strong>Error loading YouTube data:</strong> ' + esc(msg); el.style.display = ''; }
  }

  function renderEmpty(text) {
    show('yt-loading', false); show('yt-body', false); show('yt-error', false);
    var el = $('yt-empty');
    if (el) { el.innerHTML = '<strong>No YouTube data.</strong> ' + esc(text); el.style.display = ''; }
  }

  function kpiCard(label, value, highlight) {
    return '<div class="scorecard' + (highlight ? ' highlight' : '') + '"><div class="scorecard-label">' + label
      + '</div><div class="scorecard-value">' + value + '</div></div>';
  }

  function kpiHtml(k) {
    return kpiCard('Spend', money(k.spend), true)
      + kpiCard('Impressions', count(k.impressions))
      + kpiCard('CPM', money2(k.cpm))
      + kpiCard('Viewability', pct(k.viewability))
      + kpiCard('Completion rate', pct(k.completion), true)
      + kpiCard('Cost per completed view', money2(k.cpcv))
      + kpiCard('Engagements', count(k.engagements))
      + kpiCard('Views (skippable)', k.views == null ? 'n/a' : count(k.views))
      + kpiCard('View rate (skippable)', k.viewRate == null ? 'n/a' : pct(k.viewRate));
  }

  function rowHtml(a) {
    var r = adRates(a);
    return '<tr><td title="' + esc(a.ad_name) + '">' + esc(a.ad_name) + '<div style="font-size:10px;color:var(--grey);">ID ' + esc(a.ad_id) + '</div></td>'
      + '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;" title="' + esc(a.campaign_name) + '">' + esc(a.campaign_name) + '</td>'
      + '<td>' + esc(a.format) + '</td><td>' + (a.skippable ? 'Skippable' : 'Non-skippable') + '</td>'
      + '<td class="num">' + money(a.spend) + '</td><td class="num">' + count(a.impressions) + '</td>'
      + '<td class="num">' + money2(r.cpm) + '</td><td class="num">' + pct(r.viewability) + '</td>'
      + '<td class="num">' + pct(r.completion) + '</td><td class="num">' + money2(r.cpcv) + '</td>'
      + '<td class="num">' + (a.skippable ? count(r.views) : 'n/a') + '</td><td class="num">' + (a.skippable ? pct(r.viewRate) : 'n/a') + '</td></tr>';
  }

  function chartsAvailable() { return typeof Chart === 'function'; }
  function cssVar(v, fb) { try { var x = (typeof getCSS === 'function') ? getCSS(v) : ''; return x || fb; } catch (e) { return fb; } }

  function drawDaily(series) {
    if (!chartsAvailable()) return;
    if (charts.daily) charts.daily.destroy();
    var brand = cssVar('--young-blood', '#5a0f1e');
    var line = (typeof CHART_PRIMARY !== 'undefined') ? CHART_PRIMARY : '#c8ff00';
    charts.daily = new Chart($('yt-daily-chart'), {
      type: 'bar',
      data: { labels: series.map(function (d) { return dateLabel(d.date); }), datasets: [
        { type: 'bar', label: 'Spend', data: series.map(function (d) { return Math.round(d.spend * 100) / 100; }), backgroundColor: brand + '99', borderColor: brand, borderWidth: 1, yAxisID: 'y' },
        { type: 'line', label: 'Completion rate', data: series.map(function (d) { return d.completion == null ? null : Math.round(d.completion * 1000) / 10; }), borderColor: line, backgroundColor: 'transparent', borderWidth: 2.5, pointRadius: 3, tension: 0.2, yAxisID: 'y2' },
      ] },
      options: { responsive: true, maintainAspectRatio: false,
        scales: { y: { title: { display: true, text: 'Spend ($)', font: { size: 10 } }, ticks: { callback: function (v) { return '$' + Number(v).toLocaleString('en-AU'); } } },
          y2: { position: 'right', min: 0, max: 100, title: { display: true, text: 'Completion rate', font: { size: 10 } }, ticks: { callback: function (v) { return v + '%'; } }, grid: { drawOnChartArea: false } } },
        plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } } },
    });
  }

  function drawDropoff(ads) {
    if (!chartsAvailable()) return;
    if (charts.dropoff) charts.dropoff.destroy();
    var palette = (typeof COHORT_COLORS !== 'undefined' && COHORT_COLORS && COHORT_COLORS.length) ? COHORT_COLORS : ['#5a0f1e', '#4a90e2', '#c8ff00', '#fa023c', '#b0b0b0'];
    charts.dropoff = new Chart($('yt-dropoff-chart'), {
      type: 'line',
      data: { labels: ['25%', '50%', '75%', '100%'], datasets: ads.filter(function (a) { return a.impressions > 0; }).map(function (a, i) {
        var c = palette[i % palette.length];
        return { label: a.ad_name + ' (' + a.format + ')', data: adRates(a).dropoff.map(function (r) { return r == null ? null : Math.round(r * 1000) / 10; }),
          borderColor: c, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, tension: 0.15 };
      }) },
      options: { responsive: true, maintainAspectRatio: false,
        scales: { y: { min: 0, max: 100, title: { display: true, text: '% of impressions', font: { size: 10 } }, ticks: { callback: function (v) { return v + '%'; } } },
          x: { title: { display: true, text: 'Quartile reached', font: { size: 10 } } } },
        plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } } },
    });
  }

  /* Re-render from the loaded rows using the current in-panel filters (no re-query). */
  function render() {
    var fmtRe = formatRegex(), skipRe = nonSkippableRegex();
    var all = state.rows;
    var campaigns = [], formats = [];
    all.forEach(function (r) {
      var c = str(r.campaign_name); if (campaigns.indexOf(c) === -1) campaigns.push(c);
      var f = parseFormat(r.ad_name, fmtRe); if (formats.indexOf(f) === -1) formats.push(f);
    });
    campaigns.sort();
    formats.sort(function (a, b) { var x = parseFloat(a), y = parseFloat(b); x = isNaN(x) ? 1e9 : x; y = isNaN(y) ? 1e9 : y; return (x - y) || a.localeCompare(b); });
    state.filters.campaign = setOptions('yt-campaign', 'All campaigns', campaigns, state.filters.campaign);
    state.filters.format = setOptions('yt-format', 'All formats', formats, state.filters.format);

    var note = $('yt-window-note');
    if (note) note.textContent = 'Showing ' + dateLabel(state.start) + ' to ' + dateLabel(state.end)
      + (state.bounds ? '. YouTube data available ' + dateLabel(state.bounds.min) + ' to ' + dateLabel(state.bounds.max) + '.' : '.');

    if (!all.length) { renderEmpty('There are no YouTube rows between ' + dateLabel(state.start) + ' and ' + dateLabel(state.end) + '.'); return; }
    var rows = filterRows(all, state.filters, fmtRe, skipRe);
    if (!rows.length) { renderEmpty('No ads match the selected campaign, ad type and format filters.'); return; }

    var ads = aggregateByAd(rows, fmtRe, skipRe);
    var k = computeKpis(ads);
    show('yt-loading', false); show('yt-error', false); show('yt-empty', false); show('yt-body', true);
    $('yt-kpis').innerHTML = kpiHtml(k);
    $('yt-table-body').innerHTML = ads.map(rowHtml).join('');
    drawDaily(dailySeries(rows));
    drawDropoff(ads);
  }

  async function loadRange() {
    show('yt-loading', true); show('yt-body', false); show('yt-error', false); show('yt-empty', false);
    try {
      var data = await runQuery(rowsSQL(state.start, state.end));
      state.rows = Array.isArray(data) ? data : [];
      render();
    } catch (err) { renderError(err); }
  }

  async function load() {
    try {
      formatRegex(); nonSkippableRegex(); // surface a bad config regex as a visible error
      var b = await runQuery(boundsSQL());
      var row = (Array.isArray(b) && b[0]) || {};
      var min = str(row.min_date), max = str(row.max_date);
      if (!isIsoDate(max)) { renderEmpty('The YouTube table has no rows for ad network ' + (network() || '(any)') + ' yet.'); return; }
      state.bounds = { min: min, max: max };
      var start = (typeof isoOffset === 'function') ? isoOffset(max, -(defaultDays() - 1)) : min;
      if (isIsoDate(min) && start < min) start = min;
      state.start = start; state.end = max;
      var s = $('yt-start'), e = $('yt-end');
      if (s) { s.value = state.start; s.min = min; s.max = max; }
      if (e) { e.value = state.end; e.min = min; e.max = max; }
      await loadRange();
    } catch (err) { renderError(err); }
  }

  function onDateChange() {
    var s = $('yt-start') ? $('yt-start').value : state.start;
    var e = $('yt-end') ? $('yt-end').value : state.end;
    if (!isIsoDate(s) || !isIsoDate(e)) return;
    if (s > e) { var t = s; s = e; e = t; }
    state.start = s; state.end = e;
    if (window.F10A) F10A.track('control_changed', { control: 'yt-dates', value: s + '..' + e });
    loadRange();
  }

  function wireControls() {
    ['yt-start', 'yt-end'].forEach(function (id) { var el = $(id); if (el && el.addEventListener) el.addEventListener('change', onDateChange); });
    [['yt-campaign', 'campaign'], ['yt-adtype', 'adType'], ['yt-format', 'format']].forEach(function (p) {
      var el = $(p[0]);
      if (el && el.addEventListener) el.addEventListener('change', function () {
        state.filters[p[1]] = el.value;
        if (window.F10A) F10A.track('filter_changed', { filter: 'yt-' + p[1], value: el.value });
        try { render(); } catch (err) { renderError(err); }
      });
    });
  }

  function activate() {
    if (window.F10A) F10A.track('tab_viewed', { tab: 'yt', tab_label: 'YouTube Video Performance' });
    if (!state.loaded) { state.loaded = true; return load(); }
  }

  /* Called from the renderLayout tail. Registers the nav entry + panel through the
   * shared f10RegisterModuleTab helper; data loads lazily on first activation. */
  function initYouTube() {
    if (navLink || typeof f10RegisterModuleTab !== 'function') return;
    navLink = f10RegisterModuleTab({
      section: 'YouTube', linkClass: 'yt-nav-link', label: 'Video Performance',
      panelId: 'panel-yt', panelHtml: panelMarkup(), title: 'YouTube Video Performance', onActivate: activate,
    });
    wireControls();
  }

  window.initYouTube = initYouTube;

  /* Test seam: pure maths + SQL builders, read-only. */
  window.f10YouTubeInternals = {
    parseFormat: parseFormat, isNonSkippable: isNonSkippable, aggregateByAd: aggregateByAd,
    computeKpis: computeKpis, adRates: adRates, dailySeries: dailySeries, filterRows: filterRows,
    boundsSQL: boundsSQL, rowsSQL: rowsSQL, tableRef: tableRef, panelMarkup: panelMarkup,
    load: load, render: render, state: state, ALL: ALL,
    DEFAULT_FORMAT_REGEX: DEFAULT_FORMAT_REGEX, DEFAULT_NON_SKIPPABLE_REGEX: DEFAULT_NON_SKIPPABLE_REGEX,
  };
})();
