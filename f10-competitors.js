/**
 * f10-competitors.js — F10 Creative Dashboard Competitor Ad Library (probe-driven, US-003)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@TAG/f10-competitors.js"></script>
 *
 * Must be loaded AFTER f10-utils.js and f10-layout.js, and (for inline media
 * rendering) AFTER f10-preview.js — it reuses that module's f10MediaMarkup()
 * helper to build <img>/<video> markup rather than duplicating it.
 *
 * Visibility is DATA-DRIVEN: on boot, a cheap existence probe (the US-001
 * function's `probe:true` path — a BQ EXISTS on ad_registry, no snapshot-history
 * scan) asks whether this client has any competitor rows in all_clients_adlib.
 * Only when rows exist does the module inject its "Competitors" nav section and
 * panel (via f10-layout.js's competitorPanelMarkup()). No rows / probe error →
 * fail closed: zero trace in the DOM. No per-client config edit is required —
 * adding competitor rows in the warehouse is enough for the tab to appear on
 * next dashboard load.
 *
 * The f10_client key is derived from the page's DATASET global by stripping a
 * trailing `_marts` or `_clean` suffix (e.g. mosh_marts → mosh). COMPETITORS is
 * now an OPTIONAL overrides object only:
 *
 *   const COMPETITORS = {
 *     CLIENT:      'mosh',   // optional override when DATASET doesn't follow the convention
 *     PER_PAGE:    20,       // optional; competitor cards shown per in-page page (default 20)
 *     MAX_PER_PAGE: 0,       // optional hard cap on ads rendered per competitor
 *     EXTRA_TABS:  true,     // optional; preview the gated secondary sub-tabs (off by default until v1.15.1)
 *   };
 *
 * The panel groups every tracked competitor's Meta ads by competitor page_name,
 * in the F10 card layout — a JS port of the static build_competitor_page.py
 * surface. A filter bar above the grid offers three controls: Status (All / Live /
 * Inactive, default Live), Timeframe (30 / 60 / 90 days / All time, default 90
 * days) and Competitor (All + one per competitor in the dataset, default All).
 * Status + Competitor are instant client-side filters; a Timeframe change
 * re-fetches metadata for the new window.
 *
 * DATA SPLIT — metadata + on-demand creatives: the `competitor` action returns
 * ad METADATA only (latest snapshot per ad + still_active, absent-safe age
 * metrics) with NO creatives and NO signing, honouring the Timeframe `days`
 * window (All time is the only unpruned partition scan). Creatives are loaded
 * lazily, one visible page at a time, via the `competitor-creatives` action which
 * mints the short-lived v4 signed URLs for just that page's ads (cached per
 * ad_archive_id so returning to a page never re-fetches).
 *
 * Pagination mirrors the static page: each competitor shows PER_PAGE (default 20)
 * cards at a time with Prev / Next, and ONLY the currently visible page's cards
 * are mounted AND only that page's creatives are ever fetched/signed. The default
 * grid and the search results share this same lazy-per-page render path.
 *
 * Entrypoint — f10-layout.js calls initCompetitors() unconditionally during
 * boot; the probe decides whether the tab exists. The tab loads its data lazily
 * on first activation.
 */
