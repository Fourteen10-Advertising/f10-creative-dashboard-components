# Starter — new F10 creative dashboard

Copy this folder into a new repo to stand up a client dashboard. Everything is
config; the UI and logic come from the shared components via jsDelivr.

## Steps

1. Copy the contents of this `starter/` folder to the root of the new repo.
2. Edit the **CLIENT CONFIG** block in `index.html`:
   - `DATASET` — the client's BigQuery dataset.
   - `CONV_EXPR` — the conversion expression for this client.
   - `CLIENT_NAME` — sidebar label (and update the `<title>`).
   - `GROUP_FILTERS` — optional segment dropdowns (product, marketplace, …).
   - `THRESHOLDS` — optional Ad Production overrides (uncomment to change).
3. In Netlify, set the `GOOGLE_SERVICE_ACCOUNT` environment variable to the
   service account JSON with BigQuery access (project `mcc-poc-477801`,
   location `australia-southeast1`).
4. Deploy. No build step — Netlify publishes the static files and the `bq.js`
   function.

## Keeping up to date

Bump the `@vX.Y.Z` tag in the jsDelivr URLs in `index.html` to pick up new
shared-component releases.
