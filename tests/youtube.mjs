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
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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
const PIPED = (process.env.SIPHON_PIPED_URL || '').replace(/\/+$/, '');
// The bundled Invidious list, which is what a fresh visitor to the Pages
// deploy starts from. Walked until one delivers, capped so a bad day for the
// whole network cannot eat the deadline.
// The relay the site ships as its default, if the relay-config workflow found
// one: the exact thing a fresh visitor gets, so it is tried too.
const SITE = (() => {
  try {
    return JSON.parse(readFileSync(join(WEB, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const INVIDIOUS = process.env.SIPHON_INVIDIOUS_URL
  ? [process.env.SIPHON_INVIDIOUS_URL.replace(/\/+$/, '')]
  : JSON.parse(readFileSync(join(WEB, 'instances.json'), 'utf8')).invidious.slice(0, Number(process.env.SIPHON_INVIDIOUS_TRIES || 99));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/**
 * A hard ceiling on the whole run.
 *
 * Every wait below has its own timeout, but a job that is informative rather
 * than gating must never be able to sit on a runner for hours: the first CI
 * run of this file did, and nothing it could have reported was worth that.
 * The per-attempt budget is 60 s probe + 150 s download; the relay attempts,
 * the Piped one and a short walk of Invidious instances fit in twenty
 * minutes, so anything past that is a hang.
 */
const DEADLINE_MS = 20 * 60 * 1000;
setTimeout(() => {
  say(`\nFAIL watchdog: still running after ${DEADLINE_MS / 60000} minutes — hung while ${stage}`);
  process.exit(1);
}, DEADLINE_MS);

/**
 * What the run is doing right now, so a watchdog kill names the step. The
 * second CI run of this file exited by watchdog having printed nothing at
 * all, which pinned the hang to "somewhere before the preflight" and no
 * closer; a run that cannot say where it is stuck is not informative.
 */
let stage = 'starting';
const now = (what) => {
  stage = what;
  say(`.. ${what}`);
};

/** A promise that gives up: `AbortSignal.timeout` covers a fetch, this covers everything else. */
const within = (ms, what, promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms).unref()),
  ]);

/* ------------------------------------------------------------------ servers */

const relay = spawn(process.execPath, [join(HERE, '..', 'relay', 'serve.mjs')], {
  env: { ...process.env, PORT: String(RELAY_PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});

/**
 * Wait for the relay to say it is listening — on the accumulated output, not
 * on each chunk. A pipe hands text over in arbitrary pieces, and the first CI
 * run of this file most likely died here: the marker straddled two chunks,
 * no single chunk contained it, and the loop waited for a line that had
 * already gone by. Ten seconds is generous for a process that prints four
 * lines on start; past that it did not start, and that is the report.
 */
now('waiting for the relay to listen');
await new Promise((resolve, reject) => {
  let seen = '';
  const timer = setTimeout(() => reject(new Error('the relay did not report listening within 10s')), 10_000);
  relay.stdout.on('data', (chunk) => {
    seen += String(chunk);
    if (seen.includes('relay listening')) {
      clearTimeout(timer);
      resolve();
    }
  });
  relay.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`the relay exited with code ${code} before listening`));
  });
});

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
now('starting the app server');
await within(10_000, 'app.listen', new Promise((resolve, reject) => {
  // A port already in use raises 'error' and never calls back — with the
  // relay's pipe keeping the loop alive, that is a silent hang. Not any more.
  app.once('error', reject);
  app.listen(APP_PORT, '127.0.0.1', resolve);
}));

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
  const ROBOTS = 'https://www.youtube.com/robots.txt';
  const probe = async (url) => {
    try {
      const response = await within(20_000, 'the fetch', fetch(url, { signal: AbortSignal.timeout(15_000) }));
      const body = await within(20_000, 'reading the body', response.text());
      if (response.status !== 200 || !/user-agent/i.test(body)) {
        return `HTTP ${response.status}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`;
      }
      return '';
    } catch (error) {
      return error?.name === 'TimeoutError' ? 'timed out after 15s' : String(error?.message || error);
    }
  };
  const bail = (line) => {
    say(`\nFAIL ${line}`);
    say('     Nothing below could succeed, so nothing below was attempted.');
    relay.kill();
    app.close();
    process.exit(1);
  };

  // Two questions, asked separately, because they have different answers:
  // can this machine reach YouTube at all, and does the relay pass it on.
  now('preflight: youtube.com from this machine');
  const direct = await probe(ROBOTS);
  if (direct) bail(`youtube.com is not reachable from this machine — ${direct}`);

  // And what each Invidious instance says to a bare request from this
  // machine, before any browser is involved: a status is an answer, a
  // timeout is the instance (or a firewall in front of it) swallowing the
  // runner's traffic, and the two read very differently in the walk below.
  //
  // Two asks per instance, both with an Origin header as a page would send:
  // the stats endpoint, which says whether the instance is up at all, and the
  // videos endpoint the app actually uses. For each, the status and — the
  // fact that decides everything for a page — whether the answer carries
  // Access-Control-Allow-Origin. A 200 without it is a server that works
  // and a browser that will refuse it; the browser reports that only as
  // net::ERR_FAILED, which says nothing.
  say('\ninvidious instances, straight from this machine (Origin: https://example.github.io):');
  const id = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/.exec(VIDEO);
  const videoId = (id && (id[1] || id[2])) || 'jNQXAC9IVRw';
  const ask = async (url) => {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', Origin: 'https://example.github.io' },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const cors = response.headers.get('access-control-allow-origin');
      const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 110);
      return `HTTP ${response.status} in ${Date.now() - started}ms, cors=${cors ? JSON.stringify(cors) : 'NONE'} — ${body}`;
    } catch (error) {
      return error?.name === 'TimeoutError' ? 'no answer in 15s' : `${error?.cause?.code || error?.name || 'error'}: ${String(error?.cause?.message || error?.message || error).slice(0, 110)}`;
    }
  };
  for (const address of INVIDIOUS) {
    const host = new URL(address).host;
    say(`   ${host.padEnd(28)} stats   ${await ask(`${address}/api/v1/stats`)}`);
    say(`   ${''.padEnd(28)} videos  ${await ask(`${address}/api/v1/videos/${videoId}?local=true`)}`);
  }

  now('preflight: youtube.com through the relay');
  const relayed = await probe(`http://127.0.0.1:${RELAY_PORT}/?url=${encodeURIComponent(ROBOTS)}`);
  if (relayed) bail(`youtube.com is reachable, but not through the relay — ${relayed}`);
  say('\nyoutube.com reachable, directly and through the relay');
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

