/**
 * Feedback write path (US-008).
 *
 * The creative framework is read-only today (bq.js does SELECT/EXISTS reads plus
 * short-lived signed GCS reads). This endpoint is the net-new WRITE surface: it
 * records a per-ad F10 decision (approve / decline / pending) so the future
 * bundle service can serve approved-only bundles.
 *
 * A single POST does two writes and nothing else:
 *   1. GCS sidecar: writes/updates status.json in the bundle's own prefix
 *        gs://f10-creative-assets/components/{platform}/{client}/{bundle_id}/status.json
 *      This is the field the (future) bundle service reads to gate serving.
 *   2. BigQuery audit: inserts one immutable row into
 *        mcc-poc-477801.creative_pipeline.feedback_audit
 *      capturing the full record (client, bundle_id, state, comment, actor, when).
 *
 * Auth / credentials (decision 2026-08-20, supersedes the earlier vault-key plan):
 *   The write authenticates as the runtime service account
 *   feedback-write@mcc-poc-477801.iam.gserviceaccount.com via Application Default
 *   Credentials (ADC) on GCP compute. There is NO stored FEEDBACK_WRITE_SA_JSON
 *   secret; this file never reads a service-account JSON. The GCS/BigQuery clients
 *   are constructed WITHOUT credentials so they resolve the runtime SA from ADC.
 *   That SA is scoped in GCP to write only status.json under components/ and to
 *   insert only into feedback_audit; this code matches that scope by construction
 *   (it only ever writes a *.../status.json object and only ever inserts into the
 *   feedback_audit table).
 *
 * Gating (US-DEC access decision): the internal review + feedback surface is
 * F10-gated via hq-deploy company access (fourteen10 members, no password). This
 * endpoint additionally requires a trusted auth context, so it is never
 * anonymously writable even if reached directly, and it enforces per-client scope
 * so a caller scoped to client A cannot write client B's bundle. Everything fails
 * closed: a missing/invalid auth context, an out-of-scope client, or an invalid
 * payload is rejected before any write.
 *
 * The write logic (processFeedback) takes injected GCS + BigQuery writers, so the
 * unit tests exercise it fully offline with fakes and never touch Google auth or
 * live services.
 */
'use strict';

const PROJECT = 'mcc-poc-477801';
const LOCATION = 'australia-southeast1';
const BUCKET = 'f10-creative-assets';
const DATASET = 'creative_pipeline';
const AUDIT_TABLE = 'feedback_audit';

// The only decisions the surface can record. Anything else fails validation.
const VALID_STATES = ['approved', 'declined', 'pending'];

// Path segments (platform / client / bundle_id) are interpolated into the GCS
// object key, so they must be strict slugs: no separators, no traversal, no
// whitespace. This is defence in depth on top of the SA's prefix condition.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const COMMENT_MAX = 2000;

// Header names the hq-deploy company-access gate populates with the authenticated
// F10 actor and their allowed client scope. The gate strips any inbound copies,
// so the endpoint trusts them only because it sits behind that gate. Overridable
// so ops can match whatever the gate emits.
const ACTOR_HEADER = (process.env.FEEDBACK_ACTOR_HEADER || 'x-f10-actor').toLowerCase();
const SCOPE_HEADER = (process.env.FEEDBACK_SCOPE_HEADER || 'x-f10-client-scope').toLowerCase();

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

/* CORS: echo the configured origin only when it matches (mirrors bq.js). The
 * dashboard calls its own function same-origin, so this can stay unset. */
function corsHeaders(event) {
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    return { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, Vary: 'Origin' };
  }
  return {};
}

/* Case-insensitive header read (Netlify lowercases keys, but be defensive). */
function header(event, name) {
  const headers = (event && event.headers) || {};
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return undefined;
}

/* Resolve the caller's trusted auth context from the company-access gate.
 *
 * Returns { actor, clientScope: string[] } when the gate has authenticated the
 * caller and declared an explicit, non-empty client scope; returns null
 * otherwise. Null means "not authenticated / no scope" and the caller fails
 * closed with a 401. There is deliberately no wildcard: the scope is the explicit
 * list of client slugs the actor may write, so per-client isolation is strict. */