(function () {
  /* COMPETITORS is optional overrides only (CLIENT, PER_PAGE, MAX_PER_PAGE,
   * EXTRA_TABS). */
  const CFG = (typeof COMPETITORS !== 'undefined' && COMPETITORS) ? COMPETITORS : {};

  const COMP_PER_PAGE = Number(CFG.PER_PAGE) > 0 ? Number(CFG.PER_PAGE) : 20;
  const COMP_MAX = Number(CFG.MAX_PER_PAGE) > 0 ? Number(CFG.MAX_PER_PAGE) : 0;

  /* Launch gate for the SECONDARY competitor sub-tabs — Vision & Text (US-009),
   * Ad Age Over Time (US-010) and Meta Maturity Score (US-011). Tab 1 (Competitor
   * Ads) always ships. Held OFF by default in v1.15.0 while their output is being
   * validated; flip COMP_EXTRA_TABS_DEFAULT to true in v1.15.1 to release them to
   * every dashboard. A single dashboard can preview them ahead of that by setting
   * `COMPETITORS = { EXTRA_TABS: true }` (or force-hide with `false`). This gates
   * registration only — it AND-composes with each tab's own data probe, so a
   * client still needs the underlying rows for a tab to appear. */
  const COMP_EXTRA_TABS_DEFAULT = false;
  const COMP_EXTRA_TABS = (CFG.EXTRA_TABS != null) ? (CFG.EXTRA_TABS === true) : COMP_EXTRA_TABS_DEFAULT;
  const COMP_TOKEN_RE = /\{\{[^}]+\}\}/g;

  let compLoaded = false;
  let compClient = ''; // resolved f10_client key (set during initCompetitors)
  let compSections = []; // [{ page_name, ads:[obj], total, live, cur }] — sections hold ad OBJECTS (creatives loaded lazily per visible page)
  let compSearchActive = false; // true while a search view is showing instead of the full grid

  /* Full cached metadata ad list for the CURRENT timeframe + the ageMetrics that
   * came with it. Status + Competitor are client-side filters over compAllAds (no
   * refetch); a Timeframe change refetches this. */
  let compAllAds = [];
  let compAllAge = null;
  /* Per-ad creative cache, keyed by ad_archive_id -> [{media_type, idx, url}].
   * Populated lazily as pages are shown; prevents re-fetching a page you return to. */
  let compCreativeCache = {};
  /* Filter state. status: all|live|inactive (default live); days: 30|60|90|null
   * (null = all time, default 90); competitor: '' = all, else a page_name. */
  const compFilters = { status: 'live', days: 90, competitor: '' };

  /* Resolve the f10_client key: an explicit COMPETITORS.CLIENT override wins;
   * otherwise derive it from the DATASET global by stripping a trailing `_marts`
   * or `_clean` suffix (mosh_marts → mosh). Returns '' when nothing resolves. */
  function compClientKey() {
    if (CFG.CLIENT) return String(CFG.CLIENT);
    if (typeof DATASET !== 'undefined' && DATASET) return String(DATASET).replace(/_(marts|clean)$/, '');
    return '';
  }

  /* ── Small local helpers ── */

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* BQ dates/timestamps serialize as { value: 'YYYY-MM-DD...' }; keep the date part. */
  function compDateStr(v) {
    const s = bqStr(v);
    return s ? s.slice(0, 10) : null;
  }

  /* Parse a YYYY-MM-DD date string to UTC epoch ms; null if unparseable. */
  function compDateToUTC(d) {
    if (!d) return null;
    const [y, mo, da] = d.split('-').map(Number);
    if (!y || !mo || !da) return null;
    return Date.UTC(y, mo - 1, da);
  }

  /* Whole days an ad has run — the winner/longevity signal, mirroring the date
   * line on Meta's ad card, NOT the warehouse observation age. A LIVE ad counts
   * from Meta's stated go-live date to today (still running). A STOPPED ad counts
   * to Meta's stated stop date when we have it, so the badge freezes at the true
   * run length (e.g. "9 Jan – 15 Jan" = 6d) instead of climbing to today forever;
   * if the stop date is missing it falls back to today. */
  function daysActive(ad, live) {
    const startMs = compDateToUTC(compDateStr(ad.ad_delivery_start_time));
    if (startMs == null) return null;
    const stopMs = compDateToUTC(compDateStr(ad.ad_delivery_stop_time));
    const endMs = (!live && stopMs != null) ? stopMs : Date.now();
    const diff = Math.floor((endMs - startMs) / 86400000);
    return diff < 0 ? 0 : diff;
  }

  /* Meta DCO/catalog ads carry template tokens like {{product.brand}} filled per
   * product at delivery. Show a plain note instead of the raw token; keep any
   * real surrounding copy. Returns { text, dyn }. */
  function cleanCopy(text) {
    if (!text) return { text: '', dyn: false };
    const hadToken = /\{\{[^}]+\}\}/.test(text);
    const stripped = String(text).replace(COMP_TOKEN_RE, '').replace(/^[\s\-|,]+|[\s\-|,]+$/g, '').trim();
    if (hadToken && !stripped) return { text: 'Dynamic copy — varies by product', dyn: true };
    return { text: stripped || String(text), dyn: hadToken };
  }

  /* ── Age-metrics formatting + rendering (US-004) ── */

  /* Coerce a BQ numeric to a display string; null when not finite. dp>0 keeps
   * that many decimals (avg age is 1dp), dp=0 rounds to a whole count. */
  function compAgeNum(v, dp) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return dp ? n.toFixed(dp) : String(Math.round(n));
  }

  /* One age-distribution chip strip: <7d / 7-30d / 30-90d / 90d+ with counts.
   * Labels are module-owned markup; only the count values are esc()'d. */
  function compDistHtml(m) {
    const seg = (label, v) =>
      `<span class="comp-dist-seg">${label} <b>${esc(compAgeNum(v, 0) || '0')}</b></span>`;
    return '<div class="comp-dist">'
      + seg('&lt;7d', m.live_lt_7d)
      + seg('7&ndash;30d', m.live_7_30d)
      + seg('30&ndash;90d', m.live_30_90d)
      + seg('90d+', m.live_90d_plus)
      + '</div>';
  }

  /* Client summary strip above the competitor sections. Absent-safe: renders
   * nothing when the client age row is missing/null (no empty strip). */
  function compSummaryHtml(client, competitors) {
    if (!client) return '';
    const metric = (label, val) =>
      `<div class="comp-metric"><span class="comp-metric-label">${label}</span>`
      + `<span class="comp-metric-value">${esc(val)}</span></div>`;
    const live = compAgeNum(client.ads_live, 0);
    const avg = compAgeNum(client.avg_age_live_days, 1);
    return '<div class="comp-summary">'
      + metric('Competitors tracked', String(competitors))
      + metric('Live ads', live != null ? live : '0')
      + metric('Avg live age', (avg != null ? avg : '\u2013') + 'd')
      + compDistHtml(client)
      + '</div>';
  }

  /* Inner HTML for a competitor section's meta line. Base is the existing
   * "{total} ads tracked · {live} live"; when a per-page age row exists it is
   * extended with average live age and the four bucket counts. Absent-safe:
   * no byPage entry → the line is exactly what it is today. */
  function compPageMetaHtml(s, page) {
    let line = `${s.total} ad${s.total === 1 ? '' : 's'} tracked &middot; ${s.live} live`;
    if (page) {
      const avg = compAgeNum(page.avg_age_live_days, 1);
      line += ` &middot; avg live age ${esc((avg != null ? avg : '\u2013'))}d`
        + ` &middot; &lt;7d ${esc(compAgeNum(page.live_lt_7d, 0) || '0')}`
        + ` &middot; 7&ndash;30d ${esc(compAgeNum(page.live_7_30d, 0) || '0')}`
        + ` &middot; 30&ndash;90d ${esc(compAgeNum(page.live_30_90d, 0) || '0')}`
        + ` &middot; 90d+ ${esc(compAgeNum(page.live_90d_plus, 0) || '0')}`;
    }
    return line;
  }

  /* ── Data fetch ── */

  /* Metadata-only fetch for the competitor ads. `days` is the timeframe window: a
   * positive number (30/60/90) prunes the scan; null = all time (omit the field). */
  async function fetchCompetitor(client, days) {
    const payload = { action: 'competitor', client: client };
    if (days != null) payload.days = days;
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  /* On-demand signed creatives for a set of ads (the metadata/lazy split). Called
   * per visible page for only the ad ids not already cached. */
  async function fetchCompetitorCreatives(client, adIds) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'competitor-creatives', client: client, adIds: adIds }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  /* Ensure every ad in `ads` has its creatives loaded and attached. Fetches only
   * the ids not already in compCreativeCache (so returning to a page never
   * re-fetches), caches the result per ad_archive_id (even empty, so a no-creative
   * ad is not re-queried), then attaches `creatives` onto each ad object so
   * compCardHtml can render it. Lets fetch errors bubble so the caller can log +
   * show them (hq-never-swallow-errors). */
  async function compEnsureCreatives(ads) {
    const list = Array.isArray(ads) ? ads : [];
    const need = [];
    const seen = {};
    list.forEach((a) => {
      if (!a || a.ad_archive_id == null) return;
      const id = String(a.ad_archive_id);
      if (!(id in compCreativeCache) && !seen[id]) { seen[id] = true; need.push(id); }
    });
    if (need.length) {
      const res = await fetchCompetitorCreatives(compClient, need);
      const byAd = (res && res.creativesByAd && typeof res.creativesByAd === 'object') ? res.creativesByAd : {};
      need.forEach((id) => { compCreativeCache[id] = Array.isArray(byAd[id]) ? byAd[id] : []; });
    }
    list.forEach((a) => {
      if (!a || a.ad_archive_id == null) return;
      a.creatives = compCreativeCache[String(a.ad_archive_id)] || [];
    });
  }

  /* ── Card + media rendering (ports build_competitor_page.py card_html/media_html) ── */

  /* Inline media: reuses f10-preview.js's f10MediaMarkup() so the <img>/<video>
   * construction lives in exactly one place. Video ads get inline controls,
   * multi-asset ads (carousels) become a horizontally scrollable strip. */
  function compMediaHtml(creatives) {
    const mk = window.f10MediaMarkup;
    const list = Array.isArray(creatives) ? creatives : [];
    const items = [];
    if (typeof mk === 'function') {
      list.forEach((cr) => {
        if (!cr || !cr.url) return; // signing failed / no asset → skip this frame
        const isVideo = cr.media_type === 'video';
        const media = { type: isVideo ? 'video' : 'image', url: cr.url };
        items.push(isVideo
          ? mk(media, { className: 'mitem', controls: true, preload: 'metadata' })
          : mk(media, { className: 'mitem', loading: 'lazy' }));
      });
    }
    if (!items.length) return '<div class="comp-missing">no creative</div>';
    const count = items.length > 1
      ? `<span class="comp-mcount">${items.length} assets &middot; scroll &rarr;</span>` : '';
    return `<div class="comp-media">${items.join('')}${count}</div>`;
  }

  /* ── Search: matched-field indicator + shared grouping (US-008) ── */

  /* Human labels for the search action's matched_fields (US-006). Anything not
   * mapped falls back to the raw field name with underscores spaced out. */
  const COMP_MATCH_LABELS = {
    ad_creative_bodies: 'ad copy',
    ad_creative_link_titles: 'link title',
    page_name: 'page name',
    link_url: 'link URL',
    cta_type: 'CTA',
    on_screen_text: 'on-screen text',
  };

  /* One 'matched: …' line for a search result. Absent-safe: a card with no
   * matched_fields (every default-grid card) renders nothing, so compCardHtml
   * stays a single rendering path for both the full grid and search results. */
  function compMatchedHtml(ad) {
    const fields = Array.isArray(ad && ad.matched_fields) ? ad.matched_fields : [];
    if (!fields.length) return '';
    const labels = fields.map((f) => COMP_MATCH_LABELS[f] || String(f).replace(/_/g, ' '));
    return `<div class="comp-matched">matched: ${esc(labels.join(', '))}</div>`;
  }

  /* Group ads by competitor page_name, preserving the query's ordering. Shared
   * by the default grid (compRender) and the search view (compRenderSearch). */
  function compGroupByPage(ads) {
    const groups = [];
    const idx = {};
    (Array.isArray(ads) ? ads : []).forEach((a) => {
      const key = (a.page_name != null && a.page_name !== '') ? String(a.page_name) : 'Unknown';
      if (idx[key] === undefined) { idx[key] = groups.length; groups.push({ page_name: key, rows: [] }); }
      groups[idx[key]].rows.push(a);
    });
    return groups;
  }

  function compCardHtml(ad) {
    const fmt = esc(ad.display_format || '');
    const ctaRaw = (ad.cta_type || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const cta = esc(ctaRaw);
    const bodies = Array.isArray(ad.ad_creative_bodies) ? ad.ad_creative_bodies : [];
    const cc = cleanCopy(bodies.length ? bodies[0] : '');
    const copy = esc(cc.text);
    const live = (ad.still_active != null) ? ad.still_active : ad.is_active;
    const days = daysActive(ad, live);
    const snap = ad.snapshot_url || ad.link_url || '';
    const since = fmtDate(compDateStr(ad.ad_delivery_start_time));

    const tags = [];
    if (fmt) tags.push(`<span class="comp-tag fmt">${fmt}</span>`);
    if (cc.dyn) tags.push('<span class="comp-tag dyn">dynamic</span>');
    tags.push(`<span class="comp-tag ${live ? 'live' : 'off'}">${live ? 'live' : 'stopped'}</span>`);
    if (days != null) tags.push(`<span class="comp-tag days">${days}d active</span>`);

    const link = snap ? `<a href="${esc(snap)}" target="_blank" rel="noopener">View on Meta &rarr;</a>` : '';

    return `<div class="comp-card">${compMediaHtml(ad.creatives)}<div class="comp-body">`
      + `<div class="comp-tags">${tags.join('')}</div>`
      + compMatchedHtml(ad)
      + (since && since !== '–' ? `<div class="comp-since">Live since ${esc(since)}</div>` : '')
      + `<div class="comp-copy${cc.dyn ? ' dyn' : ''}">${copy}</div>`
      + `<div class="comp-foot"><span class="comp-cta">${cta || '&nbsp;'}</span>${link}</div>`
      + `</div></div>`;
  }

  /* ── Filter bar (Status / Timeframe / Competitor) ── */

  /* Filter bar markup: three <select> controls styled inline with the F10 tokens
   * the search bar uses (var(--paper-dark)/--white/--ink). Status defaults to Live,
   * Timeframe to 90 days; the Competitor options are filled after the data loads. */
  function compFilterBarHtml() {
    const field = (id, label, opts) =>
      '<label style="display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--ink);">'
      + '<span style="color:var(--grey);text-transform:uppercase;letter-spacing:0.06em;font-size:9.5px;font-weight:600;">' + label + '</span>'
      + '<select id="' + id + '" class="comp-filter-select" style="font-family:inherit;font-size:12px;padding:6px 9px;'
      + 'border:1px solid var(--paper-dark);border-radius:4px;background:var(--white);color:var(--ink);">'
      + opts + '</select></label>';
    const statusOpts = '<option value="all">All</option>'
      + '<option value="live" selected>Live</option>'
      + '<option value="inactive">Inactive</option>';
    const timeOpts = '<option value="30">30 days</option>'
      + '<option value="60">60 days</option>'
      + '<option value="90" selected>90 days</option>'
      + '<option value="all">All time</option>';
    const compOpts = '<option value="">All competitors</option>';
    return '<div class="comp-filters" id="comp-filters" role="group" aria-label="Competitor ad filters"'
      + ' style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:16px;padding:12px 14px;'
      + 'background:var(--paper-dark);border-radius:6px;">'
      + field('comp-filter-status', 'Status', statusOpts)
      + field('comp-filter-timeframe', 'Timeframe', timeOpts)
      + field('comp-filter-competitor', 'Competitor', compOpts)
      + '</div>';
  }

  /* Fill the Competitor dropdown with one option per page_name present in the
   * loaded dataset (sorted, deduped), preserving the current selection. */
  function compPopulateCompetitorOptions(ads) {
    const sel = document.getElementById('comp-filter-competitor');
    if (!sel) return;
    const names = {};
    (Array.isArray(ads) ? ads : []).forEach((a) => {
      const pn = (a && a.page_name != null && a.page_name !== '') ? String(a.page_name) : 'Unknown';
      names[pn] = true;
    });
    const cur = compFilters.competitor;
    sel.innerHTML = '<option value="">All competitors</option>'
      + Object.keys(names).sort().map((n) =>
        '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
  }

  /* Status + Competitor are client-side filters over the cached list (no refetch);
   * a Timeframe change refetches with the new window. Each re-applies the client-side
   * filters after it runs. */
  function compOnStatusChange(val) {
    compFilters.status = (val === 'live' || val === 'inactive') ? val : 'all';
    if (window.F10A) F10A.track('competitor.filter', { client: compClient, filter: 'status', value: compFilters.status });
    return compRenderFromFilters();
  }
  function compOnCompetitorChange(val) {
    compFilters.competitor = val ? String(val) : '';
    if (window.F10A) F10A.track('competitor.filter', { client: compClient, filter: 'competitor', value: compFilters.competitor || 'all' });
    return compRenderFromFilters();
  }
  function compOnTimeframeChange(val) {
    compFilters.days = (val === 'all' || val == null) ? null : (Number(val) > 0 ? Number(val) : null);
    if (window.F10A) F10A.track('competitor.filter', { client: compClient, filter: 'timeframe', value: compFilters.days == null ? 'all' : compFilters.days });
    return compLoad(); // Timeframe re-fetches metadata for the new window.
  }

  function compWireFilters() {
    const st = document.getElementById('comp-filter-status');
    const tf = document.getElementById('comp-filter-timeframe');
    const cp = document.getElementById('comp-filter-competitor');
    if (st) st.addEventListener('change', () => compOnStatusChange(st.value));
    if (tf) tf.addEventListener('change', () => compOnTimeframeChange(tf.value));
    if (cp) cp.addEventListener('change', () => compOnCompetitorChange(cp.value));
  }

  /* Inject the filter bar at the top of the competitor panel (above the search bar
   * and grid), then wire its controls. Mirrors compInjectSearchBar. */
  function compInjectFilterBar() {
    const anchor = document.getElementById('comp-loading');
    if (anchor) anchor.insertAdjacentHTML('beforebegin', compFilterBarHtml());
    else {
      const panel = document.getElementById('panel-competitors');
      if (panel) panel.insertAdjacentHTML('beforeend', compFilterBarHtml());
    }
    compWireFilters();
  }

  /* Apply the client-side Status + Competitor filters to a metadata ad list.
   * "Live" = still_active when known, else is_active; "Inactive" is the negation. */
  function compApplyFilters(ads) {
    return (Array.isArray(ads) ? ads : []).filter((a) => {
      if (!a) return false;
      const live = (a.still_active != null) ? a.still_active : a.is_active;
      if (compFilters.status === 'live' && !live) return false;
      if (compFilters.status === 'inactive' && live) return false;
      if (compFilters.competitor) {
        const pn = (a.page_name != null && a.page_name !== '') ? String(a.page_name) : 'Unknown';
        if (pn !== compFilters.competitor) return false;
      }
      return true;
    });
  }

  /* Re-group + re-render the cached full list through the current client-side
   * filters. Used by the Status/Competitor controls and by clearing a search. */
  function compRenderFromFilters() {
    compSearchActive = false;
    return compRender(compApplyFilters(compAllAds), compAllAge);
  }

  /* ── Load + render orchestration ── */

  async function compLoad() {
    showEl('comp-loading'); hideEl('comp-body');
    try {
      const res = await fetchCompetitor(compClient, compFilters.days);
      compAllAds = (res && Array.isArray(res.ads)) ? res.ads : [];
      compAllAge = res && res.ageMetrics;
      compPopulateCompetitorOptions(compAllAds);
      await compRenderFromFilters();
    } catch (err) {
      console.error('Competitor load error:', err);
      const el = document.getElementById('comp-loading');
      if (el) el.innerHTML = 'Error loading data: ' + esc(err && err.message ? err.message : String(err));
    }
  }

  async function compRender(ads, ageMetrics) {
    const age = (ageMetrics && typeof ageMetrics === 'object') ? ageMetrics : {};
    const ageClient = age.client || null;
    const ageByPage = (age.byPage && typeof age.byPage === 'object') ? age.byPage : {};
    // Group by competitor page_name (shared with the search view).
    const groups = compGroupByPage(ads);

    const body = document.getElementById('comp-body');
    const metaLine = document.getElementById('comp-meta');
    const note = document.getElementById('comp-note');

    if (!groups.length) {
      compSections = [];
      if (body) body.innerHTML = '<div class="no-data">No competitor ads match the current filters.</div>';
      if (metaLine) metaLine.textContent = '';
      if (note) note.textContent = '';
      hideEl('comp-loading'); showEl('comp-body');
      return;
    }

    let total = 0;
    // Sections hold the ad OBJECTS for their group (not pre-built card HTML) so a
    // page's creatives can be loaded lazily just before that page is drawn.
    compSections = groups.map((g) => {
      let rows = g.rows;
      if (COMP_MAX && rows.length > COMP_MAX) rows = rows.slice(0, COMP_MAX);
      const live = rows.reduce((n, a) => n + (((a.still_active != null ? a.still_active : a.is_active)) ? 1 : 0), 0);
      total += rows.length;
      return { page_name: g.page_name, ads: rows, total: rows.length, live: live, cur: 0 };
    });

    if (metaLine) {
      metaLine.textContent = `${groups.length} competitor${groups.length === 1 ? '' : 's'} · `
        + `${total} ad${total === 1 ? '' : 's'} · source: Meta Ad Library (AU)`;
    }
    if (note) {
      note.textContent = `Each competitor shows ${COMP_PER_PAGE} ads at a time — use Prev / Next to page through the rest.`;
    }

    body.innerHTML = compSummaryHtml(ageClient, groups.length)
      + compSections.map((s, i) =>
      `<section class="comp-section" id="comp-sec-${i}">`
        + `<h2 class="comp-head">${esc(s.page_name)}</h2>`
        + `<p class="comp-pgmeta">${compPageMetaHtml(s, ageByPage[s.page_name])}</p>`
        + `<div class="comp-grid" id="comp-grid-${i}"></div>`
        + `<div class="comp-pager" id="comp-pager-${i}"></div>`
      + `</section>`
    ).join('');

    hideEl('comp-loading'); showEl('comp-body');
    // Draw each section's first (visible) page — this is what lazily fetches only
    // that page's creatives. Non-visible pages are untouched until paged to.
    await Promise.all(compSections.map((s, i) => compRenderSection(i)));

    const lu = document.getElementById('last-updated');
    if (lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
  }

  /* Draw one competitor section's current page. Only the visible page's ads are
   * turned into cards, and only their creatives are fetched (lazily, cached), so
   * only that page's media is ever in the DOM and only its assets are ever signed
   * and downloaded. Shows a loading state while the page's creatives are fetched
   * and surfaces fetch errors loudly (hq-never-swallow-errors). */
  async function compRenderSection(i) {
    const s = compSections[i];
    const grid = document.getElementById('comp-grid-' + i);
    const pager = document.getElementById('comp-pager-' + i);
    if (!grid || !s) return;
    const pages = Math.max(1, Math.ceil(s.ads.length / COMP_PER_PAGE));
    if (s.cur >= pages) s.cur = pages - 1;
    if (s.cur < 0) s.cur = 0;
    const start = s.cur * COMP_PER_PAGE;
    const end = Math.min(start + COMP_PER_PAGE, s.ads.length);
    const visible = s.ads.slice(start, end);

    // Lightweight loading state while this page's creatives are fetched.
    grid.innerHTML = '<div class="comp-loading-page loading" style="grid-column:1/-1;">'
      + '<div class="spinner"></div>Loading creatives&hellip;</div>';
    try {
      await compEnsureCreatives(visible);
      grid.innerHTML = visible.map(compCardHtml).join('');
    } catch (err) {
      console.error('Competitor creatives load error:', err);
      grid.innerHTML = '<div class="comp-missing" style="grid-column:1/-1;">Error loading creatives: '
        + esc(err && err.message ? err.message : String(err)) + '</div>';
    }

    if (!pager) return;
    if (pages <= 1) { pager.style.display = 'none'; pager.innerHTML = ''; return; }
    pager.style.display = 'flex';
    pager.innerHTML =
      `<button class="pg-btn" data-comp-prev${s.cur === 0 ? ' disabled' : ''}>&#8592; Prev</button>`
      + `<span class="pg-info">Showing ${start + 1}&ndash;${end} of ${s.ads.length} &middot; page ${s.cur + 1} of ${pages}</span>`
      + `<button class="pg-btn" data-comp-next${s.cur >= pages - 1 ? ' disabled' : ''}>Next &#8594;</button>`;
    const prev = pager.querySelector('[data-comp-prev]');
    const next = pager.querySelector('[data-comp-next]');
    const go = (delta) => {
      s.cur += delta;
      // Fetch the new page's creatives on demand; cache prevents re-fetching a page
      // you return to. Scroll back to the section top once the page is drawn.
      compRenderSection(i).then(() => {
        const sec = document.getElementById('comp-sec-' + i);
        if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    };
    if (prev) prev.addEventListener('click', () => { if (s.cur > 0) go(-1); });
    if (next) next.addEventListener('click', () => { if (s.cur < pages - 1) go(1); });
  }

  /* ── Search over the competitor grid (US-008) ──
   * A term search box above the existing card grid. Submitting calls the US-006
   * `competitor-search` action (term search across this client's competitor ad
   * text / link titles / page name / CTA / vision on-screen text) and re-renders
   * the SAME grouped card grid — reusing compCardHtml / compMediaHtml /
   * compRenderSection so media stays lazy, signed, and paginated exactly as the
   * default view. Clearing restores the cached full grid. The shared controls bar
   * stays suppressed as today: this search box lives inside the competitor panel,
   * it is not the global #controls-bar. */

  async function fetchCompetitorSearch(client, term) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'competitor-search', client: client, term: term }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  /* Search bar markup. Uses the F10 form-control tokens inline (the shared
   * controls-bar CSS is scoped to #controls-bar, which stays hidden on this tab)
   * and the existing .pg-btn button style so it reads as native F10. */
  function compSearchBarHtml() {
    return '<form class="comp-search" id="comp-search" role="search"'
      + ' style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:20px;">'
      + '<input type="search" class="ctrl-search comp-search-input" id="comp-search-input"'
      + ' placeholder="Search competitor ads by any text…" aria-label="Search competitor ads"'
      + ' style="font-family:inherit;font-size:12px;padding:7px 10px;border:1px solid var(--paper-dark);'
      + 'border-radius:4px;background:var(--white);color:var(--ink);flex:1;min-width:220px;max-width:380px;">'
      + '<button type="submit" class="pg-btn comp-search-go">Search</button>'
      + '<button type="button" class="pg-btn comp-search-clear" id="comp-search-clear" hidden>Clear</button>'
      + '</form>';
  }

  /* Inject the search bar into the competitor panel, above the loading/body. */
  function compInjectSearchBar() {
    const anchor = document.getElementById('comp-loading');
    if (anchor) anchor.insertAdjacentHTML('beforebegin', compSearchBarHtml());
    else {
      const panel = document.getElementById('panel-competitors');
      if (panel) panel.insertAdjacentHTML('beforeend', compSearchBarHtml());
    }
    compWireSearch();
  }

  function compWireSearch() {
    const form = document.getElementById('comp-search');
    const input = document.getElementById('comp-search-input');
    const clear = document.getElementById('comp-search-clear');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const term = input ? String(input.value || '').trim() : '';
      if (!term) { compClearSearch(); return; }
      compRunSearch(term);
    });
    if (clear) clear.addEventListener('click', (e) => {
      e.preventDefault();
      if (input) input.value = '';
      compClearSearch();
    });
  }

  async function compRunSearch(term) {
    compSearchActive = true;
    const clear = document.getElementById('comp-search-clear');
    if (clear) clear.hidden = false;
    if (window.F10A) F10A.track('competitor.search', { term: term, client: compClient });
    showEl('comp-loading'); hideEl('comp-body');
    const loadingEl = document.getElementById('comp-loading');
    if (loadingEl) loadingEl.innerHTML = '<div class="spinner"></div>Searching…';
    try {
      const res = await fetchCompetitorSearch(compClient, term);
      await compRenderSearch((res && Array.isArray(res.ads)) ? res.ads : [], term);
    } catch (err) {
      // Surface the failure loudly (hq-never-swallow-errors): log it and show it
      // in the tab, exactly like the default-grid load path does.
      console.error('Competitor search error:', err);
      const el = document.getElementById('comp-loading');
      if (el) el.innerHTML = 'Error running search: ' + esc(err && err.message ? err.message : String(err));
    }
  }

  /* Render matched ads into the SAME grouped-section grid the default view uses
   * (the shared lazy-per-page path): sections hold ad objects and each visible
   * page's creatives are fetched on demand exactly as the default grid does. */
  async function compRenderSearch(ads, term) {
    const groups = compGroupByPage(ads);
    const body = document.getElementById('comp-body');
    const metaLine = document.getElementById('comp-meta');
    const note = document.getElementById('comp-note');

    if (!groups.length) {
      compSections = [];
      if (body) body.innerHTML = '<div class="no-data">No competitor ads match “' + esc(term) + '”.</div>';
      if (metaLine) metaLine.textContent = 'Search “' + term + '” · 0 ads';
      if (note) note.textContent = '';
      hideEl('comp-loading'); showEl('comp-body');
      return;
    }

    let total = 0;
    compSections = groups.map((g) => {
      let rows = g.rows;
      if (COMP_MAX && rows.length > COMP_MAX) rows = rows.slice(0, COMP_MAX);
      const live = rows.reduce((n, a) => n + (((a.still_active != null ? a.still_active : a.is_active)) ? 1 : 0), 0);
      total += rows.length;
      return { page_name: g.page_name, ads: rows, total: rows.length, live: live, cur: 0 };
    });

    if (metaLine) {
      metaLine.textContent = 'Search “' + term + '” · '
        + groups.length + ' competitor' + (groups.length === 1 ? '' : 's') + ' · '
        + total + ' ad' + (total === 1 ? '' : 's');
    }
    if (note) {
      note.textContent = 'Showing ads whose text matches “' + term + '” — clear the search to return to the full library.';
    }

    body.innerHTML = compSections.map((s, i) =>
      `<section class="comp-section" id="comp-sec-${i}">`
        + `<h2 class="comp-head">${esc(s.page_name)}</h2>`
        + `<p class="comp-pgmeta">${s.total} ad${s.total === 1 ? '' : 's'} matched &middot; ${s.live} live</p>`
        + `<div class="comp-grid" id="comp-grid-${i}"></div>`
        + `<div class="comp-pager" id="comp-pager-${i}"></div>`
      + `</section>`
    ).join('');

    hideEl('comp-loading'); showEl('comp-body');
    await Promise.all(compSections.map((s, i) => compRenderSection(i)));
  }

  /* Restore the cached full grid through the current client-side filters. If the
   * grid was never loaded (search ran first), fall back to a fresh load. */
  function compClearSearch() {
    compSearchActive = false;
    const clear = document.getElementById('comp-search-clear');
    if (clear) clear.hidden = true;
    const input = document.getElementById('comp-search-input');
    if (input) input.value = '';
    if (compAllAds && compAllAds.length) {
      compRenderFromFilters();
    } else {
      compLoaded = true;
      compLoad();
    }
  }

  /* ── Tab system (coordinates with the Meta engine + TikTok section) ── */

  function compSelectTab() {
    // Deactivate Meta + TikTok: hide their panels, nav highlights, control bars.
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.tt-nav-link').forEach((l) => l.classList.remove('active'));
    const mc = document.getElementById('controls-bar'); if (mc) mc.style.display = 'none';
    const tc = document.getElementById('tt-controls-bar'); if (tc) tc.style.display = 'none';
    // Activate Competitors.
    document.querySelectorAll('.comp-themes-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-age-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-maturity-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-nav-link').forEach((l) => l.classList.add('active'));
    const panel = document.getElementById('panel-competitors'); if (panel) panel.classList.add('active');
    const title = document.getElementById('page-title'); if (title) title.textContent = 'Competitor Ad Library';
    if (window.F10A) F10A.track('tab_viewed', { tab: 'competitors', tab_label: 'Competitor Ad Library' });
    if (!compLoaded) { compLoaded = true; compLoad(); }
  }

  /* When any Meta or TikTok nav link is clicked, drop the Competitors active
   * state so only one section shows at a time. */
  function compDeactivateOnOtherNav() {
    document.querySelectorAll('.comp-tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.comp-nav-link, .comp-themes-nav-link, .comp-age-nav-link, .comp-maturity-nav-link').forEach((l) => l.classList.remove('active'));
  }

  function compWireControls() {
    document.querySelectorAll('.comp-nav-link').forEach((link) =>
      link.addEventListener('click', (e) => { e.preventDefault(); compSelectTab(); })
    );
    document.querySelectorAll('.nav-link, .tt-nav-link').forEach((link) =>
      link.addEventListener('click', compDeactivateOnOtherNav)
    );
  }

  /* ── Tab 2: Vision & Text Analysis (per-competitor themes, US-009) ──
   * Reads the US-007 `themes` action (competitor_theme_summary rollup) and
   * renders, per competitor, the DECISION surface: the dominant angle/message
   * narrative + analysis confidence FIRST (insight-ladder-l4-l5-gate — the "so
   * what", not a bare tag list), then the named vision themes and the text/OCR
   * phrases visually distinguished but shown together, the format mix, and the
   * run_date freshness. Uses the F10 design tokens inline (matching the ads tab)
   * so no shared-CSS edit is needed. */

  let compThemesLoaded = false;
  let compThemes = null; // cached competitors array from the themes action

  async function fetchThemes(client) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'themes', client: client }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  /* Confidence badge — maps analysis_confidence to an F10 accent so the "how sure
   * are we" read sits right next to the competitor name. */
  function compThemesConfHtml(conf) {
    const c = String(conf || '').toLowerCase();
    const label = c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Unrated';
    let bg = 'var(--grey)', fg = 'var(--white)';
    if (c === 'high') { bg = 'var(--good)'; fg = 'var(--white)'; }
    else if (c === 'medium') { bg = 'var(--stabilo)'; fg = 'var(--ink)'; }
    else if (c === 'low') { bg = 'var(--stabilo-red)'; fg = 'var(--white)'; }
    return '<span class="compx-conf" style="font-size:9.5px;font-weight:600;text-transform:uppercase;'
      + 'letter-spacing:0.06em;padding:2px 9px;border-radius:100px;background:' + bg + ';color:' + fg + ';">'
      + esc(label) + ' confidence</span>';
  }

  /* Freshness chip — run_date of the summary. Absent-safe (no chip when missing). */
  function compThemesFreshHtml(runDate) {
    const d = fmtDate(compDateStr(runDate));
    if (!d || d === '–') return '';
    return '<span class="compx-fresh" style="font-size:10px;color:var(--grey);letter-spacing:0.04em;">as of '
      + esc(d) + '</span>';
  }

  /* One named-theme card. A theme may carry an optional modality (vision|text) —
   * when present it is badged and colour-distinguished (vision = solid
   * young-blood, text = outlined) so vision themes and text themes stay visually
   * distinct while sitting together in the same competitor section. */
  function compThemeCardHtml(t) {
    if (!t) return '';
    const name = esc(t.name || t.theme || 'Theme');
    const desc = esc(t.description || t.summary || '');
    const modality = String(t.type || t.modality || t.source || '').toLowerCase();
    const isText = /text|ocr|copy|phrase/.test(modality);
    const isVision = /vision|visual|image/.test(modality);
    let badge = '';
    if (isVision) badge = '<span style="font-size:8.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;'
      + 'padding:1px 7px;border-radius:100px;background:var(--young-blood);color:var(--white);margin-left:8px;">vision</span>';
    else if (isText) badge = '<span style="font-size:8.5px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;'
      + 'padding:1px 7px;border-radius:100px;background:transparent;color:var(--ink);border:1px solid var(--paper-dark);margin-left:8px;">text</span>';
    const phrases = Array.isArray(t.example_phrases) ? t.example_phrases
      : (Array.isArray(t.examples) ? t.examples : []);
    const ex = phrases.length
      ? '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">'
        + phrases.map((ph) => '<span style="font-size:10px;color:var(--grey);background:var(--paper);border-radius:4px;'
          + 'padding:2px 8px;">&ldquo;' + esc(ph) + '&rdquo;</span>').join('')
        + '</div>'
      : '';
    return '<div class="compx-theme" style="background:var(--white);border:1px solid var(--paper-dark);'
      + 'border-radius:6px;padding:11px 13px;">'
      + '<div style="font-size:12.5px;font-weight:600;color:var(--young-blood);letter-spacing:0.02em;">' + name + badge + '</div>'
      + (desc ? '<div style="font-size:11.5px;color:var(--ink);line-height:1.5;margin-top:3px;">' + desc + '</div>' : '')
      + ex
      + '</div>';
  }

  /* Format-mix strip — {video:8, image:3} rendered as the same pill chips the ads
   * tab uses for its age distribution (.comp-dist-seg). */
  function compFormatMixHtml(mix) {
    const m = (mix && typeof mix === 'object' && !Array.isArray(mix)) ? mix : {};
    const keys = Object.keys(m);
    if (!keys.length) return '';
    const chips = keys.map((k) =>
      '<span class="comp-dist-seg">' + esc(String(k)) + ' <b>' + esc(String(m[k])) + '</b></span>').join('');
    return '<div style="margin-top:12px;"><div style="font-size:9px;font-weight:600;letter-spacing:0.1em;'
      + 'text-transform:uppercase;color:var(--grey);margin-bottom:6px;">Format mix</div>'
      + '<div class="comp-dist" style="margin-left:0;">' + chips + '</div></div>';
  }

  /* Text/OCR phrases block — the text side of the analysis, visually distinct from
   * the vision-theme cards above (outlined young-blood chips vs solid cards). */
  function compPhrasesHtml(phrases) {
    const list = Array.isArray(phrases) ? phrases.filter((ph) => ph != null && ph !== '') : [];
    if (!list.length) return '';
    const chips = list.map((ph) =>
      '<span style="font-size:11px;color:var(--ink);background:transparent;border:1px solid var(--young-blood);'
      + 'border-radius:100px;padding:3px 11px;">&ldquo;' + esc(String(ph)) + '&rdquo;</span>').join('');
    return '<div style="margin-top:14px;"><div style="font-size:9px;font-weight:600;letter-spacing:0.1em;'
      + 'text-transform:uppercase;color:var(--grey);margin-bottom:6px;">On-screen &amp; copy phrases (text / OCR)</div>'
      + '<div style="display:flex;gap:7px;flex-wrap:wrap;">' + chips + '</div></div>';
  }

  /* One competitor's full theme section. Insight-ladder order: name + confidence +
   * freshness, THEN the dominant narrative (the "so what"), THEN the structured
   * vision themes and text phrases beneath it. */
  function compThemesSectionHtml(c) {
    const name = esc(c.page_name || c.page_id || 'Unknown competitor');
    const themes = Array.isArray(c.themes) ? c.themes : [];
    const narrative = esc(c.dominant_narrative || '');
    const themeCards = themes.length
      ? '<div class="compx-themes" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));'
        + 'gap:12px;margin-top:12px;">' + themes.map(compThemeCardHtml).join('') + '</div>'
      : '';
    const rows = c.vision_rows_summarised;
    const rowsNote = (rows != null || c.summary_model)
      ? '<div style="font-size:10px;color:var(--grey);margin-top:14px;letter-spacing:0.03em;">'
        + (rows != null ? 'Rolled up from ' + esc(String(rows)) + ' analysed ad' + (Number(rows) === 1 ? '' : 's') : '')
        + (c.summary_model ? ((rows != null ? ' &middot; ' : '') + esc(String(c.summary_model))) : '')
        + '</div>'
      : '';
    return '<section class="comp-section compx-section" style="background:var(--white);'
      + 'border:2px solid var(--paper-dark);border-radius:8px;padding:18px 20px;">'
      + '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;">'
      + '<h2 class="comp-head" style="margin-bottom:0;">' + name + '</h2>'
      + compThemesConfHtml(c.analysis_confidence)
      + compThemesFreshHtml(c.run_date)
      + '</div>'
      + (narrative
        ? '<p class="compx-narrative" style="font-size:13px;line-height:1.6;color:var(--ink);'
          + 'border-left:3px solid var(--young-blood);padding-left:12px;margin:0 0 4px;">' + narrative + '</p>'
        : '<p class="no-data" style="text-align:left;padding:0;">No dominant narrative captured for this competitor yet.</p>')
      + themeCards
      + compFormatMixHtml(c.format_mix)
      + compPhrasesHtml(c.common_phrases)
      + rowsNote
      + '</section>';
  }

  function compThemesRender(competitors) {
    const list = Array.isArray(competitors) ? competitors : [];
    const body = document.getElementById('compx-body');
    const metaLine = document.getElementById('compx-meta');
    const note = document.getElementById('compx-note');

    if (!list.length) {
      if (body) body.innerHTML = '<div class="no-data">No vision &amp; text theme summaries are available for this client yet.</div>';
      if (metaLine) metaLine.textContent = '';
      if (note) note.textContent = '';
      hideEl('compx-loading'); showEl('compx-body');
      return;
    }

    if (metaLine) {
      metaLine.textContent = list.length + ' competitor' + (list.length === 1 ? '' : 's')
        + ' summarised · source: Gemini vision + text rollup (Meta Ad Library AU)';
    }
    if (note) {
      note.textContent = 'Each competitor is summarised from its analysed ads — the dominant angle is the headline read; '
        + 'the themes and phrases below show how they express it.';
    }

    body.innerHTML = '<div class="compx-list" style="display:flex;flex-direction:column;gap:20px;">'
      + list.map(compThemesSectionHtml).join('') + '</div>';

    const lu = document.getElementById('last-updated');
    if (lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
    hideEl('compx-loading'); showEl('compx-body');
  }

  async function compThemesLoad() {
    showEl('compx-loading'); hideEl('compx-body');
    try {
      const res = await fetchThemes(compClient);
      compThemes = (res && Array.isArray(res.competitors)) ? res.competitors : [];
      compThemesRender(compThemes);
    } catch (err) {
      // Surface loudly (hq-never-swallow-errors): log + show in the tab, like the ads load path.
      console.error('Competitor themes load error:', err);
      const el = document.getElementById('compx-loading');
      if (el) el.innerHTML = 'Error loading themes: ' + esc(err && err.message ? err.message : String(err));
    }
  }

  /* Activate the Vision & Text sub-tab: deactivate Meta, TikTok, and the
   * Competitor Ads sub-tab, then show this panel. Emits competitor.tab.themes on
   * activation and loads the data lazily the first time. */
  function compThemesSelectTab() {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.tt-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-age-nav-link').forEach((l) => l.classList.remove('active'));
    const mc = document.getElementById('controls-bar'); if (mc) mc.style.display = 'none';
    const tc = document.getElementById('tt-controls-bar'); if (tc) tc.style.display = 'none';
    document.querySelectorAll('.comp-maturity-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-themes-nav-link').forEach((l) => l.classList.add('active'));
    const panel = document.getElementById('panel-competitor-themes'); if (panel) panel.classList.add('active');
    const title = document.getElementById('page-title'); if (title) title.textContent = 'Competitor Vision & Text Analysis';
    if (window.F10A) F10A.track('competitor.tab.themes', { client: compClient });
    if (!compThemesLoaded) { compThemesLoaded = true; compThemesLoad(); }
  }

  function compWireThemesControls() {
    document.querySelectorAll('.comp-themes-nav-link').forEach((link) =>
      link.addEventListener('click', (e) => { e.preventDefault(); compThemesSelectTab(); })
    );
    // Clicking the Vision & Text tab must also drop the Meta/TikTok active state,
    // handled inside compThemesSelectTab; other-nav clicks drop this tab via the
    // ads tab's compDeactivateOnOtherNav (which now also clears .comp-themes-nav-link).
  }

  /* ── Tab 3: Ad Age Over Time (competitor vs client, US-010) ──
   * A time-series chart of the AVERAGE and MEDIAN live ad age, per month, for
   * every tracked competitor PLUS the client's own line, from the US-007
   * `age-timeseries` action (US-003 over-time mart: one shared monthly axis and
   * one age definition for every series). The chart is drawn client-side as an
   * inline SVG multi-line chart — matching the framework's library-free SVG
   * charting approach (f10-utils.js retentionSparkline) rather than introducing a
   * new chart library. Avg vs median is a toggle (both always available + clearly
   * labelled); the client line is the thick young-blood brand line so it reads as
   * distinct; the legend lets you focus a single competitor vs the client. Uses
   * the F10 design tokens inline (matching the ads + themes tabs) so no shared-CSS
   * edit is needed. Absent-safe: no drawable series → a clean empty state. */

  let compaLoaded = false;
  let compaData = null;      // cached { client:[...], competitors:[...] } from the age action
  let compaMetric = 'avg';   // 'avg' | 'median' — which line the chart currently draws
  let compaFocus = null;     // legend focus: a series id, or null for "show all"

  const COMPA_METRIC_FIELD = { avg: 'avg_age_live_days', median: 'median_age_live_days' };
  /* Competitor line palette. The client owns the young-blood brand line; competitors
   * cycle this set (chosen to stay distinct from the maroon client line). */
  const COMPA_COLORS = ['#4a90e2', '#f5a623', '#7ed321', '#9b59b6', '#1abc9c', '#e67e22', '#2ecc71', '#3498db', '#c8ff00', '#fa023c'];
  const COMPA_CLIENT_COLOR = 'var(--young-blood)';

  async function fetchAge(client) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'age-timeseries', client: client }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  /* BQ period_month → 'YYYY-MM' axis key ({value:'2026-07-01'} or a raw string). */
  function compaMonthKey(v) {
    const s = compDateStr(v); // reuse the ads-tab date coercion (→ YYYY-MM-DD)
    return s ? s.slice(0, 7) : null;
  }

  /* 'YYYY-MM' → short axis label, e.g. 'Jul 26'. */
  function compaMonthLabel(key) {
    if (!key) return '';
    const [y, mo] = String(key).split('-').map(Number);
    if (!y || !mo) return String(key);
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return MON[mo - 1] + ' ' + String(y).slice(2);
  }

  /* Coerce one series' points to {key, value} for the chosen metric. Points with no
   * finite value are kept as {value:null} so a gap breaks the line rather than
   * drawing a false straight segment; points with no month key are dropped. */
  function compaSeriesPoints(series, metric) {
    const field = COMPA_METRIC_FIELD[metric] || COMPA_METRIC_FIELD.avg;
    return (Array.isArray(series) ? series : []).map((p) => {
      const n = Number(p && p[field]);
      return { key: compaMonthKey(p && p.period_month), value: Number.isFinite(n) ? n : null };
    }).filter((p) => p.key);
  }

  /* Unified, sorted month axis across the client line and every competitor series,
   * so all lines share ONE time axis (acceptance criterion). Metric-agnostic — the
   * axis is the set of months present, independent of avg vs median. */
  function compaBuildAxis(client, competitors) {
    const keys = {};
    const add = (series) => compaSeriesPoints(series, 'avg').forEach((p) => { keys[p.key] = true; });
    add(client);
    (Array.isArray(competitors) ? competitors : []).forEach((c) => add(c && c.series));
    return Object.keys(keys).sort();
  }

  /* Inline SVG multi-line chart of live ad age over time. One <path> per series on a
   * single x (month) axis + y (age, days) scale; the client line is the thick
   * young-blood brand line, competitors are thinner palette lines. Each path AND
   * legend chip carries data-series so the legend can focus one line. Absent-safe:
   * returns '' when there is nothing to plot. */
  function compaChartHtml(client, competitors, metric) {
    metric = COMPA_METRIC_FIELD[metric] ? metric : compaMetric;
    const axis = compaBuildAxis(client, competitors);
    const comps = Array.isArray(competitors) ? competitors : [];
    const clientPts = compaSeriesPoints(client, metric);
    const series = [];
    if (clientPts.length) {
      series.push({ id: 'client', label: (compClient || 'Client') + ' (you)', color: COMPA_CLIENT_COLOR, isClient: true, points: clientPts });
    }
    comps.forEach((c, i) => {
      const pts = compaSeriesPoints(c && c.series, metric);
      if (!pts.length) return;
      series.push({
        id: 'page-' + String(c && c.page_id != null ? c.page_id : i).replace(/[^A-Za-z0-9_-]/g, ''),
        label: String((c && (c.page_name || c.page_id)) || ('Competitor ' + (i + 1))),
        color: COMPA_COLORS[i % COMPA_COLORS.length], isClient: false, points: pts,
      });
    });
    if (!axis.length || !series.length) return '';

    const W = 760, H = 300, padL = 46, padR = 16, padT = 14, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xi = {}; axis.forEach((k, i) => { xi[k] = i; });
    const xFor = (k) => padL + (axis.length === 1 ? plotW / 2 : (xi[k] / (axis.length - 1)) * plotW);
    let maxV = 0;
    series.forEach((s) => s.points.forEach((p) => { if (p.value != null && p.value > maxV) maxV = p.value; }));
    const yMax = maxV > 0 ? maxV * 1.08 : 1;
    const yFor = (v) => padT + plotH - (v / yMax) * plotH;

    const yTicks = [0, yMax / 2, yMax];
    const grid = yTicks.map((v) =>
      `<line x1="${padL}" y1="${yFor(v).toFixed(1)}" x2="${W - padR}" y2="${yFor(v).toFixed(1)}" stroke="var(--paper-dark)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(yFor(v) + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="var(--grey)">${Math.round(v)}</text>`
    ).join('');
    const everyX = Math.max(1, Math.ceil(axis.length / 8));
    const xlabels = axis.map((k, i) => (i % everyX === 0 || i === axis.length - 1)
      ? `<text x="${xFor(k).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="8.5" fill="var(--grey)">${esc(compaMonthLabel(k))}</text>` : '').join('');

    const paths = series.map((s) => {
      let d = '', started = false;
      s.points.forEach((p) => {
        if (p.value == null) { started = false; return; }
        d += (started ? 'L' : 'M') + xFor(p.key).toFixed(1) + ' ' + yFor(p.value).toFixed(1) + ' ';
        started = true;
      });
      // Dots carry the data a tooltip needs (label + age + month) AND an SVG <title>
      // as the accessible, zero-JS floor: hovering shows series.label, the age in days,
      // and the month even if the enhanced HTML tooltip never wires up.
      const dots = s.points.filter((p) => p.value != null)
        .map((p) => {
          const ml = compaMonthLabel(p.key);
          const vr = Math.round(p.value);
          const titleText = esc(s.label + ' · ' + vr + 'd live age' + (ml ? ' · ' + ml : ''));
          return `<circle class="compa-dot" cx="${xFor(p.key).toFixed(1)}" cy="${yFor(p.value).toFixed(1)}" `
            + `r="${s.isClient ? 2.4 : 1.6}" fill="${s.color}" `
            + `data-label="${esc(s.label)}" data-value="${vr}" data-month="${esc(ml)}">`
            + `<title>${titleText}</title></circle>`;
        }).join('');
      return `<path class="compa-line" data-series="${s.id}" d="${d.trim()}" fill="none" stroke="${s.color}" `
        + `stroke-width="${s.isClient ? 2.2 : 1.2}" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    }).join('');

    const svg = `<svg class="compa-chart" width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Live ad age over time by competitor and client">`
      + grid + paths + xlabels + '</svg>';

    const legend = '<div class="compa-legend" style="display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;">'
      + series.map((s) =>
        `<button type="button" class="compa-legend-item" data-series="${s.id}"`
        + ' style="display:inline-flex;align-items:center;gap:7px;background:transparent;border:none;cursor:pointer;font-family:inherit;font-size:11px;color:var(--ink);padding:0;">'
        + `<span style="width:${s.isClient ? 16 : 12}px;height:${s.isClient ? 4 : 3}px;border-radius:2px;background:${s.color};display:inline-block;"></span>`
        + `<span${s.isClient ? ' style="font-weight:600;"' : ''}>${esc(s.label)}</span></button>`).join('')
      + '</div>';

    // Cap the rendered size so the SVG never upscales past its native viewBox. An
    // uncapped width:100% blew the stroke-widths, dots and axis labels up well past
    // sibling-chart scale. position:relative anchors the hover tooltip.
    return '<div class="compa-chart-wrap" style="position:relative;max-width:760px;background:var(--white);'
      + 'border:2px solid var(--paper-dark);border-radius:8px;padding:16px 18px;">'
      + svg + legend + '</div>';
  }

  /* Enhance every rendered age chart with a styled, pointer-following hover tooltip
   * (series label + age in days + month). The SVG <title> on each dot is the
   * accessible, zero-JS floor; this adds a dashboard-styled tooltip on top. Absent-safe
   * and idempotent: no-ops where the DOM/createElement is missing (e.g. the test realm)
   * and skips wraps already wired. Works for every series, the client line included. */
  function compaWireTooltips() {
    if (typeof document === 'undefined' || !document.querySelectorAll || !document.createElement) return;
    const wraps = document.querySelectorAll('.compa-chart-wrap');
    Array.prototype.forEach.call(wraps, (wrap) => {
      if (!wrap || (wrap.getAttribute && wrap.getAttribute('data-tips') === '1')) return;
      if (wrap.setAttribute) wrap.setAttribute('data-tips', '1');
      let tip = wrap.querySelector ? wrap.querySelector('.compa-tooltip') : null;
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'compa-tooltip';
        tip.setAttribute('role', 'status');
        tip.style.cssText = 'position:absolute;z-index:30;pointer-events:none;opacity:0;transition:opacity .08s ease;'
          + 'background:var(--ink);color:var(--white);font-family:inherit;font-size:11px;line-height:1.35;'
          + 'padding:6px 9px;border-radius:6px;box-shadow:0 3px 12px rgba(0,0,0,0.22);white-space:nowrap;'
          + 'transform:translate(-50%,-118%);';
        if (wrap.appendChild) wrap.appendChild(tip);
      }
      const dots = wrap.querySelectorAll ? wrap.querySelectorAll('.compa-dot') : [];
      Array.prototype.forEach.call(dots, (dot) => {
        const label = dot.getAttribute('data-label') || '';
        const value = dot.getAttribute('data-value') || '';
        const month = dot.getAttribute('data-month') || '';
        const place = (e) => {
          const rect = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
          if (rect && e && e.clientX != null) {
            tip.style.left = (e.clientX - rect.left) + 'px';
            tip.style.top = (e.clientY - rect.top) + 'px';
          }
        };
        const show = (e) => {
          tip.innerHTML = '<div style="font-weight:700;">' + esc(label) + '</div>'
            + '<div style="opacity:0.82;font-weight:500;">' + esc(String(value)) + 'd live age'
            + (month ? ' · ' + esc(month) : '') + '</div>';
          place(e);
          tip.style.opacity = '1';
        };
        const hide = () => { tip.style.opacity = '0'; };
        if (dot.addEventListener) {
          dot.addEventListener('mouseenter', show);
          dot.addEventListener('mousemove', place);
          dot.addEventListener('mouseleave', hide);
          // Keyboard/AT parity where dots are focusable.
          dot.addEventListener('focus', show);
          dot.addEventListener('blur', hide);
        }
      });
    });
  }

  /* Avg / Median toggle — the F10 segmented control (.seg). Both metrics are ALWAYS
   * present and clearly labelled; switching redraws the chart from cached data. */
  function compaToggleHtml(metric) {
    const seg = (key, label) =>
      `<button type="button" class="compa-metric-btn${metric === key ? ' active' : ''}" data-metric="${key}">${label}</button>`;
    return '<div class="compa-controls" style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">'
      + '<span style="font-size:9px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--grey);">Age metric</span>'
      + '<div class="seg">' + seg('avg', 'Average') + seg('median', 'Median') + '</div></div>';
  }

  function compaRender(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const client = Array.isArray(d.client) ? d.client : [];
    const competitors = Array.isArray(d.competitors) ? d.competitors : [];

    const body = document.getElementById('compa-body');
    const metaLine = document.getElementById('compa-meta');
    const note = document.getElementById('compa-note');

    const hasClient = compaSeriesPoints(client, 'avg').length > 0 || compaSeriesPoints(client, 'median').length > 0;
    const chart = compaChartHtml(client, competitors, compaMetric);

    if (!chart) {
      if (body) body.innerHTML = '<div class="no-data">No ad-age-over-time data is available for this client yet.</div>';
      if (metaLine) metaLine.textContent = '';
      if (note) note.textContent = '';
      hideEl('compa-loading'); showEl('compa-body');
      return;
    }

    if (metaLine) {
      metaLine.textContent = competitors.length + ' competitor' + (competitors.length === 1 ? '' : 's')
        + (hasClient ? ' + your line' : '') + ' · avg & median live ad age by month · source: Meta Ad Library (AU)';
    }
    if (note) {
      note.textContent = hasClient
        ? 'Your line is the thick maroon line — compare its trend against the competitor set. Toggle avg / median, and use the legend to focus one line.'
        : 'No client age line is available yet, so only the competitor set is shown. Toggle avg / median, and use the legend to focus one line.';
    }

    if (body) body.innerHTML = compaToggleHtml(compaMetric) + chart;
    compaWireChartControls();

    const lu = document.getElementById('last-updated');
    if (lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
    hideEl('compa-loading'); showEl('compa-body');
  }

  async function compaLoad() {
    showEl('compa-loading'); hideEl('compa-body');
    try {
      const res = await fetchAge(compClient);
      compaData = {
        client: (res && Array.isArray(res.client)) ? res.client : [],
        competitors: (res && Array.isArray(res.competitors)) ? res.competitors : [],
      };
      compaRender(compaData);
    } catch (err) {
      // Surface loudly (hq-never-swallow-errors): log + show in the tab, like the ads/themes load paths.
      console.error('Competitor age-over-time load error:', err);
      const el = document.getElementById('compa-loading');
      if (el) el.innerHTML = 'Error loading ad-age data: ' + esc(err && err.message ? err.message : String(err));
    }
  }

  /* Wire the avg/median toggle and the focus-a-line legend. Re-entrant: called after
   * every (re)render. Legend focus dims the other lines; clicking a focused line
   * again clears the focus. */
  function compaWireChartControls() {
    document.querySelectorAll('.compa-metric-btn').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const m = btn.getAttribute && btn.getAttribute('data-metric');
        if (m && m !== compaMetric && COMPA_METRIC_FIELD[m]) { compaMetric = m; compaFocus = null; compaRender(compaData); }
      })
    );
    document.querySelectorAll('.compa-legend-item').forEach((item) =>
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const id = item.getAttribute && item.getAttribute('data-series');
        compaFocus = (compaFocus === id) ? null : id;
        compaApplyFocus();
      })
    );
    compaApplyFocus();
    compaWireTooltips();
  }

  /* Apply the current legend focus: when a series is focused, fade every other line
   * + legend chip; when none is focused, show all at full strength. */
  function compaApplyFocus() {
    const dim = (el, on) => { if (el && el.style) el.style.opacity = on ? '0.15' : '1'; };
    document.querySelectorAll('.compa-line').forEach((ln) =>
      dim(ln, compaFocus && (ln.getAttribute && ln.getAttribute('data-series')) !== compaFocus));
    document.querySelectorAll('.compa-legend-item').forEach((it) =>
      dim(it, compaFocus && (it.getAttribute && it.getAttribute('data-series')) !== compaFocus));
  }

  /* Activate the Ad Age Over Time sub-tab: deactivate Meta, TikTok, and the other
   * two competitor sub-tabs, then show this panel. Emits competitor.tab.age on
   * activation and loads the data lazily the first time. */
  function compaSelectTab() {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.tt-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-themes-nav-link').forEach((l) => l.classList.remove('active'));
    const mc = document.getElementById('controls-bar'); if (mc) mc.style.display = 'none';
    const tc = document.getElementById('tt-controls-bar'); if (tc) tc.style.display = 'none';
    document.querySelectorAll('.comp-maturity-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-age-nav-link').forEach((l) => l.classList.add('active'));
    const panel = document.getElementById('panel-competitor-age'); if (panel) panel.classList.add('active');
    const title = document.getElementById('page-title'); if (title) title.textContent = 'Competitor Ad Age Over Time';
    if (window.F10A) F10A.track('competitor.tab.age', { client: compClient });
    if (!compaLoaded) { compaLoaded = true; compaLoad(); }
  }

  function compaWireControls() {
    document.querySelectorAll('.comp-age-nav-link').forEach((link) =>
      link.addEventListener('click', (e) => { e.preventDefault(); compaSelectTab(); })
    );
  }

  /* Register Tab 3 — Ad Age Over Time (US-010). Same runtime nav+panel injection
   * pattern as the ads and themes tabs; fired only when the age probe passes so a
   * client with no age-over-time mart leaves zero DOM trace. */
  function compaRegisterTab() {
    const nav = compEnsureNavSection();
    const content = document.getElementById('content');
    if (!nav || !content || typeof competitorAgePanelMarkup !== 'function') return;
    nav.insertAdjacentHTML('beforeend',
      '<a href="#" class="comp-age-nav-link" data-comp-tab="comp-age">Ad Age Over Time</a>');
    content.insertAdjacentHTML('beforeend', competitorAgePanelMarkup());
    compaWireControls();
  }


  /* ── Tab 4: Meta Maturity Score (+ leaderboard, cadence, net-new, US-011) ──
   * The roll-up sub-tab. Ranks every tracked competitor AND the client by an
   * explainable 0-100 Meta maturity score from the US-007 `maturity` action
   * (competitor_meta_maturity mart): the composite is shown TOGETHER WITH the six
   * component sub-scores + the client's rank + the data-layer-owned maturity_tier so
   * the decision surface explains WHY, not a bare number (insight-ladder-l4-l5-gate).
   * The same panel surfaces the longevity leaderboard (`leaderboard` action) and the
   * refresh cadence + net-new-ad alerts (`net-new` action). All three loads are
   * lazy + absent-safe; the maturity load is the primary (probe-gated) surface, the
   * leaderboard + net-new are secondary and degrade to empty on their own failure
   * (logged, never hidden — hq-never-swallow-errors). Uses F10 design tokens inline,
   * matching the ads/themes/age tabs, so no shared-CSS edit is needed. */

  let compmLoaded = false;
  let compmData = null; // cached { maturity, leaderboard, netnew }

  /* Fixed component order + human labels so a user can read what drives the score.
   * Keys mirror the `maturity` action's sub_scores object exactly. */
  const COMPM_COMPONENTS = [
    ['longevity', 'Longevity'],
    ['cadence', 'Cadence'],
    ['volume', 'Volume'],
    ['active_ratio', 'Active ratio'],
    ['format_diversity', 'Format diversity'],
    ['platform_spread', 'Platform spread'],
  ];
  /* Display-only colour per tier, keyed off the DATA-OWNED maturity_tier label. The
   * tier band is NEVER recomputed in the frontend (hq-classifier-own-labels-single-
   * source): the data layer owns the label; this map only styles the label it hands us. */
  const COMPM_TIER_COLORS = {
    Leading: 'var(--young-blood)', Established: '#4a90e2', Developing: '#f5a623',
    Emerging: '#9b59b6', Nascent: '#7f8c8d', Dormant: 'var(--grey)',
  };

  async function fetchMaturity(client) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'maturity', client: client }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function fetchLeaderboard(client) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'leaderboard', client: client }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  async function fetchNetNew(client) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'net-new', client: client }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function compmNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  /* Composite to one decimal for the headline number; null when not finite. */
  function compmComposite(v) { const n = compmNum(v); return n == null ? null : Math.round(n * 10) / 10; }

  /* Merge the client row (if present) with the competitor rows and sort high-to-low
   * by score. maturity_rank is the data-owned ordering (1 = most mature within the
   * set, which already includes the client); fall back to composite desc. */
  function compmRankedRows(client, competitors) {
    const rows = [];
    if (client && typeof client === 'object') rows.push(Object.assign({}, client, { __isClient: true }));
    (Array.isArray(competitors) ? competitors : []).forEach((c) => rows.push(Object.assign({}, c, { __isClient: false })));
    rows.sort((a, b) => {
      const ra = Number(a.maturity_rank), rb = Number(b.maturity_rank);
      if (Number.isFinite(ra) && Number.isFinite(rb) && ra !== rb) return ra - rb;
      return (Number(b.composite_score) || 0) - (Number(a.composite_score) || 0);
    });
    return rows;
  }

  /* Tier badge — renders the data-owned maturity_tier text verbatim (never re-banded);
   * only the chip colour is a local display choice keyed off that same label. */
  function compmTierBadge(tier) {
    const label = tier == null ? '' : String(tier);
    if (!label) return '';
    const bg = COMPM_TIER_COLORS[label] || 'var(--paper-dark)';
    return `<span class="compm-tier" data-tier="${esc(label)}" style="display:inline-block;padding:2px 9px;`
      + `border-radius:999px;font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;`
      + `background:${bg};color:var(--white);">${esc(label)}</span>`;
  }

  /* One competitor/client row: rank + name + tier + composite, then the six labelled
   * component bars (the explainable breakdown). The client row is highlighted and
   * marked "(you)". */
  function compmScoreRowHtml(entity) {
    const e = entity && typeof entity === 'object' ? entity : {};
    const isClient = !!e.__isClient;
    const name = esc(String(e.page_name || e.entity_id || 'Competitor'));
    const rank = compmNum(e.maturity_rank);
    const composite = compmComposite(e.composite_score);
    const subs = e.sub_scores && typeof e.sub_scores === 'object' ? e.sub_scores : {};
    const bars = COMPM_COMPONENTS.map(([key, label]) => {
      const v = compmNum(subs[key]);
      const pct = v == null ? 0 : Math.max(0, Math.min(100, v));
      return '<div class="compm-comp" style="flex:1 1 0;min-width:82px;">'
        + `<div class="compm-comp-label" style="font-size:9px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--grey);margin-bottom:3px;">${esc(label)}</div>`
        + '<div class="compm-comp-track" style="height:7px;border-radius:4px;background:var(--paper-dark);overflow:hidden;">'
        + `<span class="compm-comp-fill" data-comp="${esc(key)}" style="display:block;height:100%;width:${pct}%;background:${isClient ? 'var(--young-blood)' : '#4a90e2'};border-radius:4px;"></span></div>`
        + `<div class="compm-comp-val" style="font-size:11px;font-weight:700;color:var(--ink);margin-top:2px;">${v == null ? '&mdash;' : Math.round(v)}</div>`
        + '</div>';
    }).join('');
    const entId = isClient ? 'client' : ('page-' + String(e.page_id != null ? e.page_id : name).replace(/[^A-Za-z0-9_-]/g, ''));
    return `<div class="compm-row" data-entity="${entId}" style="background:var(--white);border:2px solid ${isClient ? 'var(--young-blood)' : 'var(--paper-dark)'};`
      + `border-radius:8px;padding:14px 16px;margin-bottom:12px;${isClient ? 'box-shadow:0 0 0 1px var(--young-blood) inset;' : ''}">`
      + '<div class="compm-row-head" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">'
      + `<span class="compm-rank" style="font-size:13px;font-weight:800;color:var(--grey);min-width:30px;">#${rank == null ? '&mdash;' : rank}</span>`
      + `<span class="compm-name" style="font-size:15px;font-weight:700;color:var(--ink);">${name}`
      + `${isClient ? ' <span class="compm-you" style="color:var(--young-blood);font-weight:800;">(you)</span>' : ''}</span>`
      + compmTierBadge(e.maturity_tier)
      + `<span class="compm-score" title="Composite Meta maturity score (0-100)" style="margin-left:auto;font-size:22px;font-weight:800;color:${isClient ? 'var(--young-blood)' : 'var(--ink)'};">${composite == null ? '&mdash;' : composite}</span>`
      + '</div>'
      + `<div class="compm-comps" style="display:flex;gap:10px;flex-wrap:wrap;">${bars}</div>`
      + '</div>';
  }

  /* The client's rank + tier headline — the "so what": where you sit in the set and
   * what tier you are, before the per-row breakdown of "why". */
  function compmRankHeadlineHtml(client, setSize) {
    if (!client || typeof client !== 'object') return '';
    const rank = compmNum(client.maturity_rank);
    const size = compmNum(setSize) != null ? compmNum(setSize) : compmNum(client.set_size);
    const tier = client.maturity_tier;
    const rankTxt = rank == null ? '&mdash;' : rank;
    const ofTxt = size == null ? '' : ' of ' + size;
    const tierTxt = tier ? ` &mdash; tier: <strong>${esc(String(tier))}</strong>` : '';
    return '<div class="compm-headline" style="background:var(--paper);border-left:4px solid var(--young-blood);'
      + 'border-radius:6px;padding:14px 18px;margin-bottom:18px;font-size:14px;color:var(--ink);">'
      + `You rank <strong style="color:var(--young-blood);font-size:18px;">#${rankTxt}</strong>${ofTxt} on Meta maturity${tierTxt}. `
      + 'Read across the component bars below to see exactly where you lead the set and where to close the gap.'
      + '</div>';
  }

  /* Longevity leaderboard — top live competitor ads by age, from the `leaderboard`
   * action. Only the public Ad Library snapshot_url is rendered (http(s) only — no
   * gs:// URI can leak). Absent-safe: a clean empty state when there is nothing live. */
  function compmLeaderboardHtml(ads) {
    const list = Array.isArray(ads) ? ads : [];
    if (!list.length) return '<div class="no-data">No live competitor ads to rank by longevity yet.</div>';
    const rows = list.map((a) => {
      const url = String((a && a.snapshot_url) || '');
      const safe = /^https?:\/\//.test(url) ? url : '';
      const age = compmNum(a && a.live_age_days);
      return '<tr>'
        + `<td style="padding:6px 10px;font-weight:700;color:var(--grey);">#${a && a.rank != null ? a.rank : '&mdash;'}</td>`
        + `<td style="padding:6px 10px;font-weight:600;">${esc(String((a && (a.page_name || a.page_id)) || ''))}</td>`
        + `<td style="padding:6px 10px;color:var(--grey);">${esc(String((a && a.display_format) || ''))}</td>`
        + `<td style="padding:6px 10px;font-weight:700;text-align:right;">${age == null ? '&mdash;' : Math.round(age) + 'd'}</td>`
        + `<td style="padding:6px 10px;text-align:right;">${safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener" style="color:var(--young-blood);font-weight:600;">View</a>` : ''}</td>`
        + '</tr>';
    }).join('');
    return '<div class="compm-lb-wrap" style="background:var(--white);border:2px solid var(--paper-dark);border-radius:8px;overflow:hidden;">'
      + '<table class="compm-lb" style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="background:var(--paper);text-align:left;">'
      + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);">#</th>'
      + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);">Competitor</th>'
      + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);">Format</th>'
      + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);text-align:right;">Live age</th>'
      + '<th style="padding:8px 10px;text-align:right;"></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* Refresh cadence + net-new alerts — from the `net-new` action. The per-competitor
   * net_new_count over the window IS the refresh cadence read; the flagged ads are the
   * net-new alerts. Absent-safe: a clean empty state when nothing is new this period. */
  function compmNetNewHtml(netnew) {
    const nn = netnew && typeof netnew === 'object' ? netnew : {};
    const byPage = Array.isArray(nn.byPage) ? nn.byPage : [];
    const ads = Array.isArray(nn.ads) ? nn.ads : [];
    const win = nn.window && typeof nn.window === 'object' ? nn.window : null;
    if (!byPage.length && !ads.length) return '<div class="no-data">No net-new competitor ads detected this period.</div>';
    const totalNew = byPage.length
      ? byPage.reduce((s, p) => s + (Number(p && p.net_new_count) || 0), 0)
      : ads.length;
    const winTxt = win ? `New-ad window: <strong>${esc(compDateStr(win.start) || '')}</strong> &rarr; <strong>${esc(compDateStr(win.end) || '')}</strong>` : '';
    const alert = totalNew > 0
      ? `<div class="compm-alert" style="background:var(--young-blood);color:var(--white);font-weight:700;border-radius:6px;padding:8px 14px;margin-bottom:12px;">`
        + `${totalNew} brand-new competitor ad${totalNew === 1 ? '' : 's'} this period</div>`
      : '<div class="compm-alert" style="background:var(--paper);color:var(--grey);border-radius:6px;padding:8px 14px;margin-bottom:12px;">No brand-new competitor ads this period.</div>';
    const rows = byPage.map((p) => {
      const nc = Number(p && p.net_new_count) || 0;
      const tot = Number(p && p.ads_total) || 0;
      return '<tr>'
        + `<td style="padding:6px 10px;font-weight:600;">${esc(String((p && (p.page_name || p.page_id)) || ''))}</td>`
        + `<td style="padding:6px 10px;font-weight:800;text-align:right;color:${nc > 0 ? 'var(--young-blood)' : 'var(--grey)'};">${nc}</td>`
        + `<td style="padding:6px 10px;text-align:right;color:var(--grey);">${tot}</td>`
        + '</tr>';
    }).join('');
    const table = byPage.length
      ? '<div class="compm-nn-wrap" style="background:var(--white);border:2px solid var(--paper-dark);border-radius:8px;overflow:hidden;">'
        + '<table class="compm-nn" style="width:100%;border-collapse:collapse;font-size:12px;">'
        + '<thead><tr style="background:var(--paper);text-align:left;">'
        + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);">Competitor</th>'
        + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);text-align:right;">New this period</th>'
        + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);text-align:right;">Total live</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '';
    return alert + (winTxt ? `<div class="window-note" style="margin-bottom:10px;">${winTxt}</div>` : '') + table;
  }

  function compmRender(data) {
    const d = data && typeof data === 'object' ? data : {};
    const mat = d.maturity && typeof d.maturity === 'object' ? d.maturity : {};
    const lb = d.leaderboard && typeof d.leaderboard === 'object' ? d.leaderboard : {};
    const nn = d.netnew && typeof d.netnew === 'object' ? d.netnew : {};
    const client = mat.client && typeof mat.client === 'object' ? mat.client : null;
    const competitors = Array.isArray(mat.competitors) ? mat.competitors : [];

    const body = document.getElementById('compm-body');
    const metaLine = document.getElementById('compm-meta');
    const note = document.getElementById('compm-note');

    if (!client && !competitors.length) {
      if (body) body.innerHTML = '<div class="no-data">No Meta maturity score is available for this client yet.</div>';
      if (metaLine) metaLine.textContent = '';
      if (note) note.textContent = '';
      hideEl('compm-loading'); showEl('compm-body');
      return;
    }

    if (metaLine) {
      metaLine.textContent = competitors.length + ' competitor' + (competitors.length === 1 ? '' : 's')
        + (client ? ' + you' : '') + ' · explainable Meta maturity score · source: Meta Ad Library (AU)';
    }
    if (note) {
      note.textContent = client
        ? 'Your rank and tier are the headline read; the component bars explain what drives the score, so you know exactly where to close the gap.'
        : 'No client maturity row is available yet, so only the competitor set is ranked. The component bars explain what drives each score.';
    }

    const ranked = compmRankedRows(client, competitors);
    if (body) {
      body.innerHTML =
        compmRankHeadlineHtml(client, mat.set_size)
        + '<div class="compm-scores">' + ranked.map(compmScoreRowHtml).join('') + '</div>'
        + '<div class="compm-section" style="margin-top:26px;"><h3 style="font-size:13px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink);margin:0 0 12px;">Longevity leaderboard</h3>'
        + compmLeaderboardHtml(lb.ads) + '</div>'
        + '<div class="compm-section" style="margin-top:26px;"><h3 style="font-size:13px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink);margin:0 0 12px;">Refresh cadence &amp; net-new ads</h3>'
        + compmNetNewHtml(nn) + '</div>';
    }

    const lu = document.getElementById('last-updated');
    if (lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
    hideEl('compm-loading'); showEl('compm-body');
  }

  async function compmLoad() {
    showEl('compm-loading'); hideEl('compm-body');
    try {
      // Maturity is the primary, probe-gated surface — its failure surfaces loudly.
      // Leaderboard + net-new are secondary: on their own failure we log (never hide)
      // and degrade that section to empty rather than blanking the whole tab.
      const [matRes, lbRes, nnRes] = await Promise.all([
        fetchMaturity(compClient),
        fetchLeaderboard(compClient).catch((e) => { console.error('Competitor leaderboard load error:', e); return { ads: [] }; }),
        fetchNetNew(compClient).catch((e) => { console.error('Competitor net-new load error:', e); return { ads: [], byPage: [] }; }),
      ]);
      compmData = { maturity: matRes || {}, leaderboard: lbRes || {}, netnew: nnRes || {} };
      compmRender(compmData);
    } catch (err) {
      // Surface loudly (hq-never-swallow-errors): log + show in the tab, like the other tabs.
      console.error('Competitor maturity load error:', err);
      const el = document.getElementById('compm-loading');
      if (el) el.innerHTML = 'Error loading maturity score: ' + esc(err && err.message ? err.message : String(err));
    }
  }

  /* Activate the Meta Maturity sub-tab: deactivate Meta, TikTok, and the other three
   * competitor sub-tabs, then show this panel. Emits competitor.tab.maturity on
   * activation and loads the data lazily the first time. */
  function compmSelectTab() {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.tt-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-themes-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-age-nav-link').forEach((l) => l.classList.remove('active'));
    const mc = document.getElementById('controls-bar'); if (mc) mc.style.display = 'none';
    const tc = document.getElementById('tt-controls-bar'); if (tc) tc.style.display = 'none';
    document.querySelectorAll('.comp-maturity-nav-link').forEach((l) => l.classList.add('active'));
    const panel = document.getElementById('panel-competitor-maturity'); if (panel) panel.classList.add('active');
    const title = document.getElementById('page-title'); if (title) title.textContent = 'Competitor Meta Maturity Score';
    if (window.F10A) F10A.track('competitor.tab.maturity', { client: compClient });
    if (!compmLoaded) { compmLoaded = true; compmLoad(); }
  }

  function compmWireControls() {
    document.querySelectorAll('.comp-maturity-nav-link').forEach((link) =>
      link.addEventListener('click', (e) => { e.preventDefault(); compmSelectTab(); })
    );
  }

  /* Register Tab 4 — Meta Maturity Score (US-011). Same runtime nav+panel injection
   * pattern as the ads/themes/age tabs; fired only when the maturity probe passes so a
   * client with no maturity mart leaves zero DOM trace. */
  function compmRegisterTab() {
    const nav = compEnsureNavSection();
    const content = document.getElementById('content');
    if (!nav || !content || typeof competitorMaturityPanelMarkup !== 'function') return;
    nav.insertAdjacentHTML('beforeend',
      '<a href="#" class="comp-maturity-nav-link" data-comp-tab="comp-maturity">Meta Maturity Score</a>');
    content.insertAdjacentHTML('beforeend', competitorMaturityPanelMarkup());
    compmWireControls();
  }


  /* ── Consolidated Competitor Intelligence surface (competitor-intel-rollup US-008) ──
   * The single behaviour-over-time surface that supersedes the old thin four-tab
   * layout. It reads the `competitor-intel` action (the US-005/006/007 behaviour +
   * movement + archetype marts and the precomputed narrative) plus the retained
   * `age-timeseries` action, and renders, per competitor: the narrative (the "so
   * what" / "now what") first, then what they are betting on now (effort allocation),
   * how their behaviour is moving (volume / turnover / diversity movements + a
   * discrete archetype), and which themes emerged / faded / intensified / abandoned.
   * Below the per-competitor cards it shows the go-live staying-power winners and the
   * RETAINED Ad Age Over Time chart (reused verbatim from the age module, not rebuilt).
   * All numbers come from the marts; the model only names and explains. Absent-safe:
   * the US-005/006/007 marts materialize later (US-011), so every section degrades to
   * a clean empty state until then. Uses the F10 design tokens inline, matching the
   * other competitor tabs, so no shared-CSS edit is needed. */

  let compiLoaded = false;
  let compiData = null;       // cached { competitors:[...], winners:[...] }
  let compiAgeData = null;    // cached { client:[...], competitors:[...] } for the retained age chart
  let compiAgeMetric = 'avg'; // 'avg' | 'median' for the embedded age chart

  /* Discrete behaviour archetype → display colour. The label itself is data-owned
   * (competitor_behaviour_archetype.archetype); this map only styles it, never
   * recomputes it (hq-classifier-own-labels-single-source). */
  const COMPI_ARCH_COLORS = {
    'conviction': 'var(--young-blood)',
    'steady / evergreen': '#3a8a2a',
    'diversified testing': '#4a90e2',
    'active mixed': '#9b59b6',
    'still hunting / spray': 'var(--stabilo-red)',
    'building': 'var(--grey)',
  };
  /* Theme-movement label → display colour + glyph. Labels are data-owned
   * (competitor_theme_movement.movement); this only styles them. */
  const COMPI_MOVE_STYLE = {
    emerged:     { color: '#3a8a2a', label: 'Emerged' },
    intensified: { color: 'var(--young-blood)', label: 'Intensified' },
    faded:       { color: '#f5a623', label: 'Faded' },
    abandoned:   { color: 'var(--stabilo-red)', label: 'Abandoned' },
    stable:      { color: 'var(--grey)', label: 'Stable' },
  };
  /* Human labels for the effort-allocation dimensions (the mart stores machine keys). */
  const COMPI_DIM_LABELS = {
    format_canonical: 'Format', hook_type: 'Hook type', awareness_stage: 'Awareness stage',
    emotional_appeal: 'Emotional appeal', cta_type: 'CTA type', platform: 'Platform',
  };
  const COMPI_DIM_ORDER = ['format_canonical', 'awareness_stage', 'emotional_appeal', 'hook_type', 'cta_type', 'platform'];

  async function fetchCompetitorIntel(client) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'competitor-intel', client: client }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function compiNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  /* A fractional share (0..1) → whole-percent string; null-safe. */
  function compiPct(frac) { const n = compiNum(frac); return n == null ? 'n/a' : Math.round(n * 100) + '%'; }
  /* A fractional delta → signed "points" string (e.g. +6 pts); '' when null/zero-ish. */
  function compiSignedPts(frac) {
    const n = compiNum(frac); if (n == null) return '';
    const pts = Math.round(n * 100);
    if (pts === 0) return '';
    return (pts > 0 ? '+' : '') + pts + ' pts';
  }
  /* A raw numeric delta → signed string (e.g. +3, -2); '' when null/zero. */
  function compiSigned(v, dp) {
    const n = compiNum(v); if (n == null) return '';
    const r = dp ? Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp) : Math.round(n);
    if (r === 0) return '';
    return (r > 0 ? '+' : '') + r;
  }

  /* Trend chip: a small direction glyph + optional formatted delta. Neutral colours
   * (a rising turnover is not inherently "good"), so this shows direction, not verdict:
   * up = ink, down = grey, flat = grey, new = a Stabilo "new" pill (first period). */
  function compiTrendChip(trend, deltaText) {
    const t = String(trend || '').toLowerCase();
    if (t === 'new') {
      return '<span style="font-size:8.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;'
        + 'color:var(--ink);background:var(--stabilo);border-radius:100px;padding:1px 7px;">new</span>';
    }
    const GLYPH = { up: '↑', down: '↓', flat: '→' };
    const g = GLYPH[t] || '';
    if (!g) return '';
    const color = t === 'up' ? 'var(--ink)' : 'var(--grey)';
    const dt = deltaText ? ' ' + esc(deltaText) : '';
    return '<span style="font-size:10.5px;font-weight:700;color:' + color + ';white-space:nowrap;">' + g + dt + '</span>';
  }

  /* Behaviour archetype badge: the discrete data-owned label with a defensible
   * rationale tooltip. Never recomputed here. */
  function compiArchetypeBadge(arch) {
    const a = arch && typeof arch === 'object' ? arch : {};
    const label = String(a.archetype || '').trim();
    if (!label) return '';
    const bg = COMPI_ARCH_COLORS[label.toLowerCase()] || 'var(--paper-dark)';
    const rationale = a.archetype_rationale ? ' title="' + esc(String(a.archetype_rationale)) + '"' : '';
    return '<span class="compi-arch"' + rationale + ' style="display:inline-block;padding:3px 11px;border-radius:100px;'
      + 'font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;background:' + bg + ';color:var(--white);">'
      + esc(label) + '</span>';
  }

  /* The precomputed narrative block: dominant bet FIRST (the headline read), then the
   * movements / staying-power / whitespace paragraphs, then the coverage caveat. A
   * competitor that went dark is a first-class state, not an error. Prose that failed
   * the upstream provenance gate is withheld (null), so a missing paragraph is simply
   * not rendered rather than shown as a hollow claim. */
  function compiNarrativeHtml(n) {
    if (!n || typeof n !== 'object') {
      return '<p class="no-data" style="text-align:left;padding:0;">No narrative has been generated for this competitor yet.</p>';
    }
    if (n.went_dark) {
      return '<div class="compi-dark" style="background:var(--paper);border-left:3px solid var(--stabilo-red);'
        + 'padding:12px 14px;border-radius:6px;font-size:13px;color:var(--ink);">This competitor has '
        + '<strong>gone dark</strong>: no live ads this period. '
        + (n.dominant_bet ? esc(String(n.dominant_bet)) : 'Watch for a relaunch.') + '</div>';
    }
    const para = (label, text) => {
      const t = text == null ? '' : String(text).trim();
      if (!t) return '';
      return '<div style="margin-top:12px;"><div style="font-size:9px;font-weight:700;letter-spacing:0.1em;'
        + 'text-transform:uppercase;color:var(--grey);margin-bottom:3px;">' + esc(label) + '</div>'
        + '<div style="font-size:12.5px;line-height:1.6;color:var(--ink);">' + esc(t) + '</div></div>';
    };
    const bet = n.dominant_bet == null ? '' : String(n.dominant_bet).trim();
    const head = bet
      ? '<p class="compi-narrative" style="font-size:13.5px;line-height:1.6;color:var(--ink);'
        + 'border-left:3px solid var(--young-blood);padding-left:12px;margin:0;">' + esc(bet) + '</p>'
      : '<p class="no-data" style="text-align:left;padding:0;">No dominant bet captured for this competitor yet.</p>';
    const caveat = n.coverage_caveat
      ? '<div style="font-size:10px;color:var(--grey);margin-top:12px;letter-spacing:0.02em;">' + esc(String(n.coverage_caveat)) + '</div>'
      : '';
    return head
      + para('What changed', n.notable_movements)
      + para('Staying power', n.staying_power)
      + para('Whitespace vs you', n.whitespace_read)
      + caveat;
  }

  /* Effort allocation: "what they're betting on now". For each dimension present, the
   * top buckets this period as a share bar + movement (share, delta pts, trend). Reads
   * the long-format competitor_effort_allocation rows for the competitor's latest period. */
  function compiEffortHtml(effort) {
    const rows = Array.isArray(effort) ? effort : [];
    if (!rows.length) return '';
    const byDim = {};
    rows.forEach((r) => {
      const d = String(r && r.dimension || '');
      if (!d) return;
      (byDim[d] = byDim[d] || []).push(r);
    });
    const dims = Object.keys(byDim).sort((a, b) => {
      const ia = COMPI_DIM_ORDER.indexOf(a), ib = COMPI_DIM_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const blocks = dims.map((d) => {
      const label = COMPI_DIM_LABELS[d] || d;
      const top = byDim[d].slice().sort((a, b) => (compiNum(b.share) || 0) - (compiNum(a.share) || 0)).slice(0, 3);
      const bars = top.map((r) => {
        const pct = Math.max(0, Math.min(100, Math.round((compiNum(r.share) || 0) * 100)));
        const val = compiPct(r.share);
        const trend = compiTrendChip(r.trend, compiSignedPts(r.delta_share));
        return '<div style="margin-bottom:8px;">'
          + '<div style="display:flex;align-items:baseline;gap:8px;font-size:11.5px;color:var(--ink);margin-bottom:3px;">'
          + '<span style="flex:1 1 auto;">' + esc(String(r.dimension_value)) + '</span>'
          + '<span style="font-weight:700;">' + val + '</span>' + trend + '</div>'
          + '<div style="height:6px;border-radius:4px;background:var(--paper-dark);overflow:hidden;">'
          + '<span style="display:block;height:100%;width:' + pct + '%;background:var(--young-blood);border-radius:4px;"></span></div>'
          + '</div>';
      }).join('');
      return '<div class="compi-dim" style="flex:1 1 200px;min-width:180px;">'
        + '<div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--grey);margin-bottom:8px;">'
        + esc(label) + '</div>' + bars + '</div>';
    }).join('');
    return '<div style="margin-top:18px;">'
      + '<h4 style="font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink);margin:0 0 10px;">What they’re betting on now</h4>'
      + '<div style="display:flex;gap:24px;flex-wrap:wrap;">' + blocks + '</div></div>';
  }

  /* Behaviour movements: the how-are-they-moving stat tiles. Each is a movement:
   * current value + delta vs the prior period + trend. Go-live longevity (avg live age)
   * is included as the staying-power scalar. */
  function compiBehaviourHtml(b) {
    if (!b || typeof b !== 'object') return '';
    const tile = (label, valueHtml, trend, deltaText) =>
      '<div style="flex:1 1 120px;min-width:110px;background:var(--paper);border-radius:6px;padding:10px 12px;">'
      + '<div style="font-size:9px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);margin-bottom:4px;">' + esc(label) + '</div>'
      + '<div style="display:flex;align-items:baseline;gap:7px;">'
      + '<span style="font-size:19px;font-weight:800;color:var(--ink);">' + valueHtml + '</span>'
      + compiTrendChip(trend, deltaText) + '</div></div>';
    const vol = compiNum(b.creative_volume);
    const age = compiNum(b.avg_age_live_days);
    const tiles = [
      tile('Live creative', vol == null ? 'n/a' : String(vol), b.creative_volume_trend, compiSigned(b.creative_volume_delta)),
      tile('New-ad rate', compiPct(b.new_ads_rate), b.new_ads_rate_trend, compiSignedPts(b.new_ads_rate_delta)),
      tile('Turnover', compiPct(b.turnover_rate), b.turnover_rate_trend, compiSignedPts(b.turnover_rate_delta)),
      tile('Format mix', compiNum(b.format_diversity) == null ? 'n/a' : String(compiNum(b.format_diversity)), b.format_diversity_trend, compiSigned(b.format_diversity_delta)),
      tile('Angle mix', compiNum(b.angle_diversity) == null ? 'n/a' : String(compiNum(b.angle_diversity)), b.angle_diversity_trend, compiSigned(b.angle_diversity_delta)),
      tile('Avg live age', age == null ? 'n/a' : Math.round(age) + 'd', b.avg_age_live_days_trend, compiSigned(b.avg_age_live_days_delta)),
    ].join('');
    return '<div style="margin-top:18px;">'
      + '<h4 style="font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink);margin:0 0 10px;">How they’re moving</h4>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;">' + tiles + '</div></div>';
  }

  /* Theme movements: the emerged / faded / intensified / abandoned diff for the
   * competitor's latest run_date, most-notable first, each with its share + go-live
   * longevity evidence. */
  function compiThemeMovesHtml(moves) {
    const list = Array.isArray(moves) ? moves : [];
    if (!list.length) return '';
    const RANK = { intensified: 0, emerged: 1, faded: 2, abandoned: 3, stable: 4 };
    const sorted = list.slice().sort((a, b) => {
      const ra = RANK[String(a.movement).toLowerCase()], rb = RANK[String(b.movement).toLowerCase()];
      return (ra == null ? 9 : ra) - (rb == null ? 9 : rb);
    }).slice(0, 8);
    const chips = sorted.map((m) => {
      const key = String(m.movement || '').toLowerCase();
      const st = COMPI_MOVE_STYLE[key] || { color: 'var(--grey)', label: key || 'theme' };
      const age = compiNum(m.longevity_avg_age_live_days);
      const meta = [compiPct(m.theme_share) !== 'n/a' ? compiPct(m.theme_share) + ' share' : '', age == null ? '' : Math.round(age) + 'd live']
        .filter(Boolean).join(' · ');
      return '<div style="display:flex;align-items:center;gap:9px;background:var(--white);border:1px solid var(--paper-dark);'
        + 'border-radius:6px;padding:8px 11px;">'
        + '<span style="font-size:8.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--white);'
        + 'background:' + st.color + ';border-radius:100px;padding:2px 9px;white-space:nowrap;">' + esc(st.label) + '</span>'
        + '<span style="flex:1 1 auto;font-size:12px;font-weight:600;color:var(--ink);">' + esc(String(m.theme_name || m.theme_key || 'Theme')) + '</span>'
        + (meta ? '<span style="font-size:10px;color:var(--grey);white-space:nowrap;">' + esc(meta) + '</span>' : '')
        + '</div>';
    }).join('');
    return '<div style="margin-top:18px;">'
      + '<h4 style="font-size:11px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink);margin:0 0 10px;">Theme movements</h4>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px;">' + chips + '</div></div>';
  }

  /* A resolved human page_name: not null/empty, and not merely the raw page_id echoed
   * back as a name. The noise cards render a bare numeric page_id precisely because no
   * page_name resolved for them. */
  function compiHasResolvedName(c) {
    const name = c && c.page_name;
    if (name == null) return false;
    const s = String(name).trim();
    if (!s) return false;
    return c.page_id == null || s !== String(c.page_id).trim();
  }
  /* Any live behaviour metric present (a nameless page with real movement is still signal). */
  function compiHasBehaviourSignal(b) {
    if (!b || typeof b !== 'object') return false;
    return ['creative_volume', 'avg_age_live_days', 'turnover_rate', 'new_ads_rate', 'format_diversity', 'angle_diversity']
      .some((k) => compiNum(b[k]) != null);
  }
  /* Any drawable age point (the age-timeseries shape) → the page was active over time. */
  function compiHasSeriesSignal(series) {
    if (!Array.isArray(series)) return false;
    return series.some((p) => p && (Number.isFinite(Number(p.avg_age_live_days)) || Number.isFinite(Number(p.median_age_live_days))));
  }
  /* Narrative signal that is MORE than the generic "gone dark" line. A went-dark
   * narrative on its own is not a reason to surface a nameless page. */
  function compiHasNarrativeSignal(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.went_dark) return false;
    return ['dominant_bet', 'notable_movements', 'staying_power', 'whitespace_read']
      .some((k) => n[k] != null && String(n[k]).trim() !== '');
  }

  /* isPresentableCompetitor: the noise gate for the consolidated surface (both the
   * cards and the age-chart series/legend filter through this ONE tunable predicate).
   *
   * Present a competitor when it has EITHER a resolved human page_name, OR (even
   * nameless) some real signal to show: live-ad behaviour, effort allocation, theme
   * movements, a drawable age series, or a narrative beyond the generic "gone dark".
   *
   * Drop ONLY the pure noise: a page with no resolved name that also went dark / has
   * nothing to say. It renders today as a bare page_id card with only the generic
   * went-dark narrative. A NAMED went-dark competitor is KEPT: a competitor that was
   * active and went dark is a first-class signal (US-007), not noise. Tighten or widen
   * the threshold by editing the signal checks above. */
  function isPresentableCompetitor(c) {
    if (!c || typeof c !== 'object') return false;
    if (compiHasResolvedName(c)) return true;
    return (Array.isArray(c.effort) && c.effort.length > 0)
      || compiHasBehaviourSignal(c.behaviour)
      || (Array.isArray(c.theme_movements) && c.theme_movements.length > 0)
      || compiHasSeriesSignal(c.series)
      || compiHasNarrativeSignal(c.narrative);
  }

  /* One competitor's full consolidated card: header (name + archetype + confidence +
   * freshness), then narrative, effort, behaviour, and theme movements in insight-ladder
   * order (the "so what" leads, the evidence follows). */
  function compiCompetitorCardHtml(c) {
    const cc = c && typeof c === 'object' ? c : {};
    const name = esc(String(cc.page_name || cc.page_id || 'Unknown competitor'));
    const n = cc.narrative;
    const runDate = n && n.run_date;
    return '<section class="comp-section compi-card" style="background:var(--white);border:2px solid var(--paper-dark);'
      + 'border-radius:8px;padding:18px 20px;">'
      + '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">'
      + '<h2 class="comp-head" style="margin-bottom:0;">' + name + '</h2>'
      + compiArchetypeBadge(cc.archetype)
      + (n && n.confidence ? compThemesConfHtml(n.confidence) : '')
      + (runDate ? compThemesFreshHtml(runDate) : '')
      + '</div>'
      + compiNarrativeHtml(n)
      + compiEffortHtml(cc.effort)
      + compiBehaviourHtml(cc.behaviour)
      + compiThemeMovesHtml(cc.theme_movements)
      + '</section>';
  }

  /* Go-live staying-power winners: the longest-running LIVE competitor ads across the
   * set (aged from go-live, never the observation window). The clearest read on what is
   * working for competitors in a market with no public spend data. Only the public Ad
   * Library snapshot_url is linked (http(s) only). Absent-safe. */
  function compiWinnersHtml(winners) {
    const list = Array.isArray(winners) ? winners : [];
    if (!list.length) return '<div class="no-data">No live competitor ads to rank by go-live staying power yet.</div>';
    const rows = list.map((a, i) => {
      const url = String((a && a.snapshot_url) || '');
      const safe = /^https?:\/\//.test(url) ? url : '';
      const age = compiNum(a && a.live_age_days);
      return '<tr>'
        + '<td style="padding:6px 10px;font-weight:700;color:var(--grey);">#' + (i + 1) + '</td>'
        + '<td style="padding:6px 10px;font-weight:600;">' + esc(String((a && (a.page_name || a.page_id)) || '')) + '</td>'
        + '<td style="padding:6px 10px;color:var(--grey);">' + esc(String((a && a.display_format) || '')) + '</td>'
        + '<td style="padding:6px 10px;font-weight:800;text-align:right;color:var(--young-blood);">' + (age == null ? 'n/a' : Math.round(age) + 'd') + '</td>'
        + '<td style="padding:6px 10px;text-align:right;">' + (safe ? '<a href="' + esc(safe) + '" target="_blank" rel="noopener" style="color:var(--young-blood);font-weight:600;">View</a>' : '') + '</td>'
        + '</tr>';
    }).join('');
    return '<div style="background:var(--white);border:2px solid var(--paper-dark);border-radius:8px;overflow:hidden;">'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="background:var(--paper);text-align:left;">'
      + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);">#</th>'
      + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);">Competitor</th>'
      + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);">Format</th>'
      + '<th style="padding:8px 10px;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;color:var(--grey);text-align:right;">Go-live age</th>'
      + '<th style="padding:8px 10px;text-align:right;"></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* Retained Ad Age Over Time section: reuses the age module's pure chart builder
   * (compaChartHtml) verbatim so the working view is preserved, with an intel-scoped
   * avg/median toggle wired only inside this panel (so it never collides with the
   * standalone age tab's global controls). */
  function compiAgeSectionHtml() {
    const d = compiAgeData && typeof compiAgeData === 'object' ? compiAgeData : {};
    // Filter the chart series through the same noise gate as the cards: drop nameless,
    // no-signal (went-dark) pages so they never clutter the lines or the legend.
    const ageComps = (Array.isArray(d.competitors) ? d.competitors : []).filter(isPresentableCompetitor);
    const chart = (typeof compaChartHtml === 'function')
      ? compaChartHtml(d.client || [], ageComps, compiAgeMetric) : '';
    if (!chart) return '';
    const seg = (key, label) =>
      '<button type="button" class="compi-age-metric-btn' + (compiAgeMetric === key ? ' active' : '')
      + '" data-metric="' + key + '">' + label + '</button>';
    const toggle = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">'
      + '<span style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--grey);">Age metric</span>'
      + '<div class="seg">' + seg('avg', 'Average') + seg('median', 'Median') + '</div></div>';
    return '<div class="compi-section" style="margin-top:30px;">'
      + '<h3 style="font-size:13px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink);margin:0 0 4px;">Ad age over time</h3>'
      + '<p class="window-note" style="margin:0 0 12px;">Average and median live ad age by month, your line on the same axis. A line drifting up means a competitor is leaning on older, proven creative; staying low means they refresh often.</p>'
      + toggle + chart + '</div>';
  }

  /* Re-render only the embedded age section (metric toggle / legend focus) without
   * reloading the whole tab. Scoped to #panel-competitor-intel. */
  function compiRenderAgeSection() {
    const host = document.getElementById('compi-age-host');
    if (!host) return;
    host.innerHTML = compiAgeSectionHtml();
    compiWireAgeControls();
  }

  function compiWireAgeControls() {
    const panel = document.getElementById('panel-competitor-intel');
    if (!panel) return;
    panel.querySelectorAll('.compi-age-metric-btn').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const m = btn.getAttribute && btn.getAttribute('data-metric');
        if ((m === 'avg' || m === 'median') && m !== compiAgeMetric) { compiAgeMetric = m; compiRenderAgeSection(); }
      })
    );
    // Legend focus: dim the other lines, scoped to this panel so it never touches the
    // (gated-off) standalone age tab.
    panel.querySelectorAll('.compa-legend-item').forEach((item) =>
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const id = item.getAttribute && item.getAttribute('data-series');
        const focus = item.getAttribute('data-focused') === '1' ? null : id;
        panel.querySelectorAll('.compa-line').forEach((ln) => {
          if (ln.style) ln.style.opacity = (focus && ln.getAttribute('data-series') !== focus) ? '0.15' : '1';
        });
        panel.querySelectorAll('.compa-legend-item').forEach((it) => {
          if (it.style) it.style.opacity = (focus && it.getAttribute('data-series') !== focus) ? '0.35' : '1';
          it.setAttribute('data-focused', (focus && it.getAttribute('data-series') === focus) ? '1' : '0');
        });
      })
    );
    compaWireTooltips();
  }

  function compiRender(data, ageData) {
    const d = data && typeof data === 'object' ? data : {};
    if (ageData && typeof ageData === 'object') compiAgeData = ageData;
    // Drop noise competitors (nameless + went-dark / no signal) before rendering cards,
    // the meta count, and the empty-state check. Named competitors and any nameless page
    // that still carries a signal are kept. See isPresentableCompetitor.
    const competitors = (Array.isArray(d.competitors) ? d.competitors : []).filter(isPresentableCompetitor);
    const winners = Array.isArray(d.winners) ? d.winners : [];

    const body = document.getElementById('compi-body');
    const metaLine = document.getElementById('compi-meta');
    const note = document.getElementById('compi-note');
    const hasAge = !!(compiAgeData && (Array.isArray(compiAgeData.competitors) && compiAgeData.competitors.length
      || Array.isArray(compiAgeData.client) && compiAgeData.client.length));

    if (!competitors.length && !winners.length && !hasAge) {
      if (body) body.innerHTML = '<div class="no-data">No consolidated competitor intelligence is available for this client yet.</div>';
      if (metaLine) metaLine.textContent = '';
      if (note) note.textContent = '';
      hideEl('compi-loading'); showEl('compi-body');
      return;
    }

    if (metaLine) {
      metaLine.textContent = competitors.length + ' competitor' + (competitors.length === 1 ? '' : 's')
        + ' analysed · behaviour over time + narrative · source: Meta Ad Library (AU)';
    }
    if (note) {
      note.textContent = 'Read the narrative first: what each competitor is betting on and what changed. '
        + 'The staying-power winners show what is working; the age chart shows how fresh the set is running.';
    }

    const cards = competitors.length
      ? '<div style="display:flex;flex-direction:column;gap:20px;">' + competitors.map(compiCompetitorCardHtml).join('') + '</div>'
      : '';
    const winnersSection = '<div class="compi-section" style="margin-top:30px;">'
      + '<h3 style="font-size:13px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink);margin:0 0 4px;">Go-live staying-power winners</h3>'
      + '<p class="window-note" style="margin:0 0 12px;">The longest-running live competitor ads, aged from go-live (not our observation window). The clearest signal of what is working for them.</p>'
      + compiWinnersHtml(winners) + '</div>';

    if (body) {
      body.innerHTML = cards + winnersSection + '<div id="compi-age-host"></div>';
      compiRenderAgeSection();
    }

    const lu = document.getElementById('last-updated');
    if (lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
    hideEl('compi-loading'); showEl('compi-body');
  }

  async function compiLoad() {
    showEl('compi-loading'); hideEl('compi-body');
    try {
      // The intel action is the primary surface; the retained age chart is a secondary
      // section that degrades to empty on its own failure (logged, never hidden).
      const [intelRes, ageRes] = await Promise.all([
        fetchCompetitorIntel(compClient),
        (typeof fetchAge === 'function' ? fetchAge(compClient) : Promise.resolve(null))
          .catch((e) => { console.error('Competitor-intel age load error:', e); return null; }),
      ]);
      compiData = {
        competitors: (intelRes && Array.isArray(intelRes.competitors)) ? intelRes.competitors : [],
        winners: (intelRes && Array.isArray(intelRes.winners)) ? intelRes.winners : [],
      };
      compiAgeData = ageRes && typeof ageRes === 'object'
        ? { client: Array.isArray(ageRes.client) ? ageRes.client : [], competitors: Array.isArray(ageRes.competitors) ? ageRes.competitors : [] }
        : null;
      compiRender(compiData, compiAgeData);
    } catch (err) {
      // Surface loudly (hq-never-swallow-errors): log + show in the tab, like the other tabs.
      console.error('Competitor intelligence load error:', err);
      const el = document.getElementById('compi-loading');
      if (el) el.innerHTML = 'Error loading competitor intelligence: ' + esc(err && err.message ? err.message : String(err));
    }
  }

  /* Activate the consolidated Competitor Intelligence tab: deactivate Meta, TikTok, and
   * every competitor sub-tab, then show this panel. Loads data lazily on first open. */
  function compiSelectTab() {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.tt-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-themes-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-age-nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.comp-maturity-nav-link').forEach((l) => l.classList.remove('active'));
    const mc = document.getElementById('controls-bar'); if (mc) mc.style.display = 'none';
    const tc = document.getElementById('tt-controls-bar'); if (tc) tc.style.display = 'none';
    document.querySelectorAll('.comp-intel-nav-link').forEach((l) => l.classList.add('active'));
    const panel = document.getElementById('panel-competitor-intel'); if (panel) panel.classList.add('active');
    const title = document.getElementById('page-title'); if (title) title.textContent = 'Competitor Intelligence';
    if (window.F10A) F10A.track('competitor.tab.intel', { client: compClient });
    if (!compiLoaded) { compiLoaded = true; compiLoad(); }
  }

  function compiWireControls() {
    document.querySelectorAll('.comp-intel-nav-link').forEach((link) =>
      link.addEventListener('click', (e) => { e.preventDefault(); compiSelectTab(); })
    );
    // Drop this tab's active highlight when any other nav link is clicked (its panel is
    // already hidden by the other handlers via .tab-panel / .comp-tab-panel clearing).
    document.querySelectorAll('.nav-link, .tt-nav-link, .comp-nav-link, .comp-themes-nav-link, .comp-age-nav-link, .comp-maturity-nav-link').forEach((link) =>
      link.addEventListener('click', () =>
        document.querySelectorAll('.comp-intel-nav-link').forEach((l) => l.classList.remove('active')))
    );
  }

  /* Register the consolidated Competitor Intelligence tab. Same runtime nav+panel
   * injection pattern as the other competitor tabs; fired only when the competitor-intel
   * probe passes so a client with no consolidated intelligence rows leaves zero DOM
   * trace. The nav link sits directly under Competitor Ads in the Competitors section. */
  function compiRegisterTab() {
    const nav = compEnsureNavSection();
    const content = document.getElementById('content');
    if (!nav || !content || typeof competitorIntelPanelMarkup !== 'function') return;
    nav.insertAdjacentHTML('beforeend',
      '<a href="#" class="comp-intel-nav-link" data-comp-tab="comp-intel">Competitor Intelligence</a>');
    content.insertAdjacentHTML('beforeend', competitorIntelPanelMarkup());
    compiWireControls();
  }


  /* ── Boot ── */

  /* Probe passed → register the tab: append the nav section to the sidebar nav
   * and the panel (f10-layout.js's competitorPanelMarkup()) to #content, then
   * wire the tab controls. Nothing here runs for a no-competitor client. */
  /* The "Competitors" nav-section header is shared by both competitor sub-tabs
   * (Competitor Ads + Vision & Text) and must be written exactly once, even when
   * only one of the two probes passes. */
  let compNavSectionAdded = false;
  function compEnsureNavSection() {
    const nav = document.querySelector('#sidebar nav');
    if (!nav) return null;
    if (!compNavSectionAdded) {
      nav.insertAdjacentHTML('beforeend', '<div class="nav-section">Competitors</div>');
      compNavSectionAdded = true;
    }
    return nav;
  }

  function compRegisterTab() {
    const nav = compEnsureNavSection();
    const content = document.getElementById('content');
    if (!nav || !content || typeof competitorPanelMarkup !== 'function') return;
    nav.insertAdjacentHTML('beforeend',
      '<a href="#" class="comp-nav-link" data-comp-tab="competitors">Competitor Ads</a>');
    content.insertAdjacentHTML('beforeend', competitorPanelMarkup());
    compInjectFilterBar();
    compInjectSearchBar();
    compWireControls();
  }

  /* Register Tab 2 — Vision & Text Analysis (US-009). Same runtime nav+panel
   * injection pattern as the ads tab; fired only when the themes probe passes so
   * a client with no theme summary leaves zero DOM trace. */
  function compRegisterThemesTab() {
    const nav = compEnsureNavSection();
    const content = document.getElementById('content');
    if (!nav || !content || typeof competitorThemesPanelMarkup !== 'function') return;
    nav.insertAdjacentHTML('beforeend',
      '<a href="#" class="comp-themes-nav-link" data-comp-tab="comp-themes">Vision &amp; Text</a>');
    content.insertAdjacentHTML('beforeend', competitorThemesPanelMarkup());
    compWireThemesControls();
  }

  /* Called unconditionally by f10-layout.js during boot. Fires the cheap
   * existence probe (US-001 `probe:true` path — BQ EXISTS on ad_registry, no
   * snapshot-history scan) and registers the tab only when the client has
   * competitor rows. exists:false is silent (the normal case); probe errors
   * warn once and fail closed — no nav entry, no panel, no empty state. */
  async function initCompetitors() {
    compClient = compClientKey();
    if (!compClient || typeof BQ_FUNCTION === 'undefined' || !BQ_FUNCTION) return; // no key or endpoint → silent no-op
    // Two independent, cheap existence probes: the Competitor Ads tab (ad_registry)
    // and the Vision & Text tab (competitor_theme_summary) each appear ONLY when
    // their own data exists, so a client with ads but no theme rollup gets tab 1
    // and not tab 2 — and vice versa. Each fails closed on its own.
    await compProbeAndRegister('competitor', compRegisterTab, 'Competitor visibility probe');
    // The consolidated Competitor Intelligence surface (competitor-intel-rollup US-008):
    // the single behaviour-over-time surface. It appears on its own data probe (the
    // US-005/006/007 marts + narrative), independent of the legacy COMP_EXTRA_TABS gate,
    // and is what supersedes the old thin four-tab layout. Until those marts are
    // materialized (US-011) the probe returns exists:false and the tab stays hidden.
    await compProbeAndRegister('competitor-intel', compiRegisterTab, 'Competitor intelligence visibility probe');
    // Secondary sub-tabs are behind the launch gate (COMP_EXTRA_TABS) as well as
    // their own data probe — held off in v1.15.0, released in v1.15.1.
    if (COMP_EXTRA_TABS) {
      await compProbeAndRegister('themes', compRegisterThemesTab, 'Competitor themes visibility probe');
      await compProbeAndRegister('age-timeseries', compaRegisterTab, 'Competitor age visibility probe');
      await compProbeAndRegister('maturity', compmRegisterTab, 'Competitor maturity visibility probe');
    }
  }

  /* Fire a `probe:true` existence check for `action` and register its tab only on
   * exists:true. exists:false is silent (the normal case); a non-OK response or a
   * network error warns once and fails closed — no nav entry, no panel, no empty
   * state (hq-never-swallow-errors: the failure is logged, never hidden). */
  async function compProbeAndRegister(action, register, label) {
    try {
      const r = await fetch(BQ_FUNCTION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action, client: compClient, probe: true }),
      });
      if (!r.ok) { console.warn(label + ' failed: HTTP ' + r.status); return; }
      const res = await r.json();
      if (res && res.exists === true) register();
    } catch (err) {
      console.warn(label + ' error:', err && err.message ? err.message : err);
    }
  }

  window.initCompetitors = initCompetitors;

  /* Test surface (US-008): expose the search internals so the acceptance test
   * can exercise them without a full DOM/probe boot. Production code paths do
   * not read these; they only add to window. */
  window.f10CompetitorSearch = {
    matchedHtml: compMatchedHtml,
    cardHtml: compCardHtml,
    groupByPage: compGroupByPage,
    searchBarHtml: compSearchBarHtml,
    fetchSearch: fetchCompetitorSearch,
    runSearch: compRunSearch,
    clearSearch: compClearSearch,
    renderSearch: compRenderSearch,
    getSections: function () { return compSections; },
    isSearchActive: function () { return compSearchActive; },
    setClient: function (c) { compClient = c; },
    setDefault: function (ads, age) { compAllAds = ads || []; compAllAge = age; },
    // US-014 filters + lazy creatives test surface.
    PER_PAGE: COMP_PER_PAGE,
    render: compRender,
    renderSection: compRenderSection,
    load: compLoad,
    fetchCompetitor: fetchCompetitor,
    fetchCreatives: fetchCompetitorCreatives,
    loadCreatives: compEnsureCreatives,
    applyFilters: compApplyFilters,
    renderFiltered: compRenderFromFilters,
    filterBarHtml: compFilterBarHtml,
    populateCompetitorOptions: compPopulateCompetitorOptions,
    onStatus: compOnStatusChange,
    onCompetitor: compOnCompetitorChange,
    onTimeframe: compOnTimeframeChange,
    getFilters: function () { return compFilters; },
    setFilters: function (f) { if (f && typeof f === 'object') Object.assign(compFilters, f); },
    getCreativeCache: function () { return compCreativeCache; },
    resetCreativeCache: function () { compCreativeCache = {}; },
    getAllAds: function () { return compAllAds; },
  };

  /* Test surface (US-009): expose the Vision & Text tab internals so the
   * acceptance test can exercise rendering + registration without a full boot.
   * Production paths do not read these; they only add to window. */
  window.f10CompetitorThemes = {
    themesSectionHtml: compThemesSectionHtml,
    themeCardHtml: compThemeCardHtml,
    confHtml: compThemesConfHtml,
    freshHtml: compThemesFreshHtml,
    formatMixHtml: compFormatMixHtml,
    phrasesHtml: compPhrasesHtml,
    render: compThemesRender,
    load: compThemesLoad,
    fetchThemes: fetchThemes,
    registerThemesTab: compRegisterThemesTab,
    selectTab: compThemesSelectTab,
    getThemes: function () { return compThemes; },
    setClient: function (c) { compClient = c; },
    isLoaded: function () { return compThemesLoaded; },
  };

  /* Test surface (US-010): expose the Ad Age Over Time tab internals so the
   * acceptance test can exercise chart rendering + registration without a full
   * boot. Production paths do not read these; they only add to window. */
  window.f10CompetitorAge = {
    chartHtml: compaChartHtml,
    toggleHtml: compaToggleHtml,
    seriesPoints: compaSeriesPoints,
    buildAxis: compaBuildAxis,
    monthKey: compaMonthKey,
    monthLabel: compaMonthLabel,
    render: compaRender,
    load: compaLoad,
    fetchAge: fetchAge,
    registerAgeTab: compaRegisterTab,
    selectTab: compaSelectTab,
    getData: function () { return compaData; },
    getMetric: function () { return compaMetric; },
    setMetric: function (m) { if (COMPA_METRIC_FIELD[m]) { compaMetric = m; } },
    setClient: function (c) { compClient = c; },
    isLoaded: function () { return compaLoaded; },
  };

  /* Test surface (US-011): expose the Meta Maturity tab internals so the
   * acceptance test can exercise score/leaderboard/net-new rendering + registration
   * without a full boot. Production paths do not read these; they only add to window. */
  window.f10CompetitorMaturity = {
    scoreRowHtml: compmScoreRowHtml,
    tierBadge: compmTierBadge,
    rankHeadlineHtml: compmRankHeadlineHtml,
    leaderboardHtml: compmLeaderboardHtml,
    netNewHtml: compmNetNewHtml,
    rankedRows: compmRankedRows,
    components: COMPM_COMPONENTS,
    render: compmRender,
    load: compmLoad,
    fetchMaturity: fetchMaturity,
    fetchLeaderboard: fetchLeaderboard,
    fetchNetNew: fetchNetNew,
    registerMaturityTab: compmRegisterTab,
    selectTab: compmSelectTab,
    getData: function () { return compmData; },
    setClient: function (c) { compClient = c; },
    isLoaded: function () { return compmLoaded; },
  };

  /* Test surface (competitor-intel-rollup US-008): expose the consolidated
   * Competitor Intelligence internals so the acceptance test can exercise the
   * per-competitor card, effort/behaviour/theme rendering, winners, narrative,
   * and registration without a full DOM/probe boot. Production paths do not read
   * these; they only add to window. */
  window.f10CompetitorIntel = {
    competitorCardHtml: compiCompetitorCardHtml,
    isPresentableCompetitor: isPresentableCompetitor,
    narrativeHtml: compiNarrativeHtml,
    effortHtml: compiEffortHtml,
    behaviourHtml: compiBehaviourHtml,
    themeMovesHtml: compiThemeMovesHtml,
    archetypeBadge: compiArchetypeBadge,
    trendChip: compiTrendChip,
    winnersHtml: compiWinnersHtml,
    render: compiRender,
    load: compiLoad,
    fetchIntel: fetchCompetitorIntel,
    registerTab: compiRegisterTab,
    selectTab: compiSelectTab,
    getData: function () { return compiData; },
    setClient: function (c) { compClient = c; },
    setAgeMetric: function (m) { if (m === 'avg' || m === 'median') { compiAgeMetric = m; } },
    isLoaded: function () { return compiLoaded; },
  };
})();
