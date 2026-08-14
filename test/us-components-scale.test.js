/**
 * US-004 - Component Scale dashboard tab (f10-components.js) + the generic tab
 * dispatcher refactor (f10-layout.js f10ActivateTab).
 *
 * PART 1 (unit): loads the real f10-utils.js + f10-components.js into a vm sandbox with
 * a tiny DOM stub and a fetch stub standing in for the Netlify bq function, and covers:
 *   - module registration + probe gating (EXISTS on component_performance): the tab
 *     appears only when the client's mart has rows; exists:false and probe errors both
 *     fail closed with zero DOM trace;
 *   - insufficient-evidence values render greyed WITH their asset count (never hidden);
 *   - the verbatim descriptive caveat, the co_occurrence_flag mark, and the whitespace
 *     lane rendering as its own clearly-labelled section with no performance numbers;
 *   - a failed component-scale query renders a visible panel error state.
 *
 * PART 2 (net-new live-path canary): builds a functional in-memory DOM, boots the REAL
 * base Meta engine (f10-weekly), TikTok engine (f10-tiktok) and Competitor module
 * (f10-competitors) alongside the layout dispatcher (f10-layout) and the new module
 * (f10-components), then enumerates the base nav - Weekly, Monthly, Competitors and
 * TikTok - and asserts each PRE-EXISTING tab still switches to exactly one visible panel
 * after the new module registers, and that the new tab itself activates to exactly one
 * panel through the single generic dispatcher. No such canary existed before, so it is
 * net-new (PRD US-004 note).
 *
 * Dependency-free (no jsdom): the functional DOM implements just enough (Set-backed
 * classList, dataset, addEventListener/click dispatch, createElement/appendChild, a
 * fragment-parsing insertAdjacentHTML, and class / '#sidebar nav a' selectors) for the
 * real activation code to run unchanged.
 *
 * Run: node test/us-components-scale.test.js
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
const TIKTOK = readSrc('f10-tiktok.js');
const COMPETITORS = readSrc('f10-competitors.js');
const LAYOUT = readSrc('f10-layout.js');
const COMPONENTS = readSrc('f10-components.js');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('  ok -', name); }
function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/* ========================================================================== *
 * PART 1 - unit coverage (tiny DOM stub, mirrors the existing US-009/010 tests)
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
    getElementById(id) { return slots[id] || (slots[id] = mkSlot(id)); },
    querySelector(sel) {
      if (sel === '#sidebar nav') return slots['__nav'] || (slots['__nav'] = mkSlot('__nav'));
      return null;
    },
    querySelectorAll() { return []; },
  };
  return { document, slots };
}

function makeUnitCtx(fetchImpl, componentsConfig) {
  const { document, slots } = makeTinyDom();
  const window = {};
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'mosh_marts',
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    _slots: slots,
  };
  if (componentsConfig !== undefined) sandbox.COMPONENTS = componentsConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(COMPONENTS, sandbox, { filename: 'f10-components.js' });
  return sandbox;
}

/* A representative component_performance payload: a high-confidence winner, a graded
 * mid, an insufficient-evidence value (below the 10-asset gate), and a co-occurrence-
 * flagged grade. Columns match the pinned contract in f10-dataform. */
