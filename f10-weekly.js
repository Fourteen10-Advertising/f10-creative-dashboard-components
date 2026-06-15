/**
 * f10-weekly.js — F10 Creative Dashboard weekly engine
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.5.1/f10-weekly.js"></script>
 *
 * Must be loaded AFTER f10-utils.js.
 *
 * Expects these globals set by the dashboard before this script runs:
 *   BQ_FUNCTION  — Netlify function path, e.g. '/.netlify/functions/bq'
 *   PROJECT      — GCP project ID
 *   DATASET      — BigQuery dataset name
 *   TABLE        — BigQuery table name
 *   CONV_EXPR    — SQL expression for conversions, e.g. 'purchase' or
 *                  '(customer_application_buying + broker_application_details)'
 *
 * Expects this function defined by each dashboard (called when a monthly tab
 * is first opened — each dashboard provides its own SQL):
 *   loadMonthlyTab(tab)
 *
 * Entrypoint — call after DOMContentLoaded:
 *   wireControls();
 *   initWeekly();
 */

let WIN     = null;
let MAXDATE = null;
let charts  = {};

const WEEKLY_TABS = ['summary', 'board', 'map'];
const tabTitles = {
  summary:    'Weekly Summary',
  board:      'Movement Board',
  map:        'Movement Map',
  powerlaw:   'Ad Power Law',
  production: 'Ad Production',
  decay:      'Ad Decay',
  age:        'Ad Age',
};
const loadedTabs = {};
let activeTab = 'summary';
const isWeekly = t => WEEKLY_TABS.includes(t);

/* ── Data fetching ── */

async function fetchMaxDate(){
  const rows = await runQuery(
    `SELECT FORMAT_DATE('%Y-%m-%d', MAX(date_start)) AS max_date FROM \`${PROJECT}.${DATASET}.${TABLE}\``
  );
  return rows && rows[0] ? bqStr(rows[0].max_date) : null;
}

async function fetchWindows(c){
  const curStart=isoOffset(c.end,-(c.length-1)), curEnd=c.end;
  const priEnd=isoOffset(curStart,-1), priStart=isoOffset(priEnd,-(c.length-1));
  const sql = `
    SELECT ad_id,
      ANY_VALUE(ad_name)       AS ad_name,
      ANY_VALUE(campaign_name) AS campaign_name,
      ANY_VALUE(adset_name)    AS adset_name,
      ANY_VALUE(creative_link) AS creative_link,
      SUM(IF(date_start BETWEEN '${curStart}' AND '${curEnd}', spend, 0))         AS cur_spend,
      SUM(IF(date_start BETWEEN '${curStart}' AND '${curEnd}', impressions, 0))   AS cur_impressions,
      SUM(IF(date_start BETWEEN '${curStart}' AND '${curEnd}', clicks, 0))        AS cur_clicks,
      SUM(IF(date_start BETWEEN '${curStart}' AND '${curEnd}', ${CONV_EXPR}, 0))  AS cur_conv,
      SUM(IF(date_start BETWEEN '${priStart}' AND '${priEnd}', spend, 0))         AS pri_spend,
      SUM(IF(date_start BETWEEN '${priStart}' AND '${priEnd}', impressions, 0))   AS pri_impressions,
      SUM(IF(date_start BETWEEN '${priStart}' AND '${priEnd}', clicks, 0))        AS pri_clicks,
      SUM(IF(date_start BETWEEN '${priStart}' AND '${priEnd}', ${CONV_EXPR}, 0))  AS pri_conv
    FROM \`${PROJECT}.${DATASET}.${TABLE}\`
    WHERE date_start BETWEEN '${priStart}' AND '${curEnd}'${groupWhere()}
    GROUP BY ad_id
    HAVING cur_spend > 0 OR pri_spend > 0`;
  const rows = await runQuery(sql);
  const ads = {};
  rows.forEach(r => {
    const cs=Number(r.cur_spend)||0, ps=Number(r.pri_spend)||0;
    ads[r.ad_id] = {
      ad_id: r.ad_id, ad_name: r.ad_name, campaign_name: r.campaign_name,
      adset_name: r.adset_name, creative_link: r.creative_link,
      cur: { spend:cs, impressions:Number(r.cur_impressions)||0, clicks:Number(r.cur_clicks)||0, conv:Number(r.cur_conv)||0, conv_cost_num:cs },
      pri: { spend:ps, impressions:Number(r.pri_impressions)||0, clicks:Number(r.pri_clicks)||0, conv:Number(r.pri_conv)||0, conv_cost_num:ps },
    };
  });
  return { ads, curStart, curEnd, priStart, priEnd };
}

