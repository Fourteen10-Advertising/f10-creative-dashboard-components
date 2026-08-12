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
  /* ROAS Ad Production bands (used when TARGET_METRIC='roas'). Polarity is
   * inverted vs CPA — higher ROAS is better — so Home Run is a FLOOR to clear
   * and Strike Out a ceiling to fall under. Spend floors are shared with CPA
   * (HR_SPEND/OB_SPEND/SO_SPEND) and are not duplicated. */
  HR_ROAS:  _TH.HR_ROAS  ?? 4,
  OB_ROAS:  _TH.OB_ROAS  ?? 2,
  SO_ROAS:  _TH.SO_ROAS  ?? 1,
});
let HR_SPEND = PRODUCTION_DEFAULTS.HR_SPEND;
let HR_CPA   = PRODUCTION_DEFAULTS.HR_CPA;
let OB_SPEND = PRODUCTION_DEFAULTS.OB_SPEND;
let OB_CPA   = PRODUCTION_DEFAULTS.OB_CPA;
let SO_SPEND = PRODUCTION_DEFAULTS.SO_SPEND;
let SO_CPA   = PRODUCTION_DEFAULTS.SO_CPA;
let HR_ROAS  = PRODUCTION_DEFAULTS.HR_ROAS;
let OB_ROAS  = PRODUCTION_DEFAULTS.OB_ROAS;
let SO_ROAS  = PRODUCTION_DEFAULTS.SO_ROAS;

/* The threshold keys exposed for the ACTIVE target metric. Spend floors are
 * always included; the efficiency band is CPA (lower-is-better) in CPA mode or
 * ROAS (higher-is-better) in ROAS mode. In CPA mode this is exactly the legacy
 * key set, so existing dashboards see no change. */
function _thresholdKeys(){
  return targetMetric() === 'roas'
    ? ['HR_SPEND','HR_ROAS','OB_SPEND','OB_ROAS','SO_SPEND','SO_ROAS']
    : ['HR_SPEND','HR_CPA','OB_SPEND','OB_CPA','SO_SPEND','SO_CPA'];
}

/* Read the active production thresholds as a plain object. Only the active
 * metric's bands are surfaced (CPA bands in CPA mode, ROAS bands in ROAS mode);
 * the shared spend floors are always present. */
function getProductionThresholds(){
  const all = { HR_SPEND, HR_CPA, OB_SPEND, OB_CPA, SO_SPEND, SO_CPA, HR_ROAS, OB_ROAS, SO_ROAS };
  const out = {};
  for (const k of _thresholdKeys()) out[k] = all[k];
  return out;
}
/* Apply a subset of thresholds. Only finite, non-negative numbers are accepted;
 * anything else leaves that threshold unchanged. Accepts both CPA and ROAS band
 * keys so a caller can set either metric's bands regardless of the active one.
 * Returns the active set. */
function setProductionThresholds(partial){
  const next = partial || {};
  for (const k of ['HR_SPEND','HR_CPA','OB_SPEND','OB_CPA','SO_SPEND','SO_CPA','HR_ROAS','OB_ROAS','SO_ROAS']){
    if (!(k in next)) continue;
    const v = Number(next[k]);
    if (!Number.isFinite(v) || v < 0) continue;
    if (k === 'HR_SPEND') HR_SPEND = v;
    else if (k === 'HR_CPA') HR_CPA = v;
    else if (k === 'OB_SPEND') OB_SPEND = v;
    else if (k === 'OB_CPA') OB_CPA = v;
    else if (k === 'SO_SPEND') SO_SPEND = v;
    else if (k === 'SO_CPA') SO_CPA = v;
    else if (k === 'HR_ROAS') HR_ROAS = v;
    else if (k === 'OB_ROAS') OB_ROAS = v;
    else if (k === 'SO_ROAS') SO_ROAS = v;
  }
  return getProductionThresholds();
}
/* Restore the per-client (or built-in) defaults. Returns the active set. */
function resetProductionThresholds(){
  ({ HR_SPEND, HR_CPA, OB_SPEND, OB_CPA, SO_SPEND, SO_CPA, HR_ROAS, OB_ROAS, SO_ROAS } = PRODUCTION_DEFAULTS);
  return getProductionThresholds();
}

/* ── Target metric selection (config-selectable, backward-compatible) ──
 * A dashboard may pick which efficiency metric headlines the account by defining,
 * BEFORE the scripts load (same guarded-global idiom as CONV_EXPR/GROUP_FILTERS):
 *   TARGET_METRIC — 'cpa' (default) or 'roas'. Unset ⇒ 'cpa', so every existing
 *                   dashboard behaves exactly as before.
 *   REVENUE_EXPR  — SQL expression for the mart's GATED revenue column
 *                   (default 'revenue'). ROAS must consume this gated column;
 *                   raw conversion_value is forbidden by policy.
 * Only 'roas' flips the mode — any other value falls back to 'cpa'. */
function targetMetric(){
  const t = (typeof TARGET_METRIC !== 'undefined' && TARGET_METRIC) ? String(TARGET_METRIC).toLowerCase() : 'cpa';
  return t === 'roas' ? 'roas' : 'cpa';
}
function revenueExpr(){ return (typeof REVENUE_EXPR !== 'undefined' && REVENUE_EXPR) ? String(REVENUE_EXPR) : 'revenue'; }

