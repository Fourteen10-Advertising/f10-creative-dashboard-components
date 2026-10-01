/**
 * Carousel creative previews — regression for "previews only show the first card".
 *
 * Two halves of one feature:
 *
 * 1. Backend (`starter/netlify/functions/bq.js`, action:'media'). The media
 *    resolver used to collapse each ad to a single representative asset
 *    (`QUALIFY ROW_NUMBER() ... = 1`), so a carousel ad's other cards were never
 *    returned. It now returns EVERY stored card per ad as an ordered `cards`
 *    array, read from the client's {client}_marts.creative_media in card_index
 *    order (all_clients.creative_media when no client is sent). Card 0 stays the
 *    representative pick, so `type`/`url` are unchanged (backward compatible). Unfetched cards are dropped; an ad with no
 *    stored asset still returns `url:null` for the Facebook fallback.
 *
 * 2. Frontend (`f10-preview.js`). `f10PreviewCards` normalises the response into
 *    a card list (legacy `{type,url}` and single-asset ads collapse to one card;
 *    url-less cards are dropped), and `f10CarouselHtml` renders the swipeable
 *    carousel — a frame for the active card, prev/next arrows, one dot per card,
 *    and an N-of-M counter.
 *
 * Dependency-free: bq.js is compiled with the two @google-cloud modules stubbed
 * (mirrors test/us-007-competitor-actions.test.js); f10-preview.js runs in a vm
 * sandbox (mirrors test/us-016-chart-palette.test.js).
 *
 * Run: node test/carousel-preview.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BQ_PATH = path.join(ROOT, 'starter/netlify/functions/bq.js');
const BQ_SRC = fs.readFileSync(BQ_PATH, 'utf8');
const PREVIEW_SRC = fs.readFileSync(path.join(ROOT, 'f10-preview.js'), 'utf8');

/* ── Fakes for the Netlify function (mirror us-007) ── */
function makeFakeBigQuery(router) {
  const queries = [];
  class FakeBigQuery {
    constructor(opts) { this.opts = opts; }
    async query(opts) {
      queries.push(opts);
      return [router(opts) || []];
    }
  }
  return { FakeBigQuery, queries };
}

// Signs each asset to a distinct URL that echoes the object path, so a test can
// assert the returned card order maps to the right gs:// assets.
function makeFakeStorage() {
  class FakeStorage {
    constructor(opts) { this.opts = opts; }
    bucket(b) {
      return {
        file(f) {
          return { async getSignedUrl() { return ['https://signed.example/' + b + '/' + f]; } };
        },
      };
    }
  }
  return FakeStorage;
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

process.env.GOOGLE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'x@test', private_key: 'k' });

