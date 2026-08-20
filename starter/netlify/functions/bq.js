const { BigQuery } = require('@google-cloud/bigquery');
const { Storage } = require('@google-cloud/storage');

/* Cost + safety guardrails (all optional, sensible defaults).
 *   BQ_MAX_BYTES_BILLED — max bytes BigQuery may bill per query (default ~2 GB).
 *                         Queries that would scan more are rejected by BigQuery.
 *   BQ_TIMEOUT_MS       — per-query timeout in ms (default 30000).
 *   ALLOWED_ORIGIN      — if set, the only cross-origin allowed to call this
 *                         endpoint from a browser. The dashboard calls its own
 *                         function same-origin, so this can stay unset. */
const MAX_BYTES_BILLED = process.env.BQ_MAX_BYTES_BILLED || String(2 * 1024 * 1024 * 1024);
const TIMEOUT_MS       = Number(process.env.BQ_TIMEOUT_MS || 30000);
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN || '';

// CORS: echo the configured origin only when it matches; otherwise send no
// allow-origin header. Same-origin requests (the dashboard) work without it.
function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    return { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, Vary: 'Origin' };
  }
  return {};
}

exports.handler = async function (event) {
  const cors = corsHeaders(event);

  // CORS pre-flight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!saJson) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'GOOGLE_SERVICE_ACCOUNT environment variable is not set.' }),
    };
  }

  let credentials;
  try {
    credentials = JSON.parse(saJson);
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to parse GOOGLE_SERVICE_ACCOUNT JSON: ' + e.message }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid request body.' }),
    };
  }

  // ── Media resolve: map ad_id(s) to a short-lived signed GCS preview URL ──
  // The dashboard calls this on hover to show the real image/video inline.
  // Returns { [ad_id]: { type: 'image'|'video'|null, url: signedUrl|null } };
  // url is null when the asset was never fetched into the bucket, which tells
  // the UI to fall back to the existing Facebook click-through link.
  if (body.action === 'media') {
    return resolveMedia(body, credentials, cors);
  }

  // ── Generated-ad preview: sign a GENERATED bundle's composed preview image ──
  // Delivered ads (the `media` action) resolve through BigQuery by ad_id;
  // GENERATED bundles are in no BigQuery table, so this action is a net-new,
  // bundle-keyed resolver straight against the components bucket. Given the
  // caller's client scope plus a bundle id it returns a short-lived signed READ
  // URL for that bundle's composite.png, or { url:null, reason } when the bundle
  // belongs to another client or no composite exists. Touches no BigQuery: it
  // signs with the GCS object-viewer SA path only. See resolveGeneratedPreview.
  if (body.action === 'generated-preview') {
    return resolveGeneratedPreview(body, credentials, cors);
  }

  // ── Competitor Ad Library: this client's tracked competitor ads + creatives ──
  // Queries the shared all_clients_adlib dataset (keyed by f10_client) for the
  // latest snapshot per competitor ad, its longevity from ad_registry, its
  // fetched creatives (served via the same short-lived signed GCS URLs).
  // Data-driven off body.client; the
  // function itself holds no per-client config, so it serves every dashboard.
  // Pass { action:'competitor', probe:true } for a cheap rows-exist check the
  // UI can use to decide whether to show the tab at all.
  if (body.action === 'competitor') {
    return queryCompetitor(body, credentials, cors);
  }

  // ── Competitor creatives: on-demand signed creative URLs for specific ads ──
  // The competitor action is metadata-only; the dashboard calls this lazily for
  // just the ads on the visible page (capped at 60) to mint the same short-lived
  // signed GCS URLs. Returns { creativesByAd: { <ad_archive_id>: [{media_type, idx, url}] } };
  // the private gs:// URI is deleted before the row leaves this function.
  if (body.action === 'competitor-creatives') {
    return queryCompetitorCreatives(body, credentials, cors);
  }

  // ── Competitor Ad Search: term search across THIS client's competitor ads ──
  // Case-insensitive substring match over ad copy, link titles, page name, link
  // URL, CTA, and the vision on-screen text, scoped by f10_client. Fails closed
  // (empty) for clients with no competitor data and for empty/short terms, so the
  // search surface can hide exactly like the competitor tab (US-006).
  // Pass { action:'competitor-search', probe:true } for the same rows-exist check.
  if (body.action === 'competitor-search') {
    return queryCompetitorSearch(body, credentials, cors);
  }

  // ── Competitor-intelligence tab data actions (US-007) ──
  // Five thin, action-named reads over the governed all_clients_adlib marts that
  // power the new tabs. Each scopes WHERE f10_client=@client, carries the same
  // maximumBytesBilled/jobTimeoutMs guardrails, supports { probe:true } for a cheap
  // rows-exist check, and fails closed (empty payload / { exists:false }) when the
  // client's mart has no rows OR does not exist yet — never a 500 for absent data.
  //   themes         -> competitor_theme_summary        (US-001 theme rollup)
  //   age-timeseries -> competitor_age_over_time         (US-003 age-over-time + client line)
  //   maturity       -> competitor_meta_maturity         (US-005 explainable score + rank + tier)
  //   leaderboard    -> ad_registry + ad_snapshots       (live competitor ads ranked by age)
  //   net-new        -> competitor_net_new_ads / _by_page (US-004 brand-new ads this period)
  if (body.action === 'themes') {
    return queryThemes(body, credentials, cors);
  }
  if (body.action === 'age-timeseries') {
    return queryAgeTimeseries(body, credentials, cors);
  }
  if (body.action === 'maturity') {
    return queryMaturity(body, credentials, cors);
  }
  if (body.action === 'leaderboard') {
    return queryLeaderboard(body, credentials, cors);
  }
  if (body.action === 'net-new') {
    return queryNetNew(body, credentials, cors);
  }

  // ── Consolidated competitor-intelligence surface (competitor-intel-rollup US-008) ──
  // One read that assembles, per competitor, the behaviour-over-time picture the
  // consolidated dashboard tab renders: the precomputed Gemini narrative (US-007),
  // the behaviour archetype (US-006), the effort allocation + behaviour movements
  // (US-005), and the theme movements (US-006), plus the go-live staying-power
  // winners. Every sub-read is table-not-found tolerant, so the action degrades
  // gracefully to whatever marts exist yet (the US-005/006/007 marts are
  // materialized later, in US-011). Supports { probe:true } so the tab appears only
  // when the client has consolidated intelligence rows.
  if (body.action === 'competitor-intel') {
    return queryCompetitorIntel(body, credentials, cors);
  }

  const { query } = body;
  if (!query || typeof query !== 'string') {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing or invalid "query" field.' }),
    };
  }

  try {
    const bq = new BigQuery({
      projectId: 'mcc-poc-477801',
      credentials,
      location: 'australia-southeast1',
    });

    const [rows] = await bq.query({
      query,
      location: 'australia-southeast1',
      useLegacySql: false,
      maximumBytesBilled: MAX_BYTES_BILLED,
      jobTimeoutMs: TIMEOUT_MS,
    });

    return {
      statusCode: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rows),
    };
  } catch (err) {
    console.error('BigQuery error:', err);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

/* Resolve ad_ids to signed preview URLs.
 *
 * An ad maps to its stored asset through two shared (cross-client) tables:
 *   meta_creative_links  ad_id -> video_id / image_hash (the asset id)
 *   creative_manifest    asset id -> gcs_uri + fetch_status (was it stored?)
 * We take the latest creative per ad (matching how creative_link is built),
 * then mint a short-TTL V4 signed read URL for any asset actually in the
 * bucket. The bucket stays private; only the time-limited URL reaches the
 * browser. Assets that were never fetched return url:null so the UI keeps the
 * Facebook fallback link. */
async function resolveMedia(body, credentials, cors) {
  const json = (statusCode, payload) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const adIds = Array.isArray(body.adIds)
    ? body.adIds.filter((x) => typeof x === 'string' && x).slice(0, 200)
    : [];
  if (!adIds.length) return json(200, {});

  try {
    const bq = new BigQuery({
      projectId: 'mcc-poc-477801',
      credentials,
      location: 'australia-southeast1',
    });

    // Platform-aware creative -> asset resolution. Meta maps ad_id via the shared
    // meta_creative_links table; TikTok maps ad_id -> video_id (its manifest asset_id)
    // straight from the raw ads table. Both land in the shared creative_manifest,
    // filtered by platform, so a signed GCS URL is only minted for stored assets.
    const platform = body.platform === 'tiktok' ? 'tiktok' : 'meta';
    const sql = platform === 'tiktok'
      ? `
      SELECT l.ad_id, m.asset_type, m.gcs_uri, m.fetch_status
      FROM (
        SELECT CAST(ad_id AS STRING) AS ad_id,
               COALESCE(NULLIF(video_id, ''), JSON_VALUE(image_ids, '$[0]')) AS asset_id,
               modify_time AS created_time
        FROM \`mcc-poc-477801.all_clients_tiktok.ads\`
      ) l
      LEFT JOIN \`mcc-poc-477801.all_clients.creative_manifest\` m
        ON m.asset_id = l.asset_id AND m.platform = 'tiktok'
      WHERE l.ad_id IN UNNEST(@adIds)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY l.ad_id ORDER BY l.created_time DESC) = 1`
      : `
      -- Representative asset per ad, matching the creative-audit pick order
      -- (audit.py / sql/creative_band_mining.sql): the asset actually DELIVERING
      -- the most impressions ("dominant in asset insights") wins first, then the
      -- most recently created asset, then one already stored in the bucket, then
      -- newest by created_time. Ads with no per-asset delivery data (the
      -- image/video_asset_insights feeds re-synced 2026-07-07, history still
      -- accruing) fall back to recency through the LEFT JOINs.
      WITH asset_delivery AS (
        SELECT ad_id, asset_id AS top_delivered_asset_id
        FROM (
          SELECT ad_id, asset_id, SUM(impressions) AS impr,
                 ROW_NUMBER() OVER (PARTITION BY ad_id ORDER BY SUM(impressions) DESC, asset_id) AS rn
          FROM (
            SELECT CAST(vi.ad_id AS STRING) AS ad_id, vi.video_asset_video_id AS asset_id,
                   SAFE_CAST(vi.impressions AS INT64) AS impressions
            FROM \`mcc-poc-477801.all_clients_meta.video_asset_insights\` vi
            WHERE CAST(vi.ad_id AS STRING) IN UNNEST(@adIds)
              AND vi.video_asset_video_id IS NOT NULL AND vi.video_asset_video_id != ''
            UNION ALL
            SELECT CAST(ii.ad_id AS STRING) AS ad_id, ii.image_asset_hash AS asset_id,
                   SAFE_CAST(ii.impressions AS INT64) AS impressions
            FROM \`mcc-poc-477801.all_clients_meta.image_asset_insights\` ii
            WHERE CAST(ii.ad_id AS STRING) IN UNNEST(@adIds)
              AND ii.image_asset_hash IS NOT NULL AND ii.image_asset_hash != ''
          )
          GROUP BY ad_id, asset_id
        )
        WHERE rn = 1 AND impr >= 100
      ),
      feed_recency AS (
        SELECT ad_id, asset_id, MAX(recency_ms) AS recency_ms
        FROM (
          SELECT ac.ad_id, JSON_VALUE(img, '$.hash') AS asset_id,
                 SAFE_CAST(REGEXP_EXTRACT(JSON_VALUE(al, '$.name'), r'_(\\d{13})$') AS INT64) AS recency_ms
          FROM (SELECT DISTINCT ad_id, creative_id FROM \`mcc-poc-477801.all_clients.meta_creative_links\`
                WHERE ad_id IN UNNEST(@adIds) AND creative_id IS NOT NULL) ac
          JOIN \`mcc-poc-477801.all_clients_meta.ad_creatives_from_ads\` cr ON cr.id = ac.creative_id,
               UNNEST(JSON_QUERY_ARRAY(cr.asset_feed_spec, '$.images')) img,
               UNNEST(JSON_QUERY_ARRAY(img, '$.adlabels')) al
          UNION ALL
          SELECT ac.ad_id, JSON_VALUE(vid, '$.video_id') AS asset_id,
                 SAFE_CAST(REGEXP_EXTRACT(JSON_VALUE(al, '$.name'), r'_(\\d{13})$') AS INT64) AS recency_ms
          FROM (SELECT DISTINCT ad_id, creative_id FROM \`mcc-poc-477801.all_clients.meta_creative_links\`
                WHERE ad_id IN UNNEST(@adIds) AND creative_id IS NOT NULL) ac
          JOIN \`mcc-poc-477801.all_clients_meta.ad_creatives_from_ads\` cr ON cr.id = ac.creative_id,
               UNNEST(JSON_QUERY_ARRAY(cr.asset_feed_spec, '$.videos')) vid,
               UNNEST(JSON_QUERY_ARRAY(vid, '$.adlabels')) al
        )
        WHERE asset_id IS NOT NULL AND recency_ms IS NOT NULL
        GROUP BY ad_id, asset_id
      ),
      asset_pref AS (
        SELECT ad_id, ARRAY_AGG(asset_id ORDER BY recency_ms DESC, asset_id)[OFFSET(0)] AS pref_asset_id
        FROM feed_recency GROUP BY ad_id
      )
      -- Return EVERY stored asset per ad (carousel cards), not just the top one,
      -- deduped to one row per (ad, asset). Card 0 stays the same representative
      -- asset the single-preview always picked (top-delivered -> preferred ->
      -- stored -> newest), so single-asset ads are unchanged; ads with more than
      -- one card drive the swipeable carousel in f10-preview.js.
      SELECT ad_id, asset_type, gcs_uri, fetch_status
      FROM (
        SELECT l.ad_id, m.asset_type, m.gcs_uri, m.fetch_status,
               COALESCE(l.video_id, l.image_hash) AS asset_key,
               IF(COALESCE(l.video_id, l.image_hash) = d.top_delivered_asset_id, 0, 1) AS r_top,
               IF(COALESCE(l.video_id, l.image_hash) = h.pref_asset_id, 0, 1) AS r_pref,
               IF(m.gcs_uri IS NOT NULL, 0, 1) AS r_uri,
               l.created_time AS created_time
        FROM \`mcc-poc-477801.all_clients.meta_creative_links\` l
        LEFT JOIN \`mcc-poc-477801.all_clients.creative_manifest\` m
          ON m.asset_id = COALESCE(l.video_id, l.image_hash) AND m.platform = 'meta'
        LEFT JOIN asset_pref h ON h.ad_id = l.ad_id
        LEFT JOIN asset_delivery d ON d.ad_id = l.ad_id
        WHERE l.ad_id IN UNNEST(@adIds)
        -- one row per (ad, asset): prefer the stored/fetched copy of each card
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY l.ad_id, COALESCE(l.video_id, l.image_hash)
          ORDER BY IF(m.gcs_uri IS NOT NULL, 0, 1), l.created_time DESC
        ) = 1
      )
      ORDER BY ad_id, r_top, r_pref, r_uri, created_time DESC, asset_key`;

    const [rows] = await bq.query({
      query: sql,
      params: { adIds },
      types: { adIds: ['STRING'] },
      location: 'australia-southeast1',
      useLegacySql: false,
      maximumBytesBilled: MAX_BYTES_BILLED,
      jobTimeoutMs: TIMEOUT_MS,
    });

    const storage = new Storage({ projectId: 'mcc-poc-477801', credentials });
    const expires = Date.now() + 15 * 60 * 1000; // 15 minutes

    // Group rows per ad in the query's card order (card 0 = representative pick).
    // Each ad becomes a list of signable cards; carousels keep every fetched frame,
    // single-asset ads yield a one-card list. The response stays backward
    // compatible — `type`/`url` mirror card 0 — and adds `cards` for the carousel.
    const byAd = new Map();
    for (const r of rows) {
      const list = byAd.get(r.ad_id) || [];
      list.push(r);
      byAd.set(r.ad_id, list);
    }

    const out = {};
    await Promise.all(
      Array.from(byAd.entries()).map(async ([adId, list]) => {
        const fallbackType = (list[0] && list[0].asset_type) || null;
        const cards = []; // index-aligned to `list` so query order survives signing
        await Promise.all(
          list.map(async (r, i) => {
            if (r.fetch_status !== 'fetched' || !r.gcs_uri) return;
            try {
              const url = await signGcsUri(storage, r.gcs_uri, expires);
              if (!url) return;
              const ext = (r.gcs_uri.split('.').pop() || '').toLowerCase();
              const type = r.asset_type || (ext === 'mp4' || ext === 'mov' ? 'video' : 'image');
              cards[i] = { type, url };
            } catch (e) {
              console.error('Signed URL error for', r.gcs_uri, e.message);
            }
          })
        );
        const ordered = cards.filter(Boolean); // drop unfetched/unsigned gaps, keep order
        const primary = ordered[0] || { type: fallbackType, url: null };
        out[adId] = { type: primary.type, url: primary.url, cards: ordered };
      })
    );

    return json(200, out);
  } catch (err) {
    console.error('Media resolve error:', err);
    return json(500, { error: err.message });
  }
}

/* The components bucket the Python pipeline publishes generated bundles into. */
const COMPONENTS_BUCKET = 'f10-creative-assets';

/* Path-safe GCS segment, mirroring the pipeline's _safe(): any run of characters
 * outside [A-Za-z0-9._-] collapses to '_', leading/trailing '_' are stripped, and
 * an empty result falls back to 'asset'. Case is PRESERVED so the segment matches
 * exactly what the pipeline wrote for the client and bundle id. */
function safeGcsSegment(value) {
  const s = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'asset';
}

/* The caller's client reduced to the pipeline's brief-id client slug form: the
 * lowercased client with any non-alphanumeric run turned into '-'. This is the
 * form embedded in a brief/bundle id, so it is what the scope check compares. */
function clientSlug(client) {
  return (
    String(client == null ? '' : client)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'client'
  );
}

/* The client slug a bundle id provably belongs to, or '' when the id does not
 * encode one. Pipeline brief ids are `brief_{clientslug}_{archetypeslug}_{digest}`
 * and neither slug contains an underscore (their builder maps non-alnum to '-'),
 * so a well-formed id splits on '_' into exactly [brief, client, archetype, digest]
 * and the owning client slug is the second token. */
function bundleOwnerSlug(bundleId) {
  const parts = String(bundleId == null ? '' : bundleId).split('_');
  if (parts.length >= 4 && parts[0] === 'brief' && parts[1]) {
    return parts[1].toLowerCase();
  }
  return '';
}

/* The bundle-keyed object path (no gs:// prefix) for a bundle's composed preview,
 * matching the pipeline exactly:
 *   components/{platform}/{client}/{bundle_id}/composite.png */
function compositeObjectName(client, bundleId, platform) {
  const plat = platform === 'tiktok' ? 'tiktok' : 'meta';
  return (
    'components/' + plat + '/' + safeGcsSegment(client) + '/' +
    safeGcsSegment(bundleId) + '/composite.png'
  );
}

/* GCS object-viewer credentials for signing bucket reads. Prefers a dedicated
 * GCS_OBJECT_VIEWER_SA when configured, else the dashboard's storage-read SA
 * (GOOGLE_SERVICE_ACCOUNT, which holds roles/storage.objectViewer on the bucket).
 * This is the object-viewer SA path; the resolver never uses the BigQuery job SA
 * to read the bucket. */
function objectViewerCredentials(fallback) {
  const raw = process.env.GCS_OBJECT_VIEWER_SA;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('GCS_OBJECT_VIEWER_SA is set but not valid JSON; falling back.');
    }
  }
  return fallback;
}

