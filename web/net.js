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
/**
 * A relay address is either a base — ours answer `base/?url=<encoded>` — or
 * a template with `{url}` (encoded) or `{raw}` (as is) where the target goes,
 * which is how a public CORS proxy of any shape fits the same slot.
 */
export const isRelayTemplate = (address) => /\{(url|raw)\}/.test(String(address || ''));
export const relayTarget = (address, url) => {
  const relay = String(address || '').trim();
  if (isRelayTemplate(relay)) return relay.replace('{url}', encodeURIComponent(url)).replace('{raw}', url);
  return `${relay.replace(/\/+$/, '')}/?url=${encodeURIComponent(url)}`;
};
export const relayEscape = (base) => {
  const root = String(base || '').trim();
  return root ? { name: 'relay', via: (url) => relayTarget(root, url) } : null;
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

  /**
   * Whether *any* host can be reached past the page's rules.
   *
   * The bridge and a relay fetch whatever they are handed. A server's
   * tunnel does not: it carries only the hosts that server just resolved,
   * so a request it was not told about — YouTube's own API, say — is
   * refused, and asking it is a wasted round trip and a misleading error.
   */
  get hasOpenEscape() {
    return this.hasBridge || this.escape?.name === 'relay';
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
      // A browser gives the same TypeError for "not allowed" and for "no
      // network", so which one this is depends on what the host has already
      // shown. One that answered this page before has proved it allows it: the
      // failure is the connection, and saying otherwise would stop a resume
      // on a phone changing cells with a sentence about CORS.
      if (!escape) throw known === 'direct' ? connectionLost(origin) : corsWall(origin);
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

  /**
   * A document, and the address the links inside it are relative to.
   *
   * A playlist or a page that was redirected is relative to where it landed,
   * not to what was asked for: a short link to `/cdn/path/master.m3u8` names
   * `v360.m3u8` meaning `/cdn/path/v360.m3u8`. Only a direct fetch can say
   * where it landed. Through the bridge or a relay the address it reports is
   * the escape's, not the host's, so there the one asked for is the best
   * there is.
   */
  async document(url, options = {}) {
    const response = await this.request(url, options);
    if (!response.ok) throw httpError(response, url);
    const direct = this.verdicts.get(this.#origin(url)) === 'direct';
    return { text: await response.text(), url: direct && response.redirected && response.url ? response.url : url };
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
   * Read a whole resource, handing over each chunk as it lands.
   *
   * Two things this does that a plain `fetch().arrayBuffer()` does not.
   *
   * It **resumes**. A connection that dies at 80% used to mean starting again
   * from zero, which on a phone changing cells is the difference between a
   * download that finishes and one that never does. Every host that serves
   * media supports byte ranges, so a cut stream is picked up with
   * `Range: bytes=<what we have>-` and the rest appended. A host that ignores
   * the range and sends the whole file again is handled too: what was held is
   * thrown away and the caller told to start over.
   *
   * And it **never has to hold the file**. The caller decides what a chunk
   * means — pile them up in memory, or write them straight to disk — which is
   * what lets a two-hour video land in OPFS without ever being in the heap.
   *
   * @returns {Promise<number>} how many bytes were handed over
   */
  async stream(url, { onChunk, onReset, onProgress, signal, range, prefer, attempts = 4 } = {}) {
    let received = 0;
    // For a ranged read the span is the total; for a whole file the host says.
    let stated = range ? range.length : 0;

    for (let attempt = 1; ; attempt += 1) {
      const resuming = received > 0;
      const from = (range?.offset ?? 0) + received;
      const to = range ? range.offset + range.length - 1 : '';
      const headers = range || resuming ? { Range: `bytes=${from}-${to}` } : undefined;

      try {
        const response = await this.request(url, { signal, headers, prefer });
        if (!response.ok && response.status !== 206) throw httpError(response, url);

        // Asked to carry on, handed the whole file instead: this host does not
        // do ranges, so everything held so far is worthless.
        if (resuming && response.status !== 206) {
          received = 0;
          await onReset?.();
        }
        if (!range && received === 0) stated = totalOf(response) || stated;

        if (!response.body) {
          const whole = new Uint8Array(await response.arrayBuffer());
          await onChunk(whole);
          received += whole.length;
          onProgress?.(received, stated || received);
          return received;
        }

        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await onChunk(value);
          received += value.length;
          onProgress?.(received, stated);
        }

        // A stream that stops short is a cut connection, not a short file —
        // and it arrives as a clean end-of-stream, so without this check a
        // truncated download would be handed over as if it were complete.
        if (stated && received < stated) {
          throw new Error(`the connection closed after ${received} of ${stated} bytes`);
        }
        return received;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A refusal is not worth repeating; only a broken pipe is.
        if (error instanceof BackendError && error.retryable === false) throw error;
        if (attempt >= attempts) throw cutShort(url, error, received, stated);
        await pause(Math.min(400 * 2 ** (attempt - 1), 4000), signal);
      }
    }
  }

  /**
   * The same, collected into one array.
   *
   * For everything small enough to hold: HLS segments, cover art, a playlist.
   * A whole video that needs no conversion should use `stream` and write it
   * to disk instead.
   */
  async bytes(url, options = {}) {
    const parts = [];
    let total = 0;
    await this.stream(url, {
      ...options,
      onChunk: (chunk) => {
        parts.push(chunk);
        total += chunk.length;
      },
      onReset: () => {
        parts.length = 0;
        total = 0;
      },
    });

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of parts) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/* ------------------------------------------------------------------- bridge */

/** Statuses whose response carries no body, by definition. */
const NULL_BODY = new Set([204, 205, 304]);

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
      // A Response refuses a body alongside 204, 205 or 304, and any status
      // outside 200–599 at all (a manager reports 0 for some failures). The
      // constructor throwing here, inside a message listener, would leave the
      // request waiting forever — so a bodiless status gets no body, and
      // anything else it will not take is a failure the caller hears about.
      try {
        waiting.resolve(
          new Response(NULL_BODY.has(message.status) ? null : message.body, {
            status: message.status,
            statusText: message.statusText || '',
            headers: message.headers || {},
          }),
        );
      } catch {
        waiting.reject(new BackendError(`The bridge could not fetch that: it answered with status ${message.status}.`));
      }
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

/** How big the thing being read is, whichever header says so. */
function totalOf(response) {
  const range = String(response.headers.get('content-range') || '').split('/')[1];
  return Number(range) || Number(response.headers.get('content-length')) || 0;
}

/** A sleep that gives up when the download does. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/** Retries are spent and the file is still incomplete. Say how far it got. */
function cutShort(url, error, received, stated) {
  const far = stated ? ` after ${Math.round((received / stated) * 100)}%` : '';
  return new BackendError(`The download from ${hostOf(url)} kept breaking${far}.`, {
    hint: `Last attempt: ${error?.message || error}. Try again — a download resumes rather than starting over.`,
  });
}

function httpError(response, url) {
  return new BackendError(`${hostOf(url)} answered ${response.status}.`, {
    retryable: response.status >= 500 || response.status === 429,
  });
}

/** The network went, mid-conversation with a host that had been answering. Worth another try. */
function connectionLost(origin) {
  return new BackendError(`Lost the connection to ${hostOf(origin)}.`, {
    hint: 'The network dropped part-way. Try again — a download resumes rather than starting over.',
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
