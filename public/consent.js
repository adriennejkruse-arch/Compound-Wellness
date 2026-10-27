/*
 * Cookie consent + privacy-first tracking for The Compound Wellness.
 *
 *  - Nothing is loaded from Google or Meta until the visitor clicks Accept.
 *  - A browser "Global Privacy Control" signal is treated as Decline (no banner shown).
 *  - Meta's Pixel only ever loads on pages that set window.CW_PIXEL_PAGE = true, for visitors who arrived
 *    from a Meta ad, after consent. It sends PageView and Lead only, with Meta's automatic form/button
 *    collection switched off. Nothing about practitioners, services, or health is sent.
 *  - Ad attribution (campaign names from the ad link) is kept in this browser tab only (sessionStorage)
 *    and is attached to an inquiry so you can see which ad it came from.
 */
(function () {
  'use strict';

  var CONSENT_KEY = 'cw_consent';     // 'granted' | 'denied'
  var AD_KEY = 'cw_ad';
  var GA_ID = 'G-MFCNF2ME2S';
  var META_SOURCES = ['facebook', 'fb', 'instagram', 'ig', 'meta'];

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* ── Ad attribution (first-party, this tab only) ───────────────────────── */
  (function captureAd() {
    try {
      var p = new URLSearchParams(window.location.search);
      var fbclid = p.get('fbclid'), src = p.get('utm_source');
      if (!fbclid && !src) return;
      var clean = function (v) { return v ? String(v).replace(/[^\w .:@+\-]/g, '').slice(0, 80) : ''; };
      var meta = !!fbclid || META_SOURCES.indexOf(String(src || '').toLowerCase()) > -1;
      ssSet(AD_KEY, JSON.stringify({
        meta: meta, fbclid: clean(fbclid), source: clean(src), medium: clean(p.get('utm_medium')),
        campaign: clean(p.get('utm_campaign')), content: clean(p.get('utm_content')), term: clean(p.get('utm_term')),
        landed: window.location.pathname, t: Date.now(),
      }));
    } catch (e) { /* attribution is optional */ }
  })();

  var consentState = null;
  var onGrantedCallbacks = [];

  function gpcOn() { return navigator.globalPrivacyControl === true; }
  function state() {
    var s = lsGet(CONSENT_KEY);
    if (s === 'granted') return 'granted';      // an explicit click on Accept is respected
    if (gpcOn()) return 'denied';               // otherwise a Global Privacy Control signal means no
    return s === 'denied' ? 'denied' : null;
  }

  var ad = {
    get: function () { try { return JSON.parse(ssGet(AD_KEY) || 'null'); } catch (e) { return null; } },
    isMeta: function () { var a = ad.get(); return !!(a && a.meta); },
    newEventId: function () {
      var a = new Uint8Array(12);
      (window.crypto || window.msCrypto).getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    },
    // What gets attached to an inquiry. Meta identifiers are included only after consent.
    payload: function (eventId) {
      var a = ad.get();
      if (!a) return null;
      var granted = state() === 'granted';
      var fbc = null;
      if (granted) fbc = cookie('_fbc') || (a.fbclid ? 'fb.1.' + a.t + '.' + a.fbclid : null);
      return {
        source: a.source, medium: a.medium, campaign: a.campaign, content: a.content, term: a.term, landed: a.landed,
        consent: granted && a.meta, eventId: eventId || ad.newEventId(),
        fbp: granted ? cookie('_fbp') : null, fbc: fbc,
      };
    },
  };
  window.cwAd = ad;

  // Attach the ad context to any inquiry the page sends, so every form gets it without extra code.
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : input && input.url;
        if (url === '/api/submit-inquiry' && init && init.method === 'POST' && typeof init.body === 'string') {
          var body = JSON.parse(init.body);
          if (!body.ad) {
            var a = ad.payload(body.adEventId);
            if (a) { body.ad = a; init = Object.assign({}, init, { body: JSON.stringify(body) }); }
          }
        }
      } catch (e) { /* never block a submission */ }
      return nativeFetch.call(this, input, init);
    };
  }

  /* ── Google Analytics (consent only; no query strings; no ad features) ──── */
  var gaLoaded = false;
  function loadGA() {
    if (gaLoaded) return;
    gaLoaded = true;
    window['ga-disable-' + GA_ID] = false;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, {
      page_location: window.location.origin + window.location.pathname,
      allow_google_signals: false, allow_ad_personalization_signals: false,
    });
  }

  /* ── Meta Pixel (ad visitors on opted-in pages, after consent) ──────────── */
  var metaReady = false, metaStarted = false;
  var cwMeta = window.cwMeta = {
    lead: function (eventId) {
      if (metaReady && window.fbq) window.fbq('track', 'Lead', {}, { eventID: eventId });
    },
  };
  function loadMeta() {
    if (metaStarted || !window.CW_PIXEL_PAGE || !ad.isMeta()) return;
    metaStarted = true;
    fetch('/api/meta-config').then(function (r) { return r.json(); }).then(function (cfg) {
      if (!cfg || !cfg.pixelId || !/^\d{5,20}$/.test(cfg.pixelId)) return;
      /* eslint-disable */
      !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */
      window.fbq('set', 'autoConfig', false, cfg.pixelId);   // no automatic button, form or page-content collection
      window.fbq('init', cfg.pixelId);
      window.fbq('track', 'PageView');
      metaReady = true;
    }).catch(function () { /* tracking is optional */ });
  }

  function grantedActions() {
    loadGA();
    loadMeta();
    onGrantedCallbacks.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
  }

  function deniedActions() {
    window['ga-disable-' + GA_ID] = true;
    ['_ga', '_gid', '_gat', '_fbp', '_fbc'].concat(document.cookie.split('; ').map(function (c) { return c.split('=')[0]; })
      .filter(function (n) { return /^_ga_/.test(n); })).forEach(function (n) {
      document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.' + window.location.hostname.replace(/^www\./, '');
    });
  }

  /* ── Banner ─────────────────────────────────────────────────────────────── */
  var banner = null;
  function buildBanner() {
    var css = document.createElement('style');
    css.textContent =
      '.cwc{position:fixed;left:0;right:0;bottom:0;z-index:1000;background:#FAF7F2;border-top:1px solid rgba(138,94,56,.35);box-shadow:0 -6px 24px rgba(44,36,32,.12);padding:16px 20px;font-family:"DM Sans",system-ui,sans-serif;font-size:14px;line-height:1.6;color:#2C2420}' +
      '.cwc-in{max-width:880px;margin:0 auto;display:flex;gap:18px;align-items:center;flex-wrap:wrap}' +
      '.cwc p{flex:1 1 360px;margin:0}' +
      '.cwc a{color:#8A5E38;text-decoration:underline}' +
      '.cwc-btns{display:flex;gap:10px;flex:0 0 auto}' +
      '.cwc button{font:inherit;font-size:12px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;min-height:44px;min-width:110px;padding:10px 20px;cursor:pointer;background:#fff;color:#8A5E38;border:1px solid #8A5E38}' +
      '.cwc button:hover{background:#F0EAE0}' +
      '.cwc button:focus-visible,.cwc a:focus-visible{outline:2px solid #2C2420;outline-offset:3px}' +
      '@media (prefers-reduced-motion:no-preference){.cwc{animation:cwcUp .25s ease}@keyframes cwcUp{from{transform:translateY(100%)}to{transform:none}}}';
    document.head.appendChild(css);
    banner = document.createElement('div');
    banner.className = 'cwc';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie preferences');
    banner.innerHTML =
      '<div class="cwc-in"><p>We use cookies to understand how our website is used and, if you arrived from one of our ads, to measure that ad. ' +
      'We never send health information to advertisers or analytics tools. You can change your choice at any time. ' +
      '<a href="/privacy">Privacy policy</a></p>' +
      '<div class="cwc-btns"><button type="button" data-cwc="denied">Decline</button><button type="button" data-cwc="granted">Accept</button></div></div>';
    banner.addEventListener('click', function (e) {
      var v = e.target && e.target.getAttribute && e.target.getAttribute('data-cwc');
      if (v) choose(v);
    });
    document.body.insertBefore(banner, document.body.firstChild);   // first in tab order, so keyboard users meet it straight away
  }
  var opener = null;
  function padPage() { document.body.style.paddingBottom = banner && !banner.hidden ? banner.offsetHeight + 'px' : ''; }
  function showBanner(fromUser) {
    if (!banner) buildBanner();
    banner.hidden = false;
    padPage();   // keep the last links on the page from hiding under the banner
    if (fromUser === true) { opener = document.activeElement; var b = banner.querySelector('button'); if (b) b.focus(); }
  }
  window.addEventListener('resize', padPage);
  function choose(v) {
    lsSet(CONSENT_KEY, v);
    consentState = v;
    if (banner) banner.hidden = true;
    padPage();
    if (opener && opener.focus) { opener.focus(); opener = null; }
    if (v === 'granted') grantedActions(); else deniedActions();
  }

  window.cwConsent = {
    state: function () { return state(); },
    open: function () { showBanner(true); },
    onGranted: function (fn) { if (state() === 'granted') fn(); else onGrantedCallbacks.push(fn); },
  };

  function init() {
    consentState = state();
    if (consentState === 'granted') grantedActions();
    else if (consentState === 'denied') deniedActions();
    else showBanner();
    // Any link or button marked data-cw-consent-open reopens the choice
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-cw-consent-open]') : null;
      if (t) { e.preventDefault(); showBanner(true); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
