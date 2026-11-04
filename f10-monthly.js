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
  if(tab === 'scalecut')   loadScaleCut();
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
  fillProductionInputs();
  refreshProductionThresholdCopy();
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
        SUM(video_p100) AS video_p100, SUM(video_plays) AS video_plays, SUM(outbound_clicks) AS outbound_clicks${thresholdGroupSelect()}
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scopeWhere('WHERE')} GROUP BY 1
    )
    SELECT *,
      ${classificationCaseSQL('lifetime_spend', lifetimeMetricCol())} AS classification,
      ${creativeScoreSQL('lifetime_spend', lifetimeMetricCol(), metaScoreOpts())} AS creative_score
    FROM per_ad ORDER BY lifetime_spend DESC`;
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
    scatterData.forEach(r=>{ const mVal=Number(r[mCol])||0, spend=Number(r.lifetime_spend)||0; if(mVal>0||spend>0){ const cls=r.classification; if(!byClass[cls]){ byClass[cls]=[]; unknownTiers.add(cls); } byClass[cls].push({x:spend,y:mVal,label:r.ad_name,_key:adSearchKey(r.ad_name, r.campaign_name, r.adset_name)}); } });
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
    const maxY=Math.ceil(Math.max(...scatterData.filter(r=>Number(r[mCol])>0).map(r=>Number(r[mCol])||0),yFloor)*1.2);
    scatterChart=new Chart(document.getElementById('scatter-chart'),{ type:'scatter', data:{ datasets:scatterDatasets },
      options:{ responsive:true, maintainAspectRatio:false,
        scales:{ x:{ title:{display:true,text:'Lifetime Spend ($)',font:{size:11}}, min:0, max:maxSpend, ticks:{callback:v=>fmt$(v)} }, y:{ title:{display:true,text:`Lifetime ${targetMetricDef().label} (${isRoas?'x':'$'})`,font:{size:11}}, min:0, max:maxY, ticks:{callback:v=>fmtMetricCell(v)} } },
        plugins:{ legend:{position:'top',labels:{font:{size:11}}}, tooltip:{callbacks:{label:ctx=>{ const pt=ctx.raw; const mLine=isRoas?`${targetMetricDef().label}: ${fmtMetricCell(pt.y)}`:`CPA: ${pt.y>0?fmt$(pt.y):'N/A'}`; return [`${ctx.dataset.label}`,`Spend: ${fmt$(pt.x)}`,mLine]; }}} } },
      plugins:[{ id:'threshold-lines', afterDraw(chart){ const ctx2=chart.ctx,xAxis=chart.scales.x,yAxis=chart.scales.y;
        const xHit=xAxis.getPixelForValue(guideHitSpend); if(xHit>=xAxis.left&&xHit<=xAxis.right){ ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle=CHART_SECONDARY; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xHit,yAxis.top); ctx2.lineTo(xHit,yAxis.bottom); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle=CHART_SECONDARY; ctx2.font='10px Archivo, sans-serif'; ctx2.fillText('Ad Hit ('+fmt$(guideHitSpend)+')',xHit+4,yAxis.top+14); ctx2.restore(); }
        const yThresh=guideYThresh; const yLine=yAxis.getPixelForValue(yThresh); if(yLine>=yAxis.top&&yLine<=yAxis.bottom){ ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle='#727272'; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xAxis.left,yLine); ctx2.lineTo(xAxis.right,yLine); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle='#727272'; ctx2.font='10px Archivo, sans-serif'; ctx2.fillText((isRoas?'ROAS Target (':'CPA Limit (')+fmtMetricCell(yThresh)+')',xAxis.left+4,yLine-4); ctx2.restore(); } } }] });
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
      return `<tr ${adNameAttr(r.ad_name, r.campaign_name, r.adset_name)}><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmt$(r.lifetime_spend)}</td><td>${r[mCol]&&Number(r[mCol])>0?fmtMetricCell(r[mCol]):'–'}</td><td>${fmtNum(r.total_conversions)}</td><td class="num">${cr.hold!=null?fmtPct(cr.hold,2):'–'}</td><td class="num">${cr.completion!=null?fmtPct(cr.completion,2):'–'}</td><td class="num">${cr.outboundCtr!=null?fmtPct(cr.outboundCtr,2):'–'}</td><td>${r.creative_link?`<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.creative_link}" target="_blank">Preview</a>`:'–'}</td><td><span class="badge ${badgeClass}">${cls}</span></td><td>${creativeScoreBadge(r.creative_score)}</td></tr>`; }));
    hideEl('scatter-table-loading'); showEl('scatter-table');
  } catch(err){ console.error('Production error:',err); }
}

/* ── Scale & Cut tab (confidence-lines US-002, US-003, US-007, reworked in US-008) ──
 * Everything below is inert unless CONFIDENCE_LINES is configured: the layout
 * has no #tab-scalecut, the nav has no Scale & Cut link and loadMonthlyTab()
 * never calls loadScaleCut(). Ad Production does not call in here at all. */
let confidenceControlsWired = false;
let confidenceSegmentsLoaded = false;
let _confidenceBaselinePromise = null;
let _confidenceBaselinePromiseEnd = null;

/* Populate the Campaign type dropdown once and wire its change, the Reset to
 * baseline button and the y axis toggle. Campaign type only scopes this tab. */
function ensureConfidenceControls(){
  if (confidenceControlsWired || !confidenceLinesEnabled()) return;
  const sel = document.getElementById('ctrl-segment');
  const reset = document.getElementById('cl-reset');
  if (!sel || !reset) return;
  confidenceControlsWired = true;
  sel.addEventListener('change', () => {
    setSegmentSelection(sel.value);
    if (window.F10A) F10A.track('filter_changed', { filter: 'campaign_type', value: sel.value });
    delete loadedTabs.scalecut;
    if (activeTab === 'scalecut') loadMonthlyTab('scalecut');
  });
  reset.addEventListener('click', () => {
    resetConfidenceTargets(confidenceSelectedKey());
    loadScaleCut();
  });
  [['sc-judge-kill', 'kill'], ['sc-judge-scale', 'scale']].forEach(([id, v]) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => { setScaleCutJudge(v); loadScaleCut(); });
  });
  const preset = document.getElementById('sc-launch-preset');
  if (preset) preset.addEventListener('change', () => {
    applyScaleCutPreset(preset.value);
    if (window.F10A) F10A.track('filter_changed', { filter: 'launch_range', value: preset.value });
    loadScaleCut();
  });
  ['sc-launch-from', 'sc-launch-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      scaleCutRangeTouched = true;
      if (window.F10A) F10A.track('filter_changed', { filter: 'launch_range', value: el.value });
      loadScaleCut();
    });
  });
  [['sc-look-paused-testing', 'pausedTesting'], ['sc-look-live-cut', 'liveCut']].forEach(([id, v]) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => { toggleScaleCutLook(v); loadScaleCut(); });
  });
  const playBtn = document.getElementById('sc-play');
  if (playBtn) playBtn.addEventListener('click', () => { if (scaleCutPlay.timer != null) stopScaleCutPlay(); else startScaleCutPlay(); });
  const slider = document.getElementById('sc-play-date');
  if (slider) slider.addEventListener('input', () => { stopScaleCutPlay(); renderScaleCutFrame(Number(slider.value)); });
  const trails = document.getElementById('sc-trails');
  if (trails) trails.addEventListener('change', () => { if (scaleCutPlay.frames.length) renderScaleCutFrame(scaleCutPlay.index); });
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

/* Count rows by their SQL verdict column. */
function confidenceVerdictCounts(rows){
  const out = { Scale: 0, Testing: 0, Cut: 0, ungraded: 0 };
  (rows || []).forEach(r => {
    const v = _confStr(r.verdict);
    if (v && out[v] !== undefined) out[v]++; else out.ungraded++;
  });
  return out;
}

/* ── Verdict (computed once, in SQL) ──
 * A per_ad_conf CTE attaches each ad's own group x segment kill and scale
 * targets (session edits included) and confidenceVerdictSQL grades it. The
 * table, the counts and both charts read that column; nothing here recomputes
 * a verdict. */
let confidenceYMode = 'kill';
let confidenceCurveState = null;
const CONFIDENCE_VERDICT_BADGE = { Scale: 'badge-scale', Testing: 'badge-testing', Cut: 'badge-cut' };
const CONFIDENCE_COLORS = {
  scale: '#2f9e44', testing: '#9e9e9e', cut: CHART_NEGATIVE, none: '#d6d6d6',
  efficient: '#2f9e44', reach: '#f08c00', precision: CHART_SECONDARY,
};
const CONFIDENCE_VERDICT_COLOR = { Scale: CONFIDENCE_COLORS.scale, Testing: CONFIDENCE_COLORS.testing, Cut: CONFIDENCE_COLORS.cut, 'No baseline': CONFIDENCE_COLORS.none };

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
/* ── Launch date range ──
 * Launch date is an ad's first day with spend. The range picks which ads the
 * tab shows (both charts, the table, the counts and the flow table); spend,
 * results and verdicts stay counted from each ad's launch. The default is the
 * 90 days to the window end. Dates the user typed are kept until reload. */
let scaleCutRangeTouched = false;
const SCALE_CUT_DEFAULT_RANGE_DAYS = 90;
/* Launched preset: '30' | '60' | '90' (default) | 'custom'. Custom shows the
 * two date inputs and reads them; a preset counts back from the window end. */
let scaleCutPreset = String(SCALE_CUT_DEFAULT_RANGE_DAYS);
function applyScaleCutPreset(v){
  scaleCutPreset = ['30', '60', '90', 'custom'].includes(String(v)) ? String(v) : String(SCALE_CUT_DEFAULT_RANGE_DAYS);
  scaleCutRangeTouched = scaleCutPreset === 'custom';
  ['sc-launch-custom', 'sc-launch-custom-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = scaleCutPreset !== 'custom';
  });
}
/* Judge on: 'kill' (Plans) or 'scale' (Subs). Drives both charts and the table. */
function setScaleCutJudge(v){
  confidenceYMode = v === 'scale' ? 'scale' : 'kill';
  [['sc-judge-kill', 'kill'], ['sc-judge-scale', 'scale']].forEach(([id, v]) => {
    const b = document.getElementById(id);
    if (!b) return;
    const on = v === confidenceYMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
/* Needs a look: null, 'pausedTesting' or 'liveCut'. Clicking a count rings
 * those ads on both charts and filters the table; clicking again clears it. */
let scaleCutLook = null;
function toggleScaleCutLook(which){
  scaleCutLook = (which && which === scaleCutLook) ? null : (SCALE_CUT_MISMATCH[which] ? which : null);
  [['sc-look-paused-testing', 'pausedTesting'], ['sc-look-live-cut', 'liveCut']].forEach(([id, v]) => {
    const b = document.getElementById(id);
    if (!b) return;
    const on = v === scaleCutLook;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function scaleCutLookFlag(live, verdict){
  if (!scaleCutLook) return null;
  const m = scaleCutMismatch(live, verdict);
  return m && m === SCALE_CUT_MISMATCH[scaleCutLook] ? m : null;
}
function scaleCutLookRows(rows){
  if (!scaleCutLook) return rows;
  return (rows || []).filter(r => scaleCutLookFlag(confidenceIsLive(r), _confStr(r.verdict)));
}
function _isoDate(v){ return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; }
function _isoAddDays(iso, n){
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function scaleCutLaunchRange(){
  const fEl = document.getElementById('sc-launch-from'), tEl = document.getElementById('sc-launch-to');
  const end = _isoDate(confidenceWindowEnd());
  let from = scaleCutRangeTouched && fEl ? _isoDate(fEl.value) : null;
  let to = scaleCutRangeTouched && tEl ? _isoDate(tEl.value) : null;
  if (!to) to = end;
  if (!to) return null;
  const days = scaleCutPreset === 'custom' ? SCALE_CUT_DEFAULT_RANGE_DAYS : Number(scaleCutPreset) || SCALE_CUT_DEFAULT_RANGE_DAYS;
  if (!from) from = _isoAddDays(to, -days);
  if (from > to){ const x = from; from = to; to = x; }
  if (fEl) fEl.value = from;
  if (tEl) tEl.value = to;
  return { from, to };
}
function _launchHaving(range){
  return range ? `
      HAVING MIN(IF(spend > 0, date_start, NULL)) BETWEEN DATE ${sqlQuote(range.from)} AND DATE ${sqlQuote(range.to)}` : '';
}
/* Columns every per-ad query shares: names, lifetime spend, launch date and the
 * latest delivery status (is_active on the newest row, which can lag Meta by
 * up to a day). */
function _scaleCutAdCols(){
  return `ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adset_name) AS adset_name,
        ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend, MIN(IF(spend > 0, date_start, NULL)) AS launch_date,
        ARRAY_AGG(is_active IGNORE NULLS ORDER BY date_start DESC LIMIT 1)[SAFE_OFFSET(0)] AS is_live`;
}
/* The per-ad query for the tab: one row per ad in scope (Product, Campaign
 * type, status) launched in the range, with its SQL verdict. */
function scaleCutSQL(range){
  if (!confidenceLinesConfig()) return null;
  return `WITH per_ad AS (
      SELECT ad_id, ${_scaleCutAdCols()} ${confidenceAdSelect()}
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scaleCutScopeWhere('WHERE')}
      GROUP BY 1${_launchHaving(range)}
    )${confidenceScatterCTE()}
    SELECT * ${confidenceVerdictSelect()} FROM per_ad_conf ORDER BY lifetime_spend DESC`;
}

/* ── Daily history (maturity playback and the new ad flow) ──
 * One row per ad per day with spend or results: running spend and results
 * from launch, and the verdict as of that day from confidenceVerdictSQL over
 * those running sums, against the same targets as the lifetime view. cap keeps
 * the playback to the top ads by lifetime spend. */
const SCALE_CUT_PLAY_CAP = 600;
function scaleCutDailyCTE(range, cap){
  const cfg = confidenceLinesConfig();
  if (!cfg) return null;
  return `WITH sc_ads AS (
      SELECT ad_id, ${_scaleCutAdCols()} ${confidenceAdSelect()}
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scaleCutScopeWhere('WHERE')}
      GROUP BY 1${_launchHaving(range)}${cap ? `
      ORDER BY lifetime_spend DESC LIMIT ${Math.floor(cap)}` : ''}
    ),
    sc_day AS (
      SELECT ad_id, date_start, SUM(spend) AS d_spend, SUM(${cfg.killConvExpr}) AS d_kill, SUM(${cfg.scaleConvExpr}) AS d_scale
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`
      WHERE ad_id IN (SELECT ad_id FROM sc_ads)${scaleCutScopeWhere('AND')}
      GROUP BY 1, 2
    ),
    sc_cum AS (
      SELECT ad_id, date_start, d_spend, d_kill, d_scale,
        SUM(d_spend) OVER w AS cum_spend, SUM(d_kill) OVER w AS cum_kill, SUM(d_scale) OVER w AS cum_scale
      FROM sc_day
      WINDOW w AS (PARTITION BY ad_id ORDER BY date_start ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ),
    sc_targets AS (
      SELECT c.*, a.launch_date, a.conf_group, a.conf_segment FROM sc_cum c JOIN sc_ads a USING (ad_id)
    ),
    sc_graded AS (
      SELECT *, IF(kill_target IS NULL AND scale_target IS NULL, CAST(NULL AS STRING), ${confidenceVerdictSQL('cum_spend', 'cum_kill', 'kill_target', { conf: cfg.confidence, scaleConvCol: 'cum_scale', scaleTargetCol: 'scale_target' })}) AS day_verdict
      FROM (SELECT *, ${confidenceTargetCaseSQL('kill')} AS kill_target, ${confidenceTargetCaseSQL('scale')} AS scale_target FROM sc_targets)
    )`;
}
function scaleCutPlaybackSQL(range){
  const cte = scaleCutDailyCTE(range, SCALE_CUT_PLAY_CAP);
  if (!cte) return null;
  return `${cte}
    SELECT CAST(ad_id AS STRING) AS ad_id, CAST(date_start AS STRING) AS day, cum_spend, cum_kill, cum_scale, day_verdict
    FROM sc_graded
    WHERE (d_spend > 0 OR d_kill > 0 OR d_scale > 0)${range ? ` AND date_start >= DATE ${sqlQuote(range.from)}` : ''}
    ORDER BY ad_id, date_start`;
}
/* First day each ad reached Scale or Cut, how many days after launch, and its
 * running spend that day. Every ad in the range, no cap. */
