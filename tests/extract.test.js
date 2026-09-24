import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sniffUrl,
  sniffType,
  sniffBytes,
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
  pipedResolver,
  safeFilename,
  titleFromUrl,
  extensionOf,
  innertubeFetch,
  extract,
} from '../web/extract.js';
import { BackendError } from '../web/errors.js';
import { Fetcher } from '../web/net.js';
import { pickSubtitle, subtitleData } from '../web/inbrowser.js';

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

test('a signed URL in markup keeps every parameter, whichever way its & was escaped', () => {
  // Every template engine writes & in an attribute as &amp;, WordPress as
  // &#038;, and Go's and Rails' JSON as &. Left escaped, a CloudFront
  // signature arrives as `amp;Signature` and the CDN answers 403.
  const params = (html) => [...new URL(scrapePage(html, 'https://site.example/post/')[0].url).searchParams.keys()];
  assert.deepEqual(params('<meta property="og:video" content="https://cdn.example/v.mp4?Expires=1&amp;Signature=abc&amp;Key-Pair-Id=K1">'), ['Expires', 'Signature', 'Key-Pair-Id']);
  assert.deepEqual(params('<video><source src="/media/v.mp4?a=1&#038;b=2"></video>'), ['a', 'b']);
  assert.deepEqual(params('<script>var cfg={"src":"https:\\/\\/cdn.example\\/v\\/master.m3u8?token=abc\\u0026exp=123"}</script>'), ['token', 'exp']);
});

test('an attribute without quotes, as a minifier leaves it, is still read', () => {
  const element = scrapePage('<video src=/media/clip.mp4 controls></video>', 'https://site.example/post/');
  assert.deepEqual(element, [{ url: 'https://site.example/media/clip.mp4', source: 'element' }]);
  const og = scrapePage('<meta property=og:video content=https://cdn.example/a.mp4>', 'https://site.example/');
  assert.deepEqual(og, [{ url: 'https://cdn.example/a.mp4', source: 'og' }]);
});

test('data-src is not src, and a src= inside another attribute\'s value is not either', () => {
  const lazy = scrapePage('<video data-src="/lazy.mp4" src="/real.mp4"></video>', 'https://site.example/');
  assert.equal(lazy[0].url, 'https://site.example/real.mp4');
  const poster = scrapePage('<video poster="/p.jpg?src=abc" src=/real.mp4></video>', 'https://site.example/');
  assert.equal(poster[0].url, 'https://site.example/real.mp4');
});

