# f10-creative-dashboard-components

Shared CSS and JavaScript for F10 Netlify creative dashboards. Loaded by each dashboard via jsDelivr CDN — no build step required.

A dashboard is now just a config block plus script tags: the markup, styling, and all logic come from this library. The fastest way to start a new one is to copy the [`starter/`](./starter) folder.

## Files

| File | Purpose |
|---|---|
| `f10-shared.css` | All shared styles: layout, sidebar, controls bar, scorecards, badges, tables, charts |
| `f10-utils.js` | Formatters, constants (METRICS, STATE_META, thresholds), `classify()`, aggregation helpers, group-filter helpers, `scatterMaxSpend()` |
| `f10-weekly.js` | Weekly engine: fetchWindows, renderSummary/Board/Map, tab system, group filters, wireControls, initWeekly |
| `f10-monthly.js` | Monthly engine: loadPowerLaw/Production/Decay/Age + the `loadMonthlyTab()` dispatcher. All SQL is shared and config-driven |
| `f10-layout.js` | `renderLayout()` — builds the sidebar, controls bar, and all seven tab panels into `<div id="app"></div>`. Production benchmark copy is derived from the threshold constants |

## How to use in a dashboard

The entire dashboard body is `<div id="app"></div>`. Define config, load the four scripts, then call `renderLayout(); wireControls(); initWeekly();`.

### 1. In `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.2.0/f10-shared.css" />
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
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.2.0/f10-utils.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.2.0/f10-weekly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.2.0/f10-monthly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.2.0/f10-layout.js"></script>
<script>
  renderLayout();
  wireControls();
  initWeekly();
</script>
</body>
```

`renderLayout()` generates all markup (including the `#ctrl-groups` / `#weekly-controls` containers), so dashboards no longer hand-maintain the HTML or the monthly loaders.

## Config reference

| Global | Required | Purpose |
|---|---|---|
| `BQ_FUNCTION`, `PROJECT`, `DATASET`, `TABLE`, `CONV_EXPR` | yes | BigQuery target + conversion expression |
| `CLIENT_NAME` | yes | Sidebar label |
| `REPORT_NAME` | no | Sidebar sub-label (default `Creative Reporting`) |
| `GROUP_FILTERS` | no | Array of `{ col, label }` segment dropdowns (default none) |
| `THRESHOLDS` | no | Ad Production threshold overrides (see below) |

## Group filters

- Apply to **all tabs** (weekly and monthly) by injecting `groupWhere()` into every query's WHERE clause.
- Multiple dimensions are supported — one dropdown per `GROUP_FILTERS` entry.
- Values are queried dynamically and default to **All** (no filter).
- `fetchMaxDate` stays global so the end-date picker is stable regardless of selected group.

## Thresholds

Ad Production classification (Home Run / On Base / Strike Out) uses these defaults:

| Key | Default | Meaning |
|---|---|---|
| `HR_SPEND` | 5000 | Home Run min lifetime spend |
| `HR_CPA` | 70 | Home Run max CPA |
| `OB_SPEND` | 1000 | On Base min lifetime spend |
| `SO_SPEND` | 500 | Strike Out min lifetime spend |
| `SO_CPA` | 140 | Strike Out CPA above which an ad strikes out |

To change them per client, define a `THRESHOLDS` config object (any subset) **before** the scripts load:

```js
const THRESHOLDS = { HR_SPEND: 8000, HR_CPA: 90 };
```

The SQL classification, the scatter threshold lines, and the displayed benchmark copy/legend all read these values, so the numbers users see always match the data. Do **not** redeclare `HR_SPEND` etc directly — that collides with the shared `const` declarations and breaks the page.

## Versioning

Each release is tagged (e.g. `v1.2.0`). Update the tag in the jsDelivr URLs across all dashboards to pick up changes. jsDelivr caches tags immutably, so always cut a new tag rather than re-pointing an existing one.

To cut a new release: merge to `main`, then create a GitHub tag.

## Dashboards using this library

- `fourteen10-advertising/bridgit-creative-dashboard`
- `fourteen10-advertising/fastcover-creative-dashboard`