/* Resolve a GENERATED bundle's composed preview image to a short-lived signed
 * read URL, given the caller's client scope and the bundle id.
 *
 * Delivered ads map an ad_id to an asset through BigQuery (the `media` action);
 * a generated bundle is in no BigQuery table. Its composed preview lands at ONE
 * deterministic, bundle-keyed object written by the pipeline at publish time:
 *   gs://f10-creative-assets/components/{platform}/{client}/{bundle_id}/composite.png
 * so this resolver touches NO BigQuery at all and signs the read URL with the GCS
 * object-viewer SA path (never the BigQuery SA).
 *
 * Client scope is category-1. The composite path is keyed by the CALLER'S client,
 * and the bundle id must belong to that same client, so a caller scoped to client
 * A can neither name nor resolve client B's object. A bundle id that provably
 * encodes a different owner is refused before storage is ever touched.
 *
 * Never throws for a foreign/absent/unsignable composite: it returns
 * { url: null, reason } so the review surface can fall back without leaking
 * another client's data. */
async function resolveGeneratedPreview(body, credentials, cors) {
  const json = (statusCode, payload) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const client = typeof body.client === 'string' ? body.client.trim() : '';
  const bundleId = typeof body.bundleId === 'string' ? body.bundleId.trim() : '';
  const platform = body.platform === 'tiktok' ? 'tiktok' : 'meta';

  if (!client || !bundleId) {
    return json(200, { url: null, reason: 'missing-client-or-bundle' });
  }

  // Enforce client scope up front: refuse a bundle that provably belongs to a
  // different client before any storage call, so A can never probe B's namespace.
  const owner = bundleOwnerSlug(bundleId);
  if (owner && owner !== clientSlug(client)) {
    return json(200, { url: null, reason: 'client-scope-mismatch' });
  }

  const objectName = compositeObjectName(client, bundleId, platform);
  const gcsUri = 'gs://' + COMPONENTS_BUCKET + '/' + objectName;

  try {
    // Object-viewer SA path only. This resolver never constructs a BigQuery
    // client, so the BigQuery SA is never used to read the bucket.
    const storage = new Storage({
      projectId: 'mcc-poc-477801',
      credentials: objectViewerCredentials(credentials),
    });

    // Only sign what actually exists, so an absent composite returns a clean
    // { url:null, reason } instead of a signed URL that 404s in the browser.
    const [exists] = await storage.bucket(COMPONENTS_BUCKET).file(objectName).exists();
    if (!exists) {
      return json(200, { url: null, reason: 'not-found' });
    }

    const expires = Date.now() + 15 * 60 * 1000; // 15 minutes, mirrors `media`
    const url = await signGcsUri(storage, gcsUri, expires);
    if (!url) {
      return json(200, { url: null, reason: 'unresolvable' });
    }
    return json(200, { url, client, bundleId, platform });
  } catch (err) {
    console.error('Generated-preview resolve error:', err);
    return json(200, { url: null, reason: 'error' });
  }
}

