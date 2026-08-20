/**
 * US-007 - Interactive preview module (f10-review.js): probe-gated, live-path safe.
 *
 * PART 1 (unit): loads the real f10-review.js into a vm sandbox with a tiny DOM stub and
 * a fetch stub / injectable store standing in for the Netlify bq function, and covers:
 *   - probe-gated registration: the Review tab appears only when the client has review
 *     data (winning-historical probe exists:true) AND bundles are configured; exists:false
 *     and probe errors both fail closed with zero DOM trace;
 *   - LIVE-PATH SAFETY: a dashboard with NO REVIEW config (every live client dashboard)
 *     injects nothing AND never even probes the network - strictly additive;
 *   - render: given faked winning-historical + generated-preview responses, each new ad
 *     renders beside the client's winners with the policy metric, the coherence flags and
 *     the so-what / now-what read.
 *
 * PART 2 (live-path canary, functional DOM): boots the REAL base Meta engine (f10-weekly)
 * alongside the layout dispatcher (f10-layout) and the new module (f10-review), then
 * asserts every pre-existing tab still switches to exactly one visible panel after the
 * module registers, that the Review tab activates to exactly one panel through the single
 * generic dispatcher (two panels can never both be active), and that a dashboard WITHOUT a
 * REVIEW config boots with the base nav completely unchanged (no Review nav or panel).
 *
 * Dependency-free (no jsdom): the DOM stubs implement just enough for the real activation
 * code to run unchanged. Run: node test/f10-review.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const UTILS = readSrc('f10-utils.js');
const WEEKLY = readSrc('f10-weekly.js');
const LAYOUT = readSrc('f10-layout.js');
const REVIEW = readSrc('f10-review.js');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }
function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* A representative winning-historical payload: two winners with metric + one signed
 * image + one click-through fallback, and the composed comparison (so-what / now-what). */
function sampleWinners() {
  return {
    client: 'moshy',
    metric: 'cpa',
    metric_policy: 'CPA is the default metric; ROAS only for PharmX and FastCover.',
    revenue_eligible: false,
    winners: [
      { ad_id: '111', ad_name: 'Founder hero v3', is_active: true, metric_type: 'cpa', metric_value: 42, spend: 52000, conversions: 900, image_url: 'https://signed.example/win1.jpg', creative_link: null },
      { ad_id: '222', ad_name: 'UGC testimonial', is_active: true, metric_type: 'cpa', metric_value: 51, spend: 21000, conversions: 300, image_url: null, creative_link: 'https://facebook.com/ad/222' },
    ],
    winning_components: [
      { component: 'hook_type', component_value: 'Founder story', metric_type: 'cpa', cpa: 42, lift: 0.23, confidence_tier: 'high confidence', label: 'descriptive', asset_count: 34, spend: 52000 },
    ],
    comparison: {
      metric: 'CPA',
      top_winner: { ad_id: '111', ad_name: 'Founder hero v3', metric_value: 42 },
      aligned_components: [{ component: 'hook_type', component_value: 'Founder story', lift: 0.23 }],
      unproven_components: [{ component: 'format_canonical', component_value: 'Bold typographic' }],
      coherence_flags: [],
      held_dimensions: [],
      so_what: 'This concept reuses 1 of the client\'s proven winning components (hook_type: Founder story).',
      now_what: '1 dimension is unproven for this client (format_canonical: Bold typographic); hold it and test.',
      summary: 'so what. now what.',
    },
  };
}

function sampleBundle() {
  return {
    bundle_id: 'brief_moshy_founder_ab12cd',
    platform: 'meta',
    label: 'Founder story - bold typographic',
    components: { hook_type: 'Founder story', format_canonical: 'Bold typographic' },
    coherence_flags: ['visual_style held for review'],
    held_dimensions: ['visual_style_canonical'],
    new_ad: { headline: 'Meet the founder', body: 'Why we built this' },
  };
}

/* ========================================================================== *
 * PART 1 - unit coverage (tiny DOM stub)
 * ========================================================================== */

