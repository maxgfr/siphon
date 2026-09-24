// ==UserScript==
// @name         siphon bridge
// @namespace    https://github.com/maxgfr/siphon
// @version      1.2.0
// @description  Lets siphon fetch from hosts that refuse a web page — YouTube included — using your userscript manager's privileges. No server anywhere.
// @author       siphon
// @downloadURL  https://raw.githubusercontent.com/maxgfr/siphon/main/bridge/siphon-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/maxgfr/siphon/main/bridge/siphon-bridge.user.js
// @match        https://maxgfr.github.io/siphon/*
// @match        http://localhost:8000/*
// @match        http://127.0.0.1:8000/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      *
// @run-at       document-start
// @noframes
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
 * It only runs on siphon's own page (see @match), never inside a frame, and it
 * only answers messages from that page's own window. The page decides what to
 * fetch; this script never chooses a URL itself.
 *
 * What it will fetch is narrower than "anything", because @match cannot tell
 * siphon apart from whatever else is served on localhost:8000 — the port
 * `docker run` publishes the self-hosted UI on, and the default of half the
 * development servers there are. So: http and https only, GET, HEAD and POST
 * only, and never a host on this machine or this network — loopback,
 * private, link-local and carrier-grade NAT addresses, `localhost` and
 * `.local` names, and names with no dot, which only a local resolver knows.
 * Media lives on the public internet; a router's admin page does not. A
 * public name that resolves to a private address is the one case a script
 * with no DNS cannot see, which is why the server does this check too.
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

  const METHODS = new Set(['GET', 'HEAD', 'POST']);

  /** An IPv4 address as its four numbers, or null for anything that is not one. */
  const ipv4 = (host) => {
    const parts = host.split('.');
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part)) ? parts.map(Number) : null;
  };

  /** Not the public internet: this machine, this network, or nobody's. */
  const privateV4 = ([a, b]) =>
    a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast and reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, where cloud metadata lives
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);

  /**
   * Whether the page may have this fetched. The URL parser has already
   * turned `http://2130706433/` and `http://0x7f.1/` into `127.0.0.1`, so the
   * dotted form is the only one left to read.
   */
  const allowed = (raw, method) => {
    if (!METHODS.has(String(method).toUpperCase())) return false;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[')) {
      // IPv6: only global unicast (2000::/3) is the public internet. That
      // leaves out loopback, unique-local, link-local, multicast and the
      // IPv4-mapped form of every private address above.
      const first = parseInt(host.slice(1).split(':')[0] || '0', 16);
      return first >= 0x2000 && first <= 0x3fff;
    }
    const v4 = ipv4(host);
    if (v4) return !privateV4(v4);
    return host.includes('.') && !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host);
  };

  const announce = () => window.postMessage({ siphon: 'ready', version: '1.2.0' }, '*');

  /**
   * Requests still running, by the page's id, so the page can call one off.
   * A cancelled download otherwise went on in the manager to the last byte.
   */
  const running = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.siphon === undefined) return;
    const message = event.data;

    if (message.siphon === 'hello') return announce();
    if (message.siphon === 'abort') {
      running.get(message.id)?.abort();
      running.delete(message.id);
      return;
    }
    if (message.siphon !== 'fetch') return;

    const { id, url, method = 'GET', headers = {}, body = null } = message;
    if (!allowed(url, method)) {
      window.postMessage({ siphon: 'error', id, message: 'the bridge only fetches public http(s) addresses, with GET, HEAD or POST' }, '*');
      return;
    }
    let over = false;
    const finish = (reply, transfer) => {
      over = true;
      running.delete(id);
      if (reply) window.postMessage(reply, '*', transfer || []);
    };
    const handle = gm({
      method,
      url,
      headers,
      data: body,
      responseType: 'arraybuffer',
      anonymous: true, // never send the user's cookies for a site to a fetch the page asked for
      onload: (response) => {
        const buffer = response.response instanceof ArrayBuffer ? response.response : new ArrayBuffer(0);
        // finalUrl is where the redirects ended: what a playlist's relative
        // addresses are relative to, and something only the manager saw.
        finish(
          { siphon: 'response', id, status: response.status, statusText: response.statusText, headers: parseHeaders(response.responseHeaders), finalUrl: response.finalUrl || '', body: buffer },
          [buffer],
        );
      },
      onerror: (error) => finish({ siphon: 'error', id, message: error?.error || error?.statusText || 'request failed' }),
      ontimeout: () => finish({ siphon: 'error', id, message: 'timed out' }),
      onabort: () => finish(null),
    });
    // GM_xmlhttpRequest returns an object with abort(); GM.xmlHttpRequest a
    // promise with one, whose rejection the callbacks above already report.
    if (typeof handle?.catch === 'function') handle.catch(() => {});
    if (!over && typeof handle?.abort === 'function') running.set(id, handle);
  });

  // Say hello whether or not the page asked yet: installed after the page
  // loaded, the page's own hello has already gone by.
  announce();
})();