/* Map a gs:// URI's extension to a Content-Type so the signed response makes
 * <video>/<img> play even when the object was stored as octet-stream. */
function gcsContentType(gcsUri) {
  const ext = (gcsUri.split('.').pop() || '').toLowerCase();
  return (
    ext === 'mp4' ? 'video/mp4' :
    ext === 'mov' ? 'video/quicktime' :
    ext === 'png' ? 'image/png' :
    ext === 'gif' ? 'image/gif' :
    (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : undefined
  );
}

/* Mint one short-lived V4 signed read URL for a gs:// asset. Shared by the
 * media and competitor actions so signing lives in exactly one place: the
 * bucket stays private, only the time-limited URL ever reaches the browser,
 * and nothing is base64-inlined. Returns null for an unparseable URI; lets
 * getSignedUrl errors bubble so callers can log and fall back per asset. */
async function signGcsUri(storage, gcsUri, expires) {
  const parsed = /^gs:\/\/([^/]+)\/(.+)$/.exec(gcsUri || '');
  if (!parsed) return null;
  const [url] = await storage
    .bucket(parsed[1])
    .file(parsed[2])
    .getSignedUrl({ version: 'v4', action: 'read', expires, responseType: gcsContentType(gcsUri) });
  return url;
}

/* Competitor Ad Library for one dashboard's client.
 *
 * Everything is keyed by f10_client in the shared all_clients_adlib dataset,
 * so this single action serves every dashboard with no per-client config — the
 * client key arrives as body.client (the frontend already knows it from the
 * dashboard config, mirroring how the query/media actions receive their inputs).
 *
 * METADATA ONLY: this action returns the latest snapshot per ad WITHOUT any
 * creatives and WITHOUT any signed-URL work — the dashboard loads a page's
 * creatives lazily via the `competitor-creatives` action. It carries an optional
 * date window: body.days = a positive number (e.g. 30/60/90) filters
 * run_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY) INSIDE the per-ad
 * subquery before the latest-snapshot pick, pruning the partition scan; an
 * absent/null days is full history (the only unpruned scan). The two age-metrics
 * marts are read in parallel with the ads query, each absent-safe. Same
 * byte-billed / timeout guardrails as every other query here.
 *
 *   { action:'competitor', client:'mosh', days:90 }     -> { ads:[...], ageMetrics, days:90 }
 *   { action:'competitor', client:'mosh' }              -> { ads:[...], ageMetrics, days:null }
 *   { action:'competitor', client:'mosh', probe:true }  -> { exists: true|false }
 */
async function queryCompetitor(body, credentials, cors) {
  const json = (statusCode, payload) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const client = typeof body.client === 'string' ? body.client.trim() : '';
  if (!client) return json(400, { error: 'Missing "client" field for competitor action.' });

  const PROJECT = 'mcc-poc-477801';
  const DATASET = 'all_clients_adlib';

  try {
    const bq = new BigQuery({
      projectId: PROJECT,
      credentials,
      location: 'australia-southeast1',
    });

    // Shared per-query options so every competitor query carries the same
    // byte-billed cap and timeout guardrails as the rest of this function.
    // params/types default to the { client } scope; the ads query overrides to
    // add the optional @days window bound.
    const runQuery = (query, params = { client }, types = { client: 'STRING' }) =>
      bq.query({
        query,
        params,
        types,
        location: 'australia-southeast1',
        useLegacySql: false,
        maximumBytesBilled: MAX_BYTES_BILLED,
        jobTimeoutMs: TIMEOUT_MS,
      });

    // Cheap existence probe (US-003): does this client have any competitor rows?
    if (body.probe) {
      const [rows] = await runQuery(
        `SELECT EXISTS(
           SELECT 1 FROM \`${PROJECT}.${DATASET}.ad_registry\`
           WHERE f10_client = @client
         ) AS has_data`
      );
      return json(200, { exists: !!(rows[0] && rows[0].has_data) });
    }

    // Optional date window: a positive body.days prunes the partition scan to the
    // last N days; absent/null is full history (the only unpruned scan). The bound
    // is applied INSIDE the per-ad subquery, before the latest-snapshot pick.
    const daysRaw = Number(body.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : null;
    const dateFilter = days != null
      ? 'AND run_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)'
      : '';
    const adsParams = days != null ? { client, days } : { client };
    const adsTypes = days != null ? { client: 'STRING', days: 'INT64' } : { client: 'STRING' };

    // Latest daily snapshot per ad (metadata only — no creatives), joined to the
    // ad_registry still_active flag. Dead columns (days_active_observed,
    // first_seen_date) are no longer projected; the frontend never renders them.
    const adsP = runQuery(`
      WITH latest AS (
        SELECT * EXCEPT(rn) FROM (
          SELECT ad_archive_id, page_name, display_format, cta_type,
                 ad_creative_bodies, link_url, snapshot_url, is_active,
                 ad_delivery_start_time, ad_delivery_stop_time,
                 ROW_NUMBER() OVER (PARTITION BY ad_archive_id ORDER BY run_date DESC) rn
          FROM \`${PROJECT}.${DATASET}.ad_snapshots\`
          WHERE f10_client = @client ${dateFilter}
        )
        WHERE rn = 1
      )
      SELECT l.*, r.still_active
      FROM latest l
      LEFT JOIN \`${PROJECT}.${DATASET}.ad_registry\` r USING (ad_archive_id)
      ORDER BY l.page_name, l.ad_delivery_start_time ASC, l.ad_archive_id
    `, adsParams, adsTypes);

    // Optional age-metrics reads (US-004) — absent-safe: the competitor_age_by_client
    // and competitor_age_by_page marts may not exist for a client/account yet, so a
    // table-not-found is swallowed and the frontend age-metrics header simply doesn't
    // render. The two marts are read independently so one present / one absent still
    // yields what data exists. Both run IN PARALLEL with the ads query (Promise.all);
    // a genuine (non-not-found) error still rejects and surfaces as a loud 500.
    const ageMetrics = { client: null, byPage: {} };
    const clientAgeP = runQuery(`
        SELECT f10_client, ads_tracked, ads_live, avg_age_live_days,
               live_lt_7d, live_7_30d, live_30_90d, live_90d_plus, last_refreshed
        FROM \`${PROJECT}.${DATASET}.competitor_age_by_client\`
        WHERE f10_client = @client
      `).then(([clientAgeRows]) => {
        ageMetrics.client = clientAgeRows.length ? clientAgeRows[0] : null;
      }).catch((e) => {
        const notFound = e && (e.code === 404 || /not found|does not exist/i.test(e.message || ''));
        if (!notFound) throw e;
        console.warn('competitor_age_by_client unavailable, continuing without client age metrics:', e.message);
      });
    const pageAgeP = runQuery(`
        SELECT f10_client, page_id, page_name, ads_tracked, ads_live, avg_age_live_days,
               live_lt_7d, live_7_30d, live_30_90d, live_90d_plus, last_refreshed
        FROM \`${PROJECT}.${DATASET}.competitor_age_by_page\`
        WHERE f10_client = @client
      `).then(([pageAgeRows]) => {
        // Key by page_name to match how the frontend groups competitor sections.
        for (const p of pageAgeRows) {
          if (p.page_name != null && p.page_name !== '') ageMetrics.byPage[String(p.page_name)] = p;
        }
      }).catch((e) => {
        const notFound = e && (e.code === 404 || /not found|does not exist/i.test(e.message || ''));
        if (!notFound) throw e;
        console.warn('competitor_age_by_page unavailable, continuing without per-page age metrics:', e.message);
      });

    const [adsResult] = await Promise.all([adsP, clientAgeP, pageAgeP]);
    const ads = adsResult[0];

    // Return metadata only — no creatives, no signing. The dashboard loads a
    // page's creatives on demand via the competitor-creatives action. `days`
    // echoes the applied window (a positive number) or null for full history.
    return json(200, { ads, ageMetrics, days });
  } catch (err) {
    console.error('Competitor query error:', err);
    return json(500, { error: err.message });
  }
}

/* On-demand signed creative URLs for a set of competitor ads (metadata/lazy
 * split). The competitor and competitor-search actions are metadata-only; the
 * dashboard calls this for just the ads on the page it is about to show, so only
 * that page's private assets are ever signed and fetched by the browser.
 *
 * Reads creative_manifest for the requested adIds only (same latest-per
 * (ad_archive_id, idx) QUALIFY and video-first ORDER as the old inline creatives
 * query), signs each via signGcsUri (parallel, 15-min V4 read URLs), and deletes
 * the private gs:// URI before the row leaves the function. adIds is capped at 60;
 * ids beyond the cap are ignored. Same byte-billed / timeout guardrails.
 *
 *   { action:'competitor-creatives', client:'mosh', adIds:['A1','A2'] }
 *     -> { creativesByAd: { A1:[{media_type, idx, url}], ... } }
 */
async function queryCompetitorCreatives(body, credentials, cors) {
  const json = (statusCode, payload) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const client = typeof body.client === 'string' ? body.client.trim() : '';
  if (!client) return json(400, { error: 'Missing "client" field for competitor-creatives action.' });

  // adIds must be a non-empty array; coerce to strings, drop blanks, cap at 60.
  const CAP = 60;
  const adIds = Array.isArray(body.adIds)
    ? body.adIds.map((x) => (x == null ? '' : String(x))).filter((x) => x).slice(0, CAP)
    : [];
  if (!adIds.length) return json(400, { error: 'competitor-creatives requires a non-empty "adIds" array.' });

  const PROJECT = 'mcc-poc-477801';
  const DATASET = 'all_clients_adlib';

  try {
    const bq = new BigQuery({
      projectId: PROJECT,
      credentials,
      location: 'australia-southeast1',
    });

    // All fetched creatives for just the requested ads, so carousels keep every
    // frame. Grouped in query order (video first, then idx) before signing.
    const [creativeRows] = await bq.query({
      query: `
        SELECT ad_archive_id, media_type, idx, gcs_uri
        FROM \`${PROJECT}.${DATASET}.creative_manifest\`
        WHERE f10_client = @client AND fetch_status = 'fetched'
          AND ad_archive_id IN UNNEST(@adIds)
        QUALIFY ROW_NUMBER() OVER (PARTITION BY ad_archive_id, idx ORDER BY fetched_at DESC) = 1
        ORDER BY ad_archive_id, (media_type = 'video') DESC, idx
      `,
      params: { client, adIds },
      types: { client: 'STRING', adIds: ['STRING'] },
      location: 'australia-southeast1',
      useLegacySql: false,
      maximumBytesBilled: MAX_BYTES_BILLED,
      jobTimeoutMs: TIMEOUT_MS,
    });

    const creativesByAd = {};
    for (const c of creativeRows) {
      const key = String(c.ad_archive_id);
      if (!creativesByAd[key]) creativesByAd[key] = [];
      creativesByAd[key].push({
        media_type: c.media_type,
        idx: c.idx,
        _gcsUri: c.gcs_uri,
        url: null,
      });
    }

    // Sign every fetched creative at request time, mutating in place so the per-ad
    // ordering survives the parallel signing; delete the gs:// URI before return.
    const storage = new Storage({ projectId: PROJECT, credentials });
    const expires = Date.now() + 15 * 60 * 1000; // 15 minutes
    const allCreatives = [];
    for (const list of Object.values(creativesByAd)) allCreatives.push(...list);
    await Promise.all(
      allCreatives.map(async (item) => {
        try {
          item.url = await signGcsUri(storage, item._gcsUri, expires);
        } catch (e) {
          console.error('Signed URL error for', item._gcsUri, e.message);
          item.url = null;
        }
        delete item._gcsUri; // never leak the private gs:// URI to the browser
      })
    );

    return json(200, { creativesByAd });
  } catch (err) {
    console.error('Competitor creatives query error:', err);
    return json(500, { error: err.message });
  }
}

/* Cross-competitor ad search for one dashboard's client (US-006).
 *
 * Term search across this client's tracked competitor ads: ad copy
 * (ad_creative_bodies), link titles, page name, link URL, CTA type, and the
 * vision-extracted on-screen text (competitor_vision_attributes.on_screen_text).
 * Everything stays keyed by f10_client in the shared all_clients_adlib dataset,
 * so — like the competitor action — this single action serves every dashboard
 * with no per-client config; the client key arrives as body.client.
 *
 * Fails closed exactly like the competitor tab: a client with no competitor rows
 * (probe) and an empty / too-short term both return an empty set WITHOUT a full
 * scan, so the UI can hide the surface. Matching is CONTAINS_SUBSTR — a
 * normalized, case-insensitive substring search — and every returned ad carries
 * matched_fields so the UI can show which field hit. METADATA ONLY: like the
 * competitor action, this returns no creatives — the dashboard loads the matched
 * page's creatives lazily via the competitor-creatives action. Same
 * maximumBytesBilled / jobTimeoutMs guardrails as every other query here.
 *
 *   { action:'competitor-search', client:'mosh', term:'menopause' } -> { ads:[...], term }
 *   { action:'competitor-search', client:'mosh', probe:true }        -> { exists: true|false }
 */
async function queryCompetitorSearch(body, credentials, cors) {
  const json = (statusCode, payload) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const client = typeof body.client === 'string' ? body.client.trim() : '';
  if (!client) return json(400, { error: 'Missing "client" field for competitor-search action.' });

  const PROJECT = 'mcc-poc-477801';
  const DATASET = 'all_clients_adlib';
  // Terms shorter than this never hit BigQuery — a 1-char substring matches most
  // ads and would force a full scan for no real signal.
  const MIN_TERM_LEN = 2;

  try {
    const bq = new BigQuery({
      projectId: PROJECT,
      credentials,
      location: 'australia-southeast1',
    });

    // Shared per-query options so every search query carries the same byte-billed
    // cap and timeout guardrails as the rest of this function. params/types
    // default to the {client} scope; callers override for the term + creative reads.
    const runQuery = (query, params = { client }, types = { client: 'STRING' }) =>
      bq.query({
        query,
        params,
        types,
        location: 'australia-southeast1',
        useLegacySql: false,
        maximumBytesBilled: MAX_BYTES_BILLED,
        jobTimeoutMs: TIMEOUT_MS,
      });

    // Same cheap existence probe as the competitor action so the search surface
    // fails closed (hidden) for clients with no competitor data at all.
    if (body.probe) {
      const [rows] = await runQuery(
        `SELECT EXISTS(
           SELECT 1 FROM \`${PROJECT}.${DATASET}.ad_registry\`
           WHERE f10_client = @client
         ) AS has_data`
      );
      return json(200, { exists: !!(rows[0] && rows[0].has_data) });
    }

    const term = typeof body.term === 'string' ? body.term.trim() : '';
    // Empty / too-short term returns fast without scanning anything.
    if (term.length < MIN_TERM_LEN) return json(200, { ads: [], term });

    // Latest snapshot per ad, joined to the ad's vision on-screen text. The copy
    // arrays are flattened to text so CONTAINS_SUBSTR can search them; matched_fields
    // records which fields hit. Everything is scoped WHERE f10_client = @client.
    const [ads] = await runQuery(
      `
      WITH latest AS (
        SELECT * EXCEPT(rn) FROM (
          SELECT ad_archive_id, page_name, display_format, cta_type,
                 ad_creative_bodies, ad_creative_link_titles, link_url,
                 snapshot_url, is_active, ad_delivery_start_time,
                 ROW_NUMBER() OVER (PARTITION BY ad_archive_id ORDER BY run_date DESC) rn
          FROM \`${PROJECT}.${DATASET}.ad_snapshots\`
          WHERE f10_client = @client
        )
        WHERE rn = 1
      ),
      vision AS (
        SELECT ad_archive_id, STRING_AGG(on_screen_text, ' ') AS on_screen_text
        FROM \`${PROJECT}.${DATASET}.competitor_vision_attributes\`
        WHERE f10_client = @client
        GROUP BY ad_archive_id
      ),
      joined AS (
        SELECT l.*,
               ARRAY_TO_STRING(l.ad_creative_bodies, ' ')      AS _bodies_txt,
               ARRAY_TO_STRING(l.ad_creative_link_titles, ' ') AS _titles_txt,
               v.on_screen_text AS on_screen_text
        FROM latest l
        LEFT JOIN vision v USING (ad_archive_id)
      )
      SELECT
        j.* EXCEPT(_bodies_txt, _titles_txt),
        r.days_active_observed, r.first_seen_date, r.still_active,
        ARRAY(
          SELECT f FROM UNNEST([
            IF(CONTAINS_SUBSTR(j._bodies_txt, @term),    'ad_creative_bodies',      NULL),
            IF(CONTAINS_SUBSTR(j._titles_txt, @term),    'ad_creative_link_titles', NULL),
            IF(CONTAINS_SUBSTR(j.page_name, @term),      'page_name',               NULL),
            IF(CONTAINS_SUBSTR(j.link_url, @term),       'link_url',                NULL),
            IF(CONTAINS_SUBSTR(j.cta_type, @term),       'cta_type',                NULL),
            IF(CONTAINS_SUBSTR(j.on_screen_text, @term), 'on_screen_text',          NULL)
          ]) f WHERE f IS NOT NULL
        ) AS matched_fields
      FROM joined j
      LEFT JOIN \`${PROJECT}.${DATASET}.ad_registry\` r USING (ad_archive_id)
      WHERE CONTAINS_SUBSTR(j._bodies_txt, @term)
         OR CONTAINS_SUBSTR(j._titles_txt, @term)
         OR CONTAINS_SUBSTR(j.page_name, @term)
         OR CONTAINS_SUBSTR(j.link_url, @term)
         OR CONTAINS_SUBSTR(j.cta_type, @term)
         OR CONTAINS_SUBSTR(j.on_screen_text, @term)
      ORDER BY j.page_name, j.ad_delivery_start_time ASC, j.ad_archive_id
      `,
      { client, term },
      { client: 'STRING', term: 'STRING' }
    );

    // No matching ads is a normal empty state, not an error. Return metadata only —
    // the dashboard loads the matched page's creatives lazily via competitor-creatives.
    return json(200, { ads, term });
  } catch (err) {
    console.error('Competitor search error:', err);
    return json(500, { error: err.message });
  }
}


/* ── US-007 competitor-intelligence tab actions ───────────────────────────────
 *
 * themes / age-timeseries / maturity / leaderboard / net-new are each a THIN read
 * over a single governed table in the shared all_clients_adlib dataset, keyed by
 * f10_client so one function serves every dashboard with no per-client config —
 * exactly like the competitor and competitor-search actions above.
 *
 * FAIL-CLOSED CONTRACT (mirrors queryCompetitor): a { probe:true } call returns
 * { exists:true|false } from a cheap EXISTS check; a normal call returns an empty
 * payload when the client has no rows. If the underlying mart does not physically
 * exist yet (a client whose competitor pipeline has not been built), the
 * table-not-found is caught and treated as "absent" (empty / { exists:false }),
 * so the tab simply hides instead of erroring. ONLY a genuine table-not-found is
 * swallowed — every other BigQuery error propagates to a loud 500
 * (hq-never-swallow-errors). No raw SQL and no gs:// URI ever reach the browser;
 * the frontend calls by action name only.
 */
const ADLIB_PROJECT = 'mcc-poc-477801';
const ADLIB_DATASET = 'all_clients_adlib';
const ADLIB_LOCATION = 'australia-southeast1';

// A BigQuery error meaning "this mart/table isn't there yet" (fail-closed / absent),
// as opposed to a real failure that must surface. Same shape as the age-metrics
// not-found guard in queryCompetitor.
function isTableNotFound(err) {
  return !!(err && (err.code === 404 || /not found|does not exist/i.test(err.message || '')));
}

// Best-effort parse of a JSON-string column (themes/format_mix/common_phrases are
// stored as JSON text). Returns the parsed value, or the fallback for null, or the
// raw string if it is not valid JSON — never throws, so one malformed row cannot
// take down the whole payload.
function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

// Shared plumbing for every US-007 action: a JSON responder and a client-scoped,
// guardrailed query runner. Returns { badRequest } (a 400 response) when the
// required client field is missing, so each action can bail in one line.
function martContext(body, credentials, cors, action) {
  const json = (statusCode, payload) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const client = typeof body.client === 'string' ? body.client.trim() : '';
  if (!client) {
    return { json, badRequest: json(400, { error: `Missing "client" field for ${action} action.` }) };
  }
  const bq = new BigQuery({ projectId: ADLIB_PROJECT, credentials, location: ADLIB_LOCATION });
  // Every US-007 query carries the same byte-billed cap + timeout guardrails as the
  // rest of this function. params/types default to the { client } scope; callers
  // override to add extra params (e.g. the leaderboard @limit).
  const runQuery = (queryText, params = { client }, types = { client: 'STRING' }) =>
    bq.query({
      query: queryText,
      params,
      types,
      location: ADLIB_LOCATION,
      useLegacySql: false,
      maximumBytesBilled: MAX_BYTES_BILLED,
      jobTimeoutMs: TIMEOUT_MS,
    });
  return { json, client, runQuery };
}

/* themes — per-competitor named-theme summaries (US-001 rollup).
 * Reads competitor_theme_summary, returning the LATEST summary per competitor page
 * (MERGE key run_date). Every theme narrative is returned in full — named themes,
 * dominant angle/message narrative, format mix, recurring phrases, confidence — so
 * the tab can state the "so what", not a bare label (insight-ladder-l4-l5-gate).
 *   { action:'themes', client:'mosh' }             -> { competitors:[...] }
 *   { action:'themes', client:'mosh', probe:true }  -> { exists: true|false }
 */
async function queryThemes(body, credentials, cors) {
  const cx = martContext(body, credentials, cors, 'themes');
  if (cx.badRequest) return cx.badRequest;
  const { json, runQuery } = cx;
  const TABLE = `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.competitor_theme_summary\``;
  try {
    if (body.probe) {
      const [rows] = await runQuery(
        `SELECT EXISTS(SELECT 1 FROM ${TABLE} WHERE f10_client = @client AND status = 'ok') AS has_data`
      );
      return json(200, { exists: !!(rows[0] && rows[0].has_data) });
    }
    // competitor_theme_summary is keyed on page_id only (it carries no page_name).
    // The consolidated surface needs the human-readable page_name in the header, so
    // resolve it here from the client-scoped ad_snapshots (which carries both
    // page_id and page_name) rather than shipping a bare page_id to the browser.
    // This is the recurring cross-repo drift fix (competitor-intel-rollup US-008):
    // the frontend receives page_name, not just page_id. Absent-safe: a page with no
    // snapshot name falls through as NULL and the frontend still shows the id.
    const SNAPSHOTS = `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.ad_snapshots\``;
    const [rows] = await runQuery(`
      WITH names AS (
        SELECT page_id, ANY_VALUE(page_name) AS page_name
        FROM ${SNAPSHOTS}
        WHERE f10_client = @client AND page_name IS NOT NULL
        GROUP BY page_id
      )
      SELECT t.page_id, n.page_name, t.run_date, t.themes, t.dominant_narrative,
             t.format_mix, t.common_phrases, t.analysis_confidence,
             t.vision_rows_summarised, t.summary_model, t.generated_at
      FROM ${TABLE} t
      LEFT JOIN names n USING (page_id)
      WHERE t.f10_client = @client AND t.status = 'ok'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY t.page_id ORDER BY t.run_date DESC) = 1
      ORDER BY n.page_name, t.page_id
    `);
    const competitors = rows.map((r) => ({
      page_id: r.page_id,
      page_name: r.page_name,
      run_date: r.run_date,
      themes: parseJsonColumn(r.themes, []),
      dominant_narrative: r.dominant_narrative,
      format_mix: parseJsonColumn(r.format_mix, {}),
      common_phrases: parseJsonColumn(r.common_phrases, []),
      analysis_confidence: r.analysis_confidence,
      vision_rows_summarised: r.vision_rows_summarised,
      summary_model: r.summary_model,
      generated_at: r.generated_at,
    }));
    return json(200, { competitors });
  } catch (err) {
    if (isTableNotFound(err)) return json(200, body.probe ? { exists: false } : { competitors: [] });
    console.error('Themes query error:', err);
    return json(500, { error: err.message });
  }
}

/* age-timeseries — ad-age-over-time with client comparison (US-003 mart).
 * Reads competitor_age_over_time (one shared monthly axis, one age definition) and
 * splits it into the client's own line and one series per competitor page, each
 * carrying average AND median live ad age per month.
 *   { action:'age-timeseries', client:'mosh' }            -> { client:[...], competitors:[...] }
 *   { action:'age-timeseries', client:'mosh', probe:true } -> { exists: true|false }
 */
async function queryAgeTimeseries(body, credentials, cors) {
  const cx = martContext(body, credentials, cors, 'age-timeseries');
  if (cx.badRequest) return cx.badRequest;
  const { json, runQuery } = cx;
  const TABLE = `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.competitor_age_over_time\``;
  try {
    if (body.probe) {
      const [rows] = await runQuery(
        `SELECT EXISTS(SELECT 1 FROM ${TABLE} WHERE f10_client = @client) AS has_data`
      );
      return json(200, { exists: !!(rows[0] && rows[0].has_data) });
    }
    const [rows] = await runQuery(`
      SELECT entity_type, page_id, page_name, period_month,
             ads_live, avg_age_live_days, median_age_live_days
      FROM ${TABLE}
      WHERE f10_client = @client
      ORDER BY entity_type, page_name, page_id, period_month
    `);
    const clientSeries = [];
    const competitorsByPage = {};
    for (const r of rows) {
      const point = {
        period_month: r.period_month,
        ads_live: r.ads_live,
        avg_age_live_days: r.avg_age_live_days,
        median_age_live_days: r.median_age_live_days,
      };
      if (r.entity_type === 'client') {
        clientSeries.push(point);
      } else {
        const key = String(r.page_id);
        if (!competitorsByPage[key]) {
          competitorsByPage[key] = { page_id: r.page_id, page_name: r.page_name, series: [] };
        }
        competitorsByPage[key].series.push(point);
      }
    }
    return json(200, { client: clientSeries, competitors: Object.values(competitorsByPage) });
  } catch (err) {
    if (isTableNotFound(err)) return json(200, body.probe ? { exists: false } : { client: [], competitors: [] });
    console.error('Age-timeseries query error:', err);
    return json(500, { error: err.message });
  }
}

/* maturity — explainable 0-100 Meta maturity score + client rank (US-005 mart).
 * Reads competitor_meta_maturity and returns, for every competitor and the client,
 * the composite score TOGETHER WITH all six component sub-scores, the raw signals,
 * the data-layer-owned maturity_tier band label, and the entity's rank within the
 * set — so the decision surface explains WHY, never a bare number
 * (insight-ladder-l4-l5-gate; hq-classifier-own-labels-single-source: render the
 * mart's maturity_tier, never re-band the composite downstream).
 *   { action:'maturity', client:'mosh' }            -> { client:{...}, competitors:[...], set_size }
 *   { action:'maturity', client:'mosh', probe:true } -> { exists: true|false }
 */
async function queryMaturity(body, credentials, cors) {
  const cx = martContext(body, credentials, cors, 'maturity');
  if (cx.badRequest) return cx.badRequest;
  const { json, runQuery } = cx;
  const TABLE = `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.competitor_meta_maturity\``;
  try {
    if (body.probe) {
      const [rows] = await runQuery(
        `SELECT EXISTS(SELECT 1 FROM ${TABLE} WHERE f10_client = @client) AS has_data`
      );
      return json(200, { exists: !!(rows[0] && rows[0].has_data) });
    }
    const [rows] = await runQuery(`
      SELECT entity_type, entity_id, page_id, page_name,
             composite_score, maturity_tier, maturity_rank, set_size,
             longevity_score, cadence_score, volume_score, active_ratio_score,
             format_diversity_score, platform_spread_score,
             volume_raw, longevity_raw, active_ratio_raw, cadence_raw, format_raw, platform_raw
      FROM ${TABLE}
      WHERE f10_client = @client
      ORDER BY maturity_rank
    `);
    // Keep every component sub-score + raw signal beside the composite so the score
    // is explainable at the decision surface, not a black box.
    const shape = (r) => ({
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      page_id: r.page_id,
      page_name: r.page_name,
      composite_score: r.composite_score,
      maturity_tier: r.maturity_tier,
      maturity_rank: r.maturity_rank,
      set_size: r.set_size,
      sub_scores: {
        longevity: r.longevity_score,
        cadence: r.cadence_score,
        volume: r.volume_score,
        active_ratio: r.active_ratio_score,
        format_diversity: r.format_diversity_score,
        platform_spread: r.platform_spread_score,
      },
      raw_signals: {
        volume: r.volume_raw,
        longevity: r.longevity_raw,
        active_ratio: r.active_ratio_raw,
        cadence: r.cadence_raw,
        format: r.format_raw,
        platform: r.platform_raw,
      },
    });
    const clientRow = rows.find((r) => r.entity_type === 'client') || null;
    const competitors = rows.filter((r) => r.entity_type === 'competitor').map(shape);
    return json(200, {
      client: clientRow ? shape(clientRow) : null,
      competitors,
      set_size: rows.length ? rows[0].set_size : 0,
    });
  } catch (err) {
    if (isTableNotFound(err)) return json(200, body.probe ? { exists: false } : { client: null, competitors: [] });
    console.error('Maturity query error:', err);
    return json(500, { error: err.message });
  }
}

/* leaderboard — live competitor ads ranked by age (longevity leaderboard).
 * A thin read over the same governed ad_registry + ad_snapshots pair the competitor
 * action uses: still-active ads for the client's competitor set, ranked by true live
 * age (days since Meta stated go-live, else first observed). Returns only the public
 * Ad Library snapshot_url — no gs:// URI, no creative signing needed here.
 *   { action:'leaderboard', client:'mosh' }              -> { ads:[...] }
 *   { action:'leaderboard', client:'mosh', limit:50 }     -> { ads:[...] } (capped at 100)
 *   { action:'leaderboard', client:'mosh', probe:true }   -> { exists: true|false }
 */
async function queryLeaderboard(body, credentials, cors) {
  const cx = martContext(body, credentials, cors, 'leaderboard');
  if (cx.badRequest) return cx.badRequest;
  const { json, client, runQuery } = cx;
  const REGISTRY = `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.ad_registry\``;
  const SNAPSHOTS = `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.ad_snapshots\``;
  // Bounded result size: caller may ask for fewer, never more than the cap.
  const CAP = 100;
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 25, 1), CAP);
  try {
    if (body.probe) {
      const [rows] = await runQuery(
        `SELECT EXISTS(SELECT 1 FROM ${REGISTRY} WHERE f10_client = @client AND still_active) AS has_data`
      );
      return json(200, { exists: !!(rows[0] && rows[0].has_data) });
    }
    const [rows] = await runQuery(
      `
      WITH live AS (
        SELECT ad_archive_id, page_id, first_seen_date, days_active_observed,
               COALESCE(meta_start_time, first_seen_date) AS go_live_date
        FROM ${REGISTRY}
        WHERE f10_client = @client AND still_active
      ),
      latest_snap AS (
        SELECT * EXCEPT(rn) FROM (
          SELECT ad_archive_id, page_name, display_format, snapshot_url,
                 ROW_NUMBER() OVER (PARTITION BY ad_archive_id ORDER BY run_date DESC) rn
          FROM ${SNAPSHOTS}
          WHERE f10_client = @client
        )
        WHERE rn = 1
      )
      SELECT l.ad_archive_id, l.page_id, s.page_name, s.display_format, s.snapshot_url,
             l.first_seen_date, l.days_active_observed,
             DATE_DIFF(CURRENT_DATE(), l.go_live_date, DAY) AS live_age_days
      FROM live l
      LEFT JOIN latest_snap s USING (ad_archive_id)
      ORDER BY live_age_days DESC, l.ad_archive_id
      LIMIT @limit
      `,
      { client, limit },
      { client: 'STRING', limit: 'INT64' }
    );
    const ads = rows.map((r, i) => ({
      rank: i + 1,
      ad_archive_id: r.ad_archive_id,
      page_id: r.page_id,
      page_name: r.page_name,
      display_format: r.display_format,
      snapshot_url: r.snapshot_url,
      first_seen_date: r.first_seen_date,
      days_active_observed: r.days_active_observed,
      live_age_days: r.live_age_days,
    }));
    return json(200, { ads });
  } catch (err) {
    if (isTableNotFound(err)) return json(200, body.probe ? { exists: false } : { ads: [] });
    console.error('Leaderboard query error:', err);
    return json(500, { error: err.message });
  }
}

