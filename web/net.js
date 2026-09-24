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
    // A 403 may be the relay refusing, or the host refusing and the relay
    // passing it on — googlevideo turning away a link bound to another
    // address looks exactly like a host off the allow-list — and a 502 the
    // host's, or the relay failing to reach it. Ours mark the answers they
    // make themselves. Anything unmarked is the host's, and the caller says
    // so, as it does for a public CORS proxy, which marks nothing.
    const reason = response.headers.get(RELAY_ERROR_HEADER);
    if (reason === null) return response;
    const subject = `${what[0].toUpperCase()}${what.slice(1)}`;
    if (response.status >= 500) {
      throw new BackendError(`${subject} could not reach ${hostOf(url)}.`, {
        hint: `It said: ${reason}. Try again — a download resumes rather than starting over.`,
      });
    }
    throw new BackendError(`${subject} refused to fetch that address.`, {
      hint:
        this.escape.name === 'tunnel'
          ? 'The server only carries hosts it resolved itself.'
          : /origin not allowed/i.test(reason)
            ? `It does not take requests from this page. Add ${pageOrigin()} to its ALLOWED_ORIGINS.`
            : /host not allowed/i.test(reason)
              ? 'Relays carry an allow-list of hosts. Add this one to ALLOWED_HOSTS, or use your own server.'
              : `It said: ${reason}.`,
      retryable: false,
    });
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
   * `v360.m3u8` meaning `/cdn/path/v360.m3u8`. A direct fetch says where it
   * landed itself. Through the bridge or a relay the address the response
   * carries is the escape's, not the host's; the escape followed the
   * redirects, so it says where they went in a header of its own. One that
   * does not — a public CORS proxy, an older bridge — leaves the one asked
   * for, the best there is.
   */
  async document(url, options = {}) {
    const response = await this.request(url, options);
    if (!response.ok) throw httpError(response, url);
    const direct = this.verdicts.get(this.#origin(url)) === 'direct';
    const landed = direct ? (response.redirected && response.url) || url : reportedUrl(response) || url;
    return { text: await response.text(), url: landed };
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
    // Let go of the body, or the connection stays open for the life of the
    // page. Cancelled rather than drained: a host that ignored the range is
    // sending the whole file, and reading it here would pull all of it into
    // the tab just to learn its headers.
    await response.body?.cancel().catch(() => {});
    return headersOf(response);
  }

  /**
   * The first bytes of a resource, to tell what it is when its headers do not.
   *
   * Asked for as a range, and read no further than that even from a host that
   * ignores the range and starts on the whole file: the rest is cancelled, not
   * drained. Through the bridge the body arrives whole, and is cut here.
   */
  async prefix(url, { length = 512, signal } = {}) {
    const response = await this.request(url, { signal, headers: { Range: `bytes=0-${length - 1}` } });
    if (!response.ok && response.status !== 206) throw httpError(response, url);
    if (!response.body) return new Uint8Array(await response.arrayBuffer()).slice(0, length);
    const out = new Uint8Array(length);
    let filled = 0;
    const reader = response.body.getReader();
    try {
      while (filled < length) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = value.subarray(0, length - filled);
        out.set(take, filled);
        filled += take.length;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return out.subarray(0, filled);
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

/**
 * Where an escape says a request ended up after the redirects it followed
 * itself. The bridge's answers carry it, and a relay can send it: ours follows
 * redirects by hand, so it knows the last hop.
 */
export const FINAL_URL_HEADER = 'X-Siphon-Final-URL';

/**
 * On an answer our relay or a siphon server's tunnel made itself — a refusal,
 * or a host it could not reach — rather than one it carried from the host.
 * It holds the reason, and is never passed through from upstream.
 */
export const RELAY_ERROR_HEADER = 'X-Relay-Error';

/** This page's origin, as an ALLOWED_ORIGINS entry would name it. */
export const pageOrigin = () => (typeof location !== 'undefined' && location.origin !== 'null' ? location.origin : "this page's address");

function reportedUrl(response) {
  try {
    const url = new URL(response.headers.get(FINAL_URL_HEADER) || '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- bridge */

/** Statuses whose response carries no body, by definition. */
const NULL_BODY = new Set([204, 205, 304]);

/**
 * How much of a file one request through the bridge asks for.
 *
 * A userscript manager hands a response over only once all of it is in, so
 * a file asked for in one request arrived in one piece: the bar at 0% until
 * the end, the whole file in memory twice (the manager's, then the page's),
 * a cancel that stopped nothing, and a cut at 90% with nothing handed over
 * to resume from. Asked for a window at a time instead, each window is a
 * step of progress and a chunk written to disk, a cancel calls off the one
 * in flight, and a cut costs one window. The first is small, so a short file
 * shows progress at all and an HLS segment usually fits in it; after that
 * they double, since each one is a round trip.
 */
const FIRST_WINDOW = 2 * 1024 * 1024;
const LAST_WINDOW = 8 * 1024 * 1024;

/** `bytes 0-1023/4096`, as numbers; the total is null when the host says `*`. */
function contentRange(response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(String(response.headers.get('content-range') || '').trim());
  return match ? { from: Number(match[1]), to: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) } : null;
}

/**
 * What part of a resource a request wants, when that is worth splitting:
 * a GET for all of it, or for a range that runs to the end or past a window.
 * Anything else — HEAD, POST, the few bytes a peek wants, a suffix range —
 * goes as it is.
 */
function spanOf(method, headers) {
  if (String(method).toUpperCase() !== 'GET') return null;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'range');
  if (!key) return { from: 0, to: null, ranged: false };
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(headers[key]).trim());
  if (!match) return null;
  const span = { from: Number(match[1]), to: match[2] ? Number(match[2]) : null, ranged: true };
  return span.to === null || span.to - span.from + 1 > FIRST_WINDOW ? span : null;
}

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
  const aborted = () => new DOMException('Aborted', 'AbortError');

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
      // Where the manager's request landed, which only it saw. Set from the
      // message alone: a host's own header of that name is not a report.
      const headers = { ...(message.headers || {}) };
      delete headers[FINAL_URL_HEADER.toLowerCase()];
      if (message.finalUrl) headers[FINAL_URL_HEADER.toLowerCase()] = String(message.finalUrl);
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
            headers,
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

  /** One request, answered whole when the manager has all of it. */
  const once = async (url, { signal, method = 'GET', headers = {}, body } = {}) => {
    const id = nextId++;
    const payload = body instanceof ArrayBuffer ? body : body ? await new Response(body).arrayBuffer() : null;
    if (signal?.aborted) throw aborted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        // Without this the manager carries on downloading for nobody.
        window.postMessage({ siphon: 'abort', id }, '*');
        reject(aborted());
      };
      const settle = (then) => (value) => {
        signal?.removeEventListener('abort', abort);
        then(value);
      };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      window.postMessage({ siphon: 'fetch', id, url, method, headers, body: payload }, '*', payload ? [payload] : []);
    });
  };

  /**
   * A GET for a span of a resource, a window per request, answered as one
   * response whose body arrives as the windows do. It says what a single
   * request would have: 200 and the whole length for a whole file, 206 and
   * the range for a range. A host that ignores ranges answers the first
   * window with everything, and that answer is passed on as it is.
   */
  const windowed = async (url, span, headers, signal) => {
    const rest = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'range'));
    let size = FIRST_WINDOW;
    const upTo = (from) => (span.to === null ? from + size - 1 : Math.min(span.to, from + size - 1));
    const ask = (from, over) => once(url, { signal: over, headers: { ...rest, Range: `bytes=${from}-${upTo(from)}` } });

    let first = await ask(span.from, signal);
    // A whole file asked for from its first byte, answered "nothing there":
    // an empty file. Asked again as it was, it is one.
    if (first.status === 416 && !span.ranged) return once(url, { signal, headers: rest });
    if (first.status !== 206) return first;
    // A range of a compressed body is a range of compressed bytes, which the
    // manager then decodes: the pieces would not join up into the file. Such
    // a resource is asked for as it was, in one request.
    if (!/^(identity)?$/i.test((first.headers.get('content-encoding') || '').trim())) return once(url, { signal, headers });
    const range = contentRange(first);
    if (range?.from !== span.from) throw new BackendError(`${hostOf(url)} sent a different part of the file than the one asked for.`);

    const end = range.total === null ? span.to : Math.min(span.to ?? Infinity, range.total - 1);
    const out = new Headers(first.headers);
    out.delete('content-range');
    out.delete('content-length');
    if (end !== null) out.set('content-length', String(end - span.from + 1));
    if (span.ranged && end !== null) out.set('content-range', `bytes ${span.from}-${end}/${range.total ?? '*'}`);

    // Reading stops when the reader does: a cancel calls off the window in flight.
    const stop = new AbortController();
    const quit = () => stop.abort();
    signal?.addEventListener('abort', quit, { once: true });
    let next = span.from;
    const body = new ReadableStream({
      async pull(stream) {
        const from = next;
        const wanted = upTo(from) - from + 1;
        let response = first;
        first = null;
        if (!response) {
          response = await ask(from, stop.signal);
          if (response.status !== 206 || contentRange(response)?.from !== from) {
            throw new BackendError(`${hostOf(url)} answered ${response.status} part-way through the file.`);
          }
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        next += bytes.length;
        size = Math.min(size * 2, LAST_WINDOW);
        if (bytes.length > 0) stream.enqueue(bytes);
        // The end is where the host said it is. A host that did not say ends
        // where a window comes back short. One that sends a window short of
        // an end it did state is capping its ranges, and the next asks on.
        if (end !== null ? next > end : bytes.length < wanted) {
          signal?.removeEventListener('abort', quit);
          stream.close();
        } else if (bytes.length === 0) {
          throw new BackendError(`${hostOf(url)} sent an empty part of the file.`);
        }
      },
      cancel: quit,
    });
    return new Response(body, { status: span.ranged ? 206 : 200, headers: out });
  };

  state.request = async (url, { signal, method = 'GET', headers = {}, body } = {}) => {
    const plain = headers instanceof Headers ? Object.fromEntries(headers) : { ...headers };
    const span = body ? null : spanOf(method, plain);
    return span ? windowed(url, span, plain, signal) : once(url, { signal, method, headers: plain, body });
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
