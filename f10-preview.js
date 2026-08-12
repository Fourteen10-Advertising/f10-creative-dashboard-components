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
 * Carousels: the media response carries a `cards` array of every stored frame
 * (card 0 is the same representative asset the single preview always used). When
 * an ad has more than one card the hover box becomes a swipeable carousel — it
 * pins in place, turns on pointer events, and shows prev/next arrows plus a dot
 * per card. Single-card ads keep the original cursor-following, click-through
 * card untouched.
 *
 * Wiring: any `<a class="preview-link" data-ad-id="...">` becomes a hover target.
 * The handler is delegated off #app once (initPreview), so it survives the
 * innerHTML re-renders that tab switches, pagination, and sorting perform.
 */
(function () {
  var cache = new Map(); // ad_id -> {type, url, cards} (resolved) | Promise (in-flight)
  var card = null;
  var currentAdId = null; // ad whose preview is showing / loading
  var lastX = 0,
    lastY = 0;
  // Carousel state. A multi-card ad pins the card in place and turns on pointer
  // events so the arrows/dots are clickable; single-card previews keep the old
  // cursor-following, click-through-transparent behaviour.
  var carousel = null; // { cards: [{type,url}], idx } while a carousel is showing
  var pinned = false; // true = stop following the cursor (carousel is interactive)
  var overCard = false; // pointer is currently over the (interactive) card
  var hideTimer = null; // deferred hide, so the gap between link and card is forgiving

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide(delay) {
    clearHideTimer();
    hideTimer = setTimeout(function () {
      hideTimer = null;
      if (!overCard) hide();
    }, delay);
  }

  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.className = 'f10-preview-card';
    card.style.display = 'none';
    // Keep an interactive carousel open while the pointer is over it, and drive
    // the arrows/dots. These only ever fire when the card has pointer-events
    // (the is-carousel class); single previews stay transparent to the mouse.
    card.addEventListener('mouseenter', function () {
      overCard = true;
      clearHideTimer();
    });
    card.addEventListener('mouseleave', function () {
      overCard = false;
      // Grace period, not an immediate hide: if a card swap briefly flickers the
      // pointer off the box, the following mouseenter cancels this before it fires.
      scheduleHide(120);
    });
    card.addEventListener('click', onCardClick);
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

  // Format a 0..1 sub-score to a stable 2-decimal string, so the hover shows the
  // same numbers the score math (creativeScoreParts) produced.
  function subVal(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }

  // Creative Score breakdown (US-003). The headline is the SQL creative_score the
  // table badge shows, carried verbatim in the registry and never recomputed
  // here, so the hover headline always equals the table score for the same ad.
  // Under it sit the four component sub-scores (efficiency, creative quality,
  // durability, and the confidence multiplier applied), each with a plain-English
  // line saying what it means, so the score reads as a story instead of a black
  // box. A component that does not apply (creative quality for a static image,
  // durability with no run length) states its neutral 0.5 contribution rather
  // than hiding, so the maths still adds up on screen.
  function scoreBreakdownHtml(s) {
    if (!s || s.value == null) return '';
    function comp(label, valueHtml, note) {
      return '<div class="f10-pm-row"><span>' + label + '</span><b>' + valueHtml + '</b></div>' +
        '<div class="f10-pm-note">' + note + '</div>';
    }
    var band = (s.band && s.band.label) ? s.band.label : '';
    var head = '<div class="f10-pm-score-head"><span>Creative Score</span><b>' + s.value +
      (band ? ' <i class="f10-pm-band">' + band + '</i>' : '') + '</b></div>';
    var efficiency = comp('Efficiency', subVal(s.efficiency),
      'how well spend turns into results against the target band');
    var quality = s.hasVideo
      ? comp('Creative quality', subVal(s.quality),
          'hook, hold and completion attention the video is earning')
      : comp('Creative quality', 'neutral 0.5',
          'no video to score, so this stays neutral and does not drag the score down');
    var durability = s.activeKnown
      ? comp('Durability', subVal(s.durability),
          'how long the ad has run against the maturity target')
      : comp('Durability', 'neutral 0.5',
          'run length not available, so this stays neutral');
    var confNote = (Number(s.confidence) >= 1)
      ? 'enough spend behind it to trust the score in full'
      : 'spend is still thin, so the score is pulled toward neutral';
    var confidence = comp('Confidence applied', subVal(s.confidence) + 'x', confNote);
    return '<div class="f10-preview-score">' + head + efficiency + quality + durability + confidence + '</div>';
  }

  // Per-ad creative metrics panel, read from the registry that table renderers
  // populate (window.F10_AD_METRICS). Leads with the Creative Score breakdown when
  // the ad carries a score, then the raw attention rates. Empty string when an ad
  // has no metrics at all.
  function metricsHtml(adId) {
    var reg = window.F10_AD_METRICS || {};
    var m = reg[adId];
    if (!m) return '';
    function row(label, v) {
      var val = (v == null) ? '\u2013' : (Math.round(v * 100) / 100) + '%';
      return '<div class="f10-pm-row"><span>' + label + '</span><b>' + val + '</b></div>';
    }
    var curve = '';
    if (m.hasVideo && typeof retentionSparkline === 'function') {
      curve = '<div class="f10-pm-curve">' + retentionSparkline(m.retention) +
        '<span class="f10-pm-curvelbl">25 &rarr; 100% retention</span></div>';
    }
    var hookRow = (m.hook != null) ? row('Hook rate', m.hook) : '';
    var outRow = (m.outboundCtr != null) ? row('Outbound CTR', m.outboundCtr) : '';
    return '<div class="f10-preview-metrics">' +
      scoreBreakdownHtml(m.score) +
      hookRow + row('Hold rate', m.hold) + row('Completion', m.completion) +
      row('CTR', m.ctr) + outRow + curve + '</div>';
  }
  window.f10MetricsHtml = metricsHtml;

  function showFallback(adId, platform) {
    var where = platform === 'tiktok' ? 'Opens on TikTok' : 'Opens on Facebook';
    show('<div class="f10-preview-msg">' + where + '&nbsp;&#8599;</div>' + metricsHtml(adId));
  }

  // Build the <img>/<video> markup for one resolved media object ({type, url}).
  // Shared so anything rendering framework creatives (this hover card, the
  // competitor tab's inline cards) constructs media the same way instead of
  // duplicating it. opts toggles the attributes each surface needs:
  //   className, controls, muted, loop, autoplay, preload, loading, alt.
  // The hover card wants a muted autoplay loop; inline cards want controls.
  function mediaMarkup(m, opts) {
    m = m || {};
    opts = opts || {};
    function a(k, v) {
      if (v == null || v === false) return '';
      return v === true ? ' ' + k : ' ' + k + '="' + v + '"';
    }
    var head = a('class', opts.className) + a('src', m.url);
    if (m.type === 'video') {
      return '<video' + head + a('controls', opts.controls) + a('muted', opts.muted) +
        a('loop', opts.loop) + a('autoplay', opts.autoplay) + a('preload', opts.preload) +
        ' playsinline></video>';
    }
    return '<img' + head + a('loading', opts.loading) + ' alt="' + (opts.alt || 'creative preview') + '" />';
  }
  window.f10MediaMarkup = mediaMarkup;

  // Normalise a resolved media object into its list of cards. Old responses
  // ({type,url}) and single-asset ads collapse to a one-card list; carousels
  // carry the full `cards` array. Cards without a url are dropped.
  function cardsOf(m) {
    m = m || {};
    var list = Array.isArray(m.cards) && m.cards.length ? m.cards : (m.url ? [m] : []);
    return list.filter(function (c) { return c && c.url; });
  }
  window.f10PreviewCards = cardsOf;

  // Build the swipeable-carousel markup for a multi-card ad: one visible frame,
  // prev/next arrows, and a dot per card with a live counter. Exposed for tests.
  function carouselHtml(cards, idx) {
    var frame = '<div class="f10-carousel-frame">' +
      mediaMarkup(cards[idx], { muted: true, loop: true, autoplay: true }) + '</div>';
    var dots = '';
    for (var i = 0; i < cards.length; i++) {
      dots += '<button type="button" class="f10-carousel-dot' +
        (i === idx ? ' is-active' : '') + '" data-i="' + i + '" aria-label="Card ' +
        (i + 1) + '"></button>';
    }
    return '<div class="f10-carousel">' +
      '<button type="button" class="f10-carousel-nav f10-carousel-prev" aria-label="Previous card">&#8249;</button>' +
      frame +
      '<button type="button" class="f10-carousel-nav f10-carousel-next" aria-label="Next card">&#8250;</button>' +
      '<div class="f10-carousel-dots">' + dots +
      '<span class="f10-carousel-count">' + (idx + 1) + '/' + cards.length + '</span></div>' +
      '</div>';
  }
  window.f10CarouselHtml = carouselHtml;

  // Swap just the visible frame + dot/counter state when the user navigates,
  // so only the active card's video plays.
  function renderFrame() {
    if (!carousel || !card) return;
    var frame = card.querySelector('.f10-carousel-frame');
    if (frame) {
      frame.innerHTML = mediaMarkup(carousel.cards[carousel.idx],
        { muted: true, loop: true, autoplay: true });
    }
    var dots = card.querySelectorAll('.f10-carousel-dot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('is-active', i === carousel.idx);
    }
    var count = card.querySelector('.f10-carousel-count');
    if (count) count.textContent = (carousel.idx + 1) + '/' + carousel.cards.length;
  }

  function onCardClick(e) {
    if (!carousel) return;
    var t = e.target;
    var n = cardsOf({ cards: carousel.cards }).length; // = carousel.cards.length
    if (t.closest('.f10-carousel-next')) {
      carousel.idx = (carousel.idx + 1) % n;
    } else if (t.closest('.f10-carousel-prev')) {
      carousel.idx = (carousel.idx - 1 + n) % n;
    } else {
      var dot = t.closest('.f10-carousel-dot');
      if (!dot) return;
      carousel.idx = parseInt(dot.getAttribute('data-i'), 10) || 0;
    }
    renderFrame();
  }

  function showMedia(m, adId) {
    var cards = cardsOf(m);
    if (cards.length > 1) {
      // Interactive carousel: pin it next to the cursor and let the mouse in.
      carousel = { cards: cards, idx: 0 };
      pinned = true;
      var c = ensureCard();
      c.classList.add('is-carousel');
      show(carouselHtml(cards, 0) + metricsHtml(adId));
      return;
    }
    // Single card (or legacy shape): follow the cursor, transparent to the mouse.
    carousel = null;
    pinned = false;
    if (card) card.classList.remove('is-carousel');
    var media = mediaMarkup(cards[0] || m, { muted: true, loop: true, autoplay: true });
    show(media + metricsHtml(adId));
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
    clearHideTimer();
    currentAdId = null;
    carousel = null;
    pinned = false;
    overCard = false;
    if (card) {
      card.classList.remove('is-carousel');
      card.style.display = 'none';
      card.innerHTML = ''; // stop any playing video
    }
  }

  function resolve(adId, platform) {
    var key = adId + '|' + (platform || 'meta');
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    var p = fetch(BQ_FUNCTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'media', adIds: [adId], platform: platform || 'meta' }),
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
        cache.set(key, res); // replace the in-flight promise with the value
        return res;
      });
    cache.set(key, p);
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
    var platform = el.getAttribute('data-platform') || 'meta';
    // Reset any pinned carousel from the previous link before loading this one.
    clearHideTimer();
    carousel = null;
    pinned = false;
    overCard = false;
    if (card) card.classList.remove('is-carousel');
    lastX = e.clientX;
    lastY = e.clientY;
    currentAdId = adId;
    showLoading();
    resolve(adId, platform).then(function (m) {
      if (currentAdId !== adId) return; // pointer already moved on
      if (m && (m.url || (m.cards && m.cards.length))) showMedia(m, adId);
      else showFallback(adId, platform);
    });
  }

  function onOut(e) {
    var el = targetFrom(e);
    if (!el) return;
    var to = e.relatedTarget;
    if (to && el.contains(to)) return; // still within the link
    if (to && card && card.contains(to)) return; // moving onto the interactive card
    // For a pinned carousel, defer the hide so the small gap between the link and
    // the card doesn't dismiss it before the pointer arrives; the card's
    // mouseenter cancels the timer. Single previews hide immediately as before.
    if (pinned) scheduleHide(160);
    else hide();
  }

  function onMove(e) {
    lastX = e.clientX;
    lastY = e.clientY;
    // A pinned carousel stays put so its arrows/dots are clickable.
    if (pinned || overCard) return;
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
