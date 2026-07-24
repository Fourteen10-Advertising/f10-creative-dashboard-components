/**
 * US-015 — client co-branding (colours + logo lockup).
 *
 * A dashboard may set an optional BRANDING config. When present it (1) overrides
 * a small set of themeable CSS custom properties on #app and (2) renders a
 * client + F10 logo lockup in the sidebar header. When absent, renderLayout()
 * must produce exactly the F10 look it always has — this test pins that
 * backward-compat guarantee alongside the new behaviour.
 *
 * Dependency-free: loads the real f10-utils.js + f10-layout.js into a vm sandbox
 * (mirrors us-013) and calls renderLayout().
 *
 * Run: node test/us-015-cobranding.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const UTILS = fs.readFileSync(path.join(ROOT, 'f10-utils.js'), 'utf8');
const LAYOUT = fs.readFileSync(path.join(ROOT, 'f10-layout.js'), 'utf8');

function makeApp() {
  return {
    id: 'app', innerHTML: '', style: { cssText: '' },
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {},
  };
}

/* Boot layout with a given BRANDING config (or none) and return the rendered
 * sidebar HTML plus the inline style (theme vars) applied to #app. */
function bootWith(brandingConfig) {
  const app = makeApp();
  // Theme vars must land on the document root (:root) so both CSS cascade and the
  // chart code's getComputedStyle(document.documentElement) pick them up.
  const root = { style: { cssText: '' } };
  const document = {
    documentElement: root,
    getElementById() { return app; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const window = {};
  const sandbox = {
    window, document, console,
    CLIENT_NAME: 'Acme',
  };
  if (brandingConfig !== undefined) sandbox.BRANDING = brandingConfig;
  vm.createContext(sandbox);
  vm.runInContext(UTILS, sandbox, { filename: 'f10-utils.js' });
  vm.runInContext(LAYOUT, sandbox, { filename: 'f10-layout.js' });
  sandbox.renderLayout();
  return { html: app.innerHTML, style: root.style.cssText };
}

const STAKE_LOGO = '<svg viewBox="0 0 48 54"><path d="M1 2Z" fill="currentColor"/></svg>';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

(() => {
  console.log('US-015 client co-branding');

  // ── Backward-compat: no BRANDING renders the classic F10 sidebar, no lockup, no theme vars. ──
  check('no BRANDING: no lockup, default F10 footer, no theme vars injected', () => {
    const { html, style } = bootWith(undefined);
    assert.ok(!/sidebar-lockup/.test(html), 'lockup must be absent');
    assert.ok(/F10 \| Creative Reporting/.test(html), 'default F10 footer present');
    assert.ok(/class="client-name">Acme</.test(html), 'client-name still renders');
    assert.strictEqual(style, '', 'no inline theme vars on the document root');
  });

  // ── Colour overrides map to CSS custom properties on #app; only supplied keys emit. ──
  check('colour keys inject the matching CSS vars (and nothing else)', () => {
    const { style } = bootWith({
      sidebarBg: '#141414', brand: '#141414', sidebarAccent: '#ffffff',
      onBrand: '#ffffff', navActiveBg: 'rgba(255,255,255,0.08)',
    });
    assert.ok(/--sidebar-bg:#141414/.test(style), '--sidebar-bg set');
    assert.ok(/--young-blood:#141414/.test(style), 'brand -> --young-blood set');
    assert.ok(/--sidebar-accent:#ffffff/.test(style), '--sidebar-accent set');
    assert.ok(/--on-brand:#ffffff/.test(style), '--on-brand set');
    assert.ok(/--nav-active-bg:rgba\(255,255,255,0\.08\)/.test(style), '--nav-active-bg set');
    assert.ok(!/--accent-soft/.test(style), 'unspecified --accent-soft must NOT be emitted');
    assert.ok(!/--stabilo/.test(style), 'unspecified accent must NOT be emitted');
  });

  // ── clientLogo renders the co-brand lockup: client mark | divider | F10 mark. ──
  check('clientLogo renders lockup with client mark, divider and F10 mark', () => {
    const { html } = bootWith({ clientLogo: STAKE_LOGO, sidebarBg: '#141414' });
    assert.ok(/sidebar-lockup/.test(html), 'lockup container present');
    assert.ok(/class="client-mark">/.test(html), 'client-mark slot present');
    assert.ok(/lockup-divider/.test(html), 'divider present');
    assert.ok(/class="f10-mark">/.test(html), 'f10-mark slot present');
    assert.ok(html.includes(STAKE_LOGO), 'client SVG inlined verbatim');
    assert.ok(/f10-mark"><svg/.test(html), 'F10 mark SVG rendered in its slot');
    // The bundled F10 mark tints via currentColor (no baked-in brand fill).
    assert.ok(!/#C8FF00/i.test(html), 'F10 mark must not carry a hard-coded lime fill');
  });

  // ── footer override replaces the default line. ──
  check('footer override replaces the default footer', () => {
    const { html } = bootWith({ footer: 'Acme &times; F10 | Creative Reporting' });
    assert.ok(/Acme &times; F10 \| Creative Reporting/.test(html), 'custom footer present');
  });

  console.log(`\nUS-015 OK — ${passed} checks passed`);
})();
