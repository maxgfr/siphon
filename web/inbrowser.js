/**
 * A backend that is not a backend.
 *
 * Everything the server mode does over HTTP — accept a job, report progress,
 * hand back a file — this does inside the tab, against the same interface, so
 * app.js cannot tell the difference and none of the queue code changes. The
 * job table is a Map instead of a process pool, "the file is on disk" means
 * the origin private file system instead of a temp directory, and the work
 * happens in `runJob` instead of yt-dlp.
 *
 * What it cannot do is pretend the browser's rules away. Hosts that send no
 * cross-origin headers are unreadable from a page, full stop; the relay is the
 * user's answer to that if they want one, and the failure says so if they do
 * not. See README for where the line falls.
 */
import { BackendError } from './errors.js';
import { Fetcher } from './net.js';
import { extract, planDownload, safeFilename, MIME_FOR } from './extract.js';
import { parseMedia, segmentIv } from './m3u8.js';
import { ensureFfmpeg, isLoaded, mux, toAudio, setCoreUrl } from './media.js';
import * as store from './store.js';

/** Matches the server's default, and for the same reason: bounded disk use. */
const FILE_TTL_MS = 3600_000;

/** How long a probe's work is reused, so tapping Download does not redo it. */
const PROBE_TTL_MS = 120_000;

const nowSeconds = () => Date.now() / 1000;

export class BrowserBackend {
  /**
   * @param {object} options
   * @param {string} [options.coreUrl]  where ffmpeg.wasm is fetched from
   * @param {import('./net.js').Escape|null} [options.escape]  a relay or a server tunnel, for hosts that refuse the page
   * @param {import('./extract.js').Resolver[]} [options.resolvers]  who to ask when this page cannot read a link
   */
  constructor({ coreUrl = '', escape = null, resolvers = [] } = {}) {
    this.mode = 'browser';
    this.supportsProgress = true;
    this.supportsProbe = true;
    // One video at a time is the honest answer here: a playlist would mean
    // holding several files in one tab, and the zip the server builds has
    // nowhere to be built.
    this.supportsPlaylist = false;
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    this.configure({ coreUrl, escape, resolvers });

    // Clear out whatever a previous session left behind. Nothing is spared:
    // the server sweeps finished files on the same clock and a restored row
    // whose file is gone says so, which is the behaviour being matched.
    store.sweep(FILE_TTL_MS);
  }

  /**
   * Take another way in — a new helper saved in settings — keeping the jobs.
   *
   * A job already running holds the Fetcher and the formats it started with,
   * so it finishes the way it began; only what starts next goes the new way.
   * What a probe learned is dropped, since another helper may read the same
   * link differently.
   */
  configure({ coreUrl = '', escape = null, resolvers = [] } = {}) {
    this.net = new Fetcher({ escape });
    this.resolvers = resolvers.filter(Boolean);
    this.cache = new Map();
    if (coreUrl) setCoreUrl(coreUrl);
    return this;
  }

  async health() {
    return {
      ok: true,
      label: 'in this browser',
      ffmpeg: true, // fetched on demand; absence is a download failure, not a missing dependency
      presets: null,
      escape: this.net.escape?.name || null,
      bridge: this.net.hasBridge,
      resolvers: this.resolvers.map((resolver) => resolver.name),
      converterLoaded: isLoaded(),
    };
  }

  /**
   * Identify a link, reusing the probe's work when the user downloads it.
   *
   * Not private, because the job runner below is a module function rather than
   * a method — the work is long enough that keeping it out of the class body
   * is worth more than the encapsulation.
   */
  async identify(url, signal) {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;
    const value = await extract(url, { net: this.net, signal, resolvers: this.resolvers });
    this.cache.set(url, { at: Date.now(), value });
    return value;
  }

  async probe(url) {
    const info = await this.identify(url);
    const playlist = info.playlist || null;
    return {
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail,
      extractor: info.extractor,
      isLive: info.isLive,
      isPlaylist: Boolean(playlist),
      count: playlist?.count ?? 1,
      limit: playlist?.limit ?? 1,
      // The addresses themselves, because a tab takes a playlist one video at
      // a time rather than as the zip a full server builds.
      entries: playlist?.entries || [],
      subtitles: info.subtitles || [],
    };
  }