function resolveAuthContext(event) {
  const rawScope = header(event, SCOPE_HEADER);
  const rawActor = header(event, ACTOR_HEADER);
  if (typeof rawScope !== 'string') return null;
  const clientScope = rawScope
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!clientScope.length) return null;
  // A wildcard is not honoured: strict per-client scope only.
  if (clientScope.some((c) => c === '*')) return null;
  const actor = typeof rawActor === 'string' && rawActor.trim() ? rawActor.trim() : null;
  return { actor, clientScope };
}

/* Validate + normalise the request body into a clean feedback record, or return
 * an { error } describing the first problem. Pure and side-effect free. */
function validatePayload(body) {
  if (!body || typeof body !== 'object') return { error: 'Missing request body.' };

  const client = body.client;
  const bundle_id = body.bundle_id;
  const platform = body.platform;
  const state = body.state;

  if (typeof client !== 'string' || !SLUG_RE.test(client)) {
    return { error: 'Invalid or missing "client".' };
  }
  if (typeof platform !== 'string' || !SLUG_RE.test(platform)) {
    return { error: 'Invalid or missing "platform".' };
  }
  if (typeof bundle_id !== 'string' || !SLUG_RE.test(bundle_id)) {
    return { error: 'Invalid or missing "bundle_id".' };
  }
  if (typeof state !== 'string' || VALID_STATES.indexOf(state) === -1) {
    return { error: 'Invalid or missing "state" (expected one of ' + VALID_STATES.join(', ') + ').' };
  }

  let comment = null;
  if (body.comment !== undefined && body.comment !== null) {
    if (typeof body.comment !== 'string') return { error: 'Invalid "comment" (must be a string).' };
    if (body.comment.length > COMMENT_MAX) return { error: 'Comment too long (max ' + COMMENT_MAX + ' chars).' };
    comment = body.comment;
  }

  let actor = null;
  if (body.actor !== undefined && body.actor !== null) {
    if (typeof body.actor !== 'string' || !body.actor.trim()) return { error: 'Invalid "actor".' };
    actor = body.actor.trim();
  }

  return { record: { client, platform, bundle_id, state, comment, actor } };
}

/* The GCS object key for a bundle's status sidecar. Always ends in /status.json;
 * this is the only object shape this endpoint ever writes, matching the SA scope. */
function statusObjectPath(platform, client, bundle_id) {
  return 'components/' + platform + '/' + client + '/' + bundle_id + '/status.json';
}

/* The status.json sidecar the bundle service reads. Small, self-describing.
 *
 * The sidecar carries the decision under TWO field names on purpose:
 *   status : the field the bundle service (US-010) gates serving on. It reads
 *            doc.status and serves only when it equals "approved", so this field
 *            is what actually unlocks an approved bundle.
 *   state  : the original review vocabulary (approved | declined | pending),
 *            kept for the feedback_audit row and the review UI, which speak
 *            "state".
 * Both are always the same decision value, so the writer and the reader share
 * one contract and an approved decision writes status: "approved" verbatim. */
function buildStatusJson(record, updatedAt) {
  return {
    client: record.client,
    bundle_id: record.bundle_id,
    platform: record.platform,
    state: record.state,
    status: record.state,
    comment: record.comment,
    actor: record.actor,
    updated_at: updatedAt,
  };
}

/* The immutable audit row (matches the feedback_audit schema: client, bundle_id,
 * state REQUIRED; comment, actor nullable; created_at REQUIRED TIMESTAMP). */
function buildAuditRow(record, createdAt) {
  return {
    client: record.client,
    bundle_id: record.bundle_id,
    state: record.state,
    comment: record.comment,
    actor: record.actor,
    created_at: createdAt,
  };
}

/* Core write, fully injectable so tests run offline.
 *
 *   authContext : { actor, clientScope[] } | null  (from resolveAuthContext)
 *   body        : parsed request payload
 *   gcs         : { save(objectPath, contents, contentType) => Promise }
 *   bq          : { insertAudit(rows) => Promise }
 *   now         : Date (defaults to new Date())
 *
 * Returns { statusCode, payload }. Never throws for expected failures; every
 * expected failure is a fail-closed status code with no write performed.
 */