test('a JSON-LD image is not taken for the video', () => {
  // Yoast puts an ImageObject with a contentUrl on almost every WordPress
  // page; taken as a candidate, a page whose player is JavaScript "succeeded"
  // with its featured JPEG saved as an .mp4.
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
    {"@type":"WebPage","name":"x"},
    {"@type":"ImageObject","contentUrl":"https://site.example/wp-content/uploads/featured.jpg"}]}</script>`;
  assert.deepEqual(scrapePage(html, 'https://site.example/'), []);
  const audio = scrapePage('<script type="application/ld+json">{"@type":["AudioObject"],"contentUrl":"https://cdn.example/ep.mp3"}</script>', 'https://site.example/');
  assert.equal(audio[0].url, 'https://cdn.example/ep.mp3');
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

test('MP3 re-encodes a source that is not an MP3 already', () => {
  const plan = planDownload(from([videoOnly('v', 720), audioOnly('a', 128000)]), 'audio_mp3');
  assert.equal(plan.op, 'audio-encode');
  assert.equal(plan.audio.id, 'a');
  assert.equal(plan.ext, 'mp3');
  assert.equal(plan.video, null);
});

test('an .mp3 asked for as MP3 is handed over as it is, not decoded and encoded again', () => {
  // A podcast link with MP3 as the preset: re-encoding it loaded the 32 MB
  // converter to make a second lossy generation of the same thing.
  const plan = planDownload(from([{ id: 'source', kind: 'audio', protocol: 'progressive', container: 'mp3', height: null, codecs: '' }]), 'audio_mp3');
  assert.equal(plan.op, 'raw');
  assert.equal(plan.ext, 'mp3');
  assert.equal(plan.mime, 'audio/mpeg');
  assert.equal(plan.audio.id, 'source');
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

test('a muxed file that fits the ceiling is not passed over for a sharper pair that does not', () => {
  // Nothing video-only under 480p here; the 1080p one is only the fallback
  // for when nothing at all fits, and the 360p muxed file does.
  const plan = planDownload(from([progressive('m360', 360), videoOnly('v1080', 1080), audioOnly('a', 128000)]), 'video_480');
  assert.equal(plan.video.id, 'm360');
  assert.equal(plan.audio, null);
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

test('a playlist named for its role is titled after the folder it sits in', () => {
  // Every stream on a CDN is master.m3u8 or index.m3u8; named after that,
  // they all saved as master.mp4 and collided in a phone's Files app.
  assert.equal(titleFromUrl('https://cdn.example/show/abc/master.m3u8'), 'abc');
  assert.equal(titleFromUrl('https://cdn.example/examples/bipbop_adv/720p/prog_index.m3u8'), 'bipbop adv');
  assert.equal(titleFromUrl('https://cdn.example/index.m3u8'), 'cdn.example');
  assert.equal(titleFromUrl('https://cdn.example/show/episode_3.m3u8'), 'episode 3', 'a playlist with a real name keeps it');
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

test('a Piped caption listed as TTML is asked for as WebVTT, which is what gets embedded', () => {
  // What a real instance lists: NewPipe hands Piped YouTube's captions as
  // TTML, and the proxied timedtext URL says so in its fmt parameter.
  const tracks = pipedSubtitles({
    subtitles: [
      {
        url: 'https://proxy.p.example/api/timedtext?v=jNQXAC9IVRw&caps=asr&kind=asr&lang=en&fmt=ttml&host=www.youtube.com',
        mimeType: 'application/ttml+xml', name: 'English (auto-generated)', code: 'en', autoGenerated: true,
      },
      { url: 'https://p.example/subs/de.ttml', mimeType: 'application/ttml+xml', name: 'German', code: 'de', autoGenerated: false },
    ],
  });
  assert.equal(tracks[0].url, 'https://proxy.p.example/api/timedtext?v=jNQXAC9IVRw&caps=asr&kind=asr&lang=en&fmt=vtt&host=www.youtube.com');
  assert.equal(tracks[0].ext, 'vtt');
  // No format to ask for: it stays what it is, and is not called WebVTT.
  assert.equal(tracks[1].ext, 'ttml');
  assert.equal(tracks[1].url, 'https://p.example/subs/de.ttml');
});

test('a subtitle that is not WebVTT is not handed to the muxer as one', async () => {
  // ffmpeg reads a TTML file named .vtt as an empty WebVTT track: the video
  // gets a subtitle stream with no cues and no one is told. Refused here, the
  // row says the subtitles could not be fetched instead.
  const answers = {
    'https://s.example/ttml': '<?xml version="1.0" encoding="utf-8" ?><tt xml:lang="en"><body><div><p begin="0" end="1.5">Hello</p></div></body></tt>',
    'https://s.example/vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n',
    'https://s.example/bom': '\uFEFFWEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n',
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(answers[String(url)]);
  try {
    const net = new Fetcher();
    assert.equal(await subtitleData(net, { url: 'https://s.example/ttml', ext: 'vtt' }), null);
    assert.ok(await subtitleData(net, { url: 'https://s.example/vtt', ext: 'vtt' }));
    assert.ok(await subtitleData(net, { url: 'https://s.example/bom', ext: 'vtt' }), 'a byte-order mark is still WebVTT');
  } finally {
    globalThis.fetch = real;
  }
});

test('an SRT or ASS track a server resolved is embedded, and an error page under that name is not', async () => {
  // A server's resolver hands back srt or ass when a site offers no WebVTT,
  // and ffmpeg reads both into the same mov_text track. Only the check for
  // WebVTT's own name would throw them away.
  const answers = {
    'https://s.example/srt': '1\r\n00:00:00,000 --> 00:00:01,500\r\nHello\r\n',
    'https://s.example/ass': '﻿[Script Info]\nScriptType: v4.00+\n\n[Events]\nDialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,Hello\n',
    'https://s.example/html': '<!doctype html><title>404</title><p>Not found</p>',
    'https://s.example/vtt': 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n',
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(answers[String(url)]);
  try {
    const net = new Fetcher();
    assert.ok(await subtitleData(net, { url: 'https://s.example/srt', ext: 'srt' }), 'SRT is kept');
    assert.ok(await subtitleData(net, { url: 'https://s.example/ass', ext: 'ass' }), 'ASS is kept');
    assert.equal(await subtitleData(net, { url: 'https://s.example/html', ext: 'srt' }), null);
    assert.equal(await subtitleData(net, { url: 'https://s.example/html', ext: 'ass' }), null);
    assert.equal(await subtitleData(net, { url: 'https://s.example/srt', ext: 'vtt' }), null, 'SRT under a .vtt name is not WebVTT');
    assert.equal(await subtitleData(net, { url: 'https://s.example/vtt', ext: 'ttml' }), null, 'nothing ffmpeg.wasm cannot read');
  } finally {
    globalThis.fetch = real;
  }
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

/**
 * A `net` whose request() answers from a table of URL prefix → answer, and
 * records the asks. An answer is a body, sent as 200 JSON; `refusal(status,
 * body)`, which is how a real instance says no — Invidious sends a private
 * video's reason as 500 {"error": …}; or an Error, for no answer at all.
 */
function fakeNet(table) {
  const asked = [];
  return {
    asked,
    net: {
      request: async (url) => {
        asked.push(url);
        const hit = Object.entries(table).find(([prefix]) => url.startsWith(prefix));
        if (!hit) throw new Error(`could not reach ${url}`);
        const answer = hit[1];
        if (answer instanceof Error) throw answer;
        return answer.refused ? jsonAnswer(answer.refused, answer.body) : jsonAnswer(200, answer);
      },
    },
  };
}

const refusal = (status, body) => ({ refused: status, body });
const jsonAnswer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const WATCH = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const answers = (base) => ({ ...INVIDIOUS, formatStreams: [{ ...INVIDIOUS.formatStreams[0], url: `${base}/videoplayback?itag=18` }], adaptiveFormats: [] });

test('the resolver walks the bundled replicas when its instance is bot-walled, and names the one that answered', async () => {
  const { net, asked } = fakeNet({
    'https://first.example/': refusal(500, { error: "Sign in to confirm you're not a bot" }),
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
  const { net, asked } = fakeNet({ 'https://first.example/': refusal(404, { error: 'This video is private.' }) });
  const resolver = invidiousResolver('https://first.example', { others: async () => ['https://second.example'] });
  await assert.rejects(() => resolver.resolve(WATCH, { net }), /private/);
  assert.equal(asked.length, 1);
});

test('when every replica refuses, the error says how many were tried and what the last one said', async () => {
  const { net } = fakeNet({
    'https://first.example/': new Error('first.example answered 429'),
    'https://second.example/': refusal(500, { error: "Sign in to confirm you're not a bot" }),
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
    request: (url, { signal } = {}) => {
      asked.push(url);
      if (url.startsWith('https://answers.example/')) return Promise.resolve(jsonAnswer(200, answers('https://answers.example')));
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
  const net = { request: (url, { signal } = {}) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) };
  const resolver = invidiousResolver('https://hangs.example', { timeout: 30 });
  await assert.rejects(() => resolver.resolve(WATCH, { net }), /hangs\.example did not answer within 0s/);
});

test('the person cancelling is not the instance failing', async () => {
  const controller = new AbortController();
  const net = { request: (url, { signal } = {}) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) };
  const resolver = invidiousResolver('https://slow.example', { others: async () => ['https://other.example'], timeout: 5000 });
  const pending = resolver.resolve(WATCH, { net, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError' || /abort/i.test(String(error?.message || error?.name)));
});

test('with a relay and no instance, the bundled list is walked from its first entry', async () => {
  // The first is the base, the rest are the replicas: the same walk a
  // configured instance gets, with the list itself as the starting point.
  const { net, asked } = fakeNet({
    'https://one.example/': refusal(500, { error: "Sign in to confirm you're not a bot" }),
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

/** Run `fn` with every request answered by `answer(url)`, as a real Fetcher meets it. */
async function onTheWire(answer, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => answer(String(url));
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('an instance that refuses with an error status is heard, and a private video is final', async () => {
  // A real Invidious answers every failure with a status and its reason —
  // videos.cr sends 404 or 500 {"error": …}. Read only from a 2xx, the reason
  // was lost: the row blamed the instances, and four of them were asked.
  const asked = [];
  await onTheWire((url) => (asked.push(url), jsonAnswer(500, { error: 'This video is private.' })), async () => {
    const resolver = invidiousResolver('https://first.example', { others: async () => ['https://second.example', 'https://third.example'] });
    await assert.rejects(() => resolver.resolve(WATCH, { net: new Fetcher() }), (error) => {
      assert.match(error.message, /private/);
      assert.equal(error.retryable, false);
      return true;
    });
  });
  assert.equal(asked.length, 1, 'no replica is bothered');
});

test('a bot wall sent with a 500 walks the replicas, and the row quotes what the instance said', async () => {
  const asked = [];
  await onTheWire((url) => (asked.push(url), jsonAnswer(500, { error: "Sign in to confirm you're not a bot" })), async () => {
    const resolver = invidiousResolver('https://first.example', { others: async () => ['https://second.example'] });
    await assert.rejects(() => resolver.resolve(WATCH, { net: new Fetcher() }), (error) => {
      assert.match(error.message, /\(2 of them\)/);
      assert.match(error.hint, /not a bot/);
      return true;
    });
  });
  assert.equal(asked.length, 2);
});

test('an instance that answers an error page rather than JSON simply did not answer, and the walk goes on', async () => {
  await onTheWire((url) => (url.startsWith('https://first.example/')
    ? new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
    : jsonAnswer(200, answers('https://second.example'))), async () => {
    const resolver = invidiousResolver('https://first.example', { others: async () => ['https://second.example'] });
    const info = await resolver.resolve(WATCH, { net: new Fetcher() });
    assert.equal(info.extractor, 'youtube (invidious: second.example)');
  });
});

test('Piped\'s reason arrives whatever the status it comes with', async () => {
  // Measured: pipedapi.ducks.party answered HTTP 500 {"error":"…"}.
  await onTheWire(() => jsonAnswer(500, { error: 'org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException: This video is private' }), async () => {
    await assert.rejects(() => pipedResolver('https://piped.example').resolve(WATCH, { net: new Fetcher() }), (error) => {
      assert.match(error.message, /Piped instance says: .*private/);
      assert.equal(error.retryable, false);
      return true;
    });
  });
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

test('a YouTube playlist or channel goes to your server, which reads it as a list', async () => {
  // It has no video of its own, so there is nothing for an instance or
  // InnerTube to take — but a server's yt-dlp answers it with its entries,
  // and the device takes them one row each. It was refused before the
  // server was asked, and told the person to get the server they had.
  const net = { hasEscape: true, hasOpenEscape: false, hasBridge: false, escape: { name: 'tunnel' } };
  for (const url of ['https://www.youtube.com/playlist?list=PL1234567890', 'https://www.youtube.com/@somechannel/videos']) {
    let asked = 0;
    const server = {
      name: 'server',
      generic: true,
      resolve: async () => {
        asked += 1;
        return { title: 'A list', formats: [], playlist: { count: 2, limit: 50, entries: [{ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'One' }] } };
      },
    };
    const instance = { name: 'invidious', generic: false, resolve: async () => assert.fail('an instance is asked for a video, not a list') };
    const found = await extract(url, { net, resolvers: [instance, server] });
    assert.equal(asked, 1, url);
    assert.equal(found.playlist.entries.length, 1, url);
  }
  // With no server to ask, it is still the sentence that names one.
  await assert.rejects(
    () => extract('https://www.youtube.com/playlist?list=PL1234567890', { net, resolvers: [] }),
    (error) => /no video in it/.test(error.message) && /your own server/.test(error.hint),
  );
});

/* ------------------------------------------------------ pages and ladders */

/**
 * A `net` that serves documents, headers and first bytes from tables, and
 * records which candidates were asked what they are and which addresses were
 * read whole. A document answers as a web page unless it says otherwise; a
 * head is a content type, or `{ type, filename }`.
 */
function pageNet({ documents = {}, heads = {}, starts = {} }) {
  const peeked = [];
  const read = [];
  return {
    peeked,
    read,
    document: async (url) => {
      read.push(url);
      const doc = documents[url];
      if (!doc) throw new BackendError(`${url} answered 404.`, { retryable: false });
      return typeof doc === 'string' ? { text: doc, url } : { url, ...doc };
    },
    peek: async (url) => {
      const doc = documents[url];
      if (doc) return { status: 200, type: doc.type || 'text/html', length: null, filename: null, acceptsRanges: false };
      peeked.push(url);
      const head = heads[url];
      if (!head) throw new BackendError(`${new URL(url).host} answered 404.`, { retryable: false });
      const { type, filename = null } = typeof head === 'string' ? { type: head } : head;
      return { status: 200, type, length: null, filename, acceptsRanges: true };
    },
    prefix: async (url) => {
      const start = starts[url] ?? documents[url]?.text;
      if (start === undefined) throw new BackendError(`${new URL(url).host} answered 404.`, { retryable: false });
      return typeof start === 'string' ? new TextEncoder().encode(start) : start;
    },
  };
}

const ascii = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));

test('a file\'s first bytes tell apart what the planner can take', () => {
  assert.deepEqual(sniffBytes(ascii('ID3\x04\0\0\0\0')), { protocol: 'progressive', container: 'mp3', kind: 'audio' });
  assert.equal(sniffBytes(Uint8Array.of(0xff, 0xfb, 0x90, 0x64)).container, 'mp3');
  assert.equal(sniffBytes(Uint8Array.of(0xff, 0xf1, 0x50, 0x80)).container, 'aac', 'ADTS shares the sync, not the layer');
  assert.equal(sniffBytes(ascii('\x1a\x45\xdf\xa3\x9f\x42\x82\x84webm')).container, 'webm');
  assert.equal(sniffBytes(ascii('\0\0\0\x1cftypM4A \0\0\0\0')).kind, 'audio');
  assert.equal(sniffBytes(ascii('#EXTM3U\n')).protocol, 'hls');
  assert.equal(sniffBytes(ascii('<!doctype html><title>x</title>')), 'text');
  assert.equal(sniffBytes(ascii('%PDF-1.7\n\0')), null, 'a binary that is none of them');
});

test('a link that answers with a web page is not saved as the video its name claims', async () => {
  // A Dropbox ?dl=0 preview, or an expired link that lands on a sign-in page:
  // 200 text/html behind a .mp4. Taken at its word, the page was saved as
  // video.mp4 and reported ready — and the resolvers were never asked.
  const url = 'https://host.example/s/abc/video.mp4?dl=0';
  const net = pageNet({ heads: { [url]: 'text/html' } });
  await assert.rejects(() => extract(url, { net }), (error) => /web page/.test(error.message) && error.retryable === false);
  let asked = 0;
  const server = { name: 'server', generic: true, resolve: async () => ((asked += 1), { title: 'resolved', formats: [] }) };
  const info = await extract(url, { net, resolvers: [server] });
  assert.equal(asked, 1, 'a resolver that knows the site gets the link');
  assert.equal(info.title, 'resolved');
});

test('an image a page points at is not taken for its video', async () => {
  const net = pageNet({
    documents: { 'https://blog.example/post': '<meta property="og:video" content="https://blog.example/featured.jpg"><title>Post</title>' },
    heads: { 'https://blog.example/featured.jpg': 'image/jpeg' },
  });
  await assert.rejects(() => extract('https://blog.example/post', { net }), /image/);
});

test('a file sent as application/octet-stream is taken by the name it is sent under, not read as a page', async () => {
  // What file hosts and S3 serve by default. Read as a page, 150 MB was
  // pulled into memory as a string to report "No media found".
  const url = 'https://files.example/d/8f3a2c';
  const net = pageNet({ heads: { [url]: { type: 'application/octet-stream', filename: 'holiday-clip.mp4' } } });
  const info = await extract(url, { net });
  assert.equal(info.extractor, 'direct');
  assert.equal(info.formats[0].container, 'mp4');
  assert.equal(info.title, 'holiday-clip');
  assert.deepEqual(net.read, [], 'never read whole');
});

test('with no name to go by, the first bytes say what a file is', async () => {
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\ns0.ts\n#EXT-X-ENDLIST\n';
  const net = pageNet({
    documents: { 'https://api.example/stream/123': { text: playlist, type: 'application/octet-stream' } },
    heads: { 'https://files.example/d/mp4': 'application/octet-stream', 'https://files.example/d/pdf': 'application/octet-stream' },
    starts: { 'https://files.example/d/mp4': ascii('\0\0\0\x20ftypisom\0\0\x02\0isomiso2'), 'https://files.example/d/pdf': ascii('%PDF-1.7\n%\xe2\xe3\n1 0 obj\0') },
  });
  assert.equal((await extract('https://api.example/stream/123', { net })).extractor, 'hls');
  const mp4 = await extract('https://files.example/d/mp4', { net });
  assert.equal(mp4.extractor, 'direct');
  assert.equal(mp4.formats[0].container, 'mp4');
  await assert.rejects(() => extract('https://files.example/d/pdf', { net }), (error) => error.retryable === false);
  assert.deepEqual(net.read, ['https://api.example/stream/123'], 'only the playlist was read whole, as a playlist');
});

test('a playlist sent as text/plain from an address with no extension is still a playlist', async () => {
  const net = pageNet({ documents: { 'https://api.example/live/7': { text: '#EXTM3U\n#EXTINF:6,\ns0.ts\n#EXT-X-ENDLIST\n', type: 'text/plain' } } });
  const info = await extract('https://api.example/live/7', { net });
  assert.equal(info.extractor, 'hls');
  assert.equal(info.formats[0].url, 'https://api.example/live/7');
});

test('a page\'s title loses its HTML escapes, and its artwork is found where the page is', async () => {
  const net = pageNet({
    documents: {
      'https://site.example/post/3': `<meta property="og:title" content="Don&#039;t miss this &#8211; Episode 3">
        <meta property="og:image" content="/img/cover.jpg"><video src="/v.mp4"></video>`,
      'https://site.example/post/4': '<title>Tom &amp; Jerry&#039;s &#x2013; Part&nbsp;2</title><video src="/v.mp4"></video>',
    },
    heads: { 'https://site.example/v.mp4': 'video/mp4' },
  });
  const info = await extract('https://site.example/post/3', { net });
  assert.equal(info.title, 'Don\'t miss this \u2013 Episode 3');
  assert.equal(info.thumbnail, 'https://site.example/img/cover.jpg', 'not fetched relative to siphon\'s own origin');
  assert.equal((await extract('https://site.example/post/4', { net })).title, 'Tom & Jerry\'s \u2013 Part 2');
});

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

/** A ladder of muxed rungs, `[height, bandwidth]`, with an audio-only rung when `audio` is given. */
const RUNGS = (rungs, audio = null) => [
  '#EXTM3U',
  ...rungs.flatMap(([height, bandwidth]) => [
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${Math.round((height * 16) / 9)}x${height},CODECS="avc1.640028,mp4a.40.2"`,
    `${height}/index.m3u8`,
  ]),
  ...(audio ? [`#EXT-X-STREAM-INF:BANDWIDTH=${audio},CODECS="mp4a.40.2"`, 'audio/index.m3u8'] : []),
  '',
].join('\n');

