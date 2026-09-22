import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sniffUrl,
  sniffType,
  youtubeId,
  isYouTube,
  scrapePage,
  planDownload,
  pipedFormats,
  pipedSubtitles,
  invidiousFormats,
  invidiousSubtitles,
  invidiousResolver,
  invidiousWalk,
  safeFilename,
  titleFromUrl,
  extensionOf,
  innertubeFetch,
  extract,
} from '../web/extract.js';
import { BackendError } from '../web/errors.js';
import { Fetcher } from '../web/net.js';
import { pickSubtitle } from '../web/inbrowser.js';

/* ------------------------------------------------------------------ sniffing */

test('a media extension is recognised through a query string', () => {
  assert.equal(extensionOf('https://cdn.example/a/b/clip.mp4?token=1&x=.zip'), 'mp4');
  assert.deepEqual(sniffUrl('https://cdn.example/clip.mp4?t=1'), {
    protocol: 'progressive', container: 'mp4', kind: 'muxed',
  });
});

test('an .m3u8 is HLS, whatever else the URL says', () => {
  assert.equal(sniffUrl('https://cdn.example/v/master.m3u8').protocol, 'hls');
  assert.equal(sniffType('application/vnd.apple.mpegurl; charset=utf-8').protocol, 'hls');
});

test('audio extensions come back as audio, not as video', () => {
  assert.equal(sniffUrl('https://cdn.example/track.mp3').kind, 'audio');
  assert.equal(sniffType('audio/mpeg').kind, 'audio');
});

test('an unknown URL or content type sniffs to nothing rather than guessing', () => {
  assert.equal(sniffUrl('https://example.com/watch'), null);
  assert.equal(sniffType('text/html'), null);
});

/* ------------------------------------------------------------------- youtube */

test('every shape of YouTube link yields the same id', () => {
  const expected = 'dQw4w9WgXcQ';
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ]) {
    assert.equal(youtubeId(url), expected, url);
  }
});

test('a YouTube page with no video in it has no id', () => {
  assert.equal(youtubeId('https://www.youtube.com/@someone'), null);
  assert.equal(youtubeId('https://www.youtube.com/playlist?list=PL123'), null);
  // Still YouTube, though — which is what decides the error the user reads.
  assert.equal(isYouTube('https://www.youtube.com/@someone'), true);
});

