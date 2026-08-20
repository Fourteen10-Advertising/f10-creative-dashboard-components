# f10-creative-dashboard-components

Shared CSS and JavaScript for F10 Netlify creative dashboards. Loaded by each dashboard via jsDelivr CDN — no build step required.

A dashboard is now just a config block plus script tags: the markup, styling, and all logic come from this library. The fastest way to start a new one is to copy the [`starter/`](./starter) folder.

## Files

| File | Purpose |
|---|---|
| `f10-shared.css` | All shared styles: layout, sidebar, controls bar, scorecards, badges, tables, charts |
| `f10-utils.js` | Formatters, constants (METRICS, STATE_META, thresholds), `classify()`, aggregation helpers, group/status filter helpers (`scopeWhere()`), ad-name search (`adNameAttr`, `filterRowsBySearch`, `refilterAllTables`), `scatterMaxSpend()` |
| `f10-weekly.js` | Weekly engine: fetchWindows, renderSummary/Board/Map, tab system, group filters, wireControls, initWeekly |
| `f10-monthly.js` | Monthly engine: loadPowerLaw/Production/Decay/Age/CreativeEffectiveness (video-only: static images excluded) + the `loadMonthlyTab()` dispatcher. All SQL is shared and config-driven |
| `f10-layout.js` | `renderLayout()` — builds the sidebar, controls bar, and all seven tab panels into `<div id="app"></div>`. Production benchmark copy is derived from the threshold constants |
| `f10-preview.js` | Inline creative hover previews for `.preview-link` targets; renders a swipeable carousel when an ad has multiple cards. Exposes `f10MediaMarkup({type,url}, opts)` — the shared `<img>`/`<video>` builder reused by the competitor tab — plus `f10PreviewCards(media)` and `f10CarouselHtml(cards, idx)` |
| `f10-competitors.js` | Competitor Ad Library tab (probe-driven: appears automatically when the client has competitor rows in `all_clients_adlib`): groups a client's tracked competitor Meta ads by competitor in the F10 card layout, with Status / Timeframe / Competitor filters, per-competitor pagination (20/page), and a metadata + on-demand creatives split that fetches only the visible page's signed media. Reuses `f10MediaMarkup` from `f10-preview.js` |
| `f10-components.js` | Component Scale tab (probe-driven: appears automatically when the client has a `{client}_marts.component_performance` mart): grades the five creative components (hook, format, CTA, message angle, visual style) against the client's own baseline, with lift, evidence count, confidence tier, the verbatim descriptive caveat, and a co-occurrence mark; plus the cross-client whitespace lane as a separate, clearly-labelled hypotheses section. Adds `f10ActivateTab()` (in `f10-layout.js`) as the single generic tab dispatcher (see [Component Scale](#component-scale)) |
| `f10-brief-editor.js` | Brief Editor tab (probe-driven: appears only when the client has a saved brief revision to edit): a canonical-constrained editor for the F10 internal review app. Loads a brief revision and saves a NEW one via the US-003 persistence contract (GCS `brief-revisions/{client}/{id}.json` + a `brief_revisions` BigQuery row). The five creative axes (visual style, hook, message angle, CTA, format) are dropdowns locked to the canonical vocabularies, so a non-canonical value can never be saved; copy is free text. Dual-mode: the same file exports the persistence core behind an injectable writer seam for the brief backend (see [Brief editor](#brief-editor)) |
| `f10-review.js` | Creative Review tab (probe-gated AND live-path safe: appears only on the F10-internal review surface that carries a `REVIEW` config AND has review data). Renders each newly generated ad next to the client's winning historical ads and their policy metric (from the US-006 `winning-historical` action), the new ad's own preview image (from the US-005 `generated-preview` action), and the ad's coherence flags plus the so-what / now-what read. Strictly additive: a dashboard with no `REVIEW` config never probes and injects nothing (see [Creative review](#creative-review)) |

## How to use in a dashboard

The entire dashboard body is `<div id="app"></div>`. Define config, load the four scripts, then call `renderLayout(); wireControls(); initWeekly();`.

### 1. In `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.18.0/f10-shared.css" />
```

### 2. Body + scripts:

```html
<body>
<div id="app"></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
  /* CLIENT CONFIG — the only thing you edit per client */
  const BQ_FUNCTION = '/.netlify/functions/bq';
  const PROJECT     = 'mcc-poc-477801';
  const DATASET     = 'your_dataset';
  const TABLE       = 'meta_creative_reporting';
  const CONV_EXPR   = 'purchase'; /* or: '(customer_application_buying + broker_application_details)' */
  const CLIENT_NAME = 'Your Client';

  /* Optional target metric. Unset ⇒ CPA (cost-efficiency lens), backward-compatible
     with every existing dashboard. Set 'roas' for a revenue-return lens — only for
     purchase clients whose mart publishes a GATED revenue column. REVENUE_EXPR selects
     that column (default 'revenue'); raw conversion_value is forbidden by policy. */
  // const TARGET_METRIC = 'roas';
  // const REVENUE_EXPR  = 'revenue';

  /* Optional top-level segment filters. Each renders a dropdown in the controls
     bar (visible on every tab) and scopes every query. Values are populated
     dynamically (SELECT DISTINCT) and default to "All". Leave as [] for none. */
  const GROUP_FILTERS = [
    { col: 'campaign_group', label: 'Product / Group' },
    // { col: 'marketplace', label: 'Marketplace' },
  ];

  /* Optional per-client Ad Production thresholds — see "Thresholds" below. */
  // const THRESHOLDS = { HR_SPEND: 8000, HR_CPA: 90 };
</script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.18.0/f10-utils.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.18.0/f10-weekly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.18.0/f10-monthly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.18.0/f10-components.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.18.0/f10-layout.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.18.0/f10-preview.js"></script>
<script>
  renderLayout();
  wireControls();
  initWeekly();
  initPreview();
</script>
</body>
```

`initPreview()` turns every creative "View" / "Preview" link into a hover preview:
the real image (or autoplaying muted video) is pulled from F10's creative-asset
bucket via the `bq` function and shown in a floating card. Ads whose asset has not
been stored fall back to the existing click-through Facebook link, so nothing breaks
when a file is missing. The function signs a short-lived URL per asset, so the
dashboard's service account needs `roles/storage.objectViewer` on
`gs://f10-creative-assets`.

When an ad has more than one asset (a carousel, dynamic creative, or a rebrand
mid-flight), the `media` action returns **every** stored asset for the ad as an
ordered `cards` array — `{ [ad_id]: { type, url, cards: [{type,url}, …] } }`. Card 0
is the representative asset picked the same way the creative audit does
(`audit.py` / `sql/creative_band_mining.sql`): the asset delivering the most
impressions (dominant in the per-asset `image_asset_insights` / `video_asset_insights`
feeds) wins first, then the most recently created asset, then one already stored in
the bucket, then newest by created time. Ads with no per-asset delivery data fall
back to recency, so previews degrade gracefully as that feed's history accrues. The
top-level `type`/`url` mirror card 0, so any older caller reading a single asset is
unchanged.

When `cards` has more than one entry the hover box becomes a **swipeable carousel**:
it pins in place (so it stops following the cursor), turns on pointer events, and
shows prev/next arrows plus one dot per card and an N-of-M counter — the client can
step through every frame without leaving the dashboard. The carousel frame is a
fixed-size box (`object-fit: contain`) so a not-yet-loaded next card can't collapse
the pinned box out from under the cursor mid-swipe (which would otherwise fire a
`mouseleave` and close the preview). Single-card ads keep the original
cursor-following, click-through card. Regression coverage lives in
`test/carousel-preview.test.js` (backend card ordering + fallback, and the
`f10PreviewCards` / `f10CarouselHtml` builders).

`renderLayout()` generates all markup (including the `#ctrl-groups` / `#weekly-controls` containers), so dashboards no longer hand-maintain the HTML or the monthly loaders.

### Generated-ad preview resolver (`generated-preview` action)

Delivered ads resolve to a signed GCS URL through BigQuery by `ad_id` (the `media`
action). A GENERATED bundle from the creative pipeline is in no BigQuery table, so
the `bq` function exposes a net-new, bundle-keyed resolver for it:
`{ action:'generated-preview', client, bundleId, platform? }` returns a short-lived
(15-min) v4 signed READ url for that bundle's composed preview image, which the
pipeline publishes at `components/{platform}/{client}/{bundle_id}/composite.png` in
`gs://f10-creative-assets` at bundle publish time. `platform` defaults to `meta`.

Client scope is category-1: the composite path is keyed by the caller's `client`,
and a `bundleId` that provably encodes a different owner (pipeline brief ids are
`brief_{client}_{archetype}_{digest}`) is refused before any storage call, so a
caller for client A can neither name nor resolve client B's object. A foreign,
absent, or unsignable composite returns `{ url:null, reason }` and never throws or
leaks another client's data (`reason` is one of `client-scope-mismatch`,
`not-found`, `missing-client-or-bundle`, `unresolvable`, `error`). The read signs
with the GCS object-viewer service account only (a dedicated `GCS_OBJECT_VIEWER_SA`
when set, else the dashboard's `GOOGLE_SERVICE_ACCOUNT`, which holds
`roles/storage.objectViewer` on the bucket) and constructs no BigQuery client.
Regression coverage lives in `test/us-005-generated-preview.test.js`.

### New-ad vs winning-historical join (`winning-historical` action)

Puts a newly generated ad next to the client's proven winners so the review UI can
show new-vs-winners. `{ action:'winning-historical', client, bundleId, platform? }`
returns, for that client and bundle, the top-N winning historical ads from the
client's own marts (per-delivered-ad metrics plus the winning component scoreboard),
each with a signed preview image, and echoes the new generated ad alongside.

Client scope is category-1: the only performance datasets read are the caller's own
`{client}_marts` and `{client}_reporting`, so there is no cross-client pooling. The
client key is sanitised to `[a-z0-9_]` before it is inlined (a dataset name cannot be
a bound parameter), so an injected value collapses to a harmless slug or a `400`.

Metric selection follows the revenue-gating policy: CPA is the default, and ROAS is
used only for PharmX and FastCover, chosen from the client scope alone, so a lead-gen
client never emits a revenue column. The response also carries a `comparison` block
that aligns the bundle's components against the proven winners into aligned and
unproven dimensions, with a so-what and a now-what, to clear the insight-ladder L4/L5
bar. Regression coverage lives in `test/us-006-winning-historical.test.js`.

Note: this action follows the productization dataset convention (`creative_reporting`
in `{client}_reporting`); the live growth dashboards currently keep `creative_reporting`
inside `{client}_marts`, so reconcile the dataset location at live verification.

## Config reference

| Global | Required | Purpose |
|---|---|---|
| `BQ_FUNCTION`, `PROJECT`, `DATASET`, `TABLE`, `CONV_EXPR` | yes | BigQuery target + conversion expression |
| `CLIENT_NAME` | yes | Sidebar label |
| `REPORT_NAME` | no | Sidebar sub-label (default `Creative Reporting`) |
| `TARGET_METRIC` | no | Headline efficiency metric: `'cpa'` (default) or `'roas'`. Any other value falls back to `cpa`. See [Target metric](#target-metric-cpa-vs-roas) |
| `REVENUE_EXPR` | no | SQL expression for the mart's **gated** revenue column (default `'revenue'`). Only consumed in ROAS mode. Never sum raw `conversion_value` |
| `GROUP_FILTERS` | no | Array of `{ col, label }` segment dropdowns (default none) |
| `THRESHOLDS` | no | Ad Production threshold overrides (see below) |
| `CREATIVE_SCORE_CONFIG` | no | Creative Score weights, maturity target, per-rate quality ceilings and band cutoffs (see [Creative Score column](#creative-score-column)) |
| `COMPETITORS` | no | Optional Competitor Ad Library overrides — the tab itself is automatic (see below) |
| `COMPONENTS` | no | Optional Component Scale overrides; the tab itself is automatic (see [Component Scale](#component-scale)) |
| `REVIEW` | no | F10-internal Creative Review surface only: the bundles-under-review plus optional overrides. **Absent on every live client dashboard**, which is what keeps the review tab strictly additive (see [Creative review](#creative-review)) |

## Competitor Ad Library

Visibility is **probe-driven** — no per-client config is needed. On dashboard load, `f10-competitors.js` fires the shared function's cheap existence probe (`{ action:'competitor', client, probe:true }`, a BQ `EXISTS` on `ad_registry` — no snapshot-history scan) for the `f10_client` key derived from `DATASET` (a trailing `_marts` or `_clean` is stripped, e.g. `mosh_marts` → `mosh`). If the client has competitor rows in `all_clients_adlib`, a **Competitors** nav group and tab are injected; if not (or the probe errors), the module fails closed and leaves zero competitor trace in the DOM. Adding competitor rows in the warehouse is all it takes for the tab to appear on the next dashboard load.

The tab groups this client's tracked competitor Meta ads by competitor, in the F10 card layout — image inline / video with controls / carousel strip, plus ad copy, CTA, format, "Live since" date and longevity (days active + still-active). The **days-active** badge mirrors the date line on Meta's ad card: a live ad counts from its stated go-live date to today, while a stopped ad freezes at `stop − start` using Meta's stated stop date (`ad_delivery_stop_time`, returned by the `competitor` action) so a finished ad shows its true run length instead of climbing to today; a stopped ad with no stop date falls back to today. The tab does not show competitor vision attributes (hook / angle / format read); that vision data is consumed elsewhere.

**Three filters** sit in a bar above the grid, styled with the F10 tokens:

- **Status** — All / Live / Inactive, default **Live**. ("Live" = `still_active` when known, else `is_active`; Inactive is the negation.)
- **Timeframe** — 30 / 60 / 90 days / All time, default **90 days**.
- **Competitor** — "All competitors" + one option per competitor `page_name` present in the current dataset (sorted, deduped), default All.

Status and Competitor are **instant client-side filters** over the cached list (no refetch); a Timeframe change **re-fetches** metadata for the new window and re-applies the client-side filters.

**Metadata + on-demand creatives.** The `competitor` action is **metadata-only**: `{ action:'competitor', client, days? }` returns the latest snapshot per ad (`page_name`, `display_format`, `cta_type`, `ad_creative_bodies`, `link_url`, `snapshot_url`, `is_active`, delivery start/stop, and `still_active`) with **no creatives and no signing**, plus absent-safe `ageMetrics`, and echoes the applied `days`. A positive `days` (30/60/90) applies a `run_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)` bound **inside** the per-ad subquery to prune the partition scan; an absent/null `days` is full history — **All time is the only unpruned scan**. The dead `days_active_observed` / `first_seen_date` columns are no longer projected. The two age marts are read **in parallel** with the ads query. Each competitor paginates (Prev / Next) at **20 ads/page** (`COMPETITORS.PER_PAGE` overrides), and **only the visible page's ads** have their creatives loaded — the frontend calls the new **`competitor-creatives` action** (`{ action:'competitor-creatives', client, adIds:[…] }`, adIds capped at 60) which mints the 15-min v4 signed URLs for just those ads and returns `{ creativesByAd: { <ad_archive_id>: [{ media_type, idx, url }] } }` (the private `gs://` URI is deleted before return). Creatives are cached per `ad_archive_id`, so returning to a page never re-fetches; hidden pages never trigger a creatives fetch. A lightweight loading state shows while a page's creatives resolve, and fetch errors are logged (`console.error`) and surfaced in the grid, never swallowed.

An **age-metrics header** (US-004) sits above the competitor sections when the age marts are present. A client summary strip shows competitors tracked, total live ads, average live-ad age (days, 1dp) and a four-segment age distribution (`<7d / 7–30d / 30–90d / 90d+`) with counts, read from `all_clients_adlib.competitor_age_by_client`. Each competitor's meta line is extended with its average live age and the same four bucket counts from `all_clients_adlib.competitor_age_by_page` (keyed by `page_name`). The `competitor` action returns these as `ageMetrics: { client, byPage }`. Both mart reads are absent-safe end to end: mart absent → no strip and the per-competitor lines render exactly as before; a competitor missing from `byPage` → that line is unchanged.

The shared function also exposes a **`competitor-search` action** (US-006) for term search across this client's competitor set: `{ action:'competitor-search', client, term }` returns the latest snapshot per matching ad, scoped `WHERE f10_client=@client`, with a case-insensitive `CONTAINS_SUBSTR` match over ad copy (`ad_creative_bodies`), link titles, `page_name`, `link_url`, `cta_type` and the vision `on_screen_text` (`competitor_vision_attributes`). Each ad carries a `matched_fields` array naming which fields hit. Like the `competitor` action it is **metadata-only** — it returns no creatives; search results render through the **same lazy-per-page path**, loading each visible page's creatives via `competitor-creatives`, so no `gs://` URI is ever returned here. It fails closed exactly like the competitor tab — it accepts the same `{ probe:true }` existence check, and an empty or single-character `term` (or a client with no competitor rows) returns `{ ads: [] }` without a snapshot scan — and reuses the same `maximumBytesBilled` / `jobTimeoutMs` guardrails.

The shared function additionally exposes five **competitor-intelligence tab actions** (US-007) that power the new tabs, each a thin read over a governed `all_clients_adlib` mart, scoped `WHERE f10_client=@client`, with the same `{ probe:true }` existence check and `maximumBytesBilled` / `jobTimeoutMs` guardrails as the `competitor` action. Every one **fails closed**: a client whose mart has no rows — or whose mart does not physically exist yet — gets an empty payload (or `{ exists:false }`), never a 500; only a genuine table-not-found is treated as absent, every other BigQuery error surfaces loudly. No raw SQL and no `gs://` URI ever reach the browser; the frontend calls by action name only.

- **`themes`** (`{ action:'themes', client }` → `{ competitors }`): the latest named-theme summary per competitor from `competitor_theme_summary` (US-001): structured `themes`, the `dominant_narrative`, `format_mix`, `common_phrases` and `analysis_confidence` (the full narrative, not a bare label, per the insight-ladder gate). `competitor_theme_summary` is keyed on `page_id` only, so this action now resolves the human-readable **`page_name`** by joining the client-scoped `ad_snapshots` (`page_id` → `ANY_VALUE(page_name)`) and returns it alongside `page_id`. This is the cross-repo `page_name`/`page_id` drift fix (competitor-intel-rollup US-008): the frontend receives `page_name`, not just an id.
- **`age-timeseries`** (`→ { client, competitors }`) — the ad-age-over-time series from `competitor_age_over_time` (US-003), split into the client's own line and one series per competitor page, each carrying average **and** median live-ad age per month on one shared axis.
- **`maturity`** (`→ { client, competitors, set_size }`) — the explainable 0–100 Meta maturity score from `competitor_meta_maturity` (US-005): the `composite_score` returned **with** all six component `sub_scores`, the `raw_signals`, the data-layer-owned `maturity_tier` band label (rendered as-is, never re-banded) and each entity's `maturity_rank` within the client's set.
- **`leaderboard`** (`{ action:'leaderboard', client, limit? }` → `{ ads }`) — still-active competitor ads ranked by true live age (days since Meta stated go-live, else first observed) over `ad_registry` + `ad_snapshots`; returns the public Ad Library `snapshot_url` only (no creative signing). `limit` defaults to 25 and is capped at 100.
- **`net-new`** (`→ { ads, byPage, window }`) — brand-new competitor ads this period from `competitor_net_new_ads` (flagged `is_net_new`) plus the absent-safe per-competitor `net_new_count` rollup from `competitor_net_new_by_page` (US-004).
- **`competitor-intel`** (`{ action:'competitor-intel', client }` → `{ competitors, winners }`): the one read that powers the consolidated **Competitor Intelligence** surface (competitor-intel-rollup US-008). It assembles, per competitor, the precomputed Gemini narrative (`competitor_narrative`, US-007: `dominant_bet` / `notable_movements` / `staying_power` / `whitespace_read`, `confidence`, `went_dark`, `coverage_caveat`), the discrete behaviour `archetype` + rationale (`competitor_behaviour_archetype`, US-006), the behaviour movements (`competitor_behaviour_movement`, US-005: volume / new-ad rate / turnover / format + angle diversity / avg live age, each a value + delta + `trend`), the effort allocation (`competitor_effort_allocation`, US-005: share of live creative by format / awareness stage / emotional appeal / hook / CTA / platform, as movements), and the theme movements (`competitor_theme_movement`, US-006: `emerged` / `faded` / `intensified` / `abandoned` / `stable`). `winners` is the go-live staying-power leaderboard (longest-running live ads from `ad_registry` + `ad_snapshots`, aged from `meta_start_time` fallback `first_seen_date`, go-live, never the observation window). Every sub-read is table-not-found tolerant, so the action degrades gracefully mart-by-mart: the US-005/006/007 marts + narrative table are materialized later (see the pinned Dataform column contracts), so until then it returns only what exists and `{ probe:true }` reports `exists:false` (tab hidden). All numbers come from the marts; the narrative model only names and explains (its provenance is enforced upstream in US-007). `page_name` is resolved from whichever mart carries it, so the header always shows a name, never a bare id.

Under the **Competitors** nav group, `f10-competitors.js` injects up to four sub-tabs, each registered independently by its own probe so a client only sees the ones its data supports: **Competitor Ads** (the card grid above, with the US-008 term-search box over the `competitor-search` action), **Vision & Text** (US-009 — the per-competitor `themes` rollup, leading with the dominant angle), **Ad Age Over Time** (US-010 — an inline-SVG multi-line chart of average and median live ad age per month for every competitor plus the client's own line, from the `age-timeseries` action), and **Meta Maturity Score** (US-011 — see below).

> **Launch gate (US-013):** the three secondary sub-tabs — **Vision & Text**, **Ad Age Over Time** and **Meta Maturity Score** — are held behind a `COMP_EXTRA_TABS` launch gate that is **off by default in v1.15.0** while their output is validated, and released to every dashboard in **v1.15.1** (flip `COMP_EXTRA_TABS_DEFAULT` to `true`). **Competitor Ads** (tab 1) is never gated. A single dashboard can preview the secondary tabs ahead of the release by setting `COMPETITORS = { EXTRA_TABS: true }` (or force-hide them with `false`). The gate AND-composes with each tab's data probe, so the underlying rows are still required. The age tab shares one monthly time axis and age definition across all lines; average vs median is a labelled toggle, the client line is the thick young-blood brand line, and the legend focuses a single competitor vs the client. It is probe-driven and absent-safe (hidden with zero DOM trace when `competitor_age_over_time` has no rows for the client) and emits `F10A.track('competitor.tab.age')` on activation (the Ads and Vision & Text tabs emit `competitor.search` / `competitor.tab.themes`). The chart reuses the framework's library-free inline-SVG charting approach (`retentionSparkline` in `f10-utils.js`) — no charting library is added.

The **Meta Maturity Score** tab (US-011) is the roll-up sub-tab: it ranks every tracked competitor **and the client** by an explainable 0–100 Meta maturity score from the `maturity` action (`competitor_meta_maturity` mart), sorted high-to-low with the client's row highlighted and its rank shown. Per the insight-ladder gate the composite is never a bare number — each row shows the composite **alongside** all six labelled component sub-scores (longevity, cadence, volume, active ratio, format diversity, platform spread) so the user can see what drives a high/low score, and a headline calls out the client's rank of the set and its tier. The **`maturity_tier`** band is rendered verbatim from the data layer and is never recomputed/re-banded in the frontend (`hq-classifier-own-labels-single-source`). The same panel also surfaces the **longevity leaderboard** (top live competitor ads by age, `leaderboard` action, public Ad Library `snapshot_url` only — no `gs://` leak) and the **refresh cadence + net-new alerts** (per-competitor `net_new_count` over the window plus flagged brand-new ads, `net-new` action). Maturity is the primary probe-gated surface; the leaderboard and net-new loads are secondary and degrade to their own empty state on failure (logged via `console.error`, never swallowed). It is probe-driven and absent-safe (hidden with zero DOM trace when `competitor_meta_maturity` has no rows for the client) and emits `F10A.track('competitor.tab.maturity')` on activation.

### Competitor Intelligence (consolidated surface, competitor-intel-rollup US-008)

The **Competitor Intelligence** tab is the single, consolidated behaviour-over-time surface that supersedes the thin four-tab intelligence layout and its poor rollup visualisation. It renders live from the `competitor-intel` action (plus the retained `age-timeseries` read) and is **probe-driven**: it registers only when the client has consolidated intelligence rows (its own `competitor-intel` probe), independent of the legacy `COMP_EXTRA_TABS` gate, and leaves zero DOM trace otherwise. Per competitor it shows, in insight-ladder order: the **narrative** first (the dominant bet, what changed, the go-live staying-power read, and the whitespace-vs-you now-what, with a confidence chip and coverage caveat, and a `went_dark` competitor rendered as a first-class state, not an error), then **what they're betting on now** (effort allocation as movement bars: share + delta points + trend per dimension bucket), **how they're moving** (behaviour stat tiles, each a value + delta + trend), a discrete **behaviour archetype** badge (data-owned label + rationale, never recomputed in the frontend), and the **theme movements** (`emerged` / `faded` / `intensified` / `abandoned` / `stable`). Below the per-competitor cards it shows the **go-live staying-power winners** (the longest-running live competitor ads, aged from go-live per the `f10-competitor-ad-age-from-go-live-not-observation-window` policy) and the **retained Ad Age Over Time chart** (reused verbatim from the age module, average/median toggle and focusable legend, scoped to this panel). Every section is absent-safe and degrades to a clean empty state until the US-005/006/007 marts + narrative table are materialized (verified live end-to-end in US-011). It emits `F10A.track('competitor.tab.intel')` on activation and uses the F10 design tokens inline (young-blood surface pair, one Stabilo accent, no shadows/gradients), matching the other competitor tabs.

**Noise gate (`isPresentableCompetitor`).** Both the per-competitor cards and the age-chart series/legend filter through one tunable predicate before rendering. A competitor is presentable when it has EITHER a resolved human `page_name` OR (even nameless) some real signal: live-ad behaviour, effort allocation, theme movements, a drawable age series, or a narrative beyond the generic went-dark line. It drops only the pure noise: a page with no resolved name that also went dark and has nothing to say (it otherwise renders as a bare numeric `page_id` card). A NAMED went-dark competitor is KEPT, because a competitor that was active and went dark is a first-class signal (US-007). If filtering leaves zero competitors the surface degrades to the existing empty state.

**Ad Age Over Time chart sizing + tooltips.** The inline-SVG chart is capped to its native viewBox width (`max-width` on the wrap) so it no longer upscales past sibling-chart scale, with thinner line stroke-widths (client `2.2`, competitor `1.2`), smaller dots, and smaller axis labels. Each data point carries a pointer-following hover tooltip (series label + age in days + month) styled with the F10 tokens, backed by an accessible SVG `<title>` floor on every dot so the read works with zero JS and for every series, the client line included.

The **performance controls bar is hidden on the competitor tab** — its group filter, ad-name search, ad-status, window length, efficiency metric, noise floor and min-spend controls are irrelevant to competitor ads. `compSelectTab()` hides `#controls-bar` on activation, and `applyControlsVisibility()` (f10-weekly.js) checks whether `#panel-competitors` is active and keeps the bar suppressed, so a later weekly re-render (tab switch back, refresh, filter change) can't re-show it over the competitor tab.

`COMPETITORS` is an **optional overrides object** only:

```js
const COMPETITORS = {
  CLIENT:       'mosh', // optional f10_client override when DATASET doesn't follow {client}_marts / {client}_clean
  PER_PAGE:     20,     // optional; competitor cards shown per in-page page (default 20)
  MAX_PER_PAGE: 0,      // optional hard cap on ads rendered per competitor (0 = no cap)
};
```

## Component Scale

`f10-components.js` adds a **Component Scale** tab that surfaces the creative-component-pipeline evidence layer where creative reporting already lives. It grades every value of the five canonical components (**hook, format, call-to-action, message angle, visual style**) against the client's own baseline, from the pipeline's `{client}_marts.component_performance` mart (built by `component_scale.js` in `f10-dataform`, US-002). Each value shows its grade, the spend-weighted **lift vs baseline**, the delivered **evidence count**, the **confidence tier**, and the supporting metric (CPA, or gated-revenue ROAS for the revenue-gated clients).

Visibility is **probe-driven**, exactly like the Competitor tab, so no per-client config is needed. On load, the module runs a cheap `EXISTS` probe on `{client}_marts.component_performance`; only when the mart has rows does it inject its own **Creative Components** nav section, **Component Scale** nav link and panel. A dashboard whose client has no mart (probe returns no rows, or the table does not exist and the query errors) shows **no tab** and leaves zero trace in the DOM: it fails closed, never a broken or empty tab. Every query runs through `runQuery()` (`f10-utils.js`) into the shared `bq` function, so it reuses the same 2 GB `maximumBytesBilled` cap and 30 s `jobTimeoutMs` guardrails as every other read; no fourth copy of the query options is pasted.

Honesty is built into the render:

- **Descriptive, not causal.** Every grade carries the mart's `label = 'descriptive'`; the tab renders the caveat verbatim: these are associations with performance against the client's own baseline, not proof of causation.
- **Insufficient evidence is shown, never hidden.** A value below the 10-asset evidence gate (`confidence_tier = 'insufficient evidence'`) renders **greyed with its asset count**, so a thin read is visible and honestly weighted rather than silently dropped.
- **Co-occurrence flag.** When US-005 populates `co_occurrence_flag`, a flagged grade is **marked** with a co-occurrence caution (its lift may be driven by a co-present component). Set `COMPONENTS = { SUPPRESS_CO_OCCURRENCE: true }` to hold the grade to a caution instead of showing it.
- **Whitespace lane.** A separate, clearly-labelled section renders the cross-client whitespace lane (`all_clients.component_whitespace`, US-003): component values proven on other F10 clients but untested for this one. It is **hypotheses, not grades**: the verbatim label `untested here - hypothesis, not a grade`, a count of source clients (never their names) and this client's own thin evidence count only. No lift, CPA, ROAS or spend number appears in the lane.

A failed component-scale query renders a **visible panel error state** ("Component Scale is temporarily unavailable") with the failure detail, never a blank tab or a console-only error. The whitespace read is secondary: if it fails the scale still renders and the lane shows its own note.

### Generic tab dispatcher

The Component Scale tab activates through **`f10ActivateTab()`** in `f10-layout.js`, a single generic dispatcher that clears **every** nav link (`#sidebar nav a`) and **every** panel (`.tab-panel`) before activating the selected pair. New modules call it instead of hard-coding a clear-list of every other tab's nav-link classes, which is the fix for the old O(tabs^2) activation coupling: adding this tab needed **no edit to any existing module**, and a future tab needs none either. The panel carries the shared `.tab-panel` class, so the existing engines' own clears hide it when another tab is selected, and the module binds a generic deactivate handler to the other nav anchors so its highlight clears too. A net-new live-path canary in `test/us-components-scale.test.js` boots the real base, TikTok and Competitor engines alongside this module and asserts each pre-existing tab (Weekly, Monthly, Competitors, TikTok) still switches to exactly one visible panel after the new module registers.

`COMPONENTS` is an **optional overrides object** only:

```js
const COMPONENTS = {
  CLIENT:                 'mosh', // optional f10 client slug override when DATASET doesn't follow {client}_marts / {client}_clean
  SUPPRESS_CO_OCCURRENCE: false,  // optional; true hides co-occurrence-flagged grades instead of marking them (default: mark)
};
```

## Brief editor

`f10-brief-editor.js` adds a **Brief Editor** tab for the F10 internal review app. An operator loads an existing brief revision, steers the five editable creative axes and the copy, and saves a **new** revision that the generation engine can be pointed at, so a brief can be steered before generation spends without breaking the canonical vocabularies. **Generation does not run from the app in v1** (vault Vertex SA plus a hard spend cap plus no Cloud Run): the editor only edits and saves; after saving, an operator fires generation from the CLI against the new revision id.

**The contract (US-003, already merged in the Python pipeline).** A brief revision persists as a JSON document in GCS at `gs://f10-creative-assets/brief-revisions/{client}/{revision_id}.json` plus a registry row in `mcc-poc-477801.creative_pipeline.brief_revisions`. It carries the five canonical axes, the copy blocks as free text, and provenance (client, evidence source, winning values, revision id). The axis vocabularies in this module **mirror `brief.py` / `brief_revision.schema.json` exactly** and a test asserts they stay in lockstep: the whole point of the editor is that it cannot emit a non-canonical value.

**Never non-canonical.** The five axes (**visual style, hook type, message angle, CTA type, format**) are edited through `<select>` dropdowns whose options are exactly the canonical enums, so a free-text axis value is not reachable in the UI. The save path validates a second time and rejects any axis value outside its vocabulary before anything is written, so even a tampered DOM cannot persist an off-vocabulary value. Copy is captured as free text.

**Probe-gated, fails closed.** On boot the module resolves the client, runs a cheap probe ("does this client have any brief revision to edit?") through the injectable brief store, and only then injects its own **Creative Briefs** nav section, **Brief Editor** nav link and panel. A client with no revisions, or a probe error (for example the brief backend is not yet hosted), shows **no tab** and leaves zero trace in the DOM. Tab activation goes through the same generic `f10ActivateTab()` dispatcher, so two panels can never show at once and no existing module needed editing. It self-boots (no `f10-layout.js` edit) and also exposes `window.initBriefEditor` for explicit dispatch.

**After save (AC4).** The panel shows the saved revision id and a clear next step: an operator runs generation from the CLI against that id (`hq secrets exec -- python -m f10_creative_pipeline.generate --revision <id>`), making explicit that generation is not run from the app.

**Dual-mode, injectable writer seam.** The same file is both the browser panel and the brief persistence core. In Node it exports `saveRevision` / `loadRevision` / `processRequest` programmed against an object-store + registry seam (offline tests use in-memory fakes; nothing touches Google), plus `makeWriters()` which builds the live writers **without credentials** so they authenticate as the runtime service account via Application Default Credentials on GCP compute (the same ADC model US-008's `feedback.js` uses), and `handler` (a `probe` / `load` / `save` POST endpoint) for whatever hosts the review app's brief backend.

> **Provisioning follow-up (not done in this change).** Writing a brief revision needs GCS write to the `brief-revisions/` prefix plus a `brief_revisions` insert. The read/object-viewer dashboard SA cannot do this, and the `feedback-write` SA is scoped only to `status.json` + `feedback_audit`, so it cannot either. Provisioning a brief-write runtime SA (or widening scope) **and** hosting `f10-brief-editor.js`'s `handler` as the review app's brief endpoint are live-provisioning steps that are still pending. Until they land, the browser probe fails closed and the tab does not appear, so live client dashboards are unaffected.

Config (browser, all optional):

```js
const BRIEF_EDITOR = {
  CLIENT:      'moshy',       // optional f10 client slug override when DATASET doesn't follow {client}_marts / {client}_clean
  REVISION_ID: 'rev-123',     // optional; auto-load this revision when the tab first opens
  ACTOR:       'zac@fourteen10', // optional; stamped as created_by on saved revisions
  ENDPOINT:    '/api/brief',  // optional brief backend URL (else window.BRIEF_FUNCTION, else derived from BQ_FUNCTION by swapping /bq -> /brief)
};
```

## Creative review

`f10-review.js` adds a **Creative Review** tab for the F10-internal review surface: an interactive preview that shows each newly generated ad next to the client's winning historical ads and their metric, so a reviewer can judge a concept in context instead of reading a static report. For each bundle-under-review the panel renders the new ad's own preview image beside the client's top winners, the policy metric on each winner, the bundle's coherence flags and held dimensions, and the so-what / now-what read that compares the concept to what already works for the client.

**Data sources (both already merged).** Winners, metrics and the comparison come from the US-006 [`winning-historical`](#new-ad-vs-winning-historical-join-winning-historical-action) action (strictly per-client: only `{client}_marts` and `{client}_reporting` are read, and the metric follows the revenue-gating policy - CPA default, ROAS only for PharmX and FastCover). The new ad's composed preview image comes from the US-005 [`generated-preview`](#generated-ad-preview-resolver-generated-preview-action) action. A winner with no fetched asset falls back to its click-through link, and a missing new-ad composite falls back to a labelled placeholder, so nothing renders as a broken image.

**Probe-gated AND live-path safe - two gates, both fail closed.** This module feeds the same shared framework that renders live client dashboards, so it is strictly additive:

1. **Config gate (live-path safety).** The bundles-under-review come from the optional `REVIEW` config block. A dashboard that carries **no `REVIEW` config** - which is every live client dashboard - short-circuits to a silent no-op: no probe, no network call, no nav link, no panel, zero DOM trace. An existing dashboard cannot be altered by a module it never configures.
2. **Data probe gate.** Even with bundles configured, the module first runs the cheap `winning-historical` existence probe. Only when the client actually has review data is the **Creative Review** nav section, nav link and panel injected. A client with no review data, or any probe error (endpoint down, mart not built), shows **no tab** and leaves zero trace.

**Single generic dispatcher.** Tab activation goes through the same `f10ActivateTab()` dispatcher as every other module (see [Generic tab dispatcher](#generic-tab-dispatcher)): it clears every nav link and every `.tab-panel` before activating the selected pair, so two panels can never both be active and no existing module needed editing. `f10-layout.js` calls `initReview()` at the tail of `renderLayout()` (the same probe-decides pattern as `initComponents()`), and the module also self-boots on `DOMContentLoaded` behind an idempotent guard, so a dashboard pinned to an older `f10-layout.js` tag still gets the tab.

**Live-path release discipline (`livePathWatch`).** Because a bad framework release can blank-screen live dashboards, a framework tag bump follows the [release process](#release-process): after tagging, **purge and verify the jsDelivr tag**, then load a known-good existing client dashboard (for example `matilda` or `stake`) on the new tag and confirm it still renders before bumping other dashboards. The code-level invariant behind that canary - that a dashboard without a `REVIEW` config injects nothing and the base nav is unchanged - is asserted in `test/f10-review.test.js`.

Config (F10-internal review surface only; all optional except providing at least one bundle):

```js
const REVIEW = {
  CLIENT: 'moshy',            // optional f10 client slug override when DATASET doesn't follow {client}_marts / {client}_clean
  LIMIT: 5,                   // optional winners per bundle to request (server caps at 25)
  BUNDLES: [                  // the generated ads to review, from the operator's generation run
    {
      bundle_id: 'brief_moshy_founder_ab12cd',
      platform: 'meta',                          // optional; defaults to meta
      label: 'Founder story - bold typographic', // optional display label
      components: { hook_type: 'Founder story', format_canonical: 'UGC video' },
      coherence_flags: ['visual_style held for review'],
      held_dimensions: ['visual_style_canonical'],
      new_ad: { headline: '...', body: '...' }   // optional copy metadata
    }
  ]
};
```

Regression coverage (registration, probe gating, live-path safety, the single-dispatcher activation and new-vs-winners render) lives in `test/f10-review.test.js`.

## Target metric (CPA vs ROAS)

Every dashboard headlines one efficiency metric. `TARGET_METRIC` selects it:

- **`cpa`** (default, or when `TARGET_METRIC` is unset) — a cost-efficiency lens: spend ÷ conversions, lower is better. This is the legacy behaviour, so **every existing dashboard is unchanged** when the config is absent.
- **`roas`** — a revenue-return lens: gated revenue ÷ spend, higher is better, rendered as a ratio (e.g. `4.8x`).

Set it once, before the scripts load:

```js
const TARGET_METRIC = 'roas';
const REVENUE_EXPR  = 'revenue'; /* the mart's gated revenue column; this is the default */
```

Any value other than `roas` falls back to `cpa`.

### Revenue gating rule (hard policy)

**ROAS must consume the mart's gated `revenue` column, sourced via `REVENUE_EXPR` (default `'revenue'`). Raw `conversion_value` is forbidden.** The aggregation field is deliberately named `revenue` (not `conv_value`) so it can never be confused with the raw platform value. Only enable ROAS for **purchase clients whose mart publishes that gated revenue column** — a lead-gen mart has no such column and ROAS queries will error. Revenue is fetched **only** in ROAS mode; CPA-mode dashboards never emit a revenue `SELECT`, so lead-gen marts keep working.

### What ROAS mode changes

When `TARGET_METRIC = 'roas'`, the framework becomes metric-aware end to end:

- **Efficiency-metric dropdown** leads with `ROAS (revenue / spend)`, selected by default (CPA/CPC/CPM/CTR remain available).
- **Weekly scorecards** lead with the revenue story: Spend, Revenue, blended ROAS, Conversions.
- **Monthly tabs** (Power Law, Ad Production, Ad Decay, Ad Age, Creative Effectiveness) show the ROAS column/label and compute it as `SAFE_DIVIDE(SUM(revenue), NULLIF(spend, 0))`.
- **Ad Production tiering** inverts polarity — see [Thresholds](#thresholds).
- **Notes and headings** swap CPA copy for ROAS copy automatically (`ROAS is revenue ÷ spend`).
- **Weekly noise floor** — the "× target CPA" spend gate relabels to a plain "spend target" (its behaviour is unchanged).
- **TikTok section** (when a `TIKTOK` config is present) is metric-aware too: its dropdown, Ad Production classification, scatter, tables and copy switch to ROAS, reading the gated revenue column and classifying against the TikTok ROAS bands `HR_ROAS`/`OB_ROAS`/`SO_ROAS` (defaults `4`/`2`/`1`, overridable via `TIKTOK.THRESHOLDS`; revenue column via `TIKTOK.REVENUE_EXPR`, default `REVENUE_EXPR`). The revenue-integrity guard covers the TikTok tabs as well.

### Revenue-integrity guard

In ROAS mode the framework refuses to present a ROAS number it cannot trust. When
a tab's **blended** revenue is `0` while spend is `> 0`, the gated revenue column
is almost certainly missing or zeroed upstream — so the dashboard shows a warning
banner (_"Revenue data looks incomplete for this window — ROAS may be understated.
Check the pipeline before acting."_) in place of a confident `0.0x` headline. It
runs on the aggregates already fetched for the tab (no extra query) on the Weekly
Summary and Ad Production tabs.

The check is **blended-only**: a single real-spend / zero-revenue ad is a
legitimate `0` ROAS (a Strike Out) and still renders its own `0.0x` on the board
and scatter — the guard never touches per-ad classification. It fires only when
*every* dollar of spend returned zero revenue, which distinguishes a broken
revenue signal from genuinely zero revenue on one ad. **CPA mode never shows the
banner and is completely unaffected.**

The warehouse-side half of this guard is the F10 `data-tracking-sentinel`
`revenue_integrity` watch, which flags the same zeroing/staleness at the source;
both halves exist and neither replaces the other.

## Group filters

- Apply to **all tabs** (weekly and monthly) by injecting `scopeWhere()` into every query's WHERE clause.
- Multiple dimensions are supported — one dropdown per `GROUP_FILTERS` entry.
- Values are queried dynamically and default to **All** (no filter).
- `fetchMaxDate` stays global so the end-date picker is stable regardless of selected group.

## Ad status filter & ad-name search

Both controls live in the controls bar on **every Meta/monthly tab** and need no per-client config — they serve all dashboards automatically. (The bar is hidden on the competitor tab; see Competitor Ad Library above.)

- **Ad status** (`All ads` / `Active only`) — server-side filter. `Active only` scopes every query to ads whose latest Meta delivery status is ACTIVE, via the `is_active` column on the `creative_reporting` mart. Composed with group filters through `scopeWhere()` (group + status predicates, correct WHERE/AND leading).
  - **Requires** the mart to expose `is_active` (and `effective_status`), added by the `f10-dataform` `stg_meta_ad_status` model. Pin a client to a framework tag that ships this control **only after** that column is live in the client's mart, or `Active only` queries will error.
- **Search ad** — client-side substring filter over the ad name, applied to the current view across all ad tables (Movement Board, Ad Age, Ad Production, Power Law, Creative Effectiveness). Instant, no re-query. When a term is present the weekly board **bypasses the noise floor** so a searched ad always appears. Ad rows carry a `data-adname` attribute (`adNameAttr()`); `renderPagedTable`/`refilterAllTables` do the filtering. Month-level summary rows have no `data-adname` and are never filtered.

## Thresholds

Ad Production classification (Home Run / On Base / Strike Out) uses these defaults:

| Key | Default | Meaning |
|---|---|---|
| `HR_SPEND` | 5000 | Home Run min lifetime spend |
| `HR_CPA` | 70 | Home Run max CPA |
| `OB_SPEND` | 1000 | On Base min lifetime spend |
| `OB_CPA` | 100 | On Base max CPA |
| `SO_SPEND` | 500 | Strike Out min lifetime spend |
| `SO_CPA` | 140 | Strike Out CPA above which an ad strikes out |

Classification (top-down): **Home Run** = `spend ≥ HR_SPEND AND 0 < CPA < HR_CPA`; **On Base** = `spend ≥ OB_SPEND AND 0 < CPA < OB_CPA`; **Strike Out** = `spend ≥ SO_SPEND AND CPA > SO_CPA`; otherwise **Unclassified**.

To change them per client, define a `THRESHOLDS` config object (any subset) **before** the scripts load:

```js
const THRESHOLDS = { HR_SPEND: 8000, HR_CPA: 90 };
```

The SQL classification, the scatter threshold lines, and the displayed benchmark copy/legend all read these values, so the numbers users see always match the data. Do **not** redeclare `HR_SPEND` etc directly — that collides with the shared declarations and breaks the page.

### ROAS bands (when `TARGET_METRIC = 'roas'`)

In ROAS mode the **spend floors are shared** with CPA (`HR_SPEND`/`OB_SPEND`/`SO_SPEND`, same defaults), but the efficiency band flips polarity — higher ROAS is better, so Home Run/On Base are **floors to clear** and Strike Out is a **ceiling to fall under**:

| Key | Default | Meaning |
|---|---|---|
| `HR_ROAS` | 4 | Home Run min ROAS (floor to clear) |
| `OB_ROAS` | 2 | On Base min ROAS (floor to clear) |
| `SO_ROAS` | 1 | Strike Out ROAS ceiling (below this an ad strikes out) |

Classification (top-down): **Home Run** = `spend ≥ HR_SPEND AND ROAS > HR_ROAS`; **On Base** = `spend ≥ OB_SPEND AND ROAS > OB_ROAS`; **Strike Out** = `spend ≥ SO_SPEND AND ROAS < SO_ROAS`; otherwise **Unclassified**. (A real-spend / zero-revenue ad has ROAS `0 < SO_ROAS` and correctly grades Strike Out.)

Override any subset the same way, using the ROAS keys:

```js
const THRESHOLDS = { HR_SPEND: 5000, HR_ROAS: 4, OB_SPEND: 1000, OB_ROAS: 2, SO_SPEND: 500, SO_ROAS: 1 };
```

### Tuning thresholds live (v1.5.0+)

The Ad Production tab includes an **Adjust thresholds** panel so a user can change the six bands and re-classify on the fly. Edits are **session-only**: they re-run the production queries and refresh the scorecards, scatter, chart, tables and benchmark copy, but a page reload reverts to the configured defaults. **Reset to defaults** restores the per-client `THRESHOLDS` values (or the built-in defaults if none are set). To change the persistent defaults, edit the dashboard's `THRESHOLDS` config — there is no server-side store. Helpers `getProductionThresholds()`, `setProductionThresholds(partial)` and `resetProductionThresholds()` are exposed for programmatic use.

The panel is **metric-aware**: the three spend floors are always shown, and the efficiency inputs follow `TARGET_METRIC` — CPA mode shows "max CPA" fields (`th-hr-cpa` etc.), ROAS mode shows "min ROAS" floors (`th-hr-roas`, `th-ob-roas`) plus a "max ROAS" Strike-Out ceiling (`th-so-roas`). `getProductionThresholds()` returns only the active metric's bands (plus the shared spend floors); `setProductionThresholds()` accepts either metric's keys.

## Creative Score column

The **Ad Production** and **Creative Effectiveness** per-ad tables (Meta and TikTok) carry a sortable **Creative Score** column: one 0 to 100 score per creative that lets the team rank creatives on a single, cross-metric number. The score is computed **once in SQL** by `creativeScoreSQL(...)` as a `creative_score` column and rendered verbatim by `creativeScoreBadge(...)` (both in `f10-utils.js`); the frontend never recomputes it. The badge text is the bare number so the universal table sort reads it numerically and sorts high to low on the first click, and the colour band comes from `creativeScoreBand()`, reusing the framework palette (`.score-strong` green, `.score-mid` blue, `.score-weak` red in `f10-shared.css`, sharing the `--stabilo` / `--stabilo-red` vars with the classification badges). The Creative Effectiveness query carries the same efficiency inputs and active-days as Production, so a given ad shows the same score on both tabs for the same window.

### The formula

The score is a neutral 50 shifted by a confidence multiplier:

```
score = round(50 + (raw - 50) * confidence)
raw   = 100 * (0.5 * efficiency + 0.3 * quality + 0.2 * durability)
```

`efficiency`, `quality` and `durability` are each a 0..1 sub-score, and `confidence` is a 0..1 multiplier. The four components:

- **Efficiency** (weight 0.5) is anchored to the account's live HR/OB/SO threshold bands. In CPA mode it rewards a low CPA and anchors to `HR_CPA` / `OB_CPA` / `SO_CPA`. In ROAS mode it flips to reward a high ROAS against `HR_ROAS` / `OB_ROAS` / `SO_ROAS`, and reads **only** the gated revenue expression, never raw `conversion_value` (the same revenue-gating policy the rest of the framework follows).
- **Quality** (weight 0.3) is the video gates (hook, hold, CTR, completion), each mapped 0..1 against a ceiling and then averaged. A static image with no video gates scores a neutral **0.5** on quality, so a still is not penalised for having no video attention to measure.
- **Durability** (weight 0.2) is active days against a maturity target (default 30 days).
- **Confidence** is `LN(1 + spend) / LN(1 + HR_SPEND)`, clamped 0..1, applied as a **multiplier**. It pulls a thin-spend ad toward the neutral 50 rather than letting a tiny-spend ad top the board; an ad with enough spend behind it (at or above `HR_SPEND`) is trusted in full.

The hover breakdown (`f10-preview.js`) shows the final score plus its four component sub-scores, reading the **same registry numbers** the badge shows (no second computation), so the hover always reconciles to the table badge for that ad.

### Per-platform quality ceilings

Median video quality should centre near 0.5 on both platforms, so real video sits alongside the static 0.5 baseline and TikTok is not under-scaled against Meta. The quality ceilings are therefore **per-platform** (validated on FastCover live data), carried by `metaScoreOpts()` and `ttScoreOpts()`:

| Platform | hook | hold | ctr | completion |
|---|---|---|---|---|
| Meta | n/a | 6 | 1.3 | 2.5 |
| TikTok | 11 | 1.9 | 0.4 | 0.3 |

Meta has no hook gate, so its quality is hold, ctr and completion. Each ceiling is overridable via `CREATIVE_SCORE_CONFIG.qualityCeil`; the config default is the Meta set, used only as a fallback.

### Structural note

Because efficiency carries half the weight and a zero-conversion ad grades efficiency at 0, a zero-conversion ad is capped at the neutral 50 and cannot reach the strong band, even with perfect quality and durability. That is deliberate: a creative that has never converted should not top a scoreboard on attention metrics alone.

### Config

All weights, the maturity target, the per-rate quality ceilings and the band cutoffs are tunable via the guarded-global `CREATIVE_SCORE_CONFIG`, set **before** the scripts load, the same idiom as `THRESHOLDS` / `TARGET_METRIC`:

```js
const CREATIVE_SCORE_CONFIG = { wEfficiency: 0.5, maturityDays: 45 };
```

| Key | Default | Purpose |
|---|---|---|
| `wEfficiency` | 0.5 | Efficiency weight in the blend |
| `wQuality` | 0.3 | Quality weight in the blend |
| `wDurability` | 0.2 | Durability weight in the blend |
| `maturityDays` | 30 | Active-days target the durability sub-score maps against |
| `qualityCeil` | per-platform | `{ hook, hold, ctr, completion }` ceilings; set per-platform at runtime by `metaScoreOpts()` / `ttScoreOpts()`, this config value is the Meta fallback |
| `confidenceFloor` | 0 | Lower clamp on the confidence multiplier |
| `bandStrong` | 70 | Score at or above this renders in the Strong (green) band |
| `bandMid` | 40 | Score at or above this renders in the Mid (blue) band; below it is Weak (red) |
| `neutral` | 50 | The neutral midpoint the raw score is shifted around |

Any subset can be overridden; omitted keys keep their defaults.

### Adopting the Creative Score on another dashboard

The change is **purely additive**, so a dashboard adopts the Creative Score simply by re-pinning its jsDelivr URLs to **v1.18.0 or later** (see [How to use in a dashboard](#how-to-use-in-a-dashboard)). No config is required, the defaults ship, and it works in ROAS mode as well as CPA mode. Optionally tune `CREATIVE_SCORE_CONFIG` (weights, `maturityDays`, per-rate `qualityCeil`, band cutoffs) per client, and re-validate the score against that client's known winners and dogs before relying on it for cross-creative comparison.

## Co-branding (optional)

A dashboard can be co-branded for a client: recoloured chrome plus a **client + F10 logo lockup** in the sidebar. This is opt-in — a dashboard with no `BRANDING` config renders exactly as before. The F10 **type system and content styling are kept**; only the chrome colours and the sidebar mark change, so the dashboard still reads as an F10 product carrying the client's brand.

Set a `BRANDING` object in the client config block. Every key is optional; any you omit keeps its F10 default. Colours accept any CSS colour string.

| Key | Overrides | Default |
|---|---|---|
| `clientLogo` | Inline SVG for the client mark in the sidebar lockup. Use `fill="currentColor"` so it tints to `sidebarAccent`; a light/white mark reads best on a dark sidebar. Omit for no lockup. | — |
| `sidebarBg` | Sidebar background (`--sidebar-bg`) | F10 maroon |
| `brand` | Headings / buttons / links (`--young-blood`) | F10 maroon |
| `sidebarAccent` | Client-name + active-nav text/marker (`--sidebar-accent`) | F10 lime |
| `onBrand` | Text sitting on brand-colour buttons (`--on-brand`) | F10 lime |
| `accent` | Positive-accent chrome in the content area (`--stabilo`): highlighted-scorecard border, and the Home Run / Scaling Winner pill badges (which tint from it). | F10 lime |
| `navActiveBg` | Active-nav row background (`--nav-active-bg`) | faint lime |
| `accentSoft` | Highlighted-scorecard fill (`--accent-soft`) | faint lime |
| `footer` | Sidebar footer HTML | `F10 \| Creative Reporting…` |
| `good` / `bad` | Good/bad **signalling** colours: the improve/worsen decomposition bars and the up/down deltas (`--good` / `--bad`) | F10 green / red |
| `warn` | Alert red for warn scorecards and Fading / Strike Out badges (`--stabilo-red`) | F10 red |
| `chartPrimary` | Hero chart series / Home Run class | F10 lime |
| `chartSecondary` | Secondary chart series / On Base class | F10 blue |
| `chartNegative` | Negative chart series / Strike Out class | F10 red |
| `chartPalette` | Categorical series array (cohorts, power law, decomposition) | 12-colour F10 set |
| `chartAge` / `chartClass` / `chartState` | Fine-grained overrides for the age-bucket, class, and movement-state colour maps | derived from the above |

Chart colours theme the canvas **visualisations**. Genuine good/bad signalling (deltas, the mix/efficiency waterfall) stays on the `--good`/`--bad` CSS vars and brand bars on `--young-blood`, so those follow the chrome theme and are deliberately not part of this palette. Stake's guideline (avoid green/red where it could *falsely* signal gains/losses) is why the categorical `chartPalette` uses their blue/teal/purple/yellow/orange spectrum and leaves green/red for real signalling.

When `clientLogo` is set, the sidebar header shows **client mark → divider → F10 mark**. The F10 mark is bundled in `f10-layout.js` (fills use `currentColor`, tinted to `sidebarAccent`), so nothing extra needs to be hosted. Colour keys are applied as inline CSS custom properties on `#app` at render time via `f10ThemeVars()`; because the whole stylesheet reads these tokens, the overrides cascade automatically.

Example (Stake — black sidebar, white accents, co-brand footer):

```js
const BRANDING = {
  clientLogo:    '<svg viewBox="0 0 48 54" xmlns="http://www.w3.org/2000/svg"><path d="…" fill="currentColor"/></svg>',
  sidebarBg:     '#141414',
  brand:         '#141414',
  sidebarAccent: '#ffffff',
  onBrand:       '#ffffff',
  navActiveBg:   'rgba(255,255,255,0.08)',
  footer:        'Stake &times; F10 | Creative Reporting<br/>Powered by BigQuery',
  chartPrimary:   '#13356B',   // Stake Blue 1
  chartSecondary: '#00858F',   // Stake Teal 1
  chartNegative:  '#CF3160',   // Stake Red 2
  good:           '#2C5B39',   // Stake Green 1 — 'improves' / positive delta
  bad:            '#CF3160',   // Stake Red 2   — 'worsens' / negative delta
  warn:           '#CF3160',   // Stake Red 2   — warn scorecards / Strike Out badge
  chartPalette:   ['#13356B','#00858F','#A974FF','#F6D000','#FFA800','#6D7DFF','#493072','#54D1D8','#975E39','#73AAE6','#A38106','#D2A9F3'],
};
```

## Versioning

Each release is tagged (e.g. `v1.3.0`). Dashboards pin to a tag in their jsDelivr URLs and bump it to pick up changes. jsDelivr caches tags immutably, so always cut a **new** tag rather than re-pointing an existing one.

## Release process

Because the components and the dashboards are pinned to a tag, the order matters: a dashboard pointing at `@vX.Y.Z` will 404 its assets (and break) if that tag does not exist yet. Follow this sequence for every release:

1. **Merge the components PR** to `main`.
2. **Create and publish the tag** on `main` at the merge commit:
   ```sh
   git tag vX.Y.Z <merge-commit-sha>
   git push origin vX.Y.Z
   ```
   (or GitHub → Releases → Draft new release → choose tag `vX.Y.Z` on `main` → Publish.)
   This step must be done by someone with push access to tags — it cannot be done from the Claude Code web sandbox, which is restricted to feature-branch pushes.
3. **Purge the jsDelivr cache for the new tag** — do this immediately after publishing the tag and *before* any dashboard goes live on it. jsDelivr caches the list of available versions, so a brand-new tag can 404 for a while; if a dashboard requests it during that window, jsDelivr caches the 404 and the site shows a blank screen (`renderLayout is not defined`) until the cache clears. Purging forces a refetch:
   ```sh
   for f in f10-shared.css f10-utils.js f10-weekly.js f10-monthly.js f10-layout.js; do
     curl -s "https://purge.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@vX.Y.Z/$f" -o /dev/null -w "$f -> %{http_code}\n"
   done
   ```
4. **Verify the tag resolves on the CDN** (not just in git) before touching the dashboards:
   ```sh
   git ls-remote --tags origin | grep vX.Y.Z
   curl -sI "https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@vX.Y.Z/f10-layout.js" | head -1   # expect 200
   ```
5. **Bump and merge the dashboard PRs** — update the `@vX.Y.Z` references in each dashboard's `index.html`, then merge. Netlify redeploys each site automatically.
6. **Smoke-test** each deployed dashboard (it loads, the relevant tabs render).

Use semver: patch for fixes, minor for new config/behaviour (e.g. a new threshold), major for breaking config changes.

> Note: these repos squash-merge, so after a components release the feature branch must be rebased onto the updated `main` (`git fetch origin main && git reset --soft origin/main && git commit`) before the next PR, or GitHub will report a phantom merge conflict.

## Creating a dashboard with the skill

A Claude Code skill lives in [`skills/create-creative-dashboard/`](./skills/create-creative-dashboard). It scaffolds a new client dashboard from the starter at the latest release tag, fills in the config from a short Q&A, commits it, and prints the GitHub + Netlify deploy steps.

To make it available, register it as a skill (e.g. as an organisation skill shared with the team, or copy the `create-creative-dashboard/` folder into `~/.claude/skills/`). Then in any project run:

```
/create-creative-dashboard
```

The skill only produces a small config-only repo — the UI and logic still come from this library via jsDelivr.

## Dashboards using this library

- `fourteen10-advertising/bridgit-creative-dashboard`
- `fourteen10-advertising/fastcover-creative-dashboard`
- `fourteen10-advertising/matilda-creative-dashboard`
## Doc-sync

Documentation moves with code in this repo:

- **CI (enforced):** the `doc-sync` GitHub Action fails a PR/push when code or
  config changes without a docs change. Add `[skip-docs]` to a commit message
  to bypass a change that genuinely needs none.
- **Local (fast catch):** after cloning, run once — `git config core.hooksPath
  .githooks` (or `sh .githooks/setup.sh`) — to enable the pre-commit hook that
  checks the same thing before you commit.

## Competitor Intelligence: noise filter, honest theme movements, full-width chart

Three refinements to the consolidated Competitor Intelligence tab:

- Noise filter: a competitor with no resolved page name is shown only when it has
  real current activity (live creative this period). Nameless pages that have gone
  dark, with only leftover behaviour or theme rows, are hidden rather than rendered
  as bare page-id cards, and competitors are ordered by current activity so nothing
  empty floats to the top.
- Honest theme movements: a theme is labelled faded or abandoned only when it has a
  real prior share and a real, lower current share (prior greater than current
  greater than zero). A theme simply absent from the current capture, or a
  competitor with too little history to compare, is no longer labelled as a decline
  it was never observed to make.
- Ad-age chart: rendered full width at the dashboard scale (wider viewBox, thin
  lines, standard axis label size) instead of a small capped box, with hover
  tooltips showing the competitor name and value.
