/**
 * f10-layout.js — F10 Creative Dashboard markup generator
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.5.1/f10-layout.js"></script>
 *
 * Must be loaded AFTER f10-utils.js (it reads HR_SPEND/HR_CPA/... for the
 * Production benchmark copy). Renders the sidebar, controls bar, and all seven
 * tab panels into <div id="app"></div> so dashboards no longer hand-maintain the
 * markup. The Production thresholds shown to users are derived from the same
 * constants the SQL and charts use, so the copy can never drift from the data.
 *
 * Config read from globals (define before this script runs):
 *   CLIENT_NAME   — sidebar client label (required)
 *   REPORT_NAME   — sidebar sub-label (optional, default 'Creative Reporting')
 *   GROUP_FILTERS — group dropdowns are injected by f10-weekly.js at init
 *
 * Entrypoint — call before wireControls():
 *   renderLayout();
 */

/* Production threshold copy — built from the live HR_SPEND/HR_CPA/... globals so
 * it can be regenerated whenever a user tunes the thresholds in the UI. */
function prodBenchmarkHTML(){
  /* ROAS is higher-is-better: good grades clear the target (Spend & ROAS &ge; band),
     Strike Out falls below it. CPA is lower-is-better and keeps its legacy copy. */
  if (targetMetric() === 'roas'){
    return `<span class="bm-item"><strong>Home Run:</strong> Spend &ge; ${fmt$(HR_SPEND)} &amp; ROAS &ge; ${fmtRatio(HR_ROAS)}</span>` +
      `<span class="bm-item"><strong>On Base:</strong> Spend &ge; ${fmt$(OB_SPEND)} &amp; ROAS &ge; ${fmtRatio(OB_ROAS)}</span>` +
      `<span class="bm-item"><strong>Strike Out:</strong> Spend &ge; ${fmt$(SO_SPEND)} &amp; ROAS &lt; ${fmtRatio(SO_ROAS)}</span>`;
  }
  return `<span class="bm-item"><strong>Home Run:</strong> Spend &ge; ${fmt$(HR_SPEND)} &amp; CPA &lt; ${fmt$(HR_CPA)}</span>` +
    `<span class="bm-item"><strong>On Base:</strong> Spend &ge; ${fmt$(OB_SPEND)} &amp; CPA &lt; ${fmt$(OB_CPA)}</span>` +
    `<span class="bm-item"><strong>Strike Out:</strong> Spend &ge; ${fmt$(SO_SPEND)} &amp; CPA &gt; ${fmt$(SO_CPA)}</span>`;
}
function prodThresholdLegendHTML(){
  if (targetMetric() === 'roas'){
    return `<span class="tl-item"><span class="tl-line dashed" style="color:#727272;"></span> ROAS Target (${fmtRatio(HR_ROAS)})</span><span class="tl-item"><span class="tl-line dashed" style="color:#4a90e2;"></span> Ad Hit (${fmt$(HR_SPEND)})</span>`;
  }
  return `<span class="tl-item"><span class="tl-line dashed" style="color:#727272;"></span> CPA Limit (${fmt$(HR_CPA)})</span><span class="tl-item"><span class="tl-line dashed" style="color:#4a90e2;"></span> Ad Hit (${fmt$(HR_SPEND)})</span>`;
}
/* Live threshold-tuning inputs for the Ad Production tab, metric-aware. The three
 * spend floors are shared across metrics; the efficiency band flips with the
 * active target metric — CPA is a ceiling ("max CPA", th-*-cpa) while ROAS is a
 * floor ("min ROAS", th-*-roas), except Strike Out which inverts ("min CPA" vs
 * "max ROAS"). The id set here must match productionInputMap() in f10-monthly.js
 * so Apply/Reset read the right inputs and re-run the production load. */
function prodThresholdFieldsHTML(){
  const spend = `<div class="tc-field"><label for="th-hr-spend">Home Run — min spend ($)</label><input type="number" id="th-hr-spend" min="0" step="100" /></div>` +
    `<div class="tc-field"><label for="th-ob-spend">On Base — min spend ($)</label><input type="number" id="th-ob-spend" min="0" step="100" /></div>` +
    `<div class="tc-field"><label for="th-so-spend">Strike Out — min spend ($)</label><input type="number" id="th-so-spend" min="0" step="100" /></div>`;
  if (targetMetric() === 'roas'){
    return spend +
      `<div class="tc-field"><label for="th-hr-roas">Home Run — min ROAS (x)</label><input type="number" id="th-hr-roas" min="0" step="0.1" /></div>` +
      `<div class="tc-field"><label for="th-ob-roas">On Base — min ROAS (x)</label><input type="number" id="th-ob-roas" min="0" step="0.1" /></div>` +
      `<div class="tc-field"><label for="th-so-roas">Strike Out — max ROAS (x)</label><input type="number" id="th-so-roas" min="0" step="0.1" /></div>`;
  }
  return spend +
    `<div class="tc-field"><label for="th-hr-cpa">Home Run — max CPA ($)</label><input type="number" id="th-hr-cpa" min="0" step="1" /></div>` +
    `<div class="tc-field"><label for="th-ob-cpa">On Base — max CPA ($)</label><input type="number" id="th-ob-cpa" min="0" step="1" /></div>` +
    `<div class="tc-field"><label for="th-so-cpa">Strike Out — min CPA ($)</label><input type="number" id="th-so-cpa" min="0" step="1" /></div>`;
}
/* Refresh every piece of threshold-derived copy in the Ad Production tab from the
 * current threshold values. Safe to call before the tab exists (guards on null). */
function refreshProductionThresholdCopy(){
  const bench = document.getElementById('prod-benchmark');
  if (bench) bench.innerHTML = prodBenchmarkHTML();
  const legend = document.getElementById('prod-threshold-legend');
  if (legend) legend.innerHTML = prodThresholdLegendHTML();
  const hit = document.getElementById('prod-hit-spend');
  if (hit) hit.textContent = fmt$(HR_SPEND);
}

/* Efficiency-metric <option> set, metric-aware and shared by the Meta and TikTok
 * controls bars so the two dropdowns never drift. In ROAS mode ROAS leads and is
 * selected by default; CPA/CPC/CPM/CTR remain available. In CPA mode the option
 * set is exactly the legacy list, so existing dashboards are byte-for-byte
 * unchanged. */
function efficiencyMetricOptionsHTML(){
  return targetMetric() === 'roas'
    ? `<option value="ROAS" selected>ROAS (revenue / spend)</option><option value="CPA">CPA (cost / conversion)</option><option value="CPC">CPC (cost / click)</option><option value="CPM">CPM (cost / 1k impr)</option><option value="CTR">CTR (clicks / impr)</option>`
    : `<option value="CPA" selected>CPA (cost / conversion)</option><option value="CPC">CPC (cost / click)</option><option value="CPM">CPM (cost / 1k impr)</option><option value="CTR">CTR (clicks / impr)</option>`;
}
/* Noise-floor "× target CPA" mode labels. That mode is a minimum-spend gate
 * expressed as a multiple of a reference cost — a CPA-specific concept — so in
 * ROAS mode (no target CPA) the button + input relabel to a plain spend target.
 * The control KEYS (data-floor, ids) never change, so f10-weekly.js reads them
 * unchanged; only the display copy flips. CPA mode returns the byte-for-byte
 * legacy strings. */