test('a lookalike hostname is not YouTube', () => {
  assert.equal(isYouTube('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), false);
  assert.equal(youtubeId('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
});

/* ------------------------------------------------------------------ scraping */

test('a page\'s declared video beats one merely mentioned in a script', () => {
  const html = `
    <html><head>
      <meta property="og:video:secure_url" content="/media/declared.mp4" />
    </head><body>
      <script>var config = {"hls":"https:\\/\\/cdn.example\\/guessed.m3u8"};</script>
    </body></html>`;
  const found = scrapePage(html, 'https://site.example/watch/1');
  assert.equal(found[0].url, 'https://site.example/media/declared.mp4');
  assert.equal(found[0].source, 'og');
  assert.ok(found.some((item) => item.url === 'https://cdn.example/guessed.m3u8'));
});

test('a <source> inside <video> is found, and duplicates collapse', () => {
  const html = '<video poster="p.jpg"><source src="https://cdn.example/a.mp4"><source src="https://cdn.example/a.mp4"></video>';
  const found = scrapePage(html, 'https://site.example/');
  assert.equal(found.length, 1);
  assert.equal(found[0].source, 'element');
});

test('JSON-LD contentUrl is picked up', () => {
  const html = `<script type="application/ld+json">
    {"@type":"VideoObject","name":"x","contentUrl":"https://cdn.example/ld.mp4"}
  </script>`;
  const found = scrapePage(html, 'https://site.example/');
  assert.equal(found[0].url, 'https://cdn.example/ld.mp4');
  assert.equal(found[0].source, 'jsonld');
});

test('malformed JSON-LD does not stop the other routes', () => {
  const html = '<script type="application/ld+json">{ oops </script><video src="/v.mp4">';
  const found = scrapePage(html, 'https://site.example/');
  assert.equal(found[0].url, 'https://site.example/v.mp4');
});

test('non-http schemes are ignored', () => {
  const found = scrapePage('<video src="blob:https://site.example/abc"><source src="data:video/mp4,AAA">', 'https://site.example/');
  assert.deepEqual(found, []);
});

test('a stream named inside a path that ends in .mp4 is not cut off at the .mp4', () => {
  // Wowza names streams `…/mp4:clip.mp4/playlist.m3u8`; stopping at the first
  // `.mp4` makes an address that is not a file.
  const found = scrapePage('<script>var src = "https://wowza.example/vod/mp4:clip.mp4/playlist.m3u8";</script>', 'https://site.example/');
  assert.deepEqual(found.map((item) => item.url), ['https://wowza.example/vod/mp4:clip.mp4/playlist.m3u8']);
  const plain = scrapePage('<script>{"file":"https://cdn.example/a.mp4?token=1"}</script>', 'https://site.example/');
  assert.deepEqual(plain.map((item) => item.url), ['https://cdn.example/a.mp4?token=1']);
});

/* ------------------------------------------------------------------ planning */

const progressive = (id, height, extra = {}) => ({
  id, kind: 'muxed', protocol: 'progressive', container: 'mp4', height, bitrate: height * 1000,
  filesize: height * 10000, codecs: 'avc1.4d401f,mp4a.40.2', ...extra,
});
const videoOnly = (id, height, extra = {}) => ({
  id, kind: 'video', protocol: 'progressive', container: 'mp4', height, bitrate: height * 2000,
  filesize: height * 20000, codecs: 'avc1.640028', ...extra,
});
const audioOnly = (id, bitrate, extra = {}) => ({
  id, kind: 'audio', protocol: 'progressive', container: 'm4a', height: null, bitrate,
  filesize: bitrate * 100, codecs: 'mp4a.40.2', ...extra,
});

const from = (formats) => ({ formats, title: 't', url: 'https://x/y' });

test('a progressive file that meets the preset needs no converting at all', () => {
  const plan = planDownload(from([progressive('a', 720), progressive('b', 360)]), 'video_720');
  assert.equal(plan.op, 'raw');
  assert.equal(plan.video.id, 'a');
  assert.equal(plan.ext, 'mp4');
});

test('the preset is a ceiling, so 1080p is not served for a 720p request', () => {
  const plan = planDownload(from([progressive('big', 1080), progressive('fits', 720)]), 'video_720');
  assert.equal(plan.video.id, 'fits');
});

test('a sharper video-only stream wins over a lesser muxed one, and gets merged', () => {
  const plan = planDownload(
    from([progressive('muxed360', 360), videoOnly('v1080', 1080), audioOnly('a128', 128000)]),
    'video_best',
  );
  assert.equal(plan.op, 'copy');
  assert.equal(plan.video.id, 'v1080');
  assert.equal(plan.audio.id, 'a128');
  assert.equal(plan.ext, 'mp4');
});

test('a muxed file at the same height is preferred to merging, since merging costs a wasm load', () => {
  const plan = planDownload(
    from([progressive('muxed720', 720), videoOnly('v720', 720), audioOnly('a128', 128000)]),
    'video_720',
  );
  assert.equal(plan.op, 'raw');
  assert.equal(plan.video.id, 'muxed720');
});

test('an HLS variant is remuxed rather than handed over as .ts', () => {
  const plan = planDownload(
    from([{ id: 'hls-0', kind: 'muxed', protocol: 'hls', container: 'mp4', height: 720, bitrate: 1, filesize: null, codecs: '' }]),
    'video_best',
  );
  assert.equal(plan.op, 'copy');
  assert.equal(plan.ext, 'mp4');
});

test('MP3 always re-encodes, because no source is already an MP3 stream', () => {
  const plan = planDownload(from([videoOnly('v', 720), audioOnly('a', 128000)]), 'audio_mp3');
  assert.equal(plan.op, 'audio-encode');
  assert.equal(plan.audio.id, 'a');
  assert.equal(plan.ext, 'mp3');
  assert.equal(plan.video, null);
});

test('M4A from an AAC source changes the container instead of re-encoding it', () => {
  const plan = planDownload(from([audioOnly('aac', 128000)]), 'audio_m4a');
  assert.equal(plan.op, 'audio-copy');
  assert.equal(plan.ext, 'm4a');
});

test('M4A takes the AAC track out of a muxed file rather than re-encoding it', () => {
  const plan = planDownload(from([progressive('m', 720)]), 'audio_m4a');
  assert.equal(plan.op, 'audio-copy');
  assert.equal(plan.audio.id, 'm');
});

test('M4A re-encodes when the source codec is unknown, rather than guessing', () => {
  const plan = planDownload(from([progressive('m', 720, { codecs: '' })]), 'audio_m4a');
  assert.equal(plan.op, 'audio-encode');
});

test('M4A from an Opus source has to re-encode', () => {
  const plan = planDownload(
    from([audioOnly('opus', 160000, { container: 'webm', codecs: 'opus' })]),
    'audio_m4a',
  );
  assert.equal(plan.op, 'audio-encode');
});

test('the best audio is chosen by bitrate', () => {
  const plan = planDownload(from([audioOnly('low', 64000), audioOnly('high', 256000)]), 'audio_mp3');
  assert.equal(plan.audio.id, 'high');
});

test('audio can be taken from a muxed file when nothing audio-only is offered', () => {
  const plan = planDownload(from([progressive('m', 720)]), 'audio_mp3');
  assert.equal(plan.audio.id, 'm');
  assert.equal(plan.op, 'audio-encode');
});

test('when nothing fits the ceiling, the smallest available is used rather than failing', () => {
  const plan = planDownload(from([videoOnly('v1080', 1080), audioOnly('a', 128000)]), 'video_480');
  assert.equal(plan.video.id, 'v1080');
  assert.equal(plan.op, 'copy');
});

test('a direct audio file under a video preset is handed over as it is, not rewrapped as M4A', () => {
  // The default preset is "Best" video, and a link to an .mp3 is still the
  // file. An .m4a cannot hold MP3, FLAC, Opus, Vorbis or PCM, so rewrapping
  // failed outright for all of them, after loading the converter for nothing.
  for (const [container, codecs] of [['mp3', ''], ['flac', ''], ['opus', ''], ['ogg', ''], ['wav', ''], ['m4a', '']]) {
    const plan = planDownload(from([{ id: 'source', kind: 'audio', protocol: 'progressive', container, height: null, codecs }]), 'video_best');
    assert.equal(plan.op, 'raw', container);
    assert.equal(plan.ext, container);
    assert.equal(plan.audio.id, 'source');
  }
});

test('a portrait video meets the ceiling by its short side, as its label does', () => {
  // A Short is 1080x1920 and labelled 1080p. Measured by height, a 1080p
  // request was handed 480p, and a 720p one 360p.
  const portrait = (id, width, height) => videoOnly(id, height, { width });
  const formats = [portrait('1080p', 1080, 1920), portrait('720p', 720, 1280), portrait('480p', 480, 854), portrait('360p', 360, 640), audioOnly('a', 128000)];
  assert.equal(planDownload(from(formats), 'video_1080').video.id, '1080p');
  assert.equal(planDownload(from(formats), 'video_720').video.id, '720p');
  assert.equal(planDownload(from(formats), 'video_480').video.id, '480p');
});

test('a link with no formats is an error the user can read', () => {
  assert.throws(() => planDownload(from([]), 'video_best'), /no downloadable formats/i);
});

/* ------------------------------------------------------------------- naming */

test('a filename loses the characters a file system will not take', () => {
  assert.equal(safeFilename('a/b:c*d?"e<f>g|h', 'mp4'), 'a b c d e f g h.mp4');
  assert.equal(safeFilename('', 'mp3'), 'download.mp3');
});

test('a title falls back to the last path segment', () => {
  assert.equal(titleFromUrl('https://cdn.example/videos/my_holiday.mp4'), 'my holiday');
  assert.equal(titleFromUrl('https://cdn.example/'), 'cdn.example');
});

/* --------------------------------------------------------------------- piped */

const PIPED = {
  title: 'Me at the zoo',
  uploader: 'jawed',
  duration: 19,
  videoStreams: [
    { url: 'https://p.example/v720', format: 'MPEG_4', quality: '720p', mimeType: 'video/mp4', codec: 'avc1.64001f', videoOnly: true, bitrate: 1500000, contentLength: '3000000', width: 1280, height: 720 },
    { url: 'https://p.example/v360', format: 'MPEG_4', quality: '360p', mimeType: 'video/mp4', codec: 'avc1.42001e', videoOnly: false, bitrate: 600000, contentLength: '1200000', width: 640, height: 360 },
    { url: 'https://p.example/webm', format: 'WEBM', quality: '480p', mimeType: 'video/webm', codec: 'vp9', videoOnly: true, bitrate: 800000, contentLength: '1600000', width: 854, height: 480 },
  ],
  audioStreams: [
    { url: 'https://p.example/a128', format: 'M4A', quality: '128 kbps', mimeType: 'audio/mp4', codec: 'mp4a.40.2', bitrate: 128000, contentLength: '300000' },
    { url: 'https://p.example/opus', format: 'WEBM', quality: '160 kbps', mimeType: 'audio/webm', codec: 'opus', bitrate: 160000, contentLength: '380000' },
  ],
};

test('a Piped stream list maps onto the same Format shape InnerTube produces', () => {
  const formats = pipedFormats(PIPED);
  assert.equal(formats.length, 5);
  const v720 = formats.find((f) => f.url.endsWith('v720'));
  assert.equal(v720.kind, 'video');
  assert.equal(v720.container, 'mp4');
  assert.equal(v720.height, 720);
  assert.equal(v720.filesize, 3000000);
  assert.equal(v720.codecs, 'avc1.64001f');
});

test('the planner treats Piped streams by its usual rules: a sharper pair beats a lesser muxed file', () => {
  // 480p video-only + audio is a whole step above the 360p muxed stream, so
  // the pair is merged rather than the muxed file handed over.
  const plan = planDownload({ formats: pipedFormats(PIPED), title: 't', url: 'u' }, 'video_480');
  assert.equal(plan.op, 'copy');
  assert.equal(plan.video.url, 'https://p.example/webm');
  assert.equal(plan.audio.url, 'https://p.example/opus');
});

test('a muxed Piped stream is handed over raw when nothing sharper fits', () => {
  const only = { videoStreams: [PIPED.videoStreams[1]], audioStreams: PIPED.audioStreams };
  const plan = planDownload({ formats: pipedFormats(only), title: 't', url: 'u' }, 'video_480');
  assert.equal(plan.op, 'raw');
  assert.equal(plan.video.url, 'https://p.example/v360');
});

test('audio streams keep container and codec, so an AAC stream that wins is copied, not re-encoded', () => {
  const [aac] = pipedFormats({ audioStreams: [PIPED.audioStreams[0]] });
  assert.equal(aac.container, 'm4a');
  assert.equal(aac.codecs, 'mp4a.40.2');
  const plan = planDownload({ formats: [aac], title: 't', url: 'u' }, 'audio_m4a');
  assert.equal(plan.op, 'audio-copy');
});

test('the best audio is still chosen by bitrate, even when that means re-encoding Opus to AAC', () => {
  const plan = planDownload({ formats: pipedFormats(PIPED), title: 't', url: 'u' }, 'audio_m4a');
  assert.equal(plan.audio.url, 'https://p.example/opus');
  assert.equal(plan.op, 'audio-encode');
});

test('height falls back to the quality label when the instance omits it', () => {
  const [only] = pipedFormats({ videoStreams: [{ url: 'https://p.example/x', quality: '1080p', mimeType: 'video/mp4', videoOnly: true }] });
  assert.equal(only.height, 1080);
});

test('a stream with no URL is dropped rather than planned', () => {
  assert.deepEqual(pipedFormats({ videoStreams: [{ quality: '720p' }], audioStreams: [] }), []);
});

test('a Piped stream list carries its subtitle tracks in the shape the job runner embeds', () => {
  const tracks = pipedSubtitles({
    subtitles: [
      { url: 'https://p.example/subs/en', mimeType: 'text/vtt', name: 'English', code: 'en', autoGenerated: false },
      { url: 'https://p.example/subs/fr-auto', mimeType: 'text/vtt', name: 'French (auto)', code: 'fr', autoGenerated: true },
      { mimeType: 'text/vtt', name: 'no url', code: 'de' },
    ],
  });
  assert.deepEqual(tracks, [
    { lang: 'en', ext: 'vtt', url: 'https://p.example/subs/en', auto: false },
    { lang: 'fr', ext: 'vtt', url: 'https://p.example/subs/fr-auto', auto: true },
  ]);
  assert.equal(pickSubtitle(tracks, 'fr').url, 'https://p.example/subs/fr-auto');
});

/* ----------------------------------------------------------------- invidious */

/** What a real instance answers to /api/v1/videos/{id}?local=true, trimmed. */
const INVIDIOUS = {
  title: 'Me at the zoo',
  videoId: 'jNQXAC9IVRw',
  author: 'jawed',
  lengthSeconds: 19,
  liveNow: false,
  videoThumbnails: [{ quality: 'medium', url: '/vi/jNQXAC9IVRw/mqdefault.jpg', width: 320, height: 180 }],
  formatStreams: [
    { url: '/videoplayback?expire=1&itag=18', itag: '18', type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', quality: 'medium', bitrate: '600000', container: 'mp4', encoding: 'h264', qualityLabel: '360p', resolution: '360p', size: '640x360', fps: 30 },
  ],
  adaptiveFormats: [
    { url: '/videoplayback?expire=1&itag=140', itag: '140', type: 'audio/mp4; codecs="mp4a.40.2"', clen: '300000', bitrate: '130000', container: 'm4a', encoding: 'aac', audioQuality: 'AUDIO_QUALITY_MEDIUM', audioSampleRate: 44100, audioChannels: 2 },
    { url: '/videoplayback?expire=1&itag=251', itag: '251', type: 'audio/webm; codecs="opus"', clen: '380000', bitrate: '160000', container: 'webm', encoding: 'opus', audioQuality: 'AUDIO_QUALITY_MEDIUM' },
    { url: '/videoplayback?expire=1&itag=136', itag: '136', type: 'video/mp4; codecs="avc1.64001f"', clen: '3000000', bitrate: '1500000', container: 'mp4', encoding: 'h264', qualityLabel: '720p', resolution: '720p', size: '1280x720', fps: 30 },
    { url: '/videoplayback?expire=1&itag=244', itag: '244', type: 'video/webm; codecs="vp9"', clen: '1600000', bitrate: '800000', container: 'webm', encoding: 'vp9', qualityLabel: '480p', resolution: '480p', size: '854x480', fps: 30 },
  ],
  captions: [
    { label: 'English', language_code: 'en', url: '/api/v1/captions/jNQXAC9IVRw?label=English' },
    { label: 'French (auto-generated)', language_code: 'fr', url: '/api/v1/captions/jNQXAC9IVRw?label=French+%28auto-generated%29' },
  ],
};

test('an Invidious answer maps onto the same Format shape, with its relative URLs made whole', () => {
  const formats = invidiousFormats(INVIDIOUS, 'https://inv.example/');
  assert.equal(formats.length, 5);
  const muxed = formats.find((f) => f.kind === 'muxed');
  assert.equal(muxed.url, 'https://inv.example/videoplayback?expire=1&itag=18', 'resolved against the instance, one slash');
  assert.equal(muxed.container, 'mp4');
  assert.equal(muxed.height, 360);
  assert.equal(muxed.width, 640);
  assert.equal(muxed.bitrate, 600000, 'a string on the wire, a number here');
  assert.equal(muxed.codecs, 'avc1.42001E, mp4a.40.2');
  const v720 = formats.find((f) => f.url.endsWith('itag=136'));
  assert.equal(v720.kind, 'video');
  assert.equal(v720.height, 720);
  assert.equal(v720.filesize, 3000000);
  const aac = formats.find((f) => f.url.endsWith('itag=140'));
  assert.equal(aac.kind, 'audio');
  assert.equal(aac.container, 'm4a');
  assert.equal(aac.codecs, 'mp4a.40.2');
  assert.equal(aac.label, 'medium');
});

test('the planner treats Invidious streams by its usual rules', () => {
  // 720p video-only + audio is above the 360p muxed stream, so the pair wins.
  const best = planDownload({ formats: invidiousFormats(INVIDIOUS, 'https://inv.example'), title: 't', url: 'u' }, 'video_best');
  assert.equal(best.op, 'copy');
  assert.ok(best.video.url.endsWith('itag=136'));
  assert.ok(best.audio.url.endsWith('itag=251'), 'the higher-bitrate audio');
  // Capped at 480p, the 480p video-only track is still a step above 360p muxed.
  const capped = planDownload({ formats: invidiousFormats(INVIDIOUS, 'https://inv.example'), title: 't', url: 'u' }, 'video_480');
  assert.equal(capped.op, 'copy');
  // With only the muxed file on offer it is handed over raw — no ffmpeg.
  const small = planDownload({ formats: invidiousFormats({ formatStreams: INVIDIOUS.formatStreams }, 'https://inv.example'), title: 't', url: 'u' }, 'video_480');
  assert.equal(small.op, 'raw');
  // m4a from the AAC track is a container change, not a re-encode.
  const m4a = planDownload({ formats: invidiousFormats({ adaptiveFormats: [INVIDIOUS.adaptiveFormats[0]] }, 'https://inv.example'), title: 't', url: 'u' }, 'audio_m4a');
  assert.equal(m4a.op, 'audio-copy');
});

test('an absolute URL from an instance is left alone, and one with no URL is dropped', () => {
  const formats = invidiousFormats({
    formatStreams: [{ url: 'https://rr1.example/videoplayback?itag=18', type: 'video/mp4', size: '640x360' }, { type: 'video/mp4', size: '640x360' }],
  }, 'https://inv.example');
  assert.equal(formats.length, 1);
  assert.equal(formats[0].url, 'https://rr1.example/videoplayback?itag=18');
});

test('height falls back to the quality label when the size is missing', () => {
  const [only] = invidiousFormats({ adaptiveFormats: [{ url: '/v', type: 'video/mp4', qualityLabel: '1080p60' }] }, 'https://inv.example');
  assert.equal(only.height, 1080);
});

test('Invidious captions become subtitle tracks, machine ones told apart by their label', () => {
  const tracks = invidiousSubtitles(INVIDIOUS, 'https://inv.example');
  assert.deepEqual(tracks, [
    { lang: 'en', ext: 'vtt', url: 'https://inv.example/api/v1/captions/jNQXAC9IVRw?label=English', auto: false },
    { lang: 'fr', ext: 'vtt', url: 'https://inv.example/api/v1/captions/jNQXAC9IVRw?label=French+%28auto-generated%29', auto: true },
  ]);
  assert.equal(pickSubtitle(tracks, 'en').auto, false);
  assert.equal(invidiousSubtitles({}).length, 0);
});

/** A `net` whose json() answers from a table of URL prefix → body, and records the asks. */
function fakeNet(table) {
  const asked = [];
  return {
    asked,
    net: {
      json: async (url) => {
        asked.push(url);
        const hit = Object.entries(table).find(([prefix]) => url.startsWith(prefix));
        if (!hit) throw new Error(`could not reach ${url}`);
        const body = hit[1];
        if (body instanceof Error) throw body;
        return body;
      },
    },
  };
}

const WATCH = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const answers = (base) => ({ ...INVIDIOUS, formatStreams: [{ ...INVIDIOUS.formatStreams[0], url: `${base}/videoplayback?itag=18` }], adaptiveFormats: [] });

test('the resolver walks the bundled replicas when its instance is bot-walled, and names the one that answered', async () => {
  const { net, asked } = fakeNet({
    'https://first.example/': { error: "Sign in to confirm you're not a bot" },
    'https://second.example/': new Error('second.example answered 502'),
    'https://third.example/': answers('https://third.example'),
  });
  const resolver = invidiousResolver('https://first.example', {
    others: async () => ['https://first.example', 'https://second.example', 'https://third.example', 'https://fourth.example'],
  });
  const info = await resolver.resolve(WATCH, { net });
  assert.equal(info.extractor, 'youtube (invidious: third.example)');
  assert.ok(info.formats[0].url.startsWith('https://third.example/'), 'the formats point at the instance that answered');
  assert.equal(asked.length, 3, 'stopped at the first that delivered');
  assert.ok(asked.every((url) => url.includes('local=true')));
});

test('a refusal about the video is final, and no replica is bothered', async () => {
  const { net, asked } = fakeNet({ 'https://first.example/': { error: 'This video is private.' } });
  const resolver = invidiousResolver('https://first.example', { others: async () => ['https://second.example'] });
  await assert.rejects(() => resolver.resolve(WATCH, { net }), /private/);
  assert.equal(asked.length, 1);
});

test('when every replica refuses, the error says how many were tried and what the last one said', async () => {
  const { net } = fakeNet({
    'https://first.example/': new Error('first.example answered 429'),
    'https://second.example/': { error: "Sign in to confirm you're not a bot" },
  });
  const resolver = invidiousResolver('https://first.example', { others: async () => ['https://second.example'], spare: 3 });
  await assert.rejects(() => resolver.resolve(WATCH, { net }), (error) => {
    assert.match(error.message, /Every Invidious instance tried refused that video \(2 of them\)/);
    assert.match(error.hint, /not a bot/);
    return true;
  });
});

test('the walk is capped, so a bad day for the whole network costs a few requests, not forty', async () => {
  const { net, asked } = fakeNet({});
  const many = Array.from({ length: 40 }, (_, i) => `https://i${i}.example`);
  const resolver = invidiousResolver('https://home.example', { others: async () => many, spare: 3 });
  await assert.rejects(() => resolver.resolve(WATCH, { net }));
  assert.equal(asked.length, 4, 'the configured one plus three spares');
});

test('an instance that never answers is left behind within the bound, and the walk goes on', async () => {
  // What a GitHub runner saw from three public instances: no refusal, no
  // answer, nothing — the connection just hangs. Without a bound that is a
  // minute per instance; with one it is the bound, then the next replica.
  const asked = [];
  const net = {
    json: (url, { signal } = {}) => {
      asked.push(url);
      if (url.startsWith('https://answers.example/')) return Promise.resolve(answers('https://answers.example'));
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    },
  };
  const resolver = invidiousResolver('https://hangs.example', { others: async () => ['https://answers.example'], timeout: 40 });
  const started = Date.now();
  const info = await resolver.resolve(WATCH, { net });
  assert.equal(info.extractor, 'youtube (invidious: answers.example)');
  assert.equal(asked.length, 2);
  assert.ok(Date.now() - started < 1000, 'moved on within the bound, not the default fifteen seconds');
});

test('the timeout names the host and the seconds, so the row says who kept quiet', async () => {
  const net = { json: (url, { signal } = {}) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) };
  const resolver = invidiousResolver('https://hangs.example', { timeout: 30 });
  await assert.rejects(() => resolver.resolve(WATCH, { net }), /hangs\.example did not answer within 0s/);
});

test('the person cancelling is not the instance failing', async () => {
  const controller = new AbortController();
  const net = { json: (url, { signal } = {}) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) };
  const resolver = invidiousResolver('https://slow.example', { others: async () => ['https://other.example'], timeout: 5000 });
  const pending = resolver.resolve(WATCH, { net, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError' || /abort/i.test(String(error?.message || error?.name)));
});

test('with a relay and no instance, the bundled list is walked from its first entry', async () => {
  // The first is the base, the rest are the replicas: the same walk a
  // configured instance gets, with the list itself as the starting point.
  const { net, asked } = fakeNet({
    'https://one.example/': { error: "Sign in to confirm you're not a bot" },
    'https://two.example/': answers('https://two.example'),
  });
  const walk = invidiousWalk({ others: async () => ['https://one.example', 'https://two.example', 'https://three.example'] });
  const info = await walk.resolve(WATCH, { net });
  assert.equal(info.extractor, 'youtube (invidious: two.example)');
  assert.deepEqual(asked.map((url) => new URL(url).host), ['one.example', 'two.example']);
  assert.equal(walk.generic, false, 'YouTube only, like any instance');
});

test('an empty bundled list is an error that says so, not a crash', async () => {
  const { net, asked } = fakeNet({});
  await assert.rejects(() => invidiousWalk({ others: async () => [] }).resolve(WATCH, { net }), /No public Invidious instance/);
  assert.equal(asked.length, 0);
});

test('with no list at all, the configured instance\'s own refusal is what comes back', async () => {
  const { net } = fakeNet({ 'https://home.example/': new Error('home.example answered 503') });
  const resolver = invidiousResolver('https://home.example');
  await assert.rejects(() => resolver.resolve(WATCH, { net }), /did not answer/);
});

/* ------------------------------------------------------------ youtubei.js */

test('the InnerTube fetch wrapper sends what the library added, not the bare payload', async () => {
  // youtubei.js calls fetch(Request, init): the Request holds the bare
  // payload, the init holds the finished body (with the session context)
  // and the visitor/client headers. Forwarding the Request alone sent a
  // player call with no context, which YouTube refuses outright.
  const seen = [];
  const net = {
    request: async (url, options) => {
      seen.push({ url, ...options, body: new TextDecoder().decode(options.body) });
      return new Response('{}');
    },
  };
  const url = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const bare = new Request(url, { method: 'POST', body: '{"videoId":"x"}', headers: { 'Content-Type': 'application/json' } });
  await innertubeFetch(net)(bare, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Visitor-Id': 'visitor', 'X-Youtube-Client-Name': '1' },
    body: '{"videoId":"x","context":{"client":{"clientName":"WEB"}}}',
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, url);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].prefer, 'relay');
  assert.deepEqual(JSON.parse(seen[0].body), { videoId: 'x', context: { client: { clientName: 'WEB' } } });
  assert.equal(seen[0].headers['x-goog-visitor-id'], 'visitor');
  assert.equal(seen[0].headers['x-youtube-client-name'], '1');
});

test('the InnerTube fetch wrapper still works when the library passes a plain URL', async () => {
  const seen = [];
  const net = { request: async (url, options) => (seen.push({ url, ...options }), new Response('ok')) };
  await innertubeFetch(net)('https://www.youtube.com/sw.js_data', { method: 'GET' });
  assert.equal(seen[0].url, 'https://www.youtube.com/sw.js_data');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].body, undefined);
});

/* --------------------------------------------------------------- subtitles */

test('the subtitle asked for wins, and a written track beats a machine one', () => {
  const tracks = [
    { lang: 'en', ext: 'vtt', url: 'a', auto: true },
    { lang: 'en', ext: 'vtt', url: 'b', auto: false },
    { lang: 'fr', ext: 'vtt', url: 'c', auto: false },
  ];
  assert.equal(pickSubtitle(tracks, 'en').url, 'b');
  assert.equal(pickSubtitle(tracks, 'fr').url, 'c');
  assert.equal(pickSubtitle(tracks, 'fr,en').url, 'c', 'the order asked for is the order tried');
});

test('a regional spelling still matches the language asked for', () => {
  const tracks = [{ lang: 'en-GB', ext: 'vtt', url: 'a', auto: false }];
  assert.equal(pickSubtitle(tracks, 'en').url, 'a');
});

test('asking for a language nobody offers takes the best on offer, not nothing', () => {
  // A video with only Japanese subtitles and a request for French: handing
  // back a subtitle-less file would be worse than handing back Japanese.
  const tracks = [
    { lang: 'ja', ext: 'vtt', url: 'auto', auto: true },
    { lang: 'ja', ext: 'vtt', url: 'written', auto: false },
  ];
  assert.equal(pickSubtitle(tracks, 'fr').url, 'written');
});

test('no tracks at all is null, and nothing downstream has to guess', () => {
  assert.equal(pickSubtitle([], 'en'), null);
  assert.equal(pickSubtitle(undefined, 'en'), null);
  assert.equal(pickSubtitle([{ lang: 'en' }], 'en'), null, 'a track with no url is not a track');
});

/* ------------------------------------------------- youtube behind a tunnel */

test('behind a server tunnel, a resolver\'s answer about YouTube is the answer — InnerTube is not tried through it', async () => {
  // A server that only resolves: its tunnel carries the hosts it named and
  // nothing else, so YouTube's API through it is refused before the first
  // byte. The person must read what the server said (a bot wall, cookies),
  // not the tunnel's refusal — and youtubei.js must not be fetched for it.
  const net = { hasEscape: true, hasOpenEscape: false, hasBridge: false, escape: { name: 'tunnel' } };
  const server = {
    name: 'server',
    generic: true,
    resolve: async () => {
      throw new BackendError('YouTube asked this server to prove it is not a bot, on every client tried.');
    },
  };
  await assert.rejects(() => extract(WATCH, { net, resolvers: [server] }), /prove it is not a bot/);
});

test('with no escape at all, a resolver\'s final answer is final', async () => {
  const net = { hasEscape: false, hasOpenEscape: false, hasBridge: false, escape: null };
  const instance = { name: 'invidious', generic: false, resolve: async () => { throw new BackendError('That video is private.', { retryable: false }); } };
  await assert.rejects(() => extract(WATCH, { net, resolvers: [instance] }), /private/);
});

test('with nothing to ask and no escape, YouTube is refused in a sentence that names the cure', async () => {
  const net = { hasEscape: false, hasOpenEscape: false, hasBridge: false, escape: null };
  await assert.rejects(() => extract(WATCH, { net, resolvers: [] }), (error) => /helper|relay|bridge/i.test(error.hint) && error.retryable === false);
});

/* ------------------------------------------------------ pages and ladders */

/**
 * A `net` that serves documents and headers from tables, and records which
 * candidates were asked what they are. A document answers as a web page.
 */
function pageNet({ documents = {}, heads = {} }) {
  const peeked = [];
  return {
    peeked,
    document: async (url) => {
      const doc = documents[url];
      if (!doc) throw new BackendError(`${url} answered 404.`, { retryable: false });
      return typeof doc === 'string' ? { text: doc, url } : doc;
    },
    peek: async (url) => {
      if (documents[url]) return { status: 200, type: 'text/html', length: null, filename: null, acceptsRanges: false };
      peeked.push(url);
      const head = heads[url];
      if (!head) throw new BackendError(`${new URL(url).host} answered 404.`, { retryable: false });
      return { status: 200, type: head, length: null, filename: null, acceptsRanges: true };
    },
  };
}

test('an og:video that is the site\'s player page is passed over for the file itself', async () => {
  const net = pageNet({
    documents: {
      'https://site.example/watch/42': `<meta property="og:video" content="https://player.example/embed/42">
        <title>A clip</title><video src="https://cdn.example/42.mp4"></video>`,
    },
    heads: { 'https://player.example/embed/42': 'text/html', 'https://cdn.example/42.mp4': 'video/mp4' },
  });
  const info = await extract('https://site.example/watch/42', { net });
  assert.equal(info.formats[0].url, 'https://cdn.example/42.mp4');
  assert.deepEqual(net.peeked, ['https://player.example/embed/42', 'https://cdn.example/42.mp4']);
});

test('an og:video on a dead CDN no longer sinks a page that also has a working <video>', async () => {
  const net = pageNet({
    documents: {
      'https://site.example/watch/43': `<meta property="og:video" content="https://dead.example/43.mp4"><video src="https://cdn.example/43.mp4"></video>`,
    },
    heads: { 'https://cdn.example/43.mp4': 'video/mp4' },
  });
  const info = await extract('https://site.example/watch/43', { net });
  assert.equal(info.formats[0].url, 'https://cdn.example/43.mp4');
});

test('a page with only a player to offer says so, rather than downloading the player', async () => {
  const net = pageNet({
    documents: { 'https://site.example/watch/44': '<meta property="og:video" content="https://player.example/embed/44">' },
    heads: { 'https://player.example/embed/44': 'text/html' },
  });
  await assert.rejects(() => extract('https://site.example/watch/44', { net }), /player, not at a file/);
});

test('a page that was redirected is read relative to where it landed', async () => {
  const net = pageNet({
    documents: {
      'https://site.example/watch/45': { text: '<video src="media/45.mp4"></video>', url: 'https://site.example/watch/45-a-slug/' },
    },
    heads: { 'https://site.example/watch/45-a-slug/media/45.mp4': 'video/mp4' },
  });
  const info = await extract('https://site.example/watch/45', { net });
  assert.equal(info.formats[0].url, 'https://site.example/watch/45-a-slug/media/45.mp4');
});

test('a playlist that was redirected names its renditions relative to where it landed', async () => {
  const net = pageNet({
    documents: {
      'https://short.example/master.m3u8': {
        text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nv360.m3u8\n',
        url: 'https://cdn.example/path/master.m3u8',
      },
    },
  });
  const info = await extract('https://short.example/master.m3u8', { net });
  assert.equal(info.formats[0].url, 'https://cdn.example/path/v360.m3u8');
});

const LADDER = (english) => `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES${english ? ',URI="en/audio.m3u8"' : ''}
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Espanol",LANGUAGE="es",DEFAULT=NO,URI="es/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"
720/index.m3u8
`;

test('when the default audio is inside the variants, a dub beside it is not muxed in its place', async () => {
  const net = pageNet({ documents: { 'https://cdn.example/show/master.m3u8': LADDER(false) } });
  const info = await extract('https://cdn.example/show/master.m3u8', { net });
  assert.deepEqual(info.formats.map((format) => `${format.id}:${format.kind}`), ['hls-0:muxed']);
  const plan = planDownload(info, 'video_best');
  assert.equal(plan.audio, null, 'the soundtrack comes with the video');
});

test('when the default audio is a rendition of its own, it is the one muxed with the video', async () => {
  const net = pageNet({ documents: { 'https://cdn.example/show/master.m3u8': LADDER(true) } });
  const info = await extract('https://cdn.example/show/master.m3u8', { net });
  const plan = planDownload(info, 'video_best');
  assert.equal(plan.video.kind, 'video');
  assert.equal(plan.audio.url, 'https://cdn.example/show/en/audio.m3u8');
  assert.equal(plan.audio.label, 'English');
});

test('a file on a host that refuses the page goes to a resolver that can take it, not to a download that will fail', async () => {
  // A server that only resolves: its tunnel carries what it resolved, and so
  // refuses a host it was never asked about. Taking the link as a direct
  // file anyway sent the download into that refusal; the server is who has
  // to be asked.
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://ytdl.example/api/tunnel')) return new Response('no', { status: 403 });
    throw new TypeError('Failed to fetch');
  };
  try {
    const net = new Fetcher({ escape: { name: 'tunnel', via: (url) => `https://ytdl.example/api/tunnel?url=${encodeURIComponent(url)}` } });
    let asked = 0;
    const server = {
      name: 'server',
      generic: true,
      resolve: async (url) => {
        asked += 1;
        return { title: 'resolved', formats: [{ id: 'x', url, protocol: 'progressive', kind: 'muxed', container: 'mp4' }] };
      },
    };
    const info = await extract('https://nocors.example/clip.mp4', { net, resolvers: [server] });
    assert.equal(asked, 1);
    assert.equal(info.title, 'resolved');
  } finally {
    globalThis.fetch = real;
  }
});
