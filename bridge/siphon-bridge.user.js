// ==UserScript==
// @name         siphon bridge
// @namespace    https://github.com/maxgfr/siphon
// @version      1.0.0
// @description  Lets siphon fetch from hosts that refuse a web page — YouTube included — using your userscript manager's privileges. No server anywhere.
// @author       siphon
// @match        https://maxgfr.github.io/siphon/*
// @match        http://localhost:8000/*
// @match        http://127.0.0.1:8000/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      *
// @run-at       document-start
// ==/UserScript==

/*
 * What this is, in one paragraph.
 *
 * A web page may not read a cross-origin response the host did not offer it.
 * YouTube offers none, and that single rule is why siphon needs a relay or a
 * server for it. A userscript manager is a browser extension with host
 * permissions, and it lends them to scripts through GM_xmlhttpRequest. This
 * script does exactly one thing with that: when the siphon page asks for a
 * URL, it fetches it and hands the bytes back. Every extractor siphon already
 * has — direct files, HLS, pages, YouTube — then works on hosts that refuse,
 * with nothing running anywhere.
 *
 * It only runs on siphon's own page (see @match), so no other site can use it,
 * and it only answers messages from that page's own window. The page decides
 * what to fetch; this script never chooses a URL itself.
 *
 * Add your own siphon address to @match if you host it elsewhere.
 */
(() => {
  'use strict';

  const gm = typeof GM_xmlhttpRequest === 'function'
    ? GM_xmlhttpRequest
    : typeof GM !== 'undefined' && GM.xmlHttpRequest
      ? GM.xmlHttpRequest
      : null;
  if (!gm) return;

  /** GM hands headers back as one string; the page wants an object. */
  const parseHeaders = (raw) => {
    const out = {};
    for (const line of String(raw || '').split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return out;
  };

  const announce = () => window.postMessage({ siphon: 'ready', version: '1.0.0' }, '*');

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.siphon === undefined) return;
    const message = event.data;

    if (message.siphon === 'hello') return announce();
    if (message.siphon !== 'fetch') return;

    const { id, url, method = 'GET', headers = {}, body = null } = message;
    gm({
      method,
      url,
      headers,
      data: body,
      responseType: 'arraybuffer',
      anonymous: true, // never send the user's cookies for a site to a fetch the page asked for
      onload: (response) => {
        const buffer = response.response instanceof ArrayBuffer ? response.response : new ArrayBuffer(0);
        window.postMessage(
          { siphon: 'response', id, status: response.status, statusText: response.statusText, headers: parseHeaders(response.responseHeaders), body: buffer },
          '*',
          [buffer],
        );
      },
      onerror: (error) => window.postMessage({ siphon: 'error', id, message: error?.error || error?.statusText || 'request failed' }, '*'),
      ontimeout: () => window.postMessage({ siphon: 'error', id, message: 'timed out' }, '*'),
    });
  });

  // Say hello whether or not the page asked yet: installed after the page
  // loaded, the page's own hello has already gone by.
  announce();
})();
