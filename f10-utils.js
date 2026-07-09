/**
 * f10-utils.js — F10 Creative Dashboard shared utilities
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.5.1/f10-utils.js"></script>
 *
 * Expects nothing. Provides globals used by f10-weekly.js and each dashboard's monthly functions.
 */

/* Movement classification band (10% threshold) */
const BAND = 0.10;

/* Ad Production thresholds. Defaults below; a dashboard may override any subset
 * by defining a THRESHOLDS config object BEFORE this script loads, e.g.
 *   const THRESHOLDS = { HR_SPEND: 8000, HR_CPA: 90 };
 * (Use a config object — do NOT redeclare HR_SPEND etc directly, as that would
 * collide with these declarations in the shared global scope.)
 *
 * As of v1.5.0 the Ad Production tab also lets a user tune these live in the
 * dashboard. To support that, HR_SPEND/HR_CPA/... are mutable (let, not const)
 * so render code that reads them picks up the active value. The per-client
 * THRESHOLDS values above remain the backstop: they seed PRODUCTION_DEFAULTS
 * and resetProductionThresholds() restores them. Live edits are session-only —
 * a page reload reverts to these defaults. To change the saved defaults, edit
 * the dashboard's THRESHOLDS config. */
const _TH = (typeof THRESHOLDS !== 'undefined' && THRESHOLDS) ? THRESHOLDS : {};
const PRODUCTION_DEFAULTS = Object.freeze({
  HR_SPEND: _TH.HR_SPEND ?? 5000,
  HR_CPA:   _TH.HR_CPA   ?? 70,
  OB_SPEND: _TH.OB_SPEND ?? 1000,
  OB_CPA:   _TH.OB_CPA   ?? 100,
  SO_SPEND: _TH.SO_SPEND ?? 500,
  SO_CPA:   _TH.SO_CPA   ?? 140,
});
let HR_SPEND = PRODUCTION_DEFAULTS.HR_SPEND;
let HR_CPA   = PRODUCTION_DEFAULTS.HR_CPA;
let OB_SPEND = PRODUCTION_DEFAULTS.OB_SPEND;
let OB_CPA   = PRODUCTION_DEFAULTS.OB_CPA;
let SO_SPEND = PRODUCTION_DEFAULTS.SO_SPEND;
let SO_CPA   = PRODUCTION_DEFAULTS.SO_CPA;

/* Read the active production thresholds as a plain object. */
function getProductionThresholds(){
  return { HR_SPEND, HR_CPA, OB_SPEND, OB_CPA, SO_SPEND, SO_CPA };
}
/* Apply a subset of thresholds. Only finite, non-negative numbers are accepted;
 * anything else leaves that threshold unchanged. Returns the active set. */
function setProductionThresholds(partial){
  const next = partial || {};
  for (const k of ['HR_SPEND','HR_CPA','OB_SPEND','OB_CPA','SO_SPEND','SO_CPA']){
    if (!(k in next)) continue;
    const v = Number(next[k]);
    if (!Number.isFinite(v) || v < 0) continue;
    if (k === 'HR_SPEND') HR_SPEND = v;
    else if (k === 'HR_CPA') HR_CPA = v;
    else if (k === 'OB_SPEND') OB_SPEND = v;
    else if (k === 'OB_CPA') OB_CPA = v;
    else if (k === 'SO_SPEND') SO_SPEND = v;
    else if (k === 'SO_CPA') SO_CPA = v;
  }
  return getProductionThresholds();
}
/* Restore the per-client (or built-in) defaults. Returns the active set. */
function resetProductionThresholds(){
  ({ HR_SPEND, HR_CPA, OB_SPEND, OB_CPA, SO_SPEND, SO_CPA } = PRODUCTION_DEFAULTS);
  return getProductionThresholds();
}

/* Weekly efficiency metric definitions */
const METRICS = {
  CPA: { num: 'conv_cost_num', den: 'conv',        scale: 1,    dir: 'lower',  fmt: 'money', label: 'CPA' },
  CPC: { num: 'spend',         den: 'clicks',       scale: 1,    dir: 'lower',  fmt: 'money', label: 'CPC' },
  CPM: { num: 'spend',         den: 'impressions',  scale: 1000, dir: 'lower',  fmt: 'money', label: 'CPM' },
  CTR: { num: 'clicks',        den: 'impressions',  scale: 100,  dir: 'higher', fmt: 'pct',   label: 'CTR' },
};