function scaleCutFlowSQL(range){
  const cte = scaleCutDailyCTE(range, null);
  if (!cte) return null;
  return `${cte}
    SELECT CAST(ad_id AS STRING) AS ad_id,
      CAST(MIN(IF(day_verdict IN ('Scale', 'Cut'), date_start, NULL)) AS STRING) AS first_verdict_date,
      DATE_DIFF(MIN(IF(day_verdict IN ('Scale', 'Cut'), date_start, NULL)), ANY_VALUE(launch_date), DAY) AS days_to_verdict,
      ARRAY_AGG(IF(day_verdict IN ('Scale', 'Cut'), cum_spend, NULL) IGNORE NULLS ORDER BY date_start LIMIT 1)[SAFE_OFFSET(0)] AS spend_to_verdict
    FROM sc_graded
    GROUP BY 1`;
}

/* Chart mode for the selected cell: which cost per conversion the y axis
 * shows and the target the lines are drawn from. Spend is always on a log axis. */
function confidenceScatterMode(rows){
  const cfg = confidenceLinesConfig();
  if (!cfg) return null;
  const which = confidenceYMode === 'scale' ? 'scale' : 'kill';
  const key = confidenceSelectedKey();
  const t = key ? getConfidenceTargets(key) : null;
  const minPos = Math.min(Infinity, ...(rows || []).map(r => Number(_confStr(r.lifetime_spend)) || 0).filter(v => v > 0));
  const logMin = isFinite(minPos) ? Math.min(100, Math.max(1, Math.pow(10, Math.floor(Math.log10(minPos))))) : 100;
  return {
    cfg, which, key, log: true,
    target: t ? t[which] : null,
    label: which === 'scale' ? cfg.scaleLabel : cfg.killLabel,
    convCol: which === 'scale' ? 'scale_conv' : 'kill_conv',
    logMin,
  };
}
/* Top of the cost per conversion axis: about 4x target, or 4x the median cost
 * per conversion when no target applies. Outliers clamp to this edge. */