function noiseFloorMultLabels(){
  return targetMetric() === 'roas'
    ? { btn: '&times; spend target', label: 'Spend target / Mult', title: 'Spend target ($)' }
    : { btn: '&times; target CPA',   label: 'Target CPA / Mult',   title: 'Target CPA ($)' };
}
/* TikTok Ad Production benchmark copy — same polarity rules as the Meta
 * prodBenchmarkHTML() but built from the TikTok thresholds (ttTh) rather than the
 * global HR_SPEND/... The CPA branch is byte-identical to the legacy inline copy,
 * so CPA dashboards are unchanged; ROAS mode flips to the "floor to clear /
 * ceiling to fall under" wording. */
function ttProdBenchmarkHTML(ttTh){
  if (targetMetric() === 'roas'){
    return `<span class="bm-item"><strong>Home Run:</strong> Spend &ge; ${fmt$(ttTh.HR_SPEND)} &amp; ROAS &ge; ${fmtRatio(ttTh.HR_ROAS)}</span>` +
      `<span class="bm-item"><strong>On Base:</strong> Spend &ge; ${fmt$(ttTh.OB_SPEND)} &amp; ROAS &ge; ${fmtRatio(ttTh.OB_ROAS)}</span>` +
      `<span class="bm-item"><strong>Strike Out:</strong> Spend &ge; ${fmt$(ttTh.SO_SPEND)} &amp; ROAS &lt; ${fmtRatio(ttTh.SO_ROAS)}</span>`;
  }
  return `<span class="bm-item"><strong>Home Run:</strong> Spend &ge; ${fmt$(ttTh.HR_SPEND)} &amp; CPA &lt; ${fmt$(ttTh.HR_CPA)}</span><span class="bm-item"><strong>On Base:</strong> Spend &ge; ${fmt$(ttTh.OB_SPEND)} &amp; CPA &lt; ${fmt$(ttTh.OB_CPA)}</span><span class="bm-item"><strong>Strike Out:</strong> Spend &ge; ${fmt$(ttTh.SO_SPEND)} &amp; CPA &gt; ${fmt$(ttTh.SO_CPA)}</span>`;
}

/* TikTok section markup (controls bar + four panels), rendered only when a
 * TIKTOK config object is present. Mirrors the Meta panels with tt- ids and the
 * TikTok metric columns (Hook 2s / Hold 6s). f10-tiktok.js drives these. */
function ttControlsMarkup(){
  return `<div class="controls-bar" id="tt-controls-bar" style="display:none;">
      <div class="weekly-controls" style="display:flex;">
        <div class="ctrl"><label>Window length</label>
          <select id="tt-ctrl-length"><option value="7" selected>7 days</option><option value="14">14 days</option><option value="28">28 days</option></select>
        </div>
        <div class="ctrl"><label>Current window ends</label><input type="date" id="tt-ctrl-enddate" /></div>
        <div class="ctrl"><label>Efficiency metric</label>
          <select id="tt-ctrl-metric">${efficiencyMetricOptionsHTML()}</select>
        </div>
        <div class="ctrl"><label>Min spend ($)</label><input type="number" id="tt-ctrl-minspend" value="1" min="0" step="50" /></div>
      </div>
    </div>`;
}
function ttPanelsMarkup(ttTh){
  return `
    <!-- TIKTOK: WEEKLY SUMMARY -->
    <div class="tab-panel tt-tab-panel" id="panel-tt-summary">
      <div class="insight-box"><strong>TikTok Weekly Summary:</strong> spend, conversions and blended efficiency this window vs the previous equal-length window, plus the account-level <strong>2s hook</strong> and <strong>6s hold</strong> rates &mdash; the early-attention signal TikTok exposes and Meta cannot.</div>
      <div class="window-note" id="tt-summary-window-note"></div>
      <div id="tt-summary-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="tt-summary-body" style="display:none;">
        ${targetMetric() === 'roas' ? '<div id="tt-summary-revenue-guard"></div>\n        ' : ''}<div class="scorecard-grid" id="tt-summary-scorecards"></div>
        <div class="chart-card">
          <h3>Blended Metric Decomposition &mdash; Prior &rarr; Current</h3>
          <div class="legend-row"><span class="li"><span class="dot" style="background:var(--good)"></span> Improves the metric</span><span class="li"><span class="dot" style="background:var(--bad)"></span> Worsens the metric</span></div>
          <div class="chart-wrapper" style="height:360px;"><canvas id="tt-decomp-chart"></canvas></div>
          <div class="window-note" id="tt-decomp-note" style="margin-top:12px;"></div>
        </div>
      </div>
    </div>

    <!-- TIKTOK: MOVEMENT BOARD -->
    <div class="tab-panel tt-tab-panel" id="panel-tt-board">
      <div class="insight-box"><strong>TikTok Movement Board:</strong> every ad that cleared the spend floor in either window, current vs previous, tagged by what it did. <strong>Hook (2s)</strong> and <strong>Hold (6s)</strong> show early attention. Sorted by current spend.</div>
      <div class="window-note" id="tt-board-window-note"></div>
      <div class="legend-row" id="tt-board-legend"></div>
      <div class="table-card">
        <h3 id="tt-board-title">Ad Movement</h3>
        <div class="table-scroll">
          <div id="tt-board-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="tt-board-table" style="display:none;">
            <thead><tr><th>Ad</th><th>State</th><th class="num">Spend</th><th class="num">&Delta; Spend</th><th class="num" id="tt-board-m-head">Metric</th><th class="num">&Delta; Metric</th><th class="num">Conv.</th><th class="num">Impr.</th><th class="num">Hook %</th><th class="num">Hold %</th><th>Preview</th></tr></thead>
            <tbody id="tt-board-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TIKTOK: AD PRODUCTION -->
    <div class="tab-panel tt-tab-panel" id="panel-tt-production">
      <div class="insight-box"><strong>TikTok Ad Production:</strong> how many ads were launched and the share that become hits (lifetime spend &ge; the Home Run threshold ${targetMetric() === 'roas' ? 'at a strong ROAS' : 'at an efficient CPA'}). Aim for a 10&ndash;15% hit rate.<br/><br/><strong>Thresholds:</strong>
        <div class="benchmark">${ttProdBenchmarkHTML(ttTh)}</div>
      </div>
      ${targetMetric() === 'roas' ? '<div id="tt-production-revenue-guard"></div>\n      ' : ''}<div id="tt-production-scorecards-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="tt-production-scorecards" style="display:none;">
        <div class="scorecard-grid">
          <div class="scorecard"><div class="scorecard-label">Ads Produced</div><div class="scorecard-value" id="tt-sc-ads-produced">&ndash;</div></div>
          <div class="scorecard highlight"><div class="scorecard-label">Home Runs</div><div class="scorecard-value" id="tt-sc-home-runs">&ndash;</div></div>
          <div class="scorecard highlight"><div class="scorecard-label">Home Run Rate</div><div class="scorecard-value" id="tt-sc-hr-rate">&ndash;</div></div>
          <div class="scorecard"><div class="scorecard-label">On Base</div><div class="scorecard-value" id="tt-sc-on-base">&ndash;</div></div>
          <div class="scorecard"><div class="scorecard-label">On Base Rate</div><div class="scorecard-value" id="tt-sc-ob-rate">&ndash;</div></div>
          <div class="scorecard warn"><div class="scorecard-label">Strike Outs</div><div class="scorecard-value" id="tt-sc-strike-outs">&ndash;</div></div>
          <div class="scorecard warn"><div class="scorecard-label">Strike Out Rate</div><div class="scorecard-value" id="tt-sc-so-rate">&ndash;</div></div>
        </div>
      </div>
      <div class="two-col">
        <div class="chart-card" style="margin-bottom:0;"><h3>Lifetime Spend vs ${targetMetricDef().label} &mdash; All Ads</h3>
          <div id="tt-scatter-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <div class="chart-wrapper" id="tt-scatter-wrapper" style="display:none; height:320px;"><canvas id="tt-scatter-chart"></canvas></div>
        </div>
        <div class="chart-card" style="margin-bottom:0;"><h3>Ads Launched &amp; Hit Rates by Month</h3>
          <div id="tt-production-chart-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <div class="chart-wrapper" id="tt-production-chart-wrapper" style="display:none; height:320px;"><canvas id="tt-production-chart"></canvas></div>
        </div>
      </div>
      <div class="table-card"><h3>Ad-Level Classification</h3>
        <div class="table-scroll">
          <div id="tt-scatter-table-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="tt-scatter-table" style="display:none;">
            <thead><tr><th>Ad</th><th>Campaign</th><th>Ad Group</th><th>Launch Date</th><th>Lifetime Spend</th><th>Lifetime ${targetMetricDef().label}</th><th>Conversions</th><th class="num">Hook %</th><th class="num">Hold %</th><th class="num">Compl. %</th><th>Preview</th><th>Classification</th></tr></thead>
            <tbody id="tt-scatter-table-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TIKTOK: CREATIVE EFFECTIVENESS -->
    <div class="tab-panel tt-tab-panel" id="panel-tt-creative">
      <div class="insight-box"><strong>TikTok Creative Effectiveness:</strong> attention beyond ${targetMetricDef().label}. <strong>Hook rate</strong> is the share of impressions watched to 2 seconds (did the ad stop the scroll?); <strong>Hold rate</strong> reached 6 seconds; <strong>completion</strong> watched to the end; the <strong>retention curve</strong> (25 &rarr; 100%) shows where viewers drop off. Rates cover the last 90 days.</div>
      <div class="scorecard-grid" style="margin-bottom:16px;">
        <div class="scorecard highlight"><div class="scorecard-label">Avg Hook Rate (2s)</div><div class="scorecard-value" id="tt-creative-hook">&ndash;</div></div>
        <div class="scorecard"><div class="scorecard-label">Avg Hold Rate (6s)</div><div class="scorecard-value" id="tt-creative-hold">&ndash;</div></div>
      </div>
      <div class="chart-card"><h3>Average Video Retention Curve &mdash; % of Impressions Reaching Each Quartile</h3>
        <div id="tt-creative-chart-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
        <div class="chart-wrapper" id="tt-creative-chart-wrapper" style="display:none; height:320px;"><canvas id="tt-creative-chart"></canvas></div>
      </div>
      <div class="table-card"><h3>Creative Effectiveness by Ad &mdash; Last 90 Days</h3>
        <div class="table-scroll">
          <div id="tt-creative-table-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="tt-creative-table" style="display:none;">
            <thead><tr><th>Ad</th><th>Campaign</th><th class="num">Spend</th><th class="num">Impr.</th><th class="num">Hook %</th><th class="num">Hold %</th><th class="num">Compl. %</th><th class="num">25%</th><th class="num">50%</th><th class="num">75%</th><th class="num">100%</th><th class="num">CTR</th><th>Preview</th></tr></thead>
            <tbody id="tt-creative-table-body"></tbody>
          </table>
        </div>
      </div>
    </div>
`;
}

