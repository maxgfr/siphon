/**
 * Just enough HLS to download one.
 *
 * This is not a player: nothing here has to run in real time, decide a
 * bitrate ladder on the fly, or recover from a gap. It has to read a master
 * playlist, let the caller pick one rendition, and list that rendition's
 * segments in order. That is a much smaller problem than hls.js solves, and
 * the whole of it is two parsers and an attribute reader.
 *
 * Everything here is pure — text in, objects out — so it is the part of the
 * extractor that can actually be unit-tested without a network.
 */

/**
 * Read an `#EXT-X-…:` attribute list.
 *
 * The format allows quoted values containing commas (`CODECS="avc1,mp4a"`),
 * so splitting on commas is wrong and a small scanner is right.
 */
export function parseAttributes(input) {
  const out = {};
  let index = 0;
  const text = String(input || '');

  while (index < text.length) {
    const equals = text.indexOf('=', index);
    if (equals === -1) break;
    const key = text.slice(index, equals).trim();
    index = equals + 1;

    let value;
    if (text[index] === '"') {
      const close = text.indexOf('"', index + 1);
      value = close === -1 ? text.slice(index + 1) : text.slice(index + 1, close);
      index = close === -1 ? text.length : close + 1;
      if (text[index] === ',') index += 1;
    } else {
      const comma = text.indexOf(',', index);
      value = comma === -1 ? text.slice(index) : text.slice(index, comma);
      index = comma === -1 ? text.length : comma + 1;
    }
    if (key) out[key] = value.trim();
  }
  return out;
}

/** A master playlist lists other playlists; a media playlist lists segments. */
export function isMaster(text) {
  return /^#EXT-X-STREAM-INF:/m.test(String(text || ''));
}

export function looksLikePlaylist(text) {
  return /^\s*#EXTM3U/.test(String(text || ''));
}

const resolve = (uri, base) => {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
};

const lines = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Variants and their alternate audio.
 *
 * `#EXT-X-STREAM-INF` carries the properties; the URI is on the *next*
 * non-empty line, which is why this walks with an index rather than mapping.
 */
export function parseMaster(text, baseUrl) {
  const rows = lines(text);
  const variants = [];
  const audio = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];

    if (row.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(row.slice('#EXT-X-MEDIA:'.length));
      // One with no URI is still listed, with a null url: it says the audio
      // of its group is inside the variants, which is what decides whether a
      // sibling with a URI is the soundtrack or only an alternative to it.
      if (attrs.TYPE === 'AUDIO') {
        audio.push({
          url: attrs.URI ? resolve(attrs.URI, baseUrl) : null,
          group: attrs['GROUP-ID'] || '',
          name: attrs.NAME || '',
          language: attrs.LANGUAGE || '',
          default: attrs.DEFAULT === 'YES',
        });
      }
      continue;
    }

    if (!row.startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = rows[i + 1];
    if (!uri || uri.startsWith('#')) continue;
    i += 1;

    const attrs = parseAttributes(row.slice('#EXT-X-STREAM-INF:'.length));
    const [width, height] = String(attrs.RESOLUTION || '').split('x').map((n) => parseInt(n, 10));
    variants.push({
      url: resolve(uri, baseUrl),
      bandwidth: parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || '0', 10) || null,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      codecs: attrs.CODECS || '',
      audioGroup: attrs.AUDIO || '',
    });
  }

  // Best first, so "pick the first one that fits" is the whole selection rule.
  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  return { variants, audio };
}

/**
 * One rendition's segments.
 *
 * `#EXT-X-MAP` is the fMP4 initialisation segment and has to be written first
 * or the result is not a playable file. `#EXT-X-BYTERANGE` means several
 * segments share one URL, so the range has to ride along with each.
 *
 * A playlist may change its map part-way — an ad break spliced in with its
 * own encoding, after an `#EXT-X-DISCONTINUITY`. Joined into one file only one
 * of them can lead it (ffmpeg skips a second `moov`), so the one reported is
 * the map that covers the most of the running time, not merely the last one
 * seen: the programme plays and the break is what suffers, rather than the
 * other way round. `inits` lists each distinct map, so a caller can tell.
 */