function confidenceYMax(target, cpas){
  if (target > 0) return Math.ceil(target * 4);
  const med = confidenceMedian(cpas || []);
  return med ? Math.ceil(med * 4) : 100;
}
function confidenceLogMax(maxSpend){
  const top = Math.pow(10, Math.ceil(Math.log10(Math.max(1, Number(maxSpend) || 0))));
  return Math.max(100000, top);
}
function confidenceLogTicks(min, max){
  const out = [];
  for (let v = min; v <= max * 1.0001; v *= 10) out.push(v);
  return out;
}
function confidenceShortMoney(v){
  if (v >= 1e6) return '$' + (v / 1e6) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3) + 'k';
  return '$' + v;
}

/* The Scale and Cut curves for one target. Each curve passes through the
 * points where an ad with K conversions changes verdict: it is Cut once spend
 * passes target x the kill bound for K, and Scaled while spend stays under
 * target x the scale bound for K. Cost per conversion at that spend is
 * spend / K. The Cut curve falls towards the target as spend grows and the
 * Scale curve rises towards it. */
function confidenceCurveFor(mode, maxSpend){
  if (!mode || !mode.key || !(mode.target > 0)) return null;
  const conf = mode.cfg.confidence, tg = mode.target;
  const hi = Math.max(mode.logMin, Number(maxSpend) || 0) * 1.5;
  const cut = [], scale = [];
  for (let k = 1; k <= 5000; k++){
    const b = confidenceBounds(k, conf);
    const sk = tg * b.kill, ss = tg * b.scale;
    if (sk <= hi * 10) cut.push({ spend: sk, cpa: sk / k, conv: k });
    if (ss <= hi * 10) scale.push({ spend: ss, cpa: ss / k, conv: k });
    if (sk > hi * 10 && ss > hi * 10) break;
  }
  return { key: mode.key, which: mode.which, target: tg, conf, cut, scale };
}
function renderConfidenceLinesNote(mode){
  const el = document.getElementById('sc-lines-note');
  if (!el) return;
  if (!mode) { el.textContent = ''; return; }
  if (!mode.key) { el.textContent = 'Pick a product and campaign type to see the lines'; return; }
  if (!(mode.target > 0)) { el.textContent = 'Not enough data for a baseline, so no lines'; return; }
  const cfg = mode.cfg;
  if (cfg.killConvExpr !== cfg.scaleConvExpr){
    /* Same noun as the Judge on buttons: 'Cost per subscription' reads Subscriptions. */
    const noun = l => { const n = String(l || '').replace(/^cost per /i, '').trim() || 'conversion'; return n.charAt(0).toUpperCase() + n.slice(1) + 's'; };
    el.textContent = mode.which === 'kill'
      ? `Cut line is exact. Switch Judge on to ${noun(cfg.scaleLabel)} to see the exact Scale line.`
      : `Scale line is exact. Switch Judge on to ${noun(cfg.killLabel)} to see the exact Cut line.`;
  } else el.textContent = '';
}

/* Draws the shading, both curves, the target line and the labels from
 * confidenceCurveState before the dots, so the dots sit on top and the ad
 * search filter (which only touches the dot datasets) never removes them. */
function confidenceLinesPlugin(){
  return { id: 'confidence-lines', beforeDatasetsDraw(chart){
    const st = confidenceCurveState;
    if (!st) return;
    const g = chart.ctx, xA = chart.scales.x, yA = chart.scales.y, a = chart.chartArea;
    if (!a) return;
    const px = p => ({ x: xA.getPixelForValue(p.spend), y: Math.max(a.top, yA.getPixelForValue(p.cpa)) });
    const cut = st.cut.map(px), scale = st.scale.map(px);
    const pct = Math.round(st.conf * 100);
    g.save();
    g.beginPath(); g.rect(a.left, a.top, a.right - a.left, a.bottom - a.top); g.clip();
    if (cut.length){
      g.fillStyle = 'rgba(250, 2, 60, 0.08)';
      g.beginPath(); g.moveTo(cut[0].x, a.top);
      cut.forEach(p => g.lineTo(p.x, p.y));
      g.lineTo(a.right + 10, cut[cut.length - 1].y); g.lineTo(a.right + 10, a.top); g.closePath(); g.fill();
      g.strokeStyle = CONFIDENCE_COLORS.cut; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cut[0].x, a.top); cut.forEach(p => g.lineTo(p.x, p.y)); g.lineTo(a.right + 10, cut[cut.length - 1].y); g.stroke();
    }
    if (scale.length){
      g.fillStyle = 'rgba(47, 158, 68, 0.10)';
      g.beginPath(); g.moveTo(scale[0].x, a.bottom);
      scale.forEach(p => g.lineTo(p.x, p.y));
      g.lineTo(a.right + 10, scale[scale.length - 1].y); g.lineTo(a.right + 10, a.bottom); g.closePath(); g.fill();
      g.strokeStyle = CONFIDENCE_COLORS.scale; g.lineWidth = 2;
      g.beginPath(); g.moveTo(scale[0].x, a.bottom); scale.forEach(p => g.lineTo(p.x, p.y)); g.lineTo(a.right + 10, scale[scale.length - 1].y); g.stroke();
    }
    const ty = yA.getPixelForValue(st.target);
    g.setLineDash([5, 4]); g.strokeStyle = '#727272'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(a.left, ty); g.lineTo(a.right, ty); g.stroke(); g.setLineDash([]);
    g.font = '10px Archivo, sans-serif';
    const pill = 'target ' + fmt$(st.target);
    const pw = g.measureText(pill).width + 12;
    g.fillStyle = '#ffffff'; g.strokeStyle = '#727272'; g.lineWidth = 1;
    const pxl = a.right - pw - 6, pyl = ty - 8;
    g.beginPath();
    if (g.roundRect) g.roundRect(pxl, pyl, pw, 16, 8); else g.rect(pxl, pyl, pw, 16);
    g.fill(); g.stroke();
    g.fillStyle = '#4a4a4a'; g.fillText(pill, pxl + 6, pyl + 11);
    g.font = 'bold 11px Archivo, sans-serif'; g.fillStyle = CONFIDENCE_COLORS.cut;
    g.fillText('CUT', a.right - 150, a.top + 14);
    g.font = '10px Archivo, sans-serif'; g.fillText(pct + '% sure it misses target', a.right - 150, a.top + 27);
    g.font = 'bold 11px Archivo, sans-serif'; g.fillStyle = CONFIDENCE_COLORS.scale;
    g.fillText('SCALE', a.right - 150, a.bottom - 22);
    g.font = '10px Archivo, sans-serif'; g.fillText(pct + '% sure it beats target', a.right - 150, a.bottom - 9);
    g.font = 'bold 11px Archivo, sans-serif'; g.fillStyle = '#727272';
    g.fillText('TESTING', a.left + 6, a.top + 14);
    g.font = '10px Archivo, sans-serif'; g.fillText('keep spending', a.left + 6, a.top + 27);
    g.restore();
  } };
}

/* ── Live or paused ──
 * From is_active on the ad's newest row: true live, false paused, null unknown.
 * A mismatch is an ad paused while still Testing, or live while Cut. */
const SCALE_CUT_MISMATCH = { pausedTesting: 'Paused while Testing', liveCut: 'Live in Cut' };
const SCALE_CUT_FLAG_COLOR = '#f08c00';
function confidenceIsLive(r){
  const v = r ? _confStr(r.is_live) : null;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return null;
}
function scaleCutMismatch(live, verdict){
  if (live === false && verdict === 'Testing') return SCALE_CUT_MISMATCH.pausedTesting;
  if (live === true && verdict === 'Cut') return SCALE_CUT_MISMATCH.liveCut;
  return null;
}
function confidenceStatusText(live){ return live === true ? 'Live' : live === false ? 'Paused' : 'Unknown'; }
/* Filled dot for live, hollow for paused, an orange ring on a mismatch. */
function confidenceStatusStyle(fill, border, width){
  return {
    pointBackgroundColor: c => (c.raw && c.raw._live === false) ? '#ffffff' : fill,
    pointBorderColor: c => (c.raw && c.raw._mismatch) ? SCALE_CUT_FLAG_COLOR : border,
    pointBorderWidth: c => (c.raw && c.raw._mismatch) ? 2.5 : (c.raw && c.raw._live === false ? 1.5 : width),
  };
}

/* Build the lines chart model from the SQL rows. Dots are coloured by the SQL
 * verdict, sized gently by spend and clamped to the top edge when their cost
 * per conversion is off the chart or they have no conversions yet. fixed
 * ({ maxY, maxSpend, noMismatch }) holds the axes still during playback. */
