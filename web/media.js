/**
 * The parts of the job that are not fetching: merging, remuxing, tagging.
 *
 * ffmpeg.wasm is real and does this properly, but it is a 32 MB download and a
 * pass over the whole file, so the rule here is that it is never loaded until
 * a job actually needs it. A progressive MP4 at the requested height needs
 * nothing: the bytes that arrive are the file. Separate video and audio
 * streams, an HLS ladder, or an MP3 request do need it, and then it is worth
 * the wait — and the UI says what it is waiting for.
 */
import { BackendError } from './errors.js';

/**
 * Where the wasm core comes from.
 *
 * Overridable because there are three good reasons to move it: testing against
 * a local copy, self-hosting rather than depending on a CDN, and pinning a
 * different build. The default is an exact version — a floating tag would mean
 * the app changes under the user without a deploy.
 */
export const DEFAULT_CORE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js';

let coreUrl = DEFAULT_CORE_URL;
let worker = null;
let loading = null;
let nextId = 1;

export function setCoreUrl(url) {
  const next = String(url || '').trim() || DEFAULT_CORE_URL;
  if (next === coreUrl) return;
  coreUrl = next;
  // A different core means the loaded one is wrong; drop it rather than
  // silently keeping the old build alive for the rest of the session.
  worker?.terminate();
  worker = null;
  loading = null;
}

export const isLoaded = () => Boolean(worker) && !loading;

const pending = new Map();
/** Progress listeners by run id, so two queued jobs cannot drive each other's bar. */
const watchers = new Map();

function spawn() {
  const created = new Worker(new URL('./ffmpeg-worker.js', import.meta.url));
  created.onmessage = (event) => {
    const { id, type, progress, message, data } = event.data || {};
    if (type === 'progress') {
      // Emscripten reports a ratio that can overshoot slightly on the last
      // frame; clamping keeps the bar from reading 104%.
      if (Number.isFinite(progress)) watchers.get(id)?.(Math.max(0, Math.min(1, progress)));
      return;
    }
    if (type === 'log') return;
    const settle = pending.get(id);
    if (!settle) return;
    pending.delete(id);
    if (type === 'error') settle.reject(new BackendError(`Converting failed: ${message}`));
    else settle.resolve(data);
  };
  created.onerror = () => {
    for (const settle of pending.values()) settle.reject(new BackendError('The converter stopped unexpectedly.'));
    pending.clear();
    watchers.clear();
  };
  return created;
}

function send(type, payload, transfer, onProgress) {
  const id = nextId++;
  if (onProgress) watchers.set(id, onProgress);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload }, transfer || []);
  }).finally(() => watchers.delete(id));
}

/** Load the core, at most once, however many jobs ask at the same time. */
export async function ensureFfmpeg() {
  if (isLoaded()) return;
  if (!loading) {
    worker = worker || spawn();
    loading = send('load', {
      coreURL: coreUrl,
      // The core is published as a trio of files side by side, so the other two
      // are derived rather than configured separately.
      wasmURL: coreUrl.replace(/\.js(\?.*)?$/, '.wasm$1'),
      workerURL: coreUrl.replace(/\.js(\?.*)?$/, '.worker.js$1'),
    })
      .then(() => {
        loading = null;
      })
      .catch((error) => {
        loading = null;
        worker?.terminate();
        worker = null;
        throw new BackendError('Could not load the in-browser converter.', {
          hint: `ffmpeg.wasm is fetched on first use. (${error?.message || error})`,
        });
      });
  }
  return loading;
}

/**
 * Run one ffmpeg invocation.
 *
 * Inputs are transferred rather than copied — the caller must not touch the
 * arrays afterwards — because copying a 300 MB video to hand it over is the
 * difference between working and an out-of-memory tab on a phone.
 */
async function transform({ inputs, args, output, onProgress }) {
  await ensureFfmpeg();
  return send('run', { inputs, args, output }, inputs.map((input) => input.data.buffer), onProgress);
}

const metadataArgs = (tags = {}) =>
  Object.entries(tags)
    .filter(([, value]) => value)
    .flatMap(([key, value]) => ['-metadata', `${key}=${String(value).slice(0, 200)}`]);

