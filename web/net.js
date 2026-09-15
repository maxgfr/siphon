/**
 * Fetching, under the browser's rules.
 *
 * The one thing a page genuinely cannot do is read a cross-origin response
 * that was not offered to it. Plenty of media hosts *do* offer it — an HLS
 * ladder meant to be played by hls.js on someone else's site has to send
 * `Access-Control-Allow-Origin`, or it would not work at all — and for those
 * this module is a thin wrapper over `fetch` and nothing leaves the browser.
 *
 * For the hosts that do not (YouTube being the one everybody wants), there is
 * an escape: something that fetches on the page's behalf. A relay adds the
 * missing header and forwards nothing else; a siphon server's tunnel carries
 * the bytes of hosts it just resolved; a userscript bridge does it on this very
 * device. This module is careful about the distinction — an escape is never
 * assumed, never contacted unless the direct attempt actually failed, and when
 * there is none the failure says so in a sentence.
 *
 * The verdict per origin is remembered for the session: a 400-segment HLS
 * download should discover the CORS answer once, not eight hundred times.
 */
import { BackendError } from './errors.js';

/** Whether a fetch rejection was the browser refusing, rather than the network. */
const isBlocked = (error) => error instanceof TypeError;

/**
 * @typedef {object} Escape
 * @property {'relay'|'tunnel'} name  what it is, for error messages
 * @property {(url: string) => string} via  the URL that fetches `url` on our behalf
 * @property {Record<string,string>} [headers]  sent along with it (an access key)
 */

/** A relay as an escape: `${base}/?url=…`, the shape relay/worker.js answers. */
export const relayEscape = (base) => {
  const root = String(base || '').trim().replace(/\/+$/, '');
  return root ? { name: 'relay', via: (url) => `${root}/?url=${encodeURIComponent(url)}` } : null;
};

export class Fetcher {
  constructor({ escape = null } = {}) {
    /** @type {Escape|null} */
    this.escape = escape;
    /** @type {Map<string, 'direct'|'bridge'|'relay'>} */
    this.verdicts = new Map();
    this.bridge = installBridge();
  }

  get hasRelay() {
    return Boolean(this.escape);
  }

  /** A userscript on this page that fetches with the manager's privileges — no server anywhere. */
  get hasBridge() {
    return this.bridge.ready;
  }

  /** Whether a host that refuses the page can still be reached somehow. */
  get hasEscape() {
    return this.hasBridge || this.hasRelay;
  }

  /** What the escape's URL looks like for a given target. */
  via(url) {
    return this.escape ? this.escape.via(url) : url;
  }

