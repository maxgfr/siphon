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
  safeFilename,
  titleFromUrl,
  extensionOf,
  innertubeFetch,
} from '../web/extract.js';

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
