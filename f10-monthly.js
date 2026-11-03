/**
 * f10-monthly.js — F10 Creative Dashboard monthly engine
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.5.1/f10-monthly.js"></script>
 *
 * Must be loaded AFTER f10-utils.js and f10-weekly.js.
 *
 * Provides the four monthly tab loaders (powerlaw, production, decay, age) and the
 * loadMonthlyTab(tab) dispatcher that f10-weekly.js calls when a monthly tab is
 * first opened. All SQL is shared — only the dashboard config differs:
 *   PROJECT, DATASET, TABLE  — BigQuery target
 *   CONV_EXPR                — conversion expression
 *   GROUP_FILTERS            — optional segment filters (applied via scopeWhere())
 *   HR_SPEND/HR_CPA/...      — production thresholds (from f10-utils.js, overridable)
 *
 * Every query is scoped by the active group selections AND the ad-status filter
 * (All ads / Active only) through scopeWhere() (see f10-utils.js).
 */

let decayChart = null, decayPctChart = null, ageChart = null,
    scatterChart = null, productionChart = null, powerLawChart = null, creativeChart = null;

let productionControlsWired = false;

/* Map of Ad Production threshold input ids → threshold keys, for the ACTIVE
 * target metric. Spend floors are shared; the efficiency-band inputs differ:
 * CPA mode uses the th-*-cpa ids (HR/OB/SO_CPA), ROAS mode uses the th-*-roas ids
 * (HR/OB/SO_ROAS). The layout renders whichever id set matches the active metric
 * (see prodThresholdFieldsHTML), so exactly one set is present in the DOM. */
function productionInputMap(){
  return targetMetric() === 'roas'
    ? { 'th-hr-spend':'HR_SPEND', 'th-hr-roas':'HR_ROAS',
        'th-ob-spend':'OB_SPEND', 'th-ob-roas':'OB_ROAS',
        'th-so-spend':'SO_SPEND', 'th-so-roas':'SO_ROAS' }
    : { 'th-hr-spend':'HR_SPEND', 'th-hr-cpa':'HR_CPA',
        'th-ob-spend':'OB_SPEND', 'th-ob-cpa':'OB_CPA',
        'th-so-spend':'SO_SPEND', 'th-so-cpa':'SO_CPA' };
}

/* Fill the threshold inputs from the active thresholds. */
function fillProductionInputs(){
  const th = getProductionThresholds();
  for (const [id, key] of Object.entries(productionInputMap())){
    const el = document.getElementById(id);
    if (el) el.value = th[key];
  }
}

/* Wire the Apply / Reset buttons once. Apply reads the inputs, updates the
 * thresholds, refreshes the threshold copy and re-runs the production queries so
 * the scorecards, scatter, chart and tables all re-classify against the new
 * bands. Reset restores the client defaults. Edits are session-only. */
function ensureProductionControls(){
  if (productionControlsWired) return;
  const apply = document.getElementById('th-apply');
  const reset = document.getElementById('th-reset');
  if (!apply || !reset) return; // tab markup not present yet
  fillProductionInputs();
  apply.addEventListener('click', () => {
    const partial = {};
    for (const [id, key] of Object.entries(productionInputMap())){
      const el = document.getElementById(id);
      if (el && el.value !== '') partial[key] = el.value;
    }
    setProductionThresholds(partial);
    fillProductionInputs();            // reflect any values that were rejected
    refreshProductionThresholdCopy();
    loadProduction();
  });
  reset.addEventListener('click', () => {
    resetProductionThresholds();
    fillProductionInputs();
    refreshProductionThresholdCopy();
    loadProduction();
  });
  productionControlsWired = true;
}

function loadMonthlyTab(tab){
  loadedTabs[tab] = true;
  if(tab === 'decay')      loadDecay();
  if(tab === 'age')        loadAge();
  if(tab === 'production') loadProduction();
  if(tab === 'powerlaw')   loadPowerLaw();
  if(tab === 'creative')   loadCreativeEffectiveness();
}

/* Meta tabs whose totals are summed in SQL carry the ad search in their queries
 * (searchScopeWhere). When the search changes, mark them stale and re-query the
 * one on screen; the others re-query when next opened. */
const AD_SEARCH_SQL_TABS = ['decay', 'age', 'production'];
onAdSearchReload('meta', () => {
  AD_SEARCH_SQL_TABS.forEach(t => { delete loadedTabs[t]; });
  const panel = document.getElementById('tab-' + activeTab);
  if(AD_SEARCH_SQL_TABS.includes(activeTab) && panel && panel.classList.contains('active')) loadMonthlyTab(activeTab);
});

/* ── Ad Decay ── */