function confidenceLinesPoint(r, mode, noMismatch){
  const spend = Number(_confStr(r.lifetime_spend)) || 0;
  const conv = Number(_confStr(r[mode.convCol])) || 0;
  const verdict = _confStr(r.verdict) || 'No baseline';
  const live = confidenceIsLive(r);
  return { x: Math.max(spend, mode.logMin), y: conv > 0 ? spend / conv : null, _cpa: conv > 0 ? spend / conv : null,
    _conv: conv, _spend: spend, label: _confStr(r.ad_name), _verdict: verdict,
    _live: live, _mismatch: noMismatch ? null : scaleCutLookFlag(live, verdict), _trail: r._trail || null,
    _key: adSearchKey(r.ad_name, r.campaign_name, r.adset_name) };
}
function confidenceLinesView(rows, mode, fixed){
  const pts = [];
  (rows || []).forEach(r => {
    const spend = Number(_confStr(r.lifetime_spend)) || 0;
    if (!(spend > 0)) return;
    pts.push(confidenceLinesPoint(r, mode, !!(fixed && fixed.noMismatch)));
  });
  const maxSpend = fixed ? fixed.maxSpend : Math.max(0, ...pts.map(p => p._spend));
  const maxY = fixed ? fixed.maxY : confidenceYMax(mode.target, pts.map(p => p._cpa).filter(v => v != null));
  pts.forEach(p => {
    if (p.y == null || p.y > maxY){ p.y = maxY; p._clamped = true; }
    p._r = 2.5 + 3.5 * Math.sqrt(maxSpend > 0 ? p._spend / maxSpend : 0);
  });
  const groups = { Scale: [], Testing: [], Cut: [], 'No baseline': [] };
  pts.forEach(p => (groups[p._verdict] || groups['No baseline']).push(p));
  const datasets = Object.keys(groups).filter(k => groups[k].length).map(k => ({
    label: k, data: groups[k], backgroundColor: CONFIDENCE_VERDICT_COLOR[k] + 'cc', borderColor: CONFIDENCE_VERDICT_COLOR[k], borderWidth: 1,
    ...confidenceStatusStyle(CONFIDENCE_VERDICT_COLOR[k] + 'cc', CONFIDENCE_VERDICT_COLOR[k], 1),
    pointRadius: c => (c.raw && c.raw._r) || 3, pointHoverRadius: c => ((c.raw && c.raw._r) || 3) + 2 }));
  return { mode, datasets, maxY, minX: mode.logMin, maxX: confidenceLogMax(maxSpend), maxSpend };
}
function confidenceStatusTooltip(pt){
  const out = [`Status: ${confidenceStatusText(pt._live)}`];
  if (pt._mismatch) out.push(pt._mismatch);
  return out;
}
function confidenceLinesTooltip(pt, mode){
  return [pt.label || '', `Spend: ${fmt$(pt._spend)}`, `${confidenceConvNoun(mode.label)}: ${fmtNum(pt._conv)}`,
    pt._cpa == null ? `${mode.label}: no conversions yet` : `${mode.label}: ${fmt$(pt._cpa)}`, `Verdict: ${pt._verdict}`]
    .concat(confidenceStatusTooltip(pt));
}
/* Faint path of each ad's earlier positions, drawn under the dots when Trails
 * is on. Reads the dots on the chart, so the ad search filters trails too. */