  #origin(url) {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  /**
   * Fetch, preferring whichever route is known to work for this origin.
   *
   * `prefer: 'relay'` is for hosts we already know refuse the browser, so the
   * first request does not have to be spent proving it.
   */
  async request(url, { prefer = 'direct', signal, ...init } = {}) {
    const origin = this.#origin(url);
    const known = this.verdicts.get(origin);
    // A host known to refuse the page goes straight to whatever gets past it.
    // The bridge is preferred over the relay: it is on this device and involves
    // no server of anyone's.
    const escape = this.hasBridge ? 'bridge' : this.hasRelay ? 'relay' : null;
    const route = known || (prefer === 'relay' && escape ? escape : 'direct');

    if (route === 'bridge') return this.bridge.request(url, { signal, ...init });
    if (route === 'relay') return this.#relayRequest(url, { signal, ...init });

    try {
      const response = await fetch(url, { ...init, signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      this.verdicts.set(origin, 'direct');
      return response;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isBlocked(error)) throw error;
      if (!escape) throw corsWall(origin);
      const response = escape === 'bridge'
        ? await this.bridge.request(url, { signal, ...init })
        : await this.#relayRequest(url, { signal, ...init });
      this.verdicts.set(origin, escape);
      return response;
    }
  }

  async #relayRequest(url, init) {
    if (!this.escape) throw corsWall(this.#origin(url));
    const what = this.escape.name === 'tunnel' ? 'the server' : 'the relay';
    let response;
    try {
      const headers = { ...(init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers || {}), ...(this.escape.headers || {}) };
      response = await fetch(this.escape.via(url), { ...init, headers, credentials: 'omit' });
    } catch {
      throw new BackendError(`Could not reach ${what}.`, {
        hint: 'Check the address in settings, and that it is running.',
      });
    }
    if (response.status === 403) {
      throw new BackendError(`${what[0].toUpperCase()}${what.slice(1)} refused to fetch that address.`, {
        hint:
          this.escape.name === 'tunnel'
            ? 'The server only carries hosts it resolved itself.'
            : 'Relays carry an allow-list of hosts. Add this one to ALLOWED_HOSTS, or use your own server.',
        retryable: false,
      });
    }
    return response;
  }

  async text(url, options = {}) {
    const response = await this.request(url, options);
    if (!response.ok) throw httpError(response, url);
    return response.text();
  }

  async json(url, options = {}) {
    const response = await this.request(url, options);
    if (!response.ok) throw httpError(response, url);
    return response.json();
  }

  /** A HEAD that falls back to a one-byte GET, since plenty of CDNs refuse HEAD. */
  async peek(url, options = {}) {
    let response;
    try {
      response = await this.request(url, { ...options, method: 'HEAD' });
      if (response.ok) return headersOf(response);
    } catch (error) {
      if (error instanceof BackendError && !error.retryable) throw error;
      if (options.signal?.aborted) throw error;
    }
    response = await this.request(url, { ...options, headers: { ...(options.headers || {}), Range: 'bytes=0-0' } });
    if (!response.ok && response.status !== 206) throw httpError(response, url);
    // Drain, or the connection stays open for the life of the page.
    await response.arrayBuffer().catch(() => {});
    return headersOf(response);
  }

  /**
   * Download a whole resource, reporting bytes as they land.
   *
   * Read through the stream rather than awaiting `arrayBuffer()`: the point of
   * the browser mode is a progress bar that means something, and `arrayBuffer`
   * gives one number at the end.
   */
  async bytes(url, { onProgress, signal, range, prefer } = {}) {
    const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined;
    const response = await this.request(url, { signal, headers, prefer });
    if (!response.ok && response.status !== 206) throw httpError(response, url);

    const stated = Number(response.headers.get('content-length')) || 0;
    if (!response.body) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      onProgress?.(buffer.length, buffer.length);
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, stated);
    }

    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/* ------------------------------------------------------------------- bridge */

/**
 * The bridge: a userscript on this page that fetches on the page's behalf.
 *
 * A userscript manager (Tampermonkey, Violentmonkey, …) is itself a browser
 * extension with host permissions, and it lends them to scripts through
 * GM_xmlhttpRequest. A script matched to this page can therefore fetch any
 * URL with no cross-origin restriction at all — which is the one thing the
 * page cannot do, and the whole reason the relay exists. With the bridge
 * installed there is no server anywhere: not ours, not a Worker, not an
 * instance. bridge/siphon-bridge.user.js is the other half of this protocol.
 *
 * Nothing here trusts the bridge with anything: it is handed a URL and
 * returns bytes, and the page still decides what to fetch. Messages are
 * matched on `event.source === window` and a tag, so another frame cannot
 * inject responses.
 */
function installBridge() {
  const pending = new Map();
  let nextId = 1;
  const state = { ready: false, version: null, request: null };

  if (typeof window === 'undefined') return state;

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.siphon === undefined) return;
    const message = event.data;
    if (message.siphon === 'ready') {
      state.ready = true;
      state.version = message.version || null;
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    if (message.siphon === 'response') {
      pending.delete(message.id);
      waiting.resolve(
        new Response(message.body, {
          status: message.status,
          statusText: message.statusText || '',
          headers: message.headers || {},
        }),
      );
    } else if (message.siphon === 'error') {
      pending.delete(message.id);
      waiting.reject(new BackendError(`The bridge could not fetch that: ${message.message || 'unknown error'}`));
    }
  });

  state.request = async (url, { signal, method = 'GET', headers = {}, body } = {}) => {
    const id = nextId++;
    const payload = body instanceof ArrayBuffer ? body : body ? await new Response(body).arrayBuffer() : null;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      signal?.addEventListener('abort', () => {
        pending.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      });
      const plainHeaders = headers instanceof Headers ? Object.fromEntries(headers) : { ...headers };
      window.postMessage({ siphon: 'fetch', id, url, method, headers: plainHeaders, body: payload }, '*', payload ? [payload] : []);
    });
  };

  // Ask whether a bridge is listening. A script installed after this page
  // loaded announces itself unprompted, so a late install is picked up too.
  window.postMessage({ siphon: 'hello' }, '*');
  return state;
}

function headersOf(response) {
  return {
    status: response.status,
    type: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
    // A 206 reports the range's own length in content-length; the total is in
    // content-range, which is the number worth showing.
    length:
      Number(String(response.headers.get('content-range') || '').split('/')[1]) ||
      Number(response.headers.get('content-length')) ||
      null,
    filename: filenameFrom(response.headers.get('content-disposition')),
    acceptsRanges: (response.headers.get('accept-ranges') || '').includes('bytes'),
  };
}

function filenameFrom(disposition) {
  if (!disposition) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* malformed — fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : null;
}

function httpError(response, url) {
  return new BackendError(`${hostOf(url)} answered ${response.status}.`, {
    retryable: response.status >= 500 || response.status === 429,
  });
}

function corsWall(origin) {
  return new BackendError(`${hostOf(origin)} does not let a web page read its files.`, {
    hint:
      'That host sends no cross-origin headers, so the browser refuses on its own. ' +
      'Give it a helper in settings — a server or a relay — or install the bridge.',
    retryable: false,
  });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'That host';
  }
}
