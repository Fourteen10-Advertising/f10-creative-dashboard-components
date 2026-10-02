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
   - `TIKTOK` / `LINKEDIN` — optional extra channel sections (uncomment to add).
     `LINKEDIN` has two modes: a per-client mart (`DATASET`/`TABLE`) or the shared
     `all_clients_linkedin_ads` dataset scoped by `ACCOUNT_URN`. Setting
     `ACCOUNT_URN` ignores `DATASET`/`TABLE` — see the components README's
     "LinkedIn channel" section before choosing.
     Use the per-client mart mode: the shared `all_clients_linkedin_ads` mode cannot be
     read by a client-scoped service account.
3. In Netlify, set the **site-level** environment variable `GOOGLE_SERVICE_ACCOUNT` to the
   key of this client's own scoped service account, `dash-<client>@mcc-poc-477801` (marked
   secret, production and deploy-preview contexts). It reads only the client's
   `<prefix>_marts` and `<prefix>_reporting` datasets. This is required: there is no
   organisation or account default, and a site without it fails closed. Never use the
   shared cross-client reader. Create the service account, vault secret
   (`BIGQUERY_SA_JSON__<CLIENT>`) and isolation check by following
   `templates/client-sa/README.md` in the HQ company folder (the dashboard skills do this
   in "Step 6b"). Netlify applies a changed variable only on the next deploy, so redeploy
   after setting it. The dashboard must read only the client's own two datasets: if a tab
   needs anything else (previews, competitor data, HubSpot), add it to the client's marts in
   f10-dataform rather than reading a shared dataset.
   Also set a site password (below).
4. Password protect the site in Netlify (site password or SSO) before sharing the URL.
   Every F10 client dashboard has one: the `bq` function runs any SQL it is sent, so the
   password is the access control. Save it in HQ secrets as `DASHBOARD_PASSWORD__<SITE>`;
   the client lead posts and pins it in the client's internal Slack channel. Confirm the
   live site returns 401 when unauthenticated.
5. Deploy. No build step — Netlify publishes the static files and the `bq.js`
   function.

## Feedback write path (`netlify/functions/feedback.js`)

Records a per-bundle approve / decline / pending decision. Each decision writes a
`status.json` sidecar to the bundle's own GCS prefix
(`components/{platform}/{client}/{bundle_id}/status.json`) and an audit row to
BigQuery. The sidecar carries the decision under two field names on purpose:
`status` is the field the bundle service reads to gate serving (it serves only
when `status` is `approved`), and `state` keeps the review vocabulary for the
audit row and the review UI. Both always hold the same decision value, so an
approved bundle is written with `status: "approved"` and is served.

## Keeping up to date

Bump the `@vX.Y.Z` tag in the jsDelivr URLs in `index.html` to pick up new
shared-component releases.
