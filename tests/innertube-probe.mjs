/**
 * What does YouTube's API say to a bare request from this machine, today?
 *
 * No browser, no relay, no library: a handful of InnerTube /player requests
 * built by hand, one per client the browser mode tries, sent straight from
 * Node. Each line is a verdict — the HTTP status, and for a 200 the
 * playability and the number of formats offered.
 *
 * It exists because a 400 through the whole stack has too many suspects:
 * the relay, the library, the headers a browser cannot set, the runner's
 * IP. This strips all of them away but the last, so a red in the full run
 * can be read against a known baseline instead of guessed at.
 *
 *   node tests/innertube-probe.mjs [videoId]
 */
import { writeSync } from 'node:fs';

const say = (line = '') => writeSync(1, `${line}\n`);
const VIDEO = process.argv[2] || process.env.SIPHON_YT_ID || 'jNQXAC9IVRw';
const PLAYER = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** The clients the browser mode tries, with the identity each one claims. */
const CLIENTS = {
  WEB: {
    context: { clientName: 'WEB', clientVersion: '2.20250312.04.00' },
    headers: { 'User-Agent': CHROME, 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': '2.20250312.04.00' },
  },
  MWEB: {
    context: { clientName: 'MWEB', clientVersion: '2.20250311.03.00' },
    headers: { 'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 'X-Youtube-Client-Name': '2', 'X-Youtube-Client-Version': '2.20250311.03.00' },
  },
  TV_EMBEDDED: {
    context: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' },
    headers: { 'User-Agent': 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15', 'X-Youtube-Client-Name': '85', 'X-Youtube-Client-Version': '2.0' },
    extra: { thirdParty: { embedUrl: 'https://www.youtube.com/' } },
  },
  IOS: {
    context: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
    headers: { 'User-Agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)', 'X-Youtube-Client-Name': '5', 'X-Youtube-Client-Version': '20.10.4' },
  },
  ANDROID_VR: {
    context: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' },
    headers: { 'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip', 'X-Youtube-Client-Name': '28', 'X-Youtube-Client-Version': '1.65.10' },
  },
};

async function probe(label, { context, headers, extra = {} }, tweak = {}) {
  const body = JSON.stringify({
    context: { client: { hl: 'en', gl: 'US', ...context, ...(tweak.context || {}) } },
    videoId: VIDEO,
    contentCheckOk: true,
    racyCheckOk: true,
    ...extra,
  });
  const sent = { 'Content-Type': 'application/json', Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/', ...headers, ...(tweak.headers || {}) };
  for (const name of tweak.drop || []) delete sent[name];
  let line;
  try {
    const response = await fetch(PLAYER, { method: 'POST', headers: sent, body, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    if (response.status !== 200) {
      line = `HTTP ${response.status}  ${text.replace(/\s+/g, ' ').slice(0, 140)}`;
    } else {
      let json = {};
      try { json = JSON.parse(text); } catch { /* not json */ }
      const status = json.playabilityStatus || {};
      const formats = (json.streamingData?.formats?.length || 0) + (json.streamingData?.adaptiveFormats?.length || 0);
      line = `HTTP 200  playability=${status.status || '?'}${status.reason ? ` (${status.reason.slice(0, 80)})` : ''}  formats=${formats}`;
    }
  } catch (error) {
    line = `ERROR ${error?.message || error}`;
  }
  say(`${label.padEnd(34)} ${line}`);
  return line;
}

say(`\nInnerTube /player, straight from this machine, video ${VIDEO}\n`);
const results = [];
for (const [name, client] of Object.entries(CLIENTS)) {
  results.push(await probe(name, client));
}
// The two things a browser cannot control on its own requests, isolated on
// the client most likely to care: its User-Agent, and the Origin the relay adds.
results.push(await probe('IOS, but with a Chrome User-Agent', CLIENTS.IOS, { headers: { 'User-Agent': CHROME } }));
results.push(await probe('WEB, no Origin/Referer', CLIENTS.WEB, { drop: ['Origin', 'Referer'] }));
results.push(await probe('WEB, no X-Youtube-Client-*', CLIENTS.WEB, { drop: ['X-Youtube-Client-Name', 'X-Youtube-Client-Version'] }));

const usable = results.filter((line) => /playability=OK/.test(line)).length;
say(`\n${usable}/${results.length} hand-built variants got a playable answer`);

/*
 * Now the library the browser mode uses, driven from Node with no relay and
 * no browser in between — the same pinned version, its own requests. Two
 * sessions: one built locally (what the browser does, since it cannot fetch
 * YouTube's pages to get a real one), one fetched from YouTube. If the local
 * one draws a 400 and the fetched one does not, the browser's session is
 * the problem, not the relay and not the runner.
 */
/* The Piped instance CI hands the browser test, asked directly from Node. */
const PIPED = (process.env.SIPHON_PIPED_URL || '').replace(/\/+$/, '');
if (PIPED) {
  say(`\npiped instance ${PIPED}, straight from this machine\n`);
  try {
    const response = await fetch(`${PIPED}/streams/${VIDEO}`, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } });
    const text = await response.text();
    let summary = text.replace(/\s+/g, ' ').slice(0, 140);
    try {
      const json = JSON.parse(text);
      if (json.error) summary = `error: ${String(json.error).slice(0, 120)}`;
      else summary = `title=${JSON.stringify(json.title || '')} video streams=${json.videoStreams?.length || 0} audio streams=${json.audioStreams?.length || 0}`;
    } catch {
      /* not json — the raw start of the body says enough */
    }
    say(`/streams                           HTTP ${response.status}  cors=${response.headers.get('access-control-allow-origin') || 'none'}  ${summary}`);
  } catch (error) {
    say(`/streams                           ERROR ${String(error?.message || error).slice(0, 140)}`);
  }
} else {
  say('\npiped instance: not set (SIPHON_PIPED_URL), skipped');
}

say('\nyoutubei.js from Node, same version the page loads\n');
const { Innertube } = await import('youtubei.js');
const CLIENT_LADDER = [undefined, 'TV_EMBEDDED', 'IOS', 'ANDROID_VR', 'MWEB'];
for (const local of [true, false]) {
  let youtube;
  try {
    youtube = await Innertube.create({ generate_session_locally: local, retrieve_player: true });
  } catch (error) {
    say(`session (local=${local})                ERROR creating: ${String(error?.message || error).slice(0, 140)}`);
    continue;
  }
  for (const client of CLIENT_LADDER) {
    const label = `${client || 'default'} (session ${local ? 'local' : 'fetched'})`;
    try {
      const info = await youtube.getBasicInfo(VIDEO, client ? { client } : undefined);
      const status = info?.playability_status || {};
      const formats = (info?.streaming_data?.formats?.length || 0) + (info?.streaming_data?.adaptive_formats?.length || 0);
      say(`${label.padEnd(34)} playability=${status.status || '?'}${status.reason ? ` (${String(status.reason).slice(0, 80)})` : ''}  formats=${formats}`);
    } catch (error) {
      say(`${label.padEnd(34)} ERROR ${String(error?.message || error).slice(0, 160)}`);
    }
  }
}