now('launching chromium');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 412, height: 915 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.addInitScript(
  ([relayUrl, coreUrl]) => {
    // This runs on every navigation, the reload inside attempt() included, so
    // it only seeds the very first load; what attempt() writes between
    // navigations must survive the reload that follows it.
    if (!localStorage.getItem('siphon:settings')) {
      localStorage.setItem('siphon:settings', JSON.stringify({
        endpoint: relayUrl, key: '', helper: { kind: 'relay', label: 'relay' },
        // What this job measures is the helper it was given, so it must not
        // wander off to a different instance when that one refuses.
        autoInstance: false,
        coreUrl: coreUrl || '', preset: 'video_480', subs: 'off',
      }));
    }
    localStorage.setItem('siphon:install-dismissed', '1');
  },
  [`http://127.0.0.1:${RELAY_PORT}`, process.env.SIPHON_CORE_URL || ''],
);

// The first InnerTube call, exactly as the page sends it. A hand-built
// request from the same runner gets a 200 where this gets a 400, so the
// difference is in here somewhere — and it can only be found by looking.
let dumped = false;
page.on('request', (request) => {
  if (dumped || request.method() !== 'POST') return;
  const url = request.url();
  if (!url.startsWith(`http://127.0.0.1:${RELAY_PORT}/?url=`) || !/youtubei\/v1\/player/.test(decodeURIComponent(url))) return;
  dumped = true;
  const headers = Object.entries(request.headers()).map(([k, v]) => `${k}: ${v.slice(0, 200)}`).join('\n        ');
  say(`   first InnerTube request, as the page sends it:\n        ${headers}\n        body: ${(request.postData() || '').slice(0, 1500)}`);
});