async function loadDecay(){
  /* Cohort efficiency: CPA (SUM(spend)/SUM(conv), 0 dp) or, in ROAS mode, monthly
     ROAS (SUM(revenue)/SUM(spend), 2 dp) via the gated ${REVENUE_EXPR} column. The
     alias stays `cpa` so the render/grand-total plumbing below is untouched. */
  const decayMetricSQL = `ROUND(${lifetimeMetricSQL('SUM(spend)', `SUM(${CONV_EXPR})`)}, ${targetMetric()==='roas'?2:0})`;
  const summarySQL = `
    SELECT FORMAT_DATE('%b %Y', min_date) AS launch_month, DATE_TRUNC(min_date, MONTH) AS launch_month_sort,
      COUNT(DISTINCT ad_id) AS ads_launched,
      ROUND(AVG(DATE_DIFF(COALESCE(max_date, CURRENT_DATE()), min_date, DAY)), 0) AS avg_days_running,
      ROUND(SUM(spend), 0) AS total_spend,
      ${decayMetricSQL} AS cpa
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${searchScopeWhere('WHERE')} GROUP BY 1, 2 ORDER BY 2 DESC`;
  const dailySQL = `
    SELECT FORMAT_DATE('%b %Y', min_date) AS launch_month, DATE_TRUNC(min_date, MONTH) AS launch_month_sort,
      date_start, ROUND(SUM(spend), 2) AS daily_spend
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${searchScopeWhere('WHERE')} GROUP BY 1, 2, 3 ORDER BY 3, 2`;
  const term = adSearchTerm;
  try {
    const [summary, daily] = await Promise.all([runQuery(summarySQL), runQuery(dailySQL)]);
    if(term !== adSearchTerm) return;  /* a newer search is already reloading this tab */
    let total_ads=0,total_spend=0;
    const decayRows=summary.map(r=>{ total_ads+=Number(r.ads_launched); total_spend+=Number(r.total_spend);
      return `<tr><td>${r.launch_month}</td><td>${fmtNum(r.ads_launched)}</td><td>${r.avg_days_running?r.avg_days_running+'d':'–'}</td><td>${fmt$(r.total_spend)}</td><td>${r.cpa&&Number(r.cpa)>0?fmtMetricCell(r.cpa):'–'}</td></tr>`; });
    renderPagedTable('decay-summary-body', decayRows, 20, `<tr style="font-weight:600; background:var(--paper);"><td>Grand Total</td><td>${fmtNum(total_ads)}</td><td>–</td><td>${fmt$(total_spend)}</td><td>–</td></tr>`);
    hideEl('decay-summary-loading'); showEl('decay-summary-table');
    const cohorts=[...new Set(daily.map(r=>r.launch_month))];
    const dates=[...new Set(daily.map(r=>bqStr(r.date_start)))].sort();
    const spendMap={}; daily.forEach(r=>{ spendMap[r.launch_month+'|'+bqStr(r.date_start)]=Number(r.daily_spend); });
    const datasets=cohorts.map((c,i)=>({ label:c, data:dates.map(d=>spendMap[c+'|'+d]||0), backgroundColor:COHORT_COLORS[i%COHORT_COLORS.length]+'99', borderColor:COHORT_COLORS[i%COHORT_COLORS.length], borderWidth:2, fill:true, tension:0.3, pointRadius:3 }));
    hideEl('decay-chart-loading'); showEl('decay-chart-wrapper');
    if(decayChart) decayChart.destroy();
    decayChart=new Chart(document.getElementById('decay-chart'),{ type:'line', data:{ labels:dates.map(d=>fmtDate(d)), datasets },
      options:{ responsive:true, maintainAspectRatio:true, scales:{ x:{stacked:true,ticks:{font:{size:10},maxRotation:45}}, y:{stacked:true,ticks:{callback:v=>'$'+v.toLocaleString()}} }, plugins:{ legend:{position:'top',labels:{font:{size:11}}} } } });
    const pctDatasets=cohorts.map((c,i)=>({ label:c, data:dates.map(d=>spendMap[c+'|'+d]||0), backgroundColor:COHORT_COLORS[i%COHORT_COLORS.length]+'cc', borderColor:COHORT_COLORS[i%COHORT_COLORS.length], borderWidth:1, fill:true }));
    const dayTotals=dates.map(d=>cohorts.reduce((s,c)=>s+(spendMap[c+'|'+d]||0),0));
    pctDatasets.forEach(ds=>{ ds.data=ds.data.map((v,i)=>dayTotals[i]>0?(v/dayTotals[i]*100):0); });
    hideEl('decay-pct-loading'); showEl('decay-pct-wrapper');
    if(decayPctChart) decayPctChart.destroy();
    decayPctChart=new Chart(document.getElementById('decay-pct-chart'),{ type:'bar', data:{ labels:dates.map(d=>fmtDate(d)), datasets:pctDatasets },
      options:{ responsive:true, maintainAspectRatio:true, scales:{ x:{stacked:true,ticks:{font:{size:10},maxRotation:45}}, y:{stacked:true,max:100,ticks:{callback:v=>v+'%'}} }, plugins:{ legend:{position:'top',labels:{font:{size:11}}} } } });
  } catch(err){ console.error('Decay error:',err); document.getElementById('tab-decay').innerHTML+=`<div class="no-data">Error loading data: ${err.message}</div>`; }
}

/* ── Ad Age ── */

