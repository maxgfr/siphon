/**
 * How a link becomes a file, behind one interface.
 *
 * There is one backend, `Siphon`, and it decides per link. Underneath it are
 * the three things that can actually fetch — this device, your own server, a
 * cobalt instance — and the decision is the same short rule every time:
 *
 *   a server with ffmpeg does everything, because yt-dlp with your cookies is
 *   the most capable thing on offer;
 *   otherwise this device does everything it can, and asks for help only where
 *   a page cannot go — a server that only resolves, an instance, a relay.
 *
 * app.js sees four questions — are you there, what is this link, start a
 * download, how is it going — and never which of the three answered.
 */
export { BackendError } from './errors.js';
import { BackendError } from './errors.js';
import { BrowserBackend } from './inbrowser.js';
import { pipedResolver, invidiousResolver, invidiousWalk } from './extract.js';
import { invidiousInstances } from './instances.js';
import { relayEscape } from './net.js';
import { isLoopback } from './endpoint.js';
export { detectEndpoint, privacyNote, describeEndpoint, withScheme, phoneRoute } from './endpoint.js';
export { bundledInfo, findInstance, invidiousInstances, looksUnreachable, openInstances, servesPages } from './instances.js';

/** The qualities the UI offers. The server validates against its own copy. */
export const PRESETS = Object.freeze([
  { id: 'video_best', label: 'Best', note: 'video', kind: 'video' },
  { id: 'video_1080', label: '1080p', note: 'video', kind: 'video' },
  { id: 'video_720', label: '720p', note: 'video', kind: 'video' },
  { id: 'video_480', label: '480p', note: 'video', kind: 'video' },
  { id: 'audio_mp3', label: 'MP3', note: 'audio', kind: 'audio' },
  { id: 'audio_m4a', label: 'M4A', note: 'audio', kind: 'audio' },
]);

const trimSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

async function readError(response, fallback) {
  try {
    const body = await response.json();
    if (body && typeof body.detail === 'string') return body.detail;
    if (body && typeof body.error === 'object' && body.error?.code) return body.error.code;
  } catch {
    /* not JSON — fall through to the generic message */
  }
  return fallback;
}

/**
 * Turn a fetch rejection into something that names the likely cause. This
 * computer is never mixed content, even from an HTTPS page (see isLoopback).
 */
function networkError(base) {
  const secureMismatch = location.protocol === 'https:' && base.startsWith('http://') && !isLoopback(base);
  return unreachable(new BackendError(
    secureMismatch ? 'Blocked: this page is HTTPS and the server is plain HTTP.' : 'Could not reach the server.',
    {
      hint: secureMismatch
        ? 'Browsers refuse mixed content. Put the server behind HTTPS, or open this page over plain HTTP too.'
        : 'Check the address in settings, and that the server is running and allows this page in ALLOWED_ORIGINS.' +
          (isLoopback(base) ? ' If the browser asked whether this page may reach apps on this device, allow it.' : ''),
    },
  ));
}

/** Marks an error as the server not being there at all — not a refusal, not an answer. */
function unreachable(error) {
  error.unreachable = true;
  return error;
}

/* -------------------------------------------------------------- self-hosted */

const POLL_TIMEOUT_MS = 15_000;

export class ServerBackend {
  constructor({ base = '', key = '' } = {}) {
    // An empty base means "wherever this page came from", which is exactly the
    // case when the server serves the frontend too.
    this.base = trimSlash(base) || trimSlash(location.origin);
    this.key = String(key || '').trim();
    this.mode = 'server';
    this.supportsProgress = true;
    this.supportsProbe = true;
    this.supportsPlaylist = true;
  }