  async start(url, preset, { subs = 'off', subLangs = 'en' } = {}) {
    const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    const job = {
      id,
      url,
      preset,
      state: 'running',
      stage: 'starting',
      progress: 0,
      speed: null,
      eta: null,
      totalBytes: null,
      title: null,
      filename: null,
      error: null,
      subs,
      subLangs,
      note: subs === 'files' ? 'Subtitles as a separate file need your own server; this embeds them instead.' : null,
      controller,
      objectUrl: null,
      startedAt: Date.now(),
    };
    this.jobs.set(id, job);
    runJob(this, job).catch((error) => {
      job.state = 'error';
      job.stage = 'failed';
      job.error = error instanceof BackendError ? [error.message, error.hint].filter(Boolean).join(' ') : String(error?.message || error);
    });
    return { kind: 'job', id };
  }

  /**
   * Report on a job — including one this session never started.
   *
   * After a reload the job table is empty but the file may still be in OPFS,
   * which is exactly the case the server answers with "still here". Matching
   * that is what makes a restored row show its Save button again.
   */
  async poll(id) {
    const job = this.jobs.get(id);
    if (!job) {
      const blob = await store.get(id);
      if (!blob) throw new BackendError('No such download.');
      const restored = {
        id,
        state: 'done',
        stage: 'ready',
        progress: 1,
        totalBytes: blob.size,
        objectUrl: URL.createObjectURL(blob),
      };
      this.jobs.set(id, restored);
      return snapshot(restored);
    }
    if (job.state === 'done' && !job.objectUrl) {
      const blob = await store.get(id);
      if (blob) job.objectUrl = URL.createObjectURL(blob);
    }
    return snapshot(job);
  }

  fileUrl(id) {
    return this.jobs.get(id)?.objectUrl || '';
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return Promise.resolve();
    job.controller?.abort();
    if (job.objectUrl) URL.revokeObjectURL(job.objectUrl);
    this.jobs.delete(id);
    return store.drop(id);
  }
}

function snapshot(job) {
  return {
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    totalBytes: job.totalBytes,
    filename: job.filename,
    title: job.title,
    note: job.note,
    error: job.error,
    client: job.client,
    attempts: 0,
  };
}

/* -------------------------------------------------------------------- the work */