/* ── Group filters (top-level segment dropdowns, apply to all tabs) ── */

/* Render one dropdown per GROUP_FILTERS entry into #ctrl-groups, then populate
 * each with its distinct values. Selections re-scope every query across all tabs. */
async function initGroupFilters(){
  const host = document.getElementById('ctrl-groups');
  const filters = groupFilters();
  if(!host || !filters.length) return;
  host.innerHTML = filters.map(f =>
    `<div class="ctrl"><label>${f.label}</label>
       <select id="ctrl-group-${f.col}" data-col="${f.col}">
         <option value="${GROUP_ALL}" selected>All</option>
       </select>
     </div>`
  ).join('');
  filters.forEach(f => {
    groupSelections[f.col] = GROUP_ALL;
    document.getElementById(`ctrl-group-${f.col}`)
      .addEventListener('change', onGroupChange);
  });
  await Promise.all(filters.map(async f => {
    try {
      const rows = await runQuery(
        `SELECT DISTINCT ${f.col} AS v FROM \`${PROJECT}.${DATASET}.${TABLE}\` WHERE ${f.col} IS NOT NULL ORDER BY v`
      );
      const sel = document.getElementById(`ctrl-group-${f.col}`);
      rows.forEach(r => { const v = bqStr(r.v); if(v){ const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); } });
    } catch(err){ console.error('Group filter load error ('+f.col+'):', err); }
  }));
}

/* A group selection changed: re-query the active view and invalidate cached
 * monthly tabs so they re-query when next opened. fetchMaxDate stays global. */
function onGroupChange(e){
  groupSelections[e.target.dataset.col] = e.target.value;
  Object.keys(loadedTabs).forEach(t => { if(!isWeekly(t)) delete loadedTabs[t]; });
  loadWindows();
  if(!isWeekly(activeTab) && typeof loadMonthlyTab === 'function') loadMonthlyTab(activeTab);
}

/* Controls-bar visibility: weekly-only controls show on weekly tabs; the bar
 * itself stays visible on every tab when group filters exist. */
function applyControlsVisibility(){
  const showWeekly = isWeekly(activeTab);
  const showBar = showWeekly || groupFilters().length > 0;
  document.getElementById('controls-bar').style.display = showBar ? 'flex' : 'none';
  const wc = document.getElementById('weekly-controls');
  if(wc) wc.style.display = showWeekly ? 'flex' : 'none';
}

/* ── Controls ── */

function getControls(){
  const length    = parseInt(document.getElementById('ctrl-length').value, 10);
  const end       = document.getElementById('ctrl-enddate').value || MAXDATE;
  const metricKey = document.getElementById('ctrl-metric').value;
  const floorMode = document.querySelector('#ctrl-floor button.active').dataset.floor;
  return { length, end, metricKey, metric: METRICS[metricKey], floorMode,
    targetCpa:  Number(document.getElementById('ctrl-targetcpa').value)  || 0,
    mult:       Number(document.getElementById('ctrl-mult').value)       || 0,
    fixedSpend: Number(document.getElementById('ctrl-fixedspend').value) || 0,
    minConv:    Number(document.getElementById('ctrl-minconv').value)    || 0 };
}

/* ── Load + render orchestration ── */

async function loadWindows(){
  try {
    showEl('summary-loading'); hideEl('summary-body');
    showEl('board-loading');   hideEl('board-table');
    showEl('map-loading');     hideEl('map-wrapper');
    WIN = await fetchWindows(getControls());
    renderWeekly();
  } catch(err) { console.error(err); document.getElementById('summary-loading').innerHTML='Error loading data: '+err.message; }
}

