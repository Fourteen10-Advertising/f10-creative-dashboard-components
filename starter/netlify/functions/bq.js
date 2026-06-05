const { BigQuery } = require('@google-cloud/bigquery');

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
