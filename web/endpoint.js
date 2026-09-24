/**
 * One address, and what it turns out to be.
 *
 * The settings hold a single optional address. It may be a siphon server, a
 * cobalt instance, a Piped or Invidious instance, or a bare relay — five
 * different things with five different protocols, and asking the user which
 * is the kind of question this app exists not to ask. So the address is
 * probed, once, when it is saved, and the answer is kept alongside it.
 *
 * Each probe is one small request that is unmistakable for that kind:
 *
 *   siphon     GET /api/health          → JSON with service: "siphon"
 *   cobalt     GET /  (Accept: json)    → JSON with a `cobalt` object
 *   piped      GET /config              → JSON naming an image proxy
 *   invidious  GET /api/v1/stats        → JSON whose `software.name` is invidious
 *   relay      GET /?url=<robots.txt>   → 200 whose body names a User-agent
 *
 * The fetch is injectable so the classification can be tested with no network.
 */

const trimSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

/** Public, tiny, unmistakable: a 200 whose body names a User-agent came from YouTube. */
const ROBOTS = 'https://www.youtube.com/robots.txt';

/** @typedef {{ kind: 'none'|'siphon'|'cobalt'|'piped'|'invidious'|'relay', label: string, ffmpeg?: boolean, lanUrls?: string[], hasCookies?: boolean, requiresKey?: boolean, keyAccepted?: boolean }} Endpoint */

const NONE = Object.freeze({ kind: 'none', label: 'this device only' });

