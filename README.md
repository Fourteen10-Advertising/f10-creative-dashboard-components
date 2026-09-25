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
| `f10-layout.js` | `renderLayout()` — builds the sidebar, controls bar, and every tab panel into `<div id="app"></div>` (Meta's eight, plus TikTok's and LinkedIn's eight each when those channels are configured). Production benchmark copy is derived from the threshold constants |
| `f10-preview.js` | Inline creative hover previews for `.preview-link` targets; renders a swipeable carousel when an ad has multiple cards. Exposes `f10MediaMarkup({type,url}, opts)` — the shared `<img>`/`<video>` builder reused by the competitor tab — plus `f10PreviewCards(media)` and `f10CarouselHtml(cards, idx)` |
| `f10-linkedin.js` | LinkedIn channel section (config-gated: a no-op unless the dashboard defines a `LINKEDIN` object). Adds a **LinkedIn** nav group with its own full eight-tab set — Weekly Summary / Movement Board / Movement Map, then Ad Power Law / Ad Production / Ad Decay / Ad Age / Creative Effectiveness — driven by the same shared query and render engines as TikTok with `li-` ids and state (see [Secondary-channel tab parity](#secondary-channel-tab-parity-tiktok--linkedin)). Two source modes: a **per-client LinkedIn mart** (with optional per-column `*_EXPR` overrides when the mart does not publish the contract verbatim), or the **shared `all_clients_linkedin_ads` dataset scoped by ad-account URN** for a client who has no mart of their own (see [LinkedIn channel](#linkedin-channel)) |
| `f10-competitors.js` | Competitor Ad Library tab (probe-driven: appears automatically when the client has competitor rows in `all_clients_adlib`): groups a client's tracked competitor Meta ads by competitor in the F10 card layout, with Status / Timeframe / Competitor filters, per-competitor pagination (20/page), and a metadata + on-demand creatives split that fetches only the visible page's signed media. Reuses `f10MediaMarkup` from `f10-preview.js` |
| `f10-components.js` | Component Scale tab (probe-driven: appears automatically when the client has a `{client}_marts.component_performance` mart): grades the five creative components (hook, format, CTA, message angle, visual style) against the client's own baseline, with lift, evidence count, confidence tier, the verbatim descriptive caveat, and a co-occurrence mark; plus the cross-client whitespace lane as a separate, clearly-labelled hypotheses section. Adds `f10ActivateTab()` (in `f10-layout.js`) as the single generic tab dispatcher (see [Component Scale](#component-scale)) |
| `f10-brief-editor.js` | Brief Editor tab (probe-driven: appears only when the client has a saved brief revision to edit): a canonical-constrained editor for the F10 internal review app. Loads a brief revision and saves a NEW one via the US-003 persistence contract (GCS `brief-revisions/{client}/{id}.json` + a `brief_revisions` BigQuery row). The four creative axes (visual style, hook, message angle, CTA) are dropdowns locked to the canonical vocabularies, so a non-canonical value can never be saved; copy is free text. (US-004 retired the dead Format axis: photo versus illustration is a visual_style concept and every ad is static for now; the `brief_revisions.format` column is kept for backward compatibility but is no longer edited or driven.) Dual-mode: the same file exports the persistence core behind an injectable writer seam for the brief backend (see [Brief editor](#brief-editor)) |
| `f10-review.js` | Creative Review tab (discovery-gated AND live-path safe: on boot it asks the backend `list-bundles` action which generated bundles exist for this client and registers the tab only when at least one is discovered). Bundles are **auto-discovered**, not configured. A **Generation** date dropdown groups the discovered bundles by generation date and defaults to the most recent; when a date has more than one bundle the view is a **grid of cards** in discovery order for human review: each card shows the composite thumbnail (from the US-005 `generated-preview` action), what the ad was built from, and its decision gate. A date with a single bundle shows the detail view (the ad, its copy, its held dimensions). Each ad also has a coarse **approve / decline** gate (US-009) that records the decision via the US-008 feedback write path and shows the persisted approved / declined / pending state on reload. Strictly additive: with no `BQ_FUNCTION` endpoint and no injected store it is a silent no-op (no network, no tab, zero DOM); a dashboard that has `BQ_FUNCTION` issues one `list-bundles` call on boot and shows the tab only if the client has generated bundles (see [Creative review](#creative-review)) |

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

### List generated bundles for a client (`list-bundles` action)

The Creative Review tab is no longer driven by a hardcoded config list: it asks this
action which generated bundles exist for the client, newest first, and reviews those.
`{ action:'list-bundles', client }` reads the shared bundle manifest
`mcc-poc-477801.all_clients.creative_manifest` (one row per generated component),
groups it to one row per `brief_id` (the bundle id), and returns
`{ client, bundles:[ { bundle_id, platform, date:'YYYY-MM-DD', generated_at, n_fetched, n_components } ] }`
ordered newest-first by `MAX(fetched_at)`.

Scope is `WHERE client=@client AND brief_id IS NOT NULL`, with the client passed as a
BOUND query parameter (no injection surface), and the read carries the same
`maximumBytesBilled` / `jobTimeoutMs` guardrails as every other action. It FAILS
CLOSED: a client whose manifest table does not exist yet returns a clean empty
`{ bundles: [] }` (200, never a 500), so the tab simply hides. Regression coverage
lives in `test/review-list-bundles.test.js`.

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
| `TIKTOK` | no | Optional TikTok channel section: `{ DATASET?, TABLE, CONV_EXPR?, REVENUE_EXPR?, THRESHOLDS?, AGE_BUCKET_EXPR? }`. `TABLE` is required — no `TABLE`, no TikTok nav group. `DATASET` defaults to the dashboard's `DATASET`, `CONV_EXPR` to `'conversions'`, thresholds to `HR 5000/$70 · OB 1000/$100 · SO 500/$140` (ROAS bands `4`/`2`/`1`). All **eight** tabs appear automatically; only `AGE_BUCKET_EXPR` is new and it is optional (see [Secondary-channel tab parity](#secondary-channel-tab-parity-tiktok--linkedin)) |
| `LINKEDIN` | no | Optional LinkedIn channel section. Two mutually exclusive modes — a per-client mart (optionally with per-column `*_EXPR` overrides for a mart that does not publish the contract verbatim), or the shared `all_clients_linkedin_ads` dataset scoped by `ACCOUNT_URN`. Defining the object at all is the gate (no `TABLE` required). All **eight** tabs appear automatically; the only new optional key is `AGE_BUCKET_EXPR`. See [LinkedIn channel](#linkedin-channel) and [Secondary-channel tab parity](#secondary-channel-tab-parity-tiktok--linkedin) |
| `CREATIVE_SCORE_CONFIG` | no | Creative Score weights, maturity target, per-rate quality ceilings and band cutoffs (see [Creative Score column](#creative-score-column)) |
| `COMPETITORS` | no | Optional Competitor Ad Library overrides — the tab itself is automatic (see below) |
| `COMPONENTS` | no | Optional Component Scale overrides; the tab itself is automatic (see [Component Scale](#component-scale)) |
| `STATE_LABELS` | no | Rename ad states for display, e.g. `{ 'Dropped Off': 'Zero Spend' }`. Display only, the internal keys never move (see [Ad state labels and hover definitions](#ad-state-labels-and-hover-definitions)) |
| `STATE_DEFINITIONS` | no | Override the built-in hover wording for any ad state |
| `METRIC_DEFINITIONS` | no | Override the built-in hover wording for any metric or graded tier |
| `SHOW_DEFINITIONS` | no | Set `false` to turn all hover definitions off. Default on |
| `SHOW_ZERO_SPEND_FILTER` | no | Set `true` to add the zero-spend control to the controls bar (see [Zero-spend filter](#zero-spend-filter)) |
| `SHOW_STATE_FILTER` | no | Set `true` to add an ad-state dropdown that narrows the Movement Board to one state (see [Movement Board state filter](#movement-board-state-filter)) |
| `FULL_COVERAGE_TIERS` | no | Set `true` to grade every ad into one of five tiers that sum to 100% of the ad base (see [Full-coverage tiers](#full-coverage-tiers)) |
| `THRESHOLDS_BY_GROUP` | no | Per-product Ad Production thresholds, e.g. grade SMSF ads on a different cost scale than Trade (see [Per-product thresholds](#per-product-thresholds)) |
| `REVIEW` | no | F10-internal Creative Review surface only. The bundle list is now **auto-discovered** via the `list-bundles` action, so this block no longer carries `BUNDLES` or `LIMIT` and is effectively optional/empty; it holds only optional overrides (`CLIENT` slug override, `ACTOR`, `FEEDBACK_FUNCTION`). Live client dashboards never define it (see [Creative review](#creative-review)) |

## Secondary-channel tab parity (TikTok + LinkedIn)

Meta has eight tabs. TikTok and LinkedIn — the framework's two optional secondary
channels — now have the **same eight**, in the same order, with the same nav grouping:

| | Weekly | | Monthly | | | | |
|---|---|---|---|---|---|---|---|
| **Meta** (`Meta - Weekly` / `Meta - Monthly`) | Weekly Summary · Movement Board · Movement Map | | Ad Power Law · Ad Production · Ad Decay · Ad Age · Creative Effectiveness | | | | |
| **TikTok** (`TikTok - Weekly` / `TikTok - Monthly`) | same, `tt-` ids | | same, `tt-` ids | | | | |
| **LinkedIn** (`LinkedIn - Weekly` / `LinkedIn - Monthly`) | same, `li-` ids | | same, `li-` ids | | | | |

**No new config is needed.** Configure `TIKTOK` (or `LINKEDIN`) exactly as before and all
eight tabs appear; a dashboard already running either channel gets Movement Map, Ad Power
Law, Ad Decay and Ad Age on the next version bump with **zero** config changes. Every
channel's nav group is split by two explicitly-labelled `nav-section` dividers —
`{Channel} - Weekly` / `{Channel} - Monthly` — the same `-` separator and shape as Meta's
own `Meta - Weekly` / `Meta - Monthly` headers. Note this does relabel an existing
TikTok/LinkedIn dashboard's first nav header (from the bare channel name to
`{Channel} - Weekly`) on the next version bump — a deliberate, requested change, not
config-gated.

The one new (optional) key is `AGE_BUCKET_EXPR`, described below.

### What each new tab does

- **Movement Map** — the Movement Board's ads as a bubble chart: x = current-window
  spend, y = % change in the active efficiency metric vs the prior window, bubble size =
  spend, colour = ad state. It issues **no query at all**: it re-reads the same `movers`
  array the Weekly Summary and Movement Board already compute from the single
  per-window fetch, so it is free and always consistent with the Board.
- **Ad Power Law** — every ad ranked by its share of channel spend over the last 90 days,
  with a rolling cumulative line. Ads with **no spend inside the window** are not ranked
  (they contribute nothing to a concentration read and would otherwise take a rank with a
  blank spend).
- **Ad Decay** — launch-month cohorts: ads launched, average days running, cohort spend
  and cohort efficiency, plus the daily spend curve per cohort in absolute dollars and as
  a % share.
- **Ad Age** — daily spend mix across the 0–14 / 15–90 / 90+ day age buckets, plus the
  per-ad library sorted by lifetime spend.

Everything is metric-aware in the usual way: in ROAS mode the efficiency column becomes
`lifetime_roas`, reads the gated revenue column, and CPA-mode marts are never queried for
a revenue column at all.

### Two shape divergences from the Meta SQL, and why

The Meta mart publishes two columns the normalised TikTok and LinkedIn contracts do not:

1. **`max_date`.** Meta's Ad Decay and Ad Age read a precomputed per-ad last-active date.
   The secondary channels derive it as `MAX(date_start)`. For Ad Decay that means the
   cohort summary collapses to one row per ad in a `per_ad` CTE **before** rolling up by
   launch month — which also makes "avg days running" a true per-ad average rather than
   one weighted by how many daily rows each ad happens to have.
2. **`creative_age`.** See below.

### Ad Age: why the bucket is derived

Meta's Ad Age tab reads a precomputed `creative_age` label column. TikTok and LinkedIn
**derive** the bucket in SQL from days since launch instead:

```sql
CASE WHEN DATE_DIFF(date_start, min_date, DAY) <= 14 THEN '0–14 Days'
     WHEN DATE_DIFF(date_start, min_date, DAY) <= 90 THEN '15–90 Days'
     ELSE '90+ Days' END
```

This is the same thing `creative_age` encodes, computed fresh. The reasons, in order of
weight:

1. **`creative_age` is not in either contract, and on LinkedIn it cannot be.**
   Shared-account mode (Mode 2) builds its rows from the raw LinkedIn API tables, which
   have no age column at all, and a Mode 1b normalising wrapper only passes contract
   columns through. Deriving is the only rule that gives all three LinkedIn source modes
   the same tab. TikTok's contract does not define one either.
2. **A mart is not required to publish it.** A tab that depended on the column would
   break on a lean mart rather than degrade.
3. **It costs nothing in accuracy.** Verified 2026-09-16 against Skip's real mart
   `mcc-poc-477801.skip_marts.linkedin_creative_reporting`: the derived bucket reproduces
   that mart's own `creative_age` on **1,469 of 1,469 rows (100%)**, with the
   0-7 / 8-14 / 15-30 / 31-60 / 61-90 / 90+ boundaries landing exactly where `DATE_DIFF`
   puts them.

**The Meta engine is unchanged** — `f10-monthly.js` still reads the Meta mart's
`creative_age` column. This is a secondary-channel divergence only.

#### `AGE_BUCKET_EXPR` — the escape hatch

A client who wants their mart's own bucketing instead sets a raw SQL expression that must
evaluate to one of the three bucket labels:

```js
const LINKEDIN = {
  // ...
  AGE_BUCKET_EXPR: "CASE WHEN creative_age IN ('1. 0-7 Days','2. 8-14 Days') THEN '0–14 Days' "
                 + "WHEN creative_age IN ('3. 15-30 Days','4. 31-60 Days','5. 61-90 Days') THEN '15–90 Days' "
                 + "ELSE '90+ Days' END",
};
```

`TIKTOK.AGE_BUCKET_EXPR` works identically. Both are pasted **verbatim** (the same
trusted-config escape hatch as the Mode 1b `*_EXPR` overrides) and are evaluated against
the **resolved source**, so the expression may only name columns that source emits: any
mart column when the mart is read bare (LinkedIn Mode 1, or TikTok), but only
**normalised contract columns** once a Mode 1b wrapper or shared-account mode is in play.
A client who needs a precomputed age column *and* column overrides at the same time
should map the age column into the contract in the mart itself.

A blank, missing or non-string value falls back to the derived default.

### Verification status

- **LinkedIn** — every generated query was **dry-run and executed live** against Skip's
  real mart through Skip's real Mode 1b override set.
- **TikTok** — there is currently **no real TikTok data anywhere in the BigQuery
  project**, so the TikTok queries are verified by BigQuery dry-run against a synthetic
  source declaring the contract schema (parse, type-check and column resolution, in both
  CPA and ROAS mode) plus the `test/tiktok-monthly-parity.test.js` suite. The **numbers**
  are unverified until a real TikTok mart exists.

### Fixed: sub-dollar CPA/CPC values rounding to `$0`/`$1`

Live-testing LinkedIn's Ad Production and Ad Decay tabs against Skip's real data
surfaced a display bug: `fmt$()` hardcoded whole-dollar rounding, so a genuine sub-dollar
figure (Skip's real cost-per-click ran $0.10-$0.67 for several creatives) rounded to
`$0` or `$1` and read as missing or free rather than as a very cheap, very good number.
Fixed by mirroring the same `<$10 → 2dp` threshold `fmtMetric()`'s `money` branch already
used for ROAS: values under $10 now show two decimal places (`$0.10`, `$6.83`); $10 and
over stay whole-dollar, so every existing dashboard's ordinary spend/CPA figures render
byte-for-byte unchanged. Covered by `test/sub-dollar-formatting.test.js`.

## LinkedIn channel

`f10-linkedin.js` adds LinkedIn as an optional **third channel**, alongside Meta (the
built-in default) and TikTok. It is gated exactly like TikTok: no `LINKEDIN` config
object in the dashboard's `index.html` and the module, the nav group and the panels do
not exist, so every existing Meta-only and Meta+TikTok dashboard is unaffected even
though the script tag is present. When `LINKEDIN` is defined, a **LinkedIn** nav group
appears under TikTok with the same **eight** tabs Meta has — **Weekly Summary**,
**Movement Board**, **Movement Map**, then **Ad Power Law**, **Ad Production**,
**Ad Decay**, **Ad Age**, **Creative Effectiveness** — driven by the same shared query,
classification and render engines, with its own `li-` ids and state. See
[Secondary-channel tab parity](#secondary-channel-tab-parity-tiktok--linkedin) for what
the four non-original tabs do and the one new config key they introduce.

### Two config modes — pick the one that matches the warehouse

TikTok assumes every client has a per-client mart (`{client}_marts.tiktok_creative_reporting`).
**LinkedIn does not work that way.** Some clients have no LinkedIn mart at all: their
spend sits in a shared, multi-client dataset and is separable only by ad-account URN.
Both shapes are supported and a client is in exactly **one** of them.

#### Mode 1 — per-client mart (the TikTok-shaped default)

```js
const LINKEDIN = {
  DATASET:   'acme_marts',                  // optional; defaults to the dashboard's DATASET
  TABLE:     'linkedin_creative_reporting', // optional; this is the default
  CONV_EXPR: 'conversions',                 // optional; defaults to 'conversions'
  THRESHOLDS:{ HR_SPEND: 2000, HR_CPA: 150, OB_SPEND: 750, OB_CPA: 250, SO_SPEND: 300, SO_CPA: 400 },
};
```

When the mart publishes the [normalised LinkedIn column contract](#normalised-linkedin-column-contract)
verbatim, that is the whole config: the builder reads the table directly and nothing in
Mode 1b applies.

#### Mode 1b — per-client mart with column overrides (`*_EXPR`)

Real marts are rarely built to somebody else's contract. Rather than force every client's
warehouse into one rigid shape (or make them fabricate columns they have no data for),
the contract columns a lean mart most often lacks each accept an optional **raw SQL
expression** override on `LINKEDIN`:

| Override key | Contract column it supplies |
|---|---|
| `AD_ID_EXPR` | `ad_id` |
| `AD_NAME_EXPR` | `ad_name` |
| `CAMPAIGN_NAME_EXPR` | `campaign_name` |
| `ADGROUP_NAME_EXPR` | `adgroup_name` |
| `LANDING_PAGE_CLICKS_EXPR` | `landing_page_clicks` |
| `ONE_CLICK_LEADS_EXPR` | `one_click_leads` |
| `REVENUE_EXPR` | `revenue` (ROAS mode only — the same key the engine already used) |
| `VIDEO_STARTS_EXPR` | `video_starts` |
| `VIDEO_P25_EXPR` / `VIDEO_P50_EXPR` / `VIDEO_P75_EXPR` / `VIDEO_P100_EXPR` | the video quartiles |

> `AGE_BUCKET_EXPR` is **not** in this table. It does not supply a contract column — it
> replaces the Ad Age tab's bucketing expression outright, and it works in every source
> mode. See [Ad Age: why the bucket is derived](#ad-age-why-the-bucket-is-derived).

Set **any** of them and the builder stops reading the table bare and wraps it in a
normalising subquery — exactly what shared-account mode already does — aliasing each
expression to its contract name, so every tab below stays mode-agnostic. Each value is
pasted **verbatim** into the SELECT list (the same escape hatch as Mode 2's
`CREATIVE_REF_EXPR`), so it can be:

- a differently-named column — `AD_ID_EXPR: 'creative_id'`;
- a real expression — `AD_NAME_EXPR: "COALESCE(NULLIF(creative_name, ''), creative_id)"`;
- a literal for a metric the mart genuinely does not carry — `VIDEO_P25_EXPR: 'NULL'`,
  `ONE_CLICK_LEADS_EXPR: '0'` — so the tab renders an honest blank instead of the query
  erroring on a missing column.

These values come from the dashboard's own trusted config code, never from user input,
and are **not** escaped or validated — treat them like any other line of the dashboard's
source. (`ACCOUNT_URN` is the one value that *is* sanitised, because it is a bare
identifier with a known alphabet.)

**Omit an override and the column keeps its contract name**, so a client whose mart does
publish the contract needs no config change and generates the same SQL as before.

The columns with **no** override are the ones no LinkedIn mart is useful without, and
stay mandatory: `date_start`, `min_date`, `lifetime_spend`, `spend`, `impressions`,
`clicks`, `conversions`, `video_views`, `creative_link`. `CONV_EXPR` and `REVENUE_EXPR`
are read **after** normalising, so when overrides are active they must name a *contract*
column (e.g. `CONV_EXPR: 'clicks'`), not a raw mart column the wrapper does not emit.

##### Worked example — Skip's real mart, and why this mode exists

`mcc-poc-477801.skip_marts.linkedin_creative_reporting` is Skip's own creative-level
LinkedIn mart, built for Skip's Growth dashboard. It parallels Skip's Meta mart in spirit
(same precomputed `lifetime_spend` / `lifetime_cpa` / `creative_age` pattern) but is
leaner, and it is **not** the contract: it keys on `creative_id` with no `ad_id`, carries
an always-empty `creative_name` and a `campaign_id` with no `campaign_name`, and has no
ad-group, outbound-click, lead, revenue or video-quartile columns at all.

```js
const LINKEDIN = {
  DATASET: 'skip_marts',
  TABLE:   'linkedin_creative_reporting',
  AD_ID_EXPR:               'creative_id',      // no ad_id; creative_id is the key
  AD_NAME_EXPR:             'creative_id',      // creative_name is '' on every row
  CAMPAIGN_NAME_EXPR:       'campaign_id',      // no campaign_name column
  ADGROUP_NAME_EXPR:        "'(no ad group)'",  // no ad-group level at all
  LANDING_PAGE_CLICKS_EXPR: 'clicks',           // no outbound-only click column
  ONE_CLICK_LEADS_EXPR:     'NULL',
  VIDEO_STARTS_EXPR:        'NULL',
  VIDEO_P25_EXPR: 'NULL', VIDEO_P50_EXPR: 'NULL',
  VIDEO_P75_EXPR: 'NULL', VIDEO_P100_EXPR: 'NULL',
  CONV_EXPR: 'clicks',                          // `conversions` is 0.0 on every row
  THRESHOLDS: { HR_SPEND: 2000, HR_CPA: 1, OB_SPEND: 750, OB_CPA: 2, SO_SPEND: 300, SO_CPA: 5 },
};
```

which generates, as the source every tab then reads:

```sql
(
      SELECT
        creative_id AS ad_id,
        creative_id AS ad_name,
        campaign_id AS campaign_name,
        '(no ad group)' AS adgroup_name,
        creative_link, date_start, min_date, lifetime_spend,
        spend, impressions, clicks,
        clicks AS landing_page_clicks,
        conversions,
        NULL AS one_click_leads,
        NULL AS video_starts,
        video_views,
        NULL AS video_p25, NULL AS video_p50, NULL AS video_p75, NULL AS video_p100
      FROM `mcc-poc-477801.skip_marts.linkedin_creative_reporting`
    )
```

Two consequences worth reading before copying any of it:

- **A blanked video quartile makes the whole creative read as a static.** Skip has real
  `video_views` but no quartiles, so Hold % and Completion % render `–` and the Creative
  Score's `hasVideo` gate is false. That is the honest read — without quartiles there is
  no video-quality signal to score — but it means video creatives are scored on the
  static baseline, not flattered by a partial one.
- **`THRESHOLDS` are not inheritable across override sets.** The moment `CONV_EXPR`
  points at a different metric, the `*_CPA` bands mean a different thing: Skip's Ad
  Production tab reads as **cost per raw click**, not cost per conversion. The LinkedIn
  defaults (150 / 250 / 400, set for a conversion) would classify Skip's entire account
  Home Run — its real per-creative cost per click runs **$0.10–$48.67**, median ≈ $3.75.
  Always pull the real per-creative distribution of the metric you actually chose and set
  the bands off that. The numbers above are Skip's, from Skip's data, and are not a
  template.

#### Mode 2 — shared account (`ACCOUNT_URN`)

```js
const LINKEDIN = {
  ACCOUNT_URN: 'urn:li:sponsoredAccount:510299552',  // 'Sucasa Ad Account' (Skip)
  PROJECT:     'mcc-poc-477801',        // optional; defaults to the dashboard's PROJECT
  CONV_EXPR:   'landing_page_clicks',   // optional; defaults to 'conversions'
  THRESHOLDS:  { HR_SPEND: 2000, HR_CPA: 25, OB_SPEND: 750, OB_CPA: 40, SO_SPEND: 300, SO_CPA: 60 },
};
```

**When `ACCOUNT_URN` is set, `DATASET` and `TABLE` are ignored** — shared-account mode
always wins. The SQL builder reads `{PROJECT}.all_clients_linkedin_ads` directly
(`SHARED_DATASET` overrides the dataset name; `PROJECT` overrides the project) and
normalises it into the same column contract a per-client mart publishes, so every tab
below that line is mode-agnostic.

This is the real **Skip** case, and it is why the mode exists: Skip's LinkedIn ad data
is in **no `skip_*` dataset**. It runs through a shared ad account labelled
*Sucasa Ad Account* (`urn:li:sponsoredAccount:510299552`) in
`mcc-poc-477801.all_clients_linkedin_ads`, so a Skip query that only reads Skip's own
marts silently omits LinkedIn entirely.

The shared-account query, verified against that live account:

- creative-level rows come from `ad_creative_analytics` at `pivot = 'CREATIVE'`, one row
  per creative per day (`start_date` = `end_date`), joined to `creatives` on the
  **trailing numeric id** of `sponsoredCreative` and `creatives.id` — both sides are URN
  strings, so a raw string equality returns nothing;
- `creatives` is scoped `WHERE account = '<ACCOUNT_URN>'`, and `campaigns` joins on the
  numeric id of `creatives.campaign` with the same account scope;
- spend is **`costInLocalCurrency`**, already in the client's local currency (e.g. AUD)
  — do **not** re-convert it and do not use `costInUsd`;
- the creative permalink is
  `CONCAT('https://www.linkedin.com/feed/update/', creatives.content.reference)`
  (`content` is a JSON column, so the framework reads it with
  `JSON_EXTRACT_SCALAR(content, '$.reference')`; override with `CREATIVE_REF_EXPR` if a
  future sync lands it as a STRUCT);
- `lifetime_spend` and `min_date` are window functions computed **inside** the
  normalising subquery, so they stay true lifetime values even when an outer query
  filters to a window — matching what a per-client mart precomputes;
- `ACCOUNT_URN` is sanitised to the LinkedIn URN alphabet before it is inlined.

### Normalised LinkedIn column contract

Every mode presents these columns, one row per creative per day. Build a per-client mart
to this contract and Mode 1 works with no further config; a mart that cannot publish one
of them verbatim maps or blanks it with the [Mode 1b `*_EXPR` overrides](#mode-1b--per-client-mart-with-column-overrides-_expr)
rather than fabricating the column.

```
ad_id, ad_name, campaign_name, adgroup_name, creative_link,
date_start (DATE), min_date (DATE), lifetime_spend,
spend, impressions, clicks, landing_page_clicks,
conversions, one_click_leads, revenue,
video_starts, video_views, video_p25, video_p50, video_p75, video_p100
```

LinkedIn has no ad-group level, so `adgroup_name` carries the campaign's
`objectiveType` (the nearest structural analogue, and a genuinely useful split); the
Ad Production table labels that column **Objective**. `creatives.name` is present but
empty on real rows, so `ad_name` falls back to the campaign name and then to the
creative id rather than rendering blank.

### Metrics: what LinkedIn measures differently

The `linkedin` entry in `PLATFORM_PROFILES` (`f10-utils.js`) maps the generic rate names
onto LinkedIn's columns:

| Rate | LinkedIn column | Why |
|---|---|---|
| Hook / **View %** | `video_views` | LinkedIn's own view gate is 2 continuous seconds with the post at least half in view — a genuine thumbstop analogue, closer to TikTok's 2s than to a Meta play |
| **Hold %** | `video_p50` | LinkedIn has no time-based hold, so hold is the midpoint (50% watched) quartile |
| Completion | `video_p100` | |
| Plays (video gate) | `video_starts` | |
| **Out CTR** | `landing_page_clicks` | LinkedIn's raw `clicks` counts every click on the unit (profile, reactions, expands) and runs ~8% of impressions on live data. Outbound CTR is the honest intent read — the tabs show both, with outbound called out |

The Creative Score uses the same per-platform ceiling mechanism as Meta and TikTok
(`liScoreOpts()`): `{ hook: 110, hold: 9, ctr: 0.3, completion: 4.5 }`, calibrated so a
median LinkedIn video centres near 0.5. The score's CTR input is the **outbound** rate,
and the hover breakdown is fed the same outbound rate so it explains the score it sits
next to.

| Platform | hook | hold | ctr | completion |
|---|---|---|---|---|
| LinkedIn | 110 | 9 | 0.3 (outbound) | 4.5 |

### Thresholds

LinkedIn Ad Production bands deliberately **do not** inherit the Meta/TikTok defaults:
LinkedIn runs at a far smaller spend per creative and a far higher cost per action, so
a `HR_SPEND` of `$5,000` would admit about one creative on a real account. The defaults
(`LI_THRESHOLD_DEFAULTS` in `f10-utils.js`) are:

```
HR_SPEND 2000 / HR_CPA 150 · OB_SPEND 750 / OB_CPA 250 · SO_SPEND 300 / SO_CPA 400
ROAS bands HR 4x / OB 2x / SO 1x
```

Treat these as a starting point, not a truth — set `LINKEDIN.THRESHOLDS` per client.

### Choosing `CONV_EXPR`

On the shared tables `conversions` is `externalWebsiteConversions`, which is **zero** on
a brand / thought-leadership LinkedIn account (it is zero today on the Sucasa account).
Check the column before trusting any CPA, and where there are no conversions use the
funnel-entry proxy the Skip creative review used — `CONV_EXPR: 'landing_page_clicks'`,
with the CPA thresholds re-based on cost per landing-page click.

### Previews

LinkedIn creative media is **not** in F10's creative-asset bucket — the warehouse carries
only the post URN, not the media bytes — so a LinkedIn preview link always degrades to
the metrics panel plus a click-through to the post permalink ("Opens on LinkedIn"), the
same fallback path Meta and TikTok use for an unstored asset.

### ROAS

The section is metric-aware like the others: with `TARGET_METRIC = 'roas'` the dropdown,
classification, scatter, tables and copy switch to ROAS against `HR_ROAS`/`OB_ROAS`/
`SO_ROAS`, reading `LINKEDIN.REVENUE_EXPR` (default `REVENUE_EXPR`), and the
revenue-integrity guard covers the LinkedIn tabs too. LinkedIn is almost always a
lead-gen / CAC channel, so CPA (the default) is the right lens for it.

Regression coverage lives in `test/linkedin-channel.test.js`.

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

`f10-brief-editor.js` adds a **Brief Editor** tab for the F10 internal review app. The tab is laid out as a **numbered top-to-bottom flow** so an operator builds a brief in reading order. At the top of the panel are the **two Phase 3 pickers (US-022)** — a **Source** and a **Render** — that replace the earlier three pickers (the From scratch / From inspiration mode toggle, the image/typeset format picker, and the layout picker):

- **Source** (a single dropdown) is where the layout **structure** comes from: **Auto (top performer)** — the client's top mined winner; **This client's winning layouts** — a specific mined winner; **Explore — untested** — a hand-authored preset, each shown as its own labelled, choosable row so a family with more than one preset lists each sub-format separately (this is how the former "design formats" survive, as typeset presets); or **Inspiration — replicate an ad** — the detected structure of a chosen reference ad. It is populated from the review backend's `/bq` **`list-sources`** action.
- **Render** is a **scene** / **typeset** toggle: scene draws a generated background with the copy laid over it; typeset draws a designed layout with no image model. It defaults from the chosen source's `default_render` and the operator can override it for any source.

When a source is chosen, its `structure` is drawn immediately as a **wireframe** under the picker (one labelled box per region, at its proportional position, with the repeat range where present), so the layout is visible **before** compile. The rest of the flow is: **(1) creative axes** (the four canonical dropdowns; hidden for an inspiration source, whose copy is auto-written), **(2) creative direction** (optional free text; relabelled **What you want** for an inspiration source), **(3) inspiration references** (upload / your library / competitors), and **(4) compile brief** (the primary action; "save as new revision" sits beside it as an optional secondary action), then **the compiled result**. Copy is **not** entered before compile: it is written per region and edited in the per-region editor that appears in the compiled result (see Per-region structure editor below), so the operator writes copy against the layout they actually land on rather than against fixed headline/subhead/cta slots. Loading an existing revision to edit is an optional starting point shown above the flow.

`buildCompileRequest` emits a **`source: {kind, ref}`** (`kind` one of `winner` / `explore` / `inspiration`; `ref` empty for Auto, the archetype id for a specific winner, the preset/family for explore, and the chosen reference uri for inspiration) plus a **`render`**, never the retired `archetypeId` / `format` / `beLayout`. The live on-screen brief still rides along as an inline `brief` doc (a winner/explore source sends the axes + copy verbatim; an inspiration source omits them for the backend to fill), alongside `creativeDirection` and `baseInspirationImageUris`. Steering the brief and saving a **new** revision lets a brief be steered before generation spends without breaking the canonical vocabularies. **Compile** resolves the on-screen brief with NO spend and returns, per variant, the resolved **`structure` + `region_copy`** (plus **`scene_prompts`** for a scene render, and its `source`, `render`, `layout_family`), the target sizes and a cost estimate against the remaining cap. An **explore** pick compiles as its design **format** instead: the variant carries the drafted **`design_spec`** (the format's own typed content, such as a search result's URL, title and snippet, and no `structure`) with its copy as editable fields, and `readCompiledBrief` echoes that `design_spec` back so Submit publishes exactly the compiled format with the edits applied. For a format, `typeset` is the format on the brand field and `scene` is the same format over one generated photo. A compiled result belongs to one source, render, set of axes and set of attached inspiration images: changing any of them afterwards drops it and hides the submit bar until the new choice is compiled (Submit re-checks this too), so Generate never publishes a stale compile. A direction change is not stale: it rebuilds the shown prompts instead (see Generation prompt below). The request also carries **`referenceSource`** (`competitor`, `client` or `upload`, from where the lead inspiration image came from), so a competitor reference is treated as loose direction with the no-copy guard on its prompts. **Submit** then runs generation server-side on the review backend (the US-001 in-process worker-thread model), enforcing the hard spend cap BEFORE anything runs plus a no-concurrent-run guard; results land back in the panel as thumbnails (see Viewable results below) and the approved brief is saved as a new revision so every run is reproducible. That revision id can alternatively be generated from the CLI (see After save below).

**The contract (US-003, already merged in the Python pipeline).** A brief revision persists as a JSON document in GCS at `gs://f10-creative-assets/brief-revisions/{client}/{revision_id}.json` plus a registry row in `mcc-poc-477801.creative_pipeline.brief_revisions`. It carries the four canonical axes (plus a retained `format` field / column for backward compatibility, no longer edited or driven after US-004), the copy blocks as free text, and provenance (client, evidence source, winning values, revision id). The axis vocabularies in this module **mirror `brief.py` / `brief_revision.schema.json` exactly** and a test asserts they stay in lockstep: the whole point of the editor is that it cannot emit a non-canonical value.

**Never non-canonical.** The four axes (**visual style, hook type, message angle, CTA type**) are edited through `<select>` dropdowns whose options are exactly the canonical enums, so a free-text axis value is not reachable in the UI. (US-004 retired the dead Format axis; it is no longer rendered or edited.) The save path validates a second time and rejects any axis value outside its vocabulary before anything is written, so even a tampered DOM cannot persist an off-vocabulary value. Copy is captured as free text.

**Creative direction (free-form, not an axis).** Alongside the axes and copy, the editor has a free-text **Creative direction** box that steers the generated *picture only, never the copy* — e.g. "the people shown have a higher BMI / are plus-size" or "minimal, one person talking to a doctor". It persists on the revision as `creative_direction`, plus an optional `inspiration_image_uris` array of `gs://` reference images the generation engine conditions on. Both are free-form (not canonical axes) so they skip vocab validation; they mirror the Python `BriefRevision` and the `brief_revision.schema.json` (which declares them, `additionalProperties:false`). The generation engine already reads both. For an **Inspiration** source this same box becomes the primary **What you want** prompt (its heading and sub-line are relabelled live) — the operator describes the ad they want, any copy and any changes — while the axes and copy are auto-generated server-side.

**Inspiration picker (upload + client/competitor libraries).** Below the direction box, an inspiration picker populates `inspiration_image_uris` three ways: **drag-drop / browse upload** (PNG/JPG/WebP up to 8 MB — stored content-addressed under `inspiration/{client}/` and de-duped), **Your library** (the client's own served creatives), and **Competitors** (the client's competitor ads from the Meta ad library). Selected references show as removable thumbnails and carry through a re-save. The picker reads its lists from the review backend's `/bq` `list-references` action and uploads through `/upload`; both are token-scoped to the client, so a picker can never surface or store another tenant's images. References seeded from a loaded revision are shown pre-selected. Each library source is best-effort: one the backend cannot read yet (e.g. the competitor dataset before its grant) simply shows an empty note rather than breaking the panel.

**Per-region structure editor (US-022).** After Compile, each variant that carries a `structure` renders as its **structure wireframe** plus one editable row per region: the region's copy inline, **repeat groups** with add / remove within their `[min,max]` range, and **nudgeable boxes** (x, y, w, h in 0..1). Every edit updates the per-variant working copy, and `/submit` sends exactly that — the edited **`structure` + `region_copy`** per variant (with `brief_id` so the backend matches each approved variant). This one editor replaces both the earlier reference-blueprint editor and the per-format design-fields editor. A legacy compile response with **no** `structure` falls through to the earlier flat prompt/copy editor unchanged.

**Per-region direction (what to generate).** Each region the backend will **generate** an image for shows a **Direction (what to generate)** textarea in its row, with the prompt that direction produces directly under it, so the operator can steer each element of the ad separately rather than only the whole scene (e.g. "the hero is a man in his 40s eating a burger" while the background stays a clean studio). Which regions generate is the backend's call, never guessed from the role: they are exactly the regions listed in the variant's `scene_prompts` (background, hero, person or product shot on a scene render; none on a typeset render). A logo or avatar is a brand asset, so its row says it is not generated and offers no direction. Copy regions get no direction field. Direction is keyed by region id in one **shared map** (the structure, and so the regions, is the same across variants, and the backend applies one direction map across the whole variant matrix), and it rides both the compile and submit requests as **`regionDirection`** ({region id: direction}); a blank direction is dropped rather than sent empty. It persists on the revision as **`region_direction`** (mirrored in the Python `BriefRevision` and `brief_revision.schema.json`, values constrained to strings), so re-opening a saved brief seeds the fields. The whole-picture **Creative direction / What you want** box above reaches every generated image too: it is the subject of any region with no direction of its own, and an overall line for a region that has one.

**Generation prompt (what will generate).** Every variant that generates imagery surfaces the exact **image prompt** each image is sent with, as an editable **Prompt sent to the image model** textarea: under its region for a structured variant, or on the card for a design format's photo (`image_slot_0`). `/compile` returns them as **`variant.scene_prompts`** (`[{region_id, role, prompt}]`), built by `generate.resolve_scene_prompts`, the same function generation uses to build what it sends, so what is shown is what generates. Changing a direction (a region's, or the Creative direction) rebuilds the shown prompts with a no-spend compile when the field loses focus; copy, box and repeat edits are untouched. Typing in a prompt **pins** it: `readCompiledBrief` sends back **only the pinned prompts** as `variant.scene_prompts`, and the backend uses each verbatim for its region (still carrying the competitor no-copy guard). Every other prompt is rebuilt by the backend from the current direction at generation, so a direction typed after compiling is never frozen out by the compiled text. A later direction change for a region unpins its prompt. A **typeset** render has no image prompt, so nothing is shown or sent.

**Inspiration confirmation (US-022).** For an **Inspiration** source, Compile returns the reference ad's **detected structure** (a low-confidence detection has already fallen back to its family preset on the backend). Before generating, the editor shows a **confirmation gate**: the detected structure as a wireframe and a **Confirm & continue** button. The submit bar stays hidden until the operator confirms; confirming reveals the per-region editor. No picker-derived layout is ever applied in inspiration mode: the request carries `source:{kind:"inspiration", ref:<chosen reference uri>}` and never a winner/explore layout. The reference's own copy and brand never transfer; its image does condition generation, so the prompts match its look (a competitor reference as loose direction only, with the no-copy guard), and the client's brand and copy are applied at generation. The inspiration picker still marks which statics already carry a structural row (a small **structure** badge) versus one analysed on demand (an **on-demand** badge).

Previews are large (225px grid cells) so creatives are actually legible. **Your library** is ranked by lifetime spend (highest first) and paginated with a **Load more** button, 10 ads at a time. **Competitors** are grouped per competitor and ranked by how established each is (the ad-library maturity `composite_score` — a blend of ad volume, longevity, refresh cadence and active ratio); each competitor shows its first 5 images with its name and maturity tier, and a **More from {competitor}** button pages that one competitor 5 at a time. Every page is fetched on demand via the same `list-references` action (`source=client` with `offset`, or `source=competitor` with an optional `competitor` page-id for the per-competitor drill-in).

**Source picker + `list-sources` (US-022).** The **Source** dropdown is populated from the review backend's `/bq` **`list-sources`** action, which returns `{ sources: { winners:[…], explore:[…], inspiration:{available} }, renders, explore_prefix }`. Each **winner** carries an `archetype_id`, a `name`, `source_ad_count`, its `structure` and its `default_render`; each **explore** entry carries a `family`, a `preset_id`, a distinct display `name`, an `is_family_default` flag, its `structure` and `default_render`. The picker offers **Auto (top performer)** (the top winner; `source:{kind:"winner", ref:""}`), the client's **winning layouts** (`source:{kind:"winner", ref:<archetype_id>}`), an **Explore — untested** group of presets, each a separate labelled row by its own `name` (`source:{kind:"explore", ref:<preset_id or family>}`); a preset flagged `is_family_default` is hidden once the client already wins with that family, while its alternate sub-formats stay explorable, and — when `inspiration.available` — an **Inspiration** option. This is how the ten former "design formats" survive: as typeset explore **presets**, each defaulting the render to typeset. The picker degrades to Auto-only if the `list-sources` read fails, so it never blocks the editor.

**Shared structure wireframe.** The wireframe renderer is built **once** in `f10-utils.js` (`window.f10RenderWireframe(structure, opts)`; scoped CSS injected once via `f10EnsureWireframeStyles`) and used in two places: the Brief Editor draws it under the source picker (before compile) and inside each compiled variant card, and the **Review** tab overlays it on a generated ad. Given a `LayoutStructure` doc — `{ regions:[{id, role, box:{x,y,w,h}, …}], repeats:[{group, item_role, min, max, observed}], layout_family, aspect_ratios }` — it draws one labelled box per region at its proportional (0..1) position, tags image regions, and shows the repeat range on a repeat group. It is pure DOM (no image fetch, no network), so it renders offline in the node tests.

**Probe-gated, fails closed.** On boot the module resolves the client, runs a cheap probe ("does this client have any brief revision to edit?") through the injectable brief store, and only then injects its own **Creative Briefs** nav section, **Brief Editor** nav link and panel. A client with no revisions, or a probe error (for example the brief backend is not yet hosted), shows **no tab** and leaves zero trace in the DOM. Tab activation goes through the same generic `f10ActivateTab()` dispatcher, so two panels can never show at once and no existing module needed editing. It self-boots (no `f10-layout.js` edit) and also exposes `window.initBriefEditor` for explicit dispatch.

**After save.** The panel shows the saved revision id. The primary path from here is to Compile and Submit in the app (above). As an alternative, that saved revision id can be generated from the CLI, from the f10-creative-pipeline repo root (`PYTHONPATH=src hq secrets exec --company fourteen10 --only VERTEX_SA_JSON,GCS_SA_JSON,BIGQUERY_SA_JSON -- python3 -m f10_creative_pipeline.generate --from-revision <id> --brand-dir <client brand kit> --run --confirm`). The command uses `--from-revision` (not `--revision`, which is not a real flag) and `python3`, and carries `--brand-dir` so the render is on-brand.

**Viewable results.** When a generation job's status carries landed composites, the panel renders each one as an image thumbnail rather than a raw `gs://` link, because a browser cannot open or display a `gs://` uri. The `/status` endpoint signs every landed composite to a short-lived https READ url (`asset_previews[].url`, the same 15-minute v4 signed url the `generated-preview` action mints) while leaving the raw `asset_uris` list unchanged; the panel shows each preview as an `<img>` with the composite size as a label and a click-through that opens the full signed url in a new tab, falling back to the `gs://` text link only when no signed url is available.

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

`f10-review.js` adds a **Creative Review** tab for the F10-internal review surface. The generated ads for a client are **auto-discovered** (see the gates below), and a batch is shown as a **grid of cards** for human review, so a reviewer looks over a whole batch at once instead of reading a static report or scrolling one ad at a time. Each card carries the generated ad's composite preview, what it was built from, and its approve / decline gate. A **Generation** date dropdown groups the discovered bundles by the date they were generated and defaults to the most recent, so the tab opens on the latest run; the grid-vs-detail view then renders only the selected date's bundles (a date with several bundles shows the grid, a date with one shows the single-bundle detail view directly). Loading is lazy per date: discovery lists every date up front, but a date's per-bundle previews and decision states are fetched only when that date is first selected, and cached so switching back is instant. The tab therefore opens fast (it loads only the most recent date's bundles) regardless of how much generation history a client has accumulated. **Fresh generations appear without a page reload:** the tab re-runs discovery on **every** activation (not only the first), so a bundle generated after the tab was first opened shows up, and a re-discovery jumps the view to the **most recent** generation date so the newest run is visible immediately. Re-discovery is best-effort: a discovery failure keeps the last-known bundles and current view rather than blanking the tab, and the per-date result cache is preserved, so already-loaded dates stay instant and switching dates via the dropdown still works and stays cached.

**Data sources (all already merged).** The bundle list is discovered from the [`list-bundles`](#list-generated-bundles-for-a-client-list-bundles-action) action (newest-first, grouped by `brief_id` over the shared `creative_manifest`). The new ad's composed preview image comes from the US-005 [`generated-preview`](#generated-ad-preview-resolver-generated-preview-action) action. A missing new-ad composite falls back to a labelled placeholder, so nothing renders as a broken image. The preview url is a **short-lived signed url** (it expires), so an `<img>` can still fail to load after it was rendered; a capture-phase `error` handler on the review body swaps any failed preview for the same "Preview not available" placeholder, so an expired link degrades gracefully to the placeholder instead of a broken-image icon (covers both the grid thumbnail and the detail image).

**What each ad was built from + region overlay (US-022).** Each generated ad shows its provenance as chips — its **source** (`kind` + `ref`), **render**, and **layout family** — read from the bundle's `source` / `render` / `layout_family` fields. When the bundle carries a `structure`, a **Show region overlay** toggle draws the shared structure wireframe (the same `f10RenderWireframe` the Brief Editor uses) over the preview, so a reviewer can see the region layout on the finished ad. For an **inspiration-sourced** ad, the inspiration's **detected structure** is shown as a wireframe **beside** the generated ad's overlay (from the bundle's `inspiration_structure`), and **no inspiration copy is ever shown** (only geometry transfers). An **Open in Figma** affordance hands the bundle to the existing plugin path with **no new backend**: it builds an `f10_figma_handoff` payload (the `structure`, `region_copy`, source/render/layout provenance) and calls a plugin hook (`window.f10FigmaPlugin.open`) when the review app / plugin has registered one, else stages it on `window.F10_FIGMA_HANDOFF` (and copies it to the clipboard) for the plugin to pick up.

**Discovery-gated AND live-path safe - two gates, both fail closed.** This module feeds the same shared framework that renders live client dashboards, so it is strictly additive:

1. **Live-path safety.** With **no `BQ_FUNCTION` endpoint AND no injected store** the module short-circuits to a silent no-op: no discovery call, no network, no nav link, no panel, zero DOM trace. An existing dashboard cannot be altered by a module that has no backend to reach.
2. **Discovery gate.** On boot the module calls the `list-bundles` action to discover which generated bundles exist for this client. Only when **at least one bundle is discovered** is the **Creative Review** nav section, nav link and panel injected. Zero bundles, or any discovery error (endpoint down, manifest not built), shows **no tab** and leaves zero trace. A dashboard that has `BQ_FUNCTION` therefore issues exactly one `list-bundles` call on boot and shows the tab only if the client has generated bundles.

**Single generic dispatcher.** Tab activation goes through the same `f10ActivateTab()` dispatcher as every other module (see [Generic tab dispatcher](#generic-tab-dispatcher)): it clears every nav link and every `.tab-panel` before activating the selected pair, so two panels can never both be active and no existing module needed editing. `f10-layout.js` calls `initReview()` at the tail of `renderLayout()` (the same discovery-decides pattern as `initComponents()`), and the module also self-boots on `DOMContentLoaded` behind an idempotent guard, so a dashboard pinned to an older `f10-layout.js` tag still gets the tab.

**Live-path release discipline (`livePathWatch`).** Because a bad framework release can blank-screen live dashboards, a framework tag bump follows the [release process](#release-process): after tagging, **purge and verify the jsDelivr tag**, then load a known-good existing client dashboard (for example `matilda` or `stake`) on the new tag and confirm it still renders before bumping other dashboards. The code-level invariant behind that canary - that a dashboard with no `BQ_FUNCTION` and no injected store makes no network call and injects nothing, and that a discovery finding no bundles leaves the base nav unchanged - is asserted in `test/f10-review.test.js`.

Config (F10-internal review surface only; the whole block is optional - the bundle list is auto-discovered, so on a standard review surface `REVIEW` can be omitted entirely):

```js
// The bundle list is auto-discovered via `list-bundles`, so REVIEW no longer carries
// BUNDLES or LIMIT. The block exists only for these optional overrides:
const REVIEW = {
  CLIENT: 'moshy',            // optional; override the f10 client slug when DATASET doesn't follow {client}_marts / {client}_clean
  ACTOR: 'zac@f10',           // optional; who is recording the decision (behind the F10 gate the endpoint stamps the authenticated actor, so this is optional)
  FEEDBACK_FUNCTION: '/.netlify/functions/feedback', // optional; feedback write/read endpoint override
};
```

Regression coverage (discovery-gated registration, the empty-discovery and discovery-error fail-closed paths, live-path safety, the generation-date filter, and the single-dispatcher activation) lives in `test/f10-review.test.js`.

### Batch grid

When the selected generation date has **more than one** bundle, the tab defaults to a **grid of cards** in discovery order (newest first), so a whole batch is reviewed at a glance. Each card carries:

- the **composite thumbnail** (the US-005 `generated-preview` path);
- the **label** and bundle id;
- what the ad was **built from** (the source / render / layout chips);
- the **Approve / Decline** controls and persisted state.

There is no automated score, verdict or rank on the cards: a human reviewer judges every ad. A generation date with a single visible bundle skips the grid and renders the detail view directly.

Regression coverage (auto-discovery through the store's `list-bundles` method, the discovery-order grid, per-card approve/decline + reload, the single-bundle detail view, and live-path safety) lives in `test/f10-review-grid.test.js`.

### Approve / decline gate and approval state (US-009)

Each ad in the review panel carries a coarse **concept-level decision**: an **Approve** control and a **Decline** control, plus an **optional comment** on decline. This is deliberately a yes/no gate, not a tuning surface: **approve** marks the bundle **servable** and sets its approved flag; **decline** records the reason and marks the ad **not-servable**. The decision that was made is always visible as one of three states - **Approved**, **Declined**, or **Pending** - and reloading the surface shows the persisted state, because it is read back from the feedback / status source rather than kept only in memory.

**No regenerate loop (by design).** There is no LLM tweak-and-regenerate or re-prompt control anywhere in the panel. Refinement happens with the designer in Figma *after* approval - a decision taken in the pipeline interview (a designer with the components beats re-prompting the model). The panel states this explicitly next to every decision.

**Recorded via the US-008 write path, never re-implemented here.** A decision POSTs the exact US-008 contract - `{ client, platform, bundle_id, state, comment?, actor? }` - to the feedback function (`starter/netlify/functions/feedback.js`), which writes the `status.json` sidecar the (future) bundle service reads and inserts the immutable audit row. The module reads the persisted state back from the same source on load. Both the write and the read sit behind **one injectable feedback-client seam** (`feedbackClient()` with `submit` / `read`), so the offline tests use fakes and nothing touches a live service:

- **Write endpoint** resolves from a `FEEDBACK_FUNCTION` global if present, else `REVIEW.FEEDBACK_FUNCTION`, else `/.netlify/functions/feedback`.
- **Actor** comes from `REVIEW.ACTOR` (or an `F10_ACTOR` global) when set; behind the F10 company-access gate the endpoint stamps the authenticated actor from its header, so the client need not know it.
- **Read-back** requests the persisted `status.json` shape for the bundle; a miss (no decision yet) or a read path that is **not deployed yet** degrades to **Pending** rather than throwing.

> **Deploy follow-up (not done in this change).** The `feedback` endpoint runs on GCP compute and is **not deployed yet**; this story builds the UI to call it and to read the state back behind the seam. Until the endpoint (and a status read path) are live, a real decision cannot be persisted end-to-end, so the surface shows Pending and fails closed. Live client dashboards are unaffected either way (the whole tab is behind the discovery gate - a client with no generated bundles gets no tab).

**Live-path safety is unchanged.** The decision gate adds no new code path to a live client dashboard: with no `BQ_FUNCTION` endpoint and no injected store the module still injects nothing and never calls the feedback endpoint, and a client with no discovered bundles never gets the tab. Approve/decline markup, the three states, the persisted-state reload, the exact US-008 contract, an inline write-failure surface, and the no-regenerate rule are covered in `test/f10-review-feedback.test.js`.

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
- **LinkedIn section** (when a `LINKEDIN` config is present) is metric-aware on the same terms, against its own bands (`LINKEDIN.THRESHOLDS`) and its own gated revenue column (`LINKEDIN.REVENUE_EXPR`, default `REVENUE_EXPR`), with the revenue-integrity guard on its tabs too. LinkedIn is almost always a lead-gen / CAC channel, so CPA — the default — is the right lens for it (see [LinkedIn channel](#linkedin-channel)).

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

## Ad state labels and hover definitions

### Renaming a state

`classify()` produces six ad states: `Scaling Winner`, `Efficient but Shrinking`,
`Fading`, `New Entrant`, `Dropped Off`, `Steady`. A dashboard can rename what a
person reads without touching the state itself:

```js
const STATE_LABELS = { 'Dropped Off': 'Zero Spend' };
```

Only the mapped states are renamed. Anything absent renders under its own name,
so a dashboard with no `STATE_LABELS` is unchanged.

The rename is **display only, on purpose**. The internal key stays `Dropped Off`
everywhere, which is what `STATE_META`, the legend ordering and
`BRANDING.chartState` all key off. If the key moved, a client config that themed
`Dropped Off` would silently stop matching and that state would lose its colour.

Renamed states flow through the Movement Board badge, the board legend, the
Movement Map scatter legend and its tooltip, and the same three surfaces on the
TikTok tab.

### Movement Board state filter

Opt in per dashboard:

```js
const SHOW_STATE_FILTER = true;
```

That adds an **Ad state** dropdown to the controls bar: `All states` plus one
entry per ad state (Scaling Winner, Fading, New Entrant, Efficient but Shrinking,
Dropped Off, Steady). Selecting one narrows the **Movement Board** to ads in that
state. Dashboards that do not set it get no dropdown and no filtering.

Like the zero-spend filter it is a **display** filter, applied after
classification with no re-query, and it acts on the **Movement Board only** so the
Movement Map keeps its full per-state distribution. The dropdown option value is
the internal state key while its label is the display name, so a renamed state
(e.g. `Dropped Off` shown as `Zero Spend` via `STATE_LABELS`) reads the same way
everywhere. It composes with the zero-spend filter and the ad-name search; the
board title notes the active state, and the empty state names the filter when a
chosen state has no ads this window.

## Hover definitions

Every ad state, graded tier and summary tile carries plain-English hover text
explaining what it means. This is **on by default** and needs no config: it is
inert extra context on an element a person is already looking at.

The built-in state wording describes what `classify()` actually does, so read it
against the classifier if you change either. Override any entry per client:

```js
const STATE_DEFINITIONS  = { 'Dropped Off': 'Client wording here.' };
const METRIC_DEFINITIONS = { spend: 'Client wording here.' };
const SHOW_DEFINITIONS   = false;  // turn hover text off entirely
```

Metric keys are looked up lower-cased, so `CPA` and `cpa` resolve the same
entry. Known keys: `spend`, `conversions`, `impressions`, `revenue`, `cpa`,
`cpc`, `cpm`, `ctr`, `roas`, `home run`, `on base`, `strike out`, `testing`,
`zero spend`. An unknown key returns empty and renders no `title` attribute
rather than throwing.

Definition text is HTML-escaped by `defAttr()` before it lands in the `title`
attribute, so client wording containing a quote or an angle bracket cannot break
the tag.

## Zero-spend filter

Opt in per dashboard:

```js
const SHOW_ZERO_SPEND_FILTER = true;
```

That adds a **Zero spend ads** control (`Show` / `Hide`) to the controls bar next
to Ad status. Dashboards that do not set it get no control and no filtering.

`Hide` drops every ad with no spend in the current window from the Movement Board
and the Movement Map. These are the ads `classify()` marks `Dropped Off`: they
cleared the noise floor last window and spent nothing this one. On Meta an active
ad almost always picks up at least some spend, so this nearly always means
somebody switched the ad off. They are real history, but they crowd out the ads a
person can still act on.

Two things to know about how it works:

- It is a **display** filter, applied after classification rather than in SQL.
  `Dropped Off` is derived client-side by comparing two windows and has no column
  to filter on. So switching it costs no query.
- It moves the board **and** the map together. The ad-name search deliberately
  leaves the map alone, because it is a board-level filter, but a zero-spend
  selection that moved only one view would leave the two disagreeing about which
  ads exist.

The board title reports what was hidden (`Ad Movement — 128 ads (38 zero spend
hidden)`), and if the filter empties the table the no-data copy says so rather
than blaming the noise floor.

This is distinct from **Ad status → Active only**, which is a server-side filter
on the mart's `is_active` column, meaning Meta's current delivery status. An ad
can be `Active` in Meta and still have spent nothing in the selected window, so
the two controls overlap without being redundant.

## Full-coverage tiers

By default the Ad Production `CASE` grades an ad Home Run / On Base / Strike Out
and drops everything else into `Unclassified`. Two very different kinds of ad end
up in that bucket:

1. **An ad that spent real money and converted nothing.** In CPA mode its metric
   is `NULL` (spend divided by zero conversions), so it fails the Home Run and On
   Base tests, which both require `metric > 0`, **and** the Strike Out test,
   because `metric > SO_CPA` is `NULL` and never true. An ad that burned budget
   for no result is the clearest strike out there is, and today it is invisible.
2. **An ad that has not spent enough to be judged at all.**

Because both land in the same bucket, the graded rates cannot be read as shares
of the ad base: Home Run + On Base + Strike Out never sums to 100%, and the
strike-out rate understates reality.

Opt in per dashboard:

```js
const FULL_COVERAGE_TIERS = true;
```

Every ad then grades into exactly one of five tiers that do partition the base:

| tier | rule |
|---|---|
| Home Run | spend >= `HR_SPEND` and the metric beats the Home Run target |
| On Base | spend >= `OB_SPEND` and the metric beats the On Base target |
| Strike Out | spend >= `SO_SPEND` and it did not, **including zero-conversion ads** |
| Testing | spent something, but under the gate to be judged fairly |
| Zero Spend | no spend at all |

The Strike Out branch gates on spend alone. That is what makes the set a
partition: anything that cleared the spend gate and did not qualify above is a
strike out, whatever its metric is.

Left off, `classificationCaseSQL()` emits byte-for-byte the SQL it always has, so
every existing dashboard grades identically. There is a test pinning the legacy
string in both CPA and ROAS mode.

Chart buckets are built from `classificationTiers()` rather than a hardcoded
list, so turning the flag on cannot leave a tier without a bucket to land in. The
TikTok tab's own `ttClassificationCaseSQL()` honours the same flag for the same
reason. A row carrying an unrecognised tier is bucketed and logged rather than
dropped or thrown.

**Turning this on changes the reported rates**, because ads that were invisible
in `Unclassified` now count. Expect the strike-out rate to rise. That is the
correction, not a regression: recalibrate the thresholds against the new
denominator rather than reading the old numbers across.

## Per-product thresholds

A multi-product account can convert on different actions per product, at cost
scales too far apart for one Home Run / On Base ceiling. Stake is the case in
point: Trade converts on app installs at about $60 each, SMSF on Calendly
bookings at about $255 each, roughly 8x apart. A single install-priced threshold
would strike out every SMSF ad for missing a target it was never running for,
which is exactly the false-strikeout artefact the tiers are meant to remove.

Opt in per dashboard:

```js
const THRESHOLDS_BY_GROUP = {
  col: 'group_name',            // a real mart column to switch on
  groups: {
    SMSF: { HR_SPEND: 3000, HR_CPA: 300, OB_SPEND: 1000, OB_CPA: 1000, SO_SPEND: 1000 },
  },
};
```

A listed group grades on its own thresholds. A partial override inherits the
rest from the base `THRESHOLDS`, so the SMSF block above could set just `HR_CPA`
and keep everything else. Any unlisted group, and any row with a NULL group,
falls through to the base thresholds.

The dispatch is an outer `CASE` on `col`, evaluated **per row**, so grades are
correct even with the Product filter on "All": each ad is judged on its own
product's thresholds regardless of what else is on screen. `col` is interpolated
into SQL, so it is validated as a plain column identifier; anything else disables
per-group thresholds and falls back to the base scale. Group values are escaped
as SQL string literals.

This pairs with a per-product `CONV_EXPR`. The Ad Production CPA is already
`spend / SUM(CONV_EXPR)`, so a conversion expression like
`CASE WHEN group_name = 'SMSF' THEN calendly_booking ELSE app_install END` makes
each ad's cost the cost of the action it actually runs for, and the per-group
thresholds then grade that cost on the right scale.

### Filter-aware Ad Production panel

The classification SQL is per-row, so grades are always correct whatever the
Product filter is on. The panel around it follows the filter:

- With the Product filter on a configured group (e.g. SMSF), the **threshold
  editor**, the **benchmark copy** and the **scatter guide lines** all show and
  edit that group's thresholds. Editing and applying regrades that product; the
  base and the other groups are untouched.
- On **All**, the editor and guides show the base thresholds, and the benchmark
  copy lists the base tiers followed by every group's full set of tiers.
- On a product with no override (e.g. Trade here), the panel shows the base,
  which is that product's scale.

So switching Product from Trade to SMSF flips the adjustable inputs, the copy and
the guide lines to the matching scale, rather than leaving them on one product's
numbers.

Scope and limits:

- Governs only the **Ad Production tier grading** (the Meta production tab). The
  weekly Movement states never used these thresholds, and the TikTok tab keeps
  its own single scale.
- The live editor tunes whichever context is in focus: the base thresholds on
  All / an unlisted product, or a group's thresholds when that group is filtered.
  Edits are session-only, as before.
- On the **All** view the scatter mixes products on one axis, so its guide lines
  can only sit at one scale (the base). The coloured classification and the
  scorecard rates are always per-group-correct; filter to a single product to
  read the scatter against that product's guide lines.

With no config, the emitted SQL is byte-for-byte what it was; a test pins that in
both CPA and ROAS mode.

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

Median video quality should centre near 0.5 on every platform, so real video sits alongside the static 0.5 baseline and no platform is under-scaled against Meta. The quality ceilings are therefore **per-platform** (Meta/TikTok validated on FastCover live data, LinkedIn calibrated on the live Sucasa LinkedIn account), carried by `metaScoreOpts()`, `ttScoreOpts()` and `liScoreOpts()`:

| Platform | hook | hold | ctr | completion |
|---|---|---|---|---|
| Meta | n/a | 6 | 1.3 | 2.5 |
| TikTok | 11 | 1.9 | 0.4 | 0.3 |
| LinkedIn | 110 | 9 | 0.3 (outbound) | 4.5 |

Meta has no hook gate, so its quality is hold, ctr and completion. LinkedIn's "hook" is its own 2s in-view view rate, which is defined far more loosely than TikTok's, hence the much higher ceiling; its ctr input is the **outbound** (landing-page) click rate, not raw clicks (see [LinkedIn channel](#linkedin-channel)). Each ceiling is overridable via `CREATIVE_SCORE_CONFIG.qualityCeil`; the config default is the Meta set, used only as a fallback.

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