/* net-new — brand-new competitor ads this period (US-004 marts).
 * Reads the per-ad competitor_net_new_ads view (filtered to the is_net_new flag) plus
 * the per-competitor competitor_net_new_by_page rollup, both absent-safe (0, never
 * null) for competitors with no new ads this period.
 *   { action:'net-new', client:'mosh' }            -> { ads:[...], byPage:[...], window:{...} }
 *   { action:'net-new', client:'mosh', probe:true } -> { exists: true|false }
 */
async function queryNetNew(body, credentials, cors) {
  const cx = martContext(body, credentials, cors, 'net-new');
  if (cx.badRequest) return cx.badRequest;
  const { json, runQuery } = cx;
  const ADS = `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.competitor_net_new_ads\``;
  const BY_PAGE = `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.competitor_net_new_by_page\``;
  try {
    if (body.probe) {
      const [rows] = await runQuery(
        `SELECT EXISTS(SELECT 1 FROM ${ADS} WHERE f10_client = @client) AS has_data`
      );
      return json(200, { exists: !!(rows[0] && rows[0].has_data) });
    }
    // The brand-new ads this period (per-ad view, filtered to the net-new flag).
    const [adRows] = await runQuery(`
      SELECT ad_archive_id, page_id, page_name, first_seen_date, last_seen_date,
             window_start_date, window_end_date
      FROM ${ADS}
      WHERE f10_client = @client AND is_net_new
      ORDER BY page_name, first_seen_date DESC, ad_archive_id
    `);
    // Per-competitor net-new counts (absent-safe rollup: 0, never null).
    const [pageRows] = await runQuery(`
      SELECT page_id, page_name, ads_total, net_new_count,
             window_start_date, window_end_date
      FROM ${BY_PAGE}
      WHERE f10_client = @client
      ORDER BY net_new_count DESC, page_name
    `);
    const windowRow = pageRows[0] || adRows[0] || null;
    return json(200, {
      ads: adRows,
      byPage: pageRows,
      window: windowRow
        ? { start: windowRow.window_start_date, end: windowRow.window_end_date }
        : null,
    });
  } catch (err) {
    if (isTableNotFound(err)) return json(200, body.probe ? { exists: false } : { ads: [], byPage: [] });
    console.error('Net-new query error:', err);
    return json(500, { error: err.message });
  }
}