function scaleCutTrailsPlugin(){
  return { id: 'scale-cut-trails', beforeDatasetsDraw(chart){
    const a = chart.chartArea;
    if (!a) return;
    const xA = chart.scales.x, yA = chart.scales.y, g = chart.ctx;
    g.save();
    g.beginPath(); g.rect(a.left, a.top, a.right - a.left, a.bottom - a.top); g.clip();
    g.lineWidth = 1;
    chart.data.datasets.forEach(d => (d.data || []).forEach(p => {
      if (!p || !p._trail || p._trail.length < 2 || p._hide || p._searchOut) return;
      g.strokeStyle = (CONFIDENCE_VERDICT_COLOR[p._verdict] || '#999999') + '55';
      g.beginPath();
      p._trail.forEach((t, i) => {
        const x = xA.getPixelForValue(t.x), y = yA.getPixelForValue(t.y);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.stroke();
    }));
    g.restore();
  } };
}
function confidenceLinesChart(view){
  const mode = view.mode;
  return new Chart(document.getElementById('sc-lines-chart'), { type: 'scatter', data: { datasets: view.datasets },
    options: { responsive: true, maintainAspectRatio: false,
      scales: {
        x: { type: 'logarithmic', min: view.minX, max: view.maxX, title: { display: true, text: 'Spend per ad (log)', font: { size: 11 } },
          afterBuildTicks: ax => { ax.ticks = confidenceLogTicks(view.minX, view.maxX).map(v => ({ value: v })); },
          ticks: { callback: v => confidenceShortMoney(v) } },
        y: { min: 0, max: view.maxY, title: { display: true, text: mode.label, font: { size: 11 } }, ticks: { callback: v => fmt$(v) } } },
      transitions: { [SCALE_CUT_PLAY_MODE]: { animation: { duration: 180, easing: 'linear' } } },
      plugins: { legend: { display: false },
        tooltip: { filter: c => !scaleCutDotHidden(c.raw), callbacks: { label: c => confidenceLinesTooltip(c.raw, mode) } } } },
    plugins: [confidenceLinesPlugin(), scaleCutTrailsPlugin()] });
}

/* ── Reach cost chart (confidence-lines US-007, reworked in US-008) ──
 * With CONFIDENCE_LINES.REACH_TABLE set, each ad's Meta-reported cost per
 * 1,000 people reached (CPMr) is read from the ad_window_reach mart in the
 * client's own marts dataset and plotted against the same cost per conversion
 * as the lines chart. Dotted lines at the segment's median CPMr and median cost
 * per conversion split it into four quadrants. The target is drawn as a faint
 * reference line. A Cut ad in Reach play gets a marker: cheap reach may mean it
 * is finding new people that last-click conversions do not credit. Without
 * REACH_TABLE, or with no reach rows, no chart is drawn and no reach query runs. */
let confidenceQuadState = null;
const CONFIDENCE_REACH_WINDOW_LABEL = { last_28d: '28 day', last_90d: '90 day', lifetime: 'lifetime' };
const CONFIDENCE_QUADRANTS = { efficient: 'Efficient growth', reach: 'Reach play', precision: 'Precision', cut: 'Cut candidate' };
const CONFIDENCE_QUADRANT_COLOR = {
  'Efficient growth': CONFIDENCE_COLORS.efficient, 'Reach play': CONFIDENCE_COLORS.reach,
  'Precision': CONFIDENCE_COLORS.precision, 'Cut candidate': CONFIDENCE_COLORS.cut };
const CONFIDENCE_REACH_MARK_LABEL = 'Cut, may be bringing in new people';
const CONFIDENCE_REACH_MARK_NOTE = 'Cut on cost per conversion, but it reaches people cheaply, so it may be bringing in new people. Check before switching it off.';

function confidenceReachEnabled(){ const cfg = confidenceLinesConfig(); return !!(cfg && cfg.reachTable); }
/* Reach is always lifetime, so the x axis (lifetime CPMr) matches the y axis
 * (lifetime cost per conversion). */
const CONFIDENCE_REACH_DEFAULT_WINDOW = 'lifetime';
function confidenceReachWindow(){ return CONFIDENCE_REACH_DEFAULT_WINDOW; }
/* Latest reach row per ad for one window, limited to the ads in this tab's
 * scope. Reads only the client's reach mart and the dashboard's own table. */
function confidenceReachSQL(win){
  const cfg = confidenceLinesConfig();
  if (!cfg || !cfg.reachTable || !CONFIDENCE_REACH_WINDOW_LABEL[win]) return null;
  return `SELECT CAST(ad_id AS STRING) AS ad_id, spend, impressions, reach, cpmr, as_of_date
    FROM \`${PROJECT}.${DATASET}.${cfg.reachTable}\`
    WHERE is_latest AND \`window\` = ${sqlQuote(win)}
      AND CAST(ad_id AS STRING) IN (SELECT DISTINCT CAST(ad_id AS STRING) FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scaleCutScopeWhere('WHERE')})`;
}
function confidenceMedian(vals){
  const v = vals.filter(x => x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
/* Ties count as the low side. An ad with no conversions has no cost per
 * conversion yet, so it reads as the high side. The y split is the median
 * cost per conversion, not the target. */
function confidenceQuadrant(p, medianCpmr, medianCpa){
  const lowX = p.x <= medianCpmr;
  const lowY = !p._noConv && p._cpa != null && p._cpa <= medianCpa;
  if (lowX) return lowY ? CONFIDENCE_QUADRANTS.efficient : CONFIDENCE_QUADRANTS.reach;
  return lowY ? CONFIDENCE_QUADRANTS.precision : CONFIDENCE_QUADRANTS.cut;
}
function _confEsc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* Build the reach chart model from the per-ad rows (which carry the SQL
 * verdict) and the reach rows. Joined in the browser on ad_id. */
function confidenceReachView(rows, reachRows, mode){
  /* Every ad with spend should have a lifetime row, so an ad without one is
   * counted as missing. */
  const byAd = {};
  (reachRows || []).forEach(r => { const id = _confStr(r.ad_id); if (id != null) byAd[String(id)] = r; });
  const pts = [], missing = [];
  let asOf = null;
  (rows || []).forEach(r => {
    const spend = Number(_confStr(r.lifetime_spend)) || 0;
    if (!(spend > 0)) return;
    const key = adSearchKey(r.ad_name, r.campaign_name, r.adset_name);
    const rr = byAd[String(_confStr(r.ad_id))];
    const cpmr = rr ? Number(_confStr(rr.cpmr)) : NaN;
    if (!(cpmr > 0)){ missing.push({ name: r.ad_name, _key: key }); return; }
    const d = _confStr(rr.as_of_date);
    if (d && (!asOf || String(d) > asOf)) asOf = String(d);
    const conv = Number(_confStr(r[mode.convCol])) || 0;
    const verdict = _confStr(r.verdict) || 'No baseline';
    const live = confidenceIsLive(r);
    pts.push({ x: cpmr, y: conv > 0 ? spend / conv : null, _cpa: conv > 0 ? spend / conv : null, _noConv: !(conv > 0),
      label: _confStr(r.ad_name), _key: key, _spend: spend, _reach: Number(_confStr(rr.reach)) || 0,
      _verdict: verdict, _live: live, _mismatch: scaleCutLookFlag(live, verdict),
      _cell: confidenceKey(r.conf_group == null ? '' : _confStr(r.conf_group), _confStr(r.conf_segment)) });
  });
  /* The medians are over the selected cell's ads with reach (every ad with
   * reach when Product or Campaign type is All), before any ad search, so a
   * search never moves the lines. */
  const cellPts = mode.key ? pts.filter(p => p._cell === mode.key) : pts;
  const medianCpmr = confidenceMedian(cellPts.map(p => p.x));
  const medianCpa = confidenceMedian(cellPts.map(p => p._cpa).filter(v => v != null));
  const quad = (medianCpmr != null && medianCpa != null)
    ? { median: medianCpmr, medianCpa, target: mode.target > 0 ? mode.target : null } : null;
  const maxY = confidenceYMax(mode.target, pts.map(p => p._cpa).filter(v => v != null));
  const maxReach = Math.max(0, ...pts.map(p => p._reach));
  const groups = {};
  Object.values(CONFIDENCE_QUADRANTS).forEach(q => { groups[q] = []; });
  const marked = [];
  pts.forEach(p => {
    p._r = 3 + 9 * Math.sqrt(maxReach > 0 ? p._reach / maxReach : 0);
    if (p.y == null || p.y > maxY){ p.y = maxY; p._clamped = true; }
    if (!quad){ groups[CONFIDENCE_QUADRANTS.efficient].push(p); return; }
    p._quadrant = confidenceQuadrant(p, quad.median, quad.medianCpa);
    if (p._verdict === 'Cut' && p._quadrant === CONFIDENCE_QUADRANTS.reach){ p._newPeople = true; marked.push(p); return; }
    groups[p._quadrant].push(p);
  });
  const radius = c => (c.raw && c.raw._r) || 4;
  const datasets = Object.keys(groups).filter(k => groups[k].length).map(k => ({
    label: k, data: groups[k], backgroundColor: CONFIDENCE_QUADRANT_COLOR[k] + '55', borderColor: CONFIDENCE_QUADRANT_COLOR[k], borderWidth: 1.5,
    ...confidenceStatusStyle(CONFIDENCE_QUADRANT_COLOR[k] + '55', CONFIDENCE_QUADRANT_COLOR[k], 1.5),
    pointRadius: radius, pointHoverRadius: c => radius(c) + 2 }));
  if (marked.length) datasets.push({ label: CONFIDENCE_REACH_MARK_LABEL, data: marked, pointStyle: 'triangle',
    backgroundColor: CONFIDENCE_COLORS.cut + '99', borderColor: '#000000', borderWidth: 1.5,
    ...confidenceStatusStyle(CONFIDENCE_COLORS.cut + '99', '#000000', 1.5),
    pointRadius: c => Math.max(7, radius(c)), pointHoverRadius: c => Math.max(7, radius(c)) + 2 });
  const maxX = Math.max(1, Math.ceil(Math.max(0, ...pts.map(p => p.x), quad ? quad.median : 0) * 1.1));
  return { mode, datasets, maxX, maxY, quad, missing, asOf, median: medianCpmr, points: pts };
}

function renderConfidenceReachNotes(view){
  const note = document.getElementById('sc-reach-note');
  const miss = document.getElementById('sc-reach-missing');
  if (!note || !miss) return;
  if (!view){ note.textContent = ''; miss.innerHTML = ''; return; }
  note.textContent = 'Using lifetime reach' + (view.asOf ? ` (as of ${view.asOf})` : '') + '. Cost per conversion is lifetime too.'
    + ' Reach is Meta-reported, so read it as an index.';
  /* One line with a count; the names are in the table. */
  const shown = adSearchFilter(view.missing, m => m._key);
  miss.innerHTML = shown.length
    ? `<span id="sc-reach-missing-count">${shown.length} ${shown.length === 1 ? 'ad has' : 'ads have'} no reach data yet.</span>`
    : '';
}

function confidenceReachTooltip(pt, setLabel, mode){
  const lines = [pt.label || setLabel, `Cost per 1,000 reached: ${fmt$(pt.x)}`, `Reach: ${fmtNum(pt._reach)}`, `Spend: ${fmt$(pt._spend)}`,
    pt._noConv ? 'No conversions yet' : `${mode.label}: ${fmt$(pt._cpa)}`, `Verdict: ${pt._verdict}`].concat(confidenceStatusTooltip(pt));
  if (pt._quadrant) lines.push(`Quadrant: ${pt._quadrant}`);
  if (pt._newPeople) lines.push(CONFIDENCE_REACH_MARK_NOTE);
  return lines;
}

function confidenceReachChart(view){
  confidenceQuadState = view.quad;
  const mode = view.mode;
  return new Chart(document.getElementById('sc-reach-chart'), { type: 'scatter', data: { datasets: view.datasets },
    options: { responsive: true, maintainAspectRatio: false, layout: { padding: { bottom: 12 } },
      scales: {
        x: { title: { display: true, text: 'Cost per 1,000 reached', font: { size: 11 } }, min: 0, max: view.maxX, ticks: { callback: v => fmt$(v) } },
        y: { title: { display: true, text: mode.label, font: { size: 11 } }, min: 0, max: view.maxY, ticks: { callback: v => fmt$(v) } } },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: c => confidenceReachTooltip(c.raw, c.dataset.label, mode) } } } },
    plugins: [confidenceQuadrantPlugin()] });
}

/* Tinted quadrants, dotted median lines with their values, the faint target
 * line and the "cheaper reach" note are drawn from confidenceQuadState before
 * the bubbles, so the ad search never removes them. The corner labels are
 * drawn after the bubbles. */
function confidenceQuadrantPlugin(){
  return { id: 'confidence-quadrants', beforeDatasetsDraw(chart){
    const st = confidenceQuadState;
    const g = chart.ctx, a = chart.chartArea;
    if (!a) return;
    g.save();
    g.font = '10px Archivo, sans-serif'; g.fillStyle = '#727272';
    g.fillText('cheaper reach', a.left, chart.height - 4);
    if (!st){ g.restore(); return; }
    const x = Math.min(a.right, Math.max(a.left, chart.scales.x.getPixelForValue(st.median)));
    const y = Math.min(a.bottom, Math.max(a.top, chart.scales.y.getPixelForValue(st.medianCpa)));
    const tint = (col, x0, y0, x1, y1) => { g.fillStyle = col; g.fillRect(x0, y0, x1 - x0, y1 - y0); };
    tint('rgba(240, 140, 0, 0.07)', a.left, a.top, x, y);
    tint('rgba(250, 2, 60, 0.07)', x, a.top, a.right, y);
    tint('rgba(47, 158, 68, 0.07)', a.left, y, x, a.bottom);
    tint('rgba(74, 144, 226, 0.07)', x, y, a.right, a.bottom);
    if (st.target > 0){
      const ty = chart.scales.y.getPixelForValue(st.target);
      if (ty >= a.top && ty <= a.bottom){
        g.setLineDash([5, 4]); g.strokeStyle = 'rgba(114, 114, 114, 0.45)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(a.left, ty); g.lineTo(a.right, ty); g.stroke(); g.setLineDash([]);
        g.fillStyle = 'rgba(114, 114, 114, 0.8)'; g.fillText('target ' + fmt$(st.target), a.right - 80, ty - 4);
      }
    }
    g.setLineDash([2, 3]); g.strokeStyle = '#727272'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(x, a.top); g.lineTo(x, a.bottom); g.stroke();
    g.beginPath(); g.moveTo(a.left, y); g.lineTo(a.right, y); g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#4a4a4a';
    g.fillText('median ' + fmt$(st.median), x + 4, a.bottom - 6);
    g.fillText('median ' + fmt$(st.medianCpa), a.left + 4, y - 4);
    g.restore();
  },
  /* Corner labels go on top of the bubbles, on a light panel, so a crowded
   * corner never hides them. */
  afterDatasetsDraw(chart){
    const g = chart.ctx, a = chart.chartArea;
    if (!confidenceQuadState || !a) return;
    g.save();
    const corner = (title, sub, col, left, top) => {
      g.font = 'bold 10px Archivo, sans-serif';
      const w = Math.max(g.measureText(title).width, (g.font = '10px Archivo, sans-serif', g.measureText(sub).width));
      const tx = left ? a.left + 6 : a.right - w - 6;
      const ty = top ? a.top + 14 : a.bottom - 34;
      g.fillStyle = 'rgba(255, 255, 255, 0.85)'; g.fillRect(tx - 3, ty - 11, w + 6, 27);
      g.fillStyle = col; g.font = 'bold 10px Archivo, sans-serif'; g.fillText(title, tx, ty);
      g.font = '10px Archivo, sans-serif'; g.fillText(sub, tx, ty + 12);
    };
    corner('REACH PLAY', 'cheap reach, higher CPA', CONFIDENCE_COLORS.reach, true, true);
    corner('CUT CANDIDATE', 'pricey reach, higher CPA', CONFIDENCE_COLORS.cut, false, true);
    corner('EFFICIENT GROWTH', 'cheap reach, lower CPA', CONFIDENCE_COLORS.efficient, true, false);
    corner('PRECISION', 'pricey reach, lower CPA', CONFIDENCE_COLORS.precision, false, false);
    g.restore();
  } };
}

function _confTargetField(id, label, value, conv){
  if (value == null) return `<div class="tc-field"><label>${label}</label><span class="tc-note">Not enough data for a baseline (${fmtNum(conv)} conversions, needs ${CONFIDENCE_MIN_CONVERSIONS}).</span></div>`;
  return `<div class="tc-field"><label for="${id}">${label}</label><input type="number" id="${id}" min="0" step="any" value="${Math.round(value * 100) / 100}" /></div>`;
}

/* Fill the baseline panel for the selected Product x Campaign type and wire the
 * target inputs. Edits are session-only and re-grade this tab. */
/* "Target $X per plan and $Y per sub, from your last 90 days (Meta-reported). Edit" */
let scaleCutTargetsOpen = false;
function scaleCutTargetsLineHTML(cfg, t){
  const unit = label => String(label || '').replace(/^cost /i, '').trim();
  const parts = [];
  if (t.kill != null) parts.push(`${fmt$(t.kill)} ${_confEsc(unit(cfg.killLabel))}`);
  if (t.scale != null) parts.push(`${fmt$(t.scale)} ${_confEsc(unit(cfg.scaleLabel))}`);
  return `<span id="sc-targets-text">Target ${parts.join(' and ')}, from your last ${cfg.baselineDays} days (Meta-reported).</span> <button type="button" class="f10-ctl f10-ctl-link" id="sc-targets-edit-btn" aria-expanded="${scaleCutTargetsOpen ? 'true' : 'false'}" aria-controls="sc-targets-edit">Edit</button>`;
}
function renderConfidenceBaselinePanel(){
  const cfg = confidenceLinesConfig();
  const body = document.getElementById('sc-baseline-body');
  if (!cfg || !body) return;
  const unmatched = document.getElementById('sc-baseline-unmatched');
  const resetBtn = document.getElementById('cl-reset');
  const uSpend = confidenceUnmatchedSpend();
  if (unmatched) unmatched.innerHTML = uSpend > 0
    ? `<div class="tc-note" id="cl-unmatched-flag">${fmt$(uSpend)} of spend in this window is on campaigns whose names match no campaign type. Pick "Unmatched (check naming)" in Campaign type to see them, then fix the names or the mapping.</div>`
    : '';
  const key = confidenceSelectedKey();
  const t = key ? getConfidenceTargets(key) : null;
  const line = document.getElementById('sc-targets-line');
  const edit = document.getElementById('sc-targets-edit');
  const setLine = html => { if (line) line.innerHTML = html; };
  if (!key){
    setLine('<span class="tc-note">Pick a product and campaign type to see its targets.</span>');
    body.innerHTML = '';
    if (edit) edit.hidden = true;
    if (resetBtn) resetBtn.style.display = 'none';
    return;
  }
  if (!t || (t.kill == null && t.scale == null)){
    setLine('<span class="tc-note" id="cl-not-enough">Not enough data for a baseline</span>');
    body.innerHTML = '';
    if (edit) edit.hidden = true;
    if (resetBtn) resetBtn.style.display = 'none';
    return;
  }
  setLine(scaleCutTargetsLineHTML(cfg, t));
  const editBtn = document.getElementById('sc-targets-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => {
    scaleCutTargetsOpen = !scaleCutTargetsOpen;
    if (edit) edit.hidden = !scaleCutTargetsOpen;
    editBtn.setAttribute('aria-expanded', scaleCutTargetsOpen ? 'true' : 'false');
  });
  if (edit) edit.hidden = !scaleCutTargetsOpen;
  body.innerHTML = `<div class="tc-grid">${_confTargetField('cl-target-kill', cfg.killLabel, t.kill, t.killConv)}${_confTargetField('cl-target-scale', cfg.scaleLabel, t.scale, t.scaleConv)}</div>`;
  if (resetBtn) resetBtn.style.display = '';
  [['cl-target-kill', 'kill'], ['cl-target-scale', 'scale']].forEach(([id, which]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (setConfidenceTarget(key, which, el.value)) loadScaleCut();
      else { const cur = getConfidenceTargets(key); el.value = cur && cur[which] != null ? Math.round(cur[which] * 100) / 100 : ''; }
    });
  });
}

