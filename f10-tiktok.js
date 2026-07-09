/**
 * f10-tiktok.js — F10 Creative Dashboard TikTok section (config-gated)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@TAG/f10-tiktok.js"></script>
 *
 * Must be loaded AFTER f10-utils.js, f10-weekly.js, f10-monthly.js and f10-layout.js.
 *
 * This module is a NO-OP unless the dashboard defines a TIKTOK config object
 * BEFORE the scripts load, so every existing Meta-only dashboard is unaffected:
 *
 *   const TIKTOK = {
 *     DATASET:   'fastcover_marts',        // optional; defaults to the Meta DATASET
 *     TABLE:     'tiktok_creative_reporting',
 *     CONV_EXPR: 'conversions',            // optional; defaults to 'conversions'
 *     THRESHOLDS:{ HR_SPEND: 4000, HR_CPA: 90, ... }, // optional Ad Production bands
 *   };
 *
 * It renders its own "TikTok" nav section + panels (built by f10-layout.js) and
 * queries the TikTok mart with the TikTok metric profile, which adds the real
 * 2s hook (thumbstop) and 6s hold rates Meta cannot provide. It reuses the pure
 * helpers in f10-utils.js (classify, metricValue, creativeRates, renderPagedTable,
 * formatters, retentionSparkline) and keeps entirely separate state + DOM ids
 * (tt-*) so it never collides with the Meta engine.
 *
 * Entrypoint — f10-layout.js calls initTikTok() during boot when TIKTOK exists.
 */