/* ── Load f10-preview.js builders into a vm sandbox ── */
function loadPreview() {
  const sandbox = {
    window: {}, document: {}, console,
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(PREVIEW_SRC, sandbox, { filename: 'f10-preview.js' });
  return sandbox.window;
}

let passed = 0;
function check(name, fn) {
  const p = fn();
  return Promise.resolve(p).then(() => { passed++; console.log('  ok -', name); });
}

(async () => {
  console.log('Carousel creative previews');

  /* ───────────────────────── Backend: media action ───────────────────────── */

  await check('carousel ad returns every stored card in order; card 0 stays type/url', async () => {
    // Rows come back in the query's ORDER BY order (representative card first).
    // The unfetched middle row must be dropped from the carousel, not left as a gap.
    const router = (opts) => {
      // Cards come from the dataform creative_media mart, in card_index order.
      assert.ok(/creative_media/.test(opts.query), 'media query reads creative_media');
      assert.ok(!/QUALIFY/.test(opts.query), 'every card is returned, not one per ad');
      assert.ok(/ORDER BY ad_id, card_index/.test(opts.query), 'rows ordered so cards group per ad, in card order');
      return [
        { ad_id: 'CAR', asset_type: 'image', gcs_uri: 'gs://b/car-0.jpg', fetch_status: 'fetched' },
        { ad_id: 'CAR', asset_type: 'video', gcs_uri: 'gs://b/car-1.mp4', fetch_status: 'fetched' },
        { ad_id: 'CAR', asset_type: null, gcs_uri: null, fetch_status: 'pending' }, // dropped
        { ad_id: 'CAR', asset_type: 'image', gcs_uri: 'gs://b/car-2.png', fetch_status: 'fetched' },
      ];
    };
    const { FakeBigQuery, queries } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const res = await handler(makeEvent({ action: 'media', adIds: ['CAR'], platform: 'meta' }));
    assert.strictEqual(res.statusCode, 200);
    const out = JSON.parse(res.body);

    assert.ok(out.CAR, 'CAR present');
    assert.strictEqual(out.CAR.cards.length, 3, 'three fetched cards, pending one dropped');
    assert.deepStrictEqual(
      out.CAR.cards.map((c) => c.url),
      ['https://signed.example/b/car-0.jpg', 'https://signed.example/b/car-1.mp4', 'https://signed.example/b/car-2.png'],
      'cards keep query order'
    );
    assert.strictEqual(out.CAR.cards[1].type, 'video', 'video card typed from asset_type');
    // Backward compatibility: type/url mirror card 0.
    assert.strictEqual(out.CAR.url, out.CAR.cards[0].url, 'primary url = card 0');
    assert.strictEqual(out.CAR.type, 'image', 'primary type = card 0');

    for (const q of queries) {
      assert.ok(q.maximumBytesBilled && q.jobTimeoutMs, 'media query keeps cost/timeout guardrails');
      assert.strictEqual(q.useLegacySql, false);
    }
  });

  await check('single-asset ad is unchanged: one card, type/url set', async () => {
    const router = () => [
      { ad_id: 'ONE', asset_type: 'image', gcs_uri: 'gs://b/one.jpg', fetch_status: 'fetched' },
    ];
    const { FakeBigQuery } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const out = JSON.parse((await handler(makeEvent({ action: 'media', adIds: ['ONE'] }))).body);
    assert.strictEqual(out.ONE.cards.length, 1);
    assert.strictEqual(out.ONE.url, 'https://signed.example/b/one.jpg');
    assert.strictEqual(out.ONE.type, 'image');
  });

  await check('ad with no stored asset returns url:null and an empty card list (Facebook fallback)', async () => {
    const router = () => [
      { ad_id: 'NONE', asset_type: 'video', gcs_uri: null, fetch_status: 'pending' },
    ];
    const { FakeBigQuery } = makeFakeBigQuery(router);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    const out = JSON.parse((await handler(makeEvent({ action: 'media', adIds: ['NONE'] }))).body);
    assert.strictEqual(out.NONE.url, null, 'no signed url');
    assert.deepStrictEqual(out.NONE.cards, [], 'no cards to swipe');
    assert.strictEqual(out.NONE.type, 'video', 'advertised type carried for the fallback');
  });

  /* ─────────────── Backend: which creative_media view is read ─────────────── */

  function tableOf(q) {
    const m = /FROM `([^`]+)`/.exec(q.query);
    return m ? m[1] : null;
  }

  await check('with a client, media reads that client\'s own {client}_marts.creative_media', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => []);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    await handler(makeEvent({ action: 'media', adIds: ['A'], platform: 'meta', client: 'mosh' }));
    assert.strictEqual(queries.length, 1);
    assert.strictEqual(tableOf(queries[0]), 'mcc-poc-477801.mosh_marts.creative_media');
    assert.deepStrictEqual(queries[0].params, { adIds: ['A'], platform: 'meta' }, 'ad ids and platform are bound parameters');
    assert.ok(!/all_clients_meta|all_clients_tiktok/.test(queries[0].query), 'no raw Airbyte dataset is read');
  });

  await check('without a client (older frontends), media falls back to all_clients.creative_media', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => []);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    await handler(makeEvent({ action: 'media', adIds: ['A'] }));
    assert.strictEqual(tableOf(queries[0]), 'mcc-poc-477801.all_clients.creative_media');
    assert.strictEqual(queries[0].params.platform, 'meta', 'platform defaults to meta');
  });

  await check('tiktok platform is passed through; unknown platforms read as meta', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => []);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    await handler(makeEvent({ action: 'media', adIds: ['T'], platform: 'tiktok', client: 'fastcover' }));
    await handler(makeEvent({ action: 'media', adIds: ['X'], platform: 'snapchat', client: 'fastcover' }));
    assert.strictEqual(queries[0].params.platform, 'tiktok');
    assert.strictEqual(queries[1].params.platform, 'meta');
    assert.strictEqual(tableOf(queries[0]), 'mcc-poc-477801.fastcover_marts.creative_media');
  });

  await check('a hostile client value is reduced to the dataset charset before it is inlined', async () => {
    const { FakeBigQuery, queries } = makeFakeBigQuery(() => []);
    const handler = loadHandler(FakeBigQuery, makeFakeStorage());
    await handler(makeEvent({ action: 'media', adIds: ['A'], client: 'mosh`; DROP TABLE x; --' }));
    assert.strictEqual(tableOf(queries[0]), 'mcc-poc-477801.moshdroptablex_marts.creative_media');
    assert.strictEqual((queries[0].query.match(/`/g) || []).length, 2, 'no backtick breaks out of the identifier');
  });

  /* ───────────────────────── Frontend: preview builders ───────────────────────── */

  const win = loadPreview();

  await check('f10PreviewCards normalises legacy, single, multi, and empty shapes', () => {
    assert.strictEqual(win.f10PreviewCards({ cards: [{ url: 'a' }, { url: 'b' }] }).length, 2, 'multi-card');
    assert.strictEqual(win.f10PreviewCards({ type: 'image', url: 'x' }).length, 1, 'legacy {type,url}');
    assert.strictEqual(win.f10PreviewCards({ cards: [{ url: 'a' }, { url: null }, {}] }).length, 1, 'drops url-less cards');
    assert.strictEqual(win.f10PreviewCards({ url: null, cards: [] }).length, 0, 'no media -> no cards');
  });

  await check('f10CarouselHtml renders arrows, a dot per card, active state, counter, and the active frame', () => {
    const cards = [
      { type: 'image', url: 'https://x/0.jpg' },
      { type: 'video', url: 'https://x/1.mp4' },
      { type: 'image', url: 'https://x/2.jpg' },
    ];
    const html = win.f10CarouselHtml(cards, 1);
    assert.ok(/f10-carousel-prev/.test(html) && /f10-carousel-next/.test(html), 'has prev/next arrows');
    assert.strictEqual((html.match(/f10-carousel-dot"|f10-carousel-dot /g) || []).length, 3, 'one dot per card');
    assert.ok(/f10-carousel-dot is-active" data-i="1"/.test(html), 'active dot marks the current card');
    assert.ok(/2\/3/.test(html), 'counter shows card 2 of 3');
    assert.ok(/https:\/\/x\/1\.mp4/.test(html) && /<video/.test(html), 'frame shows the active (video) card');
    assert.ok(!/https:\/\/x\/0\.jpg/.test(html), 'only the active card is in the frame');
  });

  await check('f10MediaRequestBody sends the client derived from DATASET', () => {
    const body = win.f10MediaRequestBody('123', 'tiktok');
    assert.strictEqual(body.action, 'media');
    assert.deepStrictEqual(Array.from(body.adIds), ['123']);
    assert.strictEqual(body.platform, 'tiktok');
    assert.strictEqual(body.client, undefined, 'no DATASET -> no client sent');
    const sandbox = { window: {}, document: {}, console, setTimeout, clearTimeout, DATASET: 'beyond_bank_marts' };
    vm.createContext(sandbox);
    vm.runInContext(PREVIEW_SRC, sandbox, { filename: 'f10-preview.js' });
    const withClient = sandbox.window.f10MediaRequestBody('9');
    assert.strictEqual(withClient.client, 'beyond_bank', 'mosh_marts-style DATASET loses its suffix');
    assert.strictEqual(withClient.platform, 'meta', 'platform defaults to meta');
  });

  console.log(`\n${passed} checks passed.`);
})().catch((err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