/* Weekly efficiency metric definitions */
const METRICS = {
  CPA:  { num: 'conv_cost_num', den: 'conv',        scale: 1,    dir: 'lower',  fmt: 'money', label: 'CPA' },
  CPC:  { num: 'spend',         den: 'clicks',       scale: 1,    dir: 'lower',  fmt: 'money', label: 'CPC' },
  CPM:  { num: 'spend',         den: 'impressions',  scale: 1000, dir: 'lower',  fmt: 'money', label: 'CPM' },
  CTR:  { num: 'clicks',        den: 'impressions',  scale: 100,  dir: 'higher', fmt: 'pct',   label: 'CTR' },
  /* ROAS = SUM(revenue) / spend. Higher is better (dir:'higher'); rendered as a
   * ratio (e.g. '4.8x'). Revenue comes from the gated `revenue` agg field, never
   * raw conversion_value. */
  ROAS: { num: 'revenue',       den: 'spend',        scale: 1,    dir: 'higher', fmt: 'ratio', label: 'ROAS' },
};

/* Resolve the active target metric's METRICS entry (CPA by default). */
function targetMetricDef(){ return targetMetric() === 'roas' ? METRICS.ROAS : METRICS.CPA; }

/* Chart colour palette — themeable via BRANDING (which is defined in the dashboard
 * config block, i.e. before this script loads). Every value defaults to the F10
 * palette, so a dashboard with no BRANDING renders identical colours to before.
 *   BRANDING.chartPrimary    hero series / "best" class      (default F10 lime)
 *   BRANDING.chartSecondary  secondary series / "ok" class   (default F10 blue)
 *   BRANDING.chartNegative   negative series / "worst" class (default F10 red)
 *   BRANDING.chartPalette    categorical series array (cohorts, power law, decomposition)
 *   BRANDING.chartAge        override the age-bucket colour map
 *   BRANDING.chartClass      override the Home Run / On Base / Strike Out colour map
 *   BRANDING.chartState      override individual movement-state colours by name
 * Note: genuine good/bad signalling (deltas, mix/efficiency waterfall) stays on the
 * --good/--bad CSS vars via colorFor(), and brand bars on --young-blood, so those
 * follow the chrome theme automatically and are not part of this palette. */
const _BRAND = (typeof BRANDING !== 'undefined' && BRANDING) ? BRANDING : {};
const CHART_PRIMARY   = _BRAND.chartPrimary   || '#c8ff00';
const CHART_SECONDARY = _BRAND.chartSecondary || '#4a90e2';
const CHART_NEGATIVE  = _BRAND.chartNegative  || '#fa023c';
const CHART_NEUTRAL   = '#b0b0b0';

const COHORT_COLORS = _BRAND.chartPalette ||
  ['#c8ff00','#fa023c','#4a90e2','#f5a623','#7ed321','#9b59b6','#1abc9c','#e67e22','#2ecc71','#e74c3c','#3498db','#f39c12'];
const AGE_COLORS    = _BRAND.chartAge ||
  { '0–14 Days': CHART_PRIMARY, '15–90 Days': CHART_SECONDARY, '90+ Days': '#4b000f' };
const CLASS_COLOR   = _BRAND.chartClass ||
  { 'Home Run': CHART_PRIMARY, 'On Base': CHART_SECONDARY, 'Strike Out': CHART_NEGATIVE, 'Unclassified': CHART_NEUTRAL };

/* Ad state metadata: badge CSS class + chart colour. Colours default to the F10
 * set; BRANDING.chartState may override any subset by state name. */
const _STATE_COLORS = Object.assign(
  { 'Scaling Winner': '#7ed321', 'Efficient but Shrinking': CHART_SECONDARY, 'Fading': CHART_NEGATIVE,
    'New Entrant': '#9b59b6', 'Dropped Off': CHART_NEUTRAL, 'Steady': '#f5a623' },
  _BRAND.chartState || {});
const STATE_META = {
  'Scaling Winner':          { cls: 'b-scaling', color: _STATE_COLORS['Scaling Winner'] },
  'Efficient but Shrinking': { cls: 'b-shrink',  color: _STATE_COLORS['Efficient but Shrinking'] },
  'Fading':                  { cls: 'b-fading',  color: _STATE_COLORS['Fading'] },
  'New Entrant':             { cls: 'b-new',     color: _STATE_COLORS['New Entrant'] },
  'Dropped Off':             { cls: 'b-dropped', color: _STATE_COLORS['Dropped Off'] },
  'Steady':                  { cls: 'b-steady',  color: _STATE_COLORS['Steady'] },
};

