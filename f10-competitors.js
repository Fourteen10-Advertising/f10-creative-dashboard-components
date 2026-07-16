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
 * signed creative URLs, and absent-safe vision enrichment.
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

    // Vision enrichment when present; absent → no empty labels rendered.
    let vis = '';
    const v = ad.vision;
    if (v && (v.hook || v.angle || v.format_read)) {
      vis = '<div class="comp-vision">'
        + (v.hook ? `<div><b>Hook:</b> ${esc(v.hook)}</div>` : '')
        + (v.angle ? `<div><b>Angle:</b> ${esc(v.angle)}</div>` : '')
        + (v.format_read ? `<div><b>Format:</b> ${esc(v.format_read)}</div>` : '')
        + '</div>';
    }
    const link = snap ? `<a href="${esc(snap)}" target="_blank" rel="noopener">View on Meta &rarr;</a>` : '';

    return `<div class="comp-card">${compMediaHtml(ad.creatives)}<div class="comp-body">`
      + `<div class="comp-tags">${tags.join('')}</div>`
      + (since && since !== '–' ? `<div class="comp-since">Live since ${esc(since)}</div>` : '')
      + `<div class="comp-copy${cc.dyn ? ' dyn' : ''}">${copy}</div>`
      + `<div class="comp-foot"><span class="comp-cta">${cta || '&nbsp;'}</span>${link}</div>`
      + `</div>${vis}</div>`;
  }

  /* ── Load + render orchestration ── */

  async function compLoad() {
    showEl('comp-loading'); hideEl('comp-body');
    try {
      const res = await fetchCompetitor(compClient);
      compRender((res && Array.isArray(res.ads)) ? res.ads : [], res && res.ageMetrics);
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
    // Group by competitor page_name, preserving the query's ordering.
    const groups = [];
    const idx = {};
    ads.forEach((a) => {
      const key = (a.page_name != null && a.page_name !== '') ? String(a.page_name) : 'Unknown';
      if (idx[key] === undefined) { idx[key] = groups.length; groups.push({ page_name: key, rows: [] }); }
      groups[idx[key]].rows.push(a);
    });

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

    let total = 0, visionRan = false;
    compSections = groups.map((g) => {
      let rows = g.rows;
      if (COMP_MAX && rows.length > COMP_MAX) rows = rows.slice(0, COMP_MAX);
      const live = rows.reduce((n, a) => n + (((a.still_active != null ? a.still_active : a.is_active)) ? 1 : 0), 0);
      rows.forEach((a) => { if (a.vision && (a.vision.hook || a.vision.angle || a.vision.format_read)) visionRan = true; });
      total += rows.length;
      return { page_name: g.page_name, cards: rows.map(compCardHtml), total: rows.length, live: live, cur: 0 };
    });

    if (metaLine) {
      metaLine.textContent = `${groups.length} competitor${groups.length === 1 ? '' : 's'} · `
        + `${total} ad${total === 1 ? '' : 's'} · source: Meta Ad Library (AU)`;
    }
    if (note) {
      const pageHint = `Each competitor shows ${COMP_PER_PAGE} ads at a time — use Prev / Next to page through the rest.`;
      note.textContent = visionRan
        ? `Cards show the observed hook, angle and format from the vision read. ${pageHint}`
        : `Vision analysis has not been run yet — cards show the raw scraped ads; play any video or scroll multi-asset ads in place. ${pageHint}`;
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

  /* ── Tab system (coordinates with the Meta engine + TikTok section) ── */

  function compSelectTab() {
    // Deactivate Meta + TikTok: hide their panels, nav highlights, control bars.
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    document.querySelectorAll('.tt-nav-link').forEach((l) => l.classList.remove('active'));
    const mc = document.getElementById('controls-bar'); if (mc) mc.style.display = 'none';
    const tc = document.getElementById('tt-controls-bar'); if (tc) tc.style.display = 'none';
    // Activate Competitors.
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
    document.querySelectorAll('.comp-nav-link').forEach((l) => l.classList.remove('active'));
  }

  function compWireControls() {
    document.querySelectorAll('.comp-nav-link').forEach((link) =>
      link.addEventListener('click', (e) => { e.preventDefault(); compSelectTab(); })
    );
    document.querySelectorAll('.nav-link, .tt-nav-link').forEach((link) =>
      link.addEventListener('click', compDeactivateOnOtherNav)
    );
  }

  /* ── Boot ── */

  /* Probe passed → register the tab: append the nav section to the sidebar nav
   * and the panel (f10-layout.js's competitorPanelMarkup()) to #content, then
   * wire the tab controls. Nothing here runs for a no-competitor client. */
  function compRegisterTab() {
    const nav = document.querySelector('#sidebar nav');
    const content = document.getElementById('content');
    if (!nav || !content || typeof competitorPanelMarkup !== 'function') return;
    nav.insertAdjacentHTML('beforeend',
      '<div class="nav-section">Competitors</div>'
      + '<a href="#" class="comp-nav-link" data-comp-tab="competitors">Competitor Ads</a>');
    content.insertAdjacentHTML('beforeend', competitorPanelMarkup());
    compWireControls();
  }

  /* Called unconditionally by f10-layout.js during boot. Fires the cheap
   * existence probe (US-001 `probe:true` path — BQ EXISTS on ad_registry, no
   * snapshot-history scan) and registers the tab only when the client has
   * competitor rows. exists:false is silent (the normal case); probe errors
   * warn once and fail closed — no nav entry, no panel, no empty state. */
  async function initCompetitors() {
    compClient = compClientKey();
    if (!compClient || typeof BQ_FUNCTION === 'undefined' || !BQ_FUNCTION) return; // no key or endpoint → silent no-op
    try {
      const r = await fetch(BQ_FUNCTION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'competitor', client: compClient, probe: true }),
      });
      if (!r.ok) { console.warn('Competitor visibility probe failed: HTTP ' + r.status); return; }
      const res = await r.json();
      if (res && res.exists === true) compRegisterTab();
    } catch (err) {
      console.warn('Competitor visibility probe error:', err && err.message ? err.message : err);
    }
  }

  window.initCompetitors = initCompetitors;
})();