/* Monthly chart palettes */
const COHORT_COLORS = ['#c8ff00','#fa023c','#4a90e2','#f5a623','#7ed321','#9b59b6','#1abc9c','#e67e22','#2ecc71','#e74c3c','#3498db','#f39c12'];
const AGE_COLORS    = { '0–14 Days': '#c8ff00', '15–90 Days': '#4a90e2', '90+ Days': '#4b000f' };
const CLASS_COLOR   = { 'Home Run': '#c8ff00', 'On Base': '#4a90e2', 'Strike Out': '#fa023c', 'Unclassified': '#b0b0b0' };

/* Ad state metadata: badge CSS class + chart colour */
const STATE_META = {
  'Scaling Winner':          { cls: 'b-scaling', color: '#7ed321' },
  'Efficient but Shrinking': { cls: 'b-shrink',  color: '#4a90e2' },
  'Fading':                  { cls: 'b-fading',  color: '#fa023c' },
  'New Entrant':             { cls: 'b-new',     color: '#9b59b6' },
  'Dropped Off':             { cls: 'b-dropped', color: '#b0b0b0' },
  'Steady':                  { cls: 'b-steady',  color: '#f5a623' },
};

/* ── Formatters ── */
function bqStr(v){ if(v==null) return null; if(typeof v==='object'&&v.value!==undefined) return String(v.value); return String(v); }
function fmt$(n){ if(n==null||n===''||isNaN(n)) return '–'; return '$'+Number(n).toLocaleString('en-AU',{maximumFractionDigits:0}); }
function fmtPct(n, dp=1){ if(n==null||isNaN(n)) return '–'; return Number(n).toFixed(dp)+'%'; }
function fmtNum(n){ if(n==null||isNaN(n)) return '–'; return Number(n).toLocaleString('en-AU',{maximumFractionDigits:0}); }
function fmtMetric(v, m){ if(v==null||isNaN(v)||!isFinite(v)) return '–'; return m.fmt==='money' ? '$'+Number(v).toLocaleString('en-AU',{maximumFractionDigits: v<10?2:0}) : Number(v).toFixed(2)+'%'; }
function fmtDate(s){ const str=bqStr(s); if(!str) return '–'; const [y,mo,d]=str.split('-').map(Number); const dt=new Date(Date.UTC(y,mo-1,d)); return dt.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}); }
function isoOffset(isoDate, days){ const [y,mo,d]=isoDate.split('-').map(Number); const dt=new Date(Date.UTC(y,mo-1,d)); dt.setUTCDate(dt.getUTCDate()+days); return dt.toISOString().slice(0,10); }

/* ── Creative-effectiveness metrics ──
 * The mart stores raw ad×day counts (video_plays, video_15s, video_p25..p100,
 * outbound_clicks, plus impressions/clicks). Rates are computed here at
 * aggregation time so windowed sums stay correct — never pre-divide then sum.
 * All view rates use impressions as the denominator: Meta logs a "play" on
 * ~every auto-play impression, so plays is not a meaningful gate and there is no
 * separate hook rate. Frequency is intentionally absent — reach overlap is
 * unknown once days are summed, so any windowed impressions/reach is wrong. */
function creativeRates(a){
  const impr = (a && a.impressions) || 0;
  const pct = (n) => impr > 0 ? ((Number(n)||0) / impr) * 100 : null;
  return {
    impressions: impr,
    hold:        pct(a && a.video_15s),    /* 15-sec views ÷ impr (thruplay proxy) */
    completion:  pct(a && a.video_p100),   /* 100% completes ÷ impr */
    ctr:         pct(a && a.clicks),
    outboundCtr: pct(a && a.outbound_clicks),
    retention: {
      p25:  pct(a && a.video_p25),
      p50:  pct(a && a.video_p50),
      p75:  pct(a && a.video_p75),
      p100: pct(a && a.video_p100),
    },
    hasVideo: ((a && a.video_plays) || 0) > 0,
  };
}