/* ── Formatters ── */
function bqStr(v){ if(v==null) return null; if(typeof v==='object'&&v.value!==undefined) return String(v.value); return String(v); }
function fmt$(n){ if(n==null||n===''||isNaN(n)) return '–'; return '$'+Number(n).toLocaleString('en-AU',{maximumFractionDigits:0}); }
function fmtPct(n, dp=1){ if(n==null||isNaN(n)) return '–'; return Number(n).toFixed(dp)+'%'; }
function fmtNum(n){ if(n==null||isNaN(n)) return '–'; return Number(n).toLocaleString('en-AU',{maximumFractionDigits:0}); }
function fmtRatio(n, dp=1){ if(n==null||isNaN(n)||!isFinite(n)) return '–'; return Number(n).toFixed(dp)+'x'; }
function fmtMetric(v, m){
  if(v==null||isNaN(v)||!isFinite(v)) return '–';
  const f = m && m.fmt;
  if(f==='money') return '$'+Number(v).toLocaleString('en-AU',{maximumFractionDigits: v<10?2:0});
  if(f==='ratio') return fmtRatio(v);
  return Number(v).toFixed(2)+'%';
}
/* Metric-aware table-cell formatter for the monthly lifetime/summary efficiency
 * metric (Power Law / Ad Decay / Ad Age). CPA mode renders exactly like the
 * legacy fmt$ (money, 0 dp) so CPA tables stay byte-for-byte unchanged; ROAS mode
 * renders the gated ratio (e.g. '4.8x'). Callers keep their own `> 0 ? … : '–'`
 * guard for non-positive values. */
function fmtMetricCell(v){ return targetMetric() === 'roas' ? fmtMetric(v, METRICS.ROAS) : fmt$(v); }
function fmtDate(s){ const str=bqStr(s); if(!str) return '–'; const [y,mo,d]=str.split('-').map(Number); const dt=new Date(Date.UTC(y,mo-1,d)); return dt.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}); }
function isoOffset(isoDate, days){ const [y,mo,d]=isoDate.split('-').map(Number); const dt=new Date(Date.UTC(y,mo-1,d)); dt.setUTCDate(dt.getUTCDate()+days); return dt.toISOString().slice(0,10); }

/* ── Platform metric profiles ──
 * The creative marts differ by platform in which raw columns carry the video
 * attention gates. A profile maps the generic rate names (hook/hold/completion/
 * retention) onto the columns a given platform's mart exposes, so creativeRates()
 * stays platform-agnostic. Meta is the default and preserves prior behaviour
 * exactly (no hook gate; hold = 15s views). TikTok exposes real 2s/6s view gates,
 * so it gets a genuine hook (thumbstop) and a 6s hold rate that Meta cannot give. */
const PLATFORM_PROFILES = {
  meta: {
    hookCol:       null,              /* Meta logs a play on ~every impression, so no meaningful hook gate */
    holdCol:       'video_15s',       /* 15-sec / thruplay proxy */
    completionCol: 'video_p100',
    playsCol:      'video_plays',
    outboundCol:   'outbound_clicks',
    retentionCols: { p25:'video_p25', p50:'video_p50', p75:'video_p75', p100:'video_p100' },
    holdLabel:     'Hold %',
  },
  tiktok: {
    hookCol:       'video_watched_2s',   /* 2-sec views ÷ impr = real thumbstop rate */
    holdCol:       'video_watched_6s',   /* 6-sec views ÷ impr = hold */
    completionCol: 'video_views_p100',
    playsCol:      'video_play_actions',
    outboundCol:   null,                 /* TikTok mart has no outbound_clicks; CTR only */
    retentionCols: { p25:'video_views_p25', p50:'video_views_p50', p75:'video_views_p75', p100:'video_views_p100' },
    holdLabel:     'Hold % (6s)',
  },
};
if (typeof window !== 'undefined') window.PLATFORM_PROFILES = PLATFORM_PROFILES;

/* ── Creative-effectiveness metrics ──
 * The mart stores raw ad×day counts (video gates, outbound_clicks, plus
 * impressions/clicks). Rates are computed here at aggregation time so windowed
 * sums stay correct — never pre-divide then sum. All view rates use impressions
 * as the denominator: both Meta and TikTok auto-play, so a "play" fires on ~every
 * impression and is not a meaningful gate. The profile selects which columns feed
 * each rate; hook is null for platforms (Meta) with no early-view gate. Frequency
 * is intentionally absent — reach overlap is unknown once days are summed. */
function creativeRates(a, profile){
  const p = profile || PLATFORM_PROFILES.meta;
  const impr = (a && a.impressions) || 0;
  const pct = (n) => impr > 0 ? ((Number(n)||0) / impr) * 100 : null;
  const col = (name) => (name && a) ? a[name] : null;
  return {
    impressions: impr,
    hook:        p.hookCol ? pct(col(p.hookCol)) : null,      /* thumbstop; null when platform has no gate */
    hold:        pct(col(p.holdCol)),
    completion:  pct(col(p.completionCol)),
    ctr:         pct(a && a.clicks),
    outboundCtr: p.outboundCol ? pct(col(p.outboundCol)) : null,
    retention: {
      p25:  pct(col(p.retentionCols.p25)),
      p50:  pct(col(p.retentionCols.p50)),
      p75:  pct(col(p.retentionCols.p75)),
      p100: pct(col(p.retentionCols.p100)),
    },
    hasVideo: ((p.playsCol && a && a[p.playsCol]) || 0) > 0,
  };
}