(function () {
  if (typeof TIKTOK === 'undefined' || !TIKTOK || !TIKTOK.TABLE) return; // no config → no TikTok section

  const PROFILE   = PLATFORM_PROFILES.tiktok;
  const ttDataset = () => (TIKTOK.DATASET || (typeof DATASET !== 'undefined' ? DATASET : ''));
  const ttTable   = () => `\`${PROJECT}.${ttDataset()}.${TIKTOK.TABLE}\``;
  const ttConv    = () => (TIKTOK.CONV_EXPR || 'conversions');
  const TT_TH = Object.assign(
    { HR_SPEND: 5000, HR_CPA: 70, OB_SPEND: 1000, OB_CPA: 100, SO_SPEND: 500, SO_CPA: 140 },
    TIKTOK.THRESHOLDS || {}
  );

  const TT_TABS = ['tt-summary', 'tt-board', 'tt-production', 'tt-creative'];
  const ttTitles = {
    'tt-summary':    'TikTok · Weekly Summary',
    'tt-board':      'TikTok · Movement Board',
    'tt-production': 'TikTok · Ad Production',
    'tt-creative':   'TikTok · Creative Effectiveness',
  };
  const ttIsWeekly = (t) => t === 'tt-summary' || t === 'tt-board';

  let TT_WIN = null, TT_MAXDATE = null, ttCharts = {}, ttActive = null, ttLoaded = {};

  /* ── Data fetching ── */

  async function ttFetchMaxDate() {
    const rows = await runQuery(`SELECT FORMAT_DATE('%Y-%m-%d', MAX(date_start)) AS max_date FROM ${ttTable()}`);
    return rows && rows[0] ? bqStr(rows[0].max_date) : null;
  }

  function ttControls() {
    const length = parseInt((document.getElementById('tt-ctrl-length') || {}).value || '7', 10);
    const end = (document.getElementById('tt-ctrl-enddate') || {}).value || TT_MAXDATE;
    const metricKey = (document.getElementById('tt-ctrl-metric') || {}).value || 'CPA';
    const minSpend = Number((document.getElementById('tt-ctrl-minspend') || {}).value) || 0;
    return { length, end, metricKey, metric: METRICS[metricKey], floorMode: 'fixed', fixedSpend: minSpend };
  }

  async function ttFetchWindows(c) {
    const curStart = isoOffset(c.end, -(c.length - 1)), curEnd = c.end;
    const priEnd = isoOffset(curStart, -1), priStart = isoOffset(priEnd, -(c.length - 1));
    const inCur = `date_start BETWEEN '${curStart}' AND '${curEnd}'`;
    const inPri = `date_start BETWEEN '${priStart}' AND '${priEnd}'`;
    const sql = `
      SELECT ad_id,
        ANY_VALUE(ad_name)       AS ad_name,
        ANY_VALUE(campaign_name) AS campaign_name,
        ANY_VALUE(adgroup_name)  AS adgroup_name,
        ANY_VALUE(creative_link) AS creative_link,
        SUM(IF(${inCur}, spend, 0))              AS cur_spend,
        SUM(IF(${inCur}, impressions, 0))        AS cur_impressions,
        SUM(IF(${inCur}, clicks, 0))             AS cur_clicks,
        SUM(IF(${inCur}, ${ttConv()}, 0))        AS cur_conv,
        SUM(IF(${inCur}, video_watched_2s, 0))   AS cur_hook,
        SUM(IF(${inCur}, video_watched_6s, 0))   AS cur_hold,
        SUM(IF(${inCur}, video_views_p100, 0))   AS cur_p100,
        SUM(IF(${inCur}, video_play_actions, 0)) AS cur_plays,
        SUM(IF(${inPri}, spend, 0))              AS pri_spend,
        SUM(IF(${inPri}, impressions, 0))        AS pri_impressions,
        SUM(IF(${inPri}, clicks, 0))             AS pri_clicks,
        SUM(IF(${inPri}, ${ttConv()}, 0))        AS pri_conv
      FROM ${ttTable()}
      WHERE date_start BETWEEN '${priStart}' AND '${curEnd}'
      GROUP BY ad_id
      HAVING cur_spend > 0 OR pri_spend > 0`;
    const rows = await runQuery(sql);
    const ads = {};
    rows.forEach((r) => {
      const cs = Number(r.cur_spend) || 0, ps = Number(r.pri_spend) || 0;
      ads[r.ad_id] = {
        ad_id: r.ad_id, ad_name: r.ad_name, campaign_name: r.campaign_name,
        adset_name: r.adgroup_name, creative_link: r.creative_link,
        cur: {
          spend: cs, impressions: Number(r.cur_impressions) || 0, clicks: Number(r.cur_clicks) || 0,
          conv: Number(r.cur_conv) || 0, conv_cost_num: cs,
          video_watched_2s: Number(r.cur_hook) || 0, video_watched_6s: Number(r.cur_hold) || 0,
          video_views_p100: Number(r.cur_p100) || 0, video_play_actions: Number(r.cur_plays) || 0,
        },
        pri: { spend: ps, impressions: Number(r.pri_impressions) || 0, clicks: Number(r.pri_clicks) || 0, conv: Number(r.pri_conv) || 0, conv_cost_num: ps },
      };
    });
    return { ads, curStart, curEnd, priStart, priEnd };
  }

  /* ── Load + render orchestration (weekly) ── */

  async function ttLoadWindows() {
    try {
      showEl('tt-summary-loading'); hideEl('tt-summary-body');
      showEl('tt-board-loading');   hideEl('tt-board-table');
      TT_WIN = await ttFetchWindows(ttControls());
      ttRenderWeekly();
    } catch (err) {
      console.error('TikTok weekly error:', err);
      const el = document.getElementById('tt-summary-loading'); if (el) el.innerHTML = 'Error loading data: ' + err.message;
    }
  }

  function ttRenderWeekly() {
    if (!TT_WIN) return;
    const c = ttControls();
    const classified = Object.values(TT_WIN.ads).map((a) => classify(a, c));
    const movers = classified.filter((a) => a.qCur || a.qPri);
    const windowTxt = `Current: ${fmtDate(TT_WIN.curStart)} – ${fmtDate(TT_WIN.curEnd)} vs Prior: ${fmtDate(TT_WIN.priStart)} – ${fmtDate(TT_WIN.priEnd)} · Metric: ${c.metric.label} · ${movers.length} ads cleared the floor`;
    ['tt-summary-window-note', 'tt-board-window-note'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = windowTxt; });
    ttRenderSummary(classified, c);
    ttRenderBoard(movers, c);
    const lu = document.getElementById('last-updated'); if (lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
  }

  function ttRenderSummary(all, c) {
    const m = c.metric;
    const tot = { cur: emptyAgg(), pri: emptyAgg() };
    let curImpr = 0, curHook = 0, curHold = 0, priImpr = 0, priHook = 0, priHold = 0;
    all.forEach((a) => {
      ['spend', 'impressions', 'clicks', 'conv', 'conv_cost_num'].forEach((k) => { tot.cur[k] += a.cur[k]; tot.pri[k] += a.pri[k]; });
      curImpr += a.cur.impressions; curHook += a.cur.video_watched_2s || 0; curHold += a.cur.video_watched_6s || 0;
    });
    const mCur = metricValue(tot.cur, m), mPri = metricValue(tot.pri, m);
    const hookCur = curImpr > 0 ? (curHook / curImpr) * 100 : null;
    const holdCur = curImpr > 0 ? (curHold / curImpr) * 100 : null;

    function deltaHtml(cur, pri, lowerBetter) {
      if (pri === 0 || pri == null) return `<div class="scorecard-delta delta-flat">no prior</div>`;
      const chg = (cur - pri) / pri * 100; const good = lowerBetter ? chg < 0 : chg > 0;
      const cls = Math.abs(chg) < 0.5 ? 'delta-flat' : (good ? 'delta-good' : 'delta-bad');
      const arrow = chg > 0 ? '▲' : (chg < 0 ? '▼' : '■');
      return `<div class="scorecard-delta ${cls}">${arrow} ${Math.abs(chg).toFixed(1)}% vs prior</div>`;
    }

    const cards = [
      { label: 'Spend',            val: fmt$(tot.cur.spend),         d: deltaHtml(tot.cur.spend, tot.pri.spend, false) },
      { label: 'Conversions',      val: fmtNum(tot.cur.conv),        d: deltaHtml(tot.cur.conv, tot.pri.conv, false) },
      { label: 'Impressions',      val: fmtNum(tot.cur.impressions), d: deltaHtml(tot.cur.impressions, tot.pri.impressions, false) },
      { label: 'Blended ' + m.label, val: fmtMetric(mCur, m),        d: deltaHtml(mCur, mPri, m.dir === 'lower') },
      { label: 'Hook rate (2s)',   val: hookCur != null ? fmtPct(hookCur, 2) : '–', d: `<div class="scorecard-delta delta-flat">thumbstop</div>` },
      { label: 'Hold rate (6s)',   val: holdCur != null ? fmtPct(holdCur, 2) : '–', d: `<div class="scorecard-delta delta-flat">attention</div>` },
    ];
    document.getElementById('tt-summary-scorecards').innerHTML = cards.map((c2) =>
      `<div class="scorecard"><div class="scorecard-label">${c2.label}</div><div class="scorecard-value">${c2.val}</div>${c2.d}</div>`
    ).join('');
    hideEl('tt-summary-loading'); showEl('tt-summary-body');
  }

  function ttRenderBoard(movers, c) {
    const m = c.metric;
    const head = document.getElementById('tt-board-m-head'); if (head) head.textContent = m.label;
    const order = ['Scaling Winner', 'Fading', 'New Entrant', 'Efficient but Shrinking', 'Dropped Off', 'Steady'];
    const legend = document.getElementById('tt-board-legend');
    if (legend) legend.innerHTML = order.map((s) => `<span class="li"><span class="dot" style="background:${STATE_META[s].color}"></span>${s}</span>`).join('');
    const rows = movers.slice().sort((a, b) => b.sCur - a.sCur);
    const body = document.getElementById('tt-board-body');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="11" class="no-data">No ads cleared the spend floor in this window. Lower the floor or widen the window.</td></tr>`;
    } else {
      renderPagedTable('tt-board-body', rows.map((a) => {
        const sm = STATE_META[a.state], sd = a.spendDelta;
        const sdCls = Math.abs(sd) < 1 ? 'delta-flat' : (sd > 0 ? 'delta-good' : 'delta-bad');
        let mdHtml = '–';
        if (a.metricDelta != null) { const worse = m.dir === 'lower' ? a.metricDelta > 0 : a.metricDelta < 0; const cls = Math.abs(a.metricDelta) < 1e-6 ? 'delta-flat' : (worse ? 'delta-bad' : 'delta-good'); mdHtml = `<span class="${cls}">${a.metricDelta > 0 ? '+' : ''}${fmtMetric(a.metricDelta, m)}</span>`; }
        const cr = creativeRates(a.cur, PROFILE); registerAdMetrics(a.ad_id, a.cur, PROFILE);
        return `<tr>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;" title="${a.ad_name || ''}">${a.ad_name || '–'}<br><span style="color:var(--grey);font-size:10px;">${a.campaign_name || ''}</span></td>
          <td><span class="badge ${sm.cls}">${a.state}</span></td>
          <td class="num">${fmt$(a.sCur)}</td>
          <td class="num delta-cell ${sdCls}">${sd > 0 ? '+' : ''}${fmt$(sd)}</td>
          <td class="num">${fmtMetric(a.mCur, m)}</td>
          <td class="num delta-cell">${mdHtml}</td>
          <td class="num">${fmtNum(a.cur.conv)}</td>
          <td class="num">${fmtNum(a.cur.impressions)}</td>
          <td class="num">${cr.hook != null ? fmtPct(cr.hook, 2) : '–'}</td>
          <td class="num">${cr.hold != null ? fmtPct(cr.hold, 2) : '–'}</td>
          <td>${a.creative_link ? `<a class="preview-link" data-ad-id="${a.ad_id}" data-platform="tiktok" href="${a.creative_link}" target="_blank">View</a>` : '–'}</td>
        </tr>`;
      }));
    }
    const title = document.getElementById('tt-board-title'); if (title) title.textContent = `Ad Movement — ${rows.length} ads`;
    hideEl('tt-board-loading'); showEl('tt-board-table');
  }

  /* ── Ad Production (lifetime spend vs CPA classification) ── */

  async function ttLoadProduction() {
    const clsCase = `CASE
      WHEN lifetime_spend >= ${TT_TH.HR_SPEND} AND lifetime_cpa > 0 AND lifetime_cpa < ${TT_TH.HR_CPA} THEN 'Home Run'
      WHEN lifetime_spend >= ${TT_TH.OB_SPEND} AND lifetime_cpa > 0 AND lifetime_cpa < ${TT_TH.OB_CPA} THEN 'On Base'
      WHEN lifetime_spend >= ${TT_TH.SO_SPEND} AND lifetime_cpa > ${TT_TH.SO_CPA} THEN 'Strike Out' ELSE 'Unclassified' END`;
    const scatterSQL = `
      WITH per_ad AS (
        SELECT ad_id, ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adgroup_name) AS adgroup_name,
          MIN(min_date) AS launch_date, ANY_VALUE(creative_link) AS creative_link,
          ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
          ROUND(SUM(${ttConv()}), 0) AS total_conversions,
          ROUND(SAFE_DIVIDE(ANY_VALUE(lifetime_spend), NULLIF(SUM(${ttConv()}), 0)), 2) AS lifetime_cpa,
          SUM(impressions) AS impressions, SUM(clicks) AS clicks,
          SUM(video_watched_2s) AS video_watched_2s, SUM(video_watched_6s) AS video_watched_6s,
          SUM(video_views_p100) AS video_views_p100, SUM(video_play_actions) AS video_play_actions
        FROM ${ttTable()} GROUP BY 1
      )
      SELECT *, ${clsCase} AS classification FROM per_ad ORDER BY lifetime_spend DESC`;
    const monthlySQL = `
      WITH unique_ads AS (
        SELECT ad_id, MIN(min_date) AS launch_date, ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
          ROUND(SAFE_DIVIDE(ANY_VALUE(lifetime_spend), NULLIF(SUM(${ttConv()}), 0)), 2) AS lifetime_cpa,
          ROUND(SUM(spend), 2) AS period_spend, ROUND(SUM(${ttConv()}), 0) AS total_conversions
        FROM ${ttTable()} GROUP BY 1 ),
      classified AS ( SELECT *, ${clsCase} AS classification FROM unique_ads )
      SELECT FORMAT_DATE('%b %Y', launch_date) AS launch_month, DATE_TRUNC(launch_date, MONTH) AS launch_month_sort,
        COUNT(*) AS ads_launched, COUNTIF(classification='Home Run') AS home_runs, COUNTIF(classification='On Base') AS on_base, COUNTIF(classification='Strike Out') AS strike_outs,
        ROUND(SUM(period_spend), 0) AS total_spend, ROUND(SAFE_DIVIDE(SUM(period_spend), NULLIF(SUM(total_conversions), 0)), 0) AS avg_cpa, ROUND(SUM(total_conversions), 0) AS total_conversions
      FROM classified GROUP BY 1, 2 ORDER BY 2 DESC`;
    try {
      const [scatterData, monthlyData] = await Promise.all([runQuery(scatterSQL), runQuery(monthlySQL)]);
      const totals = scatterData.reduce((acc, r) => { acc.total++; if (r.classification === 'Home Run') acc.hr++; if (r.classification === 'On Base') acc.ob++; if (r.classification === 'Strike Out') acc.so++; return acc; }, { total: 0, hr: 0, ob: 0, so: 0 });
      const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      setTxt('tt-sc-ads-produced', fmtNum(totals.total));
      setTxt('tt-sc-home-runs', fmtNum(totals.hr));
      setTxt('tt-sc-hr-rate', totals.total ? fmtPct(totals.hr / totals.total * 100) : '–');
      setTxt('tt-sc-on-base', fmtNum(totals.ob));
      setTxt('tt-sc-ob-rate', totals.total ? fmtPct(totals.ob / totals.total * 100) : '–');
      setTxt('tt-sc-strike-outs', fmtNum(totals.so));
      setTxt('tt-sc-so-rate', totals.total ? fmtPct(totals.so / totals.total * 100) : '–');
      hideEl('tt-production-scorecards-loading'); showEl('tt-production-scorecards');

      const byClass = { 'Home Run': [], 'On Base': [], 'Strike Out': [], 'Unclassified': [] };
      scatterData.forEach((r) => { const cpa = Number(r.lifetime_cpa) || 0, spend = Number(r.lifetime_spend) || 0; if (cpa > 0 || spend > 0) byClass[r.classification].push({ x: spend, y: cpa, label: r.ad_name }); });
      const scatterDatasets = Object.entries(byClass).map(([cls, pts]) => ({ label: cls, data: pts, backgroundColor: CLASS_COLOR[cls] + 'bb', borderColor: CLASS_COLOR[cls], borderWidth: 1.5, pointRadius: 6, pointHoverRadius: 8 }));
      hideEl('tt-scatter-loading'); showEl('tt-scatter-wrapper');
      if (ttCharts.scatter) ttCharts.scatter.destroy();
      const topSpend = Math.max(0, ...scatterData.map((r) => Number(r.lifetime_spend) || 0));
      const maxSpend = topSpend > TT_TH.HR_SPEND ? topSpend + 1000 : TT_TH.HR_SPEND * 1.2;
      const maxCpa = Math.ceil(Math.max(...scatterData.filter((r) => Number(r.lifetime_cpa) > 0).map((r) => Number(r.lifetime_cpa) || 0), 100) * 1.2);
      ttCharts.scatter = new Chart(document.getElementById('tt-scatter-chart'), {
        type: 'scatter', data: { datasets: scatterDatasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { x: { title: { display: true, text: 'Lifetime Spend ($)', font: { size: 11 } }, min: 0, max: maxSpend, ticks: { callback: (v) => fmt$(v) } }, y: { title: { display: true, text: 'Lifetime CPA ($)', font: { size: 11 } }, min: 0, max: maxCpa, ticks: { callback: (v) => fmt$(v) } } },
          plugins: { legend: { position: 'top', labels: { font: { size: 11 } } }, tooltip: { callbacks: { label: (ctx) => { const pt = ctx.raw; return [`${ctx.dataset.label}`, `Spend: ${fmt$(pt.x)}`, `CPA: ${pt.y > 0 ? fmt$(pt.y) : 'N/A'}`]; } } } },
        },
      });

      const months = monthlyData.map((r) => r.launch_month).reverse();
      const adsArr = monthlyData.map((r) => Number(r.ads_launched)).reverse();
      const hrRates = monthlyData.map((r) => +(Number(r.home_runs) / Number(r.ads_launched) * 100).toFixed(1)).reverse();
      const obRates = monthlyData.map((r) => +(Number(r.on_base) / Number(r.ads_launched) * 100).toFixed(1)).reverse();
      const soRates = monthlyData.map((r) => +(Number(r.strike_outs) / Number(r.ads_launched) * 100).toFixed(1)).reverse();
      hideEl('tt-production-chart-loading'); showEl('tt-production-chart-wrapper');
      if (ttCharts.production) ttCharts.production.destroy();
      ttCharts.production = new Chart(document.getElementById('tt-production-chart'), {
        type: 'bar', data: { labels: months, datasets: [
          { type: 'bar', label: 'Ads Launched', data: adsArr, backgroundColor: '#e6e6e6', borderColor: '#b0b0b0', borderWidth: 1, yAxisID: 'y', order: 1 },
          { type: 'line', label: 'Home Run Rate', data: hrRates, borderColor: '#c8ff00', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 4, yAxisID: 'y2', tension: 0.3, order: 0 },
          { type: 'line', label: 'On Base Rate', data: obRates, borderColor: '#4a90e2', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 4, yAxisID: 'y2', tension: 0.3, order: 0 },
          { type: 'line', label: 'Strike Out Rate', data: soRates, borderColor: '#fa023c', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 4, yAxisID: 'y2', tension: 0.3, borderDash: [4, 3], order: 0 } ] },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { font: { size: 10 } } }, y: { title: { display: true, text: 'Ads Launched', font: { size: 10 } }, ticks: { font: { size: 10 } } }, y2: { position: 'right', title: { display: true, text: 'Rate (%)', font: { size: 10 } }, ticks: { callback: (v) => v + '%', font: { size: 10 } }, grid: { drawOnChartArea: false } } }, plugins: { legend: { position: 'top', labels: { font: { size: 11 } } } } },
      });

      renderPagedTable('tt-scatter-table-body', scatterData.map((r) => {
        const cls = r.classification; const badgeClass = cls === 'Home Run' ? 'badge-hr' : cls === 'On Base' ? 'badge-ob' : cls === 'Strike Out' ? 'badge-so' : 'badge-un';
        const ce = { impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, video_watched_2s: Number(r.video_watched_2s) || 0, video_watched_6s: Number(r.video_watched_6s) || 0, video_views_p100: Number(r.video_views_p100) || 0, video_play_actions: Number(r.video_play_actions) || 0 };
        registerAdMetrics(r.ad_id, ce, PROFILE); const cr = creativeRates(ce, PROFILE);
        return `<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adgroup_name}">${r.adgroup_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmt$(r.lifetime_spend)}</td><td>${r.lifetime_cpa && Number(r.lifetime_cpa) > 0 ? fmt$(r.lifetime_cpa) : '–'}</td><td>${fmtNum(r.total_conversions)}</td><td class="num">${cr.hook != null ? fmtPct(cr.hook, 2) : '–'}</td><td class="num">${cr.hold != null ? fmtPct(cr.hold, 2) : '–'}</td><td class="num">${cr.completion != null ? fmtPct(cr.completion, 2) : '–'}</td><td>${r.creative_link ? `<a class="preview-link" data-ad-id="${r.ad_id}" data-platform="tiktok" href="${r.creative_link}" target="_blank">Preview</a>` : '–'}</td><td><span class="badge ${badgeClass}">${cls}</span></td></tr>`;
      }));
      hideEl('tt-scatter-table-loading'); showEl('tt-scatter-table');
    } catch (err) { console.error('TikTok production error:', err); }
  }

  /* ── Creative Effectiveness (the star: hook/hold/completion/retention) ── */

  async function ttLoadCreative() {
    const sql = `
      SELECT * FROM (
        SELECT ad_id, ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(creative_link) AS creative_link,
          ROUND(SUM(spend), 2) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
          SUM(video_play_actions) AS video_play_actions, SUM(video_watched_2s) AS video_watched_2s, SUM(video_watched_6s) AS video_watched_6s,
          SUM(video_views_p25) AS video_views_p25, SUM(video_views_p50) AS video_views_p50, SUM(video_views_p75) AS video_views_p75, SUM(video_views_p100) AS video_views_p100
        FROM ${ttTable()}
        WHERE date_start >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
        GROUP BY 1
      ) WHERE impressions > 0 ORDER BY spend DESC`;
    try {
      const data = await runQuery(sql);
      let tImpr = 0, t2 = 0, t6 = 0, t25 = 0, t50 = 0, t75 = 0, t100 = 0;
      const rows = data.map((r) => {
        const ce = { impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, video_play_actions: Number(r.video_play_actions) || 0, video_watched_2s: Number(r.video_watched_2s) || 0, video_watched_6s: Number(r.video_watched_6s) || 0, video_views_p25: Number(r.video_views_p25) || 0, video_views_p50: Number(r.video_views_p50) || 0, video_views_p75: Number(r.video_views_p75) || 0, video_views_p100: Number(r.video_views_p100) || 0 };
        registerAdMetrics(r.ad_id, ce, PROFILE);
        const cr = creativeRates(ce, PROFILE);
        tImpr += ce.impressions; t2 += ce.video_watched_2s; t6 += ce.video_watched_6s; t25 += ce.video_views_p25; t50 += ce.video_views_p50; t75 += ce.video_views_p75; t100 += ce.video_views_p100;
        const pct = (v) => v != null ? fmtPct(v, 2) : '–';
        const pv = r.creative_link ? `<a class="preview-link" data-ad-id="${r.ad_id}" data-platform="tiktok" href="${r.creative_link}" target="_blank">Preview</a>` : '–';
        return `<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name || ''}">${r.ad_name || '–'}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name || ''}">${r.campaign_name || '–'}</td><td class="num">${fmt$(r.spend)}</td><td class="num">${fmtNum(ce.impressions)}</td><td class="num">${pct(cr.hook)}</td><td class="num">${pct(cr.hold)}</td><td class="num">${pct(cr.completion)}</td><td class="num">${pct(cr.retention.p25)}</td><td class="num">${pct(cr.retention.p50)}</td><td class="num">${pct(cr.retention.p75)}</td><td class="num">${pct(cr.retention.p100)}</td><td class="num">${pct(cr.ctr)}</td><td>${pv}</td></tr>`;
      });
      renderPagedTable('tt-creative-table-body', rows);
      hideEl('tt-creative-table-loading'); showEl('tt-creative-table');
      const hookAvg = tImpr > 0 ? +(t2 / tImpr * 100).toFixed(2) : 0;
      const holdAvg = tImpr > 0 ? +(t6 / tImpr * 100).toFixed(2) : 0;
      const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      setTxt('tt-creative-hook', fmtPct(hookAvg, 2));
      setTxt('tt-creative-hold', fmtPct(holdAvg, 2));
      const curve = [t25, t50, t75, t100].map((v) => tImpr > 0 ? +(v / tImpr * 100).toFixed(2) : 0);
      hideEl('tt-creative-chart-loading'); showEl('tt-creative-chart-wrapper');
      if (ttCharts.creative) ttCharts.creative.destroy();
      ttCharts.creative = new Chart(document.getElementById('tt-creative-chart'), {
        type: 'line',
        data: { labels: ['25%', '50%', '75%', '100%'], datasets: [{ label: '% of impressions reaching', data: curve, borderColor: '#c8ff00', backgroundColor: 'rgba(200,255,0,0.13)', borderWidth: 2.5, pointRadius: 4, fill: true, tension: 0.25 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.label} watched: ${ctx.raw}% of impressions` } } }, scales: { x: { title: { display: true, text: 'Video quartile watched', font: { size: 11 } } }, y: { title: { display: true, text: '% of impressions', font: { size: 11 } }, ticks: { callback: (v) => v + '%' } } } },
      });
    } catch (err) { console.error('TikTok creative error:', err); const el = document.getElementById('tt-creative-table-loading'); if (el) el.innerHTML = 'Error loading data: ' + err.message; }
  }

  function ttLoadTab(tab) {
    ttLoaded[tab] = true;
    if (tab === 'tt-production') ttLoadProduction();
    if (tab === 'tt-creative') ttLoadCreative();
    /* tt-summary / tt-board load together via ttLoadWindows on boot + control changes */
  }

  /* ── Tab system (coordinates with the Meta engine's tabs) ── */

  function ttSelectTab(tab) {
    /* Deactivate Meta: hide its panels + nav highlight, hide its controls bar. */
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    const mc = document.getElementById('controls-bar'); if (mc) mc.style.display = 'none';
    /* Activate TikTok. */
    document.querySelectorAll('.tt-tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.tt-nav-link').forEach((l) => l.classList.toggle('active', l.dataset.ttTab === tab));
    const panel = document.getElementById('panel-' + tab); if (panel) panel.classList.add('active');
    const title = document.getElementById('page-title'); if (title) title.textContent = ttTitles[tab];
    ttActive = tab;
    const bar = document.getElementById('tt-controls-bar'); if (bar) bar.style.display = ttIsWeekly(tab) ? 'flex' : 'none';
    if (window.F10A) F10A.track('tab_viewed', { tab: tab, tab_label: ttTitles[tab] });
    if (!ttIsWeekly(tab) && !ttLoaded[tab]) ttLoadTab(tab);
  }

  /* When any Meta nav link is clicked, drop the TikTok active state so only one
   * section shows at a time. The Meta engine handles activating its own panel. */
  function ttDeactivateOnMetaNav() {
    document.querySelectorAll('.tt-tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.tt-nav-link').forEach((l) => l.classList.remove('active'));
    const bar = document.getElementById('tt-controls-bar'); if (bar) bar.style.display = 'none';
    ttActive = null;
  }

  function ttWireControls() {
    document.querySelectorAll('.tt-nav-link').forEach((link) =>
      link.addEventListener('click', (e) => { e.preventDefault(); ttSelectTab(link.dataset.ttTab); })
    );
    document.querySelectorAll('.nav-link').forEach((link) =>
      link.addEventListener('click', ttDeactivateOnMetaNav)
    );
    ['tt-ctrl-length', 'tt-ctrl-enddate'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', ttLoadWindows); });
    ['tt-ctrl-metric', 'tt-ctrl-minspend'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', ttRenderWeekly); });
  }

  /* ── Boot ── */

  async function initTikTok() {
    ttWireControls();
    try {
      TT_MAXDATE = await ttFetchMaxDate();
      const ed = document.getElementById('tt-ctrl-enddate');
      if (ed && TT_MAXDATE) { ed.value = TT_MAXDATE; ed.max = TT_MAXDATE; }
      await ttLoadWindows(); /* pre-load weekly so first click is instant */
      ttLoaded['tt-summary'] = true; ttLoaded['tt-board'] = true;
    } catch (err) { console.error('TikTok boot error:', err); }
  }

  window.initTikTok = initTikTok;
})();