async function ladder(text) {
  const url = 'https://cdn.example/show/master.m3u8';
  return extract(url, { net: pageNet({ documents: { [url]: text } }) });
}

test('MP3 or M4A from a ladder takes its audio-only rendition, not the top video one', async () => {
  // Apple's authoring spec asks for an audio-only variant. Listed as one more
  // "muxed" rung, the best-first sort handed an MP3 request the 1080p rung:
  // 45 MB a minute held in the tab's memory for half a megabyte of sound.
  const info = await ladder(RUNGS([[1080, 6000000], [360, 800000]], 70000));
  const audio = info.formats.find((format) => format.url.endsWith('/audio/index.m3u8'));
  assert.equal(audio.kind, 'audio');
  for (const preset of ['audio_mp3', 'audio_m4a']) {
    assert.equal(planDownload(info, preset).audio.url, 'https://cdn.example/show/audio/index.m3u8', preset);
  }
});

test('with no audio-only rendition, the sound is taken from the lightest rung', async () => {
  const info = await ladder(RUNGS([[1080, 6000000], [720, 3000000], [360, 800000]]));
  assert.equal(planDownload(info, 'audio_mp3').audio.url, 'https://cdn.example/show/360/index.m3u8');
});

test('M4A still copies the AAC out of a progressive file when an HLS ladder is offered beside it', () => {
  // A server's resolver keeps both an http file and an m3u8 ladder. The
  // lightest rung is only a way to hold less in memory for a re-encode; it
  // turned a lossless container change into a lossy one from the smallest rung.
  const hls = (id, height, bitrate) => ({
    id, kind: 'muxed', protocol: 'hls', container: 'mp4', height, bitrate, codecs: 'avc1.640028,mp4a.40.2',
  });
  const info = from([progressive('prog', 720, { bitrate: 3000000 }), hls('hls-0', 720, 3000000), hls('hls-1', 360, 800000)]);
  const plan = planDownload(info, 'audio_m4a');
  assert.equal(plan.op, 'audio-copy');
  assert.equal(plan.audio.id, 'prog');
  // MP3 re-encodes whatever it is given, so it still takes the lightest rung.
  assert.equal(planDownload(info, 'audio_mp3').audio.id, 'hls-1');
});

