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
  return `<span class="bm-item"><strong>Home Run:</strong> Spend &ge; ${fmt$(HR_SPEND)} &amp; CPA &lt; ${fmt$(HR_CPA)}</span>` +
    `<span class="bm-item"><strong>On Base:</strong> Spend &ge; ${fmt$(OB_SPEND)} &amp; CPA &lt; ${fmt$(OB_CPA)}</span>` +
    `<span class="bm-item"><strong>Strike Out:</strong> Spend &ge; ${fmt$(SO_SPEND)} &amp; CPA &gt; ${fmt$(SO_CPA)}</span>`;
}
function prodThresholdLegendHTML(){
  return `<span class="tl-item"><span class="tl-line dashed" style="color:#727272;"></span> CPA Limit (${fmt$(HR_CPA)})</span><span class="tl-item"><span class="tl-line dashed" style="color:#4a90e2;"></span> Ad Hit (${fmt$(HR_SPEND)})</span>`;
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

/* ── "How to read this tab" notes ──
 * Plain-English, client-facing guidance shown at the top of every tab, plus a
 * one-line definition of what a "conversion" is for this account. Rendered only
 * when SHOW_HOW_TO_NOTES is true (default off), so dashboards that don't opt in
 * are unchanged. Copy is generic; the conversion line is worded from CONV_LABEL. */
const HOW_TO_READ = {
  summary:    'Start here each week for a quick read on how the account is tracking versus the previous 7 days. The tiles are your headline numbers and how each one moved; the note and chart below explain what drove the change.',
  board:      'Come here to act on individual ads. It flags whether each ad is growing, slipping, brand new, or gone, so you can decide what to back and what to pause. The note below covers how the list is built.',
  map:        'A bird&rsquo;s&#8209;eye view for spotting outliers fast: your best ads gather in one corner and the budget&#8209;drainers in another. Use it to see where the winners and problem ads sit; the note below explains the axes.',
  powerlaw:   'Use this to answer one question: are your biggest&#8209;spending ads also your most efficient? Skim the top of the ranking and read across to CPA. The note and concentration chart below explain the bigger picture.',
  production: 'Use this to judge your testing as a whole rather than single ads &mdash; what share of everything you launch turns into a winner. The target hit rate and the thresholds behind each grade (which you can tune) are defined below.',
  decay:      'Use this for planning ahead: it shows how quickly older ads fade, which tells you how much fresh creative to line up to keep spend steady. The note and cohort charts below go into the detail.',
  age:        'Use this to check how fresh your running creative is. If a few older ads are doing most of the work, take it as a nudge to test more. The age bands and the healthy&#8209;mix benchmark are explained below.',
  creative:   'Use this to understand why an ad grabs people or loses them, beyond what it costs, so you can brief sharper creative next time. The attention measures (hold, completion, drop&#8209;off) are defined below.',
};
/* One-line "what counts as a conversion" definition, worded from CONV_LABEL. */
function convDefinitionHTML(){
  const p = convLabelPlural();
  const sl = convLabel().toLowerCase();
  return `<div class="dash-note-def"><strong>Conversions on this dashboard = ${p}.</strong> Every conversion count and <strong>CPA</strong> (cost per ${sl}) shown here is based on ${p.toLowerCase()}.</div>`;
}
/* Full note block for a tab, or '' when notes are switched off. */
function howToNote(tabKey){
  if (!showHowToNotes()) return '';
  const body = HOW_TO_READ[tabKey] || '';
  return `<div class="dash-note"><div class="dash-note-title">How to read this tab</div>` +
    `<div class="dash-note-body">${body}</div>${convDefinitionHTML()}</div>`;
}

function renderLayout(){
  const client = (typeof CLIENT_NAME !== 'undefined' && CLIENT_NAME) ? CLIENT_NAME : 'Client';
  const report = (typeof REPORT_NAME !== 'undefined' && REPORT_NAME) ? REPORT_NAME : 'Creative Reporting';

  const prodBenchmark = prodBenchmarkHTML();

  document.getElementById('app').innerHTML = `
  <div id="sidebar">
    <div class="sidebar-header">
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
    </nav>
    <div class="sidebar-footer">F10 | Creative Reporting<br/>Powered by BigQuery</div>
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
      <div id="weekly-controls" class="weekly-controls">
        <div class="ctrl"><label>Window length</label>
          <select id="ctrl-length"><option value="7" selected>7 days</option><option value="14">14 days</option><option value="28">28 days</option></select>
        </div>
        <div class="ctrl"><label>Current window ends</label><input type="date" id="ctrl-enddate" /></div>
        <div class="ctrl"><label>Efficiency metric</label>
          <select id="ctrl-metric"><option value="CPA" selected>CPA (cost / conversion)</option><option value="CPC">CPC (cost / click)</option><option value="CPM">CPM (cost / 1k impr)</option><option value="CTR">CTR (clicks / impr)</option></select>
        </div>
        <div class="ctrl"><label>Noise floor</label>
          <div class="seg" id="ctrl-floor"><button data-floor="cpaMult" class="active">&times; target CPA</button><button data-floor="fixed">Fixed spend</button><button data-floor="conv">Min conv.</button></div>
        </div>
        <div class="floor-inputs">
          <div id="floor-cpaMult" class="show"><label>Target CPA / Mult</label><div style="display:flex;gap:6px;"><input type="number" id="ctrl-targetcpa" value="70" min="0" step="1" title="Target CPA ($)" /><input type="number" id="ctrl-mult" value="3" min="0" step="0.5" title="Multiple" style="width:56px;" /></div></div>
          <div id="floor-fixed"><label>Min spend ($)</label><input type="number" id="ctrl-fixedspend" value="500" min="0" step="50" /></div>
          <div id="floor-conv"><label>Min conversions</label><input type="number" id="ctrl-minconv" value="3" min="0" step="1" /></div>
        </div>
      </div>
    </div>

    <!-- WEEKLY: SUMMARY -->
    <div class="tab-panel active" id="tab-summary">
      ${howToNote('summary')}
      <div class="insight-box"><strong>What this answers:</strong> how the account moved this window versus the previous equal-length window, and <em>why</em> &mdash; was the change driven by the creatives themselves getting better or worse (efficiency), or by budget shifting between ads and ads entering/leaving (mix &amp; flow)?</div>
      <div class="window-note" id="summary-window-note"></div>
      <div id="summary-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
      <div id="summary-body" style="display:none;">
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
            <thead><tr><th>#</th><th>Campaign</th><th>Adset</th><th>Ad</th><th>Launch Date</th><th>Last Spend</th><th>Preview</th><th>Spend</th><th>Spend %</th><th>Rolling %</th><th>CPA</th></tr></thead>
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
        <div class="tc-grid">
          <div class="tc-field"><label for="th-hr-spend">Home Run — min spend ($)</label><input type="number" id="th-hr-spend" min="0" step="100" /></div>
          <div class="tc-field"><label for="th-ob-spend">On Base — min spend ($)</label><input type="number" id="th-ob-spend" min="0" step="100" /></div>
          <div class="tc-field"><label for="th-so-spend">Strike Out — min spend ($)</label><input type="number" id="th-so-spend" min="0" step="100" /></div>
          <div class="tc-field"><label for="th-hr-cpa">Home Run — max CPA ($)</label><input type="number" id="th-hr-cpa" min="0" step="1" /></div>
          <div class="tc-field"><label for="th-ob-cpa">On Base — max CPA ($)</label><input type="number" id="th-ob-cpa" min="0" step="1" /></div>
          <div class="tc-field"><label for="th-so-cpa">Strike Out — min CPA ($)</label><input type="number" id="th-so-cpa" min="0" step="1" /></div>
        </div>
        <div class="tc-actions">
          <button class="tc-apply" id="th-apply">Apply thresholds</button>
          <button class="tc-reset" id="th-reset">Reset to defaults</button>
        </div>
      </div>
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
        <div class="chart-card" style="margin-bottom:0;"><h3>Lifetime Spend vs CPA &mdash; All Ads</h3>
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
            <thead><tr><th>Launch Month</th><th>Spend</th><th>Ads Launched</th><th>Home Runs</th><th>HR Rate</th><th>On Base</th><th>OB Rate</th><th>CPA</th><th>Conversions</th><th>Strike Outs</th><th>SO Rate</th></tr></thead>
            <tbody id="production-table-body"></tbody>
          </table>
        </div>
      </div>
      <div class="table-card"><h3>Ad-Level Classification</h3>
        <div class="table-scroll">
          <div id="scatter-table-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>
          <table id="scatter-table" style="display:none;">
            <thead><tr><th>Ad</th><th>Campaign</th><th>Adset</th><th>Launch Date</th><th>Lifetime Spend</th><th>Lifetime CPA</th><th>Conversions</th><th class="num">Hold %</th><th class="num">Compl. %</th><th class="num">Out CTR</th><th>Preview</th><th>Classification</th></tr></thead>
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
            <thead><tr><th>Launch Month</th><th>Ads Launched</th><th>Avg Days Running</th><th>Spend</th><th>CPA</th></tr></thead>
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
            <thead><tr><th>Campaign</th><th>Adset</th><th>Ad</th><th>Launch Date</th><th>Last Spend</th><th>Preview</th><th>Spend &darr;</th><th>CPA</th><th>Conversions</th></tr></thead>
            <tbody id="age-table-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- MONTHLY: CREATIVE EFFECTIVENESS -->
    <div class="tab-panel" id="tab-creative">
      ${howToNote('creative')}
      <div class="insight-box"><strong>Creative Effectiveness:</strong> performance beyond CPA &mdash; how well each creative holds attention. <strong>Hold rate</strong> is the share of impressions that watched 15 seconds; <strong>completion</strong> watched to the end; the <strong>retention curve</strong> (25 &rarr; 100%) shows where viewers drop off. Hover any ad to see its creative and curve. Rates cover the last 90 days; non-video ads show &ndash;.</div>
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

  </div>`;
  initTableSorting();

  if (window.F10A) {
    F10A.init({ client: client, dashboardType: 'creative' });
    F10A.track('dashboard_loaded', { report: report });
  }
}