function renderWeekly(){
  if(!WIN) return;
  const c          = getControls();
  const classified = Object.values(WIN.ads).map(a => classify(a, c));
  const movers     = classified.filter(a => a.qCur || a.qPri);
  const windowTxt  = `Current: ${fmtDate(WIN.curStart)} – ${fmtDate(WIN.curEnd)} vs Prior: ${fmtDate(WIN.priStart)} – ${fmtDate(WIN.priEnd)} · Metric: ${c.metric.label} · ${movers.length} ads cleared the floor`;
  ['summary-window-note','board-window-note','map-window-note'].forEach(id => document.getElementById(id).textContent = windowTxt);
  renderSummary(classified, c, WIN);
  renderBoard(movers, c);
  renderMap(movers, c);
  document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
}

/* ── Weekly Summary ── */

function renderSummary(all, c, w){
  const m   = c.metric;
  const tot = { cur: emptyAgg(), pri: emptyAgg() };
  all.forEach(a => { ['spend','impressions','clicks','conv','conv_cost_num'].forEach(k => { tot.cur[k]+=a.cur[k]; tot.pri[k]+=a.pri[k]; }); });
  const mCur=metricValue(tot.cur,m), mPri=metricValue(tot.pri,m);

  function deltaHtml(cur, pri, lowerBetter){
    if(pri===0||pri==null) return `<div class="scorecard-delta delta-flat">no prior</div>`;
    const chg=(cur-pri)/pri*100; const good=lowerBetter?chg<0:chg>0;
    const cls=Math.abs(chg)<0.5?'delta-flat':(good?'delta-good':'delta-bad');
    const arrow=chg>0?'▲':(chg<0?'▼':'■');
    return `<div class="scorecard-delta ${cls}">${arrow} ${Math.abs(chg).toFixed(1)}% vs prior</div>`;
  }

  const cards = [
    { label: 'Spend',            val: fmt$(tot.cur.spend),           d: deltaHtml(tot.cur.spend,       tot.pri.spend,       false) },
    { label: 'Conversions',      val: fmtNum(tot.cur.conv),          d: deltaHtml(tot.cur.conv,        tot.pri.conv,        false) },
    { label: 'Impressions',      val: fmtNum(tot.cur.impressions),   d: deltaHtml(tot.cur.impressions, tot.pri.impressions, false) },
    { label: 'Blended '+m.label, val: fmtMetric(mCur,m),            d: deltaHtml(mCur,                mPri,                m.dir==='lower') },
  ];
  document.getElementById('summary-scorecards').innerHTML = cards.map(c2 =>
    `<div class="scorecard"><div class="scorecard-label">${c2.label}</div><div class="scorecard-value">${c2.val}</div>${c2.d}</div>`
  ).join('');

  const denTotPri = tot.pri[m.den]; let efficiency = 0;
  all.forEach(a => { const dPri=a.pri[m.den],dCur=a.cur[m.den]; if(dPri>0&&dCur>0){ const wPri=dPri/denTotPri; const Mp=(a.pri[m.num]/dPri)*m.scale, Mc=(a.cur[m.num]/dCur)*m.scale; efficiency+=wPri*(Mc-Mp); } });
  const total = (mCur!=null&&mPri!=null) ? (mCur-mPri) : 0;
  const mixFlow = total - efficiency;
  drawDecomp(mPri||0, mixFlow, efficiency, mCur||0, m);

  const lowerBetter = m.dir==='lower';
  function effWord(v){ if(Math.abs(v)<1e-9) return 'no change'; const worse=lowerBetter?v>0:v<0; return (worse?'worsened':'improved')+' the metric by '+fmtMetric(Math.abs(v),m); }
  document.getElementById('decomp-note').innerHTML =
    `<strong>Efficiency effect:</strong> creatives themselves ${effWord(efficiency)}. <strong>Mix &amp; flow:</strong> budget reallocation + entrants/exits ${effWord(mixFlow)}. These sum to the total blended ${m.label} change of ${fmtMetric(total,m)}.`;

  hideEl('summary-loading'); showEl('summary-body');
}

