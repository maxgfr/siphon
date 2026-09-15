/**
 * YouTube, for real.
 *
 * Every other suite avoids the network on purpose. This one exists to answer
 * the question they cannot: does the browser mode actually get a file out of
 * YouTube when a relay is in front of it? The relay is the Node runner in
 * relay/serve.mjs, so the code under test is the code that ships.
 *
 *   npm run test:youtube
 *
 * Needs playwright, ffmpeg, and a network that reaches youtube.com and
 * jsDelivr — which is why it runs in CI and not in every sandbox. It is
 * informative rather than gating there: YouTube's bot wall is a property of
 * the runner's IP, not of this code, and a red that means "YouTube was
 * suspicious today" should not block a merge. What it must never do is fail
 * silently — the verdict names the client that worked, or the exact refusal.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSync } from 'node:fs';

/**
 * console.log to a pipe is asynchronous in Node, so a process killed by a
 * timeout takes its unflushed output with it — which is exactly the moment
 * the output matters. Writing to the descriptor directly cannot be lost.
 */
const say = (line = '') => writeSync(1, `${line}\n`);

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const OUT = join(HERE, '.youtube');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// The first video ever uploaded: 19 seconds, public, and not going anywhere.
const VIDEO = process.env.SIPHON_YT_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const APP_PORT = 8790;
const RELAY_PORT = 8791;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ servers */

