# f10-creative-dashboard-components

Shared CSS and JavaScript for F10 Netlify creative dashboards. Loaded by each dashboard via jsDelivr CDN — no build step required.

A dashboard is now just a config block plus script tags: the markup, styling, and all logic come from this library. The fastest way to start a new one is to copy the [`starter/`](./starter) folder.

## Files

| File | Purpose |
|---|---|
| `f10-shared.css` | All shared styles: layout, sidebar, controls bar, scorecards, badges, tables, charts |
| `f10-utils.js` | Formatters, constants (METRICS, STATE_META, thresholds), `classify()`, aggregation helpers, group/status filter helpers (`scopeWhere()`), ad-name search (`adNameAttr`, `filterRowsBySearch`, `refilterAllTables`), `scatterMaxSpend()` |
| `f10-weekly.js` | Weekly engine: fetchWindows, renderSummary/Board/Map, tab system, group filters, wireControls, initWeekly |
| `f10-monthly.js` | Monthly engine: loadPowerLaw/Production/Decay/Age + the `loadMonthlyTab()` dispatcher. All SQL is shared and config-driven |
| `f10-layout.js` | `renderLayout()` — builds the sidebar, controls bar, and all seven tab panels into `<div id="app"></div>`. Production benchmark copy is derived from the threshold constants |
| `f10-preview.js` | Inline creative hover previews for `.preview-link` targets; exposes `f10MediaMarkup({type,url}, opts)` — the shared `<img>`/`<video>` builder reused by the competitor tab |
| `f10-competitors.js` | Competitor Ad Library tab (probe-driven: appears automatically when the client has competitor rows in `all_clients_adlib`): groups a client's tracked competitor Meta ads by competitor in the F10 card layout, with per-competitor pagination that mounts only the visible page's media. Reuses `f10MediaMarkup` from `f10-preview.js` |

## How to use in a dashboard

The entire dashboard body is `<div id="app"></div>`. Define config, load the four scripts, then call `renderLayout(); wireControls(); initWeekly();`.

### 1. In `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.7.0/f10-shared.css" />
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
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.7.0/f10-utils.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.7.0/f10-weekly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.7.0/f10-monthly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.7.0/f10-layout.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.7.0/f10-preview.js"></script>
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

When an ad has more than one asset (dynamic creative, or a rebrand mid-flight),
the `media` action picks one representative asset the same way the creative audit
does (`audit.py` / `sql/creative_band_mining.sql`): the asset delivering the most
impressions (dominant in the per-asset `image_asset_insights` / `video_asset_insights`
feeds) wins first, then the most recently created asset, then one already stored in
the bucket, then newest by created time. Ads with no per-asset delivery data fall
back to recency, so previews degrade gracefully as that feed's history accrues.

`renderLayout()` generates all markup (including the `#ctrl-groups` / `#weekly-controls` containers), so dashboards no longer hand-maintain the HTML or the monthly loaders.

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
| `COMPETITORS` | no | Optional Competitor Ad Library overrides — the tab itself is automatic (see below) |

## Competitor Ad Library

Visibility is **probe-driven** — no per-client config is needed. On dashboard load, `f10-competitors.js` fires the shared function's cheap existence probe (`{ action:'competitor', client, probe:true }`, a BQ `EXISTS` on `ad_registry` — no snapshot-history scan) for the `f10_client` key derived from `DATASET` (a trailing `_marts` or `_clean` is stripped, e.g. `mosh_marts` → `mosh`). If the client has competitor rows in `all_clients_adlib`, a **Competitors** nav group and tab are injected; if not (or the probe errors), the module fails closed and leaves zero competitor trace in the DOM. Adding competitor rows in the warehouse is all it takes for the tab to appear on the next dashboard load.

The tab groups this client's tracked competitor Meta ads by competitor, in the F10 card layout — image inline / video with controls / carousel strip, plus ad copy, CTA, format, "Live since" date and longevity (days active + still-active). The tab no longer shows competitor vision attributes (hook / angle / format read); that vision data is consumed elsewhere, not on this dashboard, and the `competitor` action no longer queries `competitor_vision_attributes`. Each competitor paginates (Prev / Next) and only the visible page's cards mount their media, so only that page's signed creatives are fetched. Data is served by the shared function's data-driven `competitor` action, keyed by the resolved client key.

An **age-metrics header** (US-004) sits above the competitor sections when the age marts are present. A client summary strip shows competitors tracked, total live ads, average live-ad age (days, 1dp) and a four-segment age distribution (`<7d / 7–30d / 30–90d / 90d+`) with counts, read from `all_clients_adlib.competitor_age_by_client`. Each competitor's meta line is extended with its average live age and the same four bucket counts from `all_clients_adlib.competitor_age_by_page` (keyed by `page_name`). The `competitor` action returns these as `ageMetrics: { client, byPage }`. Both mart reads are absent-safe end to end: mart absent → no strip and the per-competitor lines render exactly as before; a competitor missing from `byPage` → that line is unchanged.

The shared function also exposes a **`competitor-search` action** (US-006) for term search across this client's competitor set: `{ action:'competitor-search', client, term }` returns the latest snapshot per matching ad, scoped `WHERE f10_client=@client`, with a case-insensitive `CONTAINS_SUBSTR` match over ad copy (`ad_creative_bodies`), link titles, `page_name`, `link_url`, `cta_type` and the vision `on_screen_text` (`competitor_vision_attributes`). Each ad carries a `matched_fields` array naming which fields hit, plus the same 15-min signed creative URLs as the `competitor` action (the private `gs://` URI is never returned). It fails closed exactly like the competitor tab — it accepts the same `{ probe:true }` existence check, and an empty or single-character `term` (or a client with no competitor rows) returns `{ ads: [] }` without a snapshot scan — and reuses the same `maximumBytesBilled` / `jobTimeoutMs` guardrails.