function drawDecomp(prior, mix, eff, current, m){
  const lowerBetter = m.dir==='lower';
  function colorFor(v){ const worse=lowerBetter?v>0:v<0; return worse?getCSS('--bad'):getCSS('--good'); }
  const after1  = prior + mix;
  const labels  = ['Prior','Mix & flow','Efficiency','Current'];
  const ranges  = [[0,prior],[Math.min(prior,after1),Math.max(prior,after1)],[Math.min(after1,current),Math.max(after1,current)],[0,current]];
  const colors  = [getCSS('--young-blood'),colorFor(mix),colorFor(eff),getCSS('--young-blood')];
  if(charts.decomp) charts.decomp.destroy();
  charts.decomp = new Chart(document.getElementById('decomp-chart'), { type:'bar',
    data:{ labels, datasets:[{ data:ranges, backgroundColor:colors, borderColor:colors, borderWidth:1 }] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>{ const i=ctx.dataIndex; if(i===0) return 'Prior blended: '+fmtMetric(prior,m); if(i===3) return 'Current blended: '+fmtMetric(current,m); const v=i===1?mix:eff; return labels[i]+': '+(v>=0?'+':'')+fmtMetric(v,m); } } } },
      scales:{ y:{ title:{display:true,text:m.label,font:{size:10}}, ticks:{ callback:v=> m.fmt==='money'?'$'+v:v+'%' } } } } });
}

/* ── Movement Board ── */

function renderBoard(movers, c){
  const m = c.metric;
  document.getElementById('board-m-head').textContent = m.label;
  const order = ['Scaling Winner','Fading','New Entrant','Efficient but Shrinking','Dropped Off','Steady'];
  document.getElementById('board-legend').innerHTML = order.map(s =>
    `<span class="li"><span class="dot" style="background:${STATE_META[s].color}"></span>${s}</span>`
  ).join('');
  const rows = movers.slice().sort((a,b) => b.sCur - a.sCur);
  const body = document.getElementById('board-body');
  if(!rows.length){
    body.innerHTML = `<tr><td colspan="9" class="no-data">No ads cleared the noise floor in this window. Lower the floor or widen the window.</td></tr>`;
  } else {
    renderPagedTable('board-body', rows.map(a => {
      const sm=STATE_META[a.state], sd=a.spendDelta;
      const sdCls=Math.abs(sd)<1?'delta-flat':(sd>0?'delta-good':'delta-bad');
      let mdHtml='–';
      if(a.metricDelta!=null){ const worse=m.dir==='lower'?a.metricDelta>0:a.metricDelta<0; const cls=Math.abs(a.metricDelta)<1e-6?'delta-flat':(worse?'delta-bad':'delta-good'); mdHtml=`<span class="${cls}">${a.metricDelta>0?'+':''}${fmtMetric(a.metricDelta,m)}</span>`; }
      return `<tr>
        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;" title="${a.ad_name||''}">${a.ad_name||'–'}<br><span style="color:var(--grey);font-size:10px;">${a.campaign_name||''}</span></td>
        <td><span class="badge ${sm.cls}">${a.state}</span></td>
        <td class="num">${fmt$(a.sCur)}</td>
        <td class="num delta-cell ${sdCls}">${sd>0?'+':''}${fmt$(sd)}</td>
        <td class="num">${fmtMetric(a.mCur,m)}</td>
        <td class="num delta-cell">${mdHtml}</td>
        <td class="num">${fmtNum(a.cur.conv)}</td>
        <td class="num">${fmtNum(a.cur.impressions)}</td>
        <td>${a.creative_link?`<a class="preview-link" href="${a.creative_link}" target="_blank">View</a>`:'–'}</td>
      </tr>`;
    }));
  }
  document.getElementById('board-title').textContent = `Ad Movement — ${rows.length} ads`;
  hideEl('board-loading'); showEl('board-table');
}

/* ── Movement Map ── */

