/* f10-preview.js — inline creative hover previews.
 *
 * Clients used to click a "View" / "Preview" link to see an ad's creative on
 * Facebook in a new tab. This shows the real image (or an autoplaying muted
 * video) in a small card that follows the cursor when they hover the link, so
 * they never leave the dashboard.
 *
 * The media comes from F10's private creative-asset bucket, resolved on demand
 * through the dashboard's own bq function (`{ action: 'media', adIds: [...] }`),
 * which returns short-lived signed URLs. When an ad has no stored asset (e.g. a
 * video that hasn't been fetched yet) the card shows a small "Opens on Facebook"
 * hint and the existing click-through link still works.
 *
 * Wiring: any `<a class="preview-link" data-ad-id="...">` becomes a hover target.
 * The handler is delegated off #app once (initPreview), so it survives the
 * innerHTML re-renders that tab switches, pagination, and sorting perform.
 */
(function () {
  var cache = new Map(); // ad_id -> {type, url} (resolved) | Promise (in-flight)
  var card = null;
  var currentAdId = null; // ad whose preview is showing / loading
  var lastX = 0,
    lastY = 0;

  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.className = 'f10-preview-card';
    card.style.display = 'none';
    document.body.appendChild(card);
    return card;
  }

  function position() {
    if (!card) return;
    var pad = 18;
    var w = card.offsetWidth || 0;
    var h = card.offsetHeight || 0;
    var left = lastX + pad;
    var top = lastY + pad;
    if (left + w > window.innerWidth - 8) left = lastX - w - pad; // flip to the left
    if (left < 8) left = 8;
    if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    if (top < 8) top = 8;
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function show(html) {
    var c = ensureCard();
    c.innerHTML = html;
    c.style.display = 'block';
    position();
  }

  function showLoading() {
    show('<div class="f10-preview-spinner"></div>');
  }

  function showFallback() {
    show('<div class="f10-preview-msg">Opens on Facebook&nbsp;&#8599;</div>');
  }

  function showMedia(m) {
    if (m.type === 'video') {
      show('<video src="' + m.url + '" muted loop autoplay playsinline></video>');
    } else {
      show('<img src="' + m.url + '" alt="creative preview" />');
    }
    // The media box may resize once it loads; reposition so it stays on-screen.
    var el = card.querySelector('img, video');
    if (el) {
      var reflow = function () {
        position();
      };
      el.addEventListener('load', reflow, { once: true });
      el.addEventListener('loadeddata', reflow, { once: true });
    }
  }

  function hide() {
    currentAdId = null;
    if (card) {
      card.style.display = 'none';
      card.innerHTML = ''; // stop any playing video
    }
  }

  function resolve(adId) {
    if (cache.has(adId)) return Promise.resolve(cache.get(adId));
    var p = fetch(BQ_FUNCTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'media', adIds: [adId] }),
    })
      .then(function (r) {
        return r.ok ? r.json() : {};
      })
      .then(function (j) {
        return (j && j[adId]) || null;
      })
      .catch(function () {
        return null;
      })
      .then(function (res) {
        cache.set(adId, res); // replace the in-flight promise with the value
        return res;
      });
    cache.set(adId, p);
    return p;
  }

  function targetFrom(e) {
    return e.target.closest ? e.target.closest('.preview-link[data-ad-id]') : null;
  }

  function onOver(e) {
    var el = targetFrom(e);
    if (!el) return;
    var adId = el.getAttribute('data-ad-id');
    if (!adId) return;
    lastX = e.clientX;
    lastY = e.clientY;
    currentAdId = adId;
    showLoading();
    resolve(adId).then(function (m) {
      if (currentAdId !== adId) return; // pointer already moved on
      if (m && m.url) showMedia(m);
      else showFallback();
    });
  }

  function onOut(e) {
    var el = targetFrom(e);
    if (!el) return;
    var to = e.relatedTarget;
    if (to && el.contains(to)) return; // still within the link
    hide();
  }

  function onMove(e) {
    lastX = e.clientX;
    lastY = e.clientY;
    if (currentAdId && card && card.style.display !== 'none') position();
  }

  function initPreview() {
    var app = document.getElementById('app') || document.body;
    app.addEventListener('mouseover', onOver);
    app.addEventListener('mouseout', onOut);
    document.addEventListener('mousemove', onMove);
    // Hide if the user scrolls the page out from under the card.
    window.addEventListener('scroll', hide, true);
  }

  window.initPreview = initPreview;
})();