/* Competitor Ad Library markup (single panel), rendered only when the
 * visibility probe finds competitor rows for this client (probe-driven, US-003).
 * Not part of the base layout: f10-competitors.js injects this panel (and the
 * matching nav entry) after its existence probe passes, and drives the panel. */
function competitorPanelMarkup(){
  return `
    <!-- COMPETITORS: AD LIBRARY -->
    <div class="tab-panel comp-tab-panel" id="panel-competitors">
      <div class="insight-box"><strong>Competitor Ad Library:</strong> every tracked competitor's live Meta ads, grouped by competitor. Longevity (<strong>Nd active</strong>) is the winner signal &mdash; AU has no public spend or impressions data, so how long a competitor keeps an ad live is the clearest read on what is working for them. Play any video or scroll multi-asset ads in place.</div>
      <div class="window-note" id="comp-meta"></div>
      <div class="window-note" id="comp-note"></div>
      <div id="comp-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="comp-body" style="display:none;"></div>
    </div>
`;
}

/* Competitor Vision & Text Analysis markup (Tab 2, US-009). A second competitor
 * sub-tab: the per-competitor Gemini theme rollup (named themes, dominant
 * angle/message narrative, format mix, on-screen/copy phrases, confidence +
 * run_date freshness) from the US-007 `themes` action. Injected by
 * f10-competitors.js only when the themes visibility probe finds a theme summary
 * for this client (probe-driven, absent-safe) — same pattern as the ads panel. */
function competitorThemesPanelMarkup(){
  return `
    <!-- COMPETITORS: VISION & TEXT ANALYSIS -->
    <div class="tab-panel comp-tab-panel" id="panel-competitor-themes">
      <div class="insight-box"><strong>Vision &amp; Text Analysis:</strong> the creative strategy behind each competitor&rsquo;s ads &mdash; the <strong>dominant angle</strong> they keep returning to, the named themes across their vision and copy, their format mix, and the on-screen &amp; copy phrases they repeat. Read the narrative first: it is the &ldquo;so what&rdquo; &mdash; what a competitor is really selling and how &mdash; not just a list of tags.</div>
      <div class="window-note" id="compx-meta"></div>
      <div class="window-note" id="compx-note"></div>
      <div id="compx-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="compx-body" style="display:none;"></div>
    </div>
`;
}

/* Competitor Ad Age Over Time markup (Tab 3, US-010). A third competitor sub-tab:
 * a time-series chart of average AND median live ad age per month for every tracked
 * competitor PLUS the client's own line, from the US-007 `age-timeseries` action
 * (US-003 over-time mart, one shared monthly axis + one age definition). Injected by
 * f10-competitors.js only when the age visibility probe finds age-over-time rows for
 * this client (probe-driven, absent-safe) — same runtime nav+panel pattern as the
 * ads and themes panels. The chart itself is drawn client-side (inline SVG multi-line,
 * matching the framework's library-free SVG charting approach, e.g. retentionSparkline). */
function competitorAgePanelMarkup(){
  return `
    <!-- COMPETITORS: AD AGE OVER TIME -->
    <div class="tab-panel comp-tab-panel" id="panel-competitor-age">
      <div class="insight-box"><strong>Ad Age Over Time:</strong> how creative longevity is trending &mdash; the average and median age of each competitor&rsquo;s live ads month by month, with <strong>your own line</strong> on the same axis for comparison. A line drifting up means a competitor is leaning on older, proven creative; a line staying low means they refresh often. Read it against your own trend: are you ageing faster or slower than the set?</div>
      <div class="window-note" id="compa-meta"></div>
      <div class="window-note" id="compa-note"></div>
      <div id="compa-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="compa-body" style="display:none;"></div>
    </div>
`;
}