/* ── Scale & Cut tab loader ── */
let scaleCutLinesChart = null;
let scaleCutReachChart = null;
let scaleCutState = null;
let _scaleCutSeq = 0;

/* Legend chip counts follow the ad search, like the dots. */
function renderScaleCutCounts(){
  const st = scaleCutState;
  const rows = st ? adSearchFilter(st.rows, r => adSearchKey(r.ad_name, r.campaign_name, r.adset_name)) : [];
  const c = confidenceVerdictCounts(rows);
  const m = { pausedTesting: 0, liveCut: 0 };
  rows.forEach(r => {
    const x = scaleCutMismatch(confidenceIsLive(r), _confStr(r.verdict));
    if (x === SCALE_CUT_MISMATCH.pausedTesting) m.pausedTesting++;
    if (x === SCALE_CUT_MISMATCH.liveCut) m.liveCut++;
  });
  [['sc-count-scale', c.Scale], ['sc-count-testing', c.Testing], ['sc-count-cut', c.Cut],
    ['sc-count-paused-testing', m.pausedTesting], ['sc-count-live-cut', m.liveCut]].forEach(([id, n]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n);
  });
}
onAdSearch('scalecut', () => {
  if (!scaleCutState) return;
  renderScaleCutCounts();
  renderConfidenceReachNotes(scaleCutState.reachView);
  renderScaleCutFlow();
});

function renderScaleCutTable(rows, mode){
  const th1 = document.getElementById('sc-th-conv'), th2 = document.getElementById('sc-th-cpa');
  if (th1) th1.textContent = confidenceConvNoun(mode.label);
  if (th2) th2.textContent = mode.label;
  renderPagedTable('sc-table-body', rows.map(r => {
    const spend = Number(_confStr(r.lifetime_spend)) || 0;
    const conv = Number(_confStr(r[mode.convCol])) || 0;
    const name = _confEsc(_confStr(r.ad_name)), camp = _confEsc(_confStr(r.campaign_name));
    return `<tr ${adNameAttr(r.ad_name, r.campaign_name, r.adset_name)}><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;" title="${name}">${name}</td><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${camp}">${camp}</td><td>${_confEsc(_confStr(r.conf_segment))}</td><td>${fmt$(spend)}</td><td>${fmtNum(conv)}</td><td>${conv > 0 ? fmt$(spend / conv) : '-'}</td>${confidenceStatusCell(r)}${confidenceVerdictCell(r.verdict)}</tr>`;
  }), 20);
  hideEl('sc-table-loading'); showEl('sc-table');
}

function confidenceStatusCell(r){
  const live = confidenceIsLive(r);
  const flag = scaleCutMismatch(live, _confStr(r.verdict));
  return `<td>${confidenceStatusText(live)}${flag ? ` <span class="sc-mismatch-badge" title="${flag}">${flag}</span>` : ''}</td>`;
}

/* ── Maturity playback ──
 * Frames run from the range start to the last day in the data. Each frame
 * shows every ad launched by that day at its running spend and cost per
 * conversion, coloured by its SQL verdict as of that day. The last frame is
 * the lifetime view. The axes and the lines stay at the segment target. */
const scaleCutPlay = { frames: [], index: 0, timer: null, byAd: {}, fixed: null };
function _scaleCutFrameDates(from, to){
  const out = [];
  if (!from || !to || from > to) return out;
  for (let d = from; d <= to && out.length < 4000; d = _isoAddDays(d, 1)) out.push(d);
  return out;
}
function scaleCutHistoryIndex(dailyRows){
  const byAd = {};
  (dailyRows || []).forEach(r => {
    const id = String(_confStr(r.ad_id));
    (byAd[id] = byAd[id] || []).push({ day: String(_confStr(r.day)), spend: Number(_confStr(r.cum_spend)) || 0,
      kill: Number(_confStr(r.cum_kill)) || 0, scale: Number(_confStr(r.cum_scale)) || 0, verdict: _confStr(r.day_verdict) });
  });
  Object.keys(byAd).forEach(k => byAd[k].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)));
  return byAd;
}
/* One ad's row for a playback date: its latest history row on or before it.
 * Before launch the row holds the first day and is marked _unlaunched. */