async function runJob(backend, job) {
  const { net } = backend;
  const signal = job.controller.signal;

  const info = await backend.identify(job.url, signal);
  job.title = info.title;
  job.client = info.extractor;
  if (info.isLive) {
    throw new BackendError('That is a live stream, which has no end to download to.', { retryable: false });
  }

  const plan = planDownload(info, job.preset);
  const resolve = info.resolve || ((format) => format.url);

  // Subtitles are a video concern, and embedding one means a remux — so a
  // download that would otherwise have needed no conversion now does. That is
  // the cost of asking for them, and it is only paid when a track was actually
  // found.
  const subtitle = job.subs !== 'off' && plan.video ? pickSubtitle(info.subtitles, job.subLangs) : null;
  if (subtitle && plan.op === 'raw') plan.op = 'copy';
  if (job.subs !== 'off' && plan.video && !subtitle) {
    job.note = 'No subtitles were offered for this video.';
  }

  // Two tracks share one bar. Weighting by stated size is right when the sizes
  // are known and a 50/50 split is the least-wrong guess when they are not.
  const tracks = [plan.video, plan.audio].filter(Boolean);
  const sizes = tracks.map((track) => track.filesize || 0);
  const known = sizes.every(Boolean);
  const weights = known
    ? sizes.map((size) => size / sizes.reduce((a, b) => a + b, 0))
    : tracks.map(() => 1 / tracks.length);

  job.stage = 'downloading';
  job.totalBytes = known ? sizes.reduce((a, b) => a + b, 0) : null;

  // The common case — a file that needs no conversion — goes straight to disk
  // as it arrives, so a two-hour video never exists in the tab's heap. Anything
  // ffmpeg has to touch must be handed to it whole, and there the size is worth
  // warning about rather than pretending away.
  if (plan.op === 'raw') return await runRaw(net, job, info, plan, resolve);

  // What each track will weigh: its stated size, or for a stream, what its
  // playlist and then its segments suggest (see downloadHls). The total —
  // and with it the row's percentage, its time left and this warning — is
  // there as soon as every track has one.
  const expected = [...sizes];
  let warned = false;
  const reckon = () => {
    if (expected.every(Boolean)) job.totalBytes = expected.reduce((a, b) => a + b, 0);
    if (!warned && expected.reduce((a, b) => a + b, 0) > HEAVY_CONVERSION_BYTES) {
      warned = true;
      job.note = 'Large file: converting it here needs it in memory, which a phone may not have. Your own server does this on disk.';
    }
  };
  reckon();

  const started = nowSeconds();
  let doneWeight = 0;
  let bytesSoFar = 0;

  const fetched = [];
  for (const [index, track] of tracks.entries()) {
    const base = doneWeight;
    const weight = weights[index];
    let trackBytes = 0;

    /** How far through this track we are, whatever unit the source counts in. */
    const advance = (fraction) => {
      job.progress = Math.min(0.99, base + weight * Math.min(1, Math.max(0, fraction)));
    };

    /** Speed and ETA are only meaningful in bytes, so only the byte path sets them. */
    const countBytes = (received) => {
      trackBytes = received;
      const elapsed = nowSeconds() - started;
      if (elapsed <= 0.6) return;
      const overall = bytesSoFar + trackBytes;
      job.speed = overall / elapsed;
      if (job.totalBytes && job.speed > 0) job.eta = Math.max(0, (job.totalBytes - overall) / job.speed);
    };

    const url = await resolve(track);
    const data =
      track.protocol === 'hls'
        ? await downloadHls(url, {
            net,
            signal,
            bitrate: track.bitrate,
            onSegment: (done, count) => advance(done / count),
            onBytes: (received) => countBytes(received),
            onEstimate: (bytes) => {
              expected[index] = bytes;
              reckon();
            },
            onNote: (note) => {
              job.note = note;
            },
          })
        : await net.bytes(url, {
            signal,
            onProgress: (received, total) => {
              countBytes(received);
              if (total) advance(received / total);
            },
          });

    fetched.push({ track, data, ext: sourceExt(track) });
    bytesSoFar += data.length;
    doneWeight = base + weight;
    job.progress = Math.min(0.99, doneWeight);
  }

  if (signal.aborted) return;

  const tags = {
    title: info.title || '',
    artist: info.uploader || '',
    comment: info.url || job.url,
  };

  // Everything that reaches here needs ffmpeg; the raw path returned above.
  job.stage = 'processing';
  job.progress = 0;
  job.speed = null;
  job.eta = null;
  await ensureFfmpeg();
  const onProgress = (ratio) => {
    job.progress = ratio;
  };

  let output;
  if (plan.op === 'copy') {
    // Fetched before the muxer is handed anything: a subtitle that could not
    // be downloaded must leave the video alone, not take it down with it.
    const subtitleBytes = subtitle ? await subtitleData(net, subtitle, signal) : null;
    if (subtitle && !subtitleBytes) job.note = 'The subtitles could not be fetched, so the video has none.';
    output = await mux({
      video: fetched.find((item) => item.track === plan.video),
      audio: fetched.find((item) => item.track === plan.audio),
      subtitle: subtitleBytes ? { ...subtitle, data: subtitleBytes } : null,
      ext: plan.ext,
      tags,
      onProgress,
      signal,
    });
  } else {
    const source = fetched[0];
    const cover = await coverArt(net, info, signal);
    output = await toAudio({
      source,
      ext: plan.ext,
      copy: plan.op === 'audio-copy',
      tags,
      cover,
      onProgress,
      signal,
    });
  }

  if (signal.aborted) return;

  const blob = new Blob([output], { type: plan.mime || MIME_FOR[plan.ext] || 'application/octet-stream' });
  // Once the file is on disk, the Save link points there: a blob URL keeps
  // whatever it was made from alive until it is revoked, and this one would
  // otherwise hold the whole converted file in memory until the row goes.
  const stored = (await store.put(job.id, blob)) ? await store.get(job.id) : null;

  job.filename = safeFilename(info.title, plan.ext);
  job.totalBytes = blob.size;
  job.objectUrl = URL.createObjectURL(stored ? stored.slice(0, stored.size, blob.type) : blob);
  job.progress = 1;
  job.stage = 'ready';
  job.state = 'done';
}

