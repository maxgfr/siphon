/**
 * A cobalt instance, asked for a file.
 *
 * cobalt checks every request against a strict schema, and anything outside
 * it gets one answer, error.api.invalid_body: a value it does not list is not
 * a preference it ignores, it is a download that fails. The stub here holds
 * the enums of cobalt's own api/src/processing/schema.js, and answers the way
 * api/src/core/api.js does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location ??= new URL('https://maxgfr.github.io/siphon/');
const { PRESETS, PublicBackend } = await import('../web/api.js');

const SCHEMA = {
  downloadMode: ['auto', 'audio', 'mute'],
  audioFormat: ['best', 'mp3', 'ogg', 'wav', 'opus'],
  audioBitrate: ['320', '256', '128', '96', '64', '8'],
  videoQuality: ['max', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144'],
  youtubeVideoCodec: ['h264', 'av1', 'vp9'],
  youtubeVideoContainer: ['auto', 'mp4', 'webm', 'mkv'],
  filenameStyle: ['classic', 'pretty', 'basic', 'nerdy'],
};

/** A fetch that answers as a cobalt instance would, or with `code` for every request. */
function instance({ code = '' } = {}) {
  const asked = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body);
    const fail = (reason) => new Response(JSON.stringify({ status: 'error', error: { code: reason } }), { status: 400 });
    if (code) return fail(code);
    // .strict(): a field it does not know is refused as surely as a value.
    for (const [field, value] of Object.entries(body)) {
      if (field === 'url') continue;
      if (!SCHEMA[field] || !SCHEMA[field].includes(value)) return fail('error.api.invalid_body');
    }
    return new Response(JSON.stringify({ status: 'tunnel', url: 'https://cobalt.example/tunnel?id=1', filename: 'clip' }), { status: 200 });
  };
  return { asked, fetchImpl };
}

async function withFetch(fetchImpl, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test('every quality the page offers is a request cobalt accepts', async () => {
  const { asked, fetchImpl } = instance();
  await withFetch(fetchImpl, async () => {
    for (const preset of PRESETS) {
      const started = await new PublicBackend({ base: 'https://cobalt.example' })
        .start('https://www.youtube.com/watch?v=jNQXAC9IVRw', preset.id)
        .catch((error) => error);
      assert.equal(started.kind, 'direct', `${preset.id}: ${started.message} ${JSON.stringify(asked.at(-1))}`);
    }
  });
  // M4A is cobalt's "best" audio: for YouTube, whose default codec is h264,
  // that is the AAC stream as it is, in an .m4a.
  assert.deepEqual(asked.find((body) => body.downloadMode === 'audio' && body.audioFormat !== 'mp3'), {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', downloadMode: 'audio', audioFormat: 'best',
  });
});

test('what an instance answers is a sentence, not its error code', async () => {
  // The codes docs/youtube.md recorded from the public instances, and the
  // ones a download through one most often meets.
  for (const code of [
    'error.api.youtube.login', 'error.api.auth.jwt.missing', 'error.api.invalid_body', 'error.api.fetch.fail',
    'error.api.fetch.empty', 'error.api.content.video.region', 'error.api.some.code.from.a.later.version',
  ]) {
    const error = await withFetch(instance({ code }).fetchImpl, () =>
      new PublicBackend({ base: 'https://cobalt.example' }).start('https://youtu.be/jNQXAC9IVRw', 'video_best').catch((e) => e));
    assert.match(error.message, /^[A-Z][^]*\.$/, `${code}: ${error.message}`);
    assert.notEqual(error.message, code, `${code} is shown as it came`);
  }
  // A key or a session is something settings can fix, and the row says so.
  const jwt = await withFetch(instance({ code: 'error.api.auth.jwt.missing' }).fetchImpl, () =>
    new PublicBackend({ base: 'https://cobalt.example' }).start('https://youtu.be/jNQXAC9IVRw', 'video_best').catch((e) => e));
  assert.match(jwt.hint, /key/);
  // A code this app has no sentence for is still named, so it can be looked up.
  const later = await withFetch(instance({ code: 'error.api.some.code.from.a.later.version' }).fetchImpl, () =>
    new PublicBackend({ base: 'https://cobalt.example' }).start('https://youtu.be/jNQXAC9IVRw', 'video_best').catch((e) => e));
  assert.match(later.message, /error\.api\.some\.code\.from\.a\.later\.version/);
});
