/**
 * Fetching, under the browser's rules.
 *
 * The one thing a page genuinely cannot do is read a cross-origin response
 * that was not offered to it. Plenty of media hosts *do* offer it — an HLS
 * ladder meant to be played by hls.js on someone else's site has to send
 * `Access-Control-Allow-Origin`, or it would not work at all — and for those
 * this module is a thin wrapper over `fetch` and nothing leaves the browser.
 *
 * For the hosts that do not (YouTube being the one everybody wants), the user
 * can point siphon at a relay: a stateless header-adder they deploy once, with
 * no yt-dlp, no ffmpeg and no state. It is still a server, and this module is
 * careful about the distinction — the relay is never assumed, never contacted
 * unless the direct attempt actually failed, and when it is unset the failure
 * says so in a sentence.
 *
 * The verdict per origin is remembered for the session: a 400-segment HLS
 * download should discover the CORS answer once, not eight hundred times.
 */
import { BackendError } from './errors.js';

/** Whether a fetch rejection was the browser refusing, rather than the network. */
const isBlocked = (error) => error instanceof TypeError;

export class Fetcher {
  constructor({ relay = '' } = {}) {
    this.relay = String(relay || '').trim().replace(/\/+$/, '');
    /** @type {Map<string, 'direct'|'relay'>} */
    this.verdicts = new Map();
  }

  get hasRelay() {
    return Boolean(this.relay);
  }

  /** What the relay's URL looks like for a given target. */
  via(url) {
    return `${this.relay}/?url=${encodeURIComponent(url)}`;
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
    const route = known || (prefer === 'relay' && this.hasRelay ? 'relay' : 'direct');

    if (route === 'relay') return this.#relayRequest(url, { signal, ...init });

    try {
      const response = await fetch(url, { ...init, signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      this.verdicts.set(origin, 'direct');
      return response;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isBlocked(error)) throw error;
      if (!this.hasRelay) throw corsWall(origin);
      const response = await this.#relayRequest(url, { signal, ...init });
      this.verdicts.set(origin, 'relay');
      return response;
    }
  }

  async #relayRequest(url, init) {
    if (!this.hasRelay) throw corsWall(this.#origin(url));
    let response;
    try {
      response = await fetch(this.via(url), { ...init, credentials: 'omit' });
    } catch {
      throw new BackendError('Could not reach the relay.', {
        hint: 'Check the address in settings, and that the worker is deployed.',
      });
    }
    if (response.status === 403) {
      throw new BackendError('The relay refused that address.', {
        hint: 'Relays carry an allow-list of hosts. Add this one to ALLOWED_HOSTS, or use your own server.',
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
      'Add a relay in settings, or switch to your own server.',
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
