/**
 * f10-review.js - F10 Creative Review tab (probe-gated, live-path safe, US-007;
 *                 approve/decline gate + approval state, US-009)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@TAG/f10-review.js"></script>
 *
 * WHAT IT SHOWS: the interactive preview surface for the creative pipeline. For each
 * newly GENERATED ad (a "bundle" under review) it renders that ad next to the client's
 * WINNING historical ads and their policy metric, plus the concept-in-context read, so
 * an F10 reviewer can judge a new concept against what already works for the client
 * without waiting on a static report. Every winner + metric + comparison comes from the
 * US-006 `winning-historical` bq action (strictly per-client); the new ad's own preview
 * image comes from the US-005 `generated-preview` action. The bundle's coherence flags
 * and held dimensions ride alongside so the reviewer sees any held dimensions in context.
 *
 * VISIBILITY IS DATA-DRIVEN AND LIVE-PATH SAFE - two gates, both fail closed:
 *   1. CONFIG GATE (live-path safety). The module reads its bundles-under-review from
 *      the optional `REVIEW` config block (or an injected store). A dashboard that
 *      carries NO `REVIEW` config - which is every live client growth/creative
 *      dashboard today - short-circuits to a silent no-op: no probe, no network, no nav
 *      link, no panel, ZERO DOM trace. This is what keeps the module STRICTLY ADDITIVE:
 *      an existing dashboard cannot be altered by a module it never configures.
 *   2. DATA PROBE GATE (US-007 AC1). Even with bundles configured, the module first runs
 *      the cheap `winning-historical` existence probe. Only when the client actually has
 *      review data does it inject its "Creative Review" nav section, "Review" nav link
 *      and panel. A client with no review data, or ANY probe error (endpoint down, mart
 *      not built), shows NO tab and leaves zero trace - it fails closed, never a broken
 *      or empty tab.
 *
 * TAB ACTIVATION: selecting the tab goes through the single generic dispatcher
 * f10ActivateTab() (f10-layout.js), which clears EVERY nav link and EVERY panel before
 * activating the selected pair. The module never hard-codes any other tab's classes, so
 * adding it required editing no existing module and two panels can never show at once.
 *
 * DISPATCH: f10-layout.js calls window.initReview() at the tail of renderLayout() (the
 * same unconditional, probe-decides pattern as initComponents). The module ALSO
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
 * client dashboards never define it.
 *   const REVIEW = {
 *     CLIENT: 'moshy',          // optional; override the f10 client slug when DATASET
 *                               // does not follow the {client}_marts / {client}_clean convention
 *     ACTOR: 'zac@f10',         // optional; who is recording the decision. Behind the F10 gate
 *                               // the endpoint stamps the authenticated actor, so this is optional.
 *     LIMIT: 5,                 // optional; winners per bundle to request (server caps at 25)
 *     BUNDLES: [                // the generated ads to review, from the operator's run
 *       {
 *         bundle_id: 'brief_moshy_founder_ab12cd',
 *         platform: 'meta',                       // optional; defaults to meta
 *         label: 'Founder story - bold typographic', // optional display label
 *         components: { hook_type: 'Founder story', format_canonical: 'UGC video' },
 *         coherence_flags: ['visual_style held for review'],
 *         held_dimensions: ['visual_style_canonical'],
 *         new_ad: { headline: '...', body: '...' } // optional copy metadata
 *       }
 *     ]
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
    var rvBundles = null;    // injectable bundle list (tests override via setBundles)
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

    /* The winner's graded metric, formatted by the policy metric_type the action set
     * (never chosen here). ROAS clients read the roas value; every other (lead-gen)
     * client reads CPA. Never invents a number. */
    function fmtMetric(w) {
      var type = w && w.metric_type;
      var v = num(w && w.metric_value);
      if (type === 'roas') return v == null ? 'n/a' : v.toFixed(2) + 'x ROAS';
      return v == null ? 'n/a' : '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' CPA';
    }

    function fmtInt(v) {
      var n = num(v);
      return n == null ? '0' : Math.round(n).toLocaleString();
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

    /* The bundles-under-review for this client. Tests inject via setBundles; production
     * reads REVIEW.BUNDLES. An empty list is the live-path-safety short-circuit: with no
     * bundles there is nothing to review, so the module never probes and never registers. */
    function getBundles() {
      var list = rvBundles || (Array.isArray(CFG.BUNDLES) ? CFG.BUNDLES : []);
      return Array.isArray(list) ? list.filter(function (b) { return b && (b.bundle_id || b.bundleId); }) : [];
    }

    function bundleId(b) {
      return (b && (b.bundle_id || b.bundleId)) ? String(b.bundle_id || b.bundleId) : '';
    }
    function bundlePlatform(b) {
      return (b && b.platform === 'tiktok') ? 'tiktok' : 'meta';
    }

    /* ---- data store (injectable; default posts to the shared bq function) ---- */

    /* The default store posts { action, ... } to BQ_FUNCTION, mirroring runQuery's
     * fetch convention, and fails closed on a non-ok response. Overridable for tests
     * and for a future backend wiring via setStore. Three reads:
     *   probe(client)                     -> boolean  (winning-historical { probe:true })
     *   winners(client, bundle)           -> payload  (winning-historical join, US-006)
     *   preview(client, bundleId, plat)   -> { url }  (generated-preview, US-005)
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
        async probe(client) {
          var r = await call({ action: 'winning-historical', client: client, probe: true });
          return !!(r && r.exists);
        },
        async winners(client, bundle) {
          return call({
            action: 'winning-historical',
            client: client,
            bundle: bundle,
            newAd: (bundle && bundle.new_ad) || null,
            limit: CFG.LIMIT || 5,
          });
        },
        async preview(client, id, platform) {
          return call({ action: 'generated-preview', client: client, bundleId: id, platform: platform });
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

    /* One winning historical ad: its signed preview image (or a click-through link when
     * the asset was never fetched), name, policy metric, spend and conversions. */
    function winnerHtml(w) {
      var img;
      if (w.image_url) {
        img = '<img class="rev-img" src="' + esc(w.image_url) + '" alt="Winning ad preview" loading="lazy" />';
      } else if (w.creative_link) {
        img = '<a class="rev-img rev-img-link" href="' + esc(w.creative_link) + '" target="_blank" rel="noopener">View on Meta</a>';
      } else {
        img = '<div class="rev-img rev-img-empty">No preview</div>';
      }
      var name = w.ad_name != null && w.ad_name !== '' ? w.ad_name : String(w.ad_id || '');
      return '<div class="rev-winner">'
        + img
        + '<div class="rev-winner-name" title="' + esc(name) + '">' + esc(name) + '</div>'
        + '<div class="rev-metric">' + esc(fmtMetric(w)) + '</div>'
        + '<div class="rev-sub">' + esc(fmtInt(w.conversions)) + ' conv'
        + (num(w.spend) != null ? ' &middot; $' + fmtInt(w.spend) + ' spend' : '') + '</div>'
        + '</div>';
    }

    /* The insight-ladder L4/L5 read the US-006 action already composed: so-what (the
     * concept reuses proven winners) and now-what (unproven dimensions to hold and test).
     * Rendered verbatim off the action's comparison block so the UI never re-derives it. */
    function comparisonHtml(cmp) {
      if (!cmp) return '';
      var so = cmp.so_what ? '<div class="rev-sowhat"><strong>So what:</strong> ' + esc(cmp.so_what) + '</div>' : '';
      var now = cmp.now_what ? '<div class="rev-nowhat"><strong>Now what:</strong> ' + esc(cmp.now_what) + '</div>' : '';
      if (!so && !now) return '';
      return '<div class="rev-compare">' + so + now + '</div>';
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

    /* One bundle-under-review block: the new ad beside the client's winners, the metric
     * policy note, the coherence flags / held dimensions, and the so-what/now-what read.
     * Coherence flags come from BOTH the bundle config and the action's echoed comparison
     * so a held dimension shows even if only one side carried it. */
    function bundleHtml(bundle, payload, previewUrl, previewReason) {
      var winners = (payload && Array.isArray(payload.winners)) ? payload.winners : [];
      var cmp = payload && payload.comparison;
      var id = bundleId(bundle);
      var label = (bundle && bundle.label) ? bundle.label : id;

      var cohFlags = (bundle && bundle.coherence_flags) || (cmp && cmp.coherence_flags) || [];
      var held = (bundle && bundle.held_dimensions) || (cmp && cmp.held_dimensions) || [];
      var flagsRow = '<div class="rev-flags">'
        + '<span class="rev-flags-label">Coherence flags:</span> '
        + flagBadges(cohFlags, 'rev-flag', 'none')
        + '<span class="rev-flags-label rev-held-label">Held for testing:</span> '
        + flagBadges(held, 'rev-held', 'none')
        + '</div>';

      var winnersInner = winners.length
        ? winners.map(winnerHtml).join('')
        : '<div class="rev-muted">No winning historical ads for this client yet.</div>';

      var metricNote = (payload && payload.metric)
        ? '<span class="rev-metric-note">Metric: ' + esc(String(payload.metric).toUpperCase()) + '</span>'
        : '';

      return '<div class="rev-bundle" data-bundle-id="' + esc(id) + '">'
        + '<div class="rev-bundle-head"><span class="rev-bundle-title">' + esc(label) + '</span>'
        + '<span class="rev-bundle-id">' + esc(id) + '</span>' + metricNote + '</div>'
        + flagsRow
        + '<div class="rev-grid">'
        + newAdHtml(bundle, previewUrl, previewReason)
        + '<div class="rev-winners"><div class="rev-col-head">Client winners</div>'
        + '<div class="rev-winners-list">' + winnersInner + '</div></div>'
        + '</div>'
        + comparisonHtml(cmp)
        + decisionHtml(bundle)
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

    /* Render every bundle block into the panel. A single bundle's read failure degrades
     * to a per-bundle error card, never a blank panel: the reviewer still sees the rest. */
    function renderBundles(results) {
      rvResults = Array.isArray(results) ? results : [];
      var body = document.getElementById('rev-body');
      if (body) {
        body.innerHTML = rvResults.map(function (r) {
          if (r.error) {
            return '<div class="rev-bundle rev-bundle-error"><div class="rev-bundle-head">'
              + '<span class="rev-bundle-title">' + esc(r.label || bundleId(r.bundle)) + '</span></div>'
              + '<div class="rev-err">Could not load this bundle: ' + esc(r.error) + '</div></div>';
          }
          return bundleHtml(r.bundle, r.payload, r.previewUrl, r.previewReason);
        }).join('');
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

    /* For one bundle, fetch the winners join (US-006) and the new ad's preview image
     * (US-005) in parallel. Each side is independently caught: a preview miss still shows
     * the winners, and a winners failure marks just this bundle as errored. */
    async function loadBundle(bundle) {
      var id = bundleId(bundle);
      var label = (bundle && bundle.label) ? bundle.label : id;
      var st = store();
      var payloadP = st.winners(rvClient, bundle);
      var previewP = st.preview(rvClient, id, bundlePlatform(bundle)).catch(function () { return null; });
      // Read the persisted decision back from the feedback/status source (US-009 AC3) in
      // parallel; a miss (or a read path not yet deployed) is simply "pending". The read is
      // authoritative on load, so reloading the surface always reflects the stored state.
      var statusP = feedbackClient().read(rvClient, id, bundlePlatform(bundle)).catch(function () { return null; });
      var persisted = await statusP;
      rvStatus[id] = (persisted && persisted.state)
        ? { state: normState(persisted.state), comment: persisted.comment || '', actor: persisted.actor || '', updated_at: persisted.updated_at || '' }
        : { state: 'pending', comment: '', actor: '', updated_at: '' };
      rvDecErr[id] = '';
      try {
        var payload = await payloadP;
        var preview = await previewP;
        return {
          bundle: bundle,
          label: label,
          payload: payload,
          previewUrl: (preview && preview.url) || null,
          previewReason: (preview && !preview.url) ? (preview.reason || '') : '',
        };
      } catch (err) {
        return { bundle: bundle, label: label, error: (err && err.message) ? err.message : String(err) };
      }
    }

    async function loadReview() {
      showEl('rev-loading');
      hideEl('rev-body');
      hideEl('rev-error');
      try {
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
     * rev-body container (survives re-renders), so no per-render rebinding. Walks up from the
     * click target to the nearest [data-rev-action] control and reads the sibling comment. */
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
        + '#panel-review .rev-winners-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px;}'
        + '#panel-review .rev-winner{font-size:12px;}'
        + '#panel-review .rev-winner .rev-img{max-width:100%;min-height:90px;}'
        + '#panel-review .rev-winner-name{font-weight:600;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
        + '#panel-review .rev-metric{color:#1c6b34;font-weight:700;margin-top:2px;}'
        + '#panel-review .rev-sub{color:#777;}'
        + '#panel-review .rev-compare{margin-top:14px;background:rgba(0,0,0,0.03);border-left:3px solid var(--brand,#7a1f2b);'
        + 'padding:10px 14px;border-radius:4px;font-size:13px;line-height:1.5;}'
        + '#panel-review .rev-nowhat{margin-top:6px;}'
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
        + '</style>'
        + '<div class="rev-insight"><strong>Creative Review:</strong> each newly generated ad shown next to '
        + 'this client\'s winning historical ads and their metric, so a concept is judged in context - not in a '
        + 'static report. The so-what / now-what read compares the concept to what already works; coherence flags '
        + 'and held dimensions are shown alongside so any held axis is visible before approval. '
        + 'Each ad has a coarse approve / decline gate: approve marks the bundle servable, decline records a reason '
        + 'and marks it not-servable. Refinement then happens with the designer in Figma after approval - there is no '
        + 'regenerate or re-prompt loop here.</div>'
        + '<div id="rev-loading" class="loading"><div class="spinner"></div>Loading&hellip;</div>'
        + '<div id="rev-error" class="rev-error" style="display:none;"></div>'
        + '<div id="rev-body" style="display:none;"></div>'
        + '</div>';
    }

    /* Inject the nav section + link and the panel, then wire activation through the
     * generic dispatcher. Only ever called once per boot, after a passing probe. */
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
     *   - live-path safety: no client, no BQ endpoint, or NO configured bundles => silent
     *     no-op, zero DOM trace, no network (this is what protects live dashboards);
     *   - data probe: only when the client actually has review data is the tab injected;
     *     any probe error fails closed (no tab, no empty state). */
    async function initReview() {
      if (rvBooted) return;
      rvBooted = true;
      rvClient = clientKey();
      if (!rvClient) return;                       // no client -> silent no-op
      if (typeof BQ_FUNCTION === 'undefined' || !BQ_FUNCTION) {
        if (!rvStore) return;                      // no endpoint and no injected store -> no-op
      }
      if (!getBundles().length) return;            // no bundles to review -> live-path-safe no-op (no probe)
      try {
        var ok = await store().probe(rvClient);
        if (ok === true) registerTab();
      } catch (err) {
        // Fail closed: log once, no tab, no empty state.
        if (window.console && console.warn) {
          console.warn('Creative Review visibility probe error:', err && err.message ? err.message : err);
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
     * registration, probe gating, activation and render without a full dashboard boot.
     * Production paths do not read these. */
    window.f10Review = {
      initReview: initReview,
      registerTab: registerTab,
      activate: activate,
      deactivateOnOtherNav: deactivateOnOtherNav,
      load: loadReview,
      loadBundle: loadBundle,
      renderBundles: renderBundles,
      renderError: renderError,
      bundleHtml: bundleHtml,
      newAdHtml: newAdHtml,
      winnerHtml: winnerHtml,
      comparisonHtml: comparisonHtml,
      panelMarkup: panelMarkup,
      navLinkHtml: navLinkHtml,
      clientKey: clientKey,
      getBundles: getBundles,
      fmtMetric: fmtMetric,
      flagText: flagText,
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
      setBundles: function (b) { rvBundles = b; },
      setFeedbackClient: function (fc) { rvFeedback = fc; },
      setClient: function (c) { rvClient = c; },
      getClient: function () { return rvClient; },
      isLoaded: function () { return rvLoaded; },
      _resetBooted: function () { rvBooted = false; rvLoaded = false; },
      _resetState: function () { rvStatus = {}; rvBusy = {}; rvDecErr = {}; rvResults = []; },
    };
  })();
}