export function parseMedia(text, baseUrl) {
  const rows = lines(text);
  const segments = [];
  /** Distinct maps, by address and range, and how many seconds each one leads. */
  const inits = new Map();
  let init = null;
  let duration = 0;
  let pending = null;
  let range = null;
  let key = null;
  let mediaSequence = 0;
  let live = true;

  for (const row of rows) {
    if (row.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(row.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      continue;
    }
    if (row.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(row.slice('#EXT-X-MAP:'.length));
      if (!attrs.URI) continue;
      const url = resolve(attrs.URI, baseUrl);
      const span = parseByteRange(attrs.BYTERANGE, null);
      const id = `${url} ${span ? `${span.offset}+${span.length}` : ''}`;
      if (!inits.has(id)) inits.set(id, { url, range: span, seconds: 0 });
      init = inits.get(id);
      continue;
    }
    if (row === '#EXT-X-PLAYLIST-TYPE:VOD') {
      // VOD is a promise that the playlist will not change, which makes it
      // finished whether or not the packager remembered the ENDLIST.
      live = false;
      continue;
    }
    if (row.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(row.slice('#EXT-X-KEY:'.length));
      key =
        !attrs.METHOD || attrs.METHOD === 'NONE'
          ? null
          : { method: attrs.METHOD, url: attrs.URI ? resolve(attrs.URI, baseUrl) : '', iv: attrs.IV || '' };
      continue;
    }
    if (row.startsWith('#EXTINF:')) {
      pending = parseFloat(row.slice('#EXTINF:'.length)) || 0;
      continue;
    }
    if (row.startsWith('#EXT-X-BYTERANGE:')) {
      range = parseByteRange(row.slice('#EXT-X-BYTERANGE:'.length), segments[segments.length - 1]);
      continue;
    }
    if (row === '#EXT-X-ENDLIST') {
      live = false;
      continue;
    }
    if (row.startsWith('#')) continue;

    segments.push({
      url: resolve(row, baseUrl),
      duration: pending || 0,
      range,
      key,
      // AES-128 derives a per-segment IV from the media sequence number when
      // the playlist does not state one, so each segment needs to know its own.
      sequence: mediaSequence + segments.length,
    });
    duration += pending || 0;
    // A segment with no stated duration still counts, so a map is never
    // outweighed for want of #EXTINF.
    if (init) init.seconds += pending || 1;
    pending = null;
    range = null;
  }

  const maps = [...inits.values()];
  const lead = maps.reduce((best, map) => (!best || map.seconds > best.seconds ? map : best), null);

  return {
    segments,
    initUrl: lead?.url || null,
    initRange: lead?.range || null,
    inits: maps.map(({ url, range }) => ({ url, range })),
    duration,
    // A playlist with no #EXT-X-ENDLIST is still being written to. Downloading
    // it would never finish on its own, so the caller has to be told.
    isLive: live && segments.length > 0,
    encryption: segments.find((segment) => segment.key)?.key?.method || null,
  };
}

/** `#EXT-X-BYTERANGE:1200@4096` — the offset is optional and then continues the last. */
function parseByteRange(value, previous) {
  if (!value) return null;
  const [lengthText, offsetText] = String(value).split('@');
  const length = parseInt(lengthText, 10);
  if (!Number.isFinite(length)) return null;
  const offset = offsetText !== undefined
    ? parseInt(offsetText, 10)
    : previous?.range
      ? previous.range.offset + previous.range.length
      : 0;
  return { offset: Number.isFinite(offset) ? offset : 0, length };
}

/**
 * The IV for an AES-128 segment.
 *
 * When the playlist gives none, the spec says to use the segment's sequence
 * number as a 128-bit big-endian integer.
 */
export function segmentIv(segment) {
  const iv = new Uint8Array(16);
  const stated = segment.key?.iv || '';
  if (/^0x[0-9a-f]{32}$/i.test(stated)) {
    for (let i = 0; i < 16; i += 1) iv[i] = parseInt(stated.slice(2 + i * 2, 4 + i * 2), 16);
    return iv;
  }
  let sequence = segment.sequence >>> 0;
  for (let i = 15; i >= 12; i -= 1) {
    iv[i] = sequence & 0xff;
    sequence >>>= 8;
  }
  return iv;
}
