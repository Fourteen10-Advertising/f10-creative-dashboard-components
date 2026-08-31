/**
 * f10-brief-editor.js - F10 Creative Brief Editor (US-004, dual-mode)
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-creative-dashboard-components@TAG/f10-brief-editor.js"></script>
 *
 * WHAT IT IS: the canonical-constrained brief editor for the F10 internal review app.
 * An operator loads an existing brief revision, steers the five editable creative axes
 * and the copy, and saves a NEW revision that the generation engine can be pointed at.
 * Generation itself does NOT run from the app in v1 (vault Vertex SA plus a hard spend
 * cap plus no Cloud Run): the editor only edits and saves; an operator fires generation
 * later from the CLI against the saved revision id.
 *
 * THE CONTRACT (US-003, python pipeline, already merged): a brief revision persists as
 *   - a JSON document in GCS at
 *       gs://f10-creative-assets/brief-revisions/{client}/{revision_id}.json
 *   - a registry row in BigQuery
 *       mcc-poc-477801.creative_pipeline.brief_revisions
 * carrying the canonical axes (visual_style, hook_type, message_angle, cta_type),
 * the copy blocks as free text, and provenance (client, evidence source,
 * winning values, revision id). The axis vocabularies below MIRROR brief.py /
 * brief_revision.schema.json EXACTLY - they are not invented here. A save both validates
 * the axes against the canonical vocabulary and writes the doc + row so a future
 * generation run reproduces the equivalent in-code brief. US-004 retired the dead
 * format axis; the brief_revisions.format column is kept for backward compatibility
 * but format is no longer edited here and no longer drives generation.
 *
 * NEVER NON-CANONICAL (AC3): the editable axes are edited through <select> dropdowns whose
 * options are exactly the canonical enums, so a free-text axis value is not reachable in
 * the UI. The save path validates a second time (defence in depth) and rejects any axis
 * value outside its vocabulary before anything is written.
 *
 * DUAL MODE (one file, two roles):
 *   1. BROWSER - a self-registering, probe-gated dashboard module. On boot it resolves
 *      the client, runs a cheap probe ("does this client have any brief revision to
 *      edit?") through the injectable brief store, and only then injects its own nav
 *      section, nav link and panel. A dashboard whose client has no revisions (or whose
 *      probe errors, e.g. the brief endpoint is not yet hosted) shows NO tab and leaves
 *      zero DOM trace - it fails closed, exactly like f10-components.js. Tab activation
 *      goes through the single generic dispatcher f10ActivateTab() (f10-layout.js), so it
 *      never hard-codes another tab's classes and two panels can never show at once.
 *   2. NODE - the brief persistence core behind an INJECTABLE WRITER SEAM. saveRevision /
 *      loadRevision program against an object-store + registry seam (in tests these are
 *      in-memory fakes; nothing touches Google), and makeAdcWriters() builds the live
 *      writers WITHOUT credentials so they authenticate as the runtime service account
 *      via Application Default Credentials on GCP compute - the same ADC model US-008's
 *      feedback.js uses. exports.handler is a ready POST endpoint (probe / load / save)
 *      for whatever hosts the review app's brief backend.
 *
 * CREDENTIAL FOLLOW-UP (not done here, deliberately): writing a brief revision needs GCS
 * write to the brief-revisions/ prefix plus a brief_revisions insert. The existing
 * read/object-viewer dashboard SA cannot do this, and the feedback-write SA is scoped
 * only to status.json + feedback_audit, so it cannot either. Provisioning a brief-write
 * runtime SA (or widening scope) AND hosting this handler as the review app's brief
 * endpoint are live-provisioning follow-ups. Until they land, the browser probe fails
 * closed and the tab simply does not appear - live client dashboards are unaffected.
 *
 * CONFIG (browser, all optional):
 *   const BRIEF_EDITOR = {
 *     CLIENT: 'moshy',           // override the f10 client slug (else derived from DATASET)
 *     REVISION_ID: 'rev-123',    // auto-load this revision when the tab first opens
 *     ACTOR: 'zac@fourteen10',   // created_by stamped on saved revisions
 *     ENDPOINT: '/api/brief',    // brief backend URL (else window.BRIEF_FUNCTION, else
 *                                // derived from BQ_FUNCTION by swapping /bq -> /brief)
 *   };
 */
'use strict';

/* ======================================================================== *
 * SHARED CORE - environment-agnostic. Defined once; used by both the Node
 * persistence half and the browser UI half below. No DOM, no require here.
 * ======================================================================== */

/* The canonical vocabularies. These MIRROR the python source of truth EXACTLY:
 * brief.CANONICAL_VISUAL_STYLES / CANONICAL_HOOK_TYPES / CANONICAL_MESSAGE_ANGLES /
 * CANONICAL_CTA_TYPES and brief_revision.schema.json enums. A test asserts they stay
 * in lockstep. Do not add or reorder values here without changing the schema; the
 * whole point of the editor is that it cannot emit a non-canonical value.
 *
 * US-004 retired the dead format axis: photo versus illustration is a visual_style
 * concept and every ad is static for now, so format is no longer an editable axis
 * here and has no canonical vocabulary. The brief_revisions.format BigQuery column
 * and the stored field are retained for backward compatibility (see the MERGE SQL
 * and buildDoc/buildRow/fromDoc below), and any stored value is ignored gracefully. */
var F10_BRIEF_CANONICAL = {
  visual_style: [
    'minimal-clean', 'bold-graphic', 'warm-natural', 'aspirational-premium',
    'authentic-raw', 'playful-colorful', 'clinical-professional', 'dark-dramatic',
    'illustrated', 'retro-nostalgic', 'other',
  ],
  hook_type: [
    'question', 'stat', 'pattern-interrupt', 'bold-claim', 'problem-callout',
    'pov', 'testimonial-open', 'demo-open', 'other',
  ],
  message_angle: [
    'problem-solution', 'ease-convenience', 'price-value', 'offer-promo',
    'social-proof', 'authority-clinical', 'empowerment-transformation',
    'reassurance-trust', 'aspiration-lifestyle', 'comparison-alternative',
    'education-howitworks', 'humour-entertainment', 'other',
  ],
  cta_type: [
    'shop-now', 'learn-more', 'sign-up', 'book', 'download', 'subscribe',
    'contact', 'none',
  ],
};

/* The editable axes, in render order, with human-readable labels. The dead format
 * axis (US-004) is intentionally absent, so no Format dropdown is rendered and
 * format does not drive save, load, or generation. */
var F10_BRIEF_AXES = [
  { key: 'visual_style', label: 'Visual style' },
  { key: 'hook_type', label: 'Hook type' },
  { key: 'message_angle', label: 'Message angle' },
  { key: 'cta_type', label: 'CTA type' },
];

var F10_BRIEF_SCHEMA = 'brief_revision';
var F10_BRIEF_PROJECT = 'mcc-poc-477801';
var F10_BRIEF_BUCKET = 'f10-creative-assets';
var F10_BRIEF_REVISIONS_ROOT = 'brief-revisions';
var F10_BRIEF_DATASET = 'creative_pipeline';
var F10_BRIEF_TABLE = F10_BRIEF_PROJECT + '.' + F10_BRIEF_DATASET + '.brief_revisions';

/* Path-segment slug, byte-for-byte the same rule as bundle.py _safe():
 *   re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_") or "asset"
 * so a JS-written object lands at the exact GCS key the python engine reads. */
function f10BriefSafeSeg(value) {
  var s = String(value == null ? '' : value).replace(/[^A-Za-z0-9._-]+/g, '_');
  s = s.replace(/^_+/, '').replace(/_+$/, '');
  return s || 'asset';
}

/* The GCS object key (no gs:// prefix) for a revision, scoped by client. */
function f10BriefObjectName(client, revisionId) {
  return F10_BRIEF_REVISIONS_ROOT + '/' + f10BriefSafeSeg(client) + '/'
    + f10BriefSafeSeg(revisionId) + '.json';
}

/* gs:// URI under brief-revisions/{client}/{revision_id}.json. */
function f10BriefGcsUri(client, revisionId, bucket) {
  return 'gs://' + (bucket || F10_BRIEF_BUCKET) + '/' + f10BriefObjectName(client, revisionId);
}

function f10BriefIsCanonical(axis, value) {
  var vocab = F10_BRIEF_CANONICAL[axis];
  return !!vocab && vocab.indexOf(value) !== -1;
}

/* Deterministic JSON with recursively sorted keys and 2-space indent, matching the
 * python side's json.dumps(doc, indent=2, sort_keys=True) so a re-save is stable and a
 * within-JS round-trip is byte-faithful. */
function f10BriefCanonicalJson(value) {
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { out[k] = sortKeys(v[k]); });
      return out;
    }
    return v;
  }
  return JSON.stringify(sortKeys(value), null, 2);
}

/* Normalise + validate a record into a clean brief revision, or return { error }.
 * Pure and side-effect free. This is the save-time gate that rejects a non-canonical
 * vocab value (AC3) - the same contract as brief.BriefRevision.validate() plus the
 * schema enums. */
function f10BriefValidate(rec) {
  if (!rec || typeof rec !== 'object') return { error: 'Missing brief revision.' };

  var revisionId = rec.revision_id;
  if (typeof revisionId !== 'string' || !revisionId.trim()) {
    return { error: 'brief revision requires a non-empty revision_id' };
  }
  var client = rec.client;
  if (typeof client !== 'string' || !client.trim()) {
    return { error: 'brief revision requires a non-empty client' };
  }

  var axes = {};
  for (var i = 0; i < F10_BRIEF_AXES.length; i++) {
    var axis = F10_BRIEF_AXES[i].key;
    var v = rec[axis];
    if (!f10BriefIsCanonical(axis, v)) {
      return {
        error: 'non-canonical ' + axis + ' ' + JSON.stringify(v)
          + '; allowed: ' + JSON.stringify(F10_BRIEF_CANONICAL[axis]),
      };
    }
    axes[axis] = v;
  }

  // copy_blocks: optional array of { role (non-empty), text (string), slot_index? }.
  var copyBlocks = [];
  if (rec.copy_blocks !== undefined && rec.copy_blocks !== null) {
    if (!Array.isArray(rec.copy_blocks)) return { error: 'copy_blocks must be an array.' };
    for (var j = 0; j < rec.copy_blocks.length; j++) {
      var cb = rec.copy_blocks[j];
      if (!cb || typeof cb !== 'object') return { error: 'each copy block must be an object.' };
      if (typeof cb.role !== 'string' || !cb.role.trim()) return { error: 'each copy block needs a non-empty role.' };
      if (cb.text !== undefined && cb.text !== null && typeof cb.text !== 'string') {
        return { error: 'copy block text must be a string.' };
      }
      var block = { role: cb.role, text: typeof cb.text === 'string' ? cb.text : '' };
      if (cb.slot_index !== undefined && cb.slot_index !== null) {
        if (typeof cb.slot_index !== 'number' || cb.slot_index < 0 || (cb.slot_index | 0) !== cb.slot_index) {
          return { error: 'copy block slot_index must be a non-negative integer.' };
        }
        block.slot_index = cb.slot_index;
      }
      copyBlocks.push(block);
    }
  }

  var record = {
    revision_id: revisionId,
    client: client,
    bundle_id: typeof rec.bundle_id === 'string' ? rec.bundle_id : '',
    visual_style: axes.visual_style,
    hook_type: axes.hook_type,
    message_angle: axes.message_angle,
    cta_type: axes.cta_type,
    // Dead axis (US-004): format is no longer an editable axis, so it is not in the
    // validated axes loop above. Any stored value is preserved verbatim into the
    // backward-compatible field / BigQuery column and ignored gracefully; a new
    // revision simply carries an empty format.
    format: typeof rec.format === 'string' ? rec.format : '',
    copy_blocks: copyBlocks,
    creative_direction: typeof rec.creative_direction === 'string' ? rec.creative_direction : '',
    inspiration_image_uris: Array.isArray(rec.inspiration_image_uris)
      ? rec.inspiration_image_uris.filter(function (u) { return typeof u === 'string' && u; })
      : [],
    evidence_source: typeof rec.evidence_source === 'string' ? rec.evidence_source : '',
    winning_values: (rec.winning_values && typeof rec.winning_values === 'object') ? rec.winning_values : {},
    gcs_uri: typeof rec.gcs_uri === 'string' ? rec.gcs_uri : '',
    created_at: typeof rec.created_at === 'string' ? rec.created_at : '',
    created_by: typeof rec.created_by === 'string' ? rec.created_by : '',
  };
  return { record: record };
}

