/**
 * f10-components.js - F10 Creative Dashboard Component Scale tab (probe-driven, US-004)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@TAG/f10-components.js"></script>
 *
 * Must be loaded AFTER f10-utils.js (it reuses runQuery, the guardrailed generic
 * BigQuery path) and BEFORE f10-layout.js, so the one-line initComponents() call at
 * the tail of renderLayout() can dispatch it (the module cannot bootstrap from its own
 * script tag alone - it exposes window.initComponents and waits to be called).
 *
 * WHAT IT SHOWS: the per-client creative Component Scale from the pipeline's US-002
 * mart {client}_marts.component_performance - every value of the five canonical
 * components (hook, format, call-to-action, message angle, visual style) graded
 * against the client's OWN baseline, with the spend-weighted lift, the delivered
 * evidence count, the confidence tier, and the verbatim "descriptive" honesty caveat
 * (these are associations, not causal claims). Any grade carrying the US-005
 * co_occurrence_flag is marked so a brief never cites a lift that is likely driven by
 * a co-present component. A separate, clearly labelled section renders the US-003
 * cross-client whitespace lane (all_clients.component_whitespace): values proven on
 * other clients but untested here - hypotheses, never grades, no names, no numbers.
 *
 * VISIBILITY IS DATA-DRIVEN: on boot a cheap EXISTS probe asks whether this client's
 * component_performance table has any rows. Only then does the module inject its own
 * "Creative Components" nav section, its "Component Scale" nav link and its panel.
 * A dashboard whose client has no mart (probe returns no rows, or the table does not
 * exist and the query errors) shows NO tab and leaves zero trace in the DOM - it fails
 * closed, never a broken or empty tab.
 *
 * GUARDRAILS: every query runs through runQuery() (f10-utils.js), which posts to the
 * shared Netlify bq function. That function applies the same 2 GB maximumBytesBilled
 * cap and 30 s jobTimeoutMs the competitor and media actions use, so this tab reuses
 * the existing guardrail wiring rather than pasting another copy of the query options.
 *
 * TAB ACTIVATION: selecting the tab goes through the single generic dispatcher
 * f10ActivateTab() (f10-layout.js), which clears EVERY nav link and EVERY panel before
 * activating the selected pair. The module never hard-codes the other tabs' classes,
 * so adding it did not require editing any existing module - it is the fix for the
 * old O(tabs^2) activation coupling where each module cleared a hand-maintained list
 * of every other module's nav-link classes.
 *
 * CONFIG: COMPONENTS is OPTIONAL overrides only.
 *   const COMPONENTS = {
 *     CLIENT: 'mosh',            // optional; override the f10 client slug when DATASET
 *                                // does not follow the {client}_marts / {client}_clean convention
 *     SUPPRESS_CO_OCCURRENCE: false, // optional; true hides co-occurrence-flagged grades
 *                                    // outright instead of marking them (default: mark)
 *   };
 */