async function processFeedback({ authContext, body, gcs, bq, now }) {
  // Fail closed: no trusted auth context => not anonymously writable.
  if (!authContext || !Array.isArray(authContext.clientScope) || !authContext.clientScope.length) {
    return { statusCode: 401, payload: { error: 'Unauthenticated: no F10 auth context.' } };
  }

  const { record, error } = validatePayload(body);
  if (error) return { statusCode: 400, payload: { error } };

  // Strict client-scope enforcement: a caller for client A cannot write client B.
  if (authContext.clientScope.indexOf(record.client) === -1) {
    return {
      statusCode: 403,
      payload: { error: 'Forbidden: client "' + record.client + '" is outside the caller scope.' },
    };
  }

  // Prefer the gate-authenticated actor over any self-declared one, but require
  // an actor from one of the two (who made the decision).
  const actor = authContext.actor || record.actor;
  if (!actor) return { statusCode: 400, payload: { error: 'Missing "actor" (who made the decision).' } };
  record.actor = actor;

  const when = (now || new Date()).toISOString();
  const objectPath = statusObjectPath(record.platform, record.client, record.bundle_id);
  const statusJson = buildStatusJson(record, when);
  const auditRow = buildAuditRow(record, when);

  // 1. Write the gating sidecar first (the field the service reads).
  try {
    await gcs.save(objectPath, JSON.stringify(statusJson, null, 2), 'application/json');
  } catch (err) {
    return { statusCode: 502, payload: { error: 'Failed to write status sidecar: ' + err.message } };
  }

  // 2. Stream the immutable audit row.
  try {
    await bq.insertAudit([auditRow]);
  } catch (err) {
    return { statusCode: 502, payload: { error: 'Status written but audit insert failed: ' + err.message } };
  }

  return {
    statusCode: 200,
    payload: {
      ok: true,
      client: record.client,
      bundle_id: record.bundle_id,
      platform: record.platform,
      state: record.state,
      status_path: 'gs://' + BUCKET + '/' + objectPath,
      updated_at: when,
    },
  };
}

/* Build the real ADC-backed writers. Lazily requires the Google packages so the
 * module can be required in tests without them installed, and constructs the
 * clients WITHOUT credentials so they authenticate as the runtime SA via ADC.
 * The writers expose only the two operations the SA is scoped for. */
function makeWriters() {
  // eslint-disable-next-line global-require
  const { Storage } = require('@google-cloud/storage');
  // eslint-disable-next-line global-require
  const { BigQuery } = require('@google-cloud/bigquery');

  const storage = new Storage({ projectId: PROJECT }); // ADC / runtime SA
  const bigquery = new BigQuery({ projectId: PROJECT, location: LOCATION }); // ADC / runtime SA

  return {
    gcs: {
      async save(objectPath, contents, contentType) {
        await storage
          .bucket(BUCKET)
          .file(objectPath)
          .save(contents, { contentType, resumable: false });
      },
    },
    bq: {
      async insertAudit(rows) {
        await bigquery.dataset(DATASET).table(AUDIT_TABLE).insert(rows);
      },
    },
  };
}

exports.handler = async function (event) {
  const cors = corsHeaders(event);
  const json = (statusCode, payload) => ({
    statusCode,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(payload),
  });

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return json(400, { error: 'Invalid request body.' });
  }

  const authContext = resolveAuthContext(event);

  let writers;
  try {
    writers = makeWriters();
  } catch (err) {
    return json(500, { error: 'Write backend unavailable: ' + err.message });
  }

  const { statusCode, payload } = await processFeedback({
    authContext,
    body,
    gcs: writers.gcs,
    bq: writers.bq,
  });
  return json(statusCode, payload);
};

// Exported for the offline unit tests (and any future reuse).
exports.processFeedback = processFeedback;
exports.validatePayload = validatePayload;
exports.resolveAuthContext = resolveAuthContext;
exports.statusObjectPath = statusObjectPath;
exports.buildStatusJson = buildStatusJson;
exports.buildAuditRow = buildAuditRow;
exports.makeWriters = makeWriters;
exports.VALID_STATES = VALID_STATES;
exports.constants = { PROJECT, LOCATION, BUCKET, DATASET, AUDIT_TABLE };