function scaleCutFrameRow(r, h, date, trails, mode){
  let last = -1;
  for (let i = 0; i < h.length && h[i].day <= date; i++) last = i;
  const e = h[Math.max(0, last)];
  const row = Object.assign({}, r, { lifetime_spend: e.spend, kill_conv: e.kill, scale_conv: e.scale, verdict: e.verdict });
  if (last < 0) return Object.assign(row, { _unlaunched: true });
  if (trails && mode){
    row._trail = h.slice(0, last + 1).map(t => {
      const conv = mode.which === 'scale' ? t.scale : t.kill;
      return { x: Math.max(t.spend, mode.logMin), y: Math.min(conv > 0 ? t.spend / conv : scaleCutPlay.fixed.maxY, scaleCutPlay.fixed.maxY) };
    });
  }
  return row;
}
/* The rows for one playback date. Ads not yet launched are left out. */
function scaleCutFrameRows(rows, byAd, date, trails, mode){
  const out = [];
  (rows || []).forEach(r => {
    const h = byAd[String(_confStr(r.ad_id))];
    if (!h || !h.length) return;
    const row = scaleCutFrameRow(r, h, date, trails, mode);
    if (!row._unlaunched) out.push(row);
  });
  return out;
}
/* ── Playback dots ──
 * While playing, every ad with history holds one slot in a single dataset, in
 * the same order on every frame. Each frame updates the points in place and
 * Chart.js tweens each dot from where it was, so nothing jumps from the axis.
 * Colour and fill come from each point's own verdict and live status. Ads not
 * yet launched (or with no spend yet) sit at their first-day position with
 * radius 0. The last frame goes back to the grouped static view. */
const SCALE_CUT_PLAY_MODE = 'sc-play';
function scaleCutFrameMs(){
  const sp = document.getElementById('sc-play-speed');
  return 200 / Math.max(1, Number(sp && sp.value) || 1);
}
function scaleCutDotColor(p){ return CONFIDENCE_VERDICT_COLOR[p && p._verdict] || CONFIDENCE_VERDICT_COLOR['No baseline']; }
function scaleCutDotHidden(p){ return !!(p && (p._hide || p._searchOut)); }
function scaleCutPlayDataset(){
  const r = c => (c.raw && c.raw._r) || 3;
  return { label: 'Ads', data: [], _scaleCutPlay: true, borderWidth: 1,
    backgroundColor: c => scaleCutDotColor(c.raw) + 'cc', borderColor: c => scaleCutDotColor(c.raw),
    pointBackgroundColor: c => (c.raw && c.raw._live === false) ? '#ffffff' : scaleCutDotColor(c.raw) + 'cc',
    pointBorderColor: c => scaleCutDotColor(c.raw),
    pointBorderWidth: c => (c.raw && c.raw._live === false) ? 1.5 : 1,
    pointRadius: c => scaleCutDotHidden(c.raw) ? 0 : r(c),
    pointHoverRadius: c => scaleCutDotHidden(c.raw) ? 0 : r(c) + 2,
    pointHitRadius: c => scaleCutDotHidden(c.raw) ? 0 : 1 };
}
/* One point per ad with history, in rows order. y is never 0: no conversions
 * or off the chart sits at the top edge, like the static view. */
function scaleCutPlayPoints(rows, byAd, date, trails, mode, fixed){
  const out = [];
  (rows || []).forEach(r => {
    const id = String(_confStr(r.ad_id)), h = byAd[id];
    if (!h || !h.length) return;
    const row = scaleCutFrameRow(r, h, date, trails, mode);
    const p = confidenceLinesPoint(row, mode, true);
    p._adId = id;
    p._hide = !!row._unlaunched || !(p._spend > 0);
    if (p._hide) p._trail = null;
    p._clamped = false;
    if (!(p.y > 0) || p.y > fixed.maxY){ p.y = fixed.maxY; p._clamped = true; }
    p._r = 2.5 + 3.5 * Math.sqrt(fixed.maxSpend > 0 ? Math.min(1, p._spend / fixed.maxSpend) : 0);
    out.push(p);
  });
  return out;
}
function renderScaleCutPlayFrame(chart, st, date, trails){
  const cur = chart.data.datasets;
  let ds = cur.length === 1 && cur[0] && cur[0]._scaleCutPlay ? cur[0] : null;
  const fresh = !ds;
  if (fresh){ ds = scaleCutPlayDataset(); chart.data.datasets = [ds]; }
  const pts = scaleCutPlayPoints(st.rows, scaleCutPlay.byAd, date, trails, st.mode, scaleCutPlay.fixed);
  pts.forEach((p, k) => {
    if (ds.data[k] && ds.data[k]._adId === p._adId) Object.assign(ds.data[k], p); else ds.data[k] = p;
  });
  ds.data.length = pts.length;
  const tokens = adSearchTokens(adSearchTerm);
  ds.data.forEach(p => { p._searchOut = !!tokens.length && !adSearchMatches(String(p._key || ''), tokens); });
  chart._adSearch = { apply: keep => ds.data.forEach(p => { p._searchOut = !keep(p._key); }) };
  _adSearchCharts['sc-lines'] = chart;
  if (fresh){ chart.update('none'); return; }
  const tr = chart.options && chart.options.transitions && chart.options.transitions[SCALE_CUT_PLAY_MODE];
  if (tr && tr.animation) tr.animation.duration = Math.round(0.9 * scaleCutFrameMs());
  chart.update(SCALE_CUT_PLAY_MODE);
}
/* The last frame is today's view: the grouped static datasets, with trails
 * ending at each ad's lifetime position when Trails is on. */
function renderScaleCutLastFrame(chart, st, date, trails){
  const frameRows = trails
    ? scaleCutFrameRows(st.rows, scaleCutPlay.byAd, date, true, st.mode).concat(st.rows.filter(r => !scaleCutPlay.byAd[String(_confStr(r.ad_id))]))
    : st.rows;
  if (trails){
    /* Lifetime position for the last dot; the trail ends there. */
    const life = {};
    st.rows.forEach(r => { life[String(_confStr(r.ad_id))] = r; });
    frameRows.forEach((r, k) => {
      const l = life[String(_confStr(r.ad_id))];
      if (l && r._trail) frameRows[k] = Object.assign({}, l, { _trail: r._trail });
    });
  }
  const view = confidenceLinesView(frameRows, st.mode, Object.assign({}, scaleCutPlay.fixed, { noMismatch: false }));
  /* Coming from a playback frame, swap in the static view without animating. */
  const fromPlay = chart.data.datasets.some(d => d && d._scaleCutPlay);
  chart.data.datasets = view.datasets;
  followAdSearch('sc-lines', chart, null, fromPlay ? 'none' : undefined);
}
function renderScaleCutFrame(i){
  const st = scaleCutState, chart = scaleCutLinesChart, n = scaleCutPlay.frames.length;
  if (!st || !chart || !n) return;
  const idx = Math.max(0, Math.min(n - 1, Math.floor(Number(i) || 0)));
  scaleCutPlay.index = idx;
  const date = scaleCutPlay.frames[idx];
  const trailsEl = document.getElementById('sc-trails');
  const trails = !!(trailsEl && trailsEl.checked);
  const isLast = idx === n - 1;
  if (isLast) renderScaleCutLastFrame(chart, st, date, trails);
  else renderScaleCutPlayFrame(chart, st, date, trails);
  const slider = document.getElementById('sc-play-date');
  if (slider){ slider.max = String(n - 1); slider.value = String(idx); }
  const label = document.getElementById('sc-play-label');
  if (label) label.textContent = isLast ? `${fmtDate(date)} (today's view)` : fmtDate(date);
}
function stopScaleCutPlay(){
  if (scaleCutPlay.timer != null) clearTimeout(scaleCutPlay.timer);
  scaleCutPlay.timer = null;
  const btn = document.getElementById('sc-play');
  if (btn) btn.textContent = 'Play';
}
function startScaleCutPlay(){
  const n = scaleCutPlay.frames.length;
  if (!n) return;
  if (scaleCutPlay.index >= n - 1) renderScaleCutFrame(0);
  const btn = document.getElementById('sc-play');
  if (btn) btn.textContent = 'Pause';
  if (window.F10A) F10A.track('filter_changed', { filter: 'playback', value: 'play' });
  const tick = () => {
    if (scaleCutPlay.index >= scaleCutPlay.frames.length - 1){ stopScaleCutPlay(); return; }
    renderScaleCutFrame(scaleCutPlay.index + 1);
    scaleCutPlay.timer = setTimeout(tick, scaleCutFrameMs());
  };
  scaleCutPlay.timer = setTimeout(tick, scaleCutFrameMs());
}
function resetScaleCutPlay(){
  stopScaleCutPlay();
  Object.assign(scaleCutPlay, { frames: [], index: 0, byAd: {}, fixed: null });
  const slider = document.getElementById('sc-play-date');
  if (slider){ slider.max = '0'; slider.value = '0'; }
  const label = document.getElementById('sc-play-label');
  if (label) label.textContent = '';
  const cap = document.getElementById('sc-play-cap');
  if (cap) cap.textContent = '';
}
function setupScaleCutPlay(dailyRows, view, range, adsInRange){
  const byAd = scaleCutHistoryIndex(dailyRows);
  let last = null;
  Object.keys(byAd).forEach(k => { const d = byAd[k][byAd[k].length - 1].day; if (!last || d > last) last = d; });
  const end = _isoDate(confidenceWindowEnd());
  if (end && (!last || end > last)) last = end;
  const first = range ? range.from : null;
  Object.assign(scaleCutPlay, { byAd, frames: _scaleCutFrameDates(first, last), fixed: { maxY: view.maxY, maxSpend: view.maxSpend } });
  scaleCutPlay.index = Math.max(0, scaleCutPlay.frames.length - 1);
  const slider = document.getElementById('sc-play-date');
  if (slider){ slider.max = String(Math.max(0, scaleCutPlay.frames.length - 1)); slider.value = String(scaleCutPlay.index); }
  const label = document.getElementById('sc-play-label');
  if (label) label.textContent = scaleCutPlay.frames.length ? `${fmtDate(scaleCutPlay.frames[scaleCutPlay.index])} (today's view)` : '';
  const cap = document.getElementById('sc-play-cap');
  if (cap) cap.textContent = adsInRange > SCALE_CUT_PLAY_CAP
    ? `Playback shows the top ${SCALE_CUT_PLAY_CAP} of ${fmtNum(adsInRange)} ads by spend. Narrow the launch range to see them all.` : '';
}

