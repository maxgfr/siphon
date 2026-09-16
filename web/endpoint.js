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

/** @typedef {{ kind: 'none'|'siphon'|'cobalt'|'piped'|'invidious'|'relay', label: string, ffmpeg?: boolean, lanUrls?: string[], hasCookies?: boolean, requiresKey?: boolean }} Endpoint */

const NONE = Object.freeze({ kind: 'none', label: 'this device only' });

/**
 * @param {string} address  '' means "wherever this page came from"
 * @param {string} key
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Endpoint>}
 */
export async function detectEndpoint(address, key = '', fetchImpl = globalThis.fetch) {
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
  const auth = key ? { Authorization: `Bearer ${key}` } : {};
  const get = async (path, init = {}) => {
    try {
      const response = await fetchImpl(`${root}${path}`, {
        ...init,
        headers: { Accept: 'application/json, text/plain, */*', ...auth, ...(init.headers || {}) },
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
    return {
      kind: 'siphon',
      label: `yt-dlp ${body.ytDlpVersion || '?'}`,
      ffmpeg: body.ffmpeg !== false,
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
    throw new Error(
      typeof location !== 'undefined' && location.protocol === 'https:' && base.startsWith('http://')
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

/** The sentence in the settings sheet after Test. */
export function describeEndpoint(endpoint) {
  switch (endpoint?.kind) {
    case 'siphon':
      return endpoint.ffmpeg
        ? `Your server — ${endpoint.label}, with ffmpeg. It does everything: every site yt-dlp knows, playlists, subtitles.`
        : `Your server — ${endpoint.label}, no ffmpeg. It resolves links; this device downloads and converts.`;
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
