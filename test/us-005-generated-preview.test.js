/**
 * US-005 - Generated-ad preview image resolver (reader side).
 *
 * The dashboard already mints ~15-min V4 signed URLs for DELIVERED ads keyed to
 * Meta/TikTok ad_ids (the `media` action, via BigQuery). GENERATED bundles are in
 * no BigQuery table, so bq.js gains a net-new, bundle-keyed action,
 * `generated-preview`, that signs a short-lived READ url for a bundle's composed
 * preview image (components/{platform}/{client}/{bundle_id}/composite.png in the
 * f10-creative-assets bucket) given only the caller's client scope + a bundle id.
 *
 * What is proven here, fully offline (both @google-cloud modules stubbed, no
 * BigQuery, no GCS, no auth, mirrors test/carousel-preview.test.js):
 *
 *   1. A working signed read url is returned for the right client + bundle, and
 *      the signer is pointed at the exact bundle-keyed composite object.
 *   2. Client scope is enforced: a caller scoped to client A requesting client B's
 *      bundle is refused with { url:null, reason:'client-scope-mismatch' }, and
 *      NEITHER exists() NOR the signer is ever called for the foreign object.
 *   3. A missing composite returns { url:null, reason:'not-found' } (no throw).
 *   4. Missing inputs return { url:null, reason:'missing-client-or-bundle' }.
 *   5. The read path never constructs a BigQuery client (object-viewer SA path).
 *
 * Run: node test/us-005-generated-preview.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BQ_PATH = path.join(ROOT, 'starter/netlify/functions/bq.js');
const BQ_SRC = fs.readFileSync(BQ_PATH, 'utf8');

/* ── Fake BigQuery: must NEVER be constructed by this read path. ── */
function makeFakeBigQuery() {
  const state = { constructed: 0 };
  class FakeBigQuery {
    constructor(opts) {
      state.constructed += 1;
      this.opts = opts;
    }
    async query() {
      throw new Error('generated-preview must not touch BigQuery');
    }
  }
  return { FakeBigQuery, state };
}

/* ── Fake Storage: records exists()/getSignedUrl() calls and lets each test say
 * which object paths exist. Signs to a URL that echoes bucket/object so the test
 * can assert exactly which object was signed. ── */
function makeFakeStorage(existing) {
  const calls = { existed: [], signed: [] };
  const present = new Set(existing || []);
  class FakeStorage {
    constructor(opts) { this.opts = opts; }
    bucket(b) {
      return {
        file(f) {
          return {
            async exists() {
              calls.existed.push(b + '/' + f);
              return [present.has(f)];
            },
            async getSignedUrl(opts) {
              calls.signed.push({ object: b + '/' + f, opts });
              return ['https://signed.example/' + b + '/' + f];
            },
          };
        },
      };
    }
  }
  return { FakeStorage, calls };
}

function loadHandler(FakeBigQuery, FakeStorage) {
  const m = new Module(BQ_PATH, null);
  m.filename = BQ_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(BQ_PATH));
  const realRequire = m.require.bind(m);
  m.require = (id) => {
    if (id === '@google-cloud/bigquery') return { BigQuery: FakeBigQuery };
    if (id === '@google-cloud/storage') return { Storage: FakeStorage };
    return realRequire(id);
  };
  m._compile(BQ_SRC, BQ_PATH);
  return m.exports.handler;
}

function makeEvent(payload) {
  return { httpMethod: 'POST', headers: {}, body: JSON.stringify(payload) };
}

process.env.GOOGLE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'viewer@test', private_key: 'k' });

let passed = 0;
function check(name, fn) {
  const p = fn();
  return Promise.resolve(p).then(() => { passed++; console.log('  ok -', name); });
}

// The pipeline path convention this resolver mirrors, for building expectations.
const A_CLIENT = 'Moshy';
const A_BUNDLE = 'brief_moshy_moshy-hero-left-offer-badge_a1b2c3d4';
const A_OBJECT = 'components/meta/Moshy/' + A_BUNDLE + '/composite.png';
const B_BUNDLE = 'brief_stake_stake-hero-centered_99887766';

