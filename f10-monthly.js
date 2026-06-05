/**
 * f10-monthly.js — F10 Creative Dashboard monthly engine
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.1.0/f10-monthly.js"></script>
 *
 * Must be loaded AFTER f10-utils.js and f10-weekly.js.
 *
 * Provides the four monthly tab loaders (powerlaw, production, decay, age) and the
 * loadMonthlyTab(tab) dispatcher that f10-weekly.js calls when a monthly tab is
 * first opened. All SQL is shared — only the dashboard config differs:
 *   PROJECT, DATASET, TABLE  — BigQuery target
 *   CONV_EXPR                — conversion expression
 *   GROUP_FILTERS            — optional segment filters (applied via groupWhere())
 *   HR_SPEND/HR_CPA/...      — production thresholds (from f10-utils.js, overridable)
 *
 * Every query is scoped by the active group selections through groupWhere().
 */

let decayChart = null, decayPctChart = null, ageChart = null,
    scatterChart = null, productionChart = null, powerLawChart = null;

function loadMonthlyTab(tab){
  loadedTabs[tab] = true;
  if(tab === 'decay')      loadDecay();
  if(tab === 'age')        loadAge();
  if(tab === 'production') loadProduction();
  if(tab === 'powerlaw')   loadPowerLaw();
}

/* ── Ad Decay ── */