/* The persisted JSON document (mirrors brief.BriefRevision.to_dict exactly). */
function f10BriefBuildDoc(record) {
  return {
    schema: F10_BRIEF_SCHEMA,
    revision_id: record.revision_id,
    client: record.client,
    bundle_id: record.bundle_id || '',
    visual_style: record.visual_style,
    hook_type: record.hook_type,
    message_angle: record.message_angle,
    cta_type: record.cta_type,
    format: record.format,
    copy_blocks: (record.copy_blocks || []).map(function (cb) {
      var out = { role: cb.role, text: cb.text || '' };
      if (cb.slot_index !== undefined && cb.slot_index !== null) out.slot_index = cb.slot_index;
      return out;
    }),
    creative_direction: record.creative_direction || '',
    inspiration_image_uris: (record.inspiration_image_uris || []).map(String),
    provenance: {
      evidence_source: record.evidence_source || '',
      winning_values: record.winning_values || {},
    },
    gcs_uri: record.gcs_uri || '',
    created_at: record.created_at || '',
    created_by: record.created_by || '',
  };
}

/* The BigQuery brief_revisions registry row (mirrors brief.BriefRevision.registry_row;
 * empty bundle_id / created_by become null, as the MERGE NULLIFs them). */
function f10BriefBuildRow(record) {
  return {
    revision_id: record.revision_id,
    client: record.client,
    bundle_id: record.bundle_id || null,
    visual_style: record.visual_style,
    hook_type: record.hook_type,
    message_angle: record.message_angle,
    cta_type: record.cta_type,
    format: record.format,
    gcs_uri: record.gcs_uri,
    created_at: record.created_at,
    created_by: record.created_by || null,
  };
}

/* Rebuild a record from a persisted document (mirrors BriefRevision.from_dict). */
function f10BriefFromDoc(doc) {
  doc = doc || {};
  var prov = (doc.provenance && typeof doc.provenance === 'object') ? doc.provenance : {};
  return {
    revision_id: doc.revision_id || '',
    client: doc.client || '',
    bundle_id: doc.bundle_id || '',
    visual_style: doc.visual_style || '',
    hook_type: doc.hook_type || '',
    message_angle: doc.message_angle || '',
    cta_type: doc.cta_type || '',
    format: doc.format || '',
    copy_blocks: Array.isArray(doc.copy_blocks) ? doc.copy_blocks.map(function (cb) {
      var out = { role: cb.role, text: cb.text || '' };
      if (cb.slot_index !== undefined && cb.slot_index !== null) out.slot_index = cb.slot_index;
      return out;
    }) : [],
    creative_direction: typeof doc.creative_direction === 'string' ? doc.creative_direction : '',
    inspiration_image_uris: Array.isArray(doc.inspiration_image_uris)
      ? doc.inspiration_image_uris.filter(function (u) { return typeof u === 'string' && u; })
      : [],
    evidence_source: prov.evidence_source || '',
    winning_values: (prov.winning_values && typeof prov.winning_values === 'object') ? prov.winning_values : {},
    gcs_uri: doc.gcs_uri || '',
    created_at: doc.created_at || '',
    created_by: doc.created_by || '',
  };
}

/* ======================================================================== *
 * NODE PERSISTENCE HALF - the injectable writer seam + the live ADC handler.
 * Guarded to CommonJS so requiring this file in a test never touches the DOM,
 * and loading it in a browser never sees `module`.
 * ======================================================================== */

/* Persist a revision behind the injected object-store + registry seams.
 *
 *   record       : the raw brief record (validated here)
 *   objectStore  : { put(gcsUri, data, contentType) => Promise|any }
 *   registry     : { register(row) => Promise|any }
 *   now          : Date (defaults to new Date())
 *   bucket       : GCS bucket (defaults to f10-creative-assets)
 *
 * Validates (rejecting non-canonical axes) BEFORE any write, sets gcs_uri, writes the
 * JSON document, then registers the row. Returns { statusCode, payload }. Never throws
 * for an expected failure. */
async function f10BriefSaveRevision(opts) {
  opts = opts || {};
  var objectStore = opts.objectStore;
  var registry = opts.registry;
  if (!objectStore || typeof objectStore.put !== 'function'
      || !registry || typeof registry.register !== 'function') {
    return { statusCode: 500, payload: { error: 'Brief write backend unavailable.' } };
  }

  var validated = f10BriefValidate(opts.record);
  if (validated.error) return { statusCode: 400, payload: { error: validated.error } };
  var record = validated.record;

  if (!record.created_at) record.created_at = (opts.now || new Date()).toISOString();
  record.gcs_uri = f10BriefGcsUri(record.client, record.revision_id, opts.bucket);

  var doc = f10BriefBuildDoc(record);
  var data = f10BriefCanonicalJson(doc);

  try {
    await objectStore.put(record.gcs_uri, data, 'application/json');
  } catch (err) {
    return { statusCode: 502, payload: { error: 'Failed to write brief revision JSON: ' + err.message } };
  }
  try {
    await registry.register(f10BriefBuildRow(record));
  } catch (err) {
    return { statusCode: 502, payload: { error: 'JSON written but registry insert failed: ' + err.message } };
  }

  return {
    statusCode: 200,
    payload: {
      ok: true,
      revision_id: record.revision_id,
      client: record.client,
      gcs_uri: record.gcs_uri,
      created_at: record.created_at,
    },
  };
}

/* Load a revision by id: resolve gcs_uri from the registry, read the JSON from the
 * object store, rebuild + validate. Mirrors brief.load_brief_revision. */
async function f10BriefLoadRevision(opts) {
  opts = opts || {};
  var objectStore = opts.objectStore;
  var registry = opts.registry;
  var revisionId = opts.revisionId;
  if (!objectStore || typeof objectStore.get !== 'function'
      || !registry || typeof registry.lookup !== 'function') {
    return { statusCode: 500, payload: { error: 'Brief read backend unavailable.' } };
  }
  if (typeof revisionId !== 'string' || !revisionId.trim()) {
    return { statusCode: 400, payload: { error: 'Missing revision_id.' } };
  }

  var row;
  try {
    row = await registry.lookup(revisionId);
  } catch (err) {
    return { statusCode: 502, payload: { error: 'Registry lookup failed: ' + err.message } };
  }
  if (!row) return { statusCode: 404, payload: { error: 'No brief revision registered for id ' + revisionId } };
  var uri = row.gcs_uri;
  if (!uri) return { statusCode: 502, payload: { error: 'Brief revision ' + revisionId + ' has no gcs_uri in the registry.' } };

  var raw;
  try {
    raw = await objectStore.get(uri);
  } catch (err) {
    return { statusCode: 502, payload: { error: 'Failed to read brief revision JSON: ' + err.message } };
  }
  var doc;
  try {
    doc = JSON.parse(typeof raw === 'string' ? raw : (raw && raw.toString ? raw.toString('utf8') : String(raw)));
  } catch (err) {
    return { statusCode: 502, payload: { error: 'Brief revision JSON is not parseable: ' + err.message } };
  }

  var record = f10BriefFromDoc(doc);
  var validated = f10BriefValidate(record);
  if (validated.error) {
    return { statusCode: 502, payload: { error: 'Loaded brief revision is not canonical: ' + validated.error } };
  }
  return { statusCode: 200, payload: { ok: true, revision: doc } };
}

/* Cheap probe: does this client have any registered brief revision to edit? Programs
 * against an optional registry.listByClient(client) seam; when the registry cannot
 * answer, it fails closed (has_data:false) so the tab stays hidden rather than erroring. */
async function f10BriefProbe(opts) {
  opts = opts || {};
  var registry = opts.registry;
  var client = opts.client;
  if (typeof client !== 'string' || !client.trim()) {
    return { statusCode: 400, payload: { has_data: false, error: 'Missing client.' } };
  }
  if (!registry || typeof registry.listByClient !== 'function') {
    return { statusCode: 200, payload: { has_data: false } };
  }
  try {
    var rows = await registry.listByClient(client);
    return { statusCode: 200, payload: { has_data: !!(rows && rows.length) } };
  } catch (err) {
    return { statusCode: 200, payload: { has_data: false } };
  }
}

/* Generic request dispatch used by the live handler. Actions: probe | load | save. */
async function f10BriefProcessRequest(opts) {
  opts = opts || {};
  var body = opts.body || {};
  var seams = { objectStore: opts.objectStore, registry: opts.registry, now: opts.now };
  switch (body.action) {
    case 'probe':
      return f10BriefProbe({ registry: seams.registry, client: body.client });
    case 'load':
      return f10BriefLoadRevision({
        objectStore: seams.objectStore, registry: seams.registry, revisionId: body.revisionId || body.revision_id,
      });
    case 'save':
      return f10BriefSaveRevision({
        objectStore: seams.objectStore, registry: seams.registry, now: seams.now, record: body.revision || body.record,
      });
    default:
      return { statusCode: 400, payload: { error: 'Unknown or missing action (expected probe, load, or save).' } };
  }
}

/* Build the LIVE object-store + registry writers. Lazily requires the Google SDKs so
 * this module can be required in tests without them installed, and constructs the
 * clients WITHOUT credentials so they authenticate as the runtime service account via
 * ADC on GCP compute (the US-008 model). Not exercised by the offline tests.
 *
 * NOTE (follow-up): the runtime SA under which this runs must be provisioned with GCS
 * write to the brief-revisions/ prefix and BigQuery insert on creative_pipeline
 * .brief_revisions. That SA (or scope widening) is a live provisioning step, not done
 * here; see the header. */
function f10BriefMakeWriters() {
  // eslint-disable-next-line global-require
  var Storage = require('@google-cloud/storage').Storage;
  // eslint-disable-next-line global-require
  var BigQuery = require('@google-cloud/bigquery').BigQuery;

  var storage = new Storage({ projectId: F10_BRIEF_PROJECT }); // ADC / runtime SA
  var bigquery = new BigQuery({ projectId: F10_BRIEF_PROJECT, location: 'australia-southeast1' });

  function parseGsUri(gcsUri) {
    var prefix = 'gs://';
    if (String(gcsUri).indexOf(prefix) !== 0) throw new Error(gcsUri + ' is not a gs:// uri');
    var rest = gcsUri.slice(prefix.length);
    var slash = rest.indexOf('/');
    return { bucket: rest.slice(0, slash), object: rest.slice(slash + 1) };
  }

  var objectStore = {
    async put(gcsUri, data, contentType) {
      var loc = parseGsUri(gcsUri);
      await storage.bucket(loc.bucket).file(loc.object).save(data, { contentType: contentType, resumable: false });
      return gcsUri;
    },
    async get(gcsUri) {
      var loc = parseGsUri(gcsUri);
      var res = await storage.bucket(loc.bucket).file(loc.object).download();
      return res[0].toString('utf8');
    },
  };

  var mergeSql = 'MERGE `' + F10_BRIEF_TABLE + '` t '
    + 'USING (SELECT @revision_id AS revision_id) s ON t.revision_id = s.revision_id '
    + 'WHEN MATCHED THEN UPDATE SET client=@client, bundle_id=NULLIF(@bundle_id, \'\'), '
    + 'visual_style=@visual_style, hook_type=@hook_type, message_angle=@message_angle, '
    + 'cta_type=@cta_type, format=@format, gcs_uri=@gcs_uri, created_at=@created_at, '
    + 'created_by=NULLIF(@created_by, \'\') '
    + 'WHEN NOT MATCHED THEN INSERT (revision_id, client, bundle_id, visual_style, '
    + 'hook_type, message_angle, cta_type, format, gcs_uri, created_at, created_by) '
    + 'VALUES (@revision_id, @client, NULLIF(@bundle_id, \'\'), @visual_style, @hook_type, '
    + '@message_angle, @cta_type, @format, @gcs_uri, @created_at, NULLIF(@created_by, \'\'))';

  var registry = {
    async register(row) {
      await bigquery.query({
        query: mergeSql,
        location: 'australia-southeast1',
        params: {
          revision_id: row.revision_id, client: row.client, bundle_id: row.bundle_id || '',
          visual_style: row.visual_style, hook_type: row.hook_type, message_angle: row.message_angle,
          cta_type: row.cta_type, format: row.format, gcs_uri: row.gcs_uri,
          created_at: row.created_at, created_by: row.created_by || '',
        },
      });
    },
    async lookup(revisionId) {
      var res = await bigquery.query({
        query: 'SELECT revision_id, client, bundle_id, visual_style, hook_type, '
          + 'message_angle, cta_type, format, gcs_uri, CAST(created_at AS STRING) AS created_at, '
          + 'created_by FROM `' + F10_BRIEF_TABLE + '` WHERE revision_id=@revision_id LIMIT 1',
        location: 'australia-southeast1',
        params: { revision_id: revisionId },
      });
      var rows = res[0];
      return rows && rows.length ? rows[0] : null;
    },
    async listByClient(client) {
      var res = await bigquery.query({
        query: 'SELECT revision_id FROM `' + F10_BRIEF_TABLE + '` WHERE client=@client LIMIT 1',
        location: 'australia-southeast1',
        params: { client: client },
      });
      return res[0] || [];
    },
  };

  return { objectStore: objectStore, registry: registry };
}