/* Competitor Meta Maturity Score markup (Tab 4, US-011). The roll-up sub-tab: an
 * explainable 0-100 Meta maturity score that ranks every tracked competitor AND the
 * client, from the US-007 `maturity` action (competitor_meta_maturity mart). It shows
 * the client's rank + data-owned tier alongside the composite AND its six component
 * sub-scores (longevity, cadence, volume, active ratio, format diversity, platform
 * spread) so the score is explainable — the "so what", not a bare number
 * (insight-ladder-l4-l5-gate). The same panel surfaces the longevity leaderboard
 * (`leaderboard` action), the refresh cadence + net-new-ad alerts (`net-new` action).
 * Injected by f10-competitors.js only when the maturity visibility probe finds a
 * maturity score for this client (probe-driven, absent-safe) — same runtime nav+panel
 * pattern as the ads, themes, and age panels. */
function competitorMaturityPanelMarkup(){
  return `
    <!-- COMPETITORS: META MATURITY SCORE -->
    <div class="tab-panel comp-tab-panel" id="panel-competitor-maturity">
      <div class="insight-box"><strong>Meta Maturity Score:</strong> who is winning on Meta &mdash; and <strong>why</strong>. Every competitor and <strong>you</strong> are ranked by a single 0&ndash;100 maturity score, but the score is never a black box: the six components below it (longevity, cadence, volume, active ratio, format diversity, platform spread) show exactly what drives a high or low score. Read your own rank and tier first, then read across the component bars to see where you lead the set and where to close the gap.</div>
      <div class="window-note" id="compm-meta"></div>
      <div class="window-note" id="compm-note"></div>
      <div id="compm-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="compm-body" style="display:none;"></div>
    </div>
`;
}

/* ── "How to read this tab" notes ──
 * Plain-English, client-facing guidance shown at the top of every tab, plus a
 * one-line definition of what a "conversion" is for this account. Rendered only
 * when SHOW_HOW_TO_NOTES is true (default off), so dashboards that don't opt in
 * are unchanged. Copy leads with the tab's purpose then hands off to the insight
 * box below for the mechanics; the conversion line is worded from CONV_LABEL. */
const HOW_TO_READ = {
  summary:    'Start here each week for a quick read on how the account is tracking versus the previous 7 days. The tiles are your headline numbers and how each one moved; the note and chart below explain what drove the change.',
  board:      'Come here to act on individual ads. It flags whether each ad is growing, slipping, brand new, or gone, so you can decide what to back and what to pause. The note below covers how the list is built.',
  map:        'A bird&rsquo;s&#8209;eye view for spotting outliers fast: your best ads gather in one corner and the budget&#8209;drainers in another. Use it to see where the winners and problem ads sit; the note below explains the axes.',
  powerlaw:   `Use this to answer one question: are your biggest&#8209;spending ads also your most efficient? Skim the top of the ranking and read across to ${targetMetricDef().label}. The note and concentration chart below explain the bigger picture.`,
  production: 'Use this to judge your testing as a whole rather than single ads &mdash; what share of everything you launch turns into a winner. The target hit rate and the thresholds behind each grade (which you can tune) are defined below.',
  decay:      'Use this for planning ahead: it shows how quickly older ads fade, which tells you how much fresh creative to line up to keep spend steady. The note and cohort charts below go into the detail.',
  age:        'Use this to check how fresh your running creative is. If a few older ads are doing most of the work, take it as a nudge to test more. The age bands and the healthy&#8209;mix benchmark are explained below.',
  creative:   'Use this to understand why an ad grabs people or loses them, beyond what it costs, so you can brief sharper creative next time. The attention measures (hold, completion, drop&#8209;off) are defined below.',
};
/* One-line "what counts as a conversion" definition, worded from CONV_LABEL. */
function convDefinitionHTML(){
  const p = convLabelPlural();
  const sl = convLabel().toLowerCase();
  if (targetMetric() === 'roas'){
    return `<div class="dash-note-def"><strong>Conversions on this dashboard = ${p}.</strong> Every conversion count shown here is based on ${p.toLowerCase()}; <strong>ROAS</strong> is revenue &divide; spend.</div>`;
  }
  return `<div class="dash-note-def"><strong>Conversions on this dashboard = ${p}.</strong> Every conversion count and <strong>CPA</strong> (cost per ${sl}) shown here is based on ${p.toLowerCase()}.</div>`;
}
/* Full note block for a tab, or '' when notes are switched off. */
function howToNote(tabKey){
  if (!showHowToNotes()) return '';
  const body = HOW_TO_READ[tabKey] || '';
  return `<div class="dash-note"><div class="dash-note-title">How to read this tab</div>` +
    `<div class="dash-note-body">${body}</div>${convDefinitionHTML()}</div>`;
}

/* ── Revenue-integrity guard (US-010) ──────────────────────────────────────
 * Dashboard-side half of the revenue guard; a warehouse-side integrity check
 * on the gated revenue column is the complementary half. Neither replaces the
 * other.
 *
 * In ROAS mode, a window whose BLENDED revenue is 0 while spend > 0 is the
 * signature of a missing or zeroed gated revenue column (REVENUE_EXPR). Rendering
 * a confident "0.0x" there would launder a broken pipeline into a real headline.
 * We show a warning banner instead so nobody acts on an understated number —
 * decisions should be downstream of clean data.
 *
 * Scope is deliberately BLENDED-only. A single real-spend / zero-revenue ad is a
 * legitimate 0 ROAS (a Strike Out) and still renders its own 0.0x on the board
 * and scatter — this guard never touches per-ad classification. It fires only
 * when EVERY dollar of spend in the window returned zero revenue, which no live
 * ROAS account produces; that is what separates "no revenue column / all rows
 * null" from "genuinely zero revenue on one ad". CPA mode (TARGET_METRIC unset)
 * can never trip it. */
const REVENUE_GUARD_MSG = 'Revenue data looks incomplete for this window — ROAS may be understated. Check the pipeline before acting.';

/* Pure predicate over an already-fetched blended aggregate — no query, no DOM. */
function revenueSignalBroken(revenue, spend){
  return targetMetric() === 'roas' && Number(spend) > 0 && !(Number(revenue) > 0);
}

function revenueGuardBannerHTML(){
  return `<div class="revenue-guard" role="alert" style="background:rgba(250,2,60,0.06);border:2px solid var(--bad);border-left-width:6px;border-radius:8px;padding:13px 16px;margin-bottom:18px;font-size:12.5px;line-height:1.5;color:var(--young-blood);">`
    + `<strong style="display:block;letter-spacing:0.06em;text-transform:uppercase;font-size:11px;color:var(--bad);margin-bottom:4px;">Revenue integrity warning</strong>`
    + `${REVENUE_GUARD_MSG}`
    + `</div>`;
}

/* Inject-or-clear the guard banner into `slotId`. `broken` is a boolean the
 * caller already derived from the tab's own aggregates (weekly: blended
 * revenue/spend; production: whether any ad has positive ROAS against spend), so
 * this adds no query and no measurable load. Returns `broken` for convenience. */