function sampleScale() {
  return [
    { client: 'mosh', component: 'hook_type', component_value: 'Problem-solution', asset_count: 34, spend: 52000, conversions: 900, revenue: null, metric_type: 'cpa', cpa: 42.1, roas: null, metric: 42.1, baseline_metric: 55.0, lift: 0.234, metric_ci_low: 0.1, metric_ci_high: 0.3, confidence_tier: 'high confidence', co_occurrence_flag: false, label: 'descriptive', evidence_window_months: 18 },
    { client: 'mosh', component: 'hook_type', component_value: 'Testimonial', asset_count: 14, spend: 12000, conversions: 180, revenue: null, metric_type: 'cpa', cpa: 61.0, roas: null, metric: 61.0, baseline_metric: 55.0, lift: -0.098, metric_ci_low: null, metric_ci_high: null, confidence_tier: 'graded', co_occurrence_flag: true, label: 'descriptive', evidence_window_months: 18 },
    { client: 'mosh', component: 'hook_type', component_value: 'Founder story', asset_count: 4, spend: 1500, conversions: 20, revenue: null, metric_type: 'cpa', cpa: 70.0, roas: null, metric: 70.0, baseline_metric: 55.0, lift: null, metric_ci_low: null, metric_ci_high: null, confidence_tier: 'insufficient evidence', co_occurrence_flag: null, label: 'descriptive', evidence_window_months: 18 },
    { client: 'mosh', component: 'format_canonical', component_value: 'UGC video', asset_count: 40, spend: 80000, conversions: 1600, revenue: null, metric_type: 'cpa', cpa: 50.0, roas: null, metric: 50.0, baseline_metric: 55.0, lift: 0.10, metric_ci_low: null, metric_ci_high: null, confidence_tier: 'high confidence', co_occurrence_flag: false, label: 'descriptive', evidence_window_months: 18 },
  ];
}

function sampleWhitespace() {
  return [
    { component: 'message_angle_canonical', component_value: 'Price / value', source_client_count: 3, local_asset_count: 0, label: 'untested here - hypothesis, not a grade', evidence_window_months: 18 },
    { component: 'visual_style_canonical', component_value: 'Bold typographic', source_client_count: 2, local_asset_count: 4, label: 'untested here - hypothesis, not a grade', evidence_window_months: 18 },
  ];
}