test('a video preset below every rung takes the lowest one, never the sound-only rendition', async () => {
  // The audio-only rung has no height, so it "fitted" any ceiling: 480p on a
  // ladder starting at 540p saved sound alone as an .mp4, and on one starting
  // at 720p there was nothing at all.
  const withAudio = await ladder(RUNGS([[1080, 6000000], [540, 1200000]], 70000));
  const plan = planDownload(withAudio, 'video_480');
  assert.equal(plan.video.url, 'https://cdn.example/show/540/index.m3u8');
  assert.equal(plan.ext, 'mp4');
  const without = await ladder(RUNGS([[1080, 6000000], [720, 3000000]]));
  assert.equal(planDownload(without, 'video_480').video.url, 'https://cdn.example/show/720/index.m3u8');
  assert.equal(planDownload(withAudio, 'video_best').video.url, 'https://cdn.example/show/1080/index.m3u8');
});

test('a file on a host that refuses the page goes to a resolver that can take it, not to a download that will fail', async () => {
  // A server that only resolves: its tunnel carries what it resolved, and so
  // refuses a host it was never asked about. Taking the link as a direct
  // file anyway sent the download into that refusal; the server is who has
  // to be asked.
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://ytdl.example/api/tunnel')) return new Response('no', { status: 403, headers: { 'X-Relay-Error': 'not a host this server resolved' } });
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
