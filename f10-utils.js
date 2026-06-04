/**
 * f10-utils.js — F10 Creative Dashboard shared utilities
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.0.0/f10-utils.js"></script>
 *
 * Expects nothing. Provides globals used by f10-weekly.js and each dashboard's monthly functions.
 */

/* Movement classification band (10% threshold) */
const BAND = 0.10;

/* Ad Production thresholds — override in dashboard config if needed */
const HR_SPEND = 5000;
const HR_CPA   = 70;
const OB_SPEND = 1000;
const SO_SPEND = 500;
const SO_CPA   = 140;

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

/* ── DOM helpers ── */
function showEl(id){ document.getElementById(id).style.display=''; }
function hideEl(id){ document.getElementById(id).style.display='none'; }
function getCSS(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

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
