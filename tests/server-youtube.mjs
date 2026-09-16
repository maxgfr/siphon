/**
 * The server, for real: yt-dlp on this machine against YouTube.
 *
 * Every Python test describes the server with a canned yt-dlp answer, and
 * two of them let the real extractor look at a file on loopback. Neither
 * says the one thing the README's first recommendation rests on: that
 * `docker run ghcr.io/maxgfr/siphon` on a machine with real network gets a
 * file out of YouTube. This starts server/app.py from this checkout, asks it
 * exactly what the page asks — health, resolve, a job, the file — and
 * prints what yt-dlp said, client by client.
 *
 *   npm run test:server
 *
 * Needs Python with server/requirements.txt installed, ffmpeg, and a network
 * that reaches youtube.com — so it runs in CI, informative rather than
 * gating: a runner is a datacentre IP, and YouTube's answer to one is
 * YouTube's decision. With POT_PROVIDER_URL set (the community proof-of-
 * origin provider, docker-compose.potoken.yml), the same run is made a
 * second time with the provider — the hardest case the image is built for.
 *
 * SIPHON_YT_URL points it at another link; a link that is not YouTube's
 * skips the YouTube preflight and the ladder, which is how the mechanics of
 * this file are checked where youtube.com is out of reach.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const say = (line = '') => writeSync(1, `${line}\n`);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, '.server');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const PYTHON = process.env.PYTHON || 'python3';
const PORT = Number(process.env.SIPHON_SERVER_PORT) || 8795;
const BASE = `http://127.0.0.1:${PORT}`;

// The first video ever uploaded: 19 seconds, public, and not going anywhere.
const VIDEO = process.env.SIPHON_YT_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const IS_YOUTUBE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(new URL(VIDEO).hostname);
const POT = (process.env.POT_PROVIDER_URL || '').replace(/\/+$/, '');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** A hard ceiling: an informative job must never sit on a runner for hours. */
const DEADLINE_MS = 12 * 60 * 1000;
let stage = 'starting';
setTimeout(() => {
  say(`\nFAIL watchdog: still running after ${DEADLINE_MS / 60000} minutes — hung while ${stage}`);
  process.exit(1);
}, DEADLINE_MS).unref();
const now = (what) => {
  stage = what;
  say(`.. ${what}`);
};

const verdicts = [];
const verdict = (ok, label, detail = '') => {
  verdicts.push(ok);
  say(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function inspect(file) {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['pipe', 'pipe', 'pipe'] });
    return '';
  } catch (error) {
    return String(error.stderr || '');
  }
}

/* ---------------------------------------------------------------- preflight */

