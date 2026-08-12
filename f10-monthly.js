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
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scopeWhere('WHERE')} GROUP BY 1, 2 ORDER BY 2 DESC`;
  const dailySQL = `
    SELECT FORMAT_DATE('%b %Y', min_date) AS launch_month, DATE_TRUNC(min_date, MONTH) AS launch_month_sort,
      date_start, ROUND(SUM(spend), 2) AS daily_spend
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scopeWhere('WHERE')} GROUP BY 1, 2, 3 ORDER BY 3, 2`;
  try {
    const [summary, daily] = await Promise.all([runQuery(summarySQL), runQuery(dailySQL)]);
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
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scopeWhere('WHERE')} GROUP BY 1, 2 ORDER BY 1, 2`;
  const tableSQL = `
    SELECT ad_id, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adset_name) AS adset_name, ANY_VALUE(ad_name) AS ad_name,
      MIN(min_date) AS launch_date, MAX(max_date) AS last_spend, ANY_VALUE(creative_link) AS preview_link,
      ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend,
      ROUND(${lifetimeMetricSQL('ANY_VALUE(lifetime_spend)', `SUM(${CONV_EXPR})`)}, 2) AS lifetime_cpa,
      ROUND(SUM(${CONV_EXPR}), 0) AS total_conversions
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scopeWhere('WHERE')} GROUP BY 1 ORDER BY lifetime_spend DESC`;
  try {
    const [ageData, tableData] = await Promise.all([runQuery(ageSQL), runQuery(tableSQL)]);
    const dates=[...new Set(ageData.map(r=>bqStr(r.date_start)))].sort();
    const buckets=['0–14 Days','15–90 Days','90+ Days'];
    const spendMap={}; ageData.forEach(r=>{ spendMap[bqStr(r.date_start)+'|'+r.age_bucket]=Number(r.daily_spend); });
    const ageDatasets=buckets.map(b=>{ const raw=dates.map(d=>spendMap[d+'|'+b]||0); const dayTotals=dates.map(d=>buckets.reduce((s,bk)=>s+(spendMap[d+'|'+bk]||0),0));
      return { label:b, data:raw.map((v,i)=>dayTotals[i]>0?+(v/dayTotals[i]*100).toFixed(1):0), backgroundColor:AGE_COLORS[b]+'dd', borderColor:AGE_COLORS[b], borderWidth:1 }; });
    hideEl('age-chart-loading'); showEl('age-chart-wrapper');
    if(ageChart) ageChart.destroy();
    ageChart=new Chart(document.getElementById('age-chart'),{ type:'bar', data:{ labels:dates.map(d=>fmtDate(d)), datasets:ageDatasets },
      options:{ responsive:true, maintainAspectRatio:true, scales:{ x:{stacked:true,ticks:{font:{size:10},maxRotation:45}}, y:{stacked:true,max:100,ticks:{callback:v=>v+'%'}} }, plugins:{ legend:{position:'top',labels:{font:{size:11}}}, tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw}%`}} } } });
    renderPagedTable('age-table-body', tableData.map(r=>`<tr ${adNameAttr(r.ad_name)}><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmtDate(r.last_spend)}</td><td>${r.preview_link?`<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.preview_link}" target="_blank">Preview</a>`:'–'}</td><td>${fmt$(r.lifetime_spend)}</td><td>${r.lifetime_cpa&&Number(r.lifetime_cpa)>0?fmtMetricCell(r.lifetime_cpa):'–'}</td><td>${fmtNum(r.total_conversions)}</td></tr>`));
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
  };
}

async function loadProduction(){
  ensureProductionControls();
  fillProductionInputs();
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
        SUM(video_p100) AS video_p100, SUM(video_plays) AS video_plays, SUM(outbound_clicks) AS outbound_clicks
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
        ROUND(SUM(spend),2) AS period_spend, ROUND(SUM(${CONV_EXPR}),0) AS total_conversions${rollupRevSel}
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`${scopeWhere('WHERE')} GROUP BY 1 ),
    classified AS ( SELECT *, ${classificationCaseSQL('lifetime_spend', rollupMetricCol)} AS classification FROM unique_ads )
    SELECT FORMAT_DATE('%b %Y', launch_date) AS launch_month, DATE_TRUNC(launch_date, MONTH) AS launch_month_sort,
      COUNT(*) AS ads_launched, COUNTIF(classification='Home Run') AS home_runs, COUNTIF(classification='On Base') AS on_base, COUNTIF(classification='Strike Out') AS strike_outs,
      ROUND(SUM(period_spend),0) AS total_spend, ${rollupAvgSQL} AS avg_cpa, ROUND(SUM(total_conversions),0) AS total_conversions
    FROM classified GROUP BY 1, 2 ORDER BY 2 DESC`;
  try {
    const [scatterData, monthlyData] = await Promise.all([runQuery(scatterSQL), runQuery(monthlySQL)]);
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
    const totals=scatterData.reduce((acc,r)=>{ acc.total++; if(r.classification==='Home Run')acc.hr++; if(r.classification==='On Base')acc.ob++; if(r.classification==='Strike Out')acc.so++; return acc; },{total:0,hr:0,ob:0,so:0});
    document.getElementById('sc-ads-produced').textContent=fmtNum(totals.total);
    document.getElementById('sc-home-runs').textContent=fmtNum(totals.hr);
    document.getElementById('sc-hr-rate').textContent=fmtPct(totals.hr/totals.total*100);
    document.getElementById('sc-on-base').textContent=fmtNum(totals.ob);
    document.getElementById('sc-ob-rate').textContent=fmtPct(totals.ob/totals.total*100);
    document.getElementById('sc-strike-outs').textContent=fmtNum(totals.so);
    document.getElementById('sc-so-rate').textContent=fmtPct(totals.so/totals.total*100);
    hideEl('production-scorecards-loading'); showEl('production-scorecards');
    const byClass={'Home Run':[],'On Base':[],'Strike Out':[],'Unclassified':[]};
    /* Metric-aware: the per-ad metric column is `lifetime_cpa` in CPA mode and
       `lifetime_roas` in ROAS mode (aliased by lifetimeMetricCol()). Read it
       generically so a dir:'higher' metric plots correctly. A creative with
       metric=0 but spend>0 (real spend, zero revenue in ROAS) is kept, not
       silently dropped — it belongs at the bottom of a higher-is-better axis. */
    const isRoas=targetMetric()==='roas';
    const mCol=lifetimeMetricCol();
    scatterData.forEach(r=>{ const mVal=Number(r[mCol])||0, spend=Number(r.lifetime_spend)||0; if(mVal>0||spend>0){ byClass[r.classification].push({x:spend,y:mVal,label:r.ad_name}); } });
    const scatterDatasets=Object.entries(byClass).map(([cls,pts])=>({ label:cls, data:pts, backgroundColor:CLASS_COLOR[cls]+'bb', borderColor:CLASS_COLOR[cls], borderWidth:1.5, pointRadius:6, pointHoverRadius:8 }));
    hideEl('scatter-loading'); showEl('scatter-wrapper');
    if(scatterChart) scatterChart.destroy();
    const topSpend=Math.max(0, ...scatterData.map(r=>Number(r.lifetime_spend)||0));
    const maxSpend=Math.round(scatterMaxSpend(topSpend));
    /* Y-axis max from the ACTIVE metric's values, not the CPA range. The floor
       keeps the Home Run threshold line on-chart even when data is sparse: 100
       ($) in CPA mode, HR_ROAS (x) in ROAS mode where values live around 1–10. */
    const yFloor=isRoas?HR_ROAS:100;
    const maxY=Math.ceil(Math.max(...scatterData.filter(r=>Number(r[mCol])>0).map(r=>Number(r[mCol])||0),yFloor)*1.2);
    scatterChart=new Chart(document.getElementById('scatter-chart'),{ type:'scatter', data:{ datasets:scatterDatasets },
      options:{ responsive:true, maintainAspectRatio:false,
        scales:{ x:{ title:{display:true,text:'Lifetime Spend ($)',font:{size:11}}, min:0, max:maxSpend, ticks:{callback:v=>fmt$(v)} }, y:{ title:{display:true,text:`Lifetime ${targetMetricDef().label} (${isRoas?'x':'$'})`,font:{size:11}}, min:0, max:maxY, ticks:{callback:v=>fmtMetricCell(v)} } },
        plugins:{ legend:{position:'top',labels:{font:{size:11}}}, tooltip:{callbacks:{label:ctx=>{ const pt=ctx.raw; const mLine=isRoas?`${targetMetricDef().label}: ${fmtMetricCell(pt.y)}`:`CPA: ${pt.y>0?fmt$(pt.y):'N/A'}`; return [`${ctx.dataset.label}`,`Spend: ${fmt$(pt.x)}`,mLine]; }}} } },
      plugins:[{ id:'threshold-lines', afterDraw(chart){ const ctx2=chart.ctx,xAxis=chart.scales.x,yAxis=chart.scales.y;
        const xHit=xAxis.getPixelForValue(HR_SPEND); if(xHit>=xAxis.left&&xHit<=xAxis.right){ ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle=CHART_SECONDARY; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xHit,yAxis.top); ctx2.lineTo(xHit,yAxis.bottom); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle=CHART_SECONDARY; ctx2.font='10px Archivo, sans-serif'; ctx2.fillText('Ad Hit ('+fmt$(HR_SPEND)+')',xHit+4,yAxis.top+14); ctx2.restore(); }
        const yThresh=isRoas?HR_ROAS:HR_CPA; const yLine=yAxis.getPixelForValue(yThresh); if(yLine>=yAxis.top&&yLine<=yAxis.bottom){ ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle='#727272'; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xAxis.left,yLine); ctx2.lineTo(xAxis.right,yLine); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle='#727272'; ctx2.font='10px Archivo, sans-serif'; ctx2.fillText((isRoas?'ROAS Target (':'CPA Limit (')+fmtMetricCell(yThresh)+')',xAxis.left+4,yLine-4); ctx2.restore(); } } }] });
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
    renderPagedTable('scatter-table-body', scatterData.map(r=>{ const cls=r.classification; const badgeClass=cls==='Home Run'?'badge-hr':cls==='On Base'?'badge-ob':cls==='Strike Out'?'badge-so':'badge-un'; const ce={ impressions:Number(r.impressions)||0, clicks:Number(r.clicks)||0, video_15s:Number(r.video_15s)||0, video_p25:Number(r.video_p25)||0, video_p50:Number(r.video_p50)||0, video_p75:Number(r.video_p75)||0, video_p100:Number(r.video_p100)||0, video_plays:Number(r.video_plays)||0, outbound_clicks:Number(r.outbound_clicks)||0 }; const cr=creativeRates(ce); registerAdMetrics(r.ad_id, ce, undefined, creativeScoreHover(r.creative_score, { spend:r.lifetime_spend, metric:r[mCol], hook:cr.hook, hold:cr.hold, ctr:cr.ctr, completion:cr.completion, hasVideo:cr.hasVideo, activeDays:r.active_days }));
      return `<tr ${adNameAttr(r.ad_name)}><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmt$(r.lifetime_spend)}</td><td>${r[mCol]&&Number(r[mCol])>0?fmtMetricCell(r[mCol]):'–'}</td><td>${fmtNum(r.total_conversions)}</td><td class="num">${cr.hold!=null?fmtPct(cr.hold,2):'–'}</td><td class="num">${cr.completion!=null?fmtPct(cr.completion,2):'–'}</td><td class="num">${cr.outboundCtr!=null?fmtPct(cr.outboundCtr,2):'–'}</td><td>${r.creative_link?`<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.creative_link}" target="_blank">Preview</a>`:'–'}</td><td><span class="badge ${badgeClass}">${cls}</span></td><td>${creativeScoreBadge(r.creative_score)}</td></tr>`; }));
    hideEl('scatter-table-loading'); showEl('scatter-table');
  } catch(err){ console.error('Production error:',err); }
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
    renderPagedTable('powerlaw-table-body', data.map(r=>`<tr ${adNameAttr(r.ad_name)}><td class="rank-num">${r.rank_num}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmtDate(r.last_spend_date)}</td><td>${r.preview_link?`<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.preview_link}" target="_blank">Preview</a>`:'–'}</td><td>${fmt$(r.spend)}</td><td>${fmtPct(r.spend_pct,2)}</td><td>${fmtPct(r.rolling_pct,2)}</td><td>${r.lifetime_cpa&&Number(r.lifetime_cpa)>0?fmtMetricCell(r.lifetime_cpa):'–'}</td></tr>`));
    hideEl('powerlaw-table-loading'); showEl('powerlaw-table');
  } catch(err){ console.error('Power law error:',err); }
}


/* ── Creative Effectiveness ──
 * Attention metrics beyond CPA: hold rate (15s ÷ impr), completion (100% ÷ impr),
 * the 25→100% retention curve, plus CTR and outbound CTR. Per-ad rates feed the
 * table and the hover preview; the chart shows the impression-weighted average
 * curve across all video ads in the last 90 days. */
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
    ) WHERE impressions > 0 ORDER BY spend DESC`;
  try {
    const data = await runQuery(sql);
    let tImpr=0,t15=0,t25=0,t50=0,t75=0,t100=0;
    const rows = data.map(r=>{
      const ce = { impressions:Number(r.impressions)||0, clicks:Number(r.clicks)||0, video_15s:Number(r.video_15s)||0, video_p25:Number(r.video_p25)||0, video_p50:Number(r.video_p50)||0, video_p75:Number(r.video_p75)||0, video_p100:Number(r.video_p100)||0, video_plays:Number(r.video_plays)||0, outbound_clicks:Number(r.outbound_clicks)||0 };
      const cr = creativeRates(ce);
      registerAdMetrics(r.ad_id, ce, undefined, creativeScoreHover(r.creative_score, { spend:r.lifetime_spend, metric:r[lifetimeMetricCol()], hook:cr.hook, hold:cr.hold, ctr:cr.ctr, completion:cr.completion, hasVideo:cr.hasVideo, activeDays:r.active_days }));
      tImpr+=ce.impressions; t15+=ce.video_15s; t25+=ce.video_p25; t50+=ce.video_p50; t75+=ce.video_p75; t100+=ce.video_p100;
      const pct = (v) => v!=null ? fmtPct(v,2) : '–';
      const pv = r.creative_link ? `<a class="preview-link" data-ad-id="${r.ad_id}" href="${r.creative_link}" target="_blank">Preview</a>` : '–';
      return `<tr ${adNameAttr(r.ad_name)}><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name||''}">${r.ad_name||'–'}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name||''}">${r.campaign_name||'–'}</td><td class="num">${fmt$(r.spend)}</td><td class="num">${fmtNum(ce.impressions)}</td><td class="num">${pct(cr.hold)}</td><td class="num">${pct(cr.completion)}</td><td class="num">${pct(cr.retention.p25)}</td><td class="num">${pct(cr.retention.p50)}</td><td class="num">${pct(cr.retention.p75)}</td><td class="num">${pct(cr.retention.p100)}</td><td class="num">${pct(cr.ctr)}</td><td class="num">${pct(cr.outboundCtr)}</td><td>${pv}</td><td>${creativeScoreBadge(r.creative_score)}</td></tr>`;
    });
    renderPagedTable('creative-table-body', rows);
    hideEl('creative-table-loading'); showEl('creative-table');
    const curve = [ t25, t50, t75, t100 ].map(v => tImpr>0 ? +(v/tImpr*100).toFixed(2) : 0);
    hideEl('creative-chart-loading'); showEl('creative-chart-wrapper');
    if(creativeChart) creativeChart.destroy();
    creativeChart = new Chart(document.getElementById('creative-chart'), { type:'line',
      data:{ labels:['25%','50%','75%','100%'], datasets:[{ label:'% of impressions reaching', data:curve, borderColor:CHART_PRIMARY, backgroundColor:CHART_PRIMARY+'21', borderWidth:2.5, pointRadius:4, fill:true, tension:0.25 }] },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>`${ctx.label} watched: ${ctx.raw}% of impressions` } } },
        scales:{ x:{ title:{display:true,text:'Video quartile watched',font:{size:11}} }, y:{ title:{display:true,text:'% of impressions',font:{size:11}}, ticks:{callback:v=>v+'%'} } } } });
  } catch(err){ console.error('Creative effectiveness error:',err); const el=document.getElementById('creative-table-loading'); if(el) el.innerHTML='Error loading data: '+err.message; }
}