async function loadAge(){
  const ageSQL = `
    SELECT date_start,
      CASE WHEN creative_age IN ('1. 0-7 Days','2. 8-14 Days') THEN '0–14 Days'
           WHEN creative_age IN ('3. 15-30 Days','4. 31-60 Days','5. 61-90 Days','3. 15-60 Days','4. 31-90 Days') THEN '15–90 Days'
           ELSE '90+ Days' END AS age_bucket,
      ROUND(SUM(spend), 2) AS daily_spend
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${searchScopeWhere('WHERE')} GROUP BY 1, 2 ORDER BY 1, 2`;
  const tableSQL = `
    SELECT ad_id, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adset_name) AS adset_name, ANY_VALUE(ad_name) AS ad_name,
      MIN(min_date) AS launch_date, MAX(max_date) AS last_spend, ANY_VALUE(creative_link) AS preview_link,
      ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
      ROUND(${lifetimeMetricSQL('ANY_VALUE(lifetime_spend)', `SUM(${CONV_EXPR})`)}, 2) AS lifetime_cpa,
      ROUND(SUM(${CONV_EXPR}), 0) AS total_conversions
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scopeWhere('WHERE')} GROUP BY 1 ORDER BY lifetime_spend DESC`;
  const term = adSearchTerm;
  try {
    const [ageData, tableData] = await Promise.all([runQuery(ageSQL), runQuery(tableSQL)]);
    if(term !== adSearchTerm) return;  /* a newer search is already reloading this tab */
    const dates=[...new Set(ageData.map(r=>bqStr(r.date_start)))].sort();
    const buckets=['0–14 Days','15–90 Days','90+ Days'];
    const spendMap={}; ageData.forEach(r=>{ spendMap[bqStr(r.date_start)+'|'+r.age_bucket]=Number(r.daily_spend); });
    const ageDatasets=buckets.map(b=>{ const raw=dates.map(d=>spendMap[d+'|'+b]||0); const dayTotals=dates.map(d=>buckets.reduce((s,bk)=>s+(spendMap[d+'|'+bk]||0),0));
      return { label:b, data:raw.map((v,i)=>dayTotals[i]>0?+(v/dayTotals[i]*100).toFixed(1):0), backgroundColor:AGE_COLORS[b]+'dd', borderColor:AGE_COLORS[b], borderWidth:1 }; });
    hideEl('age-chart-loading'); showEl('age-chart-wrapper');
    if(ageChart) ageChart.destroy();
    ageChart=new Chart(document.getElementById('age-chart'),{ type:'bar', data:{ labels:dates.map(d=>fmtDate(d)), datasets:ageDatasets },
      options:{ responsive:true, maintainAspectRatio:true, scales:{ x:{stacked:true,ticks:{font:{size:10},maxRotation:45}}, y:{stacked:true,max:100,ticks:{callback:v=>v+'%'}} }, plugins:{ legend:{position:'top',labels:{font:{size:11}}}, tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw}%`}} } } });
    renderPagedTable('age-table-body', tableData.map(r=>`<tr ${adNameAttr(r.ad_name, r.campaign_name, r.adset_name)}><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmtDate(r.last_spend)}</td><td>${r.preview_link?`<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.preview_link}" target="_blank">Preview</a>`:'–'}</td><td>${fmt$(r.lifetime_spend)}</td><td>${r.lifetime_cpa&&Number(r.lifetime_cpa)>0?fmtMetricCell(r.lifetime_cpa):'–'}</td><td>${fmtNum(r.total_conversions)}</td></tr>`));
    hideEl('age-table-loading'); showEl('age-table');
  } catch(err){ console.error('Age error:',err); }
}

/* ── Ad Production ── */

/* Creative Score inputs for the Meta creative mart (US-002). Rates are a percent
 * of impressions (0..100), matching creativeRates(); Meta has no early-view hook
 * gate (profile hookCol is null) so hookExpr is omitted and drops out of the
 * quality average. hasVideo gates on video_plays; activeDays reads the per-ad
 * active_days column both per-ad queries expose. The Production and Creative
 * Effectiveness tabs pass THESE SAME opts to creativeScoreSQL, so the score for a
 * given ad and window matches across both tabs (computed once in SQL, rendered
 * verbatim by creativeScoreBadge -- never recomputed in JS). */
function metaScoreOpts(){
  return {
    holdExpr:       'SAFE_DIVIDE(video_15s, NULLIF(impressions, 0)) * 100',
    ctrExpr:        'SAFE_DIVIDE(clicks, NULLIF(impressions, 0)) * 100',
    completionExpr: 'SAFE_DIVIDE(video_p100, NULLIF(impressions, 0)) * 100',
    hasVideoExpr:   'video_plays > 0',
    activeDaysExpr: 'active_days',
    /* Per-platform quality ceilings (rates as a percent of impressions),
       validated on FastCover live data in US-004. Meta has no hook gate, so the
       Meta set is hold/ctr/completion; centring a real Meta video near 0.5. */
    qualityCeil:    { hold: 6, ctr: 1.3, completion: 2.5 },
  };
}

async function loadProduction(){
  ensureProductionControls();
  if (confidenceLinesEnabled()) ensureConfidenceControls();
  fillProductionInputs();
  refreshProductionThresholdCopy();
  /* The verdict SQL carries the targets, so the (cached) baseline loads first. */
  if (confidenceLinesEnabled()) await loadConfidenceBaseline().catch(err => console.error('Confidence baseline error:', err));
  /* CPA is spend / conversions using the dashboard's CONV_EXPR (the same conversion
     definition every other tab uses), NOT the mart's primary-only lifetime_cpa. That
     way each ad is measured by the conversions it actually drives — e.g. SMSF ads on
     Calendly bookings — so multi-product accounts classify correctly. */
  const scatterSQL = `
    WITH per_ad AS (
      SELECT ad_id, ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adset_name) AS adset_name,
        MIN(min_date) AS launch_date, ANY_VALUE(creative_link) AS creative_link,
        DATE_DIFF(COALESCE(MAX(max_date), CURRENT_DATE()), MIN(min_date), DAY) AS active_days,
        ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
        ROUND(SUM(${CONV_EXPR}), 0) AS total_conversions,
        ROUND(${lifetimeMetricSQL('ANY_VALUE(lifetime_spend)', `SUM(${CONV_EXPR})`)}, 2) AS ${lifetimeMetricCol()},
        SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(video_15s) AS video_15s,
        SUM(video_p25) AS video_p25, SUM(video_p50) AS video_p50, SUM(video_p75) AS video_p75,
        SUM(video_p100) AS video_p100, SUM(video_plays) AS video_plays, SUM(outbound_clicks) AS outbound_clicks${thresholdGroupSelect()}${confidenceAdSelect()}
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scopeWhere('WHERE')} GROUP BY 1
    )${confidenceScatterCTE()}
    SELECT *,
      ${classificationCaseSQL('lifetime_spend', lifetimeMetricCol())} AS classification,
      ${creativeScoreSQL('lifetime_spend', lifetimeMetricCol(), metaScoreOpts())} AS creative_score${confidenceVerdictSelect()}
    FROM ${confidenceScatterFrom()} ORDER BY lifetime_spend DESC`;
  /* Metric-aware rollup: unique_ads carries the same per-ad lifetime metric the
     scatter uses (lifetime_cpa or lifetime_roas), classified by the single shared
     builder. period_revenue is selected ONLY in ROAS mode so CPA-mode marts are
     never queried for a revenue column. The month-level avg is SUM(revenue)/
     SUM(spend) in ROAS mode and SUM(spend)/SUM(conversions) in CPA mode; the
     alias stays `avg_cpa` so the existing summary-table render is unchanged
     (metric-aware formatting of that cell is US-005). */
  const rollupMetricCol = lifetimeMetricCol();
  const rollupIsRoas = targetMetric() === 'roas';
  const rollupRevSel = rollupIsRoas ? `, ROUND(SUM(${revenueExpr()}),2) AS period_revenue` : '';
  const rollupAvgSQL = rollupIsRoas
    ? `ROUND(SAFE_DIVIDE(SUM(period_revenue), NULLIF(SUM(period_spend),0)),2)`
    : `ROUND(SAFE_DIVIDE(SUM(period_spend), NULLIF(SUM(total_conversions),0)),0)`;
  const monthlySQL = `
    WITH unique_ads AS (
      SELECT ad_id, MIN(min_date) AS launch_date, ROUND(ANY_VALUE(lifetime_spend),2) AS lifetime_spend, ROUND(${lifetimeMetricSQL('ANY_VALUE(lifetime_spend)', `SUM(${CONV_EXPR})`)},2) AS ${rollupMetricCol},
        ROUND(SUM(spend),2) AS period_spend, ROUND(SUM(${CONV_EXPR}),0) AS total_conversions${rollupRevSel}${thresholdGroupSelect()}
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`${searchScopeWhere('WHERE')} GROUP BY 1 ),
    classified AS ( SELECT *, ${classificationCaseSQL('lifetime_spend', rollupMetricCol)} AS classification FROM unique_ads )
    SELECT FORMAT_DATE('%b %Y', launch_date) AS launch_month, DATE_TRUNC(launch_date, MONTH) AS launch_month_sort,
      COUNT(*) AS ads_launched, COUNTIF(classification='Home Run') AS home_runs, COUNTIF(classification='On Base') AS on_base, COUNTIF(classification='Strike Out') AS strike_outs,
      ROUND(SUM(period_spend),0) AS total_spend, ${rollupAvgSQL} AS avg_cpa, ROUND(SUM(total_conversions),0) AS total_conversions
    FROM classified GROUP BY 1, 2 ORDER BY 2 DESC`;
  const term = adSearchTerm;
  try {
    const [scatterData, monthlyData] = await Promise.all([runQuery(scatterSQL), runQuery(monthlySQL)]);
    if(term !== adSearchTerm) return;  /* a newer search is already reloading this tab */
    if (confidenceLinesEnabled()){
      try { await loadConfidenceBaseline(); renderConfidenceBaselinePanel(adSearchFilter(scatterData, r=>adSearchKey(r.ad_name, r.campaign_name, r.adset_name))); }
      catch(err){ console.error('Confidence baseline error:', err); }
    }
    /* Revenue-integrity guard (US-010): in ROAS mode, if there is lifetime spend
     * but NOT ONE ad shows positive ROAS, blended revenue is 0 across the whole
     * account — the gated revenue column is missing/zeroed. (A single Strike Out
     * coexists with positive-ROAS ads, so it never trips this.) Derived from the
     * scatter rows already fetched, so no extra query. Never fires in CPA mode. */
    const guardMCol = lifetimeMetricCol();
    const revBroken = targetMetric() === 'roas'
      && scatterData.some(r => (Number(r.lifetime_spend)||0) > 0)
      && !scatterData.some(r => (Number(r[guardMCol])||0) > 0);
    applyRevenueGuard('production-revenue-guard', revBroken);
    /* Scorecards count the ads the search matches, like the table and chart. */
    const totals=adSearchFilter(scatterData, r=>adSearchKey(r.ad_name, r.campaign_name, r.adset_name)).reduce((acc,r)=>{ acc.total++; if(r.classification==='Home Run')acc.hr++; if(r.classification==='On Base')acc.ob++; if(r.classification==='Strike Out')acc.so++; return acc; },{total:0,hr:0,ob:0,so:0});
    document.getElementById('sc-ads-produced').textContent=fmtNum(totals.total);
    document.getElementById('sc-home-runs').textContent=fmtNum(totals.hr);
    document.getElementById('sc-hr-rate').textContent=totals.total?fmtPct(totals.hr/totals.total*100):'–';
    document.getElementById('sc-on-base').textContent=fmtNum(totals.ob);
    document.getElementById('sc-ob-rate').textContent=totals.total?fmtPct(totals.ob/totals.total*100):'–';
    document.getElementById('sc-strike-outs').textContent=fmtNum(totals.so);
    document.getElementById('sc-so-rate').textContent=totals.total?fmtPct(totals.so/totals.total*100):'–';
    hideEl('production-scorecards-loading'); showEl('production-scorecards');
    /* Buckets come from classificationTiers() so a tier the active CASE can
       emit always has somewhere to land. A row carrying an unexpected label
       is counted and reported rather than thrown away or crashing the tab. */
    const byClass={}; classificationTiers().forEach(t => { byClass[t]=[]; });
    /* Metric-aware: the per-ad metric column is `lifetime_cpa` in CPA mode and
       `lifetime_roas` in ROAS mode (aliased by lifetimeMetricCol()). Read it
       generically so a dir:'higher' metric plots correctly. A creative with
       metric=0 but spend>0 (real spend, zero revenue in ROAS) is kept, not
       silently dropped — it belongs at the bottom of a higher-is-better axis. */
    const isRoas=targetMetric()==='roas';
    const mCol=lifetimeMetricCol();
    const unknownTiers=new Set();
    const confMode = confidenceLinesEnabled() ? confidenceScatterMode(scatterData) : null;
    scatterData.forEach(r=>{ const mVal=Number(r[mCol])||0, spend=Number(r.lifetime_spend)||0; if(mVal>0||spend>0){ const cls=r.classification; if(!byClass[cls]){ byClass[cls]=[]; unknownTiers.add(cls); } byClass[cls].push(confidencePoint({x:spend,y:mVal,label:r.ad_name,_key:adSearchKey(r.ad_name, r.campaign_name, r.adset_name)}, r, confMode)); } });
    if(unknownTiers.size) console.warn('Ad Production: unrecognised classification tier(s) from the query:', [...unknownTiers].join(', '));
    const scatterDatasets=Object.entries(byClass).map(([cls,pts])=>{ const col=CLASS_COLOR[cls]||'#b0b0b0'; return { label:cls, data:pts, backgroundColor:col+'bb', borderColor:col, borderWidth:1.5, pointRadius:6, pointHoverRadius:8 }; });
    hideEl('scatter-loading'); showEl('scatter-wrapper');
    if(scatterChart) scatterChart.destroy();
    const topSpend=Math.max(0, ...scatterData.map(r=>Number(r.lifetime_spend)||0));
    const maxSpend=Math.round(scatterMaxSpend(topSpend));
    /* Y-axis max from the ACTIVE metric's values, not the CPA range. The floor
       keeps the Home Run threshold line on-chart even when data is sparse: 100
       ($) in CPA mode, HR_ROAS (x) in ROAS mode where values live around 1–10. */
    /* Guide lines follow the active Product filter (getProductionThresholds is
       filter-aware): when a per-group product is selected they show that
       product's Ad Hit / CPA Limit, matching how those ads are actually graded. */
    const guideTh=getProductionThresholds();
    const guideHitSpend=guideTh.HR_SPEND, guideYThresh=isRoas?guideTh.HR_ROAS:guideTh.HR_CPA;
    const yFloor=isRoas?guideYThresh:100;
    const maxY=confMode ? confidenceScatterMaxY(scatterDatasets, confMode) : Math.ceil(Math.max(...scatterData.filter(r=>Number(r[mCol])>0).map(r=>Number(r[mCol])||0),yFloor)*1.2);
    if (confMode) confidencePinNoConv(scatterDatasets, maxY);
    confidenceCurveState = confMode ? confidenceCurveFor(confMode, maxSpend) : null;
    renderConfidenceLinesNote(confMode);
    scatterChart=new Chart(document.getElementById('scatter-chart'),{ type:'scatter', data:{ datasets:scatterDatasets },
      options:{ responsive:true, maintainAspectRatio:false,
        scales:{ x:Object.assign({ title:{display:true,text:'Lifetime Spend ($)',font:{size:11}}, min:0, max:maxSpend, ticks:{callback:v=>fmt$(v)} }, confMode && confMode.log ? { type:'logarithmic', min:confMode.logMin } : {}), y:{ title:{display:true,text:confMode ? confMode.label : `Lifetime ${targetMetricDef().label} (${isRoas?'x':'$'})`,font:{size:11}}, min:0, max:maxY, ticks:{callback:v=>fmtMetricCell(v)} } },
        plugins:{ legend:{position:'top',labels:{font:{size:11}}}, tooltip:{callbacks:{label:ctx=>{ const pt=ctx.raw; const mLine=confMode?(pt._noConv?'No conversions yet':`${confMode.label}: ${fmt$(pt.y)}`):isRoas?`${targetMetricDef().label}: ${fmtMetricCell(pt.y)}`:`CPA: ${pt.y>0?fmt$(pt.y):'N/A'}`; return [`${ctx.dataset.label}`,`Spend: ${fmt$(pt.x)}`,mLine]; }}} } },
      plugins:[{ id:'threshold-lines', afterDraw(chart){ const ctx2=chart.ctx,xAxis=chart.scales.x,yAxis=chart.scales.y;
        const xHit=xAxis.getPixelForValue(guideHitSpend); if(xHit>=xAxis.left&&xHit<=xAxis.right){ ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle=CHART_SECONDARY; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xHit,yAxis.top); ctx2.lineTo(xHit,yAxis.bottom); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle=CHART_SECONDARY; ctx2.font='10px Archivo, sans-serif'; ctx2.fillText('Ad Hit ('+fmt$(guideHitSpend)+')',xHit+4,yAxis.top+14); ctx2.restore(); }
        const yThresh=guideYThresh; const yLine=confMode?NaN:yAxis.getPixelForValue(yThresh); if(yLine>=yAxis.top&&yLine<=yAxis.bottom){ ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle='#727272'; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xAxis.left,yLine); ctx2.lineTo(xAxis.right,yLine); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle='#727272'; ctx2.font='10px Archivo, sans-serif'; ctx2.fillText((isRoas?'ROAS Target (':'CPA Limit (')+fmtMetricCell(yThresh)+')',xAxis.left+4,yLine-4); ctx2.restore(); } } }].concat(confMode ? [confidenceLinesPlugin()] : []) });
    followAdSearch('scatter', scatterChart);
    const months=monthlyData.map(r=>r.launch_month).reverse();
    const adsArr=monthlyData.map(r=>Number(r.ads_launched)).reverse();
    const hrRates=monthlyData.map(r=>+(Number(r.home_runs)/Number(r.ads_launched)*100).toFixed(1)).reverse();
    const obRates=monthlyData.map(r=>+(Number(r.on_base)/Number(r.ads_launched)*100).toFixed(1)).reverse();
    const soRates=monthlyData.map(r=>+(Number(r.strike_outs)/Number(r.ads_launched)*100).toFixed(1)).reverse();
    hideEl('production-chart-loading'); showEl('production-chart-wrapper');
    if(productionChart) productionChart.destroy();
    productionChart=new Chart(document.getElementById('production-chart'),{ type:'bar', data:{ labels:months, datasets:[
      {type:'bar',label:'Ads Launched',data:adsArr,backgroundColor:'#e6e6e6',borderColor:'#b0b0b0',borderWidth:1,yAxisID:'y',order:1},
      {type:'line',label:'Home Run Rate',data:hrRates,borderColor:CHART_PRIMARY,backgroundColor:'transparent',borderWidth:2,pointRadius:4,yAxisID:'y2',tension:0.3,order:0},
      {type:'line',label:'On Base Rate',data:obRates,borderColor:CHART_SECONDARY,backgroundColor:'transparent',borderWidth:2,pointRadius:4,yAxisID:'y2',tension:0.3,order:0},
      {type:'line',label:'Strike Out Rate',data:soRates,borderColor:CHART_NEGATIVE,backgroundColor:'transparent',borderWidth:2,pointRadius:4,yAxisID:'y2',tension:0.3,borderDash:[4,3],order:0} ] },
      options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{ticks:{font:{size:10}}}, y:{title:{display:true,text:'Ads Launched',font:{size:10}},ticks:{font:{size:10}}}, y2:{position:'right',title:{display:true,text:'Rate (%)',font:{size:10}},ticks:{callback:v=>v+'%',font:{size:10}},grid:{drawOnChartArea:false}} }, plugins:{ legend:{position:'top',labels:{font:{size:11}}} } } });
    let gAds=0,gHR=0,gOB=0,gSO=0,gSpend=0,gConv=0;
    const prodRows=monthlyData.map(r=>{ const ads=Number(r.ads_launched),hr=Number(r.home_runs),ob=Number(r.on_base),so=Number(r.strike_outs); gAds+=ads;gHR+=hr;gOB+=ob;gSO+=so;gSpend+=Number(r.total_spend);gConv+=Number(r.total_conversions);
      return `<tr><td>${r.launch_month}</td><td>${fmt$(r.total_spend)}</td><td>${ads}</td><td>${hr}</td><td>${fmtPct(hr/ads*100)}</td><td>${ob}</td><td>${fmtPct(ob/ads*100)}</td><td>${r.avg_cpa&&Number(r.avg_cpa)>0?fmtMetricCell(r.avg_cpa):'–'}</td><td>${fmtNum(r.total_conversions)}</td><td>${so}</td><td>${fmtPct(so/ads*100)}</td></tr>`; });
    renderPagedTable('production-table-body', prodRows, 20, `<tr style="font-weight:600; background:var(--paper);"><td>Grand Total</td><td>${fmt$(gSpend)}</td><td>${gAds}</td><td>${gHR}</td><td>${fmtPct(gHR/gAds*100)}</td><td>${gOB}</td><td>${fmtPct(gOB/gAds*100)}</td><td>–</td><td>${fmtNum(gConv)}</td><td>${gSO}</td><td>${fmtPct(gSO/gAds*100)}</td></tr>`);
    hideEl('production-table-loading'); showEl('production-table');
    renderPagedTable('scatter-table-body', scatterData.map(r=>{ const cls=r.classification; const badgeClass=cls==='Home Run'?'badge-hr':cls==='On Base'?'badge-ob':cls==='Strike Out'?'badge-so':'badge-un'; const ce={ impressions:Number(r.impressions)||0, clicks:Number(r.clicks)||0, video_15s:Number(r.video_15s)||0, video_p25:Number(r.video_p25)||0, video_p50:Number(r.video_p50)||0, video_p75:Number(r.video_p75)||0, video_p100:Number(r.video_p100)||0, video_plays:Number(r.video_plays)||0, outbound_clicks:Number(r.outbound_clicks)||0 }; const cr=creativeRates(ce); registerAdMetrics(r.ad_id, ce, undefined, creativeScoreHover(r.creative_score, { spend:r.lifetime_spend, metric:r[mCol], hook:cr.hook, hold:cr.hold, ctr:cr.ctr, completion:cr.completion, hasVideo:cr.hasVideo, activeDays:r.active_days }, metaScoreOpts()));
      return `<tr ${adNameAttr(r.ad_name, r.campaign_name, r.adset_name)}><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmt$(r.lifetime_spend)}</td><td>${r[mCol]&&Number(r[mCol])>0?fmtMetricCell(r[mCol]):'–'}</td><td>${fmtNum(r.total_conversions)}</td><td class="num">${cr.hold!=null?fmtPct(cr.hold,2):'–'}</td><td class="num">${cr.completion!=null?fmtPct(cr.completion,2):'–'}</td><td class="num">${cr.outboundCtr!=null?fmtPct(cr.outboundCtr,2):'–'}</td><td>${r.creative_link?`<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.creative_link}" target="_blank">Preview</a>`:'–'}</td><td><span class="badge ${badgeClass}">${cls}</span></td><td>${creativeScoreBadge(r.creative_score)}</td>${confidenceLinesEnabled() ? confidenceVerdictCell(r.verdict) : ''}</tr>`; }));
    hideEl('scatter-table-loading'); showEl('scatter-table');
  } catch(err){ console.error('Production error:',err); }
}