if (IS_YOUTUBE) {
  now('preflight: youtube.com from this machine');
  try {
    const response = await fetch('https://www.youtube.com/robots.txt', { signal: AbortSignal.timeout(15_000) });
    const body = await response.text();
    if (response.status !== 200 || !/user-agent/i.test(body)) throw new Error(`HTTP ${response.status}: ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
  } catch (error) {
    say(`\nFAIL youtube.com is not reachable from this machine — ${error?.name === 'TimeoutError' ? 'timed out after 15s' : error?.message || error}`);
    say('     Nothing below could succeed, so nothing below was attempted.');
    process.exit(1);
  }
  say('   youtube.com reachable');
}

/* ------------------------------------------------------------------- server */

/** Start server/app.py from this checkout, with or without the provider, and wait for its health. */
async function startServer({ pot = '' } = {}) {
  const downloads = join(OUT, pot ? 'with-pot' : 'plain');
  mkdirSync(downloads, { recursive: true });
  const env = {
    ...process.env,
    WEB_DIR: join(ROOT, 'web'),
    DOWNLOAD_DIR: downloads,
    MAX_CONCURRENT_JOBS: '1',
    JOB_TTL_SECONDS: '600',
    // The self-check serves its file on loopback, which the guard refuses by
    // design; the flag that lifts it is what a LAN source needs, and what
    // that check is. A YouTube run leaves the guard on.
    ...(IS_YOUTUBE ? {} : { ALLOW_PRIVATE_HOSTS: '1' }),
    POT_PROVIDER_URL: pot,
    // yt-dlp's own commentary, so the log can say whether the provider was
    // asked for a token and what YouTube answered, not only that it failed.
    YTDLP_VERBOSE: '1',
  };
  delete env.AUTH_TOKEN;
  const child = spawn(PYTHON, ['-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', String(PORT), '--log-level', 'warning'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  child.on('exit', (code) => { if (code !== null && code !== 0 && stage !== 'closing') say(`   server exited with code ${code}\n${log.slice(-800)}`); });
  child.said = () => log;

  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return { child, health: await response.json() };
    } catch {
      /* not yet */
    }
    if (child.exitCode !== null) break;
    await sleep(400);
  }
  say(`\nFAIL the server did not answer /api/health within 30s\n${log.slice(-1500)}`);
  child.kill();
  process.exit(1);
}

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(120_000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* not JSON */
  }
  return { status: response.status, body };
}

/* ---------------------------------------------------------------- one pass */

async function pass({ pot = '' } = {}) {
  const label = pot ? 'with the proof-of-origin provider' : 'plain';
  say(`\n=== server, ${label}`);
  now(`${label}: starting the server`);
  const { child, health } = await startServer({ pot });
  say(`   yt-dlp ${health.ytDlpVersion}, ffmpeg ${health.ffmpeg ? 'present' : 'MISSING'}, JS runtime ${health.jsRuntime ? 'present' : 'MISSING'}, provider ${health.potProvider ? 'configured' : 'off'}, cookies ${health.hasCookies ? 'stored' : 'none'}`);

  // 1. Resolve: the extractor alone, no download. This is what the split
  //    (a device downloading through the tunnel) starts with.
  now(`${label}: resolving`);
  const resolved = await api('/api/resolve', { method: 'POST', body: JSON.stringify({ url: VIDEO }) });
  if (resolved.status === 200 && resolved.body?.formats?.length) {
    verdict(true, `${label}: resolve named ${resolved.body.formats.length} format(s) via ${resolved.body.extractor}`, `"${resolved.body.title}"`);
  } else {
    verdict(false, `${label}: resolve produced nothing`, `HTTP ${resolved.status}: ${String(resolved.body?.detail || JSON.stringify(resolved.body)).slice(0, 300)}`);
  }

  // 2. A job, the whole download: yt-dlp does everything, walking its client
  //    ladder on a bot wall, and the file comes back over the API.
  for (const preset of ['audio_m4a', 'video_480']) {
    now(`${label}: ${preset} job`);
    const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ url: VIDEO, preset }) });
    if (created.status !== 200 || !created.body?.id) {
      verdict(false, `${label}: ${preset} job was refused`, `HTTP ${created.status}: ${String(created.body?.detail || JSON.stringify(created.body)).slice(0, 300)}`);
      continue;
    }
    const id = created.body.id;
    const started = Date.now();
    let job = created.body;
    let lastSeen = '';
    while (Date.now() - started < 240_000) {
      await sleep(1000);
      job = (await api(`/api/jobs/${id}`)).body || job;
      // Every change of client or stage is a line: the ladder is the story.
      const seen = `${job.stage}/${job.client || '-'}/${job.attempts || 0}`;
      if (seen !== lastSeen) {
        say(`   ${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s  ${job.stage.padEnd(11)} client ${job.client || '-'}${job.attempts ? `, ${job.attempts} wall(s) hit` : ''}`);
        lastSeen = seen;
      }
      if (job.state === 'done' || job.state === 'error') break;
    }
    if (job.state === 'done') {
      const response = await fetch(`${BASE}/api/jobs/${id}/file`, { signal: AbortSignal.timeout(120_000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const saved = join(OUT, `${pot ? 'pot-' : ''}${job.filename || `${preset}.bin`}`);
      writeFileSync(saved, bytes);
      const report = inspect(saved);
      const ok = preset === 'audio_m4a'
        ? /Audio: aac/.test(report) && !/Video: (h264|vp9|av1)/.test(report)
        : /Video: (h264|vp9|av1)/.test(report);
      verdict(ok, `${label}: ${preset} produced ${preset === 'audio_m4a' ? 'AAC audio' : 'real video'} via client ${job.client}${job.attempts ? ` after ${job.attempts} wall(s)` : ''}`,
        `${job.filename}, ${bytes.length} bytes${preset === 'video_480' ? `, ${(/\d{3,4}x\d{3,4}/.exec(report) || ['?'])[0]}` : ''}`);
    } else {
      verdict(false, `${label}: ${preset} did not produce a file (client ${job.client || '-'}, ${job.attempts || 0} wall(s) hit, ${job.state})`, String(job.error || 'no error text').slice(0, 400));
    }
  }

  // What yt-dlp said while all that happened: the lines about clients, tokens
  // and refusals, which are the evidence — in particular whether the provider
  // was ever asked for a token, and what YouTube answered when it was.
  const said = child.said().split(/\r?\n/).filter((line) => /po.?token|pot|proof|client|sign in|not a bot|warning|error|extract/i.test(line) && !/uvicorn|INFO:/.test(line));
  const unique = [...new Set(said.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim()))].filter(Boolean);
  say(`   yt-dlp said (${unique.length} distinct line(s) about clients, tokens and refusals):`);
  for (const line of unique.slice(0, 40)) say(`      ${line.slice(0, 220)}`);

  now('closing');
  child.kill();
  await sleep(300);
  stage = 'between passes';
}

/* ---------------------------------------------------------------- the run */

say(`video: ${VIDEO}`);
await pass({ pot: '' });

if (POT) {
  now('checking the proof-of-origin provider answers');
  let answered = '';
  try {
    const response = await fetch(`${POT}/ping`, { signal: AbortSignal.timeout(10_000) });
    answered = `HTTP ${response.status}`;
  } catch (error) {
    answered = '';
    say(`   ${POT} did not answer: ${error?.cause?.code || error?.message || error}`);
  }
  if (answered) {
    say(`   ${POT}/ping → ${answered}`);
    await pass({ pot: POT });
  } else {
    verdict(false, 'the proof-of-origin provider is not answering, so the second pass was not made');
  }
} else {
  say('\nproof-of-origin provider: POT_PROVIDER_URL not set, second pass skipped');
}

const failed = verdicts.filter((ok) => !ok).length;
say(`\n${verdicts.length - failed}/${verdicts.length} checks passed`);
if (failed && process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### The server against YouTube: ${failed} failed\n\nSee the job log for what yt-dlp said, client by client.\n`);
}
process.exit(failed ? 1 : 0);