async function runUnit() {
  console.log('US-004 Component Scale tab - unit');

  // ── Probe gating: exists:true registers the nav link + panel. ──
  await check('probe has_data:true registers the Component Scale nav link + panel', async () => {
    const ctx = makeUnitCtx(async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.ok(/component_performance/.test(body.query), 'probe queries component_performance');
      assert.ok(/EXISTS/.test(body.query), 'probe uses a cheap EXISTS check');
      return jsonResponse([{ has_data: true }]);
    });
    await ctx.window.initComponents();
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(/components-nav-link/.test(nav), 'Component Scale nav link injected');
    assert.ok(/nav-section">Creative Components/.test(nav), 'Creative Components nav section injected');
    assert.ok(/id="panel-components"/.test(content), 'Component Scale panel injected');
    assert.ok(/class="tab-panel components-tab-panel"/.test(content), 'panel carries the shared tab-panel class');
  });

  // ── Probe gating: exists:false leaves ZERO DOM trace (no tab). ──
  await check('probe has_data:false injects no nav link and no panel (fail closed)', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse([{ has_data: false }]));
    await ctx.window.initComponents();
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(!/components-nav-link/.test(nav), 'no nav link');
    assert.ok(!/panel-components/.test(content), 'no panel');
  });

  // ── Probe error (missing mart / 500) fails closed - no tab, no empty state. ──
  await check('a probe error fails closed with zero DOM trace', async () => {
    const ctx = makeUnitCtx(async () => ({ ok: false, status: 404, text: async () => 'Not found: Table component_performance' }));
    await ctx.window.initComponents();
    const nav = (ctx._slots['__nav'] && ctx._slots['__nav'].innerHTML) || '';
    const content = (ctx._slots['content'] && ctx._slots['content'].innerHTML) || '';
    assert.ok(!/components-nav-link/.test(nav) && !/panel-components/.test(content), 'no tab on probe error');
  });

  // ── Insufficient-evidence values render greyed WITH their asset count (never hidden). ──
  await check('insufficient-evidence value renders greyed with its asset count, never hidden', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse([]));
    const C = ctx.window.f10Components;
    const insuffRow = sampleScale()[2]; // Founder story, 4 assets, insufficient evidence
    const rowHtml = C.scaleRowHtml(insuffRow);
    assert.ok(/cmp-insuff/.test(rowHtml), 'row is greyed via the cmp-insuff class');
    assert.ok(/4 ads/.test(rowHtml), 'its asset count (4 ads) is still shown');
    assert.ok(/insufficient evidence/.test(rowHtml), 'its confidence tier is labelled');
    // And the full scale surface keeps it (never dropped): the value appears in scaleHtml.
    const full = C.scaleHtml(sampleScale());
    assert.ok(/Founder story/.test(full), 'the insufficient-evidence value is present in the full render');
    assert.ok(/cmp-insuff/.test(full), 'it is greyed in the full render');
  });

  // ── The verbatim descriptive caveat is rendered (association, not causation). ──
  await check('the descriptive (not causal) caveat is rendered verbatim', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse([]));
    const C = ctx.window.f10Components;
    const full = C.scaleHtml(sampleScale());
    assert.ok(/Descriptive, not causal/.test(full), 'descriptive caveat text present');
    assert.ok(/trailing 18 months/.test(full), 'evidence window surfaced from the mart');
  });

  // ── co_occurrence_flag grades are MARKED by default (US-005 populates the flag). ──
  await check('a co_occurrence_flag grade is marked; SUPPRESS_CO_OCCURRENCE hides its grade', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse([]));
    const flaggedRow = sampleScale()[1]; // Testimonial, co_occurrence_flag: true
    const marked = ctx.window.f10Components.scaleRowHtml(flaggedRow);
    assert.ok(/cmp-flagged/.test(marked), 'flagged row tagged');
    assert.ok(/co-occurrence/.test(marked), 'co-occurrence marker shown');
    // With SUPPRESS_CO_OCCURRENCE the grade is held rather than shown.
    const ctx2 = makeUnitCtx(async () => jsonResponse([]), { SUPPRESS_CO_OCCURRENCE: true });
    const suppressed = ctx2.window.f10Components.scaleRowHtml(flaggedRow);
    assert.ok(/Held - co-occurrence/.test(suppressed), 'grade suppressed to a caution when configured');
  });

  // ── Whitespace lane: its own clearly-labelled section, hypotheses only, no numbers/names. ──
  await check('whitespace lane renders as a separate labelled section with no performance numbers', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse([]));
    const ws = ctx.window.f10Components.whitespaceHtml(sampleWhitespace());
    assert.ok(/cmp-whitespace/.test(ws), 'whitespace renders in its own section');
    assert.ok(/Whitespace - untested here/.test(ws), 'section is clearly labelled');
    assert.ok(/untested here - hypothesis, not a grade/.test(ws), 'the verbatim hypothesis label is shown');
    assert.ok(/3 other clients/.test(ws), 'source client COUNT shown (not names)');
    // No pooled performance numbers leak into the lane.
    assert.ok(!/lift|CPA|ROAS|\$/.test(ws), 'no lift / CPA / ROAS / spend number in the whitespace lane');
  });

  // ── A failed scale query renders a visible panel error state (not a blank tab). ──
  await check('a failed scale query renders a visible temporarily-unavailable panel error', async () => {
    const ctx = makeUnitCtx(async () => jsonResponse([]));
    ctx.window.f10Components.renderError(new Error('backend exploded'));
    const err = (ctx._slots['cmp-error'] && ctx._slots['cmp-error'].innerHTML) || '';
    assert.ok(/temporarily unavailable/.test(err), 'panel shows a visible error state');
    assert.ok(/backend exploded/.test(err), 'the failure detail is surfaced, not swallowed');
    assert.strictEqual(ctx._slots['cmp-error'].style.display, 'block', 'error panel is shown');
  });

  // ── The load path reads the mart then renders both surfaces (scale + whitespace). ──
  await check('load fetches the scale then the whitespace and renders both', async () => {
    let sawScale = false, sawWhitespace = false;
    const ctx = makeUnitCtx(async (url, opts) => {
      const q = JSON.parse(opts.body).query;
      if (/component_performance/.test(q) && !/EXISTS/.test(q)) { sawScale = true; return jsonResponse(sampleScale()); }
      if (/component_whitespace/.test(q)) { sawWhitespace = true; return jsonResponse(sampleWhitespace()); }
      return jsonResponse([]);
    });
    ctx.window.f10Components.setClient('mosh');
    await ctx.window.f10Components.load();
    assert.ok(sawScale && sawWhitespace, 'both the scale and whitespace marts were read');
    const scale = (ctx._slots['cmp-scale'] && ctx._slots['cmp-scale'].innerHTML) || '';
    assert.ok(/Problem-solution/.test(scale) && /Winning/.test(scale), 'a winning grade rendered');
    const ws = (ctx._slots['cmp-whitespace'] && ctx._slots['cmp-whitespace'].innerHTML) || '';
    assert.ok(/untested here - hypothesis, not a grade/.test(ws), 'whitespace rendered');
  });

  // ── The layout contribution: the one-line dispatch + the generic dispatcher exist. ──
  await check('f10-layout.js dispatches initComponents from the renderLayout tail and defines f10ActivateTab', async () => {
    assert.ok(/if \(typeof initComponents === 'function'\) initComponents\(\);/.test(LAYOUT), 'renderLayout tail dispatches initComponents (one line)');
    assert.ok(/function f10ActivateTab\(/.test(LAYOUT), 'the single generic dispatcher f10ActivateTab is defined');
    assert.ok(/querySelectorAll\('#sidebar nav a'\)/.test(LAYOUT), 'the dispatcher clears every nav link generically');
    assert.ok(/querySelectorAll\('\.tab-panel'\)/.test(LAYOUT), 'the dispatcher clears every panel generically');
  });
}