The shared function additionally exposes five **competitor-intelligence tab actions** (US-007) that power the new tabs, each a thin read over a governed `all_clients_adlib` mart, scoped `WHERE f10_client=@client`, with the same `{ probe:true }` existence check and `maximumBytesBilled` / `jobTimeoutMs` guardrails as the `competitor` action. Every one **fails closed**: a client whose mart has no rows — or whose mart does not physically exist yet — gets an empty payload (or `{ exists:false }`), never a 500; only a genuine table-not-found is treated as absent, every other BigQuery error surfaces loudly. No raw SQL and no `gs://` URI ever reach the browser; the frontend calls by action name only.

- **`themes`** (`{ action:'themes', client }` → `{ competitors }`) — the latest named-theme summary per competitor from `competitor_theme_summary` (US-001): structured `themes`, the `dominant_narrative`, `format_mix`, `common_phrases` and `analysis_confidence` (the full narrative, not a bare label, per the insight-ladder gate).
- **`age-timeseries`** (`→ { client, competitors }`) — the ad-age-over-time series from `competitor_age_over_time` (US-003), split into the client's own line and one series per competitor page, each carrying average **and** median live-ad age per month on one shared axis.
- **`maturity`** (`→ { client, competitors, set_size }`) — the explainable 0–100 Meta maturity score from `competitor_meta_maturity` (US-005): the `composite_score` returned **with** all six component `sub_scores`, the `raw_signals`, the data-layer-owned `maturity_tier` band label (rendered as-is, never re-banded) and each entity's `maturity_rank` within the client's set.
- **`leaderboard`** (`{ action:'leaderboard', client, limit? }` → `{ ads }`) — still-active competitor ads ranked by true live age (days since Meta stated go-live, else first observed) over `ad_registry` + `ad_snapshots`; returns the public Ad Library `snapshot_url` only (no creative signing). `limit` defaults to 25 and is capped at 100.
- **`net-new`** (`→ { ads, byPage, window }`) — brand-new competitor ads this period from `competitor_net_new_ads` (flagged `is_net_new`) plus the absent-safe per-competitor `net_new_count` rollup from `competitor_net_new_by_page` (US-004).

Under the **Competitors** nav group, `f10-competitors.js` injects up to four sub-tabs, each registered independently by its own probe so a client only sees the ones its data supports: **Competitor Ads** (the card grid above, with the US-008 term-search box over the `competitor-search` action), **Vision & Text** (US-009 — the per-competitor `themes` rollup, leading with the dominant angle), **Ad Age Over Time** (US-010 — an inline-SVG multi-line chart of average and median live ad age per month for every competitor plus the client's own line, from the `age-timeseries` action), and **Meta Maturity Score** (US-011 — see below). The age tab shares one monthly time axis and age definition across all lines; average vs median is a labelled toggle, the client line is the thick young-blood brand line, and the legend focuses a single competitor vs the client. It is probe-driven and absent-safe (hidden with zero DOM trace when `competitor_age_over_time` has no rows for the client) and emits `F10A.track('competitor.tab.age')` on activation (the Ads and Vision & Text tabs emit `competitor.search` / `competitor.tab.themes`). The chart reuses the framework's library-free inline-SVG charting approach (`retentionSparkline` in `f10-utils.js`) — no charting library is added.

The **Meta Maturity Score** tab (US-011) is the roll-up sub-tab: it ranks every tracked competitor **and the client** by an explainable 0–100 Meta maturity score from the `maturity` action (`competitor_meta_maturity` mart), sorted high-to-low with the client's row highlighted and its rank shown. Per the insight-ladder gate the composite is never a bare number — each row shows the composite **alongside** all six labelled component sub-scores (longevity, cadence, volume, active ratio, format diversity, platform spread) so the user can see what drives a high/low score, and a headline calls out the client's rank of the set and its tier. The **`maturity_tier`** band is rendered verbatim from the data layer and is never recomputed/re-banded in the frontend (`hq-classifier-own-labels-single-source`). The same panel also surfaces the **longevity leaderboard** (top live competitor ads by age, `leaderboard` action, public Ad Library `snapshot_url` only — no `gs://` leak) and the **refresh cadence + net-new alerts** (per-competitor `net_new_count` over the window plus flagged brand-new ads, `net-new` action). Maturity is the primary probe-gated surface; the leaderboard and net-new loads are secondary and degrade to their own empty state on failure (logged via `console.error`, never swallowed). It is probe-driven and absent-safe (hidden with zero DOM trace when `competitor_meta_maturity` has no rows for the client) and emits `F10A.track('competitor.tab.maturity')` on activation.

The **performance controls bar is hidden on the competitor tab** — its group filter, ad-name search, ad-status, window length, efficiency metric, noise floor and min-spend controls are irrelevant to competitor ads. `compSelectTab()` hides `#controls-bar` on activation, and `applyControlsVisibility()` (f10-weekly.js) checks whether `#panel-competitors` is active and keeps the bar suppressed, so a later weekly re-render (tab switch back, refresh, filter change) can't re-show it over the competitor tab.

`COMPETITORS` is an **optional overrides object** only:

```js
const COMPETITORS = {
  CLIENT:       'mosh', // optional f10_client override when DATASET doesn't follow {client}_marts / {client}_clean
  PER_PAGE:     30,     // optional; competitor cards shown per in-page page (default 30)
  MAX_PER_PAGE: 0,      // optional hard cap on ads rendered per competitor (0 = no cap)
};
```

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