/**
 * Put a video track and an audio track into one playable file.
 *
 * One track is the same job: a pile of HLS segments handed in as `video` comes
 * out as a container a player will open, which is all remuxing a stream is.
 *
 * `-c copy` throughout: nothing is re-encoded, so this is bounded by how fast
 * wasm can shuffle bytes rather than by how fast it can compress them.
 * `+faststart` moves the index to the front, which is what lets a phone's
 * player start the file without reading all of it first.
 */
export async function mux({ video, audio, subtitle = null, ext = 'mp4', tags = {}, onProgress }) {
  const inputs = [];
  const args = [];
  const index = { video: -1, audio: -1, subtitle: -1 };
  if (video) {
    index.video = inputs.length;
    inputs.push({ name: `video.${video.ext || 'mp4'}`, data: video.data });
    args.push('-i', `video.${video.ext || 'mp4'}`);
  }
  if (audio) {
    index.audio = inputs.length;
    inputs.push({ name: `audio.${audio.ext || 'm4a'}`, data: audio.data });
    args.push('-i', `audio.${audio.ext || 'm4a'}`);
  }
  if (subtitle) {
    index.subtitle = inputs.length;
    inputs.push({ name: `subs.${subtitle.ext || 'vtt'}`, data: subtitle.data });
    args.push('-i', `subs.${subtitle.ext || 'vtt'}`);
  }
  if (inputs.length === 0) throw new BackendError('Nothing to convert.');

  const output = `out.${ext}`;
  args.push('-c', 'copy');
  // With one input and nothing else, ffmpeg's own choice is right and saying
  // nothing is safest. Beyond that every wanted stream has to be named, or the
  // default picks one of each and silently drops the rest.
  if (video && audio) {
    args.push('-map', `${index.video}:v:0`, '-map', `${index.audio}:a:0`);
  } else if (inputs.length > 1) {
    // One media input carrying who-knows-what — a muxed MP4, a pile of HLS
    // segments — beside a subtitle. The trailing `?` means "if it is there",
    // which keeps an audio-less video and a video-less audio both working
    // without naming streams that do not exist.
    const media = video ? index.video : index.audio;
    args.push('-map', `${media}:v:0?`, '-map', `${media}:a:0?`);
  }
  if (subtitle) args.push('-map', `${index.subtitle}:s:0`);
  if (subtitle) {
    // MP4 carries text subtitles as mov_text and nothing else; WebVTT goes in
    // as-is elsewhere. The language tag is what makes a player's subtitle menu
    // say "English" instead of "Track 1".
    args.push('-c:s', ext === 'mp4' ? 'mov_text' : 'webvtt');
    if (subtitle.lang) args.push('-metadata:s:s:0', `language=${subtitle.lang.slice(0, 12)}`);
  }
  if (ext === 'mp4') args.push('-movflags', '+faststart');
  args.push(...metadataArgs(tags), '-y', output);

  return transform({ inputs, args, output, onProgress });
}

/**
 * Pull an audio-only file out of whatever arrived.
 *
 * `copy: true` is the case where the source is already AAC and the request was
 * M4A: changing the container keeps the original samples, where re-encoding
 * would throw away quality to arrive at the same format.
 */
export async function toAudio({ source, ext = 'mp3', copy = false, tags = {}, cover = null, onProgress }) {
  const inputs = [{ name: `source.${source.ext || 'mp4'}`, data: source.data }];
  const args = ['-i', `source.${source.ext || 'mp4'}`];

  if (cover) {
    inputs.push({ name: 'cover.jpg', data: cover });
    args.push('-i', 'cover.jpg');
  }

  if (copy) args.push('-c:a', 'copy');
  else if (ext === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');
  else args.push('-c:a', 'aac', '-b:a', '192k');

  if (cover) {
    // Map the still in as a second "video" stream marked as cover art, which is
    // how both MP3 and MP4 carry artwork. Without the disposition, players
    // treat it as a one-frame video and some refuse to play the file.
    //
    // Note there is deliberately no `-vn` here: it would discard the artwork
    // along with the source's video, which is the opposite of what was asked.
    // The explicit maps already drop everything that is not wanted.
    args.push('-map', '0:a:0', '-map', '1:v:0', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
    if (ext === 'mp3') args.push('-id3v2_version', '3');
  } else {
    args.push('-vn', '-map', '0:a:0');
  }

  const output = `out.${ext}`;
  args.push(...metadataArgs(tags), '-y', output);
  return transform({ inputs, args, output, onProgress });
}