// Where the media bytes actually travelled. If googlevideo ever answers the
// page directly, the relay only has to carry InnerTube's few kilobytes rather
// than every megabyte of video — a different cost model entirely. Counting
// requests on the wire answers that without trusting anything.
const routes = { direct: 0, relayed: 0 };
// Every refusal, with its body. "failed with status code 400" names the
// status and nothing else; the body is where YouTube (or an instance) says
// why, and that sentence is the whole point of running this job at all.
page.on('response', async (response) => {
  const url = response.url();
  // An instance's every answer is worth a line, not only its refusals: the
  // question "was it even asked?" has to be answerable from the log.
  const instance = (PIPED && url.startsWith(PIPED)) || INVIDIOUS.some((address) => url.startsWith(address));
  if (response.status() < 400 && !instance) return;
  const target = url.startsWith(`http://127.0.0.1:${RELAY_PORT}/?url=`) ? `relay -> ${decodeURIComponent(url.slice(url.indexOf('=') + 1))}` : url;
  if (target.startsWith(`http://127.0.0.1:${APP_PORT}`)) return; // a missing icon is not news
  let body = '';
  try {
    body = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
  } catch {
    body = '(body unreadable)';
  }
  say(`   ${response.status()} ${target.slice(0, 160)}\n        ${body}`);
});
// A request that never got a response is the one case the response listener
// above cannot describe — and it is what three Invidious instances did to
// the first walk. The browser's own reason for giving up is the fact to log.
page.on('requestfailed', (request) => {
  const url = request.url();
  const instance = (PIPED && url.startsWith(PIPED)) || INVIDIOUS.some((address) => url.startsWith(address));
  if (!instance) return;
  say(`   FAILED ${url.slice(0, 160)}\n        ${request.failure()?.errorText || '(no reason given)'}`);
});
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