/* Per-ad creative metrics registry. Table renderers populate this keyed by
 * ad_id so the hover preview can show metrics next to the creative. */
const F10_AD_METRICS = {};
if (typeof window !== 'undefined') window.F10_AD_METRICS = F10_AD_METRICS; /* expose: const is not auto-attached to window */
function registerAdMetrics(adId, agg){ if(adId != null) F10_AD_METRICS[adId] = creativeRates(agg); }

/* Inline SVG sparkline for a 25/50/75/100 video-retention curve. Values are %
 * of impressions; scaled to the local max so the shape reads even when absolute
 * rates are low. Returns an <svg> string sized w×h. */
function retentionSparkline(ret, w, h){
  w = w || 132; h = h || 36;
  const pts = ret ? [ret.p25, ret.p50, ret.p75, ret.p100].map(v => v==null ? 0 : v) : [0,0,0,0];
  const max = Math.max(0.0001, ...pts);
  const step = w / (pts.length - 1);
  const coords = pts.map((v,i) => [ +(i*step).toFixed(1), +(h - (v/max)*(h-6) - 3).toFixed(1) ]);
  const line = coords.map((c,i) => (i?'L':'M')+c[0]+' '+c[1]).join(' ');
  const area = 'M0 '+h+' ' + coords.map(c => 'L'+c[0]+' '+c[1]).join(' ') + ' L'+w+' '+h+' Z';
  const dots = coords.map(c => `<circle cx="${c[0]}" cy="${c[1]}" r="2.2" fill="#c8ff00"/>`).join('');
  return `<svg class="f10-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`+
    `<path d="${area}" fill="rgba(200,255,0,0.13)"/>`+
    `<path d="${line}" fill="none" stroke="#c8ff00" stroke-width="1.6"/>${dots}</svg>`;
}