async function loadDecay(){
  const summarySQL = `
    SELECT FORMAT_DATE('%b %Y', min_date) AS launch_month, DATE_TRUNC(min_date, MONTH) AS launch_month_sort,
      COUNT(DISTINCT ad_id) AS ads_launched,
      ROUND(AVG(DATE_DIFF(COALESCE(max_date, CURRENT_DATE()), min_date, DAY)), 0) AS avg_days_running,
      ROUND(SUM(spend), 0) AS total_spend,
      ROUND(SAFE_DIVIDE(SUM(spend), NULLIF(SUM(${CONV_EXPR}), 0)), 0) AS cpa
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${groupWhere('WHERE')} GROUP BY 1, 2 ORDER BY 2 DESC`;
  const dailySQL = `
    SELECT FORMAT_DATE('%b %Y', min_date) AS launch_month, DATE_TRUNC(min_date, MONTH) AS launch_month_sort,
      date_start, ROUND(SUM(spend), 2) AS daily_spend
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${groupWhere('WHERE')} GROUP BY 1, 2, 3 ORDER BY 3, 2`;
  try {
    const [summary, daily] = await Promise.all([runQuery(summarySQL), runQuery(dailySQL)]);
    const tbody=document.getElementById('decay-summary-body'); let total_ads=0,total_spend=0;
    tbody.innerHTML = summary.map(r=>{ total_ads+=Number(r.ads_launched); total_spend+=Number(r.total_spend);
      return `<tr><td>${r.launch_month}</td><td>${fmtNum(r.ads_launched)}</td><td>${r.avg_days_running?r.avg_days_running+'d':'–'}</td><td>${fmt$(r.total_spend)}</td><td>${r.cpa&&Number(r.cpa)>0?fmt$(r.cpa):'–'}</td></tr>`; }).join('')
      + `<tr style="font-weight:600; background:var(--paper);"><td>Grand Total</td><td>${fmtNum(total_ads)}</td><td>–</td><td>${fmt$(total_spend)}</td><td>–</td></tr>`;
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
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${groupWhere('WHERE')} GROUP BY 1, 2 ORDER BY 1, 2`;
  const tableSQL = `
    SELECT ad_id, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adset_name) AS adset_name, ANY_VALUE(ad_name) AS ad_name,
      MIN(min_date) AS launch_date, MAX(max_date) AS last_spend, ANY_VALUE(creative_link) AS preview_link,
      ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend, ROUND(ANY_VALUE(lifetime_cpa), 2) AS lifetime_cpa,
      ROUND(SUM(${CONV_EXPR}), 0) AS total_conversions
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${groupWhere('WHERE')} GROUP BY 1 ORDER BY lifetime_spend DESC`;
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
    const tbody=document.getElementById('age-table-body');
    tbody.innerHTML=tableData.map(r=>`<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmtDate(r.last_spend)}</td><td>${r.preview_link?`<a class="preview-link" href="${r.preview_link}" target="_blank">Preview</a>`:'–'}</td><td>${fmt$(r.lifetime_spend)}</td><td>${r.lifetime_cpa&&Number(r.lifetime_cpa)>0?fmt$(r.lifetime_cpa):'–'}</td><td>${fmtNum(r.total_conversions)}</td></tr>`).join('');
    hideEl('age-table-loading'); showEl('age-table');
  } catch(err){ console.error('Age error:',err); }
}

/* ── Ad Production ── */

async function loadProduction(){
  const scatterSQL = `
    SELECT ad_id, ANY_VALUE(ad_name) AS ad_name, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adset_name) AS adset_name,
      MIN(min_date) AS launch_date, ANY_VALUE(creative_link) AS creative_link,
      ROUND(ANY_VALUE(lifetime_spend), 2) AS lifetime_spend, ROUND(ANY_VALUE(lifetime_cpa), 2) AS lifetime_cpa,
      ROUND(SUM(${CONV_EXPR}), 0) AS total_conversions,
      CASE WHEN ANY_VALUE(lifetime_spend) >= ${HR_SPEND} AND ANY_VALUE(lifetime_cpa) > 0 AND ANY_VALUE(lifetime_cpa) < ${HR_CPA} THEN 'Home Run'
           WHEN ANY_VALUE(lifetime_spend) >= ${OB_SPEND} THEN 'On Base'
           WHEN ANY_VALUE(lifetime_spend) >= ${SO_SPEND} AND ANY_VALUE(lifetime_cpa) > ${SO_CPA} THEN 'Strike Out' ELSE 'Unclassified' END AS classification
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`${groupWhere('WHERE')} GROUP BY 1 ORDER BY lifetime_spend DESC`;
  const monthlySQL = `
    WITH unique_ads AS (
      SELECT ad_id, MIN(min_date) AS launch_date, ROUND(ANY_VALUE(lifetime_spend),2) AS lifetime_spend, ROUND(ANY_VALUE(lifetime_cpa),2) AS lifetime_cpa,
        ROUND(SUM(spend),2) AS period_spend, ROUND(SUM(${CONV_EXPR}),0) AS total_conversions
      FROM \`${PROJECT}.${DATASET}.${TABLE}\`${groupWhere('WHERE')} GROUP BY 1 ),
    classified AS ( SELECT *, CASE WHEN lifetime_spend>=${HR_SPEND} AND lifetime_cpa>0 AND lifetime_cpa<${HR_CPA} THEN 'Home Run' WHEN lifetime_spend>=${OB_SPEND} THEN 'On Base' WHEN lifetime_spend>=${SO_SPEND} AND lifetime_cpa>${SO_CPA} THEN 'Strike Out' ELSE 'Unclassified' END AS classification FROM unique_ads )
    SELECT FORMAT_DATE('%b %Y', launch_date) AS launch_month, DATE_TRUNC(launch_date, MONTH) AS launch_month_sort,
      COUNT(*) AS ads_launched, COUNTIF(classification='Home Run') AS home_runs, COUNTIF(classification='On Base') AS on_base, COUNTIF(classification='Strike Out') AS strike_outs,
      ROUND(SUM(period_spend),0) AS total_spend, ROUND(SAFE_DIVIDE(SUM(period_spend), NULLIF(SUM(total_conversions),0)),0) AS avg_cpa, ROUND(SUM(total_conversions),0) AS total_conversions
    FROM classified GROUP BY 1, 2 ORDER BY 2 DESC`;
  try {
    const [scatterData, monthlyData] = await Promise.all([runQuery(scatterSQL), runQuery(monthlySQL)]);
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
    scatterData.forEach(r=>{ const cpa=Number(r.lifetime_cpa)||0, spend=Number(r.lifetime_spend)||0; if(cpa>0||spend>0){ byClass[r.classification].push({x:spend,y:cpa,label:r.ad_name}); } });
    const scatterDatasets=Object.entries(byClass).map(([cls,pts])=>({ label:cls, data:pts, backgroundColor:CLASS_COLOR[cls]+'bb', borderColor:CLASS_COLOR[cls], borderWidth:1.5, pointRadius:6, pointHoverRadius:8 }));
    hideEl('scatter-loading'); showEl('scatter-wrapper');
    if(scatterChart) scatterChart.destroy();
    const topSpend=Math.max(0, ...scatterData.map(r=>Number(r.lifetime_spend)||0));
    const maxSpend=scatterMaxSpend(topSpend);
    const maxCpa=Math.max(...scatterData.filter(r=>Number(r.lifetime_cpa)>0).map(r=>Number(r.lifetime_cpa)||0),100)*1.2;
    scatterChart=new Chart(document.getElementById('scatter-chart'),{ type:'scatter', data:{ datasets:scatterDatasets },
      options:{ responsive:true, maintainAspectRatio:false,
        scales:{ x:{ title:{display:true,text:'Lifetime Spend ($)',font:{size:11}}, min:0, max:maxSpend, ticks:{callback:v=>'$'+v.toLocaleString()} }, y:{ title:{display:true,text:'Lifetime CPA ($)',font:{size:11}}, min:0, max:maxCpa, ticks:{callback:v=>'$'+v} } },
        plugins:{ legend:{position:'top',labels:{font:{size:11}}}, tooltip:{callbacks:{label:ctx=>{ const pt=ctx.raw; return [`${ctx.dataset.label}`,`Spend: $${pt.x.toLocaleString()}`,`CPA: ${pt.y>0?'$'+pt.y:'N/A'}`]; }}} } },
      plugins:[{ id:'threshold-lines', afterDraw(chart){ const ctx2=chart.ctx,xAxis=chart.scales.x,yAxis=chart.scales.y;
        const xHit=xAxis.getPixelForValue(HR_SPEND); if(xHit>=xAxis.left&&xHit<=xAxis.right){ ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle='#4a90e2'; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xHit,yAxis.top); ctx2.lineTo(xHit,yAxis.bottom); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle='#4a90e2'; ctx2.font='10px Archivo, sans-serif'; ctx2.fillText('Ad Hit ($'+HR_SPEND.toLocaleString()+')',xHit+4,yAxis.top+14); ctx2.restore(); }
        const yCpa=yAxis.getPixelForValue(HR_CPA); if(yCpa>=yAxis.top&&yCpa<=yAxis.bottom){ ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle='#727272'; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xAxis.left,yCpa); ctx2.lineTo(xAxis.right,yCpa); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle='#727272'; ctx2.font='10px Archivo, sans-serif'; ctx2.fillText('CPA Limit ($'+HR_CPA+')',xAxis.left+4,yCpa-4); ctx2.restore(); } } }] });
    const months=monthlyData.map(r=>r.launch_month).reverse();
    const adsArr=monthlyData.map(r=>Number(r.ads_launched)).reverse();
    const hrRates=monthlyData.map(r=>+(Number(r.home_runs)/Number(r.ads_launched)*100).toFixed(1)).reverse();
    const obRates=monthlyData.map(r=>+(Number(r.on_base)/Number(r.ads_launched)*100).toFixed(1)).reverse();
    const soRates=monthlyData.map(r=>+(Number(r.strike_outs)/Number(r.ads_launched)*100).toFixed(1)).reverse();
    hideEl('production-chart-loading'); showEl('production-chart-wrapper');
    if(productionChart) productionChart.destroy();
    productionChart=new Chart(document.getElementById('production-chart'),{ type:'bar', data:{ labels:months, datasets:[
      {type:'bar',label:'Ads Launched',data:adsArr,backgroundColor:'#e6e6e6',borderColor:'#b0b0b0',borderWidth:1,yAxisID:'y'},
      {type:'line',label:'Home Run Rate',data:hrRates,borderColor:'#c8ff00',backgroundColor:'transparent',borderWidth:2,pointRadius:4,yAxisID:'y2',tension:0.3},
      {type:'line',label:'On Base Rate',data:obRates,borderColor:'#4a90e2',backgroundColor:'transparent',borderWidth:2,pointRadius:4,yAxisID:'y2',tension:0.3},
      {type:'line',label:'Strike Out Rate',data:soRates,borderColor:'#fa023c',backgroundColor:'transparent',borderWidth:2,pointRadius:4,yAxisID:'y2',tension:0.3,borderDash:[4,3]} ] },
      options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{ticks:{font:{size:10}}}, y:{title:{display:true,text:'Ads Launched',font:{size:10}},ticks:{font:{size:10}}}, y2:{position:'right',title:{display:true,text:'Rate (%)',font:{size:10}},ticks:{callback:v=>v+'%',font:{size:10}},grid:{drawOnChartArea:false}} }, plugins:{ legend:{position:'top',labels:{font:{size:11}}} } } });
    const ptbody=document.getElementById('production-table-body');
    let gAds=0,gHR=0,gOB=0,gSO=0,gSpend=0,gConv=0;
    ptbody.innerHTML=monthlyData.map(r=>{ const ads=Number(r.ads_launched),hr=Number(r.home_runs),ob=Number(r.on_base),so=Number(r.strike_outs); gAds+=ads;gHR+=hr;gOB+=ob;gSO+=so;gSpend+=Number(r.total_spend);gConv+=Number(r.total_conversions);
      return `<tr><td>${r.launch_month}</td><td>${fmt$(r.total_spend)}</td><td>${ads}</td><td>${hr}</td><td>${fmtPct(hr/ads*100)}</td><td>${ob}</td><td>${fmtPct(ob/ads*100)}</td><td>${r.avg_cpa&&Number(r.avg_cpa)>0?fmt$(r.avg_cpa):'–'}</td><td>${fmtNum(r.total_conversions)}</td><td>${so}</td><td>${fmtPct(so/ads*100)}</td></tr>`; }).join('')
      + `<tr style="font-weight:600; background:var(--paper);"><td>Grand Total</td><td>${fmt$(gSpend)}</td><td>${gAds}</td><td>${gHR}</td><td>${fmtPct(gHR/gAds*100)}</td><td>${gOB}</td><td>${fmtPct(gOB/gAds*100)}</td><td>–</td><td>${fmtNum(gConv)}</td><td>${gSO}</td><td>${fmtPct(gSO/gAds*100)}</td></tr>`;
    hideEl('production-table-loading'); showEl('production-table');
    const stbody=document.getElementById('scatter-table-body');
    stbody.innerHTML=scatterData.map(r=>{ const cls=r.classification; const badgeClass=cls==='Home Run'?'badge-hr':cls==='On Base'?'badge-ob':cls==='Strike Out'?'badge-so':'badge-un';
      return `<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmt$(r.lifetime_spend)}</td><td>${r.lifetime_cpa&&Number(r.lifetime_cpa)>0?fmt$(r.lifetime_cpa):'–'}</td><td>${fmtNum(r.total_conversions)}</td><td>${r.creative_link?`<a class="preview-link" href="${r.creative_link}" target="_blank">Preview</a>`:'–'}</td><td><span class="badge ${badgeClass}">${cls}</span></td></tr>`; }).join('');
    hideEl('scatter-table-loading'); showEl('scatter-table');
  } catch(err){ console.error('Production error:',err); }
}

