# f10-creative-dashboard-components

Shared CSS and JavaScript for F10 Netlify creative dashboards. Loaded by each dashboard via jsDelivr CDN — no build step required.

## Files

| File | Purpose |
|---|---|
| `f10-shared.css` | All shared styles: layout, sidebar, scorecards, badges, tables, charts |
| `f10-utils.js` | Formatters, constants (METRICS, STATE_META, thresholds), classify(), aggregation helpers |
| `f10-weekly.js` | Weekly engine: fetchWindows, renderSummary/Board/Map, tab system, wireControls, initWeekly |

## How to use in a dashboard

### 1. In `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.0.0/f10-shared.css" />
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
</script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.0.0/f10-utils.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@v1.0.0/f10-weekly.js"></script>
<script>
  /* CLIENT-SPECIFIC: monthly tab loader (SQL varies per client) */
  function loadMonthlyTab(tab){
    loadedTabs[tab] = true;
    if(tab==='decay')      loadDecay();
    if(tab==='age')        loadAge();
    if(tab==='production') loadProduction();
    if(tab==='powerlaw')   loadPowerLaw();
  }

  /* Define loadDecay(), loadAge(), loadProduction(), loadPowerLaw() here */

  wireControls();
  initWeekly();
</script>
```

## Versioning

Each release is tagged (e.g. `v1.0.0`). Update the tag in the jsDelivr URLs across all dashboards to pick up changes.

To cut a new release: push to main, then create a GitHub tag.

## Dashboards using this library

- `fourteen10-advertising/bridgit-creative-dashboard`
- `fourteen10-advertising/fastcover-creative-dashboard`