/* Netlify-style POST handler for the review app's brief backend. Actions: probe, load,
 * save. Builds the ADC writers lazily and delegates to the injectable core. */
async function f10BriefHandler(event) {
  var ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
  var origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
  var cors = (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN)
    ? { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, Vary: 'Origin' } : {};
  var json = function (statusCode, payload) {
    return {
      statusCode: statusCode,
      headers: Object.assign({}, cors, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }),
      body: JSON.stringify(payload),
    };
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: Object.assign({}, cors, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }),
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  var body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return json(400, { error: 'Invalid request body.' });
  }

  var writers;
  try {
    writers = f10BriefMakeWriters();
  } catch (err) {
    return json(500, { error: 'Brief backend unavailable: ' + err.message });
  }

  var out = await f10BriefProcessRequest({
    body: body, objectStore: writers.objectStore, registry: writers.registry,
  });
  return json(out.statusCode, out.payload);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // core (env-agnostic)
    CANONICAL: F10_BRIEF_CANONICAL,
    AXES: F10_BRIEF_AXES,
    SCHEMA: F10_BRIEF_SCHEMA,
    TABLE: F10_BRIEF_TABLE,
    BUCKET: F10_BRIEF_BUCKET,
    safeSeg: f10BriefSafeSeg,
    objectName: f10BriefObjectName,
    gcsUri: f10BriefGcsUri,
    isCanonical: f10BriefIsCanonical,
    canonicalJson: f10BriefCanonicalJson,
    validate: f10BriefValidate,
    buildDoc: f10BriefBuildDoc,
    buildRow: f10BriefBuildRow,
    fromDoc: f10BriefFromDoc,
    // persistence (injectable seam)
    saveRevision: f10BriefSaveRevision,
    loadRevision: f10BriefLoadRevision,
    probe: f10BriefProbe,
    processRequest: f10BriefProcessRequest,
    makeWriters: f10BriefMakeWriters,
    handler: f10BriefHandler,
  };
}