/* ── DOM helpers ── */
function showEl(id){ document.getElementById(id).style.display=''; }
function hideEl(id){ document.getElementById(id).style.display='none'; }
function getCSS(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

/* ── Table pagination ──
 * renderPagedTable(tbodyId, rowsHtml, pageSize=20, footerHtml='')
 * rowsHtml: array of <tr> HTML strings for data rows.
 * footerHtml: optional pinned row (e.g. Grand Total) always shown after the page. */
const _tablePages = {};
const _tableSort = {};   /* tbodyId -> { colIndex, ascending } for the active sort */
function renderPagedTable(tbodyId, rowsHtml, pageSize, footerHtml){
  pageSize = pageSize || 20;
  footerHtml = footerHtml || '';
  const tbody = document.getElementById(tbodyId);
  if(!tbody) return;
  if(!_tablePages[tbodyId] || _tablePages[tbodyId].rows !== rowsHtml){
    _tablePages[tbodyId] = { rows: rowsHtml, page: 0, pageSize: pageSize, footerHtml: footerHtml };
    /* Fresh data: reapply any active sort so the user's chosen order — and the
     * header ▲/▼ indicator — survive refreshes and filter changes. */
    if(_tableSort[tbodyId]) applyTableSort(tbodyId, true);
  }
  _tablePages[tbodyId].pageSize = pageSize;
  _tablePages[tbodyId].footerHtml = footerHtml;
  const totalRows = rowsHtml.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.max(0, Math.min(_tablePages[tbodyId].page, totalPages - 1));
  _tablePages[tbodyId].page = page;
  tbody.innerHTML = rowsHtml.slice(page * pageSize, page * pageSize + pageSize).join('') + footerHtml;
  const tableCard = tbody.closest('.table-card');
  if(!tableCard) return;
  let pager = tableCard.querySelector('.table-pagination[data-for="'+tbodyId+'"]');
  if(!pager){ pager = document.createElement('div'); pager.className='table-pagination'; pager.dataset.for=tbodyId; tableCard.appendChild(pager); }
  if(totalPages <= 1){ pager.style.display='none'; return; }
  pager.style.display='';
  pager.innerHTML = `<button class="pg-btn"${page===0?' disabled':''} data-prev>&#8592; Prev</button><span class="pg-info">Page ${page+1} of ${totalPages} &middot; ${totalRows} rows</span><button class="pg-btn"${page>=totalPages-1?' disabled':''} data-next>Next &#8594;</button>`;
  pager.querySelector('[data-prev]').addEventListener('click', ()=>{ _tablePages[tbodyId].page--; renderPagedTable(tbodyId,rowsHtml,pageSize,footerHtml); });
  pager.querySelector('[data-next]').addEventListener('click', ()=>{ _tablePages[tbodyId].page++; renderPagedTable(tbodyId,rowsHtml,pageSize,footerHtml); });
}

/* ── Group filters ──
 * Dashboards may define GROUP_FILTERS = [{ col, label }, ...] to expose top-level
 * segment dropdowns (e.g. product line, marketplace). Selections scope every query
 * across all tabs. An unset/'__all__' selection means no filter on that dimension.
 */
const GROUP_ALL = '__all__';
const groupSelections = {}; /* col -> selected value (or GROUP_ALL) */

function groupFilters(){ return (typeof GROUP_FILTERS !== 'undefined' && Array.isArray(GROUP_FILTERS)) ? GROUP_FILTERS : []; }

/* SQL-escape a value for inlining inside single quotes (double any single quotes). */
function sqlQuote(v){ return "'" + String(v).replace(/'/g, "''") + "'"; }

/* Build a SQL fragment for the active group selections.
 * Pass { lead:'AND' } (default) to prefix each clause, or { lead:'WHERE' } to
 * start a WHERE block (subsequent clauses still use AND). Returns '' when nothing
 * is selected. */
function groupClauses(){
  return groupFilters()
    .filter(f => groupSelections[f.col] && groupSelections[f.col] !== GROUP_ALL)
    .map(f => `${f.col} = ${sqlQuote(groupSelections[f.col])}`);
}
function groupWhere(lead){
  const parts = groupClauses();
  if(!parts.length) return '';
  const prefix = lead === 'WHERE' ? 'WHERE' : 'AND';
  return ' ' + prefix + ' ' + parts.join(' AND ');
}

/* ── Display config: conversion label + "How to read" tab notes ──
 * Optional, all defaulting to today's behaviour so existing dashboards are
 * unchanged (same guarded-global idiom as GROUP_FILTERS above). A dashboard may
 * define, BEFORE the scripts load:
 *   CONV_LABEL         — singular noun for what a "conversion" is for this
 *                        account (e.g. 'Purchase', 'Lead'). Default 'Conversion'.
 *                        Used ONLY in the how-to-read note copy — it does NOT
 *                        change any table header, tile, or dropdown label.
 *   CONV_LABEL_PLURAL  — plural form. Defaults to CONV_LABEL + 's'.
 *   SHOW_HOW_TO_NOTES  — when true, renderLayout() shows a plain-English
 *                        "How to read this tab" note (plus the conversion
 *                        definition) at the top of every tab. Default false.
 */
function convLabel(){ return (typeof CONV_LABEL !== 'undefined' && CONV_LABEL) ? String(CONV_LABEL) : 'Conversion'; }
function convLabelPlural(){
  if (typeof CONV_LABEL_PLURAL !== 'undefined' && CONV_LABEL_PLURAL) return String(CONV_LABEL_PLURAL);
  const s = convLabel();
  return /s$/i.test(s) ? s : s + 's';
}
function showHowToNotes(){ return (typeof SHOW_HOW_TO_NOTES !== 'undefined') && SHOW_HOW_TO_NOTES === true; }

/* ── BQ fetch — expects BQ_FUNCTION to be defined by the dashboard ── */
async function runQuery(sql){ const r=await fetch(BQ_FUNCTION,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:sql})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }

/* ── Aggregation helpers ── */
function emptyAgg(){ return { spend:0, impressions:0, clicks:0, conv:0, conv_cost_num:0 }; }
function addRow(a, r){ a.spend+=r.spend; a.impressions+=r.impressions; a.clicks+=r.clicks; a.conv+=r.conv; a.conv_cost_num+=r.conv_cost_num; }
function metricValue(agg, m){ const den=agg[m.den]; if(!den) return null; return (agg[m.num]/den)*m.scale; }

/* ── Noise floor ── */
function passesFloor(agg, c){
  if(c.floorMode==='cpaMult') return agg.spend >= c.targetCpa * c.mult;
  if(c.floorMode==='fixed')   return agg.spend >= c.fixedSpend;
  if(c.floorMode==='conv')    return agg.conv  >= c.minConv;
  return true;
}

/* ── Ad state classifier ── */
function classify(ad, c){
  const m=c.metric;
  const qCur=passesFloor(ad.cur,c), qPri=passesFloor(ad.pri,c);
  const sCur=ad.cur.spend, sPri=ad.pri.spend;
  const mCur=metricValue(ad.cur,m), mPri=metricValue(ad.pri,m);
  let improvePct=null;
  if(mCur!=null&&mPri!=null&&mPri!==0){ improvePct=(m.dir==='lower')?(mPri-mCur)/mPri:(mCur-mPri)/mPri; }
  let state;
  if(sPri<1e-6&&sCur>0) state='New Entrant';
  else if(sCur<1e-6&&qPri) state='Dropped Off';
  else if(mCur==null&&sCur>0) state='Fading';
  else {
    const spendChg=sPri>0?(sCur-sPri)/sPri:0;
    const spendUp=spendChg>BAND, spendDown=spendChg<-BAND;
    const mImp=improvePct!=null&&improvePct>BAND, mWorse=improvePct!=null&&improvePct<-BAND;
    if(spendUp&&!mWorse) state='Scaling Winner';
    else if(mImp&&spendDown) state='Efficient but Shrinking';
    else if(mWorse) state='Fading';
    else state='Steady';
  }
  return { ...ad, qCur, qPri, sCur, sPri, mCur, mPri, improvePct, state,
    spendDelta: sCur-sPri,
    metricDelta: (mCur!=null&&mPri!=null) ? mCur-mPri : null };
}

/* ── Scatter axis ── */
/* Upper bound for the Production spend axis, as a function of the top spender:
 * if the biggest spender clears the Home Run threshold, give it $1,000 of
 * headroom; otherwise frame the chart around the threshold itself. */
function scatterMaxSpend(topSpend){
  return topSpend > HR_SPEND ? topSpend + 1000 : HR_SPEND * 1.2;
}

/* ── Universal table sorting ──────────────────────────────────────────────
 * Click any column header to sort that table; click again to reverse. On the
 * first click numeric and date columns sort high→low (newest first) and text
 * columns A→Z. A ▲/▼ indicator marks the active column. Wired once via event
 * delegation so it covers every table, including those re-rendered after data
 * loads. Blank / "—" / "–" cells always sink to the bottom.
 *
 * For paginated tables the FULL dataset (_tablePages[id].rows) is sorted, not
 * just the visible page, then the table jumps back to page 1. The active sort
 * is remembered per table so it survives data refreshes. */
const MONTH_IDX = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

/* Classify a cell as date, number, or text so each sorts correctly. Dates use
 * the formats this library renders: "12 Jun 2026", "Jun 2026", or ISO. */
function cellSortValue(cell){
  const txt = (cell ? cell.textContent : '').trim();
  const empty = txt === '' || txt === '—' || txt === '–';
  let isDate = false, time = 0;
  if(!empty){
    let m = txt.match(/^(?:(\d{1,2})\s+)?([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})$/); /* day-month-year or month-year */
    if(m && MONTH_IDX[m[2].toLowerCase()] !== undefined){
      isDate = true; time = Date.UTC(+m[3], MONTH_IDX[m[2].toLowerCase()], m[1] ? +m[1] : 1);
    } else if((m = txt.match(/^(\d{4})-(\d{2})-(\d{2})$/))){          /* ISO yyyy-mm-dd */
      isDate = true; time = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    }
  }
  /* Numeric only if the whole cell is a number (allowing $ , % . - and parens),
   * so "12 Jun 2026" is never mistaken for 122026. */
  const numericLike = !empty && !isDate && /^[-+]?\$?\(?-?[\d,]*\.?\d+\)?%?$/.test(txt.replace(/\s/g, ''));
  const num = numericLike ? parseFloat(txt.replace(/[^0-9.\-]/g, '')) : NaN;
  const isNum = numericLike && !isNaN(num);
  return { txt, empty, isDate, time, num, isNum };
}

function compareSortValues(a, b, ascending){
  if(a.empty && b.empty) return 0;
  if(a.empty) return 1;            /* blanks always last, regardless of direction */
  if(b.empty) return -1;
  let cmp;
  if(a.isDate && b.isDate) cmp = a.time - b.time;
  else if(a.isNum && b.isNum) cmp = a.num - b.num;
  else cmp = a.txt.localeCompare(b.txt, undefined, { numeric: true, sensitivity: 'base' });
  return ascending ? cmp : -cmp;
}

/* First-click direction: text → ascending (A→Z); numbers/dates → descending. */
function defaultAscending(sample){ return !(sample.isNum || sample.isDate); }

/* Sort an array of <tr> HTML strings by a column. Cell values are parsed once. */
function sortRowsHtml(rowsHtml, colIndex, ascending){
  const holder = document.createElement('tbody');
  const keyed = rowsHtml.map(html => {
    holder.innerHTML = html;
    const tr = holder.rows[0];
    return { html, key: cellSortValue(tr ? tr.cells[colIndex] : null) };
  });
  keyed.sort((a, b) => compareSortValues(a.key, b.key, ascending));
  return keyed.map(k => k.html);
}

/* Sort the full dataset behind a paginated table; re-render from page 1 unless
 * skipRender (used when called mid-render to avoid recursion). */
function applyTableSort(tbodyId, skipRender){
  const st = _tablePages[tbodyId], s = _tableSort[tbodyId];
  if(!st || !s) return;
  const sorted = sortRowsHtml(st.rows, s.colIndex, s.ascending);
  st.rows.length = 0;
  for(let i = 0; i < sorted.length; i++) st.rows.push(sorted[i]);
  st.page = 0;
  if(!skipRender) renderPagedTable(tbodyId, st.rows, st.pageSize, st.footerHtml);
}

/* DOM fallback for tables that don't use pagination. */
function sortTableByColumn(table, colIndex, ascending){
  const tbody = table.tBodies[0];
  if(!tbody) return;
  const rows = Array.from(tbody.rows).filter(r => r.cells.length > colIndex);
  rows.sort((ra, rb) => compareSortValues(cellSortValue(ra.cells[colIndex]), cellSortValue(rb.cells[colIndex]), ascending));
  rows.forEach(r => tbody.appendChild(r));
}

function initTableSorting(){
  if(window.__f10SortWired) return;
  window.__f10SortWired = true;
  document.addEventListener('click', (e) => {
    const th = e.target.closest('thead th');
    if(!th) return;
    const table = th.closest('table');
    if(!table || !table.tBodies[0]) return;
    const headRow = th.parentElement;
    const colIndex = Array.prototype.indexOf.call(headRow.cells, th);
    if(colIndex < 0) return;
    const tbody = table.tBodies[0];
    const paged = !!(tbody.id && _tablePages[tbody.id]);

    /* toggle direction; first click uses the column-type default */
    const prev = th.getAttribute('data-sort-dir');
    let ascending;
    if(prev === 'asc') ascending = false;
    else if(prev === 'desc') ascending = true;
    else {
      let sample;
      if(paged && _tablePages[tbody.id].rows.length){
        const holder = document.createElement('tbody');
        holder.innerHTML = _tablePages[tbody.id].rows[0];
        sample = cellSortValue(holder.rows[0] ? holder.rows[0].cells[colIndex] : null);
      } else if(tbody.rows.length){
        sample = cellSortValue(tbody.rows[0].cells[colIndex]);
      } else return;
      ascending = defaultAscending(sample);
    }

    if(paged){
      _tableSort[tbody.id] = { colIndex, ascending };  /* sort the whole dataset, then page 1 */
      applyTableSort(tbody.id);
    } else {
      sortTableByColumn(table, colIndex, ascending);
    }

    headRow.querySelectorAll('th').forEach(h => {
      h.removeAttribute('data-sort-dir');
      h.classList.remove('sorted-asc', 'sorted-desc');
    });
    th.setAttribute('data-sort-dir', ascending ? 'asc' : 'desc');
    th.classList.add(ascending ? 'sorted-asc' : 'sorted-desc');
  });
}