/* competitor-intel: the consolidated competitor-intelligence surface (US-008).
 * Assembles, per competitor, the behaviour-over-time read the single consolidated
 * dashboard tab renders, from the deterministic marts + the precomputed narrative:
 *   competitor_narrative            (US-007 Gemini narrative + whitespace read)
 *   competitor_behaviour_archetype  (US-006 discrete archetype label + rationale)
 *   competitor_behaviour_movement   (US-005 volume / turnover / diversity movements)
 *   competitor_effort_allocation    (US-005 what they are betting on, as movements)
 *   competitor_theme_movement       (US-006 emerged / faded / intensified / abandoned)
 * plus the go-live staying-power winners (ad_registry + ad_snapshots, aged from
 * meta_start_time fallback first_seen_date: go-live, never the observation window).
 *
 * Numbers come only from the marts; the narrative model names and explains but never
 * invents a number (its provenance is enforced upstream in US-007). Each sub-read is
 * wrapped so a not-yet-materialized mart yields [] instead of a 500. The US-005/006/007
 * marts land later (US-011), so today this returns only what exists. A { probe:true }
 * call reports whether the client has any consolidated intelligence rows yet.
 *   { action:'competitor-intel', client:'mosh' }             -> { competitors:[...], winners:[...] }
 *   { action:'competitor-intel', client:'mosh', probe:true }  -> { exists: true|false }
 */