/* ── Confidence lines baseline panel (confidence-lines US-002) ──
 * All of this is inert unless CONFIDENCE_LINES is configured: the layout has no
 * #ctrl-segment or #prod-baseline-controls, and loadProduction() never calls in. */
let confidenceControlsWired = false;
let confidenceSegmentsLoaded = false;
let _confidenceBaselinePromise = null;
let _confidenceBaselinePromiseEnd = null;

/* Populate the Campaign type dropdown once and wire its change, plus the Reset
 * to baseline button. A segment change re-scopes every non-weekly tab the same
 * way a Product change does. */
function ensureConfidenceControls(){
  if (confidenceControlsWired || !confidenceLinesEnabled()) return;
  const sel = document.getElementById('ctrl-segment');
  const reset = document.getElementById('cl-reset');
  if (!sel || !reset) return;
  confidenceControlsWired = true;
  sel.addEventListener('change', () => {
    setSegmentSelection(sel.value);
    if (window.F10A) F10A.track('filter_changed', { filter: 'campaign_type', value: sel.value });
    Object.keys(loadedTabs).forEach(t => { if (!isWeekly(t)) delete loadedTabs[t]; });
    loadWindows();
    if (!isWeekly(activeTab)) loadMonthlyTab(activeTab);
  });
  reset.addEventListener('click', () => {
    resetConfidenceTargets(confidenceSelectedKey());
    loadProduction();
  });
  const logEl = document.getElementById('cl-log-toggle');
  if (logEl) logEl.addEventListener('change', () => { confidenceLogAxis = !!logEl.checked; loadProduction(); });
  const yEl = document.getElementById('cl-y-mode');
  if (yEl) yEl.addEventListener('change', () => { confidenceYMode = yEl.value === 'scale' ? 'scale' : 'kill'; loadProduction(); });
  loadConfidenceSegments(sel);
}