/**
 * Above this, a conversion is worth a warning: ffmpeg.wasm needs the whole
 * input and the whole output in memory at once, and a phone will not have it.
 * Not a refusal — it is the user's device and their call — but not a surprise
 * either.
 */
const HEAVY_CONVERSION_BYTES = 500 * 1024 * 1024;

/**
 * A download that needs nothing done to it.
 *
 * Bytes off the socket go to disk and nowhere else: no array of chunks, no
 * concatenated copy, no Blob built from either. What the heap holds at any
 * moment is one chunk. This is the path a plain MP4 takes, which is most of
 * them.
 */
async function runRaw(net, job, info, plan, resolve) {
  const signal = job.controller.signal;
  const sink = await store.writer(job.id);
  const started = nowSeconds();

  try {
    const url = await resolve(plan.video || plan.audio);
    await net.stream(url, {
      signal,
      onChunk: (chunk) => sink.write(chunk),
      onReset: () => sink.reset(),
      onProgress: (received, total) => {
        const elapsed = nowSeconds() - started;
        if (elapsed > 0.6) {
          job.speed = received / elapsed;
          if (total && job.speed > 0) job.eta = Math.max(0, (total - received) / job.speed);
        }
        if (total) {
          job.totalBytes = total;
          job.progress = Math.min(0.99, received / total);
        }
      },
    });
  } catch (error) {
    await sink.abort();
    throw error;
  }

  if (signal.aborted) {
    await sink.abort();
    return;
  }

  const blob = await sink.done(plan.mime || MIME_FOR[plan.ext] || 'application/octet-stream');
  job.filename = safeFilename(info.title, plan.ext);
  job.totalBytes = blob.size;
  job.objectUrl = URL.createObjectURL(blob);
  job.progress = 1;
  job.stage = 'ready';
  job.state = 'done';
}

const sourceExt = (track) => (track.protocol === 'hls' ? 'ts' : track.container || 'mp4');

/**
 * Which subtitle track to embed, given what was asked for.
 *
 * The languages are a preference list, not a filter: someone who asked for
 * "fr,en" and is offered only English gets English rather than nothing, and a
 * written track always beats a machine one.
 */
export function pickSubtitle(tracks, langs = 'en') {
  const offered = (tracks || []).filter((track) => track?.url);
  if (offered.length === 0) return null;
  const wanted = String(langs || '')
    .split(',')
    .map((lang) => lang.trim().toLowerCase())
    .filter(Boolean);

  for (const lang of wanted) {
    // "en" should match "en-GB" and "en-orig" too; a site's spelling is its own.
    const matches = offered.filter((track) => String(track.lang || '').toLowerCase().startsWith(lang));
    const best = matches.find((track) => !track.auto) || matches[0];
    if (best) return best;
  }
  return offered.find((track) => !track.auto) || offered[0];
}

/**
 * Cover art, if the thumbnail host will give it to us.
 *
 * Worth attempting because an untagged MP3 lands in a music library as a blank
 * square, and worth giving up on silently because a missing picture is not a
 * reason to fail a download that otherwise worked.
 */
/**
 * A subtitle file, or nothing.
 *
 * A missing subtitle must not fail a download that otherwise worked — the
 * video is what was asked for — so this swallows its own failure the way the
 * cover art does, and says so in the row.
 *
 * What is embedded is WebVTT, and only that is let through. ffmpeg handed
 * anything else under a .vtt name — TTML, an error page — makes an empty
 * track of it without complaint, and the video would carry a subtitle menu
 * entry that never shows a word.
 */
export async function subtitleData(net, subtitle, signal) {
  let data;
  try {
    data = await net.bytes(subtitle.url, { signal });
  } catch {
    return null;
  }
  // The decoder drops a byte-order mark, which WebVTT allows before its name.
  return new TextDecoder().decode(data.subarray(0, 16)).startsWith('WEBVTT') ? data : null;
}