function applyRevenueGuard(slotId, broken){
  const slot = document.getElementById(slotId);
  if(slot) slot.innerHTML = broken ? revenueGuardBannerHTML() : '';
  return broken;
}

/* Co-branding: F10 wordmark for the sidebar lockup. Fills use currentColor so it
 * tints to --sidebar-accent. Rendered only when a client sets BRANDING.clientLogo. */
const F10_MARK_SVG = `<svg viewBox="366 423 2205 608" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet"><path d="M2422.77 441.877L2389.04 453.121V691.877H2365.8L2196.38 496.974V668.264L2237.24 679.508V691.877H2140.91V679.508L2174.64 668.264V475.985L2143.91 440.752V429.508H2191.14L2367.3 633.781V453.121L2326.07 441.877V429.508H2422.77V441.877Z" fill="currentColor"></path><path d="M2108.76 429.508L2117.38 504.096L2106.89 506.719L2064.91 448.623H1963.33V549.823H2026.68L2046.92 512.341H2056.66V606.045H2046.92L2026.68 568.938H1963.33V672.761H2067.16L2112.88 610.542L2123 613.541L2113.63 691.877H1890.62V679.508L1924.35 668.264V453.121L1890.62 441.877V429.508H2108.76Z" fill="currentColor"></path><path d="M1858.47 429.508L1867.09 504.096L1856.6 506.719L1814.62 448.623H1713.04V549.823H1776.39L1796.63 512.341H1806.37V606.045H1796.63L1776.39 568.938H1713.04V672.761H1816.86L1862.59 610.542L1872.71 613.541L1863.34 691.877H1640.33V679.508L1674.06 668.264V453.121L1640.33 441.877V429.508H1858.47Z" fill="currentColor"></path><path d="M1637.72 504.096L1627.6 506.719L1585.62 448.623H1530.52V668.264L1575.5 679.508V691.877H1446.57V679.508L1491.54 668.264V448.623H1436.82L1394.47 506.719L1384.35 504.096L1392.59 429.508H1629.48L1637.72 504.096Z" fill="currentColor"></path><path d="M1292.22 429.508C1308.97 429.508 1323.21 432.631 1334.95 438.878C1346.95 444.875 1355.94 452.871 1361.94 462.866C1368.19 472.861 1371.31 483.606 1371.31 495.1C1371.31 510.842 1365.69 525.335 1354.44 538.578C1343.2 551.822 1327.08 560.692 1306.09 565.19L1356.69 640.902C1364.69 652.896 1372.43 662.517 1379.93 669.763C1387.43 677.009 1394.55 681.507 1401.29 683.256V693.376C1392.55 696.375 1384.05 697.874 1375.81 697.874C1364.31 697.874 1354.07 694.75 1345.07 688.504C1336.08 682.257 1327.46 672.387 1319.21 658.893L1265.24 568.938H1231.13V668.264L1264.86 679.508V691.877H1158.42V679.508L1192.15 668.264V453.121L1158.42 441.877V429.508H1292.22ZM1231.13 549.823H1267.49C1280.23 549.823 1291.1 547.449 1300.1 542.701C1309.09 537.704 1315.84 531.332 1320.34 523.586C1324.83 515.84 1327.08 507.594 1327.08 498.848C1327.08 490.103 1324.96 481.857 1320.71 474.111C1316.46 466.364 1310.09 460.242 1301.59 455.745C1293.1 450.997 1282.98 448.623 1271.23 448.623H1231.13V549.823Z" fill="currentColor"></path><path d="M1148.88 441.877L1115.15 453.121V603.796C1115.15 624.036 1110.4 641.277 1100.91 655.52C1091.66 669.513 1079.29 680.133 1063.8 687.379C1048.31 694.376 1031.69 697.874 1013.95 697.874C994.961 697.874 976.97 694.001 959.978 686.255C943.237 678.509 929.618 667.139 919.124 652.147C908.629 636.904 903.382 618.788 903.382 597.799V453.121L869.648 441.877V429.508H976.095V441.877L942.362 453.121V603.796C942.362 619.038 945.86 632.157 952.857 643.151C960.103 654.146 969.599 662.517 981.343 668.264C993.087 674.011 1005.83 676.884 1019.57 676.884C1033.07 676.884 1045.44 674.136 1056.68 668.638C1067.92 663.141 1076.8 655.02 1083.29 644.276C1090.04 633.281 1093.41 620.163 1093.41 604.92V453.121L1052.56 441.877V429.508H1148.88V441.877Z" fill="currentColor"></path><path d="M726.43 423.137C751.667 423.137 774.156 428.884 793.896 440.378C813.886 451.622 829.503 467.739 840.748 488.729C852.242 509.469 857.989 533.582 857.989 561.068C857.989 587.805 852.492 611.543 841.497 632.282C830.503 653.022 815.135 669.139 795.395 680.633C775.905 692.127 753.666 697.875 728.678 697.875C703.691 697.875 681.202 692.252 661.212 681.008C641.472 669.514 625.855 653.397 614.361 632.657C602.866 611.668 597.119 587.43 597.119 559.943C597.119 533.207 602.616 509.469 613.611 488.729C624.855 467.989 640.223 451.872 659.713 440.378C679.453 428.884 701.692 423.137 726.43 423.137ZM720.807 439.254C703.566 439.254 688.948 444.251 676.954 454.246C665.21 464.241 656.34 477.61 650.343 494.351C644.346 510.843 641.347 529.209 641.347 549.449C641.347 572.437 644.97 594.051 652.217 614.291C659.713 634.531 670.458 650.898 684.451 663.392C698.693 675.636 715.31 681.758 734.301 681.758C751.542 681.758 766.16 676.76 778.154 666.765C790.148 656.77 799.018 643.527 804.766 627.035C810.763 610.293 813.761 591.803 813.761 571.563C813.761 548.574 810.138 526.96 802.891 506.72C795.645 486.48 784.9 470.238 770.658 457.994C756.665 445.501 740.048 439.254 720.807 439.254Z" fill="currentColor"></path><path d="M580.944 429.508L589.564 504.096L579.07 506.719L537.091 448.623H439.264V549.823H502.608L522.848 512.341H532.593V606.045H522.848L502.608 568.938H439.264V668.264L484.242 679.508V691.877H366.551V679.508L400.284 668.264V453.121L366.551 441.877V429.508H580.944Z" fill="currentColor"></path><path d="M1771.84 780.521L1738.11 791.766V1030.52H1714.87L1545.46 835.619V1006.91L1586.31 1018.15V1030.52H1489.98V1018.15L1523.72 1006.91V814.629L1492.98 779.397V768.152H1540.21L1716.37 972.425V791.766L1675.14 780.521V768.152H1771.84V780.521Z" fill="currentColor"></path><path d="M1457.83 768.152L1466.46 842.74L1455.96 845.364L1413.98 787.268H1312.41V888.467H1375.75L1395.99 850.986H1405.74V944.689H1395.99L1375.75 907.583H1312.41V1011.41H1416.23L1461.96 949.187L1472.08 952.186L1462.71 1030.52H1239.69V1018.15L1273.43 1006.91V791.766L1239.69 780.521V768.152H1457.83Z" fill="currentColor"></path><path d="M1237.08 842.74L1226.96 845.364L1184.99 787.268H1129.89V1006.91L1174.87 1018.15V1030.52H1045.93V1018.15L1090.91 1006.91V787.268H1036.18L993.831 845.364L983.711 842.74L991.957 768.152H1228.84L1237.08 842.74Z" fill="currentColor"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M2571 471.5C2571 496.629 2550.63 517 2525.5 517C2500.37 517 2480 496.629 2480 471.5C2480 446.371 2500.37 426 2525.5 426C2550.63 426 2571 446.371 2571 471.5ZM2525.5 505C2544 505 2559 490.002 2559 471.5C2559 452.998 2544 438 2525.5 438C2507 438 2492 452.998 2492 471.5C2492 490.002 2507 505 2525.5 505Z" fill="currentColor"></path><path d="M2520.67 490.413H2512V455H2541.86V462.4H2520.67V468.637H2541.6V476.036H2520.67V490.413Z" fill="currentColor"></path></svg>`;