async function loadConfidenceSegments(sel){
  if (confidenceSegmentsLoaded) return;
  const cfg = confidenceLinesConfig();
  if (!cfg) return;
  confidenceSegmentsLoaded = true;
  try {
    const rows = await runQuery(`SELECT DISTINCT (${cfg.segmentExpr}) AS segment FROM \`${PROJECT}.${DATASET}.${TABLE}\` WHERE (${cfg.segmentExpr}) IS NOT NULL ORDER BY 1`);
    const opts = rows.map(r => _confStr(r.segment)).filter(v => v != null && v !== '');
    sel.innerHTML = `<option value="${GROUP_ALL}">All campaign types</option>` + opts.map(v => {
      const label = v === CONFIDENCE_UNMATCHED_SEGMENT ? 'Unmatched (check naming)' : v;
      return `<option value="${escapeHtmlAttr(v)}"${v === segmentSelection ? ' selected' : ''}>${escapeHtmlAttr(label)}</option>`;
    }).join('');
    sel.value = segmentSelection;
  } catch (err) { confidenceSegmentsLoaded = false; console.error('Campaign type list error:', err); }
}
function escapeHtmlAttr(v){ return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* The window end the dashboard is showing: the end-date control, else the
 * latest date in the mart. */
function confidenceWindowEnd(){
  const el = document.getElementById('ctrl-enddate');
  if (el && el.value) return el.value;
  return (typeof MAXDATE !== 'undefined' && MAXDATE) ? MAXDATE : null;
}

/* Run the baseline query once per window end; later calls reuse the result. */
async function loadConfidenceBaseline(){
  const end = confidenceWindowEnd();
  if (!end) return false;
  if (confidenceBaselineEnd() === end) return true;
  if (_confidenceBaselinePromise && _confidenceBaselinePromiseEnd === end) return _confidenceBaselinePromise;
  const sql = confidenceBaselineSQL(end);
  if (!sql) return false;
  _confidenceBaselinePromiseEnd = end;
  _confidenceBaselinePromise = runQuery(sql).then(rows => { setConfidenceBaseline(rows, end); return true; })
    .finally(() => { _confidenceBaselinePromise = null; _confidenceBaselinePromiseEnd = null; });
  return _confidenceBaselinePromise;
}

/* Count the visible scatter rows by their SQL verdict column. */
function confidenceVerdictCounts(rows){
  const out = { Scale: 0, Testing: 0, Cut: 0, ungraded: 0 };
  (rows || []).forEach(r => {
    const v = _confStr(r.verdict);
    if (v && out[v] !== undefined) out[v]++; else out.ungraded++;
  });
  return out;
}

/* ── Verdict column and confidence lines (confidence-lines US-003) ──
 * The verdict is computed once, in SQL: a per_ad_conf CTE attaches each ad's own
 * group x segment kill and scale targets (session edits included) and
 * confidenceVerdictSQL grades it. The table, the counts and the chart all read
 * that column; nothing here recomputes a verdict. All inert without config. */
let confidenceLogAxis = false;
let confidenceYMode = 'kill';
let confidenceCurveState = null;
const CONFIDENCE_VERDICT_BADGE = { Scale: 'badge-scale', Testing: 'badge-testing', Cut: 'badge-cut' };

/* CASE over every baseline cell that has a usable target for which ('kill' or
 * 'scale'). NULL when no cell has one. */
function confidenceTargetCaseSQL(which){
  const whens = Object.keys(_confidenceBaseline.rows).map(k => {
    const b = _confidenceBaseline.rows[k];
    const t = getConfidenceTargets(k);
    if (!t || !(t[which] > 0)) return null;
    return `WHEN IFNULL(conf_group, '') = ${sqlQuote(b.group == null ? '' : b.group)} AND conf_segment = ${sqlQuote(b.segment)} THEN ${_sqlNum(t[which])}`;
  }).filter(Boolean);
  return whens.length ? `CASE ${whens.join(' ')} END` : 'CAST(NULL AS FLOAT64)';
}
function confidenceScatterCTE(){
  if (!confidenceLinesConfig()) return '';
  return `,
    per_ad_conf AS (
      SELECT *, ${confidenceTargetCaseSQL('kill')} AS kill_target, ${confidenceTargetCaseSQL('scale')} AS scale_target FROM per_ad
    )`;
}
function confidenceScatterFrom(){ return confidenceLinesConfig() ? 'per_ad_conf' : 'per_ad'; }
/* Scale is tested first inside confidenceVerdictSQL, so sub evidence outranks
 * lead evidence when an ad qualifies for both. NULL when the ad's cell has no
 * baseline. */
function confidenceVerdictSelect(){
  const cfg = confidenceLinesConfig();
  if (!cfg) return '';
  return `,
      IF(kill_target IS NULL AND scale_target IS NULL, CAST(NULL AS STRING), ${confidenceVerdictSQL('lifetime_spend', 'kill_conv', 'kill_target', { conf: cfg.confidence, scaleConvCol: 'scale_conv', scaleTargetCol: 'scale_target' })}) AS verdict`;
}
function confidenceVerdictCell(v){
  const s = _confStr(v);
  if (!s || !CONFIDENCE_VERDICT_BADGE[s]) return '<td><span class="tc-note">No baseline</span></td>';
  return `<td><span class="badge ${CONFIDENCE_VERDICT_BADGE[s]}">${s}</span></td>`;
}

/* Chart mode for the selected cell: which cost per conversion the y axis shows,
 * whether spend is on a log axis, and the target the line is drawn from. */
function confidenceScatterMode(rows){
  const cfg = confidenceLinesConfig();
  if (!cfg) return null;
  const which = confidenceYMode === 'scale' ? 'scale' : 'kill';
  const key = confidenceSelectedKey();
  const t = key ? getConfidenceTargets(key) : null;
  const minPos = Math.min(Infinity, ...(rows || []).map(r => Number(r.lifetime_spend) || 0).filter(v => v > 0));
  const logMin = isFinite(minPos) ? Math.max(1, Math.pow(10, Math.floor(Math.log10(minPos)))) : 1;
  return {
    cfg, which, key, log: !!confidenceLogAxis,
    target: t ? t[which] : null,
    label: which === 'scale' ? cfg.scaleLabel : cfg.killLabel,
    convCol: which === 'scale' ? 'scale_conv' : 'kill_conv',
    logMin,
  };
}
function confidencePoint(base, r, mode){
  if (!mode) return base;
  const conv = Number(r[mode.convCol]) || 0;
  if (conv > 0) return Object.assign(base, { y: base.x / conv });
  return Object.assign(base, { y: null, _noConv: true });
}
function confidenceScatterMaxY(datasets, mode){
  const ys = [];
  datasets.forEach(d => d.data.forEach(p => { if (p.y != null && p.y > 0) ys.push(p.y); }));
  if (mode.target > 0) ys.push(mode.target * 2);
  return Math.max(1, Math.ceil(Math.max(0, ...ys) * 1.2));
}
/* Ads with no conversions of the selected kind sit along the top edge. */
function confidencePinNoConv(datasets, maxY){
  datasets.forEach(d => d.data.forEach(p => { if (p._noConv) p.y = maxY; }));
}
function confidenceCurveFor(mode, maxSpend){
  if (!mode || !mode.key || !(mode.target > 0)) return null;
  const conf = mode.cfg.confidence;
  let points;
  if (mode.log){
    const lo = mode.logMin, hi = Math.max(lo, Number(maxSpend) || 0), n = 80;
    points = [];
    for (let i = 0; i <= n; i++){
      const s = lo * Math.pow(hi / lo, i / n);
      points.push(confidenceCurvePoints(mode.target, s, s, conf)[0]);
    }
  } else {
    points = confidenceCurvePoints(mode.target, 0, maxSpend, conf, { steps: 80 });
  }
  return { key: mode.key, which: mode.which, target: mode.target, log: mode.log, points };
}
function renderConfidenceLinesNote(mode){
  const el = document.getElementById('prod-conf-lines-note');
  if (!el) return;
  if (!mode) el.textContent = '';
  else if (!mode.key) el.textContent = 'Pick a product and campaign type to see the lines';
  else if (!(mode.target > 0)) el.textContent = 'Not enough data for a baseline, so no lines';
  else el.textContent = '';
}
/* Draws the selected line from confidenceCurveState after the points, so the
 * ad search filter (which only touches the point datasets) never removes it. */
function confidenceLinesPlugin(){
  return { id: 'confidence-lines', afterDraw(chart){
    const st = confidenceCurveState;
    if (!st || !st.points || !st.points.length) return;
    const ctx2 = chart.ctx, xA = chart.scales.x, yA = chart.scales.y, area = chart.chartArea;
    const color = st.which === 'kill' ? CHART_NEGATIVE : CHART_PRIMARY;
    ctx2.save();
    if (area){ ctx2.beginPath(); ctx2.rect(area.left, area.top, area.right - area.left, area.bottom - area.top); ctx2.clip(); }
    ctx2.strokeStyle = color; ctx2.lineWidth = 2; ctx2.beginPath();
    let pen = false, last = null;
    st.points.forEach(p => {
      const v = p[st.which];
      if (v == null || !(p.spend > 0)){ pen = false; return; }
      const x = xA.getPixelForValue(p.spend), y = yA.getPixelForValue(v);
      if (pen) ctx2.lineTo(x, y); else ctx2.moveTo(x, y);
      pen = true; last = { x, y };
    });
    ctx2.stroke();
    if (last){ ctx2.fillStyle = color; ctx2.font = '10px Archivo, sans-serif'; ctx2.fillText(st.which === 'kill' ? 'Cut line' : 'Scale line', last.x - 52, last.y - 6); }
    ctx2.restore();
  } };
}

function _confTargetField(id, label, value, conv){
  if (value == null) return `<div class="tc-field"><label>${label}</label><span class="tc-note">Not enough data for a baseline (${fmtNum(conv)} conversions, needs ${CONFIDENCE_MIN_CONVERSIONS}).</span></div>`;
  return `<div class="tc-field"><label for="${id}">${label}</label><input type="number" id="${id}" min="0" step="any" value="${Math.round(value * 100) / 100}" /></div>`;
}

/* Fill the baseline panel for the selected Product x Campaign type and wire the
 * target inputs. Edits are session-only and re-grade the page. */
function renderConfidenceBaselinePanel(rows){
  const cfg = confidenceLinesConfig();
  const body = document.getElementById('prod-baseline-body');
  if (!cfg || !body) return;
  const unmatched = document.getElementById('prod-baseline-unmatched');
  const verdicts = document.getElementById('prod-baseline-verdicts');
  const resetBtn = document.getElementById('cl-reset');
  const uSpend = confidenceUnmatchedSpend();
  if (unmatched) unmatched.innerHTML = uSpend > 0
    ? `<div class="tc-note" id="cl-unmatched-flag">${fmt$(uSpend)} of spend in this window is on campaigns whose names match no campaign type. Pick "Unmatched (check naming)" in Campaign type to see them, then fix the names or the mapping.</div>`
    : '';
  const key = confidenceSelectedKey();
  const t = key ? getConfidenceTargets(key) : null;
  if (!key){
    body.innerHTML = '<span class="tc-note">Pick a product and campaign type to see its baseline.</span>';
    if (verdicts) verdicts.innerHTML = '';
    if (resetBtn) resetBtn.style.display = 'none';
    return;
  }
  if (!t || (t.kill == null && t.scale == null)){
    body.innerHTML = '<span class="tc-note" id="cl-not-enough">Not enough data for a baseline</span>';
    if (verdicts) verdicts.innerHTML = '';
    if (resetBtn) resetBtn.style.display = 'none';
    return;
  }
  body.innerHTML = `<div class="tc-grid">${_confTargetField('cl-target-kill', cfg.killLabel, t.kill, t.killConv)}${_confTargetField('cl-target-scale', cfg.scaleLabel, t.scale, t.scaleConv)}</div>`;
  if (resetBtn) resetBtn.style.display = '';
  [['cl-target-kill', 'kill'], ['cl-target-scale', 'scale']].forEach(([id, which]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (setConfidenceTarget(key, which, el.value)) loadProduction();
      else { const cur = getConfidenceTargets(key); el.value = cur && cur[which] != null ? Math.round(cur[which] * 100) / 100 : ''; }
    });
  });
  if (verdicts){
    const c = confidenceVerdictCounts(rows);
    verdicts.innerHTML = `<span class="tc-note" id="cl-verdict-counts">At these targets: <strong>${c.Scale}</strong> Scale, <strong>${c.Testing}</strong> Testing, <strong>${c.Cut}</strong> Cut${t.edited ? ' (edited for this session)' : ''}.</span>`;
  }
}