/* ======================================================================== *
 * BROWSER UI HALF - the self-registering, probe-gated brief editor panel.
 * Guarded to a real browser so requiring this file in Node never runs it.
 * ======================================================================== */

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (function () {
    var CFG = (typeof BRIEF_EDITOR !== 'undefined' && BRIEF_EDITOR) ? BRIEF_EDITOR : {};

    var beClient = '';        // resolved f10 client slug
    var beNavLink = null;     // the injected nav-link element
    var beBooted = false;     // guard against double boot
    var beLoadedRevision = null; // the currently loaded revision record (provenance carrier)
    var beStore = null;       // injectable brief store (tests override via setStore)
    var beInspiration = [];   // selected inspiration refs: [{gcs_uri, thumb_url, source, label}]
    var beInspTab = 'upload'; // active inspiration picker tab: upload | client | competitor
    var beRefIndex = {};      // gcs_uri -> ref object, populated as thumbs render (toggle lookup)
    var beClientPage = { offset: 0, hasMore: false, loading: false }; // client-library paging cursor
    var beCompState = {};     // page_id -> { offset, hasMore, total, name } for competitor drill-in
    var CLIENT_PAGE_SIZE = 10;    // client library loads 10 ads per page (spend-ranked)
    var COMPETITOR_PAGE_SIZE = 5; // competitors show + page 5 images at a time
    var INSP_MAX_BYTES = 8 * 1024 * 1024; // client-side mirror of the backend 8 MB cap

    /* Compile / review / tweak / submit surface (US-009). Compile resolves the full
     * brief x variant matrix x size set into a NO-SPEND plan (per-variant resolved
     * prompts, copy, inspiration + warnings, sizes, cost estimate) via POST /compile
     * (US-007). The operator edits the resolved prompts + copy inline; those edits are
     * exactly what get submitted. Submit (POST /submit, US-008) starts async generation
     * and returns a job id; /status is polled for progress + asset URIs as they land.
     * When the estimate exceeds the remaining cap, Submit is disabled with a clear
     * message (the server also rejects an over-cap submit 402, so this is defence in
     * depth, not the only guard). */
    var beCompiled = null;        // last /compile response (resolved variants + cost)
    var beCompiledEdits = null;   // operator overrides: { 'p:vi:pi': text, 'c:vi:ci': text }
    var beVariantMatrix = null;   // optional variant config passed through compile + submit
    var beRemainingCap = null;    // optional remaining spend cap (omitted -> backend default)
    var beJobId = null;           // the running generation job id (submit -> status polling)
    var bePollTimer = null;       // status poll timer handle
    var POLL_MS = 2500;           // status poll interval

    function esc(s) {
      if (s == null) return '';
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function clientKey() {
      var raw = CFG.CLIENT
        ? String(CFG.CLIENT)
        : (typeof DATASET !== 'undefined' && DATASET ? String(DATASET).replace(/_(marts|clean)$/, '') : '');
      return raw.replace(/[^a-z0-9_]/gi, '');
    }

    /* The brief backend endpoint: explicit config wins, then window.BRIEF_FUNCTION,
     * then derive from BQ_FUNCTION by swapping the trailing /bq for /brief. */
    function endpoint() {
      if (CFG.ENDPOINT) return String(CFG.ENDPOINT);
      if (typeof window.BRIEF_FUNCTION !== 'undefined' && window.BRIEF_FUNCTION) return String(window.BRIEF_FUNCTION);
      if (typeof BQ_FUNCTION !== 'undefined' && BQ_FUNCTION) return String(BQ_FUNCTION).replace(/\/bq(\/)?$/, '/brief');
      return '/.netlify/functions/brief';
    }

    /* Default store: POSTs { action, ... } to the brief endpoint, mirroring runQuery's
     * fetch convention. Fails closed on a non-ok response. Overridable for tests. */
    function defaultStore() {
      var url = endpoint();
      async function call(action, payload) {
        var res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ action: action }, payload || {})),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }
      // The reference list + upload live on the /bq and /upload endpoints, not /brief.
      async function callAt(targetUrl, payload) {
        var res = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {}),
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }
      return {
        async probe(client) { var r = await call('probe', { client: client }); return !!(r && r.has_data); },
        async load(revisionId) { var r = await call('load', { revisionId: revisionId }); return r && r.revision; },
        async save(record) { return call('save', { revision: record }); },
        async references(params) {
          // params: {source, limit?, offset?, competitor?, per_competitor?}. Returns the
          // full response (references+has_more, or grouped competitors) — callers read
          // the shape they asked for.
          var p = (typeof params === 'string') ? { source: params } : (params || {});
          return callAt(bqEndpoint(), Object.assign({ action: 'list-references', client: beClient }, p));
        },
        async upload(payload) {
          return callAt(uploadEndpoint(), Object.assign({ action: 'upload', client: beClient }, payload || {}));
        },
        // Compile / submit / status (US-009). Compile + submit POST the full brief
        // context to their own routes (no `action` field; the routes are dedicated);
        // status POSTs { jobId } to /status. Client is stamped so the backend scope
        // check matches, exactly like references + upload.
        async compile(payload) {
          return callAt(compileEndpoint(), Object.assign({ client: beClient }, payload || {}));
        },
        async submit(payload) {
          return callAt(submitEndpoint(), Object.assign({ client: beClient }, payload || {}));
        },
        async status(payload) {
          var p = payload || {};
          return callAt(statusEndpoint(), { client: beClient, jobId: p.jobId || p.job_id || '' });
        },
      };
    }

    /* The reads endpoint (/bq) and the upload endpoint (/upload), derived off the same
     * BACKEND as the brief endpoint. Live requests to BACKEND get their bearer token from
     * the review app's fetch shim (index.html), so the picker never handles a token. */
    function bqEndpoint() {
      if (typeof BQ_FUNCTION !== 'undefined' && BQ_FUNCTION) return String(BQ_FUNCTION);
      return endpoint().replace(/\/brief(\/)?$/, '/bq');
    }
    function uploadEndpoint() {
      if (typeof window.UPLOAD_FUNCTION !== 'undefined' && window.UPLOAD_FUNCTION) return String(window.UPLOAD_FUNCTION);
      return bqEndpoint().replace(/\/bq(\/)?$/, '/upload');
    }
    /* The compile / submit / status endpoints (US-007/US-008), each derived off the
     * same BACKEND as the brief endpoint by swapping the trailing /brief. Explicit
     * window overrides win, mirroring the BQ_FUNCTION / UPLOAD_FUNCTION convention. */
    function compileEndpoint() {
      if (typeof window.COMPILE_FUNCTION !== 'undefined' && window.COMPILE_FUNCTION) return String(window.COMPILE_FUNCTION);
      return endpoint().replace(/\/brief(\/)?$/, '/compile');
    }
    function submitEndpoint() {
      if (typeof window.SUBMIT_FUNCTION !== 'undefined' && window.SUBMIT_FUNCTION) return String(window.SUBMIT_FUNCTION);
      return endpoint().replace(/\/brief(\/)?$/, '/submit');
    }
    function statusEndpoint() {
      if (typeof window.STATUS_FUNCTION !== 'undefined' && window.STATUS_FUNCTION) return String(window.STATUS_FUNCTION);
      return endpoint().replace(/\/brief(\/)?$/, '/status');
    }

    function store() {
      var s = beStore || defaultStore();
      // The picker + compile/submit calls are optional on an injected store; back any
      // that are missing with the default network store so a test store that only stubs
      // probe/load/save still works. A test that exercises compile/submit stubs those.
      if (!s.references || !s.upload || !s.compile || !s.submit || !s.status) {
        var net = defaultStore();
        if (!s.references) s.references = net.references;
        if (!s.upload) s.upload = net.upload;
        if (!s.compile) s.compile = net.compile;
        if (!s.submit) s.submit = net.submit;
        if (!s.status) s.status = net.status;
      }
      return s;
    }

    /* ---- markup ---- */

    function axisSelectHtml(axis) {
      var options = F10_BRIEF_CANONICAL[axis.key].map(function (v) {
        return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
      }).join('');
      return '<label class="be-field"><span class="be-label">' + esc(axis.label) + '</span>'
        + '<select class="be-axis" id="be-axis-' + esc(axis.key) + '" data-axis="' + esc(axis.key) + '">'
        + options + '</select></label>';
    }

    function panelMarkup() {
      var axisFields = F10_BRIEF_AXES.map(axisSelectHtml).join('');
      return '<div class="tab-panel brief-editor-tab-panel" id="panel-brief-editor">'
        + '<style id="be-styles">'
        + '#panel-brief-editor .be-insight{background:rgba(0,0,0,0.03);border-left:3px solid var(--brand,#7a1f2b);'
        + 'padding:10px 14px;margin:0 0 18px;font-size:13px;line-height:1.5;border-radius:4px;}'
        + '#panel-brief-editor .be-load{display:flex;gap:8px;align-items:flex-end;margin:0 0 18px;flex-wrap:wrap;}'
        + '#panel-brief-editor .be-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 18px;}'
        + '#panel-brief-editor .be-field{display:flex;flex-direction:column;gap:4px;font-size:13px;}'
        + '#panel-brief-editor .be-label{font-weight:600;}'
        + '#panel-brief-editor select,#panel-brief-editor input,#panel-brief-editor textarea{'
        + 'font:inherit;padding:7px 9px;border:1px solid rgba(0,0,0,0.2);border-radius:5px;background:#fff;}'
        + '#panel-brief-editor textarea{min-height:60px;resize:vertical;}'
        + '#panel-brief-editor .be-copy .be-field{margin-bottom:12px;}'
        + '#panel-brief-editor .be-btn{background:var(--brand,#7a1f2b);color:#fff;border:0;border-radius:5px;'
        + 'padding:9px 16px;font-weight:600;cursor:pointer;}'
        + '#panel-brief-editor .be-btn[disabled]{opacity:0.5;cursor:default;}'
        + '#panel-brief-editor .be-btn-secondary{background:#eee;color:#333;}'
        + '#panel-brief-editor .be-status{margin-top:16px;font-size:13px;}'
        + '#panel-brief-editor .be-ok{background:#e3f4e8;border:1px solid #b7e0c4;color:#1c6b34;padding:12px 14px;border-radius:6px;}'
        + '#panel-brief-editor .be-err{background:#fbe6ea;border:1px solid #e3a9b6;color:#a3243c;padding:12px 14px;border-radius:6px;}'
        + '#panel-brief-editor .be-revid{font-family:monospace;font-weight:700;word-break:break-all;}'
        + '#panel-brief-editor .be-next{margin-top:6px;color:#555;}'
        + '#panel-brief-editor .be-cli{font-family:monospace;background:rgba(0,0,0,0.05);padding:2px 5px;border-radius:3px;word-break:break-all;}'
        + '#panel-brief-editor .be-insp{margin:0 0 16px;}'
        + '#panel-brief-editor .be-muted{color:#888;font-size:12px;}'
        + '#panel-brief-editor .be-chips{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 12px;min-height:8px;}'
        + '#panel-brief-editor .be-chip{position:relative;width:144px;height:144px;border-radius:8px;overflow:hidden;'
        + 'border:1px solid rgba(0,0,0,0.15);background:#f4f4f4;display:inline-flex;align-items:center;justify-content:center;}'
        + '#panel-brief-editor .be-chip img{width:100%;height:100%;object-fit:cover;display:block;}'
        + '#panel-brief-editor .be-noimg{font-size:9px;color:#777;text-align:center;padding:2px;text-transform:uppercase;}'
        + '#panel-brief-editor .be-chip-x{position:absolute;top:2px;right:3px;width:20px;height:20px;line-height:19px;'
        + 'text-align:center;border-radius:50%;background:rgba(0,0,0,0.65);color:#fff;font-size:14px;cursor:pointer;}'
        + '#panel-brief-editor .be-insp-tabs{display:flex;gap:6px;margin:4px 0 10px;}'
        + '#panel-brief-editor .be-insp-tabs button{font:inherit;font-size:12px;padding:6px 12px;border:1px solid rgba(0,0,0,0.2);'
        + 'background:#fff;border-radius:16px;cursor:pointer;color:#444;}'
        + '#panel-brief-editor .be-insp-tabs button.active{background:var(--brand,#7a1f2b);color:#fff;border-color:transparent;}'
        + '#panel-brief-editor .be-drop{border:2px dashed rgba(0,0,0,0.22);border-radius:8px;padding:22px 14px;text-align:center;'
        + 'color:#666;font-size:13px;background:rgba(0,0,0,0.015);}'
        + '#panel-brief-editor .be-drop.be-dragover{border-color:var(--brand,#7a1f2b);background:rgba(122,31,43,0.06);color:#333;}'
        + '#panel-brief-editor .be-link{color:var(--brand,#7a1f2b);text-decoration:underline;cursor:pointer;font-weight:600;}'
        + '#panel-brief-editor .be-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:12px;margin-top:10px;}'
        + '#panel-brief-editor .be-thumb{position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;cursor:pointer;'
        + 'border:3px solid transparent;background:#f4f4f4;}'
        + '#panel-brief-editor .be-thumb img{width:100%;height:100%;object-fit:cover;display:block;}'
        + '#panel-brief-editor .be-thumb.selected{border-color:var(--brand,#7a1f2b);}'
        + '#panel-brief-editor .be-thumb .be-tick{position:absolute;top:5px;right:6px;width:22px;height:22px;line-height:21px;'
        + 'text-align:center;border-radius:50%;background:var(--brand,#7a1f2b);color:#fff;font-size:13px;display:none;}'
        + '#panel-brief-editor .be-thumb.selected .be-tick{display:block;}'
        + '#panel-brief-editor .be-thumb .be-cap{position:absolute;left:0;right:0;bottom:0;font-size:10px;line-height:1.2;padding:3px 4px;'
        + 'background:rgba(0,0,0,0.55);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
        // competitor groups
        + '#panel-brief-editor .be-comp-group{margin:0 0 18px;}'
        + '#panel-brief-editor .be-comp-head{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;}'
        + '#panel-brief-editor .be-comp-name{font-weight:700;font-size:14px;}'
        + '#panel-brief-editor .be-comp-tier{font-size:11px;color:#fff;background:var(--brand,#7a1f2b);border-radius:10px;padding:1px 8px;}'
        + '#panel-brief-editor .be-comp-meta{font-size:11px;color:#888;}'
        + '#panel-brief-editor .be-comp-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:12px;}'
        + '#panel-brief-editor .be-more{margin-top:10px;font:inherit;font-size:12px;padding:7px 14px;border:1px solid rgba(0,0,0,0.2);'
        + 'background:#fff;border-radius:6px;cursor:pointer;color:#444;}'
        + '#panel-brief-editor .be-more[disabled]{opacity:0.5;cursor:default;}'
        // compile / review / submit surface (US-009)
        + '#panel-brief-editor .be-compile-bar{margin:18px 0 8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;}'
        + '#panel-brief-editor .be-compiled{margin:0;}'
        + '#panel-brief-editor .be-compile-head{margin:8px 0 12px;font-size:14px;}'
        + '#panel-brief-editor .be-compile-warn{background:#fff6e5;border:1px solid #f0d8a8;color:#8a5a00;'
        + 'padding:10px 12px;border-radius:6px;margin:0 0 12px;font-size:13px;line-height:1.5;}'
        + '#panel-brief-editor .be-compile-meta{display:flex;flex-wrap:wrap;gap:18px;font-size:13px;margin:0 0 14px;}'
        + '#panel-brief-editor .be-cost{font-variant-numeric:tabular-nums;}'
        + '#panel-brief-editor .be-variant{border:1px solid rgba(0,0,0,0.12);border-radius:8px;padding:14px;'
        + 'margin:0 0 14px;background:rgba(0,0,0,0.015);}'
        + '#panel-brief-editor .be-variant-head{margin:0 0 10px;}'
        + '#panel-brief-editor .be-variant-id{font-family:monospace;font-size:11px;margin-left:6px;color:#777;}'
        + '#panel-brief-editor .be-compile-insps{margin-top:8px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;}'
        + '#panel-brief-editor .be-compile-insp{width:104px;border:1px solid rgba(0,0,0,0.15);border-radius:6px;padding:5px;'
        + 'background:#f4f4f4;font-size:9px;color:#666;word-break:break-all;}'
        + '#panel-brief-editor .be-compile-insp img{width:100%;height:74px;object-fit:cover;border-radius:4px;display:block;margin-bottom:3px;}'
        + '#panel-brief-editor .be-insp-warn{display:block;color:#a3243c;margin-top:3px;line-height:1.3;}'
        + '#panel-brief-editor .be-submit-bar{margin:14px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;}'
        + '#panel-brief-editor .be-submit-note{font-size:12px;color:#555;}'
        + '#panel-brief-editor .be-submit-note.be-over{color:#a3243c;font-weight:600;}'
        + '#panel-brief-editor .be-progress{margin:10px 0;font-size:13px;}'
        + '#panel-brief-editor .be-prog-head{margin:0 0 8px;}'
        + '#panel-brief-editor .be-results{display:flex;flex-direction:column;gap:6px;margin-top:8px;}'
        + '#panel-brief-editor .be-result a{color:var(--brand,#7a1f2b);word-break:break-all;text-decoration:none;}'
        + '#panel-brief-editor .be-result a:hover{text-decoration:underline;}'
        // landed composites as viewable image thumbnails (signed https preview urls)
        + '#panel-brief-editor .be-result-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:8px;}'
        + '#panel-brief-editor .be-result-thumb{position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;display:block;'
        + 'border:3px solid transparent;background:#f4f4f4;}'
        + '#panel-brief-editor .be-result-thumb img{width:100%;height:100%;object-fit:cover;display:block;}'
        + '#panel-brief-editor .be-result-thumb .be-cap{position:absolute;left:0;right:0;bottom:0;font-size:10px;line-height:1.2;'
        + 'padding:3px 4px;background:rgba(0,0,0,0.55);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
        + '</style>'
        + '<div class="be-insight"><strong>Brief editor:</strong> steer generation before it spends. '
        + 'Load a saved brief revision, adjust the five creative axes (dropdowns are locked to the canonical '
        + 'vocabulary, so nothing off-vocabulary can be saved) and the copy, then save a NEW revision. '
        + 'Generation does not run from here in v1: after saving, an operator runs it from the CLI against '
        + 'the new revision id.</div>'
        + '<div class="be-load">'
        + '<label class="be-field" style="flex:1;min-width:220px;"><span class="be-label">Revision id to load</span>'
        + '<input type="text" id="be-load-id" placeholder="existing revision id" /></label>'
        + '<button type="button" class="be-btn be-btn-secondary" id="be-load-btn">Load revision</button>'
        + '</div>'
        + '<form id="be-form" autocomplete="off">'
        + '<div class="be-grid">' + axisFields + '</div>'
        + '<div class="be-copy" id="be-copy"></div>'
        + '<label class="be-field" style="margin-bottom:14px;"><span class="be-label">Creative direction '
        + '<span style="font-weight:400;color:#666;">(optional — steers the picture, never the copy)</span></span>'
        + '<textarea id="be-direction" placeholder="e.g. the people shown have a higher BMI / are plus-size, warm and authentic — or — minimal, one person talking to a doctor"></textarea></label>'
        + '<div class="be-insp" id="be-insp">'
        + '<span class="be-label">Inspiration references '
        + '<span style="font-weight:400;color:#666;">(optional — real images the model looks at for style/subject)</span></span>'
        + '<div class="be-chips" id="be-insp-chips"></div>'
        + '<div class="be-insp-tabs" id="be-insp-tabs">'
        + '<button type="button" data-insp-tab="upload" class="active">Upload</button>'
        + '<button type="button" data-insp-tab="client">Your library</button>'
        + '<button type="button" data-insp-tab="competitor">Competitors</button>'
        + '</div>'
        + '<div class="be-insp-body" id="be-insp-upload">'
        + '<div class="be-drop" id="be-drop">Drag an image here, or '
        + '<label class="be-link">browse<input type="file" id="be-file" accept="image/png,image/jpeg,image/webp" multiple style="display:none;" /></label>'
        + '<div class="be-muted" style="margin-top:6px;">PNG, JPG or WebP · up to 8&nbsp;MB each</div></div>'
        + '</div>'
        + '<div class="be-insp-body" id="be-insp-client" style="display:none;">'
        + '<div class="be-muted" id="be-client-status">Loading your top-spend ads…</div>'
        + '<div class="be-thumbs" id="be-thumbs"></div>'
        + '<button type="button" class="be-more" id="be-client-more" style="display:none;">Load more</button>'
        + '</div>'
        + '<div class="be-insp-body" id="be-insp-competitor" style="display:none;">'
        + '<div class="be-muted" id="be-comp-status">Loading competitors…</div>'
        + '<div id="be-comp-groups"></div>'
        + '</div>'
        + '</div>'
        + '<button type="submit" class="be-btn" id="be-save-btn" disabled>Save as new revision</button>'
        + '</form>'
        + '<div class="be-compile-bar">'
        + '<button type="button" class="be-btn" id="be-compile-btn">Compile brief</button>'
        + '<span class="be-muted">Resolve the exact prompts, copy and cost with no spend before generating.</span>'
        + '</div>'
        + '<div class="be-compiled" id="be-compiled"></div>'
        + '<div class="be-submit-bar" id="be-submit-bar" style="display:none;">'
        + '<button type="button" class="be-btn" id="be-submit-btn">Submit and generate</button>'
        + '<span class="be-submit-note" id="be-submit-note"></span>'
        + '</div>'
        + '<div class="be-progress" id="be-progress"></div>'
        + '<div class="be-status" id="be-status"></div>'
        + '</div>';
    }

    function navLinkHtml() {
      return '<a href="#" class="brief-editor-nav-link" data-brief-editor-tab="brief-editor">Brief Editor</a>';
    }

    /* ---- copy fields ---- */

    function copyFieldHtml(role, text, idx) {
      return '<label class="be-field"><span class="be-label">Copy: ' + esc(role) + '</span>'
        + '<textarea class="be-copy-text" data-role="' + esc(role) + '" data-idx="' + esc(idx) + '">'
        + esc(text) + '</textarea></label>';
    }

    function renderCopy(copyBlocks) {
      var wrap = document.getElementById('be-copy');
      if (!wrap) return;
      var blocks = (copyBlocks && copyBlocks.length) ? copyBlocks
        : [{ role: 'headline', text: '' }, { role: 'body', text: '' }];
      wrap.innerHTML = blocks.map(function (cb, i) {
        return copyFieldHtml(cb.role, cb.text || '', i);
      }).join('');
    }

    function readCopy() {
      var out = [];
      var nodes = document.querySelectorAll ? document.querySelectorAll('#be-copy .be-copy-text') : [];
      Array.prototype.forEach.call(nodes, function (n) {
        var role = (n.getAttribute && n.getAttribute('data-role')) || '';
        if (!role) return;
        out.push({ role: role, text: n.value != null ? n.value : '' });
      });
      return out;
    }

    /* ---- inspiration picker (upload + client/competitor libraries) ---- */

    function inspHas(uri) {
      for (var i = 0; i < beInspiration.length; i++) if (beInspiration[i].gcs_uri === uri) return true;
      return false;
    }

    function selectRef(ref) {
      if (!ref || !ref.gcs_uri || inspHas(ref.gcs_uri)) return;
      beInspiration.push({
        gcs_uri: ref.gcs_uri,
        thumb_url: ref.thumb_url || '',
        source: ref.source || '',
        label: ref.label || '',
      });
      renderInspChips();
      markThumbs();
    }

    function deselectRef(uri) {
      beInspiration = beInspiration.filter(function (r) { return r.gcs_uri !== uri; });
      renderInspChips();
      markThumbs();
    }

    function indexRefs(refs) {
      (refs || []).forEach(function (r) { if (r && r.gcs_uri) beRefIndex[r.gcs_uri] = r; });
    }

    function toggleThumb(uri) {
      if (inspHas(uri)) { deselectRef(uri); return; }
      if (beRefIndex[uri]) selectRef(beRefIndex[uri]);
    }

    function renderInspChips() {
      var wrap = document.getElementById('be-insp-chips');
      if (!wrap) return;
      if (!beInspiration.length) {
        wrap.innerHTML = '<span class="be-muted">No references selected yet.</span>';
        return;
      }
      wrap.innerHTML = beInspiration.map(function (r) {
        var body = r.thumb_url
          ? '<img src="' + esc(r.thumb_url) + '" alt="" />'
          : '<span class="be-noimg">' + esc(r.source || 'ref') + '</span>';
        return '<span class="be-chip" title="' + esc(r.gcs_uri) + '">' + body
          + '<span class="be-chip-x" data-uri="' + esc(r.gcs_uri) + '" title="Remove">&times;</span></span>';
      }).join('');
    }

    /* One thumb's HTML. Bigger previews (see .be-thumb CSS); caption optional. */
    function thumbHtml(r) {
      var sel = inspHas(r.gcs_uri) ? ' selected' : '';
      var img = r.thumb_url ? '<img src="' + esc(r.thumb_url) + '" alt="" loading="lazy" />' : '';
      var cap = r.label ? '<span class="be-cap">' + esc(r.label) + '</span>' : '';
      return '<div class="be-thumb' + sel + '" data-uri="' + esc(r.gcs_uri) + '">'
        + img + '<span class="be-tick">&#10003;</span>' + cap + '</div>';
    }

    /* Re-apply the selected outline across EVERY rendered thumb (client grid +
     * every competitor row), so a chip removal reflects wherever the image shows. */
    function markThumbs() {
      var panel = document.getElementById('panel-brief-editor');
      if (!panel || !panel.querySelectorAll) return;
      var nodes = panel.querySelectorAll('.be-thumb');
      Array.prototype.forEach.call(nodes, function (n) {
        var uri = n.getAttribute && n.getAttribute('data-uri');
        if (!n.classList) return;
        if (uri && inspHas(uri)) n.classList.add('selected'); else n.classList.remove('selected');
      });
    }

    function setClientStatus(msg) {
      var el = document.getElementById('be-client-status');
      if (el) el.textContent = msg || '';
    }
    function setCompStatus(msg) {
      var el = document.getElementById('be-comp-status');
      if (el) el.textContent = msg || '';
    }

    /* ---- client library: spend-ranked, paginated 10 at a time ---- */
    async function loadClient(reset) {
      if (beClientPage.loading) return;
      if (reset) {
        beClientPage = { offset: 0, hasMore: false, loading: true };
        var grid0 = document.getElementById('be-thumbs');
        if (grid0) grid0.innerHTML = '';
      } else {
        beClientPage.loading = true;
      }
      var more = document.getElementById('be-client-more');
      if (more && more.style) more.style.display = 'none';
      setClientStatus(beClientPage.offset ? 'Loading more…' : 'Loading your top-spend ads…');
      try {
        var resp = await store().references({
          source: 'client', limit: CLIENT_PAGE_SIZE, offset: beClientPage.offset,
        });
        var refs = (resp && resp.references) || [];
        indexRefs(refs);
        var grid = document.getElementById('be-thumbs');
        if (grid && grid.insertAdjacentHTML) {
          grid.insertAdjacentHTML('beforeend', refs.map(thumbHtml).join(''));
        }
        beClientPage.offset += refs.length;
        beClientPage.hasMore = !!(resp && resp.has_more);
        if (!beClientPage.offset) {
          setClientStatus('No creatives found in this client’s library yet.');
        } else {
          setClientStatus(beClientPage.offset + ' ad' + (beClientPage.offset === 1 ? '' : 's')
            + ' (highest spend first) — click to select.');
        }
        if (more && more.style) more.style.display = beClientPage.hasMore ? '' : 'none';
      } catch (err) {
        setClientStatus('Could not load your library: ' + (err && err.message ? err.message : err));
      } finally {
        beClientPage.loading = false;
      }
    }

    /* ---- competitor library: grouped per competitor, ranked, paginated ---- */
    function compGroupHtml(g) {
      var meta = (g.total || 0) + ' ad' + (g.total === 1 ? '' : 's');
      var tier = g.tier ? '<span class="be-comp-tier">' + esc(g.tier) + '</span>' : '';
      var thumbs = (g.images || []).map(thumbHtml).join('');
      var shown = (g.images || []).length;
      var moreBtn = (g.total > shown)
        ? '<button type="button" class="be-more" data-comp-more="' + esc(g.page_id) + '">More from ' + esc(g.name) + '</button>'
        : '';
      return '<div class="be-comp-group" data-comp="' + esc(g.page_id) + '">'
        + '<div class="be-comp-head"><span class="be-comp-name">' + esc(g.name) + '</span>'
        + tier + '<span class="be-comp-meta">' + esc(meta) + '</span></div>'
        + '<div class="be-comp-row" data-comp-row="' + esc(g.page_id) + '">' + thumbs + '</div>'
        + moreBtn + '</div>';
    }

    async function loadCompetitors() {
      if (Object.keys(beCompState).length) return; // already loaded this session
      setCompStatus('Loading competitors…');
      var wrap = document.getElementById('be-comp-groups');
      try {
        var resp = await store().references({ source: 'competitor', per_competitor: COMPETITOR_PAGE_SIZE });
        var groups = (resp && resp.competitors) || [];
        if (!groups.length) {
          setCompStatus('No competitor images available for this client yet.');
          if (wrap) wrap.innerHTML = '';
          return;
        }
        groups.forEach(function (g) {
          indexRefs(g.images);
          beCompState[String(g.page_id)] = {
            offset: (g.images || []).length, hasMore: (g.total || 0) > (g.images || []).length,
            total: g.total || 0, name: g.name,
          };
        });
        if (wrap) wrap.innerHTML = groups.map(compGroupHtml).join('');
        setCompStatus(groups.length + ' competitor' + (groups.length === 1 ? '' : 's')
          + ' — ranked by how established they are. Click any image to select.');
      } catch (err) {
        setCompStatus('Could not load competitors: ' + (err && err.message ? err.message : err));
      }
    }

    async function loadCompetitorMore(pageId) {
      var st = beCompState[String(pageId)];
      if (!st || st.loading || !st.hasMore) return;
      st.loading = true;
      try {
        var resp = await store().references({
          source: 'competitor', competitor: String(pageId),
          limit: COMPETITOR_PAGE_SIZE, offset: st.offset,
        });
        var refs = (resp && resp.references) || [];
        indexRefs(refs);
        var row = null;
        var groups = document.getElementById('be-comp-groups');
        if (groups && groups.querySelector) row = groups.querySelector('[data-comp-row="' + pageId + '"]');
        if (row && row.insertAdjacentHTML) row.insertAdjacentHTML('beforeend', refs.map(thumbHtml).join(''));
        st.offset += refs.length;
        st.hasMore = !!(resp && resp.has_more);
        if (!st.hasMore && groups && groups.querySelector) {
          var btn = groups.querySelector('[data-comp-more="' + pageId + '"]');
          if (btn && btn.parentNode && btn.parentNode.removeChild) btn.parentNode.removeChild(btn);
        }
      } catch (err) {
        // leave the row as-is; a transient failure just means no more appended
      } finally {
        st.loading = false;
      }
    }

    function showInspBody(tab) {
      var bodies = { upload: 'be-insp-upload', client: 'be-insp-client', competitor: 'be-insp-competitor' };
      Object.keys(bodies).forEach(function (k) {
        var el = document.getElementById(bodies[k]);
        if (el && el.style) el.style.display = (k === tab) ? '' : 'none';
      });
      var tabsWrap = document.getElementById('be-insp-tabs');
      if (tabsWrap && tabsWrap.querySelectorAll) {
        var btns = tabsWrap.querySelectorAll('button');
        Array.prototype.forEach.call(btns, function (b) {
          var t = b.getAttribute && b.getAttribute('data-insp-tab');
          if (!b.classList) return;
          if (t === tab) b.classList.add('active'); else b.classList.remove('active');
        });
      }
    }

    function switchInspTab(tab) {
      beInspTab = tab;
      showInspBody(tab);
      // Lazy-load once per session; re-selecting a tab just re-shows what's there.
      if (tab === 'client') return beClientPage.offset === 0 ? loadClient(true) : Promise.resolve();
      if (tab === 'competitor') return loadCompetitors();
      return Promise.resolve();
    }

    /* Read one File to a data: URL, upload it, and select the stored reference. Only real
     * png/jpeg/webp under the cap are sent; the backend content-addresses + dedupes. */
    function handleFile(file) {
      if (!file) return Promise.resolve();
      var okType = /^image\/(png|jpe?g|webp)$/i.test(file.type || '');
      if (!okType) { setUploadNote('Only PNG, JPG or WebP images are supported.'); return Promise.resolve(); }
      if (file.size && file.size > INSP_MAX_BYTES) { setUploadNote(file.name + ' is larger than 8 MB.'); return Promise.resolve(); }
      if (typeof FileReader === 'undefined') return Promise.resolve();
      return new Promise(function (resolve) {
        var reader = new FileReader();
        reader.onload = async function () {
          setUploadNote('Uploading ' + file.name + '…');
          try {
            var result = await store().upload({
              contentType: file.type, filename: file.name, data: String(reader.result || ''),
            });
            if (!result || !result.gcs_uri) throw new Error((result && result.error) || 'upload failed');
            selectRef({ gcs_uri: result.gcs_uri, thumb_url: result.thumb_url, source: 'upload', label: file.name });
            setUploadNote('Added ' + file.name + '.');
          } catch (err) {
            setUploadNote('Upload failed: ' + (err && err.message ? err.message : err));
          }
          resolve();
        };
        reader.onerror = function () { setUploadNote('Could not read ' + file.name + '.'); resolve(); };
        reader.readAsDataURL(file);
      });
    }

    function setUploadNote(msg) {
      var drop = document.getElementById('be-drop');
      if (!drop) return;
      var note = drop.querySelector ? drop.querySelector('.be-upload-note') : null;
      if (!note && drop.insertAdjacentHTML) {
        drop.insertAdjacentHTML('beforeend', '<div class="be-muted be-upload-note" style="margin-top:6px;"></div>');
        note = drop.querySelector ? drop.querySelector('.be-upload-note') : null;
      }
      if (note) note.textContent = msg || '';
    }

    function handleFiles(list) {
      if (!list) return;
      Array.prototype.forEach.call(list, function (f) { handleFile(f); });
    }

    /* Seed the picker from a loaded revision's uris (no thumbs — they were saved as
     * bare gs:// uris). Called on load so a re-save carries them through unchanged. */
    function seedInspiration(uris) {
      beInspiration = (Array.isArray(uris) ? uris : [])
        .filter(function (u) { return typeof u === 'string' && u; })
        .map(function (u) { return { gcs_uri: u, thumb_url: '', source: 'saved', label: '' }; });
      renderInspChips();
      markThumbs();
    }

    /* ---- form population + reading ---- */

    function setAxis(axis, value) {
      var sel = document.getElementById('be-axis-' + axis);
      if (sel && f10BriefIsCanonical(axis, value)) sel.value = value;
    }

    function populateForm(record) {
      F10_BRIEF_AXES.forEach(function (a) { setAxis(a.key, record[a.key]); });
      renderCopy(record.copy_blocks);
      var dir = document.getElementById('be-direction');
      if (dir) dir.value = record.creative_direction || '';
      seedInspiration(record.inspiration_image_uris);
      var save = document.getElementById('be-save-btn');
      if (save) save.disabled = false;
    }

    /* Read the current form into a new revision record. The axis values come only from
     * the canonical <select>s, so they are canonical by construction; provenance is
     * carried from the loaded revision so a non-edited scoreboard axis is preserved. */
    function readForm() {
      var loaded = beLoadedRevision || {};
      var rec = {
        revision_id: newRevisionId(loaded.client || beClient),
        client: loaded.client || beClient,
        bundle_id: loaded.bundle_id || '',
        copy_blocks: readCopy(),
        evidence_source: loaded.evidence_source || '',
        winning_values: loaded.winning_values || {},
        created_by: CFG.ACTOR ? String(CFG.ACTOR) : (loaded.created_by || ''),
      };
      var dirEl = document.getElementById('be-direction');
      rec.creative_direction = dirEl ? (dirEl.value || '') : (loaded.creative_direction || '');
      // Inspiration references come from the picker's selection (uploads + library +
      // whatever was seeded from the loaded revision), de-duplicated to bare gs:// uris.
      rec.inspiration_image_uris = beInspiration.map(function (r) { return r.gcs_uri; });
      // Dead axis (US-004): format is not an editable dropdown, so it is not read from
      // the form. A loaded revision's stored format rides along unchanged into the new
      // revision for backward compatibility; it never drives generation.
      rec.format = typeof loaded.format === 'string' ? loaded.format : '';
      F10_BRIEF_AXES.forEach(function (a) {
        var sel = document.getElementById('be-axis-' + a.key);
        rec[a.key] = sel ? sel.value : loaded[a.key];
      });
      return rec;
    }

    /* A fresh, client-scoped revision id. A save always writes a NEW revision (the editor
     * never overwrites the loaded one), so id collisions are avoided by timestamp + rand. */
    function newRevisionId(client) {
      var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
      var rand = Math.random().toString(36).slice(2, 8);
      return 'rev_' + f10BriefSafeSeg(client || 'brief') + '_' + stamp + '_' + rand;
    }

    /* ---- status rendering ---- */

    function renderSaved(result) {
      var el = document.getElementById('be-status');
      if (!el) return;
      var id = (result && result.revision_id) || '';
      // The generation command, run by an operator from the f10-creative-pipeline
      // repo root. Mirrors the pipeline README's canonical run form: PYTHONPATH=src
      // so the package imports, python3 (not python), the vault SAs via hq secrets
      // exec, --from-revision (NOT --revision, which is not a real flag), and
      // --brand-dir so the render is on-brand. --run --confirm actually spends;
      // drop them for a dry-run cost estimate first.
      var cli = 'PYTHONPATH=src hq secrets exec --company fourteen10 '
        + '--only VERTEX_SA_JSON,GCS_SA_JSON,BIGQUERY_SA_JSON -- '
        + 'python3 -m f10_creative_pipeline.generate '
        + '--from-revision ' + id + ' --brand-dir <client brand kit> --run --confirm';
      el.innerHTML = '<div class="be-ok"><strong>Saved.</strong> New revision id: '
        + '<span class="be-revid" id="be-saved-id">' + esc(id) + '</span>'
        + '<div class="be-next">Next step: an operator runs generation from the CLI against this revision, '
        + 'from the f10-creative-pipeline repo root (generation does not run from this app). '
        + 'Fill in --brand-dir with the client brand kit path:<br><span class="be-cli">' + esc(cli) + '</span></div></div>';
    }

    function renderStatusError(msg) {
      var el = document.getElementById('be-status');
      if (el) el.innerHTML = '<div class="be-err">' + esc(msg || 'Something went wrong.') + '</div>';
    }

    /* ---- load + save actions ---- */

    async function loadRevisionById(revisionId) {
      if (!revisionId) { renderStatusError('Enter a revision id to load.'); return; }
      var el = document.getElementById('be-status');
      if (el) el.innerHTML = 'Loading revision ' + esc(revisionId) + '...';
      try {
        var doc = await store().load(revisionId);
        if (!doc) { renderStatusError('No brief revision found for id ' + revisionId + '.'); return; }
        beLoadedRevision = f10BriefFromDoc(doc);
        populateForm(beLoadedRevision);
        if (el) el.innerHTML = '';
      } catch (err) {
        renderStatusError('Failed to load revision: ' + (err && err.message ? err.message : err));
      }
    }

    async function saveNewRevision() {
      var record = readForm();
      // Defence in depth: the dropdowns are canonical, but validate before any write.
      var validated = f10BriefValidate(record);
      if (validated.error) { renderStatusError(validated.error); return; }
      var save = document.getElementById('be-save-btn');
      if (save) save.disabled = true;
      try {
        var result = await store().save(record);
        if (result && result.ok === false) throw new Error(result.error || 'save rejected');
        renderSaved(result || { revision_id: record.revision_id });
        // Adopt the just-saved record as the loaded revision so a later Compile or
        // Submit (even one that resolves without an inline brief) still reflects it,
        // and readForm carries the saved provenance + id forward. Prefer the
        // backend's echoed revision doc; fall back to the validated record as a doc.
        var savedDoc = (result && result.revision) ? result.revision : f10BriefBuildDoc(validated.record);
        beLoadedRevision = f10BriefFromDoc(savedDoc);
      } catch (err) {
        renderStatusError('Failed to save revision: ' + (err && err.message ? err.message : err));
      } finally {
        if (save) save.disabled = false;
      }
    }

    /* ---- compile / review / tweak / submit (US-009) ---- */

    function fmtUsd(v) {
      var n = Number(v);
      if (!isFinite(n)) n = 0;
      return n.toFixed(2);
    }

    /* "1080x1080, 1080x1350, 1080x1920" from an array of [w, h] pairs. */
    function sizesLabel(sizes) {
      return (Array.isArray(sizes) ? sizes : []).map(function (s) {
        return Array.isArray(s) ? (s[0] + 'x' + s[1]) : String(s);
      }).join(', ');
    }

    /* The last path segment of a gs:// uri, for a compact inspiration label. */
    function shortUri(uri) {
      var s = String(uri || '');
      var slash = s.lastIndexOf('/');
      return slash >= 0 ? s.slice(slash + 1) : s;
    }

    /* A thumb_url for an inspiration uri if the picker already has one (operator picked
     * it or it was indexed from a library), else '' so compile falls back to a label. */
    function inspThumbFor(uri) {
      for (var i = 0; i < beInspiration.length; i++) {
        if (beInspiration[i].gcs_uri === uri && beInspiration[i].thumb_url) return beInspiration[i].thumb_url;
      }
      return (beRefIndex[uri] && beRefIndex[uri].thumb_url) ? beRefIndex[uri].thumb_url : '';
    }

    /* The shared compile/submit request seed: same inputs for both, so the backend
     * re-resolves identical briefs on submit and overlays the operator's edits by
     * brief_id. Revision id comes from a loaded revision (or the load-id field). */
    function buildCompileRequest() {
      var loaded = beLoadedRevision || {};
      var dirEl = document.getElementById('be-direction');
      // The LIVE on-screen brief is the primary driver. readForm() assembles the
      // full current record (the axes, the copy VERBATIM, the creative direction and
      // the inspiration references) in the exact revision-doc shape a saved revision
      // has, so Compile and Submit resolve exactly what the operator sees, with no
      // Save/Load step. client + creativeDirection stay for backward compatibility;
      // a revisionId is still sent when a revision is loaded or entered, but the
      // inline brief wins if both reach the backend.
      var req = {
        client: loaded.client || beClient,
        creativeDirection: dirEl ? (dirEl.value || '') : (loaded.creative_direction || ''),
        baseInspirationImageUris: beInspiration.map(function (r) { return r.gcs_uri; }),
        variantMatrix: beVariantMatrix || {},
        brief: readForm(),
      };
      if (beRemainingCap != null) req.remainingCapUsd = beRemainingCap;
      var loadId = document.getElementById('be-load-id');
      var rid = loaded.revision_id || (loadId ? loadId.value : '') || '';
      if (rid) req.revisionId = rid;
      return req;
    }

    /* Record an operator edit to a resolved prompt or copy block. Keyed by variant +
     * index so readCompiledBrief() overlays it onto the compiled brief at submit time.
     * This is exactly what the delegated textarea `input` handler calls, so a DOM edit
     * and a test edit take the identical path. */
    function applyCompiledEdit(kind, variantIdx, idx, text) {
      if (!beCompiledEdits) beCompiledEdits = {};
      var prefix = (kind === 'prompt') ? 'p' : 'c';
      beCompiledEdits[prefix + ':' + (variantIdx | 0) + ':' + (idx | 0)] = String(text == null ? '' : text);
    }

    /* The approved compiled brief to submit: the compiled variants with every operator
     * edit overlaid, plus the size set. brief_id is carried so the backend matches each
     * approved variant to its re-resolved brief (US-008 _apply_approved_edits). */
    function readCompiledBrief() {
      if (!beCompiled || !Array.isArray(beCompiled.variants)) return null;
      var edits = beCompiledEdits || {};
      var variants = beCompiled.variants.map(function (v, vi) {
        var prompts = (v.prompts || []).map(function (p, pi) {
          var k = 'p:' + vi + ':' + pi;
          return { component_role: p.component_role, prompt: (k in edits) ? edits[k] : (p.prompt || '') };
        });
        var copy = (v.copy || []).map(function (cb, ci) {
          var k = 'c:' + vi + ':' + ci;
          var out = { role: cb.role, text: (k in edits) ? edits[k] : (cb.text || '') };
          if (cb.slot_index !== undefined && cb.slot_index !== null) out.slot_index = cb.slot_index;
          return out;
        });
        var out = { prompts: prompts, copy: copy };
        if (v.brief_id) out.brief_id = v.brief_id;
        return out;
      });
      return { variants: variants, sizes: beCompiled.sizes || [] };
    }

    /* One inspiration cell: a real thumbnail when we have one, else the reference
     * label, with any US-004 validation warning beneath it. */
    function compileInspHtml(im) {
      im = im || {};
      var thumb = inspThumbFor(im.uri);
      var body = thumb
        ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" />'
        : '<span>' + esc(shortUri(im.uri)) + '</span>';
      var warn = im.warning ? '<span class="be-insp-warn">' + esc(im.warning) + '</span>' : '';
      return '<div class="be-compile-insp" title="' + esc(im.uri || '') + '">' + body + warn + '</div>';
    }

    /* One variant card: its resolved prompt(s) and copy as EDITABLE textareas (data
     * attributes let the delegated input handler map an edit back to the model), plus
     * the inspiration cells. */
    function variantCardHtml(v, vi) {
      v = v || {};
      var prompts = (v.prompts || []).map(function (p, pi) {
        return '<label class="be-field"><span class="be-label">Prompt: '
          + esc(p.component_role || ('image ' + (pi + 1))) + '</span>'
          + '<textarea class="be-compile-prompt" data-be-edit="prompt" data-vi="' + vi + '" data-idx="' + pi + '">'
          + esc(p.prompt || '') + '</textarea></label>';
      }).join('');
      var copy = (v.copy || []).map(function (cb, ci) {
        return '<label class="be-field"><span class="be-label">Copy: '
          + esc(cb.role || ('block ' + (ci + 1))) + '</span>'
          + '<textarea class="be-compile-copy" data-be-edit="copy" data-vi="' + vi + '" data-idx="' + ci + '">'
          + esc(cb.text || '') + '</textarea></label>';
      }).join('');
      var insps = (v.inspiration_images || []).map(compileInspHtml).join('');
      var inspWrap = insps
        ? '<div class="be-compile-insps"><span class="be-label">Inspiration</span>' + insps + '</div>' : '';
      var idLine = v.brief_id ? '<span class="be-variant-id">' + esc(v.brief_id) + '</span>' : '';
      return '<div class="be-variant" data-vi="' + vi + '">'
        + '<div class="be-variant-head"><strong>Variant ' + (vi + 1) + '</strong>' + idLine + '</div>'
        + prompts + copy + inspWrap + '</div>';
    }

    /* The full inline compiled-brief view: header, any top-level warnings, the size set
     * and cost estimate, then one editable card per variant. */
    function compiledHtml(resp) {
      resp = resp || {};
      var ce = resp.cost_estimate || {};
      var variants = Array.isArray(resp.variants) ? resp.variants : [];
      var warn = (Array.isArray(resp.warnings) && resp.warnings.length)
        ? '<div class="be-compile-warn">' + resp.warnings.map(esc).join('<br />') + '</div>' : '';
      var meta = '<div class="be-compile-meta">'
        + '<div><span class="be-label">Sizes</span> ' + esc(sizesLabel(resp.sizes)) + '</div>'
        + '<div class="be-cost"><span class="be-label">Cost estimate</span> '
        + 'Files: ' + (ce.files_produced || 0)
        + ' | Generations: ' + (ce.unique_image_generations || 0)
        + ' | Estimated: $' + fmtUsd(ce.estimated_usd)
        + ' | Remaining cap: $' + fmtUsd(ce.remaining_cap_usd)
        + '</div></div>';
      var head = '<div class="be-compile-head"><strong>Compiled brief</strong> '
        + '<span class="be-muted">' + variants.length + ' variant' + (variants.length === 1 ? '' : 's')
        + ', no spend yet. Edit any prompt or copy below; your edits are what generate.</span></div>';
      return head + warn + meta + '<div class="be-variants">' + variants.map(variantCardHtml).join('') + '</div>';
    }

    function overCapMessage(ce) {
      ce = ce || {};
      return 'Estimated $' + fmtUsd(ce.estimated_usd) + ' exceeds the remaining cap $'
        + fmtUsd(ce.remaining_cap_usd) + '. Reduce the size set or the variant matrix to submit.';
    }
    function readyMessage(ce) {
      ce = ce || {};
      return 'Ready to generate ' + (ce.files_produced || 0) + ' file'
        + ((ce.files_produced === 1) ? '' : 's') + ' for about $' + fmtUsd(ce.estimated_usd)
        + ' (remaining cap $' + fmtUsd(ce.remaining_cap_usd) + ').';
    }
    function setSubmitNote(msg, over) {
      var el = document.getElementById('be-submit-note');
      if (!el) return;
      el.textContent = msg || '';
      if (el.classList) { if (over) el.classList.add('be-over'); else el.classList.remove('be-over'); }
    }

    /* Render the compiled brief inline, reveal the submit bar, and gate Submit on the
     * cost estimate: over the remaining cap disables Submit with a clear message. */
    function renderCompiled(resp) {
      var el = document.getElementById('be-compiled');
      if (el) el.innerHTML = compiledHtml(resp);
      var bar = document.getElementById('be-submit-bar');
      if (bar && bar.style) bar.style.display = '';
      var prog = document.getElementById('be-progress');
      if (prog) prog.innerHTML = '';
      var ce = (resp && resp.cost_estimate) || {};
      var over = !!ce.exceeds_cap;
      var btn = document.getElementById('be-submit-btn');
      if (btn) btn.disabled = over;
      setSubmitNote(over ? overCapMessage(ce) : readyMessage(ce), over);
    }

    function renderCompileError(msg) {
      var el = document.getElementById('be-compiled');
      if (el) el.innerHTML = '<div class="be-err">' + esc(msg || 'Compile failed.') + '</div>';
      var bar = document.getElementById('be-submit-bar');
      if (bar && bar.style) bar.style.display = 'none';
    }

    /* Compile the current brief with NO spend and render the result inline. */
    async function compileBrief() {
      stopPolling();
      var el = document.getElementById('be-compiled');
      if (el) el.innerHTML = '<div class="be-muted">Compiling brief (no spend)...</div>';
      var bar = document.getElementById('be-submit-bar');
      if (bar && bar.style) bar.style.display = 'none';
      try {
        var resp = await store().compile(buildCompileRequest());
        if (!resp || resp.ok === false) throw new Error((resp && resp.error) || 'compile failed');
        beCompiled = resp;
        beCompiledEdits = {};
        renderCompiled(resp);
      } catch (err) {
        beCompiled = null;
        renderCompileError('Failed to compile: ' + (err && err.message ? err.message : err));
      }
    }

    /* Render a job's live progress + the results that have landed so far. Accepts both
     * the submit 202 body and a /status job doc (both carry status + counts). */
    function renderProgress(doc) {
      var el = document.getElementById('be-progress');
      if (!el) return;
      doc = doc || {};
      var status = doc.status || 'running';
      var done = doc.bundles_completed || 0;
      var total = doc.bundles_total || 0;
      var spend = doc.spend_usd;
      var assets = Array.isArray(doc.asset_uris) ? doc.asset_uris : [];
      // Signed https preview urls per composite (US viewable-results): a browser
      // cannot open a gs:// uri, so /status signs each landed composite to a
      // short-lived https READ url the editor renders as an <img>.
      var previews = Array.isArray(doc.asset_previews) ? doc.asset_previews : [];
      var previewByUri = {};
      previews.forEach(function (p) { if (p && p.gcs_uri) previewByUri[p.gcs_uri] = p; });
      var anySigned = previews.some(function (p) { return p && p.url; });
      var head = '<div class="be-prog-head"><strong>Generation: ' + esc(status) + '</strong>'
        + ' · ' + done + '/' + (total || done) + ' bundles'
        + (spend != null ? (' · $' + fmtUsd(spend) + ' spent') : '')
        + (doc.error ? (' · ' + esc(doc.error)) : '') + '</div>';
      var results;
      if (!assets.length) {
        results = '<div class="be-muted">No results yet.</div>';
      } else {
        var items = assets.map(function (u) {
          var p = previewByUri[u] || {};
          var cap = p.size ? '<span class="be-cap">' + esc(p.size) + '</span>' : '';
          if (p.url) {
            // Render the signed https preview as an image thumbnail; the
            // click-through opens the full signed url in a new tab.
            return '<a class="be-result-thumb" href="' + esc(p.url) + '" target="_blank" rel="noopener" '
              + 'title="' + esc(u) + '"><img src="' + esc(p.url) + '" alt="" loading="lazy" />' + cap + '</a>';
          }
          // Fall back to the raw gs:// text link when no signed url is available.
          return '<div class="be-result"><a href="' + esc(u) + '" target="_blank" rel="noopener">'
            + esc(u) + '</a></div>';
        }).join('');
        results = '<div class="' + (anySigned ? 'be-results be-result-grid' : 'be-results') + '">'
          + items + '</div>';
      }
      el.innerHTML = head + results;
    }

    function renderProgressError(msg) {
      var el = document.getElementById('be-progress');
      if (el) el.innerHTML = '<div class="be-err">' + esc(msg || 'Generation failed.') + '</div>';
    }

    function stopPolling() {
      if (bePollTimer) { clearTimeout(bePollTimer); bePollTimer = null; }
    }

    /* One status poll: read the job, render its progress, and return the job doc (or
     * null on error, already surfaced). Exposed so tests drive polling without timers. */
    async function pollStatusOnce(jobId) {
      try {
        var resp = await store().status({ jobId: jobId });
        var doc = (resp && resp.job) ? resp.job : resp;
        renderProgress(doc);
        return doc;
      } catch (err) {
        renderProgressError('Could not read job status: ' + (err && err.message ? err.message : err));
        return null;
      }
    }

    /* Poll /status on an interval, dropping in results as they land, until the job
     * reaches a terminal state (completed | failed) or the polling is stopped. */
    function startPolling(jobId) {
      stopPolling();
      var tick = function () {
        pollStatusOnce(jobId).then(function (doc) {
          if (!doc) return; // error already surfaced; stop the loop
          if (doc.status === 'completed' || doc.status === 'failed') { stopPolling(); return; }
          if (typeof setTimeout === 'function') bePollTimer = setTimeout(tick, POLL_MS);
        });
      };
      if (typeof setTimeout === 'function') bePollTimer = setTimeout(tick, POLL_MS);
    }

    /* Submit the approved (edited) compiled brief for generation, then poll status.
     * Over the remaining cap, Submit is disabled and this is a no-op guard (the server
     * would 402 anyway). */
    async function submitCompiled() {
      if (!beCompiled) return;
      var ce = beCompiled.cost_estimate || {};
      if (ce.exceeds_cap) { setSubmitNote(overCapMessage(ce), true); return; }
      var compiledBrief = readCompiledBrief();
      if (!compiledBrief) return;
      var btn = document.getElementById('be-submit-btn');
      if (btn) btn.disabled = true;
      var prog = document.getElementById('be-progress');
      if (prog) prog.innerHTML = '<div class="be-muted">Submitting...</div>';
      try {
        var req = buildCompileRequest();
        req.compiledBrief = compiledBrief;
        var resp = await store().submit(req);
        if (!resp || resp.ok === false) throw new Error((resp && resp.error) || 'submit failed');
        beJobId = resp.job_id || null;
        renderProgress(resp);
        if (beJobId) startPolling(beJobId);
      } catch (err) {
        renderProgressError('Submit failed: ' + (err && err.message ? err.message : err));
        if (btn) btn.disabled = false;
      }
    }

    /* Wire the inspiration picker's events once the panel exists. Delegated clicks so the
     * dynamically rendered chips + thumbs need no per-node listeners. */
    function wireInspiration() {
      renderInspChips();

      var tabs = document.getElementById('be-insp-tabs');
      if (tabs && tabs.addEventListener) {
        tabs.addEventListener('click', function (e) {
          var t = e && e.target;
          var tab = t && t.getAttribute && t.getAttribute('data-insp-tab');
          if (!tab) return;
          if (e.preventDefault) e.preventDefault();
          switchInspTab(tab);
        });
      }

      var chips = document.getElementById('be-insp-chips');
      if (chips && chips.addEventListener) {
        chips.addEventListener('click', function (e) {
          var t = e && e.target;
          var uri = t && t.getAttribute && t.getAttribute('data-uri');
          if (uri) deselectRef(uri);
        });
      }

      // One delegated handler for the whole picker body: thumb select/deselect
      // across the client grid AND every competitor row, plus the "load more" and
      // per-competitor "more" buttons — all rendered dynamically.
      function closestWithAttr(node, attr, stopAt) {
        while (node && node !== stopAt) {
          if (node.getAttribute && node.getAttribute(attr) != null) return node;
          node = node.parentNode;
        }
        return null;
      }
      var insp = document.getElementById('be-insp');
      if (insp && insp.addEventListener) {
        insp.addEventListener('click', function (e) {
          var t = e && e.target;
          if (!t) return;
          var moreComp = closestWithAttr(t, 'data-comp-more', insp);
          if (moreComp) { if (e.preventDefault) e.preventDefault(); loadCompetitorMore(moreComp.getAttribute('data-comp-more')); return; }
          if (t.getAttribute && t.getAttribute('id') === 'be-client-more') {
            if (e.preventDefault) e.preventDefault(); loadClient(false); return;
          }
          var thumb = closestWithAttr(t, 'data-uri', insp);
          // Only .be-thumb carries data-uri here that should toggle; the chip-x
          // (also data-uri) is handled by the chips listener above, and its node
          // is inside #be-insp-chips, not a .be-thumb — guard on the class.
          if (thumb && thumb.classList && thumb.classList.contains && thumb.classList.contains('be-thumb')) {
            toggleThumb(thumb.getAttribute('data-uri'));
          }
        });
      }

      var file = document.getElementById('be-file');
      if (file && file.addEventListener) {
        file.addEventListener('change', function (e) {
          var target = (e && e.target) || file;
          handleFiles(target.files);
          if (target) target.value = ''; // allow re-selecting the same file
        });
      }

      var drop = document.getElementById('be-drop');
      if (drop && drop.addEventListener) {
        drop.addEventListener('dragover', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          if (drop.classList) drop.classList.add('be-dragover');
        });
        drop.addEventListener('dragleave', function () { if (drop.classList) drop.classList.remove('be-dragover'); });
        drop.addEventListener('drop', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          if (drop.classList) drop.classList.remove('be-dragover');
          var dt = e && e.dataTransfer;
          if (dt && dt.files) handleFiles(dt.files);
        });
      }
    }

    /* ---- tab activation (single generic dispatcher) ---- */

    function activate() {
      if (typeof f10ActivateTab === 'function') {
        f10ActivateTab({ panelId: 'panel-brief-editor', navLink: beNavLink, title: 'Brief Editor' });
      } else {
        var links = document.querySelectorAll ? document.querySelectorAll('#sidebar nav a') : [];
        Array.prototype.forEach.call(links, function (l) { if (l.classList) l.classList.remove('active'); });
        var panels = document.querySelectorAll ? document.querySelectorAll('.tab-panel') : [];
        Array.prototype.forEach.call(panels, function (p) { if (p.classList) p.classList.remove('active'); });
        var panel = document.getElementById('panel-brief-editor'); if (panel) panel.classList.add('active');
        if (beNavLink && beNavLink.classList) beNavLink.classList.add('active');
        var t = document.getElementById('page-title'); if (t) t.textContent = 'Brief Editor';
      }
      if (window.F10A) F10A.track('tab_viewed', { tab: 'brief-editor', tab_label: 'Brief Editor' });
    }

    function deactivateOnOtherNav() {
      var panels = document.querySelectorAll ? document.querySelectorAll('.brief-editor-tab-panel') : [];
      Array.prototype.forEach.call(panels, function (p) { if (p.classList) p.classList.remove('active'); });
      var links = document.querySelectorAll ? document.querySelectorAll('.brief-editor-nav-link') : [];
      Array.prototype.forEach.call(links, function (l) { if (l.classList) l.classList.remove('active'); });
    }

    /* ---- registration ---- */

    function registerTab() {
      var nav = document.querySelector('#sidebar nav');
      var content = document.getElementById('content');
      if (!nav || !content) return;
      nav.insertAdjacentHTML('beforeend', '<div class="nav-section">Creative Briefs</div>');
      nav.insertAdjacentHTML('beforeend', navLinkHtml());
      content.insertAdjacentHTML('beforeend', panelMarkup());
      beNavLink = document.querySelector('.brief-editor-nav-link');
      if (beNavLink && beNavLink.addEventListener) {
        beNavLink.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); activate(); });
      }
      var loadBtn = document.getElementById('be-load-btn');
      if (loadBtn && loadBtn.addEventListener) {
        loadBtn.addEventListener('click', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          var input = document.getElementById('be-load-id');
          loadRevisionById(input ? input.value : '');
        });
      }
      var form = document.getElementById('be-form');
      if (form && form.addEventListener) {
        form.addEventListener('submit', function (e) { if (e && e.preventDefault) e.preventDefault(); saveNewRevision(); });
      }
      wireInspiration();

      // Compile / review / tweak / submit surface (US-009). The compile + submit
      // buttons are static; the edit handler is delegated on the compiled container so
      // the dynamically rendered prompt/copy textareas need no per-node listeners.
      var compileBtn = document.getElementById('be-compile-btn');
      if (compileBtn && compileBtn.addEventListener) {
        compileBtn.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); compileBrief(); });
      }
      var submitBtn = document.getElementById('be-submit-btn');
      if (submitBtn && submitBtn.addEventListener) {
        submitBtn.addEventListener('click', function (e) { if (e && e.preventDefault) e.preventDefault(); submitCompiled(); });
      }
      var compiledEl = document.getElementById('be-compiled');
      if (compiledEl && compiledEl.addEventListener) {
        compiledEl.addEventListener('input', function (e) {
          var t = e && e.target;
          if (!t || !t.getAttribute) return;
          var kind = t.getAttribute('data-be-edit');
          if (!kind) return;
          applyCompiledEdit(kind, parseInt(t.getAttribute('data-vi'), 10) || 0,
            parseInt(t.getAttribute('data-idx'), 10) || 0, t.value);
        });
      }
      var others = document.querySelectorAll ? document.querySelectorAll('#sidebar nav a') : [];
      Array.prototype.forEach.call(others, function (a) {
        if (a === beNavLink || !a.addEventListener) return;
        a.addEventListener('click', deactivateOnOtherNav);
      });
      // Optional auto-load of a configured revision once the panel exists.
      if (CFG.REVISION_ID) loadRevisionById(String(CFG.REVISION_ID));
    }

    /* ---- boot ----
     * Resolve the client, run the cheap probe through the store, and register the tab only
     * when the client has a brief revision to edit. Any probe error fails closed (no tab,
     * no DOM trace). Does not require an f10-layout.js edit: it self-boots and also exposes
     * window.initBriefEditor for explicit dispatch. */
    async function initBriefEditor() {
      if (beBooted) return;
      beBooted = true;
      beClient = clientKey();
      if (!beClient) return; // no client -> silent no-op
      try {
        var ok = await store().probe(beClient);
        if (ok === true) registerTab();
      } catch (err) {
        // Fail closed: no tab, no empty state.
        if (window.console && console.warn) {
          console.warn('Brief Editor visibility probe error:', err && err.message ? err.message : err);
        }
      }
    }

    window.initBriefEditor = initBriefEditor;

    /* Self-boot without editing f10-layout.js. renderLayout() runs synchronously in a
     * trailing inline script, so by DOMContentLoaded / load the nav + content exist. The
     * beBooted guard makes an explicit initBriefEditor() call idempotent. */
    (function autoBoot() {
      var run = function () { initBriefEditor(); };
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        if (typeof setTimeout === 'function') setTimeout(run, 0);
      } else if (document.addEventListener) {
        document.addEventListener('DOMContentLoaded', function () {
          if (typeof setTimeout === 'function') setTimeout(run, 0); else run();
        });
      }
    })();

    /* Test surface (US-004): expose internals so the acceptance test can drive
     * registration, probe gating, load + save via a fake store, and canonical enforcement
     * without a full dashboard boot. Production paths do not read these. */
    window.f10BriefEditor = {
      initBriefEditor: initBriefEditor,
      registerTab: registerTab,
      activate: activate,
      deactivateOnOtherNav: deactivateOnOtherNav,
      loadRevisionById: loadRevisionById,
      saveNewRevision: saveNewRevision,
      populateForm: populateForm,
      readForm: readForm,
      renderSaved: renderSaved,
      panelMarkup: panelMarkup,
      navLinkHtml: navLinkHtml,
      endpoint: endpoint,
      validate: f10BriefValidate,
      isCanonical: f10BriefIsCanonical,
      CANONICAL: F10_BRIEF_CANONICAL,
      AXES: F10_BRIEF_AXES,
      setStore: function (s) { beStore = s; },
      setClient: function (c) { beClient = c; },
      getClient: function () { return beClient; },
      getLoaded: function () { return beLoadedRevision; },
      isBooted: function () { return beBooted; },
      // inspiration picker surface (US-Phase-1 part 2)
      switchInspTab: switchInspTab,
      loadClient: loadClient,
      loadCompetitors: loadCompetitors,
      loadCompetitorMore: loadCompetitorMore,
      toggleThumb: toggleThumb,
      selectRef: selectRef,
      deselectRef: deselectRef,
      handleFile: handleFile,
      getInspiration: function () { return beInspiration.slice(); },
      getClientPage: function () { return { offset: beClientPage.offset, hasMore: beClientPage.hasMore }; },
      getCompState: function () { return JSON.parse(JSON.stringify(beCompState)); },
      // compile / review / tweak / submit surface (US-009)
      compileBrief: compileBrief,
      submitCompiled: submitCompiled,
      pollStatusOnce: pollStatusOnce,
      applyCompiledEdit: applyCompiledEdit,
      readCompiledBrief: readCompiledBrief,
      buildCompileRequest: buildCompileRequest,
      renderCompiled: renderCompiled,
      compileEndpoint: compileEndpoint,
      submitEndpoint: submitEndpoint,
      statusEndpoint: statusEndpoint,
      getCompiled: function () { return beCompiled; },
      getJobId: function () { return beJobId; },
      setVariantMatrix: function (m) { beVariantMatrix = m; },
      setRemainingCap: function (c) { beRemainingCap = c; },
      stopPolling: stopPolling,
      resetForTest: function () {
        beBooted = false; beLoadedRevision = null;
        beInspiration = []; beRefIndex = {}; beInspTab = 'upload';
        beClientPage = { offset: 0, hasMore: false, loading: false }; beCompState = {};
        stopPolling();
        beCompiled = null; beCompiledEdits = null; beVariantMatrix = null;
        beRemainingCap = null; beJobId = null;
      },
    };
  })();
}