  get headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.key) headers.Authorization = `Bearer ${this.key}`;
    return headers;
  }

  async #json(path, init = {}) {
    let response;
    try {
      response = await fetch(`${this.base}${path}`, { ...init, headers: { ...this.headers, ...(init.headers || {}) } });
    } catch {
      throw networkError(this.base);
    }
    if (response.status === 401) {
      throw new BackendError('This server needs an access key.', {
        hint: 'Add it in settings — it is the AUTH_TOKEN the server was started with.',
        retryable: false,
      });
    }
    if (response.status === 429) {
      // As many downloads in flight as it takes: this one waits its turn.
      const error = new BackendError(await readError(response, 'Your server is busy.'));
      error.busy = true;
      throw error;
    }
    if (!response.ok) {
      throw new BackendError(await readError(response, `The server answered ${response.status}.`));
    }
    return response.json();
  }

  async health() {
    const body = await this.#json('/api/health');
    return {
      ok: true,
      label: `yt-dlp ${body.ytDlpVersion || '?'}`,
      ffmpeg: body.ffmpeg !== false,
      presets: Array.isArray(body.presets) ? body.presets.map((p) => p.id) : null,
      lanUrls: Array.isArray(body.lanUrls) ? body.lanUrls : [],
      hasCookies: body.hasCookies === true,
      potProvider: body.potProvider === true,
    };
  }

  probe(url) {
    return this.#json('/api/probe', { method: 'POST', body: JSON.stringify({ url }) });
  }

  /** The formats behind a link, from yt-dlp, for this page to download itself. */
  resolve(url) {
    return this.#json('/api/resolve', { method: 'POST', body: JSON.stringify({ url }) });
  }

  /** This server as an escape: it carries the bytes of hosts it just resolved. */
  get escape() {
    const headers = this.key ? { Authorization: `Bearer ${this.key}` } : {};
    return { name: 'tunnel', via: (url) => `${this.base}/api/tunnel?url=${encodeURIComponent(url)}`, headers };
  }

  async start(url, preset, { playlist = false, subs = 'off', subLangs = 'en', ytdlp = {} } = {}) {
    const job = await this.#json('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        url,
        preset,
        playlist,
        subs,
        sub_langs: subLangs,
        // The Advanced section's asks, in the server's vocabulary. The server
        // validates each one and refuses the job with the reason if one is off.
        sponsorblock: ytdlp.sponsorblock === true,
        clip_start: String(ytdlp.clipStart || ''),
        clip_end: String(ytdlp.clipEnd || ''),
        rate_limit: String(ytdlp.rateLimit || ''),
        yt_client: String(ytdlp.client || ''),
      }),
    });
    return { kind: 'job', id: job.id };
  }

  /**
   * A poll that has not answered in this long is a miss, like any other
   * silence. Left to itself, on a network that swallows the packets, it
   * waits out the system's own connect timeout: minutes of a row standing still.
   */
  poll(id) {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(POLL_TIMEOUT_MS) : undefined;
    return this.#json(`/api/jobs/${encodeURIComponent(id)}`, { signal });
  }

  /**
   * The browser's downloader fetches this itself, so it cannot carry an
   * Authorization header — the key rides in the query string instead.
   */
  fileUrl(id) {
    const suffix = this.key ? `?key=${encodeURIComponent(this.key)}` : '';
    return `${this.base}/api/jobs/${encodeURIComponent(id)}/file${suffix}`;
  }

  putCookies(text) {
    return this.#json('/api/cookies', { method: 'POST', body: JSON.stringify({ cookies: text }) });
  }

  dropCookies() {
    return this.#json('/api/cookies', { method: 'DELETE' });
  }

  cancel(id) {
    return fetch(`${this.base}/api/jobs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers,
    }).catch(() => {});
  }
}

/* ------------------------------------------------------------------- public */

/**
 * Map our preset ids onto cobalt's request shape.
 *
 * cobalt checks a request against a strict list of values and refuses the
 * whole of it over one it does not know, so there is no asking for "m4a":
 * its audio formats are best, mp3, ogg, wav and opus. "best" is the site's
 * own audio, untouched, and for YouTube — the one site a page mostly needs
 * an instance for — that is AAC in an .m4a, with cobalt's default h264.
 */
const COBALT_REQUEST = {
  video_best: { downloadMode: 'auto', videoQuality: 'max' },
  video_1080: { downloadMode: 'auto', videoQuality: '1080' },
  video_720: { downloadMode: 'auto', videoQuality: '720' },
  video_480: { downloadMode: 'auto', videoQuality: '480' },
  audio_mp3: { downloadMode: 'audio', audioFormat: 'mp3' },
  audio_m4a: { downloadMode: 'audio', audioFormat: 'best' },
};

/** cobalt's error codes are namespaced strings; these are the ones users hit. */
const COBALT_MESSAGES = {
  'error.api.auth.key.missing': 'This instance requires an API key.',
  'error.api.auth.key.invalid': 'This instance rejected that API key.',
  'error.api.auth.turnstile.missing': 'This instance requires a captcha, which only its own website can show.',
  'error.api.auth.jwt.missing': 'This instance answers only its own website, which holds a session from its captcha.',
  'error.api.auth.jwt.invalid': 'This instance answers only its own website, which holds a session from its captcha.',
  'error.api.invalid_body': 'This instance did not accept the request: it runs a cobalt this app does not speak.',
  'error.api.youtube.login': 'YouTube asked this instance to sign in, so it cannot fetch that video. Your own server, with your cookies, can.',
  'error.api.service.unsupported': 'This instance does not support that site.',
  'error.api.service.disabled': 'This instance has that site turned off.',
  'error.api.link.invalid': 'That link was not understood.',
  'error.api.content.video.unavailable': 'That video is unavailable.',
  'error.api.content.video.age': 'That video is age-restricted.',
  'error.api.content.video.private': 'That video is private.',
  'error.api.content.too_long': 'That video is longer than this instance allows.',
  'error.api.content.video.region': 'That video is not available where this instance runs.',
  'error.api.fetch.rate': 'This instance is rate-limiting you. Wait a bit, or use your own server.',
  'error.api.fetch.fail': 'This instance could not get that link from the site.',
  'error.api.fetch.critical': 'This instance could not get that link from the site.',
  'error.api.fetch.empty': 'This instance found nothing to download at that link.',
};

export class PublicBackend {
  constructor({ base = '', key = '' } = {}) {
    this.base = trimSlash(base);
    this.key = String(key || '').trim();
    this.mode = 'public';
    // No job to poll: cobalt streams the file through its own tunnel, so the
    // only progress indicator is the browser's own download UI.
    this.supportsProgress = false;
    this.supportsProbe = false;
    this.supportsPlaylist = false;
  }

  get headers() {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.key) headers.Authorization = `Api-Key ${this.key}`;
    return headers;
  }

  async health() {
    if (!this.base) {
      throw new BackendError('No instance set.', {
        hint: 'Public mode needs an instance address — there is no default to fall back on.',
        retryable: false,
      });
    }
    let response;
    try {
      response = await fetch(`${this.base}/`, { headers: { Accept: 'application/json' } });
    } catch {
      throw networkError(this.base);
    }
    if (!response.ok) throw new BackendError(`That instance answered ${response.status}.`);
    const body = await response.json().catch(() => ({}));
    return { ok: true, label: body?.cobalt?.version ? `cobalt ${body.cobalt.version}` : 'public instance', ffmpeg: true, presets: null };
  }

  async probe() {
    return null; // cobalt returns no metadata before the download
  }

  async start(url, preset, _options = {}) {
    if (!this.base) {
      throw new BackendError('No instance set.', { hint: 'Open settings and add one.', retryable: false });
    }
    let response;
    try {
      response = await fetch(`${this.base}/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ url, ...(COBALT_REQUEST[preset] || COBALT_REQUEST.video_best) }),
      });
    } catch {
      throw networkError(this.base);
    }

    const body = await response.json().catch(() => ({}));

    if (body.status === 'error' || !response.ok) {
      const code = body?.error?.code || '';
      // A code with no sentence here is still named, so it can be looked up.
      const message = COBALT_MESSAGES[code] || (code ? `This instance refused: ${code}.` : `That instance answered ${response.status}.`);
      throw new BackendError(message, {
        hint: code.includes('auth') ? 'Add the key in settings, or switch to your own server.' : '',
      });
    }
    if (body.status === 'picker') {
      throw new BackendError('That link holds several files, which this app cannot pick between yet.', {
        hint: 'Your own server handles these.',
        retryable: false,
      });
    }
    if (!body.url) throw new BackendError('That instance returned no file.');
    // The address goes straight into a link this page clicks. An instance is
    // someone else's server, and a `javascript:` URL from it would run as
    // this page — with its settings, its keys and the bridge — so only a
    // real download address is taken.
    let link;
    try {
      link = new URL(body.url, `${this.base}/`);
    } catch {
      link = null;
    }
    if (!link || (link.protocol !== 'https:' && link.protocol !== 'http:')) {
      throw new BackendError('That instance returned something that is not a download link.', { retryable: false });
    }

    return { kind: 'direct', url: link.href, filename: body.filename || null };
  }
}