/** The host of an address, lower-cased, without its port or IPv6 brackets. */
const bareHost = (address) =>
  String(address || '')
    .replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
    .split(/[/?#]/)[0]
    .replace(/^[^@]*@/, '')
    .replace(/:\d*$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();

/**
 * Whether an address is this machine. A browser counts http://127.0.0.1 and
 * http://localhost as secure, so an HTTPS page may call them: when one does
 * not answer, mixed content is never the reason.
 */
export function isLoopback(address) {
  return loopbackHost(bareHost(address));
}

const loopbackHost = (host) => host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1';

/** Addresses on this machine or this network, which a server there answers on in plain http. */
const LOCAL = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /\.local$/, /^f[cd][\da-f]{2}:/, /^fe[89ab][\da-f]:/, /^[^.:]+$/];

/**
 * An address as a phone keyboard leaves it — "inv.nadeko.net",
 * "192.168.1.42:8000" — with the scheme it most likely has. Without one it is
 * a path under this page, and every probe would ask the page's own host.
 * A server on this machine or this network is plain http, the way one docker
 * run starts it; anything else is https. An address that already has a
 * scheme, or is a path on this page's own host, is left as it is.
 */
export function withScheme(address) {
  const text = String(address || '').trim();
  if (!text || /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^[/.]/.test(text)) return text;
  const host = bareHost(text);
  return `${loopbackHost(host) || LOCAL.some((pattern) => pattern.test(host)) ? 'http' : 'https'}://${text}`;
}

/**
 * @param {string} address  '' means "wherever this page came from"
 * @param {string} key
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Endpoint>}
 */
export async function detectEndpoint(address, key = '', fetchImpl = globalThis.fetch) {
  // The sheet adds the scheme before it asks. A bare host from anywhere else
  // is refused rather than probed as a path under this page's own host.
  if (withScheme(address) !== String(address || '').trim()) {
    throw new Error('Include the https:// at the start of the address.');
  }
  // A template — `{url}` or `{raw}` where the target goes — can only be a
  // relay, and is probed the one way a relay can be: by fetching through it.
  if (/\{(url|raw)\}/.test(String(address || ''))) {
    const target = String(address).trim().replace('{url}', encodeURIComponent(ROBOTS)).replace('{raw}', ROBOTS);
    let response;
    try {
      response = await fetchImpl(target, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    } catch {
      throw new Error('Could not reach that relay.');
    }
    const text = await response.text().catch(() => '');
    if (response.status === 200 && /user-agent/i.test(text)) return { kind: 'relay', label: 'relay' };
    throw new Error(`That relay answered ${response.status} rather than fetching for this page.`);
  }
  const base = trimSlash(address);
  const sameOrigin = !base;
  const root = sameOrigin ? '' : base;
  // The key goes to one request only: the gated check below, once health has
  // said this is a siphon server. The key in the sheet may be the one saved
  // for another address, and a cobalt instance or a stranger's relay
  // answering the other probes has no business receiving it.
  const auth = key ? { Authorization: `Bearer ${key}` } : {};
  const get = async (path, init = {}) => {
    try {
      const response = await fetchImpl(`${root}${path}`, {
        ...init,
        headers: { Accept: 'application/json, text/plain, */*', ...(init.headers || {}) },
        credentials: 'omit',
        signal: AbortSignal.timeout(8000),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: response.status, ok: response.ok, text, json };
    } catch {
      return null;
    }
  };

  const health = await get('/api/health');
  if (health?.json?.service === 'siphon') {
    const body = health.json;
    // Health answers everyone, so it cannot say whether the key in the sheet
    // is the right one — and without this, a wrong key passed Test and failed
    // at the first download. A gated endpoint is asked instead: 401 is the
    // key being wrong or missing; a 404 is the key being taken. Reported
    // rather than thrown, because the server is still a siphon server: a
    // first visit at a keyed server adopts it and asks for the key later.
    let keyAccepted = true;
    if (body.requiresKey === true) {
      const gate = await get('/api/jobs/key-check', { headers: auth });
      keyAccepted = gate?.status !== 401;
    }
    return {
      kind: 'siphon',
      keyAccepted,
      label: `yt-dlp ${body.ytDlpVersion || '?'}`,
      ytDlpVersion: body.ytDlpVersion || '',
      ffmpeg: body.ffmpeg !== false,
      // Older servers say nothing about it; only an explicit "no" is a warning.
      jsRuntime: body.jsRuntime !== false,
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : ['jobs'],
      lanUrls: Array.isArray(body.lanUrls) ? body.lanUrls : [],
      hasCookies: body.hasCookies === true,
      requiresKey: body.requiresKey === true,
    };
  }
  if (health?.status === 401) {
    throw new Error('That server wants an access key.');
  }
  // A same-origin page with no API behind it is the static-host case, and it
  // is not an error: it is the answer "nothing here, the device does it".
  if (sameOrigin) return NONE;

  const cobalt = await get('/');
  if (cobalt?.json && typeof cobalt.json.cobalt === 'object') {
    return { kind: 'cobalt', label: `cobalt ${cobalt.json.cobalt.version || ''}`.trim(), ffmpeg: true };
  }

  const piped = await get('/config');
  if (piped?.json && ('imageProxyUrl' in piped.json || 'donationUrl' in piped.json || 'statusPageUrl' in piped.json)) {
    return { kind: 'piped', label: 'Piped instance' };
  }

  // Stats can be switched off in an instance's config, and then the endpoint
  // answers 400 with a sentence only Invidious says — which is still an answer.
  const invidious = await get('/api/v1/stats');
  if (invidious?.json && (/invidious/i.test(String(invidious.json.software?.name || '')) || /statistics are not enabled/i.test(String(invidious.json.error || '')))) {
    return { kind: 'invidious', label: 'Invidious instance' };
  }

  const relay = await get(`/?url=${encodeURIComponent(ROBOTS)}`);
  if (relay?.status === 200 && /user-agent/i.test(relay.text)) {
    return { kind: 'relay', label: 'relay' };
  }
  if (relay?.status === 403 && /origin not allowed/i.test(relay.text)) {
    throw new Error('That relay does not allow this page. Add this origin to its ALLOWED_ORIGINS.');
  }

  if (!health && !cobalt && !piped && !invidious && !relay) {
    const page = typeof location !== 'undefined' ? location : null;
    // This computer is not mixed content, even from an HTTPS page. What stops
    // it is a server not started yet, one that does not name this page, or
    // the browser's own question about letting a page reach this device.
    if (isLoopback(base)) {
      throw new Error(
        `Could not reach it. Is the server running, and does its ALLOWED_ORIGINS name this page${page ? ` (${page.origin})` : ''}? ` +
          'If the browser asked whether this page may reach apps on this device, allow it.',
      );
    }
    throw new Error(
      page?.protocol === 'https:' && base.startsWith('http://')
        ? 'Blocked: this page is HTTPS and the address is plain HTTP. Browsers refuse mixed content.'
        : 'Could not reach that address.',
    );
  }
  throw new Error('That address answers, but not as a siphon server, a cobalt, Piped or Invidious instance, or a relay.');
}

/** The sentence under the link box: where a pasted link goes. */
export function privacyNote(endpoint) {
  switch (endpoint?.kind) {
    case 'siphon':
      return endpoint.ffmpeg
        ? 'Links go only to your server, which does the downloading. Nothing is sent anywhere else.'
        : 'Downloads happen on this device. Links the device cannot read itself go to your server, which resolves them.';
    case 'cobalt':
      return 'Downloads happen on this device where the site allows it. The rest are sent to the cobalt instance you configured.';
    case 'piped':
      return 'Downloads happen on this device. YouTube links are sent to the Piped instance you configured.';
    case 'invidious':
      return 'Downloads happen on this device. YouTube links are sent to the Invidious instance you configured.';
    case 'relay':
      return 'Downloads happen on this device, except for hosts that refuse a web page — those go through your relay.';
    default:
      return 'Downloads happen on this device. Links go to the site they point at, and nowhere else.';
  }
}

/**
 * How old a yt-dlp is, in days, from its calendar version (2026.08.19); null
 * when the version is not one. YouTube changes often enough that the age of
 * the extractor is the first thing to check when a download fails.
 */
export function ytdlpAge(version, now = new Date()) {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(String(version || ''));
  if (!match) return null;
  const released = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.floor((now.getTime() - released) / 86_400_000);
}

/** Past this, the sheet says so: yt-dlp releases about monthly, and the image is rebuilt weekly. */
export const STALE_AFTER_DAYS = 45;

/** The sentence in the settings sheet after Test. */
export function describeEndpoint(endpoint, now = new Date()) {
  switch (endpoint?.kind) {
    case 'siphon': {
      let text = endpoint.ffmpeg
        ? `Your server — ${endpoint.label}, with ffmpeg. It does everything: every site yt-dlp knows, playlists, subtitles.`
        : `Your server — ${endpoint.label}, no ffmpeg. It resolves links; this device downloads and converts.`;
      if (endpoint.jsRuntime === false) {
        text += ' It has no JavaScript runtime beside yt-dlp, so YouTube formats may be missing — install Deno there, or use the Docker image, which has one.';
      }
      const age = ytdlpAge(endpoint.ytDlpVersion, now);
      if (age !== null && age > STALE_AFTER_DAYS) {
        // Both ways of starting it: the guide's one docker run has no compose
        // file to pull with, and a pull alone leaves the old container running.
        text += ` Its yt-dlp is ${age} days old, and YouTube changes often: the image is rebuilt every week, so when a download fails, take the new one — docker compose pull && docker compose up -d, or docker pull ghcr.io/maxgfr/siphon, then docker rm -f siphon and the same docker run.`;
      }
      return text;
    }
    case 'cobalt':
      return `A ${endpoint.label} instance. This device does what it can; the rest goes to the instance.`;
    case 'piped':
      return 'A Piped instance. YouTube goes through it; everything else stays on this device.';
    case 'invidious':
      return 'An Invidious instance. YouTube goes through it; everything else stays on this device.';
    case 'relay':
      return 'A relay. This device does everything; hosts that refuse a page go through the relay.';
    default:
      return 'Nothing set — this device only. Direct files, HLS and pages that allow it; YouTube will need a helper.';
  }
}