/* ── Ad Power Law ── */

async function loadPowerLaw(){
  const plSQL = `
    WITH ad_spend AS (
      SELECT ad_id, ANY_VALUE(campaign_name) AS campaign_name, ANY_VALUE(adset_name) AS adset_name, ANY_VALUE(ad_name) AS ad_name,
        MIN(min_date) AS launch_date, MAX(max_date) AS last_spend_date, ANY_VALUE(creative_link) AS preview_link,
        ROUND(SUM(spend),2) AS period_spend, ROUND(ANY_VALUE(lifetime_cpa),2) AS lifetime_cpa
      FROM \`${PROJECT}.${DATASET}.${TABLE}\` WHERE date_start >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)${groupWhere()} GROUP BY 1 ),
    total AS (SELECT SUM(period_spend) AS grand_total FROM ad_spend)
    SELECT ROW_NUMBER() OVER (ORDER BY a.period_spend DESC) AS rank_num, a.campaign_name, a.adset_name, a.ad_name, a.launch_date, a.last_spend_date, a.preview_link,
      a.period_spend AS spend, ROUND(a.period_spend/t.grand_total*100,2) AS spend_pct,
      ROUND(SUM(a.period_spend/t.grand_total*100) OVER (ORDER BY a.period_spend DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),2) AS rolling_pct, a.lifetime_cpa
    FROM ad_spend a, total t ORDER BY a.period_spend DESC`;
  try {
    const data=await runQuery(plSQL);
    const labels=data.map(r=>`#${r.rank_num}`), pcts=data.map(r=>Number(r.spend_pct)), rolling=data.map(r=>Number(r.rolling_pct));
    hideEl('powerlaw-chart-loading'); showEl('powerlaw-chart-wrapper');
    if(powerLawChart) powerLawChart.destroy();
    powerLawChart=new Chart(document.getElementById('powerlaw-chart'),{ type:'bar', data:{ labels, datasets:[
      {type:'bar',label:'% of Spend',data:pcts,backgroundColor:'#4b000f99',borderColor:'#4b000f',borderWidth:1,yAxisID:'y'},
      {type:'line',label:'% Rolling Cumulative',data:rolling,borderColor:'#c8ff00',backgroundColor:'transparent',borderWidth:2.5,pointRadius:3,yAxisID:'y2',tension:0.2} ] },
      options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{ticks:{font:{size:10}}}, y:{title:{display:true,text:'% of Spend',font:{size:10}},ticks:{callback:v=>v+'%'}}, y2:{position:'right',min:0,max:100,title:{display:true,text:'Cumulative %',font:{size:10}},ticks:{callback:v=>v+'%',font:{size:10}},grid:{drawOnChartArea:false}} }, plugins:{ legend:{position:'top',labels:{font:{size:11}}} } } });
    const tbody=document.getElementById('powerlaw-table-body');
    tbody.innerHTML=data.map(r=>`<tr><td class="rank-num">${r.rank_num}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.campaign_name}">${r.campaign_name}</td><td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${r.adset_name}">${r.adset_name}</td><td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${r.ad_name}">${r.ad_name}</td><td>${fmtDate(r.launch_date)}</td><td>${fmtDate(r.last_spend_date)}</td><td>${r.preview_link?`<a class="preview-link" href="${r.preview_link}" target="_blank">Preview</a>`:'–'}</td><td>${fmt$(r.spend)}</td><td>${fmtPct(r.spend_pct,2)}</td><td>${fmtPct(r.rolling_pct,2)}</td><td>${r.lifetime_cpa&&Number(r.lifetime_cpa)>0?fmt$(r.lifetime_cpa):'–'}</td></tr>`).join('');
    hideEl('powerlaw-table-loading'); showEl('powerlaw-table');
  } catch(err){ console.error('Power law error:',err); }
}
