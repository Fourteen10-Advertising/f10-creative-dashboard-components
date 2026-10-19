/**
 * Functional in-memory DOM for tab-switching canaries (no jsdom dependency).
 *
 * Same model as the one inlined in test/us-components-scale.test.js, plus what the
 * delegated nav dispatcher needs: click events BUBBLE up the parent chain (so a
 * listener on `#sidebar nav` sees a click on one of its links), `closest()` for tag /
 * class selectors, and compound class selectors such as `.tab-panel.active`.
 *
 * Not a test file itself (CI runs test/*.test.js only); required by tests.
 */
'use strict';

function makeLiveDom() {
  const byId = {};
  const all = [];
  const VOID = { br: 1, img: 1, input: 1, hr: 1, meta: 1, link: 1 };

  function El(tag) {
    const self = {
      tagName: String(tag).toUpperCase(),
      _id: '', _classes: new Set(), dataset: {}, style: {},
      children: [], parent: null, _listeners: {}, _text: '', _html: '', value: '',
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
    self.dispatch = function (type) {
      const evt = { type, target: self, preventDefault() {}, stopPropagation() { evt._stop = true; } };
      let node = self;
      while (node && !evt._stop) {
        (node._listeners[type] || []).forEach((fn) => fn.call(node, evt));
        node = node.parent;
      }
    };
    self.click = function () { self.dispatch('click'); };
    self.closest = function (sel) {
      let node = self;
      while (node) { if (matchesSimple(node, sel)) return node; node = node.parent; }
      return null;
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
      // Panels are parsed shallowly; also materialise any id'd descendants so
      // getElementById finds the inner elements a module writes into.
      materialiseIds(el);
      rest = after;
    }
  }

  function materialiseIds(el) {
    const re = /<([a-zA-Z][\w-]*)\s[^>]*\bid="([^"]+)"[^>]*>/g;
    let m;
    while ((m = re.exec(el.innerHTML))) {
      if (byId[m[2]]) continue;
      const child = El(m[1]);
      const cls = /\bclass="([^"]*)"/.exec(m[0]);
      if (cls) child.className = cls[1];
      child.id = m[2];
      el.appendChild(child);
    }
  }

  function isDescendant(el, ancestor) {
    let p = el.parent;
    while (p) { if (p === ancestor) return true; p = p.parent; }
    return false;
  }

  function matchesSimple(el, part) {
    part = part.trim();
    if (part.charAt(0) === '.') return part.slice(1).split('.').every((c) => el._classes.has(c));
    if (/^[a-zA-Z][\w-]*$/.test(part)) return el.tagName === part.toUpperCase();
    return false;
  }

  function matchOne(part, root) {
    part = part.trim();
    if (part === '#sidebar nav a') {
      const nav = document.querySelector('#sidebar nav');
      if (!nav) return [];
      return all.filter((e) => e.tagName === 'A' && isDescendant(e, nav));
    }
    if (part.charAt(0) === '.' || /^[a-zA-Z][\w-]*$/.test(part)) {
      return all.filter((e) => matchesSimple(e, part) && (!root || isDescendant(e, root)));
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
    addEventListener() {},
  };
  return { document, El, byId, all };
}

module.exports = { makeLiveDom };
