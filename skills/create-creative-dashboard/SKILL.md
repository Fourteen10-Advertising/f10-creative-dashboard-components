---
name: create-creative-dashboard
description: >-
  Scaffold a new F10 creative reporting dashboard from the shared
  f10-creative-dashboard-components framework. Use when someone wants to create,
  set up, spin up, bootstrap, or add a new client creative dashboard / creative
  reporting dashboard. Gathers the client config (BigQuery dataset, conversion
  expression, optional group filters and Ad Production thresholds), pulls the
  latest starter scaffold, fills in the config, commits it, and prints the
  GitHub + Netlify deploy steps.
argument-hint: "[client name]"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# Create an F10 creative dashboard

Scaffold a new client creative reporting dashboard. The dashboard is a thin
shell that loads the shared `f10-creative-dashboard-components` library from
jsDelivr — so this skill only produces a small config-driven repo, not a copy
of the UI. Keep that philosophy: do NOT inline or duplicate the shared CSS/JS.

Work through the steps in order. Confirm the gathered config with the user
before writing files.

## Step 1 — Gather the client config

If a client name was passed as an argument, use it. Otherwise ask. Collect:

| Field | Required | Notes / examples |
|---|---|---|
| Client name | yes | e.g. `Acme`. Used for the sidebar, `<title>`, and the default folder name |
| BigQuery dataset | yes | e.g. `acme_clean`. The dataset holding `meta_creative_reporting` |
| Conversion expression | yes | SQL expr, e.g. `purchase` or `(lead + signup)` or `(customer_application_buying + broker_application_details)` |
| Group filters | no | Top-level segment dropdowns. Array of `{ col, label }`, e.g. `[{ col: 'campaign_group', label: 'Product / Group' }]`. Leave empty `[]` if none |
| Thresholds | no | Per-client Ad Production overrides. Any subset of `HR_SPEND, HR_CPA, OB_SPEND, OB_CPA, SO_SPEND, SO_CPA`. Omit to use defaults (5000 / 70 / 1000 / 100 / 500 / 140) |
| Target folder | no | Default `<client-slug>-creative-dashboard` (lowercase, hyphenated) |

Assume `PROJECT = mcc-poc-477801`, `TABLE = meta_creative_reporting`, and
`BQ_FUNCTION = /.netlify/functions/bq` unless the user says otherwise.

See [reference.md](reference.md) for the full config contract and the
classification rules, if you need to explain any field.

Echo the collected config back and get a thumbs-up before proceeding.

## Step 2 — Resolve the latest components release tag

The scaffolded dashboard must pin to a real release tag. Resolve the latest:

```bash
TAG=$(curl -fsSL https://api.github.com/repos/fourteen10-advertising/f10-creative-dashboard-components/releases/latest \
  | grep -oE '"tag_name"[^,]*' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
echo "Latest components tag: ${TAG:-<none found>}"
```

If that returns nothing (API blocked), fall back to:

```bash
git ls-remote --tags https://github.com/fourteen10-advertising/f10-creative-dashboard-components.git \
  | awk -F/ '{print $NF}' | grep -E '^v[0-9]' | sort -V | tail -1
```

If you still cannot resolve a tag, ask the user which version to pin to.

## Step 3 — Scaffold the files from the starter at that tag

Pull the starter scaffold for the resolved `$TAG` into the target folder. The
starter already pins its jsDelivr URLs to the matching tag, so fetching it at
`$TAG` keeps the dashboard and library in lockstep.

```bash
DIR="<target-folder>"
BASE="https://raw.githubusercontent.com/fourteen10-advertising/f10-creative-dashboard-components/${TAG}/starter"
mkdir -p "$DIR/netlify/functions"
curl -fsSL "$BASE/index.html"                   -o "$DIR/index.html"
curl -fsSL "$BASE/package.json"                 -o "$DIR/package.json"
curl -fsSL "$BASE/netlify.toml"                 -o "$DIR/netlify.toml"
curl -fsSL "$BASE/netlify/functions/bq.js"      -o "$DIR/netlify/functions/bq.js"
curl -fsSL "$BASE/netlify/functions/package.json" -o "$DIR/netlify/functions/package.json"
```

If the network blocks raw.githubusercontent.com, reconstruct the files from the
canonical templates in [reference.md](reference.md), substituting `${TAG}` into
every jsDelivr URL.

## Step 4 — Fill in the config

Edit the new `index.html` only — never touch the script tags or markup. Make
these substitutions in the `<head>` and the CLIENT CONFIG block:

- `<title>` → `<Client> | Creative Reporting`
- `DATASET` → the client's dataset
- `CONV_EXPR` → the conversion expression
- `CLIENT_NAME` → the client name
- `GROUP_FILTERS` → the configured array (or `[]`)
- `THRESHOLDS` → if the user set overrides, uncomment and set the line; otherwise
  leave it commented (defaults apply)

Also set the new repo's `package.json` `name`/`description` to the client.

Verify: no `your_dataset`, `Client Name`, or `CLIENT_NAME` placeholders remain,
and the four jsDelivr URLs all reference the same `$TAG`.

## Step 5 — Initialise git and commit

```bash
cd "$DIR"
git init -q && git add -A
git commit -q -m "Scaffold <Client> creative dashboard on components ${TAG}"
```

## Step 6 — Tell the user how to deploy

Print these next steps (do NOT try to create the GitHub repo or Netlify site
yourself unless the user explicitly asks):

1. Create a new GitHub repo under `fourteen10-advertising` (e.g.
   `<client-slug>-creative-dashboard`) and push this folder to it.
2. In Netlify, create a new project from that GitHub repo and deploy. No
   environment variables are needed — `GOOGLE_SERVICE_ACCOUNT` is already set at
   the organisation level in Netlify.
3. Open the deployed site and confirm the Weekly Summary loads, then click
   through the Monthly tabs. If a group filter was configured, confirm the
   dropdown populates and re-scopes the tabs.

## Guardrails

- This skill creates a small config-only repo. If you ever feel the urge to copy
  CSS, the weekly/monthly engines, or the tab markup into the new repo, stop —
  that is exactly what the shared library exists to prevent.
- To change shared behaviour for every client, edit
  `f10-creative-dashboard-components` and cut a new release; do not fork logic
  into a single dashboard.