const relay = spawn(process.execPath, [join(HERE, '..', 'relay', 'serve.mjs')], {
  env: { ...process.env, PORT: String(RELAY_PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
for await (const chunk of relay.stdout) if (String(chunk).includes('relay listening')) break;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const app = createServer((request, response) => {
  let path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const file = join(WEB, path);
  try {
    const stats = statSync(file);
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': stats.size });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => app.listen(APP_PORT, '127.0.0.1', resolve));

/* ---------------------------------------------------------------- preflight */

/**
 * Prove the relay can reach YouTube before opening a browser at all.
 *
 * Without this, a sandbox with no route to youtube.com sits through every
 * timeout below and then dies having printed nothing — which is what
 * happened the first time this ran. A test that cannot tell "unreachable"
 * from "refused" is not informative, and informative is the only reason this
 * one exists.
 */
{
  // robots.txt is public, tiny, and unmistakable: a 200 whose body names a
  // User-agent came from YouTube. Any other status — a gateway's 403, a
  // relay's 502 — did not, whatever it says.
  const target = `http://127.0.0.1:${RELAY_PORT}/?url=${encodeURIComponent('https://www.youtube.com/robots.txt')}`;
  let reason = '';
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(15_000) });
    const body = await response.text();
    if (response.status !== 200 || !/user-agent/i.test(body)) {
      reason = `HTTP ${response.status}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`;
    }
  } catch (error) {
    reason = error?.name === 'TimeoutError' ? 'timed out after 15s' : String(error?.message || error);
  }
  if (reason) {
    say(`\nFAIL youtube.com is not reachable through the relay — ${reason}`);
    say('     Nothing below could succeed, so nothing below was attempted.');
    relay.kill();
    app.close();
    process.exit(1);
  }
  say('\nyoutube.com reachable through the relay');
}

/* ------------------------------------------------------------------- driver */

function inspect(file) {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['pipe', 'pipe', 'pipe'] });
    return '';
  } catch (error) {
    return String(error.stderr || '');
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 412, height: 915 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.addInitScript(
  ([relayUrl, coreUrl]) => {
    localStorage.setItem('siphon:settings', JSON.stringify({
      mode: 'browser', preset: 'video_480', subs: 'off', relayUrl, coreUrl: coreUrl || '',
    }));
    localStorage.setItem('siphon:install-dismissed', '1');
  },
  [`http://127.0.0.1:${RELAY_PORT}`, process.env.SIPHON_CORE_URL || ''],
);

// Where the media bytes actually travelled. If googlevideo ever answers the
// page directly, the relay only has to carry InnerTube's few kilobytes rather
// than every megabyte of video — a different cost model entirely. Counting
// requests on the wire answers that without trusting anything.
const routes = { direct: 0, relayed: 0 };
page.on('request', (request) => {
  const url = request.url();
  if (/googlevideo\.com/.test(url)) routes.direct += 1;
  else if (url.startsWith(`http://127.0.0.1:${RELAY_PORT}/?url=`) && /googlevideo/.test(decodeURIComponent(url))) routes.relayed += 1;
});

const verdicts = [];
const verdict = (ok, label, detail = '') => {
  verdicts.push(ok);
  say(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function attempt(preset, { piped = '' } = {}) {
  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await page.evaluate(
    (instance) => {
      localStorage.removeItem('siphon:queue');
      const settings = JSON.parse(localStorage.getItem('siphon:settings') || '{}');
      settings.pipedUrl = instance;
      localStorage.setItem('siphon:settings', JSON.stringify(settings));
    },
    piped,
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.check(`input[name="quality"][value="${preset}"]`);
  await page.fill('#url', VIDEO);

  // The probe runs first and names the client that got through; that is the
  // single most useful fact this test can report.
  let client = '(no preview)';
  try {
    await page.waitForSelector('.preview-meta:not(.skeleton)', { timeout: 60_000 });
    client = ((await page.textContent('.preview-meta')) || '').split('·').pop().trim();
  } catch {
    // A probe the app refused outright is written to #feedback as a sentence;
    // that is the reason worth reporting, not "selector timed out".
    const note = ((await page.textContent('#feedback').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (note) client = `(probe failed: ${note.slice(0, 140)})`;
  }

  const waiting = page.waitForEvent('download', { timeout: 150_000 });
  await page.click('#go');

  try {
    const event = await waiting;
    const saved = join(OUT, event.suggestedFilename());
    await event.saveAs(saved);
    return { saved, client };
  } catch {
    const row = (await page.textContent('.q-msg').catch(() => '')) || '';
    return { error: row.trim() || 'no download and no message', client };
  }
}

/* ---------------------------------------------------------------- the run */

say(`\nvideo: ${VIDEO}`);

{
  const r = await attempt('video_480');
  if (r.saved) {
    const report = inspect(r.saved);
    verdict(/Video: (h264|vp9|av1)/.test(report), `video_480 produced real video via ${r.client}`, (/\d{3,4}x\d{3,4}/.exec(report) || [])[0] || r.saved);
  } else {
    verdict(false, `video_480 did not produce a file (probe client: ${r.client})`, r.error);
  }
}

{
  const r = await attempt('audio_m4a');
  if (r.saved) {
    const report = inspect(r.saved);
    verdict(/Audio: aac/.test(report) && !/Video: (h264|vp9|av1)/.test(report), `audio_m4a produced AAC audio via ${r.client}`, r.saved.split('/').pop());
  } else {
    verdict(false, `audio_m4a did not produce a file (probe client: ${r.client})`, r.error);
  }
}

say(`\nmedia bytes: ${routes.direct} request(s) straight to googlevideo, ${routes.relayed} through the relay`);
if (routes.direct > 0 && routes.relayed === 0) {
  say('     -> googlevideo answered the page directly; the relay carried only the API call');
}

/* Piped: the same video with nothing of ours in front of it at all. */
const PIPED = process.env.SIPHON_PIPED_URL || '';
if (PIPED) {
  say(`\npiped instance: ${PIPED}`);
  const r = await attempt('video_480', { piped: PIPED });
  if (r.saved) {
    const report = inspect(r.saved);
    verdict(/Video: (h264|vp9|av1)/.test(report), `piped: video_480 produced real video via ${r.client}`, (/\d{3,4}x\d{3,4}/.exec(report) || [])[0] || r.saved);
  } else {
    verdict(false, `piped: no file (probe client: ${r.client})`, r.error);
  }
} else {
  say('\npiped instance: not set (SIPHON_PIPED_URL), skipped');
}

verdict(pageErrors.length === 0, 'no uncaught errors in the page', pageErrors.slice(0, 2).join(' ; '));

await browser.close();
app.close();
relay.kill();

const failed = verdicts.filter((ok) => !ok).length;
say(`\n${verdicts.length - failed}/${verdicts.length} checks passed`);
if (failed && process.env.GITHUB_STEP_SUMMARY) {
  // Make the reason readable from the Actions summary without opening logs.
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### YouTube end-to-end: ${failed} failed\n\nSee the job log for the exact refusal.\n`);
}
process.exit(failed ? 1 : 0);