/* Map a BRANDING config to inline CSS custom-property overrides. Only keys that are
 * set emit a declaration, so any unspecified token keeps its F10 default. */
function f10ThemeVars(b){
  if (!b) return '';
  const map = { sidebarBg:'--sidebar-bg', brand:'--young-blood', accent:'--stabilo',
                sidebarAccent:'--sidebar-accent', navActiveBg:'--nav-active-bg',
                onBrand:'--on-brand', accentSoft:'--accent-soft' };
  let css = '';
  for (const k in map){ if (b[k]) css += map[k] + ':' + b[k] + ';'; }
  return css;
}

function renderLayout(){
  const client = (typeof CLIENT_NAME !== 'undefined' && CLIENT_NAME) ? CLIENT_NAME : 'Client';
  const report = (typeof REPORT_NAME !== 'undefined' && REPORT_NAME) ? REPORT_NAME : 'Creative Reporting';

  /* Optional co-branding (see f10-shared.css tokens + starter BRANDING block). */
  const branding = (typeof BRANDING !== 'undefined' && BRANDING) ? BRANDING : null;
  const lockupHTML = (branding && branding.clientLogo)
    ? `<div class="sidebar-lockup"><span class="client-mark">${branding.clientLogo}</span>`
      + `<span class="lockup-divider"></span><span class="f10-mark">${F10_MARK_SVG}</span></div>`
    : '';
  const footerHTML = (branding && branding.footer) ? branding.footer : 'F10 | Creative Reporting<br/>Powered by BigQuery';

  const prodBenchmark = prodBenchmarkHTML();

  const hasTikTok = (typeof TIKTOK !== 'undefined' && TIKTOK && TIKTOK.TABLE);
  const ttTh = Object.assign({ HR_SPEND:5000, HR_CPA:70, OB_SPEND:1000, OB_CPA:100, SO_SPEND:500, SO_CPA:140, HR_ROAS:4, OB_ROAS:2, SO_ROAS:1 }, (hasTikTok && TIKTOK.THRESHOLDS) || {});
  const ttNav = hasTikTok ? `<div class="nav-section">TikTok</div>
      <a href="#" class="tt-nav-link" data-tt-tab="tt-summary">Weekly Summary</a>
      <a href="#" class="tt-nav-link" data-tt-tab="tt-board">Movement Board</a>
      <a href="#" class="tt-nav-link" data-tt-tab="tt-production">Ad Production</a>
      <a href="#" class="tt-nav-link" data-tt-tab="tt-creative">Creative Effectiveness</a>` : '';
  const ttControls = hasTikTok ? ttControlsMarkup() : '';
  const ttPanels = hasTikTok ? ttPanelsMarkup(ttTh) : '';

  /* Efficiency-metric dropdown is metric-aware. In ROAS mode ROAS leads the list
   * and is selected by default so the Movement Board/Map and blended tile render
   * ROAS out of the box (they read METRICS[ctrl-metric.value]); CPA/CPC/CPM/CTR
   * remain available. In CPA mode the option set is exactly the legacy list, so
   * existing dashboards are unchanged. */
  const metricOptions = efficiencyMetricOptionsHTML();

  const floorMult = noiseFloorMultLabels();

  document.getElementById('app').innerHTML = `
  <div id="sidebar">
    <div class="sidebar-header">
      ${lockupHTML}
      <div class="client-name">${client}</div>
      <div class="report-name">${report}</div>
    </div>
    <nav>
      <div class="nav-section">Weekly</div>
      <a href="#" class="nav-link active" data-tab="summary">Weekly Summary</a>
      <a href="#" class="nav-link" data-tab="board">Movement Board</a>
      <a href="#" class="nav-link" data-tab="map">Movement Map</a>
      <div class="nav-section">Monthly</div>
      <a href="#" class="nav-link" data-tab="powerlaw">Ad Power Law</a>
      <a href="#" class="nav-link" data-tab="production">Ad Production</a>
      <a href="#" class="nav-link" data-tab="decay">Ad Decay</a>
      <a href="#" class="nav-link" data-tab="age">Ad Age</a>
      <a href="#" class="nav-link" data-tab="creative">Creative Effectiveness</a>
      ${ttNav}
    </nav>
    <div class="sidebar-footer">${footerHTML}</div>
  </div>

  <div id="content">
    <div class="page-header">
      <h1 id="page-title">Weekly Summary</h1>
      <div class="header-right">
        <span class="last-updated" id="last-updated">Loading&hellip;</span>
        <button class="refresh-btn" id="refresh-btn">&circlearrowleft; Refresh</button>
      </div>
    </div>

    <!-- Global controls: group filters (all tabs) + weekly-only controls -->
    <div class="controls-bar" id="controls-bar" style="display:none;">
      <div id="ctrl-groups" class="ctrl-groups"></div>
      <div id="ctrl-scope" class="ctrl-groups">
        <div class="ctrl"><label>Search ad</label><input type="search" id="ctrl-adsearch" class="ctrl-search" placeholder="Ad name&hellip;" autocomplete="off" /></div>
        <div class="ctrl"><label>Ad status</label><select id="ctrl-status"><option value="all" selected>All ads</option><option value="active">Active only</option></select></div>
      </div>
      <div id="weekly-controls" class="weekly-controls">
        <div class="ctrl"><label>Window length</label>
          <select id="ctrl-length"><option value="7" selected>7 days</option><option value="14">14 days</option><option value="28">28 days</option></select>
        </div>
        <div class="ctrl"><label>Current window ends</label><input type="date" id="ctrl-enddate" /></div>
        <div class="ctrl"><label>Efficiency metric</label>
          <select id="ctrl-metric">${metricOptions}</select>
        </div>
        <div class="ctrl"><label>Noise floor</label>
          <div class="seg" id="ctrl-floor"><button data-floor="cpaMult">${floorMult.btn}</button><button data-floor="fixed" class="active">Fixed spend</button><button data-floor="conv">Min conv.</button></div>
        </div>
        <div class="floor-inputs">
          <div id="floor-cpaMult"><label>${floorMult.label}</label><div style="display:flex;gap:6px;"><input type="number" id="ctrl-targetcpa" value="70" min="0" step="1" title="${floorMult.title}" /><input type="number" id="ctrl-mult" value="3" min="0" step="0.5" title="Multiple" style="width:56px;" /></div></div>
          <div id="floor-fixed" class="show"><label>Min spend ($)</label><input type="number" id="ctrl-fixedspend" value="1" min="0" step="50" /></div>
          <div id="floor-conv"><label>Min conversions</label><input type="number" id="ctrl-minconv" value="3" min="0" step="1" /></div>
        </div>
      </div>
    </div>

${ttControls}

        <!-- WEEKLY: SUMMARY -->
    <div class="tab-panel active" id="tab-summary">
      ${howToNote('summary')}
      <div class="insight-box"><strong>What this answers:</strong> how the account moved this window versus the previous equal-length window, and <em>why</em> &mdash; was the change driven by the creatives themselves getting better or worse (efficiency), or by budget shifting between ads and ads entering/leaving (mix &amp; flow)?</div>
      <div class="window-note" id="summary-window-note"></div>
      <div id="summary-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="summary-body" style="display:none;">
        <div id="summary-revenue-guard"></div>
        <div class="scorecard-grid" id="summary-scorecards"></div>
        <div class="chart-card">
          <h3>Blended Metric Decomposition &mdash; Prior &rarr; Current</h3>
          <div class="legend-row"><span class="li"><span class="dot" style="background:var(--good)"></span> Improves the metric</span><span class="li"><span class="dot" style="background:var(--bad)"></span> Worsens the metric</span></div>
          <div class="chart-wrapper" style="height:360px;"><canvas id="decomp-chart"></canvas></div>
          <div class="window-note" id="decomp-note" style="margin-top:12px;"></div>
        </div>
      </div>
    </div>

    <!-- WEEKLY: BOARD -->
    <div class="tab-panel" id="tab-board">
      ${howToNote('board')}
      <div class="insight-box"><strong>Movement Board:</strong> every ad that cleared the noise floor in either window, current vs previous side by side, tagged by what it did. Sorted by current spend. Low-volume ads are filtered out so you are not chasing ratio noise.</div>
      <div class="window-note" id="board-window-note"></div>
      <div class="legend-row" id="board-legend"></div>
      <div class="table-card">
        <h3 id="board-title">Ad Movement</h3>
        <div class="table-scroll">
          <div id="board-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="board-table" style="display:none;">
            <thead><tr><th>Ad</th><th>State</th><th class="num">Spend</th><th class="num">&Delta; Spend</th><th class="num" id="board-m-head">Metric</th><th class="num">&Delta; Metric</th><th class="num">Conv.</th><th class="num">Impr.</th><th class="num">Hold %</th><th class="num">Compl. %</th><th>Preview</th></tr></thead>
            <tbody id="board-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- WEEKLY: MAP -->
    <div class="tab-panel" id="tab-map">
      ${howToNote('map')}
      <div class="insight-box"><strong>Movement Map:</strong> each qualifying ad plotted by current spend (x, how much it carries) against how its efficiency changed versus the prior window (y, up = better). Bubble size = current spend. Heroes sit top-right, drags bottom-right.</div>
      <div class="window-note" id="map-window-note"></div>
      <div class="chart-card"><h3>Spend vs Efficiency Change</h3>
        <div id="map-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
        <div class="chart-wrapper" id="map-wrapper" style="display:none; height:440px;"><canvas id="map-chart"></canvas></div>
      </div>
    </div>

    <!-- MONTHLY: AD POWER LAW -->
    <div class="tab-panel" id="tab-powerlaw">
      ${howToNote('powerlaw')}
      <div class="insight-box"><strong>Ad Power Law:</strong> A small number of ads drive the majority of spend. This view ranks every ad by its share of total spend in the last 90 days, with a rolling cumulative line to visualise concentration. A steep drop-off early in the chart confirms the power law effect &mdash; your top ads are pulling most of the weight.</div>
      <div class="chart-card"><h3>Spend Concentration &mdash; % of Total &amp; Cumulative</h3>
        <div id="powerlaw-chart-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
        <div class="chart-wrapper" id="powerlaw-chart-wrapper" style="display:none; min-height:320px;"><canvas id="powerlaw-chart"></canvas></div>
      </div>
      <div class="table-card"><h3>Ad Spend Ranking &mdash; Last 90 Days</h3>
        <div class="table-scroll">
          <div id="powerlaw-table-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="powerlaw-table" style="display:none;">
            <thead><tr><th>#</th><th>Campaign</th><th>Adset</th><th>Ad</th><th>Launch Date</th><th>Last Spend</th><th>Preview</th><th>Spend</th><th>Spend %</th><th>Rolling %</th><th>${targetMetricDef().label}</th></tr></thead>
            <tbody id="powerlaw-table-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- MONTHLY: AD PRODUCTION -->
    <div class="tab-panel" id="tab-production">
      ${howToNote('production')}
      <div class="insight-box"><strong>Why it's important:</strong> This chart measures the number of ads launched and the percentage of those that become "hits" (spending more than <span id="prod-hit-spend">${fmt$(HR_SPEND)}</span> lifetime).<br/><br/><strong>How to interpret it:</strong> Aim for a hit rate of 10&ndash;15%. A lower hit rate suggests a need for better ad quality, while a much higher hit rate might indicate you're not testing enough variety.<br/><br/><strong>Thresholds:</strong>
        <div class="benchmark" id="prod-benchmark">${prodBenchmark}</div>
      </div>
      <div class="threshold-controls" id="prod-threshold-controls">
        <div class="tc-header">
          <strong>Adjust thresholds</strong>
          <span class="tc-note">Tune the classification bands for this session. Reset restores the client defaults; a page reload also reverts.</span>
        </div>
        <div class="tc-grid">${prodThresholdFieldsHTML()}</div>
        <div class="tc-actions">
          <button class="tc-apply" id="th-apply">Apply thresholds</button>
          <button class="tc-reset" id="th-reset">Reset to defaults</button>
        </div>
      </div>
      <div id="production-revenue-guard"></div>
      <div id="production-scorecards-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="production-scorecards" style="display:none;">
        <div class="scorecard-grid">
          <div class="scorecard"><div class="scorecard-label">Ads Produced</div><div class="scorecard-value" id="sc-ads-produced">&ndash;</div></div>
          <div class="scorecard highlight"><div class="scorecard-label">Home Runs</div><div class="scorecard-value" id="sc-home-runs">&ndash;</div></div>
          <div class="scorecard highlight"><div class="scorecard-label">Home Run Rate</div><div class="scorecard-value" id="sc-hr-rate">&ndash;</div></div>
          <div class="scorecard"><div class="scorecard-label">On Base</div><div class="scorecard-value" id="sc-on-base">&ndash;</div></div>
          <div class="scorecard"><div class="scorecard-label">On Base Rate</div><div class="scorecard-value" id="sc-ob-rate">&ndash;</div></div>
          <div class="scorecard warn"><div class="scorecard-label">Strike Outs</div><div class="scorecard-value" id="sc-strike-outs">&ndash;</div></div>
          <div class="scorecard warn"><div class="scorecard-label">Strike Out Rate</div><div class="scorecard-value" id="sc-so-rate">&ndash;</div></div>
        </div>
      </div>
      <div class="two-col">
        <div class="chart-card" style="margin-bottom:0;"><h3>Lifetime Spend vs ${targetMetricDef().label} &mdash; All Ads</h3>
          <div class="threshold-legend" id="prod-threshold-legend">${prodThresholdLegendHTML()}</div>
          <div id="scatter-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <div class="chart-wrapper" id="scatter-wrapper" style="display:none; height:320px;"><canvas id="scatter-chart"></canvas></div>
        </div>
        <div class="chart-card" style="margin-bottom:0;"><h3>Ads Launched &amp; Hit Rates by Month</h3>
          <div id="production-chart-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <div class="chart-wrapper" id="production-chart-wrapper" style="display:none; height:320px;"><canvas id="production-chart"></canvas></div>
        </div>
      </div>
      <div class="table-card" style="margin-top:20px;"><h3>Monthly Production Summary</h3>
        <div class="table-scroll">
          <div id="production-table-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="production-table" style="display:none;">
            <thead><tr><th>Launch Month</th><th>Spend</th><th>Ads Launched</th><th>Home Runs</th><th>HR Rate</th><th>On Base</th><th>OB Rate</th><th>${targetMetricDef().label}</th><th>Conversions</th><th>Strike Outs</th><th>SO Rate</th></tr></thead>
            <tbody id="production-table-body"></tbody>
          </table>
        </div>
      </div>
      <div class="table-card"><h3>Ad-Level Classification</h3>
        <div class="table-scroll">
          <div id="scatter-table-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="scatter-table" style="display:none;">
            <thead><tr><th>Ad</th><th>Campaign</th><th>Adset</th><th>Launch Date</th><th>Lifetime Spend</th><th>Lifetime ${targetMetricDef().label}</th><th>Conversions</th><th class="num">Hold %</th><th class="num">Compl. %</th><th class="num">Out CTR</th><th>Preview</th><th>Classification</th></tr></thead>
            <tbody id="scatter-table-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- MONTHLY: AD DECAY -->
    <div class="tab-panel" id="tab-decay">
      ${howToNote('decay')}
      <div class="insight-box"><strong>Why it's important:</strong> This chart tracks how long it takes for ads launched in a specific month (cohorts) to churn. It helps in projecting future ad needs by understanding the churn rate of existing creatives.<br/><br/><strong>How to interpret it:</strong> Look at each month's cohort to see the decline in spend over time. This helps in forecasting the volume of new ads required to maintain or scale the total spend level.</div>
      <div class="table-card" style="margin-bottom:20px;"><h3>Cohort Summary</h3>
        <div class="table-scroll">
          <div id="decay-summary-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="decay-summary-table" style="display:none;">
            <thead><tr><th>Launch Month</th><th>Ads Launched</th><th>Avg Days Running</th><th>Spend</th><th>${targetMetricDef().label}</th></tr></thead>
            <tbody id="decay-summary-body"></tbody>
          </table>
        </div>
      </div>
      <div class="chart-card"><h3>Ad Spend by Cohort &mdash; Absolute ($)</h3>
        <div id="decay-chart-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
        <div class="chart-wrapper" id="decay-chart-wrapper" style="display:none;"><canvas id="decay-chart"></canvas></div>
      </div>
      <div class="chart-card"><h3>Ad Spend by Cohort &mdash; % Share</h3>
        <div id="decay-pct-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
        <div class="chart-wrapper" id="decay-pct-wrapper" style="display:none;"><canvas id="decay-pct-chart"></canvas></div>
      </div>
    </div>

    <!-- MONTHLY: AD AGE -->
    <div class="tab-panel" id="tab-age">
      ${howToNote('age')}
      <div class="insight-box"><strong>Why it's important:</strong> This chart shows the age distribution of creatives contributing to the daily spend. It highlights how much of the performance is driven by new ads versus long-standing winners.<br/><br/><strong>How to interpret it:</strong> A high reliance on older ads (&gt;90 days) indicates a need for more frequent and effective testing. Conversely, a healthy mix shows that the creative testing process is successfully identifying new winners.<br/><br/><strong>Healthy Mix:</strong>
        <div class="benchmark"><span class="bm-item"><strong>0&ndash;14 Days:</strong> 10&ndash;20%</span><span class="bm-item"><strong>15&ndash;90 Days:</strong> 20&ndash;40%</span><span class="bm-item"><strong>90+ Days:</strong> 40&ndash;50%</span></div>
      </div>
      <div class="chart-card"><h3>Daily Spend by Creative Age (%)</h3>
        <div id="age-chart-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
        <div class="chart-wrapper" id="age-chart-wrapper" style="display:none;"><canvas id="age-chart"></canvas></div>
      </div>
      <div class="table-card"><h3>Ad Library &mdash; Sorted by Spend</h3>
        <div class="table-scroll">
          <div id="age-table-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="age-table" style="display:none;">
            <thead><tr><th>Campaign</th><th>Adset</th><th>Ad</th><th>Launch Date</th><th>Last Spend</th><th>Preview</th><th>Spend &darr;</th><th>${targetMetricDef().label}</th><th>Conversions</th></tr></thead>
            <tbody id="age-table-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- MONTHLY: CREATIVE EFFECTIVENESS -->
    <div class="tab-panel" id="tab-creative">
      ${howToNote('creative')}
      <div class="insight-box"><strong>Creative Effectiveness:</strong> performance beyond ${targetMetricDef().label} &mdash; how well each creative holds attention. <strong>Hold rate</strong> is the share of impressions that watched 15 seconds; <strong>completion</strong> watched to the end; the <strong>retention curve</strong> (25 &rarr; 100%) shows where viewers drop off. Hover any ad to see its creative and curve. Rates cover the last 90 days; non-video ads show &ndash;.</div>
      <div class="chart-card"><h3>Average Video Retention Curve &mdash; % of Impressions Reaching Each Quartile</h3>
        <div id="creative-chart-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
        <div class="chart-wrapper" id="creative-chart-wrapper" style="display:none; height:320px;"><canvas id="creative-chart"></canvas></div>
      </div>
      <div class="table-card"><h3>Creative Effectiveness by Ad &mdash; Last 90 Days</h3>
        <div class="table-scroll">
          <div id="creative-table-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="creative-table" style="display:none;">
            <thead><tr><th>Ad</th><th>Campaign</th><th class="num">Spend</th><th class="num">Impr.</th><th class="num">Hold %</th><th class="num">Compl. %</th><th class="num">25%</th><th class="num">50%</th><th class="num">75%</th><th class="num">100%</th><th class="num">CTR</th><th class="num">Out CTR</th><th>Preview</th></tr></thead>
            <tbody id="creative-table-body"></tbody>
          </table>
        </div>
      </div>
    </div>

  ${ttPanels}

  </div>`;
  /* Apply theme overrides on the document root (:root), not #app. CSS still
   * cascades (root is an ancestor of everything), AND the chart code's getCSS()
   * reads via getComputedStyle(document.documentElement) — so canvas colours like
   * the decomposition bars (getCSS('--young-blood')) pick up the theme too. */
  const _f10Theme = f10ThemeVars(branding);
  if (_f10Theme) document.documentElement.style.cssText += ';' + _f10Theme;
  initTableSorting();

  if (window.F10A) {
    F10A.init({ client: client, dashboardType: 'creative' });
    F10A.track('dashboard_loaded', { report: report });
  }

  if (hasTikTok && typeof initTikTok === 'function') initTikTok();
  /* Competitor tab visibility is probe-driven (US-003): f10-competitors.js runs a
   * cheap existence probe and registers its own nav entry + panel only when the
   * client has competitor rows — so this call is unconditional. */
  if (typeof initCompetitors === 'function') initCompetitors();
}
