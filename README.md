# f10-creative-dashboard-components

Shared CSS and JavaScript for F10 Netlify creative dashboards. Loaded by each dashboard via jsDelivr CDN — no build step required.

## Files

| File | Purpose |
|---|---|
| `f10-shared.css` | All shared styles: layout, sidebar, controls bar, scorecards, badges, tables, charts |
| `f10-utils.js` | Formatters, constants (METRICS, STATE_META, thresholds), `classify()`, aggregation helpers, group-filter helpers, `scatterMaxSpend()` |
| `f10-weekly.js` | Weekly engine: fetchWindows, renderSummary/Board/Map, tab system, group filters, wireControls, initWeekly |
| `f10-monthly.js` | Monthly engine: loadPowerLaw/Production/Decay/Age + the `loadMonthlyTab()` dispatcher. All SQL is shared and config-driven |

## How to use in a dashboard

### 1. In `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.1.0/f10-shared.css" />
```

### 2. Before `</body>`:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
  /* CLIENT CONFIG — define before loading shared scripts */
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
</script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.1.0/f10-utils.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.1.0/f10-weekly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.1.0/f10-monthly.js"></script>
<script>
  wireControls();
  initWeekly();
</script>
```

The monthly loaders now live in `f10-monthly.js`, so a dashboard no longer defines its own `loadMonthlyTab` / `loadDecay` / `loadAge` / `loadProduction` / `loadPowerLaw`. To override a production threshold, redefine the constant (e.g. `HR_SPEND`) in the config block before the scripts load.

## Required markup

The dashboard's `index.html` must include the controls bar with two containers:

```html
<div class="controls-bar" id="controls-bar" style="display:none;">
  <div id="ctrl-groups" class="ctrl-groups"></div>   <!-- group dropdowns injected here -->
  <div id="weekly-controls" class="weekly-controls"> <!-- weekly-only controls -->
    ...window length, end date, metric, noise floor...
  </div>
</div>
```

The group dropdowns are injected into `#ctrl-groups`. The bar stays visible on every tab when `GROUP_FILTERS` is non-empty; the weekly-only controls show only on weekly tabs.

## Group filters

- Apply to **all tabs** (weekly and monthly) by injecting `groupWhere()` into every query's WHERE clause.
- Multiple dimensions are supported — one dropdown per `GROUP_FILTERS` entry.
- Values are queried dynamically and default to **All** (no filter).
- `fetchMaxDate` stays global so the end-date picker is stable regardless of selected group.

## Versioning

Each release is tagged (e.g. `v1.1.0`). Update the tag in the jsDelivr URLs across all dashboards to pick up changes.

To cut a new release: push to main, then create a GitHub tag.

## Dashboards using this library

- `fourteen10-advertising/bridgit-creative-dashboard`
- `fourteen10-advertising/fastcover-creative-dashboard`
