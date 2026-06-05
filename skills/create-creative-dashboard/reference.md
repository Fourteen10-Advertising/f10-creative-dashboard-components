# Reference — create-creative-dashboard

Supporting detail for the `create-creative-dashboard` skill. The primary path is
to fetch the starter from the components repo at the latest release tag; use the
templates here only if the network blocks that fetch.

## Config contract

Defined in the dashboard's `index.html` CLIENT CONFIG block:

| Global | Required | Purpose |
|---|---|---|
| `BQ_FUNCTION` | yes | Netlify function path. Always `/.netlify/functions/bq` |
| `PROJECT` | yes | GCP project. Always `mcc-poc-477801` |
| `DATASET` | yes | Client BigQuery dataset, e.g. `acme_clean` |
| `TABLE` | yes | Always `meta_creative_reporting` unless renamed |
| `CONV_EXPR` | yes | Conversion SQL expression, e.g. `purchase` or `(lead + signup)` |
| `CLIENT_NAME` | yes | Sidebar label |
| `REPORT_NAME` | no | Sidebar sub-label (default `Creative Reporting`) |
| `GROUP_FILTERS` | no | Array of `{ col, label }` segment dropdowns; default `[]` |
| `THRESHOLDS` | no | Ad Production threshold overrides (see below) |

## Ad Production thresholds

Defaults: `HR_SPEND 5000`, `HR_CPA 70`, `OB_SPEND 1000`, `OB_CPA 100`,
`SO_SPEND 500`, `SO_CPA 140`. Override any subset via a `THRESHOLDS` object.

Classification (top-down):

- **Home Run** — `spend ≥ HR_SPEND AND 0 < CPA < HR_CPA`
- **On Base** — `spend ≥ OB_SPEND AND 0 < CPA < OB_CPA`
- **Strike Out** — `spend ≥ SO_SPEND AND CPA > SO_CPA`
- **Unclassified** — everything else

## Group filters

Each entry renders a dropdown that applies to every tab (weekly and monthly),
with values populated dynamically (`SELECT DISTINCT`) and an "All" default.
Multiple dimensions are supported. Example:

```js
const GROUP_FILTERS = [
  { col: 'campaign_group', label: 'Product / Group' },
  { col: 'marketplace',    label: 'Marketplace' },
];
```

## Fallback templates

Substitute `${TAG}` with the resolved release tag (e.g. `v1.3.0`) everywhere.

### index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CLIENT_NAME | Creative Reporting</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600&family=Bodoni+Moda:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@${TAG}/f10-shared.css" />
</head>
<body>
<div id="app"></div>

<script>
/* CLIENT CONFIG */
const BQ_FUNCTION = '/.netlify/functions/bq';
const PROJECT     = 'mcc-poc-477801';
const DATASET     = 'your_dataset';
const TABLE       = 'meta_creative_reporting';
const CONV_EXPR   = 'purchase';
const CLIENT_NAME = 'Client Name';

/* Top-level segment filters — apply to every tab. Values populated dynamically. */
const GROUP_FILTERS = [
  // { col: 'campaign_group', label: 'Product / Group' },
];

/* Optional per-client Ad Production thresholds (defaults shown). Uncomment to override:
const THRESHOLDS = { HR_SPEND: 5000, HR_CPA: 70, OB_SPEND: 1000, OB_CPA: 100, SO_SPEND: 500, SO_CPA: 140 };
*/
</script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@${TAG}/f10-utils.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@${TAG}/f10-weekly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@${TAG}/f10-monthly.js"></script>
<script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@${TAG}/f10-layout.js"></script>
<script>
  renderLayout();
  wireControls();
  initWeekly();
</script>
</body>
</html>
```

### netlify.toml

```toml
[build]
  publish = "."
  functions = "netlify/functions"

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "SAMEORIGIN"
    X-Content-Type-Options = "nosniff"
    Access-Control-Allow-Origin = "*"
```

### package.json (repo root)

```json
{
  "name": "creative-dashboard",
  "version": "1.0.0",
  "description": "Creative Reporting Dashboard — F10",
  "dependencies": {
    "@google-cloud/bigquery": "^7.9.1"
  }
}
```

### netlify/functions/package.json

```json
{
  "name": "creative-dashboard-functions",
  "version": "1.0.0",
  "dependencies": {
    "@google-cloud/bigquery": "^7.9.1"
  }
}
```

### netlify/functions/bq.js

Fetch from the repo at `${TAG}` — it is a standard BigQuery proxy and should not
be hand-rewritten. If you must, it reads `process.env.GOOGLE_SERVICE_ACCOUNT`,
parses it as credentials, runs the POSTed `query` against BigQuery in
`australia-southeast1`, and returns the rows as JSON with permissive CORS.