async function attempt(preset, { piped = '', invidious = '', relay = '', cobalt = '' } = {}) {
  const instance = piped || invidious || cobalt;
  const label = piped ? `${preset} via piped` : invidious ? `${preset} via ${new URL(invidious).host}` : cobalt ? `${preset} via cobalt ${new URL(cobalt).host}` : relay ? `${preset} via the site's relay` : preset;
  now(`${label}: loading the app`);
  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'networkidle' });
  // One helper at a time, which is the app's model: the relay for the relay
  // attempts, the instance for the Piped and Invidious ones. autoInstance is
  // off so the app tests the address it was given, not one it went and found.
  await page.evaluate(
    ([address, kind, relayUrl, siteInstance]) => {
      localStorage.removeItem('siphon:queue');
      const settings = JSON.parse(localStorage.getItem('siphon:settings') || '{}');
      settings.endpoint = address || relayUrl;
      settings.siteInstance = siteInstance || '';
      settings.helper = kind === 'piped' ? { kind: 'piped', label: 'Piped instance' }
        : kind === 'invidious' ? { kind: 'invidious', label: 'Invidious instance' }
          : kind === 'cobalt' ? { kind: 'cobalt', label: 'cobalt', ffmpeg: true }
            : { kind: 'relay', label: 'relay' };
      settings.autoInstance = false;
      localStorage.setItem('siphon:settings', JSON.stringify(settings));
    },
    [instance, piped ? 'piped' : invidious ? 'invidious' : cobalt ? 'cobalt' : 'relay', relay || `http://127.0.0.1:${RELAY_PORT}`, relay ? SITE.instance || '' : ''],
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.check(`input[name="quality"][value="${preset}"]`);
  await page.fill('#url', VIDEO);

  // The probe runs first and names the client that got through; that is the
  // single most useful fact this test can report.
  let client = '(no preview)';
  now(`${label}: probing the video`);
  try {
    // A preview, or the app's own sentence about why there is none — whichever
    // comes first. Waiting the full minute on a probe that failed in fifteen
    // seconds is what made the first walk take three and a half minutes an
    // instance.
    await page.waitForFunction(
      () => document.querySelector('.preview-meta:not(.skeleton)') || (document.getElementById('feedback')?.textContent || '').trim(),
      null, { timeout: instance ? 20_000 : 60_000 });
    if (!(await page.$('.preview-meta:not(.skeleton)'))) throw new Error('no preview');
    client = ((await page.textContent('.preview-meta')) || '').split('·').pop().trim();
  } catch {
    // A probe the app refused outright is written to #feedback as a sentence;
    // that is the reason worth reporting, not "selector timed out".
    const note = ((await page.textContent('#feedback').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (note) client = `(probe failed: ${note.slice(0, 140)})`;
  }

  now(`${label}: downloading`);
  const waiting = page.waitForEvent('download', { timeout: 150_000 });
  // A row that has already failed is an answer; waiting the remaining two
  // and a half minutes for a download that will not come is not.
  const failed = page.waitForSelector('.q-error', { timeout: 150_000 }).then(() => 'failed').catch(() => 'failed');
  await page.click('#go');

  try {
    const outcome = await Promise.race([waiting, failed]);
    if (outcome === 'failed') throw new Error('the row failed');
    const saved = join(OUT, outcome.suggestedFilename());
    await outcome.saveAs(saved);
    return { saved, client };
  } catch {
    waiting.catch(() => {});
    const row = (await page.textContent('.q-error .q-msg').catch(() => '')) || (await page.textContent('.q-msg').catch(() => '')) || '';
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

/*
 * Invidious: the plan for the Pages deploy. The bundled list is walked until
 * one instance delivers the video to the browser mode — which is exactly what
 * a fresh visitor gets — and the verdict names the instance that did.
 */
{
  say(`\ninvidious: ${INVIDIOUS.length} instance(s) from the bundled list`);
  let delivered = null;
  const refusals = [];
  for (const address of INVIDIOUS) {
    const r = await attempt('video_480', { invidious: address });
    if (r.saved) {
      const report = inspect(r.saved);
      if (/Video: (h264|vp9|av1)/.test(report)) {
        delivered = { address, client: r.client, size: (/\d{3,4}x\d{3,4}/.exec(report) || [])[0] || r.saved };
        break;
      }
      refusals.push(`${new URL(address).host}: a file, but not video`);
    } else {
      refusals.push(`${new URL(address).host}: ${r.error}`);
    }
  }
  for (const line of refusals) say(`   ${line.slice(0, 200)}`);
  if (delivered) {
    verdict(true, `invidious: video_480 produced real video through ${new URL(delivered.address).host} (${delivered.client})`, delivered.size);
  } else {
    verdict(false, `invidious: none of ${INVIDIOUS.length} instance(s) delivered the video`, refusals[0] || '');
  }
}

/*
 * The measured ones: what the daily refresh saw answer a page, of every
 * kind — the chips a visitor is offered. Each is tried as a visitor would
 * take it; the verdict names the one that delivered, or every refusal.
 */
{
  const open = (() => {
    try {
      return JSON.parse(readFileSync(join(WEB, 'instances.json'), 'utf8')).open || [];
    } catch {
      return [];
    }
  })();
  if (open.length === 0) {
    say('\nmeasured instances: none in web/instances.json, so no chips are offered, skipped');
  } else {
    say(`\nmeasured instances: ${open.length} in web/instances.json (the chips)`);
    let delivered = null;
    const refusals = [];
    for (const entry of open) {
      const r = await attempt('video_480', { [entry.kind]: entry.url });
      if (r.saved && /Video: (h264|vp9|av1)/.test(inspect(r.saved))) {
        delivered = entry;
        break;
      }
      refusals.push(`${entry.kind} ${new URL(entry.url).host}: ${r.error || 'a file, but not video'}`);
    }
    for (const line of refusals) say(`   ${line.slice(0, 200)}`);
    if (delivered) verdict(true, `measured: video_480 produced real video through ${delivered.kind} ${new URL(delivered.url).host}`);
    else verdict(false, `measured: none of ${open.length} chip(s) delivered the video`, refusals[0] || '');
  }
}

/* The site's default: the relay the relay-config workflow found, if any. */
if (SITE.relay) {
  say(`\nsite relay: ${SITE.relay} (${SITE.relayKind || '?'}, instance ${SITE.instance || '-'})`);
  const r = await attempt('video_480', { relay: SITE.relay });
  if (r.saved) {
    const report = inspect(r.saved);
    verdict(/Video: (h264|vp9|av1)/.test(report), `site relay: video_480 produced real video via ${r.client}`, (/\d{3,4}x\d{3,4}/.exec(report) || [])[0] || r.saved);
  } else {
    verdict(false, `site relay: no file (probe client: ${r.client})`, r.error);
  }
} else {
  say('\nsite relay: none in web/config.json, skipped');
}

/* The site's cobalt instance, if the measurement found one that delivers. */
if (SITE.cobalt) {
  say(`\nsite cobalt: ${SITE.cobalt}`);
  const r = await attempt('video_480', { cobalt: SITE.cobalt });
  if (r.saved) {
    const report = inspect(r.saved);
    verdict(/Video: (h264|vp9|av1)/.test(report), `site cobalt: video_480 produced real video via ${new URL(SITE.cobalt).host}`, (/\d{3,4}x\d{3,4}/.exec(report) || [])[0] || r.saved);
  } else {
    verdict(false, `site cobalt: no file`, r.error);
  }
} else {
  say('\nsite cobalt: none in web/config.json, skipped');
}

verdict(pageErrors.length === 0, 'no uncaught errors in the page', pageErrors.slice(0, 2).join(' ; '));

now('closing');
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