/* ------------------------------------------------------------------ browser */

export { BrowserBackend };

/** A siphon server as a resolver: every site yt-dlp knows, with your cookies. */
function serverResolver(server) {
  return {
    name: 'server',
    generic: true,
    resolve: (url) => server.resolve(url),
  };
}

/* ------------------------------------------------------------------- siphon */

/** What a row says when your server could not be reached and this device took the link. */
const TAKEN_HERE = 'Taken on this device: your server could not be reached.';

/** The bridge before 1.2 neither stops a cancelled transfer nor says where a redirect landed. */
const olderBridge = (version) => {
  const [major, minor] = String(version || '').split('.').map(Number);
  return Number.isFinite(major) && (major < 1 || (major === 1 && (minor || 0) < 2));
};

/**
 * The one backend.
 *
 * `helper` is what the address in settings turned out to be (see endpoint.js):
 * nothing, a siphon server (with or without ffmpeg), a cobalt instance, a
 * Piped or Invidious instance, a relay. Everything below follows from that.
 */
export class Siphon {
  /**
   * @param {object} options
   * @param {Siphon|null} [options.previous]  the backend this one replaces:
   *   its device and its record of who owns which job carry over, so a
   *   download already running outlives a change of settings
   */
  constructor({ endpoint = '', key = '', helper = null, coreUrl = '', firstInstance = '', previous = null } = {}) {
    this.helper = helper || { kind: 'none', label: 'this device only' };
    const kind = this.helper.kind;

    this.server = kind === 'siphon' ? new ServerBackend({ base: endpoint, key }) : null;
    this.instance = kind === 'cobalt' ? new PublicBackend({ base: endpoint, key }) : null;
    /** Whether the server takes the whole job. */
    this.full = Boolean(this.server && this.helper.ffmpeg !== false);

    const way = {
      coreUrl,
      escape: this.server ? this.server.escape : kind === 'relay' ? relayEscape(endpoint) : null,
      resolvers: [
        this.server ? serverResolver(this.server) : null,
        kind === 'piped' ? pipedResolver(endpoint) : null,
        kind === 'invidious' ? invidiousResolver(endpoint, { others: () => invidiousInstances() }) : null,
        // A relay makes the public instances readable again (they refuse a
        // page, not a plain client), so with one the bundled list is walked
        // before InnerTube is tried through the same relay.
        kind === 'relay'
          ? invidiousWalk({
              // The instance the site's measurement saw answer through this
              // relay goes first; the rest of the bundled list follows.
              others: async () => [firstInstance, ...(await invidiousInstances())].filter(Boolean),
            })
          : null,
      ],
    };
    // A fresh device would have an empty job table: the next poll of a
    // download still running on this one would find nothing and call it
    // gone, while it carried on unseen.
    this.device = previous?.device ? previous.device.configure(way) : new BrowserBackend(way);

    this.supportsProgress = true;
    this.supportsProbe = true;
    this.supportsPlaylist = this.full;
    /** @type {Map<string, object>} which backend owns a job id */
    this.owners = previous?.owners || new Map();
    /** Jobs this device took because your server could not be reached. */
    this.takenHere = previous?.takenHere || new Set();
  }