async function queryCompetitorIntel(body, credentials, cors) {
  const cx = martContext(body, credentials, cors, 'competitor-intel');
  if (cx.badRequest) return cx.badRequest;
  const { json, client, runQuery } = cx;
  const T = (name) => `\`${ADLIB_PROJECT}.${ADLIB_DATASET}.${name}\``;

  // Run a client-scoped read, but treat a not-yet-materialized mart as empty so the
  // consolidated action degrades gracefully mart-by-mart (hq-never-swallow-errors:
  // only a genuine table-not-found is swallowed; every other error propagates).
  const safeRows = async (queryText, params, types) => {
    try {
      const [rows] = await runQuery(queryText, params, types);
      return rows;
    } catch (err) {
      if (isTableNotFound(err)) return [];
      throw err;
    }
  };

  try {
    if (body.probe) {
      // The tab exists when the client has EITHER a behaviour movement mart row OR a
      // precomputed narrative row. Both reads are absent-safe, so a client whose
      // marts have not been built yet cleanly reports exists:false (tab hidden).
      const [behav, narr] = await Promise.all([
        safeRows(`SELECT 1 FROM ${T('competitor_behaviour_movement')} WHERE f10_client = @client LIMIT 1`),
        safeRows(`SELECT 1 FROM ${T('competitor_narrative')} WHERE f10_client = @client LIMIT 1`),
      ]);
      return json(200, { exists: behav.length > 0 || narr.length > 0 });
    }

    const [narrRows, archRows, behavRows, effortRows, themeRows, winnerRows] = await Promise.all([
      // Latest narrative per competitor (prose withheld / null on a non-ok row upstream).
      safeRows(`
        SELECT page_id, page_name, run_date, dominant_bet, notable_movements,
               staying_power, whitespace_read, went_dark, confidence, coverage_caveat,
               numbers_flagged, narrative_model, status
        FROM ${T('competitor_narrative')}
        WHERE f10_client = @client
        QUALIFY ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY run_date DESC) = 1
      `),
      // Latest archetype per competitor (discrete label + defensible rationale).
      safeRows(`
        SELECT page_id, page_name, as_of_month, archetype, archetype_rationale,
               creative_volume, format_diversity, angle_diversity, turnover_rate,
               new_ads_rate, avg_age_live_days, median_age_live_days
        FROM ${T('competitor_behaviour_archetype')}
        WHERE f10_client = @client
        QUALIFY ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY as_of_month DESC) = 1
      `),
      // Latest behaviour-movement row per competitor (each metric a movement).
      safeRows(`
        SELECT page_id, page_name, period_month, is_first_period,
               creative_volume, creative_volume_delta, creative_volume_trend,
               new_ads, new_ads_rate, new_ads_rate_delta, new_ads_rate_trend,
               turnover_rate, turnover_rate_delta, turnover_rate_trend,
               format_diversity, format_diversity_delta, format_diversity_trend,
               angle_diversity, angle_diversity_delta, angle_diversity_trend,
               avg_age_live_days, avg_age_live_days_delta, avg_age_live_days_trend,
               median_age_live_days, median_age_live_days_delta
        FROM ${T('competitor_behaviour_movement')}
        WHERE f10_client = @client
        QUALIFY ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY period_month DESC) = 1
      `),
      // Effort allocation for each competitor's latest period (all dimension buckets).
      safeRows(`
        WITH latest AS (
          SELECT page_id, MAX(period_month) AS period_month
          FROM ${T('competitor_effort_allocation')}
          WHERE f10_client = @client
          GROUP BY page_id
        )
        SELECT e.page_id, e.page_name, e.period_month, e.dimension, e.dimension_value,
               e.dimension_is_multilabel, e.live_ads, e.share, e.prior_share,
               e.delta_share, e.trend
        FROM ${T('competitor_effort_allocation')} e
        JOIN latest l ON l.page_id = e.page_id AND l.period_month = e.period_month
        WHERE e.f10_client = @client
        ORDER BY e.page_id, e.dimension, e.share DESC
      `),
      // Theme movements for each competitor's latest run_date (emerged/faded/...).
      safeRows(`
        WITH latest AS (
          SELECT page_id, MAX(run_date) AS run_date
          FROM ${T('competitor_theme_movement')}
          WHERE f10_client = @client
          GROUP BY page_id
        )
        SELECT m.page_id, m.theme_name, m.theme_key, m.run_date, m.movement,
               m.theme_share, m.prior_share, m.delta_share, m.phrase_count,
               m.live_ads_this_period, m.longevity_avg_age_live_days
        FROM ${T('competitor_theme_movement')} m
        JOIN latest l ON l.page_id = m.page_id AND l.run_date = m.run_date
        WHERE m.f10_client = @client
        ORDER BY m.page_id, m.theme_share DESC
      `),
      // Go-live staying-power winners: the longest-running LIVE competitor ads, aged
      // from meta_start_time (fallback first_seen_date) per hard policy: go-live, not
      // the observation window. ad_registry + ad_snapshots exist independently of the
      // US-005/006/007 marts, so this section is populated even before they land.
      safeRows(`
        WITH live AS (
          SELECT ad_archive_id, page_id,
                 COALESCE(meta_start_time, first_seen_date) AS go_live_date
          FROM ${T('ad_registry')}
          WHERE f10_client = @client AND still_active
        ),
        latest_snap AS (
          SELECT * EXCEPT(rn) FROM (
            SELECT ad_archive_id, page_name, display_format, snapshot_url,
                   ROW_NUMBER() OVER (PARTITION BY ad_archive_id ORDER BY run_date DESC) rn
            FROM ${T('ad_snapshots')}
            WHERE f10_client = @client
          )
          WHERE rn = 1
        )
        SELECT l.ad_archive_id, l.page_id, s.page_name, s.display_format, s.snapshot_url,
               DATE_DIFF(CURRENT_DATE(), l.go_live_date, DAY) AS live_age_days
        FROM live l
        LEFT JOIN latest_snap s USING (ad_archive_id)
        ORDER BY live_age_days DESC, l.ad_archive_id
        LIMIT 10
      `),
    ]);

    // Merge everything per competitor page_id. page_name is resolved from whichever
    // mart carries it (narrative / archetype / behaviour / effort all do), so the
    // header always shows a name, never a bare page_id: the page_name drift guard.
    const byPage = {};
    const ensure = (pageId, pageName) => {
      const key = String(pageId);
      if (!byPage[key]) {
        byPage[key] = {
          page_id: pageId, page_name: null,
          narrative: null, archetype: null, behaviour: null,
          effort: [], theme_movements: [],
        };
      }
      if (!byPage[key].page_name && pageName != null && pageName !== '') {
        byPage[key].page_name = pageName;
      }
      return byPage[key];
    };

    for (const r of narrRows) {
      const c = ensure(r.page_id, r.page_name);
      c.narrative = {
        run_date: r.run_date,
        dominant_bet: r.dominant_bet,
        notable_movements: r.notable_movements,
        staying_power: r.staying_power,
        whitespace_read: r.whitespace_read,
        went_dark: r.went_dark,
        confidence: r.confidence,
        coverage_caveat: r.coverage_caveat,
        status: r.status,
      };
    }
    for (const r of archRows) {
      const c = ensure(r.page_id, r.page_name);
      c.archetype = {
        archetype: r.archetype,
        archetype_rationale: r.archetype_rationale,
        as_of_month: r.as_of_month,
      };
    }
    for (const r of behavRows) {
      const c = ensure(r.page_id, r.page_name);
      c.behaviour = r;
    }
    for (const r of effortRows) {
      ensure(r.page_id, r.page_name).effort.push(r);
    }
    for (const r of themeRows) {
      // theme_movement carries no page_name (per the pinned mart contract); it merges
      // onto a page created by one of the name-bearing marts above.
      ensure(r.page_id, null).theme_movements.push(r);
    }

    const competitors = Object.values(byPage).sort((a, b) =>
      String(a.page_name || a.page_id).localeCompare(String(b.page_name || b.page_id)));

    return json(200, { competitors, winners: winnerRows });
  } catch (err) {
    console.error('Competitor-intel query error:', err);
    return json(500, { error: err.message });
  }
}