function renderMap(movers, c){
  const m   = c.metric;
  const pts = movers.filter(a => a.improvePct!=null && a.sCur>0);
  const byState = {};
  pts.forEach(a => { (byState[a.state]=byState[a.state]||[]).push({ x:a.sCur, y:a.improvePct*100, r:0, _spend:a.sCur, _name:a.ad_name, _state:a.state }); });
  const maxSpend   = Math.max(1, ...pts.map(p => p.sCur));
  const datasets   = Object.entries(byState).map(([s,arr]) => ({
    label: s,
    data:  arr.map(p => ({...p, r: 6+22*Math.sqrt(p._spend/maxSpend)})),
    backgroundColor: STATE_META[s].color+'bb',
    borderColor:     STATE_META[s].color,
    borderWidth: 1.5,
  }));
  hideEl('map-loading'); showEl('map-wrapper');
  if(charts.map) charts.map.destroy();
  if(!pts.length){
    document.getElementById('map-wrapper').innerHTML='<div class="no-data">No ads with a comparable metric in both windows. New entrants and zero-conversion ads appear on the Board instead.</div>';
    return;
  }
  document.getElementById('map-wrapper').innerHTML='<canvas id="map-chart"></canvas>';
  charts.map = new Chart(document.getElementById('map-chart'), { type:'bubble', data:{ datasets },
    options:{ responsive:true, maintainAspectRatio:false,
      scales:{
        x:{ title:{display:true,text:'Current window spend ($)',font:{size:11}}, min:0, ticks:{callback:v=>'$'+v.toLocaleString()} },
        y:{ title:{display:true,text:`${m.label} change vs prior (%, up = better)`,font:{size:11}}, ticks:{callback:v=>v+'%'} },
      },
      plugins:{ legend:{position:'top',labels:{font:{size:11}}}, tooltip:{ callbacks:{ label:ctx=>{ const p=ctx.raw; return [p._name||'', p._state, `Spend: $${p._spend.toLocaleString()}`, `${m.label} change: ${p.y>0?'+':''}${p.y.toFixed(1)}%`]; } } } } },
    plugins:[{ id:'zeroLine', afterDraw(chart){ const yA=chart.scales.y,xA=chart.scales.x; const y0=yA.getPixelForValue(0); if(y0>=yA.top&&y0<=yA.bottom){ const ctx2=chart.ctx; ctx2.save(); ctx2.setLineDash([5,4]); ctx2.strokeStyle='#727272'; ctx2.lineWidth=1.5; ctx2.beginPath(); ctx2.moveTo(xA.left,y0); ctx2.lineTo(xA.right,y0); ctx2.stroke(); ctx2.setLineDash([]); ctx2.fillStyle='#727272'; ctx2.font='10px Archivo'; ctx2.fillText('no change',xA.left+4,y0-4); ctx2.restore(); } } }] });
}

/* ── Tab system ── */

function selectTab(tab){
  document.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
  document.getElementById('page-title').textContent = tabTitles[tab];
  activeTab = tab;
  applyControlsVisibility();
  if(!isWeekly(tab) && !loadedTabs[tab]) loadMonthlyTab(tab);
}

/* ── Controls wiring ── */

function wireControls(){
  /* Window length / end date = new server query */
  ['ctrl-length','ctrl-enddate'].forEach(id =>
    document.getElementById(id).addEventListener('change', loadWindows)
  );
  /* Metric / noise floor = client-side re-render only */
  ['ctrl-metric','ctrl-targetcpa','ctrl-mult','ctrl-fixedspend','ctrl-minconv'].forEach(id =>
    document.getElementById(id).addEventListener('change', renderWeekly)
  );
  document.querySelectorAll('#ctrl-floor button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#ctrl-floor button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.floor-inputs > div').forEach(d => d.classList.remove('show'));
    document.getElementById('floor-'+b.dataset.floor).classList.add('show');
    renderWeekly();
  }));
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if(isWeekly(activeTab)) initWeekly(); else { delete loadedTabs[activeTab]; loadMonthlyTab(activeTab); }
  });
  document.querySelectorAll('.nav-link').forEach(link =>
    link.addEventListener('click', e => { e.preventDefault(); selectTab(link.dataset.tab); })
  );
}

/* ── Boot ── */

async function initWeekly(){
  try {
    document.getElementById('controls-bar').style.display = 'none';
    await initGroupFilters();
    MAXDATE = await fetchMaxDate();
    const ed = document.getElementById('ctrl-enddate');
    if(MAXDATE){ ed.value = MAXDATE; ed.max = MAXDATE; }
    applyControlsVisibility();
    await loadWindows();
  } catch(err) {
    console.error(err);
    document.getElementById('summary-loading').innerHTML = 'Error loading data: ' + err.message;
  }
}
