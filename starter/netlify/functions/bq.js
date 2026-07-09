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
      SELECT l.ad_id, m.asset_type, m.gcs_uri, m.fetch_status
      FROM \`mcc-poc-477801.all_clients.meta_creative_links\` l
      LEFT JOIN \`mcc-poc-477801.all_clients.creative_manifest\` m
        ON m.asset_id = COALESCE(l.video_id, l.image_hash) AND m.platform = 'meta'
      WHERE l.ad_id IN UNNEST(@adIds)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY l.ad_id ORDER BY l.created_time DESC) = 1`;

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
        const parsed = /^gs:\/\/([^/]+)\/(.+)$/.exec(r.gcs_uri);
        if (!parsed) {
          out[adId] = { type, url: null };
          return;
        }
        try {
          // Force a correct Content-Type on the signed response so <video>/<img>
          // play even if the object was stored as application/octet-stream.
          const ext = (r.gcs_uri.split('.').pop() || '').toLowerCase();
          const contentType =
            ext === 'mp4' ? 'video/mp4' :
            ext === 'mov' ? 'video/quicktime' :
            ext === 'png' ? 'image/png' :
            ext === 'gif' ? 'image/gif' :
            (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : undefined;
          const [url] = await storage
            .bucket(parsed[1])
            .file(parsed[2])
            .getSignedUrl({ version: 'v4', action: 'read', expires, responseType: contentType });
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