  /** Whether the bridge is on this page: it goes first, whatever the helper. */
  get hasBridge() {
    return this.device.net.hasBridge;
  }

  get bridgeVersion() {
    return this.device.net.bridgeVersion;
  }

  /** Where a job id came from, including ones started before a reload. */
  #owner(id) {
    return this.owners.get(id) || (String(id).startsWith('b-') ? this.device : this.server || this.device);
  }

  async health() {
    // A server adopted without the key it wants is there, and does nothing
    // until the key is in: the header says so before a link fails on it.
    const keyless = this.server && this.helper.keyAccepted === false ? ' — needs its access key' : '';
    if (this.full) {
      const info = await this.server.health();
      return { ...info, label: `${info.label} · your server${keyless}` };
    }
    const info = await this.device.health();
    const suffix = {
      siphon: `your server resolves${keyless}`,
      cobalt: `${this.helper.label} for the rest`,
      piped: 'Piped for YouTube',
      invidious: 'Invidious for YouTube',
      relay: 'relay for YouTube',
      none: 'no helper',
    }[this.helper.kind] || 'no helper';
    // The bridge is used ahead of any helper, so it is named first; with it
    // and nothing else, "no helper" would read as a bridge that is not running.
    const bridge = info.bridge
      ? `bridge${info.bridgeVersion ? ` ${info.bridgeVersion}` : ''}${olderBridge(info.bridgeVersion) ? ', update it' : ''}`
      : '';
    const parts = [info.label, bridge, bridge && this.helper.kind === 'none' ? '' : suffix];
    return { ...info, label: parts.filter(Boolean).join(' · ') };
  }

  async probe(url) {
    if (this.full) {
      try {
        return await this.server.probe(url);
      } catch (error) {
        if (!error?.unreachable) throw error;
        return this.device.probe(url).catch(() => {
          throw error;
        });
      }
    }
    try {
      return await this.device.probe(url);
    } catch (error) {
      // An instance offers no metadata, so a link only it can take shows no
      // preview — and that is not a failure.
      if (this.instance) return null;
      throw error;
    }
  }

  async start(url, preset, options = {}) {
    if (this.full) {
      try {
        const started = await this.server.start(url, preset, options);
        this.owners.set(started.id, this.server);
        return started;
      } catch (error) {
        // Away from home, or with the tunnel down: a link this device can
        // read itself is still a download, taken here and said so on its row.
        // A refusal, or anything the server answered, is not the network.
        if (!error?.unreachable) throw error;
        try {
          await this.device.identify(url);
        } catch {
          throw error;
        }
        const started = await this.device.start(url, preset, options);
        this.owners.set(started.id, this.device);
        this.takenHere.add(started.id);
        return started;
      }
    }
    try {
      // identify() is what throws when the device has no way in; start() would
      // fail later, inside the job, where an instance can no longer take over.
      await this.device.identify(url);
    } catch (error) {
      if (this.instance) return this.instance.start(url, preset, options);
      throw error;
    }
    const started = await this.device.start(url, preset, options);
    this.owners.set(started.id, this.device);
    return started;
  }

  async poll(id) {
    const job = await this.#owner(id).poll(id);
    return this.takenHere.has(id) ? { ...job, note: [TAKEN_HERE, job.note].filter(Boolean).join(' ') } : job;
  }

  fileUrl(id) {
    return this.#owner(id).fileUrl(id);
  }

  cancel(id) {
    const owner = this.#owner(id);
    this.owners.delete(id);
    this.takenHere.delete(id);
    return owner.cancel?.(id) || Promise.resolve();
  }

  putCookies(text) {
    if (!this.server) throw new BackendError('Cookies only apply to your own server.');
    return this.server.putCookies(text);
  }

  dropCookies() {
    if (!this.server) throw new BackendError('Cookies only apply to your own server.');
    return this.server.dropCookies();
  }
}

/** Build the backend the saved settings describe, taking over the jobs of `previous`. */
export function makeBackend(settings, previous = null) {
  return new Siphon({
    endpoint: settings.endpoint,
    key: settings.key,
    helper: settings.helper,
    coreUrl: settings.coreUrl,
    firstInstance: settings.siteInstance || '',
    previous,
  });
}
