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
 *     PER_PAGE:    30,       // optional; competitor cards shown per in-page page
 *     MAX_PER_PAGE: 0,       // optional hard cap on ads rendered per competitor
 *   };
 *
 * The panel groups every tracked competitor's live Meta ads by competitor
 * page_name, in the F10 card layout — a JS port of the static
 * build_competitor_page.py surface. Data comes from the shared framework's
 * Netlify function via the data-driven `competitor` action (US-001), which
 * returns the latest snapshot per ad with longevity fields, request-time v4
 * signed creative URLs, and absent-safe age-metrics enrichment.
 *
 * Pagination mirrors the static page: each competitor shows PER_PAGE cards at a
 * time with Prev / Next, and ONLY the currently visible page's cards are mounted
 * in the DOM — so only that page's media (signed URLs) is fetched by the browser.
 *
 * Entrypoint — f10-layout.js calls initCompetitors() unconditionally during
 * boot; the probe decides whether the tab exists. The tab loads its data lazily
 * on first activation.
 */
(function () {
  /* COMPETITORS is optional overrides only (CLIENT, PER_PAGE, MAX_PER_PAGE). */
  const CFG = (typeof COMPETITORS !== 'undefined' && COMPETITORS) ? COMPETITORS : {};

  const COMP_PER_PAGE = Number(CFG.PER_PAGE) > 0 ? Number(CFG.PER_PAGE) : 30;
  const COMP_MAX = Number(CFG.MAX_PER_PAGE) > 0 ? Number(CFG.MAX_PER_PAGE) : 0;
  const COMP_TOKEN_RE = /\{\{[^}]+\}\}/g;

  let compLoaded = false;
  let compClient = ''; // resolved f10_client key (set during initCompetitors)
  let compSections = []; // [{ page_name, cards:[html], total, live, cur }]
  let compDefaultAds = null;  // cached full ad set from the default competitor load (US-008 restore)
  let compDefaultAge = null;  // cached ageMetrics that went with compDefaultAds
  let compSearchActive = false; // true while a search view is showing instead of the full grid

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

  /* Days since Meta's stated go-live date (the winner/longevity signal), NOT the
   * warehouse observation age. Mirrors build_competitor_page.py's card "days". */
  function daysSince(v) {
    const d = compDateStr(v);
    if (!d) return null;
    const [y, mo, da] = d.split('-').map(Number);
    if (!y || !mo || !da) return null;
    const diff = Math.floor((Date.now() - Date.UTC(y, mo - 1, da)) / 86400000);
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

  async function fetchCompetitor(client) {
    const r = await fetch(BQ_FUNCTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'competitor', client: client }),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
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
    const days = daysSince(ad.ad_delivery_start_time);
    const live = (ad.still_active != null) ? ad.still_active : ad.is_active;
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

  /* ── Load + render orchestration ── */

  async function compLoad() {
    showEl('comp-loading'); hideEl('comp-body');
    try {
      const res = await fetchCompetitor(compClient);
      compDefaultAds = (res && Array.isArray(res.ads)) ? res.ads : [];
      compDefaultAge = res && res.ageMetrics;
      compRender(compDefaultAds, compDefaultAge);
    } catch (err) {
      console.error('Competitor load error:', err);
      const el = document.getElementById('comp-loading');
      if (el) el.innerHTML = 'Error loading data: ' + esc(err && err.message ? err.message : String(err));
    }
  }

  function compRender(ads, ageMetrics) {
    const age = (ageMetrics && typeof ageMetrics === 'object') ? ageMetrics : {};
    const ageClient = age.client || null;
    const ageByPage = (age.byPage && typeof age.byPage === 'object') ? age.byPage : {};
    // Group by competitor page_name (shared with the search view).
    const groups = compGroupByPage(ads);

    const body = document.getElementById('comp-body');
    const metaLine = document.getElementById('comp-meta');
    const note = document.getElementById('comp-note');

    if (!groups.length) {
      if (body) body.innerHTML = '<div class="no-data">No competitor ads are being tracked for this client yet.</div>';
      if (metaLine) metaLine.textContent = '';
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
      return { page_name: g.page_name, cards: rows.map(compCardHtml), total: rows.length, live: live, cur: 0 };
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

    compSections.forEach((s, i) => compRenderSection(i));

    const lu = document.getElementById('last-updated');
    if (lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
    hideEl('comp-loading'); showEl('comp-body');
  }

  /* Draw one competitor section's current page. Only the visible page's cards
   * are written into the grid, so only that page's media is ever in the DOM. */
  function compRenderSection(i) {
    const s = compSections[i];
    const grid = document.getElementById('comp-grid-' + i);
    const pager = document.getElementById('comp-pager-' + i);
    if (!grid) return;
    const pages = Math.max(1, Math.ceil(s.cards.length / COMP_PER_PAGE));
    if (s.cur >= pages) s.cur = pages - 1;
    if (s.cur < 0) s.cur = 0;
    const start = s.cur * COMP_PER_PAGE;
    const end = Math.min(start + COMP_PER_PAGE, s.cards.length);
    grid.innerHTML = s.cards.slice(start, end).join('');

    if (!pager) return;
    if (pages <= 1) { pager.style.display = 'none'; pager.innerHTML = ''; return; }
    pager.style.display = 'flex';
    pager.innerHTML =
      `<button class="pg-btn" data-comp-prev${s.cur === 0 ? ' disabled' : ''}>&#8592; Prev</button>`
      + `<span class="pg-info">Showing ${start + 1}&ndash;${end} of ${s.cards.length} &middot; page ${s.cur + 1} of ${pages}</span>`
      + `<button class="pg-btn" data-comp-next${s.cur >= pages - 1 ? ' disabled' : ''}>Next &#8594;</button>`;
    const prev = pager.querySelector('[data-comp-prev]');
    const next = pager.querySelector('[data-comp-next]');
    const go = (delta) => {
      s.cur += delta;
      compRenderSection(i);
      const sec = document.getElementById('comp-sec-' + i);
      if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
      compRenderSearch((res && Array.isArray(res.ads)) ? res.ads : [], term);
    } catch (err) {
      // Surface the failure loudly (hq-never-swallow-errors): log it and show it
      // in the tab, exactly like the default-grid load path does.
      console.error('Competitor search error:', err);
      const el = document.getElementById('comp-loading');
      if (el) el.innerHTML = 'Error running search: ' + esc(err && err.message ? err.message : String(err));
    }
  }

  /* Render matched ads into the SAME grouped-section grid the default view uses,
   * so media is lazy/signed and the pager behaves identically. */
  function compRenderSearch(ads, term) {
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
      return { page_name: g.page_name, cards: rows.map(compCardHtml), total: rows.length, live: live, cur: 0 };
    });

    if (metaLine) {
      metaLine.textContent = 'Search “' + term + '” · '
        + groups.length + ' competitor' + (groups.length === 1 ? '' : 's') + ' · '
        + total + ' ad' + (total === 1 ? '' : 's');
    }
    if (note) {
      note.textContent = 'Showing ads whose text matches “' + term + '” — clear the search to return to the full library.';
    }

    body.innerHTML = groups.length ? compSections.map((s, i) =>
      `<section class="comp-section" id="comp-sec-${i}">`
        + `<h2 class="comp-head">${esc(s.page_name)}</h2>`
        + `<p class="comp-pgmeta">${s.total} ad${s.total === 1 ? '' : 's'} matched &middot; ${s.live} live</p>`
        + `<div class="comp-grid" id="comp-grid-${i}"></div>`
        + `<div class="comp-pager" id="comp-pager-${i}"></div>`
      + `</section>`
    ).join('') : '';

    compSections.forEach((s, i) => compRenderSection(i));
    hideEl('comp-loading'); showEl('comp-body');
  }

  /* Restore the cached full grid. If the default grid was never loaded (search
   * ran first), fall back to a fresh load. */
  function compClearSearch() {
    compSearchActive = false;
    const clear = document.getElementById('comp-search-clear');
    if (clear) clear.hidden = true;
    const input = document.getElementById('comp-search-input');
    if (input) input.value = '';
    if (compDefaultAds) {
      compRender(compDefaultAds, compDefaultAge);
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
    document.querySelectorAll('.comp-nav-link, .comp-themes-nav-link, .comp-age-nav-link').forEach((l) => l.classList.remove('active'));
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
      + `<text x="${padL - 6}" y="${(yFor(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--grey)">${Math.round(v)}</text>`
    ).join('');
    const everyX = Math.max(1, Math.ceil(axis.length / 8));
    const xlabels = axis.map((k, i) => (i % everyX === 0 || i === axis.length - 1)
      ? `<text x="${xFor(k).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="9" fill="var(--grey)">${esc(compaMonthLabel(k))}</text>` : '').join('');

    const paths = series.map((s) => {
      let d = '', started = false;
      s.points.forEach((p) => {
        if (p.value == null) { started = false; return; }
        d += (started ? 'L' : 'M') + xFor(p.key).toFixed(1) + ' ' + yFor(p.value).toFixed(1) + ' ';
        started = true;
      });
      const dots = s.points.filter((p) => p.value != null)
        .map((p) => `<circle cx="${xFor(p.key).toFixed(1)}" cy="${yFor(p.value).toFixed(1)}" r="${s.isClient ? 3 : 2.4}" fill="${s.color}"/>`).join('');
      return `<path class="compa-line" data-series="${s.id}" d="${d.trim()}" fill="none" stroke="${s.color}" `
        + `stroke-width="${s.isClient ? 3 : 1.8}" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
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

    return '<div class="compa-chart-wrap" style="background:var(--white);border:2px solid var(--paper-dark);border-radius:8px;padding:16px 18px;">'
      + svg + legend + '</div>';
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
    await compProbeAndRegister('themes', compRegisterThemesTab, 'Competitor themes visibility probe');
    await compProbeAndRegister('age-timeseries', compaRegisterTab, 'Competitor age visibility probe');
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
    setDefault: function (ads, age) { compDefaultAds = ads; compDefaultAge = age; },
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
})();
