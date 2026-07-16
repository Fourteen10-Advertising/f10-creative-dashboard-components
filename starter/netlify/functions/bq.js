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

  // ── Competitor Ad Library: this client's tracked competitor ads + creatives ──
  // Queries the shared all_clients_adlib dataset (keyed by f10_client) for the
  // latest snapshot per competitor ad, its longevity from ad_registry, its
  // fetched creatives (served via the same short-lived signed GCS URLs) and —
  // when the table exists — its vision read. Data-driven off body.client; the
  // function itself holds no per-client config, so it serves every dashboard.
  // Pass { action:'competitor', probe:true } for a cheap rows-exist check the
  // UI can use to decide whether to show the tab at all.
  if (body.action === 'competitor') {
    return queryCompetitor(body, credentials, cors);
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
      SELECT l.ad_id, m.asset_type, m.gcs_uri, m.fetch_status
      FROM \`mcc-poc-477801.all_clients.meta_creative_links\` l
      LEFT JOIN \`mcc-poc-477801.all_clients.creative_manifest\` m
        ON m.asset_id = COALESCE(l.video_id, l.image_hash) AND m.platform = 'meta'
      LEFT JOIN asset_pref h ON h.ad_id = l.ad_id
      LEFT JOIN asset_delivery d ON d.ad_id = l.ad_id
      WHERE l.ad_id IN UNNEST(@adIds)
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY l.ad_id
        ORDER BY
          IF(COALESCE(l.video_id, l.image_hash) = d.top_delivered_asset_id, 0, 1),
          IF(COALESCE(l.video_id, l.image_hash) = h.pref_asset_id, 0, 1),
          IF(m.gcs_uri IS NOT NULL, 0, 1),
          l.created_time DESC,
          COALESCE(l.video_id, l.image_hash)
      ) = 1`;

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
    const out = {};

    await Promise.all(
      rows.map(async (r) => {
        const adId = r.ad_id;
        const type = r.asset_type || null;
        if (r.fetch_status !== 'fetched' || !r.gcs_uri) {
          out[adId] = { type, url: null };
          return;
        }
        try {
          const url = await signGcsUri(storage, r.gcs_uri, expires);
          if (!url) {
            out[adId] = { type, url: null };
            return;
          }
          const ext = (r.gcs_uri.split('.').pop() || '').toLowerCase();
          out[adId] = { type: type || (ext === 'mp4' || ext === 'mov' ? 'video' : 'image'), url };
        } catch (e) {
          console.error('Signed URL error for', r.gcs_uri, e.message);
          out[adId] = { type, url: null };
        }
      })
    );

    return json(200, out);
  } catch (err) {
    console.error('Media resolve error:', err);
    return json(500, { error: err.message });
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
 * Query shapes mirror build_competitor_page.py (fetch_ads / fetch_creatives /
 * fetch_vision): latest snapshot per ad + registry longevity, all fetched
 * creatives per ad (signed at request time), and an absent-safe vision read.
 * Same byte-billed / timeout guardrails as every other query here.
 *
 *   { action:'competitor', client:'mosh' }              -> { ads: [...] }
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
    const runQuery = (query) =>
      bq.query({
        query,
        params: { client },
        types: { client: 'STRING' },
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

    // Latest daily snapshot per ad, joined to ad_registry longevity fields.
    const [ads] = await runQuery(`
      WITH latest AS (
        SELECT * EXCEPT(rn) FROM (
          SELECT ad_archive_id, page_name, display_format, cta_type,
                 ad_creative_bodies, link_url, snapshot_url, is_active,
                 ad_delivery_start_time,
                 ROW_NUMBER() OVER (PARTITION BY ad_archive_id ORDER BY run_date DESC) rn
          FROM \`${PROJECT}.${DATASET}.ad_snapshots\`
          WHERE f10_client = @client
        )
        WHERE rn = 1
      )
      SELECT l.*, r.days_active_observed, r.first_seen_date, r.still_active
      FROM latest l
      LEFT JOIN \`${PROJECT}.${DATASET}.ad_registry\` r USING (ad_archive_id)
      ORDER BY l.page_name, l.ad_delivery_start_time ASC, l.ad_archive_id
    `);

    // No competitor rows for this client is a normal empty state, not an error.
    if (!ads.length) return json(200, { ads: [] });

    // All fetched creatives per ad, so carousels keep every frame. Grouped in
    // query order (video first, then idx) before signing so order is preserved.
    const [creativeRows] = await runQuery(`
      SELECT ad_archive_id, media_type, idx, gcs_uri
      FROM \`${PROJECT}.${DATASET}.creative_manifest\`
      WHERE f10_client = @client AND fetch_status = 'fetched'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY ad_archive_id, idx ORDER BY fetched_at DESC) = 1
      ORDER BY ad_archive_id, (media_type = 'video') DESC, idx
    `);

    const creativesByAd = {};
    for (const c of creativeRows) {
      if (!creativesByAd[c.ad_archive_id]) creativesByAd[c.ad_archive_id] = [];
      creativesByAd[c.ad_archive_id].push({
        media_type: c.media_type,
        idx: c.idx,
        _gcsUri: c.gcs_uri,
        url: null,
      });
    }

    // Optional vision read — absent-safe: competitor_vision_attributes may not
    // exist for a client/account yet, so a table-not-found is swallowed and the
    // cards simply render without vision data.
    const visionByAd = {};
    try {
      const [visionRows] = await runQuery(`
        SELECT ad_archive_id, hook, angle, format_read
        FROM \`${PROJECT}.${DATASET}.competitor_vision_attributes\`
        WHERE f10_client = @client
        QUALIFY ROW_NUMBER() OVER (PARTITION BY ad_archive_id ORDER BY run_date DESC) = 1
      `);
      for (const v of visionRows) {
        visionByAd[v.ad_archive_id] = { hook: v.hook, angle: v.angle, format_read: v.format_read };
      }
    } catch (e) {
      const notFound = e && (e.code === 404 || /not found|does not exist/i.test(e.message || ''));
      if (!notFound) throw e;
      console.warn('competitor_vision_attributes unavailable, continuing without vision:', e.message);
    }

    // Sign every fetched creative at request time, mutating in place so the
    // per-ad ordering above survives the parallel signing.
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

    const out = ads.map((a) => ({
      ...a,
      creatives: creativesByAd[a.ad_archive_id] || [],
      vision: visionByAd[a.ad_archive_id] || null,
    }));

    return json(200, { ads: out });
  } catch (err) {
    console.error('Competitor query error:', err);
    return json(500, { error: err.message });
  }
}
