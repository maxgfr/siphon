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
  constructor({ relay = '', coreUrl = '', piped = '' } = {}) {
    this.net = new Fetcher({ relay });
    this.piped = String(piped || '').trim();
    this.mode = 'browser';
    this.supportsProgress = true;
    this.supportsProbe = true;
    // One video at a time is the honest answer here: a playlist would mean
    // holding several files in one tab, and the zip the server builds has
    // nowhere to be built.
    this.supportsPlaylist = false;
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    this.cache = new Map();
    if (coreUrl) setCoreUrl(coreUrl);

    // Clear out whatever a previous session left behind. Nothing is spared:
    // the server sweeps finished files on the same clock and a restored row
    // whose file is gone says so, which is the behaviour being matched.
    store.sweep(FILE_TTL_MS);
  }

  async health() {
    return {
      ok: true,
      label: 'in this browser',
      ffmpeg: true, // fetched on demand; absence is a download failure, not a missing dependency
      presets: null,
      relay: this.net.hasRelay,
      bridge: this.net.hasBridge,
      piped: Boolean(this.piped),
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
    const value = await extract(url, { net: this.net, signal, piped: this.piped });
    this.cache.set(url, { at: Date.now(), value });
    return value;
  }

  async probe(url) {
    const info = await this.identify(url);
    return {
      title: info.title,
      uploader: info.uploader,
      duration: info.duration,
      thumbnail: info.thumbnail,
      extractor: info.extractor,
      isLive: info.isLive,
      isPlaylist: false,
      count: 1,
      limit: 1,
    };
  }

  async start(url, preset, { subs = 'off' } = {}) {
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
      note: subs !== 'off' ? 'Subtitles need your own server.' : null,
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
            onSegment: (done, count) => advance(done / count),
            onBytes: (received) => countBytes(received),
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

  let output;
  if (plan.op === 'raw') {
    output = fetched[0].data;
  } else {
    job.stage = 'processing';
    job.progress = 0;
    job.speed = null;
    job.eta = null;
    await ensureFfmpeg();
    const onProgress = (ratio) => {
      job.progress = ratio;
    };

    if (plan.op === 'copy') {
      output = await mux({
        video: fetched.find((item) => item.track === plan.video),
        audio: fetched.find((item) => item.track === plan.audio),
        ext: plan.ext,
        tags,
        onProgress,
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
      });
    }
  }

  if (signal.aborted) return;

  const blob = new Blob([output], { type: plan.mime || MIME_FOR[plan.ext] || 'application/octet-stream' });
  await store.put(job.id, blob);

  job.filename = safeFilename(info.title, plan.ext);
  job.totalBytes = blob.size;
  job.objectUrl = URL.createObjectURL(blob);
  job.progress = 1;
  job.stage = 'ready';
  job.state = 'done';
}

const sourceExt = (track) => (track.protocol === 'hls' ? 'ts' : track.container || 'mp4');

/**
 * Cover art, if the thumbnail host will give it to us.
 *
 * Worth attempting because an untagged MP3 lands in a music library as a blank
 * square, and worth giving up on silently because a missing picture is not a
 * reason to fail a download that otherwise worked.
 */
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
 */
async function downloadHls(url, { net, signal, onSegment, onBytes }) {
  const media = parseMedia(await net.text(url, { signal }), url);

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

  if (media.initUrl) keep(await net.bytes(media.initUrl, { signal, range: media.initRange }));

  const keys = new Map();
  const count = media.segments.length;

  for (const [index, segment] of media.segments.entries()) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    let bytes = await net.bytes(segment.url, { signal, range: segment.range });
    if (segment.key) bytes = await decryptSegment(bytes, segment, keys, net, signal);
    keep(bytes);
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