function makeTinyDom() {
  const slots = {};
  function mkSlot(id) {
    return {
      id, innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener() {}, getAttribute() { return null; },
      insertAdjacentHTML(_pos, html) { this.innerHTML += html; }, scrollIntoView() {},
    };
  }
  const document = {
    // Deliberately NO readyState / addEventListener: f10-review's autoBoot becomes a
    // no-op, so each test drives initReview() explicitly and deterministically.
    getElementById(id) { return slots[id] || (slots[id] = mkSlot(id)); },
    querySelector(sel) {
      if (sel === '#sidebar nav') return slots['__nav'] || (slots['__nav'] = mkSlot('__nav'));
      return null;
    },
    querySelectorAll() { return []; },
  };
  return { document, slots };
}

function makeUnitCtx(fetchImpl, reviewConfig) {
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'moshy_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    _slots: slots,
  };
  if (reviewConfig !== undefined) sandbox.REVIEW = reviewConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(REVIEW, sandbox, { filename: 'f10-review.js' });
  return sandbox;
}

async function runUnit() {
  console.log('US-007 Creative Review tab - unit');

  // ── Probe gating: exists:true + bundles configured registers the nav link + panel. ──
  await check('probe exists:true + bundles configured registers the Review nav link + panel', async () => {
    let probeBody = null;
    const ctx = makeUnitCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.probe) { probeBody = body; return jsonResponse({ exists: true }); }
      return jsonResponse({});
    }, { BUNDLES: [sampleBundle()] });
    await ctx.window.initReview();
    assert.ok(probeBody, 'the data probe was called');
    assert.strictEqual(probeBody.action, 'winning-historical', 'probe uses the winning-historical action');
    assert.strictEqual(probeBody.client, 'moshy', 'probe scopes to the resolved client slug');
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(/review-nav-link/.test(nav), 'Review nav link injected');
    assert.ok(/nav-section">Creative Review/.test(nav), 'Creative Review nav section injected');
    assert.ok(/id="panel-review"/.test(content), 'Review panel injected');
    assert.ok(/class="tab-panel review-tab-panel"/.test(content), 'panel carries the shared tab-panel class');
  });

  // ── Probe gating: exists:false leaves ZERO DOM trace (fail closed). ──
  await check('probe exists:false injects no nav link and no panel (fail closed)', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({ exists: false }), { BUNDLES: [sampleBundle()] });
    await ctx.window.initReview();
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link');
    assert.ok(!/panel-review/.test(content), 'no Review panel');
  });

  // ── Probe gating: a probe error fails closed (zero trace). ──
  await check('a probe error fails closed (no nav link, no panel)', async () => {
    const ctx = makeUnitCtx(async () => { throw new Error('endpoint 500'); }, { BUNDLES: [sampleBundle()] });
    await ctx.window.initReview();
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link on probe error');
    assert.ok(!/panel-review/.test(content), 'no Review panel on probe error');
  });

  // ── LIVE-PATH SAFETY: no REVIEW config => no probe, no DOM trace. ──
  await check('no REVIEW config injects nothing AND never touches the network (live-path safe)', async () => {
    let fetched = 0;
    const ctx = makeUnitCtx(async () => { fetched += 1; return jsonResponse({ exists: true }); } /* no reviewConfig */);
    await ctx.window.initReview();
    assert.strictEqual(fetched, 0, 'the probe network call was never made without configured bundles');
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(!/review-nav-link/.test(nav), 'no Review nav link without a REVIEW config');
    assert.ok(!/panel-review/.test(content), 'no Review panel without a REVIEW config');
  });

  // ── LIVE-PATH SAFETY: REVIEW config with an EMPTY bundle list is still a no-op. ──
  await check('REVIEW config with no bundles is a zero-trace no-op', async () => {
    let fetched = 0;
    const ctx = makeUnitCtx(async () => { fetched += 1; return jsonResponse({ exists: true }); }, { BUNDLES: [] });
    await ctx.window.initReview();
    assert.strictEqual(fetched, 0, 'no probe with an empty bundle list');
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(!/panel-review/.test(content), 'no Review panel with an empty bundle list');
  });

  // ── Render: each new ad renders beside the client's winners with metric + flags. ──
  await check('renders each new ad beside the client winners with metric, flags and the so-what/now-what', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({}), { BUNDLES: [sampleBundle()] });
    const previewUrl = 'https://signed.example/new-composite.png';
    ctx.window.f10Review.setStore({
      async probe() { return true; },
      async winners() { return sampleWinners(); },
      async preview() { return { url: previewUrl }; },
    });
    ctx.window.f10Review.setClient('moshy');
    await ctx.window.f10Review.load();
    const html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    // New generated ad preview image is shown.
    assert.ok(html.indexOf(previewUrl) !== -1, 'the new ad preview image (US-005) is rendered');
    // Winners rendered with names, one signed image, one click-through fallback.
    assert.ok(/Founder hero v3/.test(html), 'first winner name rendered');
    assert.ok(html.indexOf('https://signed.example/win1.jpg') !== -1, 'winner signed image rendered');
    assert.ok(html.indexOf('https://facebook.com/ad/222') !== -1, 'winner click-through fallback rendered when no signed image');
    // Policy metric formatted (CPA), not invented.
    assert.ok(/\$42 CPA/.test(html), 'first winner CPA metric formatted');
    // Coherence flags + held dimensions shown in context.
    assert.ok(/visual_style held for review/.test(html), 'coherence flag rendered');
    assert.ok(/visual_style_canonical/.test(html), 'held dimension rendered');
    // Insight-ladder L4/L5 read surfaced verbatim from the action.
    assert.ok(/So what/.test(html) && /proven winning component/.test(html), 'so-what surfaced');
    assert.ok(/Now what/.test(html) && /unproven for this client/.test(html), 'now-what surfaced');
  });

  // ── Render: ROAS-eligible client formats the winner metric as ROAS. ──
  await check('a ROAS-eligible payload formats the winner metric as ROAS', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse({}), { BUNDLES: [sampleBundle()] });
    ctx.window.f10Review.setStore({
      async probe() { return true; },
      async winners() {
        const p = sampleWinners();
        p.metric = 'roas'; p.revenue_eligible = true;
        p.winners = [{ ad_id: '9', ad_name: 'Revenue hero', metric_type: 'roas', metric_value: 3.5, spend: 1000, conversions: 40, image_url: null, creative_link: null }];
        return p;
      },
      async preview() { return { url: null, reason: 'not-found' }; },
    });
    ctx.window.f10Review.setClient('pharmx');
    await ctx.window.f10Review.load();
    const html = (ctx._slots['rev-body'] && ctx._slots['rev-body'].innerHTML) || '';
    assert.ok(/3\.50x ROAS/.test(html), 'ROAS metric formatted');
    assert.ok(/Preview not available/.test(html), 'missing composite falls back to a labelled placeholder, never a broken img');
  });
}

