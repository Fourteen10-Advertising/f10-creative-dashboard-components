/**
 * f10-review.js - F10 Creative Review tab (discovery-gated, live-path safe, US-007;
 *                 approve/decline gate + approval state, US-009;
 *                 scored batch review / ranked grid, roadmap #5;
 *                 auto-discovered bundles + generation-date filter)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@TAG/f10-review.js"></script>
 *
 * WHAT IT SHOWS: the interactive preview surface for the creative pipeline. For each
 * newly GENERATED ad (a "bundle" under review) it renders that ad with its coherence
 * scorecard, so an F10 reviewer can triage a whole batch of new concepts at a glance
 * without waiting on a static report. The new ad's own preview image comes from the
 * US-005 `generated-preview` action; the bundle's coherence flags and held dimensions
 * ride alongside so the reviewer sees any held dimensions in context.
 *
 * AUTO-DISCOVERED BUNDLES: the review list is NOT a hardcoded config array. On load the
 * module asks the backend `list-bundles` action which generated bundles exist for this
 * client (from the shared creative_manifest), newest first, and reviews those. So a new
 * operator run shows up on the tab with no dashboard edit.
 *
 * SCORED BATCH REVIEW - RANKED GRID (roadmap #5): when more than one bundle is visible
 * the DEFAULT view is a ranked GRID of scorecard cards, best-first, so a whole batch is
 * triaged at a glance instead of one ad at a time. Each card fetches its coherence
 * scorecard from the backend via the store's `coherence` action
 * ({ found, overall_verdict, overall_score, dimensions:{client_fit, component_fidelity,
 * brand_compliance}, flags }) and shows the composite thumbnail, the three dimension
 * scores with pass/flag chips, the flags, the overall verdict badge + score, and the same
 * Approve / Decline controls + persisted state. Cards sort `found && verdict==='pass'`
 * first, then by overall_score desc, with unscored (found:false) bundles last; a small
 * rank / among-N indicator rides on each card. The scorecard fetch FAILS CLOSED: any
 * error (or a store with no `coherence` method) renders a clean "not scored yet" card that
 * is still approvable - a scorecard miss never breaks the tab. A single visible bundle
 * renders the detail view (the new ad, its flags and its decision gate) instead of a grid.
 *
 * GENERATION-DATE FILTER: discovered bundles are grouped by the date they were generated.
 * A "Generation" dropdown inside the panel lists the distinct generation dates newest
 * first and defaults to the most recent, so the tab opens on the latest run. Changing it
 * re-filters the visible bundles (a date with one bundle shows the detail view, a date
 * with several shows the ranked grid) without a re-query.
 *
 * VISIBILITY IS DATA-DRIVEN AND LIVE-PATH SAFE - two gates, both fail closed:
 *   1. LIVE-PATH SAFETY. With no `BQ_FUNCTION` endpoint AND no injected store the module
 *      short-circuits to a silent no-op: no discovery call, no network, no nav link, no
 *      panel, ZERO DOM trace. This keeps the module STRICTLY ADDITIVE on a host that has
 *      not wired the backend.
 *   2. DISCOVERY GATE (US-007 AC1). The module asks `list-bundles` which bundles exist for
 *      this client. Only when at least one bundle is discovered does it inject its
 *      "Creative Review" nav section, "Review" nav link and panel. A client with no
 *      generated bundles, or ANY discovery error (endpoint down, table not built), shows
 *      NO tab and leaves zero trace - it fails closed, never a broken or empty tab.
 *
 * TAB ACTIVATION: selecting the tab goes through the single generic dispatcher
 * f10ActivateTab() (f10-layout.js), which clears EVERY nav link and EVERY panel before
 * activating the selected pair. The module never hard-codes any other tab's classes, so
 * adding it required editing no existing module and two panels can never show at once.
 *
 * DISPATCH: f10-layout.js calls window.initReview() at the tail of renderLayout() (the
 * same unconditional, discovery-decides pattern as initComponents). The module ALSO
 * self-boots on DOMContentLoaded behind an idempotent guard, so a dashboard pinned to an
 * older f10-layout.js tag still gets the tab. Both paths call the same idempotent
 * initReview().
 *
 * APPROVE / DECLINE GATE (US-009): each ad carries a coarse concept-level decision -
 * approve (marks the bundle servable, sets its approved flag) or decline (records a reason
 * and marks it not-servable). The decision is recorded via the US-008 feedback WRITE path
 * (this module never re-implements that write); the persisted state is read back on load, so
 * reloading the surface shows the real approved / declined / pending state. Both the write and
 * the read sit behind an injectable feedback-client seam (setFeedbackClient) so tests use
 * fakes and never hit a live service. There is NO regenerate / re-prompt loop: refinement is a
 * designer pass in Figma after approval, decided in interview.
 *
 * CONFIG (optional): REVIEW is only defined on the F10-internal review surface; live
 * client dashboards never define it. The bundle list is auto-discovered, so REVIEW only
 * carries optional overrides.
 *   const REVIEW = {
 *     CLIENT: 'moshy',          // optional; override the f10 client slug when DATASET
 *                               // does not follow the {client}_marts / {client}_clean convention
 *     ACTOR: 'zac@f10',         // optional; who is recording the decision. Behind the F10 gate
 *                               // the endpoint stamps the authenticated actor, so this is optional.
 *   };
 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (function () {
    'use strict';

    /* Optional overrides only; absent on every live client dashboard. */
    var CFG = (typeof REVIEW !== 'undefined' && REVIEW) ? REVIEW : {};

    var rvClient = '';       // resolved f10 client slug (set during initReview)
    var rvBooted = false;    // guard against double boot (renderLayout + autoBoot)
    var rvLoaded = false;    // bundle data loaded lazily on first activation
    var rvNavLink = null;    // the injected nav-link element (bound once)
    var rvStore = null;      // injectable data store (tests override via setStore)
    var rvBundles = null;    // discovered + normalised bundle list (from list-bundles; tests override via setBundles)
    var rvDate = '';         // selected generation-date filter (defaults to the most recent discovered date)
    var rvFeedback = null;   // injectable feedback client (US-009; tests override via setFeedbackClient)
    var rvResults = [];      // last-loaded per-bundle results, so a decision can re-render in place
    var rvStatus = {};       // per-bundle approval state {state,comment,actor,updated_at}, read back + updated on decide
    var rvBusy = {};         // per-bundle in-flight guard so a double click cannot double-post
    var rvDecErr = {};       // per-bundle last decision error message, surfaced inline (never a silent failure)

    /* ---- small local helpers ---- */

    function esc(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* BQ numbers can arrive as { value: '12.3' }; coerce to a real number or null. */
    function num(v) {
      if (v == null || v === '') return null;
      if (typeof v === 'object' && v.value !== undefined) v = v.value;
      var n = Number(v);
      return isFinite(n) ? n : null;
    }

    /* A coherence flag / held dimension may be a plain string or a small object
     * ({ dimension|label|name, reason? }); render either into human text. */
    function flagText(f) {
      if (f == null) return '';
      if (typeof f === 'string') return f;
      if (typeof f === 'object') {
        var base = f.dimension || f.label || f.name || f.flag || '';
        var reason = f.reason || f.note || '';
        return reason ? (String(base) + ': ' + String(reason)) : String(base);
      }
      return String(f);
    }

    /* ---- client resolution ---- */

    /* Resolve the f10 client slug: an explicit REVIEW.CLIENT override wins; otherwise
     * derive it from DATASET by stripping a trailing _marts / _clean suffix
     * (moshy_marts -> moshy), mirroring f10-components.js and f10-brief-editor.js.
     * Sanitised to the slug charset. Returns '' when nothing resolves. */
    function clientKey() {
      var raw = CFG.CLIENT
        ? String(CFG.CLIENT)
        : (typeof DATASET !== 'undefined' && DATASET ? String(DATASET).replace(/_(marts|clean)$/, '') : '');
      return raw.replace(/[^a-z0-9_]/gi, '');
    }

    /* The auto-discovered bundles-under-review for this client, populated from the backend
     * `list-bundles` action during load (discoverBundles) and normalised into the render
     * shape below. Tests inject via setBundles. An empty list is the discovery gate: with
     * no discovered bundles there is nothing to review, so the module never registers. */
    function getBundles() {
      var list = Array.isArray(rvBundles) ? rvBundles : [];
      return list.filter(function (b) { return b && (b.bundle_id || b.bundleId); });
    }

    function bundleId(b) {
      return (b && (b.bundle_id || b.bundleId)) ? String(b.bundle_id || b.bundleId) : '';
    }
    function bundlePlatform(b) {
      return (b && b.platform === 'tiktok') ? 'tiktok' : 'meta';
    }

    /* The generation date a bundle belongs to (the list-bundles `date`, an ISO
     * 'YYYY-MM-DD' string). Missing dates normalise to '' so they group together. */
    function bundleDate(b) {
      return (b && b.date != null && b.date !== '') ? String(b.date) : '';
    }

    /* Normalise one discovered bundle into the shape the render path expects. Backend
     * entries carry { bundle_id, platform, date, generated_at }; injected test bundles may
     * carry the fuller config shape (label, components, coherence_flags, new_ad). All
     * original fields are preserved; bundle_id / platform / date are always present. A
     * bundle with no usable id is dropped (returns null). */
    function normalizeDiscovered(b) {
      if (!b || typeof b !== 'object') return null;
      var id = b.bundle_id || b.bundleId;
      if (!id) return null;
      var out = {};
      for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = b[k]; }
      out.bundle_id = String(id);
      out.platform = (b.platform === 'tiktok') ? 'tiktok' : 'meta';
      out.date = (b.date != null && b.date !== '') ? String(b.date)
        : (b.generated_date != null && b.generated_date !== '' ? String(b.generated_date)
          : (b.generated_at != null && b.generated_at !== '' ? String(b.generated_at).slice(0, 10) : ''));
      return out;
    }

    /* The distinct generation dates across the discovered bundles, newest first. ISO
     * 'YYYY-MM-DD' strings sort lexicographically in chronological order, so a descending
     * string sort puts the most recent date first; bundles with no date ('') sort last. */
    function distinctDates() {
      var list = getBundles();
      var seen = {};
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var d = bundleDate(list[i]);
        if (!Object.prototype.hasOwnProperty.call(seen, d)) { seen[d] = 1; out.push(d); }
      }
      out.sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0); });
      return out;
    }

    /* The loaded per-bundle results whose bundle matches the selected generation date. */
    function filteredResults(results) {
      var list = Array.isArray(results) ? results : [];
      return list.filter(function (r) { return bundleDate(r && r.bundle) === rvDate; });
    }

    /* ---- data store (injectable; default posts to the shared bq function) ---- */

    /* The default store posts { action, ... } to BQ_FUNCTION, mirroring runQuery's
     * fetch convention, and fails closed on a non-ok response. Overridable for tests
     * and for a future backend wiring via setStore. Three reads:
     *   listBundles(client)               -> { bundles:[...] } (list-bundles discovery)
     *   preview(client, bundleId, plat)   -> { url }  (generated-preview, US-005)
     *   coherence(client, bundleId, plat) -> scorecard (coherence action, roadmap #5)
     *
     * The coherence scorecard contract (fail-closed on any error -> treated as unscored):
     *   { found:bool,
     *     overall_verdict:'pass'|'flag', overall_score:number(0..1),
     *     dimensions:{
     *       client_fit:{ score, verdict, reason },
     *       component_fidelity:{ score, verdict, reason, matched, total },
     *       brand_compliance:{ score, verdict, reason } },
     *     flags:[string] }
     */
    function defaultStore() {
      var url = (typeof BQ_FUNCTION !== 'undefined' && BQ_FUNCTION) ? BQ_FUNCTION : '/.netlify/functions/bq';
      async function call(payload) {
        var res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }
      return {
        async listBundles(client) {
          return call({ action: 'list-bundles', client: client });
        },
        async preview(client, id, platform) {
          return call({ action: 'generated-preview', client: client, bundleId: id, platform: platform });
        },
        async coherence(client, id, platform) {
          return call({ action: 'coherence', client: client, bundleId: id, platform: platform });
        },
      };
    }

    function store() { return rvStore || defaultStore(); }

    /* ---- feedback write/read seam (US-009; injectable, default hits the US-008 endpoint) ----
     *
     * The approve/decline decision is recorded by the US-008 feedback write path; this module
     * never re-implements that write. The default client POSTs the exact US-008 contract
     * ({ client, platform, bundle_id, state, comment?, actor? }) to the feedback function and
     * reads the persisted state back from the same source so a reload shows the real decision.
     * The endpoint runs on GCP compute and is not deployed yet, so both calls sit behind this
     * seam: tests inject a fake via setFeedbackClient, and a read that cannot resolve degrades
     * to "pending" rather than throwing. Two operations:
     *   submit(record)                 -> the endpoint's success payload (includes state, updated_at)
     *   read(client, bundleId, plat)   -> the persisted status.json shape, or null when none (pending)
     */
    function feedbackUrl() {
      if (typeof FEEDBACK_FUNCTION !== 'undefined' && FEEDBACK_FUNCTION) return FEEDBACK_FUNCTION;
      if (CFG.FEEDBACK_FUNCTION) return String(CFG.FEEDBACK_FUNCTION);
      return '/.netlify/functions/feedback';
    }

    function defaultFeedbackClient() {
      var url = feedbackUrl();
      return {
        async submit(record) {
          var res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record),
          });
          if (!res.ok) throw new Error(await res.text());
          return res.json();
        },
        async read(client, id, platform) {
          // Read back the persisted decision (status.json sidecar) from the same source.
          // A non-ok response (no decision yet, or the read path not deployed) means "pending".
          var q = url + (url.indexOf('?') === -1 ? '?' : '&')
            + 'client=' + encodeURIComponent(client)
            + '&bundle_id=' + encodeURIComponent(id)
            + '&platform=' + encodeURIComponent(platform);
          var res = await fetch(q, { method: 'GET', headers: { Accept: 'application/json' } });
          if (!res.ok) return null;
          var data = await res.json();
          return (data && data.state) ? data : null;
        },
      };
    }

    function feedbackClient() { return rvFeedback || defaultFeedbackClient(); }

    /* The three visible states, nothing else. Anything unrecognised reads as pending so the
     * UI never shows an invented or half-set decision. */
    function normState(s) {
      return (s === 'approved' || s === 'declined') ? s : 'pending';
    }

    /* The current known decision for a bundle, defaulting to pending. */
    function statusOf(id) {
      var st = rvStatus[id];
      return { state: normState(st && st.state), comment: (st && st.comment) || '', actor: (st && st.actor) || '', updated_at: (st && st.updated_at) || '' };
    }

    /* Who is recording the decision. An explicit REVIEW.ACTOR wins; otherwise a global the
     * host may set. Empty is fine: behind the F10 gate the endpoint stamps the actor from the
     * authenticated header, so the client need not know it. */
    function actorName() {
      if (CFG.ACTOR) return String(CFG.ACTOR);
      if (typeof F10_ACTOR !== 'undefined' && F10_ACTOR) return String(F10_ACTOR);
      return '';
    }

    function findBundleById(id) {
      var list = getBundles();
      for (var i = 0; i < list.length; i++) { if (bundleId(list[i]) === id) return list[i]; }
      return null;
    }

    /* ---- coherence scorecard (roadmap #5; fail-closed) ----
     *
     * Fetch one bundle's coherence scorecard from the store. FAILS CLOSED in every failure
     * mode - a store with no coherence method, a rejected fetch, or a non-object response all
     * resolve to null (treated as "not scored yet"), so a scorecard miss can never throw and
     * never breaks the tab. Never rejects. */
    async function fetchCoherence(bundle) {
      var st = store();
      if (!st || typeof st.coherence !== 'function') return null;
      try {
        var sc = await st.coherence(rvClient, bundleId(bundle), bundlePlatform(bundle));
        return (sc && typeof sc === 'object') ? sc : null;
      } catch (err) {
        return null;
      }
    }

    /* A scorecard counts as scored only when the backend explicitly says found:true. Anything
     * else (null, found:false, a malformed shape) is unscored. */
    function isScored(sc) {
      return !!(sc && sc.found === true);
    }

    /* Ranking tier for the grid sort: 0 = scored & passing, 1 = scored & flagged,
     * 2 = unscored (always last). */
    function rankTier(sc) {
      if (!isScored(sc)) return 2;
      return (sc.overall_verdict === 'pass') ? 0 : 1;
    }

    function overallScore(sc) {
      var n = num(sc && sc.overall_score);
      return n == null ? -1 : n;
    }

    /* Best-first ordering: `found && verdict==='pass'` first, then by overall_score desc,
     * with unscored (found:false) bundles last. Stable within ties (original load order). */
    function sortForGrid(results) {
      var list = Array.isArray(results) ? results : [];
      return list.map(function (r, i) { return { r: r, i: i }; })
        .sort(function (a, b) {
          var ta = rankTier(a.r && a.r.coherence), tb = rankTier(b.r && b.r.coherence);
          if (ta !== tb) return ta - tb;
          var sa = overallScore(a.r && a.r.coherence), sb = overallScore(b.r && b.r.coherence);
          if (sa !== sb) return sb - sa;      // overall_score desc
          return a.i - b.i;                   // stable
        })
        .map(function (x) { return x.r; });
    }

    /* ---- rendering ---- */

    function flagBadges(flags, cls, emptyNote) {
      var arr = Array.isArray(flags) ? flags.filter(function (f) { return flagText(f); }) : [];
      if (!arr.length) return emptyNote ? '<span class="rev-muted">' + esc(emptyNote) + '</span>' : '';
      return arr.map(function (f) {
        return '<span class="' + cls + '">' + esc(flagText(f)) + '</span>';
      }).join(' ');
    }

    /* The NEW generated ad card: its own preview image (US-005), the bundle's component
     * values, any copy, and the coherence flags / held dimensions in context. A missing
     * or unresolvable composite falls back to a labelled placeholder, never a broken img. */
    function newAdHtml(bundle, previewUrl, previewReason) {
      var img = previewUrl
        ? '<img class="rev-img" src="' + esc(previewUrl) + '" alt="New generated ad preview" loading="lazy" />'
        : '<div class="rev-img rev-img-empty">Preview not available'
          + (previewReason ? ' <span class="rev-muted">(' + esc(previewReason) + ')</span>' : '') + '</div>';

      var comps = (bundle && bundle.components && typeof bundle.components === 'object') ? bundle.components : {};
      var rows = Object.keys(comps).map(function (k) {
        var v = comps[k];
        if (v == null || v === '') return '';
        return '<div class="rev-kv"><span class="rev-k">' + esc(k) + '</span>'
          + '<span class="rev-v">' + esc(v) + '</span></div>';
      }).join('');

      var copy = '';
      var na = (bundle && bundle.new_ad && typeof bundle.new_ad === 'object') ? bundle.new_ad : null;
      if (na) {
        copy = Object.keys(na).map(function (k) {
          var v = na[k];
          if (v == null || v === '' || typeof v === 'object') return '';
          return '<div class="rev-copy-line"><span class="rev-k">' + esc(k) + '</span> ' + esc(v) + '</div>';
        }).join('');
      }

      return '<div class="rev-new">'
        + '<div class="rev-col-head">New generated ad</div>'
        + img
        + (rows ? '<div class="rev-kvs">' + rows + '</div>' : '')
        + (copy ? '<div class="rev-copy">' + copy + '</div>' : '')
        + '</div>';
    }

    /* The per-bundle approve/decline gate (US-009). A coarse concept-level decision: approve
     * sets the bundle's approved flag (recorded via the US-008 write path) or decline records
     * a reason and marks the ad not-servable. The current state (approved / declined / pending)
     * is always shown, and after a decision the panel reflects the new state. There is
     * deliberately NO regenerate / re-prompt control: refinement is a designer pass in Figma
     * after approval, not an LLM tweak-and-regenerate loop. */
    function decisionHtml(bundle) {
      var id = bundleId(bundle);
      var st = statusOf(id);
      var busy = !!rvBusy[id];
      var err = rvDecErr[id] || '';

      var stateLabel = st.state === 'approved' ? 'Approved' : (st.state === 'declined' ? 'Declined' : 'Pending');
      var badge = '<span class="rev-state rev-state-' + st.state + '" data-rev-state="' + esc(st.state) + '">' + esc(stateLabel) + '</span>';
      var meta = '';
      if (st.state === 'declined') {
        meta = '<span class="rev-state-note">Not servable'
          + (st.comment ? ' &middot; reason: ' + esc(st.comment) : '')
          + (st.actor ? ' &middot; by ' + esc(st.actor) : '') + '</span>';
      } else if (st.state === 'approved') {
        meta = '<span class="rev-state-note">Servable'
          + (st.actor ? ' &middot; by ' + esc(st.actor) : '') + '</span>';
      }

      var dis = busy ? ' disabled' : '';
      var approveBtn = '<button type="button" class="rev-btn rev-approve" data-rev-action="approve" data-bundle-id="' + esc(id) + '"'
        + (st.state === 'approved' ? ' aria-pressed="true"' : '') + dis + '>Approve</button>';
      var declineBtn = '<button type="button" class="rev-btn rev-decline" data-rev-action="decline" data-bundle-id="' + esc(id) + '"'
        + (st.state === 'declined' ? ' aria-pressed="true"' : '') + dis + '>Decline</button>';
      var comment = '<textarea class="rev-comment" id="rev-comment-' + esc(id) + '" data-bundle-id="' + esc(id) + '" rows="1" '
        + 'placeholder="Optional reason for a decline">' + esc(st.state === 'declined' ? st.comment : '') + '</textarea>';

      var errHtml = err ? '<div class="rev-dec-err" data-bundle-id="' + esc(id) + '">Could not save decision: ' + esc(err) + '</div>' : '';
      var busyHtml = busy ? '<span class="rev-dec-busy">Saving&hellip;</span>' : '';

      return '<div class="rev-decision" data-bundle-id="' + esc(id) + '">'
        + '<div class="rev-decision-row">'
        + '<span class="rev-decision-label">Decision:</span> ' + badge + meta
        + '<span class="rev-decision-actions">' + approveBtn + declineBtn + busyHtml + '</span>'
        + '</div>'
        + '<div class="rev-decision-comment">' + comment + '</div>'
        + errHtml
        + '<div class="rev-refine-note">Refinement happens with the designer in Figma after approval. '
        + 'This is a yes/no concept gate; there is no regenerate or re-prompt step here.</div>'
        + '</div>';
    }

    /* The shared new-ad detail body: the coherence flags / held dimensions row and the new
     * generated ad (its preview, components and copy). Coherence flags and held dimensions
     * come from the bundle itself. */
    function detailBodyHtml(bundle, previewUrl, previewReason) {
      var cohFlags = (bundle && bundle.coherence_flags) || [];
      var held = (bundle && bundle.held_dimensions) || [];
      var flagsRow = '<div class="rev-flags">'
        + '<span class="rev-flags-label">Coherence flags:</span> '
        + flagBadges(cohFlags, 'rev-flag', 'none')
        + '<span class="rev-flags-label rev-held-label">Held for testing:</span> '
        + flagBadges(held, 'rev-held', 'none')
        + '</div>';

      return flagsRow
        + '<div class="rev-grid">'
        + newAdHtml(bundle, previewUrl, previewReason)
        + '</div>';
    }

    /* One bundle-under-review block for the single-bundle detail view: the head + the shared
     * detail body + the approve/decline gate. */
    function bundleHtml(bundle, previewUrl, previewReason) {
      var id = bundleId(bundle);
      var label = (bundle && bundle.label) ? bundle.label : id;

      return '<div class="rev-bundle" data-bundle-id="' + esc(id) + '">'
        + '<div class="rev-bundle-head"><span class="rev-bundle-title">' + esc(label) + '</span>'
        + '<span class="rev-bundle-id">' + esc(id) + '</span></div>'
        + detailBodyHtml(bundle, previewUrl, previewReason)
        + decisionHtml(bundle)
        + '</div>';
    }

    /* ---- coherence scorecard rendering (roadmap #5) ---- */

    /* A 0..1 score as a whole-percent, or a dash when absent. Never invents a number. */
    function fmtScore(v) {
      var n = num(v);
      return n == null ? '&mdash;' : Math.round(n * 100) + '%';
    }

    /* A pass/flag verdict chip. Anything not 'pass'/'flag' renders as a neutral dash chip. */
    function verdictChip(verdict) {
      var v = (verdict === 'pass') ? 'pass' : (verdict === 'flag' ? 'flag' : 'na');
      var label = v === 'pass' ? 'Pass' : (v === 'flag' ? 'Flag' : '&mdash;');
      return '<span class="rev-chip rev-chip-' + v + '" data-rev-verdict="' + v + '">' + label + '</span>';
    }

    function dimRow(label, valueHtml, verdict) {
      return '<div class="rev-dim">'
        + '<span class="rev-dim-label">' + esc(label) + '</span>'
        + '<span class="rev-dim-val">' + valueHtml + '</span>'
        + verdictChip(verdict) + '</div>';
    }

    /* The coherence scorecard for one card: overall verdict badge + score, the three
     * dimension scores (client_fit / component_fidelity as matched/total / brand_compliance)
     * with pass/flag chips, and the flags list. An unscored bundle (found:false, or a fetch
     * error) renders a clean "not scored yet" block - still approvable. */
    function scorecardHtml(sc) {
      if (!isScored(sc)) {
        return '<div class="rev-scorecard rev-scorecard-unscored" data-rev-scored="false">'
          + '<div class="rev-overall rev-overall-unscored">'
          + '<span class="rev-overall-badge rev-overall-na">Not scored yet</span></div>'
          + '<div class="rev-scorecard-note rev-muted">No coherence scorecard for this bundle yet.</div>'
          + '</div>';
      }
      var dims = (sc.dimensions && typeof sc.dimensions === 'object') ? sc.dimensions : {};
      var cf = dims.client_fit || {};
      var comp = dims.component_fidelity || {};
      var bc = dims.brand_compliance || {};
      var matched = num(comp.matched), total = num(comp.total);
      var compVal = (matched != null && total != null)
        ? esc(Math.round(matched) + '/' + Math.round(total))
        : fmtScore(comp.score);
      var overallV = (sc.overall_verdict === 'pass') ? 'pass' : 'flag';
      var overallLabel = overallV === 'pass' ? 'PASS' : 'FLAG';

      var flags = Array.isArray(sc.flags) ? sc.flags.filter(function (f) { return flagText(f); }) : [];
      var flagsHtml = flags.length
        ? '<ul class="rev-scorecard-flags">'
          + flags.map(function (f) { return '<li>' + esc(flagText(f)) + '</li>'; }).join('')
          + '</ul>'
        : '<div class="rev-scorecard-flags rev-scorecard-flags-none rev-muted">No flags</div>';

      return '<div class="rev-scorecard rev-scorecard-' + overallV + '" data-rev-scored="true">'
        + '<div class="rev-overall rev-overall-' + overallV + '">'
        + '<span class="rev-overall-badge rev-overall-' + overallV + '" data-rev-verdict="' + overallV + '">' + overallLabel + '</span>'
        + '<span class="rev-overall-score">' + fmtScore(sc.overall_score) + '</span>'
        + '</div>'
        + '<div class="rev-dims">'
        + dimRow('Client fit', fmtScore(cf.score), cf.verdict)
        + dimRow('Component fidelity', compVal, comp.verdict)
        + dimRow('Brand compliance', fmtScore(bc.score), bc.verdict)
        + '</div>'
        + flagsHtml
        + '</div>';
    }

    /* One ranked grid card: rank / among-N indicator, composite thumbnail, label, the
     * coherence scorecard, and the approve/decline gate + persisted state. */
    function cardHtml(r, rank, total) {
      var bundle = r.bundle;
      var id = bundleId(bundle);
      var label = (bundle && bundle.label) ? bundle.label : id;
      var scored = isScored(r.coherence);

      var rankBadge = scored
        ? '<span class="rev-rank" data-rev-rank="' + rank + '">#' + rank + ' of ' + total + '</span>'
        : '<span class="rev-rank rev-rank-unscored" data-rev-rank="0">Unscored &middot; ' + total + ' total</span>';

      var thumb = r.previewUrl
        ? '<img class="rev-img rev-card-thumb" src="' + esc(r.previewUrl) + '" alt="New generated ad preview" loading="lazy" />'
        : '<div class="rev-img rev-card-thumb rev-img-empty">Preview not available'
          + (r.previewReason ? ' <span class="rev-muted">(' + esc(r.previewReason) + ')</span>' : '') + '</div>';

      return '<div class="rev-card' + (scored ? '' : ' rev-card-unscored') + '" data-bundle-id="' + esc(id) + '">'
        + '<div class="rev-card-head">' + rankBadge
        + '<span class="rev-card-title" title="' + esc(label) + '">' + esc(label) + '</span>'
        + '<span class="rev-card-id">' + esc(id) + '</span>'
        + '</div>'
        + '<div class="rev-card-thumb-wrap">' + thumb + '</div>'
        + scorecardHtml(r.coherence)
        + decisionHtml(bundle)
        + '</div>';
    }

    /* The ranked grid: cards best-first with a small rank / among-N indicator. */
    function gridHtml(results) {
      var sorted = sortForGrid(results);
      var total = sorted.length;
      var scoredRank = 0;
      var cards = sorted.map(function (r) {
        var rank = isScored(r.coherence) ? (++scoredRank) : 0;
        return cardHtml(r, rank, total);
      });
      return '<div class="rev-cards">' + cards.join('') + '</div>';
    }

    /* The single-bundle detail view (the original stacked layout): each bundle's new ad,
     * its flags and the decision gate. */
    function detailHtml(results) {
      return results.map(function (r) {
        return bundleHtml(r.bundle, r.previewUrl, r.previewReason);
      }).join('');
    }

    function showEl(id, disp) {
      var el = document.getElementById(id);
      if (el) el.style.display = (disp || 'block');
    }
    function hideEl(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }

    /* Render the review body for the CURRENTLY FILTERED set (the bundles matching the
     * selected generation date). With MORE THAN ONE visible bundle the default view is the
     * ranked scorecard GRID (roadmap #5); with a single visible bundle it is the detail
     * view. Never a blank panel: an empty filtered set renders a small note. */
    function renderBundles(results) {
      rvResults = Array.isArray(results) ? results : [];
      var visible = filteredResults(rvResults);
      var body = document.getElementById('rev-body');
      if (body) {
        body.innerHTML = visible.length
          ? ((visible.length > 1) ? gridHtml(visible) : detailHtml(visible))
          : '<div class="rev-muted">No bundles for this generation date.</div>';
      }
      hideEl('rev-loading');
      hideEl('rev-error');
      showEl('rev-body');
    }

    /* A total load failure (should be rare - per-bundle failures are caught) renders a
     * visible panel error state, never a blank tab or a console-only error. */
    function renderError(err) {
      var msg = (err && err.message) ? err.message : String(err);
      if (window.console && console.error) console.error('Creative Review load error:', err);
      hideEl('rev-loading');
      hideEl('rev-body');
      var el = document.getElementById('rev-error');
      if (el) {
        el.innerHTML = '<strong>Creative Review is temporarily unavailable.</strong>'
          + '<div class="rev-error-detail">' + esc(msg) + '</div>';
        el.style.display = 'block';
      }
    }

    /* For one bundle, fetch the new ad's preview image (US-005) and its coherence scorecard
     * (roadmap #5) in parallel, and read back the persisted decision. Each side is
     * independently caught, so a preview or scorecard miss still leaves a full card
     * standing; a scorecard miss resolves to an unscored card. */
    async function loadBundle(bundle) {
      var id = bundleId(bundle);
      var label = (bundle && bundle.label) ? bundle.label : id;
      var st = store();
      var previewP = st.preview(rvClient, id, bundlePlatform(bundle)).catch(function () { return null; });
      // The coherence scorecard for the ranked grid (roadmap #5), fetched in parallel and
      // FAIL-CLOSED: fetchCoherence never rejects, so a scorecard miss resolves to an unscored
      // card without touching the rest of the load.
      var coherenceP = fetchCoherence(bundle);
      // Read the persisted decision back from the feedback/status source (US-009 AC3) in
      // parallel; a miss (or a read path not yet deployed) is simply "pending". The read is
      // authoritative on load, so reloading the surface always reflects the stored state.
      var statusP = feedbackClient().read(rvClient, id, bundlePlatform(bundle)).catch(function () { return null; });
      var persisted = await statusP;
      rvStatus[id] = (persisted && persisted.state)
        ? { state: normState(persisted.state), comment: persisted.comment || '', actor: persisted.actor || '', updated_at: persisted.updated_at || '' }
        : { state: 'pending', comment: '', actor: '', updated_at: '' };
      rvDecErr[id] = '';
      var preview = await previewP;
      var coherence = await coherenceP;
      return {
        bundle: bundle,
        label: label,
        previewUrl: (preview && preview.url) || null,
        previewReason: (preview && !preview.url) ? (preview.reason || '') : '',
        coherence: coherence,
      };
    }

    /* Discover the client's generated bundles from the store's list-bundles action and
     * normalise them into the render shape. A store with no listBundles method leaves any
     * already-injected list in place (setBundles). Populates rvBundles. */
    async function discoverBundles() {
      var st = store();
      if (st && typeof st.listBundles === 'function') {
        var r = await st.listBundles(rvClient);
        var raw = (r && Array.isArray(r.bundles)) ? r.bundles : (Array.isArray(r) ? r : []);
        rvBundles = raw.map(normalizeDiscovered).filter(function (b) { return !!b; });
      } else if (!Array.isArray(rvBundles)) {
        rvBundles = [];
      }
      return getBundles();
    }

    async function loadReview() {
      showEl('rev-loading');
      hideEl('rev-body');
      hideEl('rev-error');
      try {
        if (!Array.isArray(rvBundles)) await discoverBundles();
        initDateFilter();
        var bundles = getBundles();
        var results = await Promise.all(bundles.map(loadBundle));
        renderBundles(results);
      } catch (err) {
        renderError(err);
      }
    }

    /* ---- decide (US-009): approve / decline a bundle via the US-008 write path ---- */

    /* Re-render every loaded bundle from the cached results; each block reads the current
     * rvStatus, so a decision reflects in the panel without a full reload. */
    function rerender() {
      if (rvResults && rvResults.length) renderBundles(rvResults);
    }

    /* Record an approve/decline decision for one bundle. Posts the exact US-008 contract to
     * the feedback write path (we never re-implement that write), then reflects the persisted
     * new state in the panel. Approve sets state 'approved' (servable); decline sets state
     * 'declined' with the optional reason (not-servable). An in-flight guard prevents a
     * double-post, and a failure is surfaced inline, never swallowed. */
    async function submitDecision(id, state, comment) {
      id = String(id || '');
      if (!id || rvBusy[id]) return;
      var target = normState(state);
      if (target === 'pending') return;           // only approve/decline are user decisions
      var bundle = findBundleById(id);
      if (!bundle) return;

      var reason = (comment != null && String(comment).trim()) ? String(comment).trim() : null;
      var record = {
        client: rvClient,
        platform: bundlePlatform(bundle),
        bundle_id: id,
        state: target,
        comment: target === 'declined' ? reason : null,
        actor: actorName() || null,
      };

      rvBusy[id] = true;
      rvDecErr[id] = '';
      rerender();
      try {
        var resp = await feedbackClient().submit(record);
        var newState = normState((resp && resp.state) || target);
        rvStatus[id] = {
          state: newState,
          comment: record.comment || '',
          actor: (resp && resp.actor) || record.actor || '',
          updated_at: (resp && resp.updated_at) || '',
        };
      } catch (err) {
        rvDecErr[id] = (err && err.message) ? err.message : String(err);
      } finally {
        rvBusy[id] = false;
        rerender();
      }
      return rvStatus[id];
    }

    /* Delegated click handling for the approve/decline controls. Bound ONCE on the stable
     * rev-body container (survives re-renders), so no per-render rebinding. Walks up from
     * the click target to the nearest [data-rev-action] control and reads the sibling
     * comment. */
    function onDecisionClick(e) {
      var el = e && (e.target || e.srcElement);
      var action = null, id = null;
      while (el && el !== document) {
        if (el.getAttribute) {
          var a = el.getAttribute('data-rev-action');
          if (a) { action = a; id = el.getAttribute('data-bundle-id'); break; }
        }
        el = el.parentNode;
      }
      if (!action || !id) return;
      if (e && e.preventDefault) e.preventDefault();
      if (action === 'approve') {
        submitDecision(id, 'approved', null);
      } else if (action === 'decline') {
        var box = document.getElementById('rev-comment-' + id);
        submitDecision(id, 'declined', box ? box.value : null);
      }
    }

    /* ---- generation-date filter ---- */

    /* Populate the generation dropdown with the distinct discovered dates (newest first)
     * and default the selection to the most recent, then bind the change listener. Mirrors
     * f10-weekly's initGroupFilters pattern. Called once during load, after discovery, so
     * the select DOM element (built in panelMarkup) already exists. Defensive for the
     * minimal DOM stubs used in tests: it still sets the default rvDate, and only touches
     * the select when createElement / appendChild are available. */
    function initDateFilter() {
      var dates = distinctDates();
      if (!rvDate && dates.length) rvDate = dates[0];   // default to the most recent date
      var sel = document.getElementById('rev-date');
      if (!sel || typeof document.createElement !== 'function' || typeof sel.appendChild !== 'function') return;
      sel.innerHTML = '';
      dates.forEach(function (d) {
        var o = document.createElement('option');
        o.value = d;
        o.textContent = d || 'All';
        if (d === rvDate) o.selected = true;
        sel.appendChild(o);
      });
      if (sel.addEventListener) sel.addEventListener('change', onDateChange);
    }

    /* The generation-date selection changed: re-filter the visible bundles and re-render. */
    function onDateChange(e) {
      var v = (e && e.target && e.target.value != null) ? e.target.value : rvDate;
      setDate(v);
    }

    function setDate(d) {
      rvDate = String(d == null ? '' : d);
      if (window.F10A) F10A.track('filter_changed', { filter: 'generation_date', value: rvDate });
      rerender();
    }

    /* ---- tab activation (via the single generic dispatcher) ---- */

    function activate() {
      if (typeof f10ActivateTab === 'function') {
        f10ActivateTab({ panelId: 'panel-review', navLink: rvNavLink, title: 'Creative Review' });
      } else {
        // Defensive fallback if the layout dispatcher is unavailable: same generic clear.
        var links = document.querySelectorAll ? document.querySelectorAll('#sidebar nav a') : [];
        Array.prototype.forEach.call(links, function (l) { if (l.classList) l.classList.remove('active'); });
        var panels = document.querySelectorAll ? document.querySelectorAll('.tab-panel') : [];
        Array.prototype.forEach.call(panels, function (p) { if (p.classList) p.classList.remove('active'); });
        var panel = document.getElementById('panel-review'); if (panel) panel.classList.add('active');
        if (rvNavLink && rvNavLink.classList) rvNavLink.classList.add('active');
        var t = document.getElementById('page-title'); if (t) t.textContent = 'Creative Review';
      }
      if (window.F10A) F10A.track('tab_viewed', { tab: 'review', tab_label: 'Creative Review' });
      if (!rvLoaded) { rvLoaded = true; loadReview(); }
    }

    /* When any OTHER nav link is clicked, drop this tab's active state so only one
     * section ever shows. Bound generically to every sibling nav anchor - no per-module
     * class list - so a future tab needs no edit here either. */
    function deactivateOnOtherNav() {
      var panels = document.querySelectorAll ? document.querySelectorAll('.review-tab-panel') : [];
      Array.prototype.forEach.call(panels, function (p) { if (p.classList) p.classList.remove('active'); });
      var links = document.querySelectorAll ? document.querySelectorAll('.review-nav-link') : [];
      Array.prototype.forEach.call(links, function (l) { if (l.classList) l.classList.remove('active'); });
    }

    /* ---- panel + nav markup (self-contained; the module injects its own) ---- */

    function navLinkHtml() {
      return '<a href="#" class="review-nav-link" data-review-tab="review">Review</a>';
    }

    function panelMarkup() {
      return '<div class="tab-panel review-tab-panel" id="panel-review">'
        + '<style id="rev-styles">'
        + '#panel-review .rev-insight{background:rgba(0,0,0,0.03);border-left:3px solid var(--brand,#7a1f2b);'
        + 'padding:10px 14px;margin:0 0 18px;font-size:13px;line-height:1.5;border-radius:4px;}'
        + '#panel-review .rev-bundle{border:1px solid rgba(0,0,0,0.1);border-radius:8px;padding:16px;margin:0 0 22px;}'
        + '#panel-review .rev-bundle-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:0 0 10px;}'
        + '#panel-review .rev-bundle-title{font-size:15px;font-weight:700;}'
        + '#panel-review .rev-bundle-id{font-family:monospace;font-size:12px;color:#777;}'
        + '#panel-review .rev-metric-note{margin-left:auto;font-size:12px;color:#555;background:#eee;padding:2px 8px;border-radius:10px;}'
        + '#panel-review .rev-flags{font-size:12px;margin:0 0 14px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}'
        + '#panel-review .rev-flags-label{font-weight:600;color:#555;}'
        + '#panel-review .rev-held-label{margin-left:10px;}'
        + '#panel-review .rev-flag{background:#fff3d6;color:#8a5a00;padding:2px 8px;border-radius:10px;font-weight:600;}'
        + '#panel-review .rev-held{background:#e7eefc;color:#274690;padding:2px 8px;border-radius:10px;font-weight:600;}'
        + '#panel-review .rev-grid{display:grid;grid-template-columns:minmax(200px,1fr) minmax(260px,2fr);gap:18px;}'
        + '#panel-review .rev-col-head{font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#777;margin:0 0 8px;font-weight:700;}'
        + '#panel-review .rev-img{display:block;width:100%;max-width:260px;border-radius:6px;border:1px solid rgba(0,0,0,0.1);background:#fafafa;}'
        + '#panel-review .rev-img-empty,#panel-review .rev-img-link{display:flex;align-items:center;justify-content:center;min-height:120px;'
        + 'font-size:12px;color:#888;text-decoration:none;padding:8px;text-align:center;}'
        + '#panel-review .rev-img-link{color:var(--brand,#7a1f2b);font-weight:600;}'
        + '#panel-review .rev-kvs{margin-top:10px;font-size:12px;}'
        + '#panel-review .rev-kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid rgba(0,0,0,0.06);}'
        + '#panel-review .rev-k{color:#777;}'
        + '#panel-review .rev-v{font-weight:600;text-align:right;}'
        + '#panel-review .rev-copy{margin-top:10px;font-size:12px;color:#444;}'
        + '#panel-review .rev-copy-line{margin:2px 0;}'
        + '#panel-review .rev-muted{color:#999;}'
        + '#panel-review .rev-bundle-error{border-color:#e3a9b6;}'
        + '#panel-review .rev-err,#panel-review .rev-error-detail{color:#a3243c;font-size:12px;margin-top:6px;word-break:break-word;}'
        + '#panel-review .rev-error{background:#fbe6ea;border:1px solid #e3a9b6;color:#a3243c;padding:14px 16px;border-radius:6px;}'
        + '#panel-review .rev-decision{margin-top:16px;padding-top:14px;border-top:1px solid rgba(0,0,0,0.08);}'
        + '#panel-review .rev-decision-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px;font-size:13px;}'
        + '#panel-review .rev-decision-label{font-weight:700;color:#555;}'
        + '#panel-review .rev-state{padding:2px 10px;border-radius:10px;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.03em;}'
        + '#panel-review .rev-state-pending{background:#eee;color:#666;}'
        + '#panel-review .rev-state-approved{background:#e2f3e6;color:#1c6b34;}'
        + '#panel-review .rev-state-declined{background:#fbe6ea;color:#a3243c;}'
        + '#panel-review .rev-state-note{font-size:12px;color:#777;}'
        + '#panel-review .rev-decision-actions{margin-left:auto;display:flex;gap:8px;align-items:center;}'
        + '#panel-review .rev-btn{font:inherit;font-size:13px;font-weight:600;padding:6px 14px;border-radius:6px;border:1px solid rgba(0,0,0,0.15);cursor:pointer;background:#fff;}'
        + '#panel-review .rev-btn[disabled]{opacity:0.5;cursor:default;}'
        + '#panel-review .rev-approve{border-color:#1c6b34;color:#1c6b34;}'
        + '#panel-review .rev-approve[aria-pressed="true"]{background:#1c6b34;color:#fff;}'
        + '#panel-review .rev-decline{border-color:#a3243c;color:#a3243c;}'
        + '#panel-review .rev-decline[aria-pressed="true"]{background:#a3243c;color:#fff;}'
        + '#panel-review .rev-decision-comment{margin-top:8px;}'
        + '#panel-review .rev-comment{width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:6px 8px;border:1px solid rgba(0,0,0,0.15);border-radius:6px;resize:vertical;min-height:32px;}'
        + '#panel-review .rev-dec-busy{font-size:12px;color:#777;}'
        + '#panel-review .rev-dec-err{color:#a3243c;font-size:12px;margin-top:6px;word-break:break-word;}'
        + '#panel-review .rev-refine-note{margin-top:8px;font-size:12px;color:#777;font-style:italic;}'
        // ---- ranked scorecard grid (roadmap #5) ----
        + '#panel-review .rev-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;align-items:start;}'
        + '#panel-review .rev-card{border:1px solid rgba(0,0,0,0.1);border-radius:8px;padding:14px;display:flex;flex-direction:column;}'
        + '#panel-review .rev-card-unscored{border-style:dashed;}'
        + '#panel-review .rev-card-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:0 0 10px;}'
        + '#panel-review .rev-rank{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#555;background:#eee;padding:2px 8px;border-radius:10px;}'
        + '#panel-review .rev-rank-unscored{color:#888;background:#f3f3f3;}'
        + '#panel-review .rev-card-title{font-size:14px;font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
        + '#panel-review .rev-card-id{font-family:monospace;font-size:11px;color:#999;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
        + '#panel-review .rev-card-thumb-wrap{margin:0 0 12px;}'
        + '#panel-review .rev-card-thumb{max-width:100%;}'
        + '#panel-review .rev-scorecard{margin:0 0 12px;}'
        + '#panel-review .rev-overall{display:flex;align-items:center;gap:8px;margin:0 0 10px;}'
        + '#panel-review .rev-overall-badge{font-size:12px;font-weight:800;letter-spacing:0.05em;padding:3px 10px;border-radius:6px;}'
        + '#panel-review .rev-overall-pass{background:#e2f3e6;color:#1c6b34;}'
        + '#panel-review .rev-overall-flag{background:#fbe6ea;color:#a3243c;}'
        + '#panel-review .rev-overall-na{background:#eee;color:#666;}'
        + '#panel-review .rev-overall-score{font-size:18px;font-weight:800;color:#222;}'
        + '#panel-review .rev-dims{font-size:12px;margin:0 0 10px;}'
        + '#panel-review .rev-dim{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(0,0,0,0.06);}'
        + '#panel-review .rev-dim-label{color:#555;flex:1;}'
        + '#panel-review .rev-dim-val{font-weight:700;color:#222;}'
        + '#panel-review .rev-chip{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;padding:1px 7px;border-radius:8px;}'
        + '#panel-review .rev-chip-pass{background:#e2f3e6;color:#1c6b34;}'
        + '#panel-review .rev-chip-flag{background:#fbe6ea;color:#a3243c;}'
        + '#panel-review .rev-chip-na{background:#eee;color:#888;}'
        + '#panel-review .rev-scorecard-flags{font-size:12px;color:#8a5a00;margin:0;padding-left:18px;}'
        + '#panel-review .rev-scorecard-flags-none{padding-left:0;color:#999;}'
        + '#panel-review .rev-scorecard-note{font-size:12px;margin-top:6px;}'
        // ---- generation-date filter ----
        + '#panel-review .rev-controls{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 16px;}'
        + '#panel-review .rev-controls .ctrl{display:flex;flex-direction:column;gap:4px;}'
        + '#panel-review .rev-controls label{font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#777;font-weight:700;}'
        + '#panel-review .rev-controls select{font:inherit;font-size:13px;padding:6px 10px;border:1px solid rgba(0,0,0,0.15);border-radius:6px;background:#fff;}'
        + '</style>'
        + '<div class="rev-insight"><strong>Creative Review:</strong> the generated ads for this client are '
        + 'auto-discovered and triaged as a ranked grid of scorecards, best-first - each card carries its coherence '
        + 'scorecard (an overall pass / flag verdict and score, plus client-fit, component-fidelity and '
        + 'brand-compliance dimensions), so the strongest concepts surface at a glance and unscored bundles fall to '
        + 'the end. Use the Generation dropdown to switch between generation runs; it opens on the most recent. '
        + 'Each ad has a coarse approve / decline gate: approve marks the bundle servable, decline records a reason '
        + 'and marks it not-servable. Refinement then happens with the designer in Figma after approval - there is no '
        + 'regenerate or re-prompt loop here.</div>'
        + '<div class="rev-controls">'
        + '<div class="ctrl"><label for="rev-date">Generation</label>'
        + '<select id="rev-date"></select></div>'
        + '</div>'
        + '<div id="rev-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>'
        + '<div id="rev-error" class="rev-error" style="display:none;"></div>'
        + '<div id="rev-body" style="display:none;"></div>'
        + '</div>';
    }

    /* Inject the nav section + link and the panel, then wire activation through the
     * generic dispatcher. Only ever called once per boot, after discovery finds bundles. */
    function registerTab() {
      var nav = document.querySelector('#sidebar nav');
      var content = document.getElementById('content');
      if (!nav || !content) return;
      nav.insertAdjacentHTML('beforeend', '<div class="nav-section">Creative Review</div>');
      nav.insertAdjacentHTML('beforeend', navLinkHtml());
      content.insertAdjacentHTML('beforeend', panelMarkup());
      rvNavLink = document.querySelector('.review-nav-link');
      if (rvNavLink && rvNavLink.addEventListener) {
        rvNavLink.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); activate(); });
      }
      // Bind the approve/decline delegation ONCE on the stable rev-body container so it
      // survives every re-render (renderBundles only swaps the container's innerHTML).
      var body = document.getElementById('rev-body');
      if (body && body.addEventListener) body.addEventListener('click', onDecisionClick);
      // Bind the deactivate handler to every OTHER existing nav anchor - generic, no
      // hard-coded class list - so this never needs editing when tabs are added.
      var others = document.querySelectorAll ? document.querySelectorAll('#sidebar nav a') : [];
      Array.prototype.forEach.call(others, function (a) {
        if (a === rvNavLink || !a.addEventListener) return;
        a.addEventListener('click', deactivateOnOtherNav);
      });
    }

    /* ---- boot ----
     * Called by the one-line addition to the tail of renderLayout() in f10-layout.js and
     * (idempotently) on DOMContentLoaded. Two gates, both fail closed:
     *   - live-path safety: no client, or NO BQ endpoint AND no injected store => silent
     *     no-op, zero DOM trace, no network (this is what protects a host with no backend);
     *   - discovery: the module asks list-bundles which bundles exist for this client and
     *     only injects the tab when at least one is discovered; a discovery error fails
     *     closed (no tab, no empty state). */
    async function initReview() {
      if (rvBooted) return;
      rvBooted = true;
      rvClient = clientKey();
      if (!rvClient) return;                       // no client -> silent no-op
      if (typeof BQ_FUNCTION === 'undefined' || !BQ_FUNCTION) {
        if (!rvStore) return;                      // no endpoint and no injected store -> no-op, zero trace
      }
      try {
        var list = await discoverBundles();
        if (list && list.length >= 1) registerTab();
      } catch (err) {
        // Fail closed: log once, no tab, no empty state.
        if (window.console && console.warn) {
          console.warn('Creative Review discovery error:', err && err.message ? err.message : err);
        }
      }
    }

    window.initReview = initReview;

    /* Self-boot without requiring an f10-layout.js edit. renderLayout() also calls
     * initReview() at its tail; the rvBooted guard makes the double call idempotent, so a
     * dashboard pinned to an older layout tag still gets the tab. */
    (function autoBoot() {
      var run = function () { initReview(); };
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        if (typeof setTimeout === 'function') setTimeout(run, 0);
      } else if (document.addEventListener) {
        document.addEventListener('DOMContentLoaded', function () {
          if (typeof setTimeout === 'function') setTimeout(run, 0); else run();
        });
      }
    })();

    /* Test surface (US-007): expose the internals so the acceptance test can exercise
     * discovery, registration, activation and render without a full dashboard boot.
     * Production paths do not read these. */
    window.f10Review = {
      initReview: initReview,
      registerTab: registerTab,
      activate: activate,
      deactivateOnOtherNav: deactivateOnOtherNav,
      load: loadReview,
      loadBundle: loadBundle,
      discoverBundles: discoverBundles,
      renderBundles: renderBundles,
      renderError: renderError,
      bundleHtml: bundleHtml,
      newAdHtml: newAdHtml,
      panelMarkup: panelMarkup,
      navLinkHtml: navLinkHtml,
      clientKey: clientKey,
      getBundles: getBundles,
      flagText: flagText,
      // Scored batch review / ranked grid (roadmap #5)
      scorecardHtml: scorecardHtml,
      cardHtml: cardHtml,
      gridHtml: gridHtml,
      detailHtml: detailHtml,
      sortForGrid: sortForGrid,
      isScored: isScored,
      fetchCoherence: fetchCoherence,
      // Generation-date filter
      dates: distinctDates,
      getDate: function () { return rvDate; },
      setDate: setDate,
      onDateChange: onDateChange,
      // US-009 approve/decline surface
      decisionHtml: decisionHtml,
      submitDecision: submitDecision,
      onDecisionClick: onDecisionClick,
      approve: function (id) { return submitDecision(id, 'approved', null); },
      decline: function (id, comment) { return submitDecision(id, 'declined', comment); },
      statusOf: statusOf,
      isBusy: function (id) { return !!rvBusy[id]; },
      decisionError: function (id) { return rvDecErr[id] || ''; },
      setStore: function (s) { rvStore = s; },
      setBundles: function (b) { rvBundles = Array.isArray(b) ? b.map(normalizeDiscovered).filter(function (x) { return !!x; }) : b; },
      setFeedbackClient: function (fc) { rvFeedback = fc; },
      setClient: function (c) { rvClient = c; },
      getClient: function () { return rvClient; },
      isLoaded: function () { return rvLoaded; },
      _resetBooted: function () { rvBooted = false; rvLoaded = false; },
      _resetState: function () { rvStatus = {}; rvBusy = {}; rvDecErr = {}; rvResults = []; rvDate = ''; },
    };
  })();
}