/* ── Ad Power Law ── */

async function loadPowerLaw(){
  const plSQL = `
    WITH ad_spend AS (
      SELECT ad_id, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adset_name) AS adset_name, ANY_VALUE(ad_name) AS ad_name,
        MIN(min_date) AS launch_date, MAX(max_date) AS last_spend_date, ANY_VALUE(creative_link) AS preview_link,
        ROUND(SUM(spend),2) AS period_spend, ROUND(${lifetimeMetricSQL('SUM(spend)', `SUM(${CONV_EXPR})`)},2) AS lifetime_cpa
      FROM \`${PROJECT}.${DATASET}.${TABLE}\` WHERE date_start >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)${scopeWhere()} GROUP BY 1 ),
    total AS (SELECT SUM(period_spend) AS grand_total FROM ad_spend)
    SELECT ROW_NUMBER() OVER (ORDER BY a.period_spend DESC) AS rank_num, a.ad_id, a.campaign_name, a.adset_name, a.ad_name, a.launch_date, a.last_spend_date, a.preview_link,
      a.period_spend AS spend, ROUND(a.period_spend/t.grand_total*100,2) AS spend_pct,
      ROUND(SUM(a.period_spend/t.grand_total*100) OVER (ORDER BY a.period_spend DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),2) AS rolling_pct, a.lifetime_cpa
    FROM ad_spend a, total t ORDER BY a.period_spend DESC`;
  try {
    const data=await runQuery(plSQL);
    const labels=data.map(r=>`#${r.rank_num}`), pcts=data.map(r=>Number(r.spend_pct)), rolling=data.map(r=>Number(r.rolling_pct));
    hideEl('powerlaw-chart-loading'); showEl('powerlaw-chart-wrapper');
    if(powerLawChart) powerLawChart.destroy();
    powerLawChart=new Chart(document.getElementById('powerlaw-chart'),{ type:'bar', data:{ labels, datasets:[
      {type:'bar',label:'% of Spend',data:pcts,backgroundColor:getCSS('--young-blood')+'99',borderColor:getCSS('--young-blood'),borderWidth:1,yAxisID:'y'},
      {type:'line',label:'% Rolling Cumulative',data:rolling,borderColor:CHART_PRIMARY,backgroundColor:'transparent',borderWidth:2.5,pointRadius:3,yAxisID:'y2',tension:0.2} ] },
      options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{ticks:{font:{size:10}}}, y:{title:{display:true,text:'% of Spend',font:{size:10}},ticks:{callback:v=>v+'%'}}, y2:{position:'right',min:0,max:100,title:{display:true,text:'Cumulative %',font:{size:10}},ticks:{callback:v=>v+'%',font:{size:10}},grid:{drawOnChartArea:false}} }, plugins:{ legend:{position:'top',labels:{font:{size:11}}} } } });
    followAdSearch('powerlaw', powerLawChart, data.map(r=>adSearchKey(r.ad_name, r.campaign_name, r.adset_name)));
    renderPagedTable('powerlaw-table-body', data.map(r=>`<tr ${adNameAttr(r.ad_name, r.campaign_name, r.adset_name)}><td class="rank-num">${r.rank_num}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmtDate(r.last_spend_date)}</td><td>${r.preview_link?`<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.preview_link}" target="_blank">Preview</a>`:'–'}</td><td>${fmt$(r.spend)}</td><td>${fmtPct(r.spend_pct,2)}</td><td>${fmtPct(r.rolling_pct,2)}</td><td>${r.lifetime_cpa&&Number(r.lifetime_cpa)>0?fmtMetricCell(r.lifetime_cpa):'–'}</td></tr>`));
    hideEl('powerlaw-table-loading'); showEl('powerlaw-table');
  } catch(err){ console.error('Power law error:',err); }
}