/* ========================================================================== *
 * PART 2 - net-new live-path canary (functional DOM, real engines booted)
 * ========================================================================== */

/* A functional in-memory DOM: enough of the browser API for the real activation code
 * to run unchanged - Set-backed classList, dataset, event dispatch, createElement /
 * appendChild, a fragment-parsing insertAdjacentHTML, and the class / '#sidebar nav a'
 * selectors the engines query with. */
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

  // Parse the FIRST top-level element of a fragment (id/class/data-* + inner HTML),
  // append it, and continue with the remainder - enough for the single-element nav /
  // panel fragments the modules inject.
  function parseInto(target, pos, html) {
    let rest = String(html);
    for (;;) {
      // Skip leading whitespace and HTML comments (panel fragments lead with a comment).
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
        // Find the matching close tag, honouring nesting of the same tag name.
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
      else target.appendChild(el); // beforeend and everything else: append under target
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
    return []; // '#ctrl-floor button' and other unmodelled selectors -> empty (safe)
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

/* Boot the full stack against a functional DOM: build the base Meta + TikTok nav and
 * panels (as renderLayout would), then load and wire every real engine plus the new
 * module. Returns handles for the canary assertions. */
async function bootLiveDashboard() {
  const dom = makeLiveDom();
  const document = dom.document;

  // Root chrome the activation code touches.
  const sidebar = document.createElement('div'); sidebar.id = 'sidebar';
  const nav = document.createElement('nav'); sidebar.appendChild(nav);
  const content = document.createElement('div'); content.id = 'content';
  const pageTitle = document.createElement('h1'); pageTitle.id = 'page-title'; content.appendChild(pageTitle);
  const controlsBar = document.createElement('div'); controlsBar.id = 'controls-bar'; content.appendChild(controlsBar);
  const ttControlsBar = document.createElement('div'); ttControlsBar.id = 'tt-controls-bar'; content.appendChild(ttControlsBar);

  function addNavLink(cls, dataKey, dataVal, label) {
    const a = document.createElement('a');
    a.className = cls;
    a.dataset[dataKey] = dataVal;
    a.textContent = label;
    nav.appendChild(a);
    return a;
  }
  function addPanel(id, cls) {
    const p = document.createElement('div');
    p.className = cls; p.id = id;
    content.appendChild(p);
    return p;
  }

  // Base Meta nav + panels (the Weekly and Monthly groups from renderLayout).
  const META_TABS = ['summary', 'board', 'map', 'powerlaw', 'production', 'decay', 'age', 'creative'];
  META_TABS.forEach((t, i) => {
    const link = addNavLink('nav-link', 'tab', t, t);
    if (i === 0) link.classList.add('active');
    const panel = addPanel('tab-' + t, 'tab-panel');
    if (i === 0) panel.classList.add('active');
  });
  // TikTok nav + panels.
  const TT_TABS = ['tt-summary', 'tt-board', 'tt-production', 'tt-creative'];
  TT_TABS.forEach((t) => {
    addNavLink('tt-nav-link', 'ttTab', t, t);
    addPanel('panel-' + t, 'tab-panel tt-tab-panel');
  });

  // The fetch stub standing in for the Netlify bq function: serves the competitor
  // named-action probes AND the components raw-SQL EXISTS probe + reads.
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.action) {
      // Competitor engine: only the Competitor Ads tab exists here.
      if (body.probe) return jsonResponse({ exists: body.action === 'competitor' });
      if (body.action === 'competitor') return jsonResponse({ ads: [], ageMetrics: { client: null, byPage: {} }, days: body.days || 90 });
      return jsonResponse({});
    }
    const q = body.query || '';
    if (/component_performance/.test(q) && /EXISTS/.test(q)) return jsonResponse([{ has_data: true }]);
    if (/component_performance/.test(q)) return jsonResponse([]);
    if (/component_whitespace/.test(q)) return jsonResponse([]);
    // TikTok / Meta boot reads: benign empty result.
    return jsonResponse([]);
  };

  const window = { f10MediaMarkup: () => '' };
  window.F10A = { track() {} };
  const sandbox = {
    window, document, console,
    F10A: window.F10A,
    PROJECT: 'mcc-poc-477801',
    DATASET: 'mosh_marts',
    TABLE: 'creative_reporting',
    CONV_EXPR: 'purchase',
    CLIENT_NAME: 'Mosh',
    TIKTOK: { TABLE: 'tiktok_creative_reporting', CONV_EXPR: 'conversions' },
    BQ_FUNCTION: 'https://fn.example/.netlify/functions/bq',
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    Chart: function () { return { destroy() {} }; },
    competitorPanelMarkup: () => '<div class="tab-panel comp-tab-panel" id="panel-competitors"><div id="comp-loading"></div><div id="comp-body"></div></div>',
  };
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(WEEKLY, sandbox, { filename: 'f10-weekly.js' });
  vm.runInContext(TIKTOK, sandbox, { filename: 'f10-tiktok.js' });
  vm.runInContext(COMPETITORS, sandbox, { filename: 'f10-competitors.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  vm.runInContext(COMPONENTS, sandbox, { filename: 'f10-components.js' });

  // f10-monthly.js is not loaded here (the canary is about tab switching, not monthly
  // data): neutralise the one symbol base selectTab calls for a monthly tab.
  sandbox.loadMonthlyTab = function () {};

  // Wire the real engines exactly as the dashboard boot does.
  sandbox.wireControls();          // base Meta: binds .nav-link -> selectTab
  await sandbox.window.initTikTok();     // TikTok: binds .tt-nav-link -> ttSelectTab (loads are try/caught)
  await sandbox.window.initCompetitors(); // Competitors: probe -> register + wire
  await sandbox.window.initComponents();  // the NEW module: probe -> register + wire via f10ActivateTab

  return { dom, document, sandbox, nav, content };
}

function activePanels(document) {
  return document.querySelectorAll('.tab-panel').filter((p) => p.classList.contains('active'));
}

async function runCanary() {
  console.log('US-004 Component Scale tab - live-path canary');

  const { document } = await bootLiveDashboard();

  // The new module registered: nav link + panel are live in the DOM.
  await check('the new Component Scale module registered (nav link + panel present)', async () => {
    assert.strictEqual(document.querySelectorAll('.components-nav-link').length, 1, 'exactly one Component Scale nav link');
    assert.strictEqual(document.querySelectorAll('#panel-components').length >= 0, true);
    const panel = document.getElementById('panel-components');
    assert.ok(panel && panel.classList.contains('tab-panel'), 'the panel carries .tab-panel so existing dispatchers clear it');
    // The Competitor tab registered too (its probe returned exists:true).
    assert.strictEqual(document.querySelectorAll('.comp-nav-link').length, 1, 'the pre-existing Competitor tab is present');
  });

  // ENUMERATE THE BASE NAV: every pre-existing tab still switches to exactly one panel.
  const preExisting = [
    { label: 'Weekly (Weekly Summary)', sel: '.nav-link', pick: (els) => els.find((e) => e.dataset.tab === 'summary'), panelId: 'tab-summary' },
    { label: 'Weekly (Movement Board)', sel: '.nav-link', pick: (els) => els.find((e) => e.dataset.tab === 'board'), panelId: 'tab-board' },
    { label: 'Monthly (Ad Production)', sel: '.nav-link', pick: (els) => els.find((e) => e.dataset.tab === 'production'), panelId: 'tab-production' },
    { label: 'Monthly (Creative Effectiveness)', sel: '.nav-link', pick: (els) => els.find((e) => e.dataset.tab === 'creative'), panelId: 'tab-creative' },
    { label: 'Competitors (Competitor Ads)', sel: '.comp-nav-link', pick: (els) => els[0], panelId: 'panel-competitors' },
    { label: 'TikTok (Weekly Summary)', sel: '.tt-nav-link', pick: (els) => els.find((e) => e.dataset.ttTab === 'tt-summary'), panelId: 'panel-tt-summary' },
  ];

  for (const tab of preExisting) {
    await check('pre-existing tab still switches to exactly one visible panel: ' + tab.label, async () => {
      const link = tab.pick(document.querySelectorAll(tab.sel));
      assert.ok(link, 'nav link found for ' + tab.label);
      link.click();
      const active = activePanels(document);
      assert.strictEqual(active.length, 1, 'exactly one panel is visible after activating ' + tab.label);
      assert.strictEqual(active[0].getAttribute('id'), tab.panelId, 'the correct panel (' + tab.panelId + ') is the visible one');
      // And the new module's panel is NOT left visible alongside it.
      const cmp = document.getElementById('panel-components');
      assert.ok(!cmp.classList.contains('active'), 'the Component Scale panel is not stuck visible');
    });
  }

  // The NEW tab itself activates to exactly one panel via the single generic dispatcher,
  // clearing every other nav link + panel.
  await check('the new Component Scale tab activates to exactly one panel and clears all others', async () => {
    const link = document.querySelectorAll('.components-nav-link')[0];
    link.click();
    const active = activePanels(document);
    assert.strictEqual(active.length, 1, 'exactly one panel visible after activating Component Scale');
    assert.strictEqual(active[0].getAttribute('id'), 'panel-components', 'the Component Scale panel is the visible one');
    // Every nav link except the Component Scale one was cleared by the generic dispatcher.
    const activeLinks = document.querySelectorAll('#sidebar nav a').filter((a) => a.classList.contains('active'));
    assert.strictEqual(activeLinks.length, 1, 'exactly one nav link is active');
    assert.ok(activeLinks[0].classList.contains('components-nav-link'), 'the active nav link is Component Scale');
    assert.strictEqual(document.getElementById('page-title').textContent, 'Component Scale', 'page title updated');
  });

  // Switching BACK to a base tab clears the new panel (the reverse direction).
  await check('switching back to a base tab clears the Component Scale panel', async () => {
    const summary = document.querySelectorAll('.nav-link').find((e) => e.dataset.tab === 'summary');
    summary.click();
    const active = activePanels(document);
    assert.strictEqual(active.length, 1, 'exactly one panel visible');
    assert.strictEqual(active[0].getAttribute('id'), 'tab-summary', 'back on the Weekly Summary panel');
    assert.ok(!document.getElementById('panel-components').classList.contains('active'), 'Component Scale panel cleared');
    assert.strictEqual(document.querySelectorAll('.components-nav-link').filter((a) => a.classList.contains('active')).length, 0, 'Component Scale nav link no longer active');
  });
}

(async () => {
  await runUnit();
  await runCanary();
  console.log('\nUS-004 OK - ' + passed + ' checks passed.');
})().catch((e) => { console.error('\nUS-004 FAILED:', (e && e.stack) || e); process.exit(1); });