/* ========================================================================== *
 * PART 2 - live-path canary (functional DOM, real base engine + dispatcher)
 * ========================================================================== */

function makeLiveDom() {
  const byId = {};
  const all = [];
  const VOID = { br: 1, img: 1, input: 1, hr: 1, meta: 1, link: 1 };

  function El(tag) {
    const self = {
      tagName: String(tag).toUpperCase(),
      _id: '', _classes: new Set(), dataset: {}, style: {},
      children: [], parent: null, _listeners: {}, _text: '', _html: '',
    };
    Object.defineProperty(self, 'id', { get() { return self._id; }, set(v) { self._id = v || ''; if (v) byId[v] = self; } });
    Object.defineProperty(self, 'className', {
      get() { return Array.from(self._classes).join(' '); },
      set(v) { self._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
    });
    Object.defineProperty(self, 'textContent', { get() { return self._text; }, set(v) { self._text = v == null ? '' : String(v); } });
    Object.defineProperty(self, 'innerHTML', { get() { return self._html; }, set(v) { self._html = v == null ? '' : String(v); } });
    self.classList = {
      add(c) { self._classes.add(c); },
      remove(c) { self._classes.delete(c); },
      contains(c) { return self._classes.has(c); },
      toggle(c, force) {
        const want = force === undefined ? !self._classes.has(c) : !!force;
        if (want) self._classes.add(c); else self._classes.delete(c);
        return want;
      },
    };
    self.setAttribute = function (k, v) {
      if (k === 'id') { self.id = v; return; }
      if (k === 'class') { self.className = v; return; }
      if (k.indexOf('data-') === 0) {
        self.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
        return;
      }
      self[k] = v;
    };
    self.getAttribute = function (k) { return k === 'id' ? self._id : (k === 'class' ? self.className : (self[k] != null ? self[k] : null)); };
    self.appendChild = function (child) { child.parent = self; self.children.push(child); return child; };
    self.addEventListener = function (type, fn) { (self._listeners[type] || (self._listeners[type] = [])).push(fn); };
    self.click = function () {
      const evt = { preventDefault() {}, target: self };
      (self._listeners.click || []).forEach((fn) => fn.call(self, evt));
    };
    self.querySelector = function (sel) { return document.querySelector(sel, self); };
    self.querySelectorAll = function (sel) { return document.querySelectorAll(sel, self); };
    self.insertAdjacentHTML = function (pos, html) { parseInto(self, pos, html); };
    self.scrollIntoView = function () {};
    all.push(self);
    return self;
  }

  function parseInto(target, pos, html) {
    let rest = String(html);
    for (;;) {
      rest = rest.replace(/^\s+/, '');
      while (/^<!--/.test(rest)) rest = rest.replace(/^<!--[\s\S]*?-->/, '').replace(/^\s+/, '');
      const open = /^<([a-zA-Z][\w-]*)((?:\s+[^\s/>]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/.exec(rest);
      if (!open) break;
      const tag = open[1], attrs = open[2], selfClose = open[3] === '/';
      const el = El(tag);
      const attrRe = /([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = attrRe.exec(attrs))) {
        const val = a[2] != null ? a[2] : (a[3] != null ? a[3] : (a[4] != null ? a[4] : ''));
        el.setAttribute(a[1], val);
      }
      let after = rest.slice(open[0].length);
      if (!selfClose && !VOID[tag.toLowerCase()]) {
        const re = new RegExp('<(/?)' + tag + '(?:\\s[^>]*)?>', 'gi');
        re.lastIndex = 0;
        let depth = 1, m, closeStart = -1, closeEnd = -1;
        while ((m = re.exec(after))) {
          if (m[1] === '/') { depth--; if (depth === 0) { closeStart = m.index; closeEnd = re.lastIndex; break; } }
          else { depth++; }
        }
        if (closeStart >= 0) { el.innerHTML = after.slice(0, closeStart); after = after.slice(closeEnd); }
        else { el.innerHTML = after; after = ''; }
      }
      if (pos === 'afterbegin') target.children.unshift(Object.assign(el, { parent: target }));
      else target.appendChild(el);
      rest = after;
    }
  }

  function isDescendant(el, ancestor) {
    let p = el.parent;
    while (p) { if (p === ancestor) return true; p = p.parent; }
    return false;
  }

  function matchOne(part, root) {
    part = part.trim();
    if (part === '#sidebar nav a') {
      const nav = document.querySelector('#sidebar nav');
      if (!nav) return [];
      return all.filter((e) => e.tagName === 'A' && isDescendant(e, nav));
    }
    if (part.charAt(0) === '.') {
      const cls = part.slice(1);
      return all.filter((e) => e._classes.has(cls) && (!root || isDescendant(e, root) || e === root));
    }
    if (/^[a-zA-Z][\w-]*$/.test(part)) {
      const tag = part.toUpperCase();
      return all.filter((e) => e.tagName === tag && (!root || isDescendant(e, root)));
    }
    return [];
  }

  const document = {
    createElement(tag) { return El(tag); },
    getElementById(id) { return byId[id] || (byId[id] = El('div'), byId[id].id = id, byId[id]); },
    querySelector(sel, root) {
      if (sel === '#sidebar nav') { const r = matchOne('nav', null).filter((n) => n.parent && n.parent._id === 'sidebar'); return r[0] || null; }
      const r = document.querySelectorAll(sel, root);
      return r[0] || null;
    },
    querySelectorAll(sel, root) {
      const out = [];
      String(sel).split(',').forEach((part) => {
        matchOne(part, root).forEach((e) => { if (out.indexOf(e) === -1) out.push(e); });
      });
      return out;
    },
  };
  return { document, El, byId, all };
}

/* Boot a functional dashboard: build the base Meta nav + panels (as renderLayout would),
 * wire the real base engine + layout dispatcher, then run initReview with the given
 * REVIEW config + store. Returns handles for the canary assertions. */
async function bootDashboard(reviewConfig, store) {
  const dom = makeLiveDom();
  const document = dom.document;

  const sidebar = document.createElement('div'); sidebar.id = 'sidebar';
  const nav = document.createElement('nav'); sidebar.appendChild(nav);
  const content = document.createElement('div'); content.id = 'content';
  const pageTitle = document.createElement('h1'); pageTitle.id = 'page-title'; content.appendChild(pageTitle);
  const controlsBar = document.createElement('div'); controlsBar.id = 'controls-bar'; content.appendChild(controlsBar);
  const ttControlsBar = document.createElement('div'); ttControlsBar.id = 'tt-controls-bar'; content.appendChild(ttControlsBar);

  function addNavLink(cls, dataKey, dataVal, label) {
    const a = document.createElement('a');
    a.className = cls; a.dataset[dataKey] = dataVal; a.textContent = label;
    nav.appendChild(a); return a;
  }
  function addPanel(id, cls) {
    const p = document.createElement('div'); p.className = cls; p.id = id;
    content.appendChild(p); return p;
  }

  const META_TABS = ['summary', 'board', 'map', 'production', 'creative'];
  META_TABS.forEach((t, i) => {
    const link = addNavLink('nav-link', 'tab', t, t);
    if (i === 0) link.classList.add('active');
    const panel = addPanel('tab-' + t, 'tab-panel');
    if (i === 0) panel.classList.add('active');
  });

  const fetchImpl = async () => jsonResponse([]);

  const window = { f10MediaMarkup: () => '' };
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'moshy_marts',
    TABLE: 'creative_reporting',
    CONV_EXPR: 'purchase',
    CLIENT_NAME: 'Moshy',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    Chart: function () { return { destroy() {} }; },
  };
  if (reviewConfig !== undefined) sandbox.REVIEW = reviewConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(WEEKLY, sandbox, { filename: 'f10-weekly.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  vm.runInContext(REVIEW, sandbox, { filename: 'f10-review.js' });

  // f10-monthly.js is not loaded (the canary is about tab switching): neutralise the one
  // symbol base selectTab calls for a monthly tab.
  sandbox.loadMonthlyTab = function () {};

  sandbox.wireControls();               // base Meta: binds .nav-link -> selectTab
  if (store) sandbox.window.f10Review.setStore(store);
  await sandbox.window.initReview();    // the NEW module: config + probe gate -> register via f10ActivateTab

  return { dom, document, sandbox, nav, content };
}

function activePanels(document) {
  return document.querySelectorAll('.tab-panel').filter((p) => p.classList.contains('active'));
}

const REVIEW_STORE = {
  async probe() { return true; },
  async winners() { return sampleWinners(); },
  async preview() { return { url: 'https://signed.example/new-composite.png' }; },
};

async function runCanary() {
  console.log('US-007 Creative Review tab - live-path canary + dispatcher');

  const { document } = await bootDashboard({ BUNDLES: [sampleBundle()] }, REVIEW_STORE);

  await check('the new Review module registered (nav link + panel present)', async () => {
    assert.strictEqual(document.querySelectorAll('.review-nav-link').length, 1, 'exactly one Review nav link');
    const panel = document.getElementById('panel-review');
    assert.ok(panel && panel.classList.contains('tab-panel'), 'the panel carries .tab-panel so existing dispatchers clear it');
  });

  // Every pre-existing base tab still switches to exactly one visible panel.
  const preExisting = [
    { label: 'Weekly Summary', tab: 'summary', panelId: 'tab-summary' },
    { label: 'Movement Board', tab: 'board', panelId: 'tab-board' },
    { label: 'Ad Production', tab: 'production', panelId: 'tab-production' },
    { label: 'Creative Effectiveness', tab: 'creative', panelId: 'tab-creative' },
  ];
  for (const t of preExisting) {
    await check('pre-existing tab still switches to exactly one visible panel: ' + t.label, async () => {
      const link = document.querySelectorAll('.nav-link').find((e) => e.dataset.tab === t.tab);
      assert.ok(link, 'nav link found for ' + t.label);
      link.click();
      const active = activePanels(document);
      assert.strictEqual(active.length, 1, 'exactly one panel visible after activating ' + t.label);
      assert.strictEqual(active[0].getAttribute('id'), t.panelId, 'the correct base panel is visible');
      const rev = document.getElementById('panel-review');
      assert.ok(!rev.classList.contains('active'), 'the Review panel is not stuck visible');
    });
  }

  // The Review tab activates to exactly one panel via the single generic dispatcher.
  await check('the Review tab activates to exactly one panel and clears all others', async () => {
    const link = document.querySelectorAll('.review-nav-link')[0];
    link.click();
    const active = activePanels(document);
    assert.strictEqual(active.length, 1, 'exactly one panel visible after activating Review');
    assert.strictEqual(active[0].getAttribute('id'), 'panel-review', 'the Review panel is the visible one');
    const activeLinks = document.querySelectorAll('#sidebar nav a').filter((a) => a.classList.contains('active'));
    assert.strictEqual(activeLinks.length, 1, 'exactly one nav link is active');
    assert.ok(activeLinks[0].classList.contains('review-nav-link'), 'the active nav link is Review');
    assert.strictEqual(document.getElementById('page-title').textContent, 'Creative Review', 'page title updated');
  });

  // Two panels can never both be active: switching back to a base tab clears Review.
  await check('switching back to a base tab clears the Review panel (two panels never both active)', async () => {
    const summary = document.querySelectorAll('.nav-link').find((e) => e.dataset.tab === 'summary');
    summary.click();
    const active = activePanels(document);
    assert.strictEqual(active.length, 1, 'exactly one panel visible');
    assert.strictEqual(active[0].getAttribute('id'), 'tab-summary', 'back on the Weekly Summary panel');
    assert.ok(!document.getElementById('panel-review').classList.contains('active'), 'Review panel cleared');
  });

  // LIVE-PATH: a dashboard with NO REVIEW config boots with the base nav UNCHANGED.
  await check('a dashboard without a REVIEW config is completely unaffected (no Review nav or panel)', async () => {
    const d2 = await bootDashboard(undefined, REVIEW_STORE);
    assert.strictEqual(d2.document.querySelectorAll('.review-nav-link').length, 0, 'no Review nav link injected on a live client dashboard');
    assert.strictEqual(d2.document.querySelectorAll('.review-tab-panel').length, 0, 'no Review panel injected on a live client dashboard');
    // The base nav + its active summary panel are exactly as booted.
    assert.strictEqual(d2.document.querySelectorAll('.nav-link').length, 5, 'the five base nav links are untouched');
    const active = activePanels(d2.document);
    assert.strictEqual(active.length, 1, 'exactly one base panel active');
    assert.strictEqual(active[0].getAttribute('id'), 'tab-summary', 'the base Weekly Summary panel is still the active one');
  });
}

(async () => {
  await runUnit();
  await runCanary();
  console.log('\nUS-007 OK - ' + passed + ' checks passed.');
})().catch((e) => { console.error('\nUS-007 FAILED:', (e && e.stack) || e); process.exit(1); });