/* Per-ad creative metrics registry. Table renderers populate this keyed by
 * ad_id so the hover preview can show metrics next to the creative. An optional
 * profile selects the platform column mapping (defaults to Meta). An optional
 * score payload (built by creativeScoreHover, US-003) rides along so the hover
 * can show the Creative Score breakdown from the SAME numbers the table used,
 * with no second computation. Callers with no score (e.g. the movement board)
 * omit it and the entry stays metrics-only, exactly as before. */
const F10_AD_METRICS = {};
if (typeof window !== 'undefined') window.F10_AD_METRICS = F10_AD_METRICS; /* expose: const is not auto-attached to window */
function registerAdMetrics(adId, agg, profile, score){
  if(adId == null) return;
  const m = creativeRates(agg, profile);
  if(score != null) m.score = score;
  F10_AD_METRICS[adId] = m;
}

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
  const dots = coords.map(c => `<circle cx="${c[0]}" cy="${c[1]}" r="2.2" fill="${CHART_PRIMARY}"/>`).join('');
  return `<svg class="f10-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`+
    `<path d="${area}" fill="${CHART_PRIMARY}21"/>`+
    `<path d="${line}" fill="none" stroke="${CHART_PRIMARY}" stroke-width="1.6"/>${dots}</svg>`;
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

/* ── Ad-name search (client-side, filters the current view across all ad tables) ──
 * adSearchTerm is a lowercased substring. Ad-row builders tag their <tr> with
 * data-adname (see adNameAttr); renderPagedTable filters on it. Rows without the
 * attribute (e.g. month-level summary tables) are never filtered. */
let adSearchTerm = '';

/* Emit a data-adname attribute (lowercased, attribute-escaped) for an ad row's
 * <tr> so the search filter can match it without touching the visible cells. */
function adNameAttr(name){
  const v = String(name == null ? '' : name).toLowerCase().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `data-adname="${v}"`;
}

/* Keep only rows that match the active ad-name search. Rows carrying no
 * data-adname attribute always pass, so non-ad tables are unaffected. */
function filterRowsBySearch(rowsHtml){
  const term = adSearchTerm;
  if(!term) return rowsHtml;
  return rowsHtml.filter(html => {
    const i = html.indexOf('data-adname="');
    if(i === -1) return true;
    const start = i + 13;
    const end = html.indexOf('"', start);
    return html.slice(start, end === -1 ? undefined : end).indexOf(term) !== -1;
  });
}

/* renderPagedTable(tbodyId, rowsHtml, pageSize=20, footerHtml='')
 * rowsHtml: array of <tr> HTML strings (the full, unfiltered data rows).
 * State keeps `src` (the builder's array, identity key) separate from `rows`
 * (the filtered + sorted working view that gets paged). footerHtml is a pinned
 * row (e.g. Grand Total); it is suppressed while an ad-name search is active on
 * an ad table so the total can't contradict the visible rows. */
function renderPagedTable(tbodyId, rowsHtml, pageSize, footerHtml){
  pageSize = pageSize || 20;
  footerHtml = footerHtml || '';
  const tbody = document.getElementById(tbodyId);
  if(!tbody) return;
  if(!_tablePages[tbodyId] || _tablePages[tbodyId].src !== rowsHtml){
    /* Fresh data from a builder: derive the filtered view, then reapply any
     * active sort so the user's chosen order — and the header ▲/▼ indicator —
     * survive refreshes and filter changes. */
    _tablePages[tbodyId] = { src: rowsHtml, rows: filterRowsBySearch(rowsHtml), page: 0, pageSize: pageSize, footerHtml: footerHtml };
    if(_tableSort[tbodyId]) applyTableSort(tbodyId, true);
  }
  const st = _tablePages[tbodyId];
  st.pageSize = pageSize;
  st.footerHtml = footerHtml;
  const view = st.rows;
  const hasAdRows = st.src.length > 0 && st.src[0].indexOf('data-adname="') !== -1;
  const foot = (adSearchTerm && hasAdRows) ? '' : footerHtml;
  const totalRows = view.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.max(0, Math.min(st.page, totalPages - 1));
  st.page = page;
  tbody.innerHTML = view.slice(page * pageSize, page * pageSize + pageSize).join('') + foot;
  const tableCard = tbody.closest('.table-card');
  if(!tableCard) return;
  let pager = tableCard.querySelector('.table-pagination[data-for="'+tbodyId+'"]');
  if(!pager){ pager = document.createElement('div'); pager.className='table-pagination'; pager.dataset.for=tbodyId; tableCard.appendChild(pager); }
  if(totalPages <= 1){ pager.style.display='none'; return; }
  pager.style.display='';
  pager.innerHTML = `<button class="pg-btn"${page===0?' disabled':''} data-prev>&#8592; Prev</button><span class="pg-info">Page ${page+1} of ${totalPages} &middot; ${totalRows} rows</span><button class="pg-btn"${page>=totalPages-1?' disabled':''} data-next>Next &#8594;</button>`;
  pager.querySelector('[data-prev]').addEventListener('click', ()=>{ st.page--; renderPagedTable(tbodyId, st.src, pageSize, footerHtml); });
  pager.querySelector('[data-next]').addEventListener('click', ()=>{ st.page++; renderPagedTable(tbodyId, st.src, pageSize, footerHtml); });
}