async function coverArt(net, info, signal) {
  if (!info.thumbnail) return null;
  try {
    return await net.bytes(info.thumbnail, { signal });
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------- HLS */

/**
 * Fetch every segment of one rendition and join them.
 *
 * Both HLS flavours concatenate: MPEG-TS is self-synchronising by design, and
 * fMP4 is an init segment followed by fragments, which is a valid file as it
 * stands. So this produces one buffer and ffmpeg only has to change the
 * container, never re-encode.
 *
 * The bar is driven by segments, because a segment playlist states no total
 * size and a byte percentage would have to be invented. The running byte count
 * is reported separately, since that one is real and gives an honest speed.
 *
 * The size is still worth guessing — a time left needs one, and so does the
 * warning that a two-hour stream will not fit in a phone's memory — and it is
 * reported as an estimate: the bitrate the master playlist gave times the
 * running time to begin with, then what the segments so far weigh, scaled up
 * to the whole running time.
 */
async function downloadHls(url, { net, signal, bitrate = null, onSegment, onBytes, onEstimate, onNote }) {
  // Segments are relative to where the playlist landed, which a redirect moves.
  const playlist = await net.document(url, { signal });
  const media = parseMedia(playlist.text, playlist.url);

  if (media.segments.length === 0) throw new BackendError('That stream listed no segments.', { retryable: false });
  if (media.isLive) {
    throw new BackendError('That is a live stream, which has no end to download to.', { retryable: false });
  }
  if (media.encryption && media.encryption !== 'AES-128') {
    throw new BackendError(`That stream is protected with ${media.encryption}.`, {
      hint: 'Only plain AES-128 can be decrypted here; anything else is DRM.',
      retryable: false,
    });
  }

  const parts = [];
  let total = 0;
  const keep = (bytes) => {
    parts.push(bytes);
    total += bytes.length;
    onBytes?.(total);
  };

  if (media.initUrl) {
    const init = await net.bytes(media.initUrl, { signal, range: media.initRange });
    // Several maps with the same bytes under different names are one map.
    // Different bytes mean the stream changes encoding part-way, and a copy
    // into one file can only follow one of them: the parser chose the one
    // that leads most of the running time, and the row says the rest may not
    // play rather than letting it be found out later.
    if (media.inits.length > 1) {
      const others = await Promise.all(
        media.inits
          .filter((map) => map.url !== media.initUrl || map.range !== media.initRange)
          .map((map) => net.bytes(map.url, { signal, range: map.range })),
      );
      if (others.some((bytes) => bytes.length !== init.length || bytes.some((byte, i) => byte !== init[i]))) {
        onNote?.('This stream changes encoding part-way (an ad break, usually); the main part plays, the rest may not.');
      }
    }
    keep(init);
  }

  const keys = new Map();
  const count = media.segments.length;
  if (bitrate && media.duration) onEstimate?.(Math.round((bitrate * media.duration) / 8));
  let seconds = 0;

  for (const [index, segment] of media.segments.entries()) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    let bytes = await net.bytes(segment.url, { signal, range: segment.range });
    if (segment.key) bytes = await decryptSegment(bytes, segment, keys, net, signal);
    keep(bytes);
    seconds += segment.duration;
    onEstimate?.(Math.round(seconds && media.duration ? (total / seconds) * media.duration : (total / (index + 1)) * count));
    onSegment?.(index + 1, count);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function decryptSegment(bytes, segment, keys, net, signal) {
  const keyUrl = segment.key.url;
  if (!keyUrl) throw new BackendError('That stream is encrypted but names no key.', { retryable: false });

  if (!keys.has(keyUrl)) {
    keys.set(
      keyUrl,
      net
        .bytes(keyUrl, { signal })
        .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt'])),
    );
  }
  const key = await keys.get(keyUrl);

  try {
    // HLS pads each segment with PKCS#7, which is what WebCrypto expects, so
    // no manual unpadding is needed here.
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: segmentIv(segment) }, key, bytes);
    return new Uint8Array(plain);
  } catch {
    throw new BackendError('That stream\'s key did not decrypt it.', {
      hint: 'It is probably DRM rather than plain AES-128.',
      retryable: false,
    });
  }
}