/* ── New ad flow ──
 * One row per launch week (weeks start Monday), newest first. "Now" counts
 * use today's verdict; days and spend to first verdict use each ad's history.
 * Follows Product, Campaign type, the launch range and the ad search. */
function _mondayOf(iso){
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function _medianAllowZero(vals){
  const v = vals.filter(x => x != null && Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function scaleCutFlowRows(rows, flowRows){
  const byAd = {};
  (flowRows || []).forEach(f => { byAd[String(_confStr(f.ad_id))] = f; });
  const weeks = {};
  (rows || []).forEach(r => {
    const launch = _isoDate(_confStr(r.launch_date));
    if (!launch) return;
    const wk = _mondayOf(launch);
    const w = weeks[wk] = weeks[wk] || { week: wk, ads: 0, scale: 0, testing: 0, cut: 0, ungraded: 0, cutSpend: 0, days: [], spend: [] };
    w.ads++;
    const v = _confStr(r.verdict);
    if (v === 'Scale') w.scale++; else if (v === 'Testing') w.testing++; else if (v === 'Cut') w.cut++; else w.ungraded++;
    if (v === 'Cut') w.cutSpend += Number(_confStr(r.lifetime_spend)) || 0;
    const f = byAd[String(_confStr(r.ad_id))];
    if (f && _confStr(f.first_verdict_date) != null){
      const dd = Number(_confStr(f.days_to_verdict));
      const sp = Number(_confStr(f.spend_to_verdict));
      if (Number.isFinite(dd)) w.days.push(dd);
      if (Number.isFinite(sp)) w.spend.push(sp);
    }
  });
  return Object.keys(weeks).sort().reverse().map(k => {
    const w = weeks[k];
    return { week: w.week, ads: w.ads, scale: w.scale, testing: w.testing, cut: w.cut, ungraded: w.ungraded,
      withVerdict: w.ads ? (w.scale + w.cut) / w.ads : 0, cutSpend: w.cutSpend,
      medianDays: _medianAllowZero(w.days), medianSpend: _medianAllowZero(w.spend) };
  });
}
function renderScaleCutFlow(){
  const body = document.getElementById('sc-flow-body');
  const st = scaleCutState;
  if (!body || !st) return;
  if (st.flowError){ body.innerHTML = '<tr><td colspan="9" class="tc-note">Could not load the flow table.</td></tr>'; return; }
  if (!st.flowRows){ body.innerHTML = '<tr><td colspan="9" class="tc-note">Loading&hellip;</td></tr>'; return; }
  const rows = adSearchFilter(st.rows, r => adSearchKey(r.ad_name, r.campaign_name, r.adset_name));
  const out = scaleCutFlowRows(rows, st.flowRows);
  if (!out.length){ body.innerHTML = '<tr><td colspan="9" class="tc-note">No ads launched in this range.</td></tr>'; return; }
  body.innerHTML = out.map(w => `<tr><td>${fmtDate(w.week)}</td><td>${fmtNum(w.ads)}</td><td>${fmtNum(w.scale)}</td><td>${fmtNum(w.testing)}</td><td>${fmtNum(w.cut)}</td>`
    + `<td>${fmtPct(w.withVerdict * 100)}</td><td>${fmt$(w.cutSpend)}</td><td>${w.medianDays == null ? '-' : fmtNum(w.medianDays)}</td><td>${w.medianSpend == null ? '-' : fmt$(w.medianSpend)}</td></tr>`).join('');
}

/* Run the playback and flow queries together. Errors leave a note and keep the
 * lifetime view; nothing reaches the console as an uncaught error. */
async function loadScaleCutHistory(seq, rows, view, range){
  const st = scaleCutState;
  let daily = [], flow = null, flowError = false;
  try {
    const res = await Promise.all([
      runQuery(scaleCutPlaybackSQL(range)).catch(err => { console.warn('Playback data error:', err); return []; }),
      runQuery(scaleCutFlowSQL(range)).catch(err => { console.warn('Flow data error:', err); flowError = true; return null; }),
    ]);
    daily = res[0] || []; flow = res[1];
  } catch (err){ console.warn('Scale & Cut history error:', err); flowError = true; }
  if (seq !== _scaleCutSeq || st !== scaleCutState) return;
  st.flowRows = flow || (flowError ? null : []);
  st.flowError = flowError;
  renderScaleCutFlow();
  setupScaleCutPlay(daily, view, range, rows.length);
}

function showScaleCutReachEmpty(){
  const empty = document.getElementById('sc-reach-empty');
  if (empty) empty.style.display = '';
  hideEl('sc-reach-loading'); hideEl('sc-reach-wrapper');
  if (scaleCutReachChart){ scaleCutReachChart.destroy(); scaleCutReachChart = null; }
  confidenceQuadState = null;
  renderConfidenceReachNotes(null);
}

async function loadScaleCut(){
  if (!confidenceLinesEnabled()) return;
  ensureConfidenceControls();
  const seq = ++_scaleCutSeq;
  resetScaleCutPlay();
  try {
    await loadConfidenceBaseline();
    if (seq !== _scaleCutSeq) return;
    const range = scaleCutLaunchRange();
    const rows = await runQuery(scaleCutSQL(range));
    if (seq !== _scaleCutSeq) return;
    const mode = confidenceScatterMode(rows);
    renderConfidenceBaselinePanel();

    const view = confidenceLinesView(rows, mode);
    confidenceCurveState = confidenceCurveFor(mode, view.maxSpend);
    renderConfidenceLinesNote(mode);
    const sub = document.getElementById('sc-lines-sub');
    if (sub) sub.textContent = 'Spend (log) against ' + mode.label.toLowerCase();
    hideEl('sc-lines-loading'); showEl('sc-lines-wrapper');
    if (scaleCutLinesChart) scaleCutLinesChart.destroy();
    scaleCutLinesChart = confidenceLinesChart(view);
    followAdSearch('sc-lines', scaleCutLinesChart);

    scaleCutState = { rows, mode, range, reachView: null, reachRows: null, flowRows: null, flowError: false };
    renderScaleCutTable(scaleCutLookRows(rows), mode);
    renderScaleCutCounts();
    renderScaleCutFlow();
    scaleCutState.history = loadScaleCutHistory(seq, rows, view, range);

    if (!confidenceReachEnabled()){ showScaleCutReachEmpty(); return; }
    const win = confidenceReachWindow();
    const empty = document.getElementById('sc-reach-empty');
    if (empty) empty.style.display = 'none';
    showEl('sc-reach-loading'); hideEl('sc-reach-wrapper');
    let reachRows;
    try { reachRows = await runQuery(confidenceReachSQL(win)); }
    catch (err){
      if (seq !== _scaleCutSeq) return;
      console.error('Reach data error:', err);
      showScaleCutReachEmpty();
      const note = document.getElementById('sc-reach-note');
      if (note) note.textContent = 'Could not load reach data.';
      return;
    }
    if (seq !== _scaleCutSeq) return;
    if (!reachRows || !reachRows.length){ showScaleCutReachEmpty(); return; }
    const rview = confidenceReachView(rows, reachRows, mode);
    Object.assign(scaleCutState, { reachView: rview, reachRows });
    renderConfidenceReachNotes(rview);
    hideEl('sc-reach-loading'); showEl('sc-reach-wrapper');
    if (scaleCutReachChart) scaleCutReachChart.destroy();
    scaleCutReachChart = confidenceReachChart(rview);
    followAdSearch('sc-reach', scaleCutReachChart);
  } catch (err){ console.error('Scale & Cut error:', err); }
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
