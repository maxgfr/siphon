import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAttributes, parseMaster, parseMedia, isMaster, segmentIv } from '../web/m3u8.js';

test('attribute values may contain commas when quoted', () => {
  const attrs = parseAttributes('BANDWIDTH=1280000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1920x1080');
  assert.equal(attrs.BANDWIDTH, '1280000');
  assert.equal(attrs.CODECS, 'avc1.64001f,mp4a.40.2');
  assert.equal(attrs.RESOLUTION, '1920x1080');
});

test('a master playlist is told apart from a media one', () => {
  assert.equal(isMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8'), true);
  assert.equal(isMaster('#EXTM3U\n#EXTINF:9.0,\nseg0.ts'), false);
});

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="French",DEFAULT=NO,URI="audio/fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aac"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aac"
high/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aac"
mid/index.m3u8
`;

test('variants come back best first, with URLs resolved against the playlist', () => {
  const { variants } = parseMaster(MASTER, 'https://cdn.example/v/master.m3u8');
  assert.deepEqual(variants.map((v) => v.height), [1080, 720, 360]);
  assert.equal(variants[0].url, 'https://cdn.example/v/high/index.m3u8');
  assert.equal(variants[0].width, 1920);
});

test('the default audio rendition is the one marked DEFAULT', () => {
  const { audio } = parseMaster(MASTER, 'https://cdn.example/v/master.m3u8');
  assert.equal(audio.length, 2);
  const chosen = audio.find((track) => track.default);
  assert.equal(chosen.name, 'English');
  assert.equal(chosen.url, 'https://cdn.example/v/audio/en.m3u8');
});

test('a variant with no RESOLUTION still parses, with a null height', () => {
  const { variants } = parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000\naudio.m3u8', 'https://x/y.m3u8');
  assert.equal(variants.length, 1);
  assert.equal(variants[0].height, null);
  assert.equal(variants[0].bandwidth, 64000);
});

test('a stream tag whose next line is another tag is skipped, not mispaired', () => {
  const { variants } = parseMaster(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-STREAM-INF:BANDWIDTH=2\nreal.m3u8',
    'https://x/y.m3u8',
  );
  assert.equal(variants.length, 1);
  assert.equal(variants[0].bandwidth, 2);
});

test('a finished media playlist lists its segments and its duration', () => {
  const media = parseMedia(
    `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXTINF:3.003,
seg2.ts
#EXT-X-ENDLIST`,
    'https://cdn.example/v/index.m3u8',
  );
  assert.equal(media.segments.length, 3);
  assert.equal(media.segments[1].url, 'https://cdn.example/v/seg1.ts');
  assert.equal(media.isLive, false);
  assert.ok(Math.abs(media.duration - 21.021) < 0.001);
});

test('a playlist with no ENDLIST is still being written to', () => {
  const media = parseMedia('#EXTM3U\n#EXTINF:4,\nseg0.ts', 'https://x/i.m3u8');
  assert.equal(media.isLive, true);
});

test('the fMP4 init segment is picked up separately from the segments', () => {
  const media = parseMedia(
    `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
0.m4s
#EXT-X-ENDLIST`,
    'https://cdn.example/v/index.m3u8',
  );
  assert.equal(media.initUrl, 'https://cdn.example/v/init.mp4');
  assert.equal(media.segments.length, 1);
});

test('a byte range with no offset continues from the previous segment', () => {
  const media = parseMedia(
    `#EXTM3U
#EXTINF:4,
#EXT-X-BYTERANGE:1000@0
all.ts
#EXTINF:4,
#EXT-X-BYTERANGE:500
all.ts
#EXT-X-ENDLIST`,
    'https://cdn.example/v/index.m3u8',
  );
  assert.deepEqual(media.segments[0].range, { offset: 0, length: 1000 });
  assert.deepEqual(media.segments[1].range, { offset: 1000, length: 500 });
});

test('encryption is reported, and METHOD=NONE is not encryption', () => {
  const encrypted = parseMedia(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\n0.ts\n#EXT-X-ENDLIST',
    'https://cdn.example/v/i.m3u8',
  );
  assert.equal(encrypted.encryption, 'AES-128');
  assert.equal(encrypted.segments[0].key.url, 'https://cdn.example/v/k.key');

  const cleared = parseMedia(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\n0.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\n1.ts\n#EXT-X-ENDLIST',
    'https://cdn.example/v/i.m3u8',
  );
  assert.equal(cleared.segments[1].key, null);
});

test('a segment with no stated IV derives one from its sequence number', () => {
  const media = parseMedia(
    '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\n5.ts\n#EXT-X-ENDLIST',
    'https://x/i.m3u8',
  );
  assert.deepEqual([...segmentIv(media.segments[0])], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
});

test('a stated IV is used exactly as written', () => {
  const media = parseMedia(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x000102030405060708090a0b0c0d0e0f\n#EXTINF:4,\n0.ts\n#EXT-X-ENDLIST',
    'https://x/i.m3u8',
  );
  assert.deepEqual([...segmentIv(media.segments[0])], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});