(function () {
  'use strict';

  /* Optional overrides only. */
  var CFG = (typeof COMPONENTS !== 'undefined' && COMPONENTS) ? COMPONENTS : {};

  /* The five canonical component columns carried on component_performance, in the
   * order the tab renders them, each with a human-readable section heading. Kept in
   * lockstep with includes/component_grading.js CANONICAL_COMPONENTS in f10-dataform. */
  var COMPONENT_ORDER = [
    { key: 'hook_type', label: 'Hook' },
    { key: 'format_canonical', label: 'Format' },
    { key: 'cta_type', label: 'Call to action' },
    { key: 'message_angle_canonical', label: 'Message angle' },
    { key: 'visual_style_canonical', label: 'Visual style' },
  ];

  /* The exact honesty caveat, rendered verbatim off the mart's label = 'descriptive'.
   * These are descriptive associations with performance, not proof of causation. */
  var DESCRIPTIVE_CAVEAT = 'Descriptive, not causal: each grade shows how a component value is '
    + 'associated with performance against this client\'s own baseline. It is not proof the '
    + 'component caused the result. Read it as evidence to weigh, not a guarantee.';

  var cmpClient = '';       // resolved f10 client slug (set during initComponents)
  var cmpLoaded = false;    // data loaded lazily on first activation
  var cmpNavLink = null;    // the injected nav-link element (bound once)

  /* ---- small local helpers ---- */

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* BQ numbers can arrive as { value: '12.3' }; coerce to a real number or null. */
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'object' && v.value !== undefined) v = v.value;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* BQ BOOL is a real boolean, but tolerate string/number encodings too. The column is
   * nullable and defaults to unchecked until US-005 populates it. */
  function isFlag(v) {
    if (v == null) return false;
    if (typeof v === 'object' && v.value !== undefined) v = v.value;
    return v === true || v === 'true' || v === 1 || v === '1';
  }

  function fmtInt(v) {
    var n = num(v);
    return n == null ? '0' : Math.round(n).toLocaleString();
  }

  /* Signed percentage, e.g. +12.3% / -8.0%. Lift is already direction-normalised in
   * the mart so a POSITIVE value always means "beats this client's baseline". */
  function fmtPct(v) {
    var n = num(v);
    if (n == null) return 'n/a';
    var pct = n * 100;
    return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  }

  /* The graded metric, shown as supporting evidence. roas clients read the roas
   * column; every other (lead-gen) client reads cpa. Never invents a number. */
  function fmtMetric(row) {
    var type = row.metric_type;
    if (type === 'roas') {
      var r = num(row.roas);
      return r == null ? 'n/a' : r.toFixed(2) + 'x ROAS';
    }
    var c = num(row.cpa);
    return c == null ? 'n/a' : '$' + c.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' CPA';
  }

  var INSUFFICIENT = 'insufficient evidence';

  /* Qualitative grade band derived from the spend-weighted lift. Insufficient-evidence
   * values are never given a performance verdict - they render greyed with their count. */
  function gradeBand(row) {
    if (row.confidence_tier === INSUFFICIENT) {
      return { text: 'Insufficient evidence', cls: 'cmp-band-insuff' };
    }
    var lift = num(row.lift);
    if (lift == null) return { text: 'Not enough signal', cls: 'cmp-band-neutral' };
    if (lift >= 0.10) return { text: 'Winning', cls: 'cmp-band-win' };
    if (lift > 0) return { text: 'Above baseline', cls: 'cmp-band-above' };
    if (lift === 0) return { text: 'At baseline', cls: 'cmp-band-neutral' };
    return { text: 'Below baseline', cls: 'cmp-band-below' };
  }

  /* ---- client + table resolution ---- */

  /* Resolve the f10 client slug: an explicit COMPONENTS.CLIENT override wins; otherwise
   * derive it from the DATASET global by stripping a trailing _marts or _clean suffix
   * (mosh_marts -> mosh), mirroring f10-competitors.js. Returns '' when nothing resolves.
   * Sanitised to the slug charset because it is inlined into the whitespace SQL. */
  function clientKey() {
    var raw = CFG.CLIENT
      ? String(CFG.CLIENT)
      : (typeof DATASET !== 'undefined' && DATASET ? String(DATASET).replace(/_(marts|clean)$/, '') : '');
    return raw.replace(/[^a-z0-9_]/gi, '');
  }

  function project() {
    return (typeof PROJECT !== 'undefined' && PROJECT) ? PROJECT : 'mcc-poc-477801';
  }

  /* component_performance lives in the client's marts dataset, which IS the dashboard's
   * DATASET (per the starter config and US-002's {client}_marts publish target). */
  function scaleTableRef() {
    var ds = (typeof DATASET !== 'undefined' && DATASET) ? String(DATASET) : '';
    return '`' + project() + '.' + ds + '.component_performance`';
  }

  function whitespaceTableRef() {
    return '`' + project() + '.all_clients.component_whitespace`';
  }

  /* The literal contract columns the dashboard reads, pinned by
   * assert_component_performance_contract.sqlx in f10-dataform. */
  var SCALE_COLUMNS = [
    'client', 'component', 'component_value', 'asset_count', 'spend', 'conversions',
    'revenue', 'metric_type', 'cpa', 'roas', 'metric', 'baseline_metric', 'lift',
    'metric_ci_low', 'metric_ci_high', 'confidence_tier', 'co_occurrence_flag',
    'label', 'evidence_window_months',
  ];

  /* ---- data access (all via the guardrailed generic runQuery path) ---- */

  /* Cheap EXISTS probe: does this client's component_performance table have any rows?
   * Returns true/false. A missing table makes runQuery reject; initComponents treats
   * that (and any other error) as "no tab" - fail closed. */
  async function probeExists() {
    if (typeof runQuery !== 'function') return false;
    var rows = await runQuery('SELECT EXISTS(SELECT 1 FROM ' + scaleTableRef() + ') AS has_data');
    var r = Array.isArray(rows) ? rows[0] : null;
    return !!(r && (r.has_data === true || r.has_data === 'true' || r.has_data === 1));
  }

  function fetchScale() {
    return runQuery(
      'SELECT ' + SCALE_COLUMNS.join(', ') + ' FROM ' + scaleTableRef()
      + ' ORDER BY component, asset_count DESC, component_value'
    );
  }

  function fetchWhitespace() {
    return runQuery(
      'SELECT component, component_value, source_client_count, local_asset_count, label, '
      + 'evidence_window_months FROM ' + whitespaceTableRef()
      + " WHERE client = '" + cmpClient + "'"
      + ' ORDER BY component, source_client_count DESC, component_value'
    );
  }

  /* ---- rendering ---- */

  function evidenceWindowNote(scaleRows) {
    var m = null;
    for (var i = 0; i < scaleRows.length; i++) {
      var v = num(scaleRows[i].evidence_window_months);
      if (v != null) { m = v; break; }
    }
    return m == null ? '' : ' Grades read the trailing ' + m + ' months of delivery.';
  }

  /* One scale row. Insufficient-evidence values render greyed WITH their asset count
   * (never hidden). A co_occurrence_flag either marks the row (default) or, when
   * COMPONENTS.SUPPRESS_CO_OCCURRENCE is set, suppresses the grade to a caution. */
  function scaleRowHtml(row) {
    var band = gradeBand(row);
    var insuff = row.confidence_tier === INSUFFICIENT;
    var flagged = isFlag(row.co_occurrence_flag);
    var suppress = flagged && CFG.SUPPRESS_CO_OCCURRENCE === true;
    var rowCls = 'cmp-row' + (insuff ? ' cmp-insuff' : '') + (flagged ? ' cmp-flagged' : '');

    var gradeCell;
    if (suppress) {
      gradeCell = '<span class="cmp-band cmp-band-flagged">Held - co-occurrence</span>';
    } else {
      gradeCell = '<span class="cmp-band ' + band.cls + '">' + esc(band.text) + '</span>'
        + (flagged ? ' <span class="cmp-cooc" title="Lift may be driven by a co-present component (US-005 flag)">co-occurrence</span>' : '');
    }

    var liftCell = (insuff || suppress) ? '<span class="cmp-muted">-</span>' : esc(fmtPct(row.lift));
    var metricCell = insuff ? '<span class="cmp-muted">-</span>' : esc(fmtMetric(row));

    return '<tr class="' + rowCls + '">'
      + '<td class="cmp-val">' + esc(row.component_value) + '</td>'
      + '<td>' + gradeCell + '</td>'
      + '<td class="cmp-num">' + liftCell + '</td>'
      + '<td class="cmp-num">' + esc(fmtInt(row.asset_count)) + ' ads</td>'
      + '<td class="cmp-tier">' + esc(row.confidence_tier || '') + '</td>'
      + '<td class="cmp-num">' + metricCell + '</td>'
      + '</tr>';
  }

  function scaleSectionHtml(component, rows) {
    if (!rows.length) return '';
    var body = rows.map(scaleRowHtml).join('');
    return '<div class="cmp-section">'
      + '<h3 class="cmp-heading">' + esc(component.label) + '</h3>'
      + '<div class="cmp-table-wrap"><table class="cmp-table">'
      + '<thead><tr><th>Value</th><th>Grade</th><th class="cmp-num">Lift vs baseline</th>'
      + '<th class="cmp-num">Evidence</th><th>Confidence</th><th class="cmp-num">Metric</th></tr></thead>'
      + '<tbody>' + body + '</tbody></table></div>'
      + '</div>';
  }

  /* Full scale surface: one section per canonical component, in canonical order. Any
   * component with no rows is skipped, but no VALUE is ever dropped inside a section. */
  function scaleHtml(scaleRows) {
    var byComponent = {};
    scaleRows.forEach(function (r) {
      var k = r.component;
      (byComponent[k] || (byComponent[k] = [])).push(r);
    });
    var sections = COMPONENT_ORDER.map(function (c) {
      return scaleSectionHtml(c, byComponent[c.key] || []);
    }).join('');
    if (!sections) {
      return '<div class="no-data">No graded components for this client yet.</div>';
    }
    return '<div class="cmp-caveat">' + esc(DESCRIPTIVE_CAVEAT) + evidenceWindowNote(scaleRows) + '</div>' + sections;
  }

  /* The cross-client whitespace lane, rendered as its own clearly-labelled section.
   * Hypotheses only: no lift, no CPA/ROAS, no client names - counts and the verbatim
   * label only, exactly as the mart guarantees. */
  function whitespaceHtml(wsRows) {
    if (!wsRows || !wsRows.length) {
      return '<div class="cmp-section cmp-whitespace">'
        + '<h3 class="cmp-heading">Whitespace - untested here</h3>'
        + '<div class="no-data">No cross-client whitespace hypotheses for this client.</div>'
        + '</div>';
    }
    var labelMap = {};
    COMPONENT_ORDER.forEach(function (c) { labelMap[c.key] = c.label; });
    var rows = wsRows.map(function (r) {
      var n = num(r.source_client_count);
      var local = num(r.local_asset_count);
      return '<tr class="cmp-row">'
        + '<td>' + esc(labelMap[r.component] || r.component) + '</td>'
        + '<td class="cmp-val">' + esc(r.component_value) + '</td>'
        + '<td class="cmp-num">' + esc(fmtInt(n)) + ' other client' + (n === 1 ? '' : 's') + '</td>'
        + '<td class="cmp-num">' + esc(fmtInt(local)) + ' ads here</td>'
        + '<td class="cmp-label">' + esc(r.label || 'untested here - hypothesis, not a grade') + '</td>'
        + '</tr>';
    }).join('');
    return '<div class="cmp-section cmp-whitespace">'
      + '<h3 class="cmp-heading">Whitespace - untested here</h3>'
      + '<div class="cmp-caveat cmp-hyp">Hypothesis fuel, not a grade: these values win on other F10 '
      + 'clients but are untested for this client. No performance numbers and no client names are shown.</div>'
      + '<div class="cmp-table-wrap"><table class="cmp-table">'
      + '<thead><tr><th>Component</th><th>Value</th><th class="cmp-num">Proven on</th>'
      + '<th class="cmp-num">Your evidence</th><th>Status</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>'
      + '</div>';
  }

  function showEl(id, disp) {
    var el = document.getElementById(id);
    if (el) el.style.display = (disp || 'block');
  }
  function hideEl(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  /* Render both surfaces into the panel. Whitespace is best-effort: a whitespace read
   * failure must not blank the scale, so it is caught and shown as its own note. */
  function render(scaleRows, wsRows) {
    var scale = document.getElementById('cmp-scale');
    var ws = document.getElementById('cmp-whitespace');
    if (scale) scale.innerHTML = scaleHtml(scaleRows || []);
    if (ws) ws.innerHTML = whitespaceHtml(wsRows || []);
    hideEl('cmp-loading');
    hideEl('cmp-error');
    showEl('cmp-body');
  }

  /* A failed component-scale query renders a visible panel error state (temporarily
   * unavailable), never a blank tab or a console-only error. */
  function renderError(err) {
    var msg = (err && err.message) ? err.message : String(err);
    console.error('Component Scale load error:', err);
    hideEl('cmp-loading');
    hideEl('cmp-body');
    var el = document.getElementById('cmp-error');
    if (el) {
      el.innerHTML = '<strong>Component Scale is temporarily unavailable.</strong>'
        + '<div class="cmp-error-detail">' + esc(msg) + '</div>';
      el.style.display = 'block';
    }
  }

  async function loadComponents() {
    showEl('cmp-loading');
    hideEl('cmp-body');
    hideEl('cmp-error');
    try {
      var scaleRows = await fetchScale();
      // Whitespace is a secondary surface; its failure must not take down the scale.
      var wsRows = [];
      try {
        wsRows = await fetchWhitespace();
      } catch (wsErr) {
        console.warn('Component whitespace unavailable, continuing without it:', wsErr && wsErr.message ? wsErr.message : wsErr);
        wsRows = [];
      }
      render(Array.isArray(scaleRows) ? scaleRows : [], Array.isArray(wsRows) ? wsRows : []);
    } catch (err) {
      renderError(err);
    }
  }

  /* ---- tab activation (via the single generic dispatcher) ---- */

  function activateComponents() {
    if (typeof f10ActivateTab === 'function') {
      f10ActivateTab({ panelId: 'panel-components', navLink: cmpNavLink, title: 'Component Scale' });
    } else {
      // Defensive fallback if the layout dispatcher is unavailable: same generic clear.
      var q = document.querySelectorAll ? document.querySelectorAll('#sidebar nav a') : [];
      Array.prototype.forEach.call(q, function (l) { if (l.classList) l.classList.remove('active'); });
      var panels = document.querySelectorAll ? document.querySelectorAll('.tab-panel') : [];
      Array.prototype.forEach.call(panels, function (p) { if (p.classList) p.classList.remove('active'); });
      var panel = document.getElementById('panel-components'); if (panel) panel.classList.add('active');
      if (cmpNavLink && cmpNavLink.classList) cmpNavLink.classList.add('active');
      var t = document.getElementById('page-title'); if (t) t.textContent = 'Component Scale';
    }
    if (window.F10A) F10A.track('tab_viewed', { tab: 'components', tab_label: 'Component Scale' });
    if (!cmpLoaded) { cmpLoaded = true; loadComponents(); }
  }

  /* When any OTHER nav link is clicked, drop this tab's active state so only one
   * section ever shows. Bound generically to every sibling nav anchor - no per-module
   * class list - so a future tab needs no edit here either. */
  function deactivateOnOtherNav() {
    var panels = document.querySelectorAll ? document.querySelectorAll('.components-tab-panel') : [];
    Array.prototype.forEach.call(panels, function (p) { if (p.classList) p.classList.remove('active'); });
    var links = document.querySelectorAll ? document.querySelectorAll('.components-nav-link') : [];
    Array.prototype.forEach.call(links, function (l) { if (l.classList) l.classList.remove('active'); });
  }

  /* ---- panel + nav markup (self-contained; the module injects its own) ---- */

  function navLinkHtml() {
    return '<a href="#" class="components-nav-link" data-components-tab="components">Component Scale</a>';
  }

  function panelMarkup() {
    return '<div class="tab-panel components-tab-panel" id="panel-components">'
      + '<style id="cmp-styles">'
      + '#panel-components .cmp-caveat{background:rgba(0,0,0,0.03);border-left:3px solid var(--brand,#7a1f2b);'
      + 'padding:10px 14px;margin:0 0 18px;font-size:13px;line-height:1.5;border-radius:4px;}'
      + '#panel-components .cmp-hyp{border-left-color:#8a8a8a;}'
      + '#panel-components .cmp-section{margin:0 0 26px;}'
      + '#panel-components .cmp-heading{margin:0 0 10px;font-size:15px;}'
      + '#panel-components .cmp-table{width:100%;border-collapse:collapse;font-size:13px;}'
      + '#panel-components .cmp-table th,#panel-components .cmp-table td{padding:7px 10px;border-bottom:1px solid rgba(0,0,0,0.08);text-align:left;}'
      + '#panel-components .cmp-num{text-align:right;}'
      + '#panel-components .cmp-val{font-weight:600;}'
      + '#panel-components .cmp-tier{text-transform:capitalize;color:#555;}'
      + '#panel-components .cmp-insuff{opacity:0.55;}'
      + '#panel-components .cmp-insuff .cmp-val{font-weight:500;}'
      + '#panel-components .cmp-muted{color:#999;}'
      + '#panel-components .cmp-band{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;}'
      + '#panel-components .cmp-band-win{background:#e3f4e8;color:#1c6b34;}'
      + '#panel-components .cmp-band-above{background:#eef7e6;color:#3f6b1c;}'
      + '#panel-components .cmp-band-neutral{background:#eee;color:#555;}'
      + '#panel-components .cmp-band-below{background:#fbe6ea;color:#a3243c;}'
      + '#panel-components .cmp-band-insuff{background:#f0f0f0;color:#777;}'
      + '#panel-components .cmp-band-flagged{background:#fff3d6;color:#8a5a00;}'
      + '#panel-components .cmp-cooc{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;font-size:11px;'
      + 'background:#fff3d6;color:#8a5a00;font-weight:600;}'
      + '#panel-components .cmp-error{background:#fbe6ea;border:1px solid #e3a9b6;color:#a3243c;padding:14px 16px;border-radius:6px;}'
      + '#panel-components .cmp-error-detail{margin-top:6px;font-size:12px;color:#7a1f2b;opacity:0.8;word-break:break-word;}'
      + '#panel-components .cmp-whitespace{border-top:1px solid rgba(0,0,0,0.1);padding-top:20px;margin-top:6px;}'
      + '#panel-components .cmp-label{color:#777;font-style:italic;}'
      + '</style>'
      + '<div class="insight-box"><strong>Component Scale:</strong> which creative components win for this '
      + 'client, graded against the client\'s own baseline from complete vision coverage. Each value shows its '
      + 'grade, spend-weighted lift, delivered evidence count and confidence tier. Values below the evidence '
      + 'gate are greyed but never hidden; the whitespace lane below lists cross-client hypotheses, not grades.</div>'
      + '<div id="cmp-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>'
      + '<div id="cmp-error" class="cmp-error" style="display:none;"></div>'
      + '<div id="cmp-body" style="display:none;">'
      + '<div id="cmp-scale"></div>'
      + '<div id="cmp-whitespace"></div>'
      + '</div>'
      + '</div>';
  }

  /* Inject the nav section + link and the panel, then wire activation through the
   * generic dispatcher. Idempotent-safe: only ever called once per boot (after a
   * passing probe). */
  function registerTab() {
    var nav = document.querySelector('#sidebar nav');
    var content = document.getElementById('content');
    if (!nav || !content) return;
    nav.insertAdjacentHTML('beforeend', '<div class="nav-section">Creative Components</div>');
    nav.insertAdjacentHTML('beforeend', navLinkHtml());
    content.insertAdjacentHTML('beforeend', panelMarkup());
    cmpNavLink = document.querySelector('.components-nav-link');
    if (cmpNavLink && cmpNavLink.addEventListener) {
      cmpNavLink.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); activateComponents(); });
    }
    // Bind the deactivate handler to every OTHER existing nav anchor - generic, no
    // hard-coded class list, so this never needs editing when tabs are added.
    var others = document.querySelectorAll ? document.querySelectorAll('#sidebar nav a') : [];
    Array.prototype.forEach.call(others, function (a) {
      if (a === cmpNavLink || !a.addEventListener) return;
      a.addEventListener('click', deactivateOnOtherNav);
    });
  }

  /* ---- boot ----
   * Called by the one-line addition to the tail of renderLayout() in f10-layout.js.
   * Resolves the client, runs the cheap EXISTS probe, and registers the tab only when
   * the client has a component_performance mart. Any probe error fails closed (no tab,
   * no DOM trace) - a dashboard without the mart simply has no Component Scale tab. */
  async function initComponents() {
    cmpClient = clientKey();
    if (!cmpClient || typeof BQ_FUNCTION === 'undefined' || !BQ_FUNCTION) return; // no key/endpoint -> silent no-op
    try {
      var exists = await probeExists();
      if (exists === true) registerTab();
    } catch (err) {
      // Fail closed: log once, no tab, no empty state.
      console.warn('Component Scale visibility probe error:', err && err.message ? err.message : err);
    }
  }

  window.initComponents = initComponents;

  /* Test surface (US-004): expose the internals so the acceptance test can exercise
   * registration, probe gating, insufficient-evidence rendering and activation without
   * a full dashboard boot. Production paths do not read these. */
  window.f10Components = {
    initComponents: initComponents,
    registerTab: registerTab,
    activate: activateComponents,
    deactivateOnOtherNav: deactivateOnOtherNav,
    load: loadComponents,
    render: render,
    renderError: renderError,
    probeExists: probeExists,
    scaleHtml: scaleHtml,
    scaleSectionHtml: scaleSectionHtml,
    scaleRowHtml: scaleRowHtml,
    whitespaceHtml: whitespaceHtml,
    panelMarkup: panelMarkup,
    navLinkHtml: navLinkHtml,
    gradeBand: gradeBand,
    clientKey: clientKey,
    setClient: function (c) { cmpClient = c; },
    getClient: function () { return cmpClient; },
    isLoaded: function () { return cmpLoaded; },
    COMPONENT_ORDER: COMPONENT_ORDER,
    DESCRIPTIVE_CAVEAT: DESCRIPTIVE_CAVEAT,
  };
})();