/* ── Creative Effectiveness ──
 * Attention metrics beyond CPA: hold rate (15s ÷ impr), completion (100% ÷ impr),
 * the 25→100% retention curve, plus CTR and outbound CTR. Per-ad rates feed the
 * table and the hover preview; the chart shows the impression-weighted average
 * curve across all video ads in the last 90 days. Static-image ads (no
 * video plays) are excluded, since every attention metric is zero for them. */
async function loadCreativeEffectiveness(){
  /* Additive Creative Score (US-002): the inner query gains the score's efficiency
     inputs (lifetime spend + the metric column via the SAME lifetimeMetricSQL the
     Production tab uses) and active_days, then the outer SELECT computes
     creative_score with the SAME metaScoreOpts as Production. Every original
     column and the impressions>0 filter are unchanged, so existing rows/rates are
     untouched and the same ad shows the same score as the Production tab. */
  const sql = `
    SELECT *, ${creativeScoreSQL('lifetime_spend', lifetimeMetricCol(), metaScoreOpts())} AS creative_score FROM (
      SELECT ad_id, ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(creative_link) AS creative_link,
        ROUND(SUM(spend),2) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
        SUM(video_plays) AS video_plays, SUM(video_15s) AS video_15s,
        SUM(video_p25) AS video_p25, SUM(video_p50) AS video_p50, SUM(video_p75) AS video_p75, SUM(video_p100) AS video_p100,
        SUM(outbound_clicks) AS outbound_clicks,
        ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
        ROUND(SUM(${CONV_EXPR}), 0) AS total_conversions,
        ROUND(${lifetimeMetricSQL('ANY_VALUE(lifetime_spend)', `SUM(${CONV_EXPR})`)}, 2) AS ${lifetimeMetricCol()},
        DATE_DIFF(COALESCE(MAX(max_date), CURRENT_DATE()), MIN(min_date), DAY) AS active_days
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`
      WHERE date_start >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)${scopeWhere()}
      GROUP BY 1
    ) WHERE impressions > 0 AND video_plays > 0 ORDER BY spend DESC`;
  try {
    const data = await runQuery(sql);
    const rows = data.map(r=>{
      const ce = { impressions:Number(r.impressions)||0, clicks:Number(r.clicks)||0, video_15s:Number(r.video_15s)||0, video_p25:Number(r.video_p25)||0, video_p50:Number(r.video_p50)||0, video_p75:Number(r.video_p75)||0, video_p100:Number(r.video_p100)||0, video_plays:Number(r.video_plays)||0, outbound_clicks:Number(r.outbound_clicks)||0 };
      const cr = creativeRates(ce);
      registerAdMetrics(r.ad_id, ce, undefined, creativeScoreHover(r.creative_score, { spend:r.lifetime_spend, metric:r[lifetimeMetricCol()], hook:cr.hook, hold:cr.hold, ctr:cr.ctr, completion:cr.completion, hasVideo:cr.hasVideo, activeDays:r.active_days }, metaScoreOpts()));
      const pct = (v) => v!=null ? fmtPct(v,2) : '–';
      const pv = r.creative_link ? `<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.creative_link}" target="_blank">Preview</a>` : '–';
      return `<tr ${adNameAttr(r.ad_name, r.campaign_name)}><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name||''}">${r.ad_name||'–'}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name||''}">${r.campaign_name||'–'}</td><td class="num">${fmt$(r.spend)}</td><td class="num">${fmtNum(ce.impressions)}</td><td class="num">${pct(cr.hold)}</td><td class="num">${pct(cr.completion)}</td><td class="num">${pct(cr.retention.p25)}</td><td class="num">${pct(cr.retention.p50)}</td><td class="num">${pct(cr.retention.p75)}</td><td class="num">${pct(cr.retention.p100)}</td><td class="num">${pct(cr.ctr)}</td><td class="num">${pct(cr.outboundCtr)}</td><td>${pv}</td><td>${creativeScoreBadge(r.creative_score)}</td></tr>`;
    });
    renderPagedTable('creative-table-body', rows);
    hideEl('creative-table-loading'); showEl('creative-table');
    /* The curve is summed here from the rows already loaded, so it follows the
       ad search with no re-query: onAdSearch redraws it from the matching ads. */
    const drawCurve = () => {
      let tImpr=0,t25=0,t50=0,t75=0,t100=0;
      adSearchFilter(data, r=>adSearchKey(r.ad_name, r.campaign_name)).forEach(r=>{
        tImpr+=Number(r.impressions)||0; t25+=Number(r.video_p25)||0; t50+=Number(r.video_p50)||0; t75+=Number(r.video_p75)||0; t100+=Number(r.video_p100)||0;
      });
      const curve = [ t25, t50, t75, t100 ].map(v => tImpr>0 ? +(v/tImpr*100).toFixed(2) : 0);
      hideEl('creative-chart-loading'); showEl('creative-chart-wrapper');
      if(creativeChart) creativeChart.destroy();
      creativeChart = new Chart(document.getElementById('creative-chart'), { type:'line',
        data:{ labels:['25%','50%','75%','100%'], datasets:[{ label:'% of impressions reaching', data:curve, borderColor:CHART_PRIMARY, backgroundColor:CHART_PRIMARY+'21', borderWidth:2.5, pointRadius:4, fill:true, tension:0.25 }] },
        options:{ responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>`${ctx.label} watched: ${ctx.raw}% of impressions` } } },
          scales:{ x:{ title:{display:true,text:'Video quartile watched',font:{size:11}} }, y:{ title:{display:true,text:'% of impressions',font:{size:11}}, ticks:{callback:v=>v+'%'} } } } });
    };
    drawCurve();
    onAdSearch('creative-curve', drawCurve);
  } catch(err){ console.error('Creative effectiveness error:',err); const el=document.getElementById('creative-table-loading'); if(el) el.innerHTML='Error loading data: '+err.message; }
}