(async () => {
  console.log('US-005 generated-ad preview resolver');

  /* 1. Happy path: a working signed read url for the right client + bundle. */
  await check('returns a working signed url for a published bundle composite', async () => {
    const { FakeBigQuery, state } = makeFakeBigQuery();
    const { FakeStorage, calls } = makeFakeStorage([A_OBJECT]);
    const handler = loadHandler(FakeBigQuery, FakeStorage);

    const res = await handler(makeEvent({
      action: 'generated-preview', client: A_CLIENT, bundleId: A_BUNDLE,
    }));
    assert.strictEqual(res.statusCode, 200);
    const out = JSON.parse(res.body);

    assert.strictEqual(out.url, 'https://signed.example/f10-creative-assets/' + A_OBJECT,
      'signs the exact bundle-keyed composite object');
    assert.strictEqual(out.reason, undefined, 'no reason on success');
    assert.strictEqual(out.bundleId, A_BUNDLE);

    // Exactly one existence check + one sign, both for the bundle-keyed object.
    assert.deepStrictEqual(calls.existed, ['f10-creative-assets/' + A_OBJECT]);
    assert.strictEqual(calls.signed.length, 1);
    assert.strictEqual(calls.signed[0].object, 'f10-creative-assets/' + A_OBJECT);
    // A short-lived V4 READ url, matching the delivered-ad signer contract.
    assert.strictEqual(calls.signed[0].opts.version, 'v4');
    assert.strictEqual(calls.signed[0].opts.action, 'read');
    assert.ok(calls.signed[0].opts.expires > Date.now(), 'expiry is in the future (short-lived)');
    assert.ok(calls.signed[0].opts.expires <= Date.now() + 15 * 60 * 1000 + 1000, 'about 15 minutes');

    // The object-viewer SA path only: BigQuery is never constructed.
    assert.strictEqual(state.constructed, 0, 'no BigQuery client for a GCS read');
  });

  /* 2. Client scope: caller A cannot resolve client B's bundle. */
  await check('refuses client B bundle for a caller scoped to client A (no url, no probe)', async () => {
    const { FakeBigQuery } = makeFakeBigQuery();
    // Even if the foreign object "existed", scope must refuse BEFORE any storage.
    const { FakeStorage, calls } = makeFakeStorage(['components/meta/Stake/' + B_BUNDLE + '/composite.png']);
    const handler = loadHandler(FakeBigQuery, FakeStorage);

    const res = await handler(makeEvent({
      action: 'generated-preview', client: A_CLIENT, bundleId: B_BUNDLE,
    }));
    assert.strictEqual(res.statusCode, 200);
    const out = JSON.parse(res.body);

    assert.strictEqual(out.url, null, 'no url leaks for another client');
    assert.strictEqual(out.reason, 'client-scope-mismatch');
    // Category-1: A never even probes B's namespace.
    assert.deepStrictEqual(calls.existed, [], 'no existence probe of the foreign object');
    assert.deepStrictEqual(calls.signed, [], 'nothing signed for the foreign object');
  });

  await check('a client whose slug matches the bundle owner resolves (case/format-insensitive)', async () => {
    // Caller passes "moshy" (lowercase); the bundle owner slug is "moshy" too, so
    // scope passes and the path is built from the caller's client segment.
    const object = 'components/meta/moshy/' + A_BUNDLE + '/composite.png';
    const { FakeBigQuery } = makeFakeBigQuery();
    const { FakeStorage, calls } = makeFakeStorage([object]);
    const handler = loadHandler(FakeBigQuery, FakeStorage);

    const out = JSON.parse((await handler(makeEvent({
      action: 'generated-preview', client: 'moshy', bundleId: A_BUNDLE,
    }))).body);
    assert.strictEqual(out.url, 'https://signed.example/f10-creative-assets/' + object);
    assert.strictEqual(calls.signed.length, 1);
  });

  /* 3. Missing composite: clean { url:null, reason } instead of a throw or a 404 url. */
  await check('returns url:null with a reason when the composite does not exist', async () => {
    const { FakeBigQuery } = makeFakeBigQuery();
    const { FakeStorage, calls } = makeFakeStorage([]); // nothing exists
    const handler = loadHandler(FakeBigQuery, FakeStorage);

    const out = JSON.parse((await handler(makeEvent({
      action: 'generated-preview', client: A_CLIENT, bundleId: A_BUNDLE,
    }))).body);
    assert.strictEqual(out.url, null);
    assert.strictEqual(out.reason, 'not-found');
    assert.strictEqual(calls.existed.length, 1, 'existence was checked');
    assert.deepStrictEqual(calls.signed, [], 'a missing object is never signed');
  });

  /* 4. Missing inputs fail closed, no storage work. */
  await check('missing client or bundle id returns url:null with a reason', async () => {
    const { FakeBigQuery } = makeFakeBigQuery();
    const { FakeStorage, calls } = makeFakeStorage([A_OBJECT]);
    const handler = loadHandler(FakeBigQuery, FakeStorage);

    for (const payload of [
      { action: 'generated-preview', bundleId: A_BUNDLE },
      { action: 'generated-preview', client: A_CLIENT },
      { action: 'generated-preview', client: '  ', bundleId: '  ' },
    ]) {
      const out = JSON.parse((await handler(makeEvent(payload))).body);
      assert.strictEqual(out.url, null);
      assert.strictEqual(out.reason, 'missing-client-or-bundle');
    }
    assert.deepStrictEqual(calls.existed, [], 'no storage work without both inputs');
  });

  /* 5. Platform routing: a tiktok bundle signs under the tiktok segment. */
  await check('platform routes the composite object under the right segment', async () => {
    const object = 'components/tiktok/Moshy/' + A_BUNDLE + '/composite.png';
    const { FakeBigQuery } = makeFakeBigQuery();
    const { FakeStorage, calls } = makeFakeStorage([object]);
    const handler = loadHandler(FakeBigQuery, FakeStorage);

    const out = JSON.parse((await handler(makeEvent({
      action: 'generated-preview', client: A_CLIENT, bundleId: A_BUNDLE, platform: 'tiktok',
    }))).body);
    assert.strictEqual(out.url, 'https://signed.example/f10-creative-assets/' + object);
    assert.strictEqual(out.platform, 'tiktok');
    assert.strictEqual(calls.existed[0], 'f10-creative-assets/' + object);
  });

  console.log(`\n${passed} checks passed.`);
})().catch((err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