/* Re-apply the current ad-name search to every already-rendered paged table
 * without re-querying — used when the search box changes. */
function refilterAllTables(){
  Object.keys(_tablePages).forEach(id => {
    const st = _tablePages[id];
    if(!st) return;
    st.rows = filterRowsBySearch(st.src);
    if(_tableSort[id]) applyTableSort(id, true);
    st.page = 0;
    renderPagedTable(id, st.src, st.pageSize, st.footerHtml);
  });
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

/* ── Ad status filter (currently-active ads) ──
 * statusFilter is 'all' (default) or 'active'. When 'active', queries are scoped
 * to ads whose latest Meta effective_status is ACTIVE, via the is_active column
 * on the creative_reporting mart. */
let statusFilter = 'all';
function statusClauses(){ return statusFilter === 'active' ? ['is_active'] : []; }

/* Combined query scope = group-segment filters + ad-status filter. Use this in
 * place of groupWhere() so both compose correctly and the WHERE/AND leading is
 * right whether or not any group filter is set:
 *   scopeWhere('WHERE') — start a fresh WHERE block (e.g. FROM t ${scopeWhere('WHERE')})
 *   scopeWhere()        — append to an existing WHERE (leads with AND)
 * Returns '' when nothing is active. */
function scopeClauses(){ return groupClauses().concat(statusClauses()); }
function scopeWhere(lead){
  const parts = scopeClauses();
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
/* `revenue` is the gated revenue field (sourced from REVENUE_EXPR, default the
 * mart's 'revenue' column) — deliberately NOT `conv_value`, so it can never be
 * confused with the policy-forbidden raw conversion_value. It is summed with
 * `|| 0` so CPA-mode rows (which carry no revenue) contribute 0 and never poison
 * the aggregate into NaN. */
function emptyAgg(){ return { spend:0, impressions:0, clicks:0, conv:0, conv_cost_num:0, revenue:0 }; }
function addRow(a, r){ a.spend+=r.spend; a.impressions+=r.impressions; a.clicks+=r.clicks; a.conv+=r.conv; a.conv_cost_num+=r.conv_cost_num; a.revenue += r.revenue || 0; }
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

/* ── Ad Production tier classification (metric-aware, single-sourced) ──
 * ONE SQL CASE expression grades an ad into Home Run / On Base / Strike Out /
 * Unclassified. It is used by BOTH the Production scatter (per-ad CTE) AND the
 * monthly rollup (unique_ads CTE), so the tier labels are produced once in the
 * query layer and consumed verbatim by the display shell — the shell never
 * recomputes bands (hq-classifier-own-labels-single-source).
 *
 * Polarity is metric-aware via the active target metric:
 *   CPA  (dir:'lower')  — Home Run / On Base are CPA CEILINGS to stay under
 *                         (metric > 0 AND metric < band); Strike Out is a floor
 *                         to exceed (metric > SO_CPA).
 *   ROAS (dir:'higher') — Home Run / On Base are ROAS FLOORS to clear
 *                         (metric > band); Strike Out is a ceiling to fall under
 *                         (metric < SO_ROAS). A real-spend / zero-revenue ad has
 *                         roas 0 < SO_ROAS and correctly grades Strike Out.
 *
 * Column names are passed in (spendCol, metricCol) so the same fragment is valid
 * in either query shape. NEVER hardcode one shape's column names — the scatter
 * per-ad CTE and the rollup unique_ads CTE alias the metric differently, and a
 * hardcoded name would silently break the rollup COUNTIF classification counts. */
function classificationCaseSQL(spendCol, metricCol){
  if (targetMetric() === 'roas'){
    return `CASE WHEN ${spendCol} >= ${HR_SPEND} AND ${metricCol} > ${HR_ROAS} THEN 'Home Run'`
         + ` WHEN ${spendCol} >= ${OB_SPEND} AND ${metricCol} > ${OB_ROAS} THEN 'On Base'`
         + ` WHEN ${spendCol} >= ${SO_SPEND} AND ${metricCol} < ${SO_ROAS} THEN 'Strike Out'`
         + ` ELSE 'Unclassified' END`;
  }
  return `CASE WHEN ${spendCol} >= ${HR_SPEND} AND ${metricCol} > 0 AND ${metricCol} < ${HR_CPA} THEN 'Home Run'`
       + ` WHEN ${spendCol} >= ${OB_SPEND} AND ${metricCol} > 0 AND ${metricCol} < ${OB_CPA} THEN 'On Base'`
       + ` WHEN ${spendCol} >= ${SO_SPEND} AND ${metricCol} > ${SO_CPA} THEN 'Strike Out'`
       + ` ELSE 'Unclassified' END`;
}

/* Column alias the classifier's metric column carries in the active mode. CPA
 * mode keeps `lifetime_cpa` (so every existing CPA render site is untouched);
 * ROAS mode uses `lifetime_roas`. */
function lifetimeMetricCol(){ return targetMetric() === 'roas' ? 'lifetime_roas' : 'lifetime_cpa'; }

/* SQL expression for an ad's lifetime efficiency metric (no alias). CPA mode is
 * spend / conversions (lower is better); ROAS mode is gated revenue / spend
 * (higher is better), reading the gated ${REVENUE_EXPR} column — never raw
 * conversion_value. `revenue` is referenced ONLY in ROAS mode, so CPA-mode marts
 * without a revenue column are never queried for it. spendExpr is the ad's
 * lifetime-spend SQL (e.g. ANY_VALUE(lifetime_spend)); convExpr the summed-
 * conversions SQL. */
function lifetimeMetricSQL(spendExpr, convExpr){
  return targetMetric() === 'roas'
    ? `SAFE_DIVIDE(SUM(${revenueExpr()}), NULLIF(${spendExpr}, 0))`
    : `SAFE_DIVIDE(${spendExpr}, NULLIF(${convExpr}, 0))`;
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
  if(!skipRender) renderPagedTable(tbodyId, st.src, st.pageSize, st.footerHtml);
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

/* == Creative Score (target-anchored, metric-aware, confidence-weighted) =====
 * ONE 0 to 100 score per creative, blended from four components:
 *   efficiency   the account headline metric (CPA in CPA mode, ROAS in ROAS
 *                mode) mapped to 0..1 against the LIVE HR/OB/SO threshold bands.
 *   quality      creative-effectiveness rates (hook/hold/CTR/completion) mapped
 *                to 0..1 against tunable reference ceilings. A static image (no
 *                video gates) contributes a neutral 0.5, never 0, so it is not
 *                penalised for having no video attention to measure.
 *   durability   active days vs a maturity target, mapped to 0..1.
 *   confidence   log spend vs HR_SPEND, applied as a MULTIPLIER that pulls the
 *                headline toward the neutral midpoint (50) when volume is thin,
 *                rather than as a large additive term. A brand-new low-spend ad
 *                is therefore drawn toward neutral, not to the top.
 *
 * Single source, same discipline as classificationCaseSQL: the math is emitted
 * ONCE as SQL (creativeScoreSQL / creativeScoreComponentsSQL); the query layer
 * runs it and the display reads the produced value, never recomputing it. The
 * JS companion creativeScoreParts() mirrors the same math for badge/hover
 * packaging and for tuning; the test suite evaluates the emitted SQL and asserts
 * it equals creativeScoreParts so the two can never drift.
 *
 * Metric polarity is taken from targetMetric(): CPA rewards a LOW metric and
 * anchors to HR_CPA/OB_CPA/SO_CPA; ROAS flips to reward a HIGH metric and anchors
 * to HR_ROAS/OB_ROAS/SO_ROAS. The efficiency input is a column NAME passed by the
 * caller. In ROAS mode that column is the pre-gated roas expression (the same one
 * lifetimeMetricSQL builds from revenueExpr()); this helper never names raw
 * conversion_value, honouring policy f10-blended-roas-revenue-gating.
 *
 * Weights, the maturity target, the quality ceilings, the confidence-multiplier
 * floor and the band cutoffs are TUNABLE constants (validated in US-004). A
 * dashboard may override any subset BEFORE the scripts load, same guarded-global
 * idiom as THRESHOLDS / TARGET_METRIC:
 *   const CREATIVE_SCORE_CONFIG = { wEfficiency: 0.5, maturityDays: 45 };
 * Logic and constants are kept separate so tuning never touches the formula. */
function creativeScoreConfig(){
  const c = (typeof CREATIVE_SCORE_CONFIG !== 'undefined' && CREATIVE_SCORE_CONFIG) ? CREATIVE_SCORE_CONFIG : {};
  const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
  const ceil = c.qualityCeil || {};
  return {
    wEfficiency: num(c.wEfficiency, 0.5),
    wQuality:    num(c.wQuality, 0.3),
    wDurability: num(c.wDurability, 0.2),
    maturityDays: num(c.maturityDays, 30),
    confidenceFloor: Math.min(1, Math.max(0, num(c.confidenceFloor, 0))),
    neutral: num(c.neutral, 50),
    bandStrong: num(c.bandStrong, 70),
    bandMid:    num(c.bandMid, 40),
    qualityCeil: {
      hook:       num(ceil.hook, 30),
      hold:       num(ceil.hold, 20),
      ctr:        num(ceil.ctr, 2),
      completion: num(ceil.completion, 15),
    },
  };
}

/* Emit the four component SQL expressions plus the blended score expression, all
 * as strings. spendCol and metricCol are column NAMES (metricCol is the headline
 * CPA or gated ROAS column). opts carries the rate/gate column expressions so the
 * mart shape is never hardcoded:
 *   hookExpr, holdExpr, ctrExpr, completionExpr  creative rates as a percent of
 *       impressions (0..100). Omit any the platform lacks (e.g. Meta has no hook
 *       gate) and it is dropped from the quality average.
 *   hasVideoExpr   boolean SQL that is true when the ad has video (e.g.
 *       'video_plays > 0'). When false the quality component is a flat 0.5.
 *   activeDaysExpr numeric SQL for the ad active/lifetime days (durability input).
 * All arithmetic is pure (LEAST/GREATEST/LN/IF/IFNULL/ROUND only, no CASE) so the
 * expression is a faithful, testable mirror of creativeScoreParts. */
function creativeScoreComponentsSQL(spendCol, metricCol, opts){
  opts = opts || {};
  const cfg = creativeScoreConfig();
  const clamp01 = (e) => `GREATEST(0, LEAST(1, ${e}))`;
  const width = (a, b) => (a - b) || 1; /* band width, guarded against zero */

  let efficiency;
  if (targetMetric() === 'roas'){
    const upper = clamp01(`(${metricCol} - ${OB_ROAS}) / ${width(HR_ROAS, OB_ROAS)}`);
    const lower = clamp01(`(${metricCol} - ${SO_ROAS}) / ${width(OB_ROAS, SO_ROAS)}`);
    efficiency = `IFNULL(0.5 * ${upper} + 0.5 * ${lower}, 0)`;
  } else {
    const upper = clamp01(`(${OB_CPA} - ${metricCol}) / ${width(OB_CPA, HR_CPA)}`);
    const lower = clamp01(`(${SO_CPA} - ${metricCol}) / ${width(SO_CPA, OB_CPA)}`);
    efficiency = `IFNULL(0.5 * ${upper} + 0.5 * ${lower}, 0)`;
  }

  const qParts = [];
  const pushQ = (expr, ceil) => { if (expr) qParts.push(clamp01(`(${expr}) / ${ceil || 1}`)); };
  pushQ(opts.hookExpr, cfg.qualityCeil.hook);
  pushQ(opts.holdExpr, cfg.qualityCeil.hold);
  pushQ(opts.ctrExpr, cfg.qualityCeil.ctr);
  pushQ(opts.completionExpr, cfg.qualityCeil.completion);
  const videoQuality = qParts.length ? `(${qParts.join(' + ')}) / ${qParts.length}` : '0.5';
  const quality = opts.hasVideoExpr ? `IF(${opts.hasVideoExpr}, ${videoQuality}, 0.5)` : videoQuality;

  const durability = opts.activeDaysExpr
    ? clamp01(`IFNULL(${opts.activeDaysExpr}, 0) / ${cfg.maturityDays || 1}`)
    : '0.5';

  const lnHrSpend = Math.log(1 + Math.max(0, HR_SPEND)) || 1;
  const confidence = `LEAST(1, GREATEST(${cfg.confidenceFloor}, LN(1 + ${spendCol}) / ${lnHrSpend}))`;

  const sumW = (cfg.wEfficiency + cfg.wQuality + cfg.wDurability) || 1;
  const raw = `100 * (${cfg.wEfficiency} * (${efficiency}) + ${cfg.wQuality} * (${quality}) + ${cfg.wDurability} * (${durability})) / ${sumW}`;
  const score = `LEAST(100, GREATEST(0, ROUND(${cfg.neutral} + ((${raw}) - ${cfg.neutral}) * (${confidence}))))`;

  return { efficiency: efficiency, quality: quality, durability: durability, confidence: confidence, score: score };
}

/* The single headline SQL expression: a 0 to 100 Creative Score. Mirror of
 * classificationCaseSQL(spendCol, metricCol) in shape (branch on targetMetric(),
 * take column names, emit one string) so a dashboard computes the score once in
 * the query and renders it verbatim. See creativeScoreComponentsSQL for opts. */
function creativeScoreSQL(spendCol, metricCol, opts){
  return creativeScoreComponentsSQL(spendCol, metricCol, opts).score;
}

/* Map a produced 0 to 100 score to a colour band, reusing the framework chart
 * palette (Strong = primary, Mid = secondary, Weak = negative) so the badge and
 * hover share one colour system. Cutoffs are tunable via CREATIVE_SCORE_CONFIG. */
function creativeScoreBand(score){
  const cfg = creativeScoreConfig();
  const s = Number(score);
  if (Number.isFinite(s) && s >= cfg.bandStrong) return { label: 'Strong', cls: 'score-strong', color: CHART_PRIMARY };
  if (Number.isFinite(s) && s >= cfg.bandMid)    return { label: 'Mid',    cls: 'score-mid',    color: CHART_SECONDARY };
  return { label: 'Weak', cls: 'score-weak', color: CHART_NEGATIVE };
}

/* JS companion / mirror of the score math. Given NUMERIC values it returns the
 * four component sub-scores (0..1 each, confidence as a 0..1 multiplier), the
 * final 0 to 100 score and its band, so the badge and hover read the same numbers
 * the SQL produced without a second, divergent computation. Represent a SQL NULL
 * (e.g. CPA of a zero-conversion ad) by passing metric: null; it grades 0.
 *   vals: { spend, metric, hook, hold, ctr, completion, hasVideo, activeDays }
 * A rate left undefined is dropped from the quality average (matching an omitted
 * *Expr in the SQL). hasVideo:false forces the quality component to a neutral 0.5. */
function creativeScoreParts(vals){
  vals = vals || {};
  const cfg = creativeScoreConfig();
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ifnull = (x, d) => (x == null || Number.isNaN(x)) ? d : x;
  const width = (a, b) => (a - b) || 1;
  const metric = (vals.metric == null) ? NaN : Number(vals.metric);

  let efficiency;
  if (targetMetric() === 'roas'){
    const upper = clamp01((metric - OB_ROAS) / width(HR_ROAS, OB_ROAS));
    const lower = clamp01((metric - SO_ROAS) / width(OB_ROAS, SO_ROAS));
    efficiency = ifnull(0.5 * upper + 0.5 * lower, 0);
  } else {
    const upper = clamp01((OB_CPA - metric) / width(OB_CPA, HR_CPA));
    const lower = clamp01((SO_CPA - metric) / width(SO_CPA, OB_CPA));
    efficiency = ifnull(0.5 * upper + 0.5 * lower, 0);
  }

  const qParts = [];
  const pushQ = (v, ceil) => { if (v != null) qParts.push(clamp01(Number(v) / (ceil || 1))); };
  pushQ(vals.hook, cfg.qualityCeil.hook);
  pushQ(vals.hold, cfg.qualityCeil.hold);
  pushQ(vals.ctr, cfg.qualityCeil.ctr);
  pushQ(vals.completion, cfg.qualityCeil.completion);
  const videoQuality = qParts.length ? qParts.reduce((a, b) => a + b, 0) / qParts.length : 0.5;
  const hasVideo = (vals.hasVideo === undefined) ? true : !!vals.hasVideo;
  const quality = hasVideo ? videoQuality : 0.5;

  const durability = (vals.activeDays == null)
    ? 0.5
    : clamp01(ifnull(Number(vals.activeDays), 0) / (cfg.maturityDays || 1));

  const spend = Number.isFinite(Number(vals.spend)) ? Number(vals.spend) : 0;
  const lnHrSpend = Math.log(1 + Math.max(0, HR_SPEND)) || 1;
  const confidence = Math.min(1, Math.max(cfg.confidenceFloor, Math.log(1 + spend) / lnHrSpend));

  const sumW = (cfg.wEfficiency + cfg.wQuality + cfg.wDurability) || 1;
  const raw = 100 * (cfg.wEfficiency * efficiency + cfg.wQuality * quality + cfg.wDurability * durability) / sumW;
  const score = Math.min(100, Math.max(0, Math.round(cfg.neutral + (raw - cfg.neutral) * confidence)));

  return {
    efficiency: efficiency,
    quality: quality,
    durability: durability,
    confidence: confidence,
    score: score,
    band: creativeScoreBand(score),
  };
}

/* Render a produced 0 to 100 Creative Score as a colour badge for a per-ad
 * table cell (US-002). The score is computed ONCE in SQL by creativeScoreSQL and
 * passed in here verbatim -- this NEVER recomputes it. The badge text is the
 * BARE integer (no label suffix) so the universal table sort reads the cell as a
 * number and sorts high to low on first click; the colour band comes from
 * creativeScoreBand so the badge reuses the framework palette (strong/mid/weak).
 * A missing/non-numeric score renders an empty cell, which the sort treats as
 * blank and sinks to the bottom. Accepts raw BigQuery values (plain number,
 * string, or {value} wrapper) via bqStr. */
function creativeScoreBadge(score){
  const raw = bqStr(score);
  const n = (raw == null || raw === '') ? NaN : Number(raw);
  if(!Number.isFinite(n)) return '';
  const v = Math.round(n);
  return `<span class="badge ${creativeScoreBand(v).cls}">${v}</span>`;
}
if (typeof window !== 'undefined') window.creativeScoreBadge = creativeScoreBadge;

/* Package the per-ad Creative Score for the hover breakdown (US-003). The
 * headline VALUE is the score BigQuery already produced (creative_score),
 * rounded and rendered verbatim, so the hover headline always equals the table
 * badge for the same ad -- never a second, divergent computation. The four
 * component sub-scores (efficiency, creative quality, durability, and the
 * confidence multiplier applied) come from creativeScoreParts, the JS mirror of
 * the same SQL math, computed ONCE here at registration from the inputs the
 * query used, so the breakdown reconciles to the headline. `vals` is the same
 * shape creativeScoreParts takes: { spend, metric, hook, hold, ctr, completion,
 * hasVideo, activeDays }. hasVideo:false and a missing activeDays are surfaced
 * so the hover can state the neutral 0.5 contribution rather than hide it. */
function creativeScoreHover(sqlScore, vals){
  vals = vals || {};
  const parts = creativeScoreParts(vals);
  const raw = bqStr(sqlScore);
  const n = (raw == null || raw === '') ? NaN : Number(raw);
  const value = Number.isFinite(n) ? Math.round(n) : null;
  return {
    value:      value,
    band:       value == null ? null : creativeScoreBand(value),
    efficiency: parts.efficiency,
    quality:    parts.quality,
    durability: parts.durability,
    confidence: parts.confidence,
    hasVideo:   (vals.hasVideo === undefined) ? true : !!vals.hasVideo,
    activeKnown: vals.activeDays != null,
  };
}
if (typeof window !== 'undefined') window.creativeScoreHover = creativeScoreHover;
