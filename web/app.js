/**
 * siphon — UI.
 *
 * One screen, one job at a time, driven by a small state machine:
 *
 *   idle → (probing) → ready → working → done
 *                                  ↘ error ↩
 *
 * Everything that talks to a backend lives in api.js; this file owns the DOM
 * and the state. The bias throughout is towards a phone: one column, one
 * primary action pinned within thumb reach, and no interaction that needs a
 * hover or a precise tap.
 */
import { PRESETS, BackendError, makeBackend, ServerBackend } from './api.js';

const SETTINGS_KEY = 'siphon:settings';
const POLL_MS = 700;

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'server',
  serverUrl: '',
  serverKey: '',
  publicUrl: '',
  publicKey: '',
  // Browser mode: both optional. An empty relay is the honest default — it
  // means "nothing but this device", and the hosts that need one say so.
  relayUrl: '',
  pipedUrl: '',
  coreUrl: '',
  preset: 'video_best',
  subs: 'off',
  subLangs: 'en',
});

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let backend = null;
let probeToken = 0;
let lastProbe = null;
let wantPlaylist = false;
const recent = [];

/* ---------------------------------------------------------------- settings */

/**
 * Read the saved settings, and say whether there were any.
 *
 * "First visit" is the thing the caller actually needs to know: it is the one
 * moment where choosing a mode on the user's behalf is helpful rather than
 * presumptuous, because there is nothing of theirs to override.
 */
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { settings: { ...DEFAULT_SETTINGS, ...JSON.parse(raw || '{}') }, firstVisit: !raw };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, firstVisit: true };
  }
}

/**
 * Which mode a brand-new visitor should land in.
 *
 * `server` is only the right default when a server is actually there, which is
 * the case that matters: the container serves this page and the API from one
 * origin, and that setup must keep working with nothing configured. Anywhere
 * else — GitHub Pages, any static host — there is no server behind the page,
 * and defaulting to one means the first thing a visitor sees is a dead end
 * telling them to go and set something up. Browser mode works on arrival.
 *
 * The probe is one request, on the first visit only; the answer is saved.
 */
async function pickInitialMode() {
  try {
    await new ServerBackend({ base: '' }).health();
    return 'server';
  } catch {
    return 'browser';
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode — the session still works, it just won't be remembered */
  }
}

/* ----------------------------------------------------------------- helpers */

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Platform facts the UI has to behave differently for.
 *
 * iOS is the awkward one: it has no install prompt (the user goes through the
 * Share sheet by hand), no Web Share Target, and — the part that actually
 * breaks things — a home-screen web app where a synthetic click on a download
 * link frequently does nothing at all. So the finished file has to be offered
 * as a real link the user taps.
 */
const platform = {
  ios: /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  get standalone() {
    return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  },
};

function looksLikeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ render */

function renderQualities() {
  const host = $('qualities');
  host.innerHTML = '';
  for (const preset of PRESETS) {
    const label = document.createElement('label');
    label.className = 'quality';
    label.innerHTML =
      `<input type="radio" name="quality" value="${preset.id}" ${preset.id === settings.preset ? 'checked' : ''} />` +
      `<span><b>${escapeHtml(preset.label)}</b><small>${escapeHtml(preset.note)}</small></span>`;
    label.querySelector('input').addEventListener('change', (event) => {
      settings.preset = event.target.value;
      saveSettings();
    });
    host.appendChild(label);
  }
}

function renderPreview(info, { loading = false } = {}) {
  const host = $('preview');
  if (loading) {
    host.hidden = false;
    host.className = 'preview';
    host.innerHTML =
      '<div class="skeleton" style="width:104px;aspect-ratio:16/9;border-radius:10px;flex:none"></div>' +
      '<div class="preview-body"><p class="preview-title skeleton">Loading the title</p>' +
      '<p class="preview-meta skeleton">Loading details</p></div>';
    return;
  }
  if (!info) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  const meta = info.isPlaylist
    ? [info.uploader, `${info.count} videos`].filter(Boolean).join(' · ')
    : [info.uploader, formatDuration(info.duration), info.extractor].filter(Boolean).join(' · ');

  host.hidden = false;
  host.className = 'preview';
  host.innerHTML =
    (info.thumbnail
      ? `<img src="${escapeHtml(info.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : '') +
    '<div class="preview-body">' +
    `<p class="preview-title">${escapeHtml(info.title || 'Untitled')}</p>` +
    (meta ? `<p class="preview-meta">${escapeHtml(meta)}</p>` : '') +
    (info.isPlaylist ? playlistChoiceHtml(info) : '') +
    '</div>';

  if (info.isPlaylist) {
    for (const input of host.querySelectorAll('input[name="scope"]')) {
      input.addEventListener('change', (event) => {
        wantPlaylist = event.target.value === 'all';
        renderPlaylistNote(info);
      });
    }
    renderPlaylistNote(info);
  }
}

/**
 * A link can be a video *inside* a playlist, so taking the whole thing is
 * offered, never assumed — the surprise of fifty downloads is worse than the
 * mild annoyance of one extra tap.
 */
function playlistChoiceHtml(info) {
  const capped = Math.min(info.count, info.limit);
  return (
    '<div class="playlist-choice">' +
    '<div class="seg" role="radiogroup" aria-label="How much of this playlist">' +
    `<label><input type="radio" name="scope" value="one" ${wantPlaylist ? '' : 'checked'} /><span>This one</span></label>` +
    `<label><input type="radio" name="scope" value="all" ${wantPlaylist ? 'checked' : ''} /><span>All ${capped}</span></label>` +
    '</div>' +
    '<p class="playlist-note" id="playlistNote"></p>' +
    '</div>'
  );
}

function renderPlaylistNote(info) {
  const note = $('playlistNote');
  if (!note) return;
  if (!wantPlaylist) {
    note.textContent = 'Only the video this link points at.';
    return;
  }
  note.textContent =
    info.count > info.limit
      ? `Capped at ${info.limit} of ${info.count} — arrives as one .zip`
      : `${info.count} files, arriving as one .zip`;
}

function renderFeedback(html = '') {
  $('feedback').innerHTML = html;
}

function showError(error) {
  const message = error instanceof BackendError ? error.message : String(error?.message || error);
  const hint = error instanceof BackendError ? error.hint : '';
  renderFeedback(
    '<div class="notice error" role="alert">' +
      `<p><strong>Didn't work.</strong> ${escapeHtml(message)}</p>` +
      (hint ? `<p>${escapeHtml(hint)}</p>` : '') +
      '</div>',
  );
}

/** The action bar holds one control: the thing you came to press. */
function renderAction() {
  const go = $('go');
  if (go) go.disabled = !looksLikeUrl($('url').value);
}

/* -------------------------------------------------------------------- queue */

const QUEUE_KEY = 'siphon:queue';
const QUEUE_MAX = 20;

/** Newest first. Holds running and finished downloads alike — same row, same place. */
let queue = [];
let pollTimer = null;

function saveQueue() {
  try {
    // Only what is needed to redraw a row and re-find the file on the server.
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify(queue.slice(0, QUEUE_MAX).map(({ key, id, url, title, preset, state, error, filename }) => ({
        key, id, url, title, preset, state, error, filename,
      }))),
    );
  } catch {
    /* storage off — the queue still works for this session */
  }
}

const STAGE_TEXT = {
  starting: 'Starting…',
  // A bar that silently jumps back to zero reads as a bug. Naming the reason
  // turns the same event into the app visibly working around YouTube.
  retrying: 'Retrying — YouTube asked for a login',
  downloading: 'Downloading',
  processing: 'Converting…',
  packing: 'Packing the zip…',
  ready: 'Ready',
  failed: 'Failed',
};

function rowLabel(entry) {
  if (entry.state === 'error') return entry.error || 'Failed';
  if (entry.state === 'expired') return 'No longer on the server';
  if (entry.state === 'done') return entry.filename || 'Ready';
  const stage = STAGE_TEXT[entry.stage] || 'Working…';
  return entry.itemsTotal ? `${stage} ${entry.itemsDone || 1}/${entry.itemsTotal}` : stage;
}

function renderQueue() {
  const section = $('queue');
  const list = $('queueList');
  section.hidden = queue.length === 0;
  if (queue.length === 0) {
    // Empty the DOM too, not just hide it: leaving the old rows in place means
    // they flash back the next time the section is shown.
    list.innerHTML = '';
    return;
  }

  const running = queue.filter((e) => e.state === 'running' || e.state === 'starting').length;
  $('queueLabel').textContent = running ? `Downloads — ${running} running` : 'Downloads';
  $('queueClear').hidden = !queue.some((e) => e.state !== 'running' && e.state !== 'starting');

  list.innerHTML = '';
  for (const entry of queue) {
    const item = document.createElement('li');
    if (entry.state === 'error' || entry.state === 'expired') item.className = 'q-error';

    const active = entry.state === 'running' || entry.state === 'starting';
    const determinate = entry.stage === 'downloading' && entry.totalBytes;
    const percent = Math.round((entry.progress || 0) * 100);

    const bits = [];
    if (active && entry.speed) bits.push(`${formatBytes(entry.speed)}/s`);
    if (active && entry.eta) bits.push(`${formatDuration(entry.eta)} left`);
    if (!active && entry.totalBytes) bits.push(formatBytes(entry.totalBytes));
    if (entry.attempts > 0 && entry.client) bits.push(`attempt ${entry.attempts + 1} · ${entry.client}`);

    item.innerHTML =
      '<div class="q-top">' +
      `<span class="q-title">${escapeHtml(entry.title || entry.url)}</span>` +
      (active && determinate ? `<span class="q-pct">${percent}%</span>` : '') +
      '</div>' +
      (active
        ? `<div class="q-bar"><div class="q-fill${determinate ? '' : ' indeterminate'}" style="${determinate ? `width:${percent}%` : ''}"></div></div>`
        : '') +
      `<p class="q-msg">${escapeHtml(rowLabel(entry))}</p>` +
      '<div class="q-foot">' +
      `<span>${escapeHtml(bits.join(' · '))}</span>` +
      '<span class="spacer"></span>' +
      (entry.state === 'done' && entry.fileUrl
        ? `<a class="q-act primary" href="${escapeHtml(entry.fileUrl)}" download>Save</a>`
        : '') +
      (active ? `<button class="q-act" type="button" data-cancel="${entry.key}">Cancel</button>` : '') +
      (entry.state === 'error' ? `<button class="q-act" type="button" data-retry="${entry.key}">Try again</button>` : '') +
      '</div>';
    list.appendChild(item);
  }

  for (const button of list.querySelectorAll('[data-cancel]')) {
    button.addEventListener('click', () => cancelEntry(button.dataset.cancel));
  }
  for (const button of list.querySelectorAll('[data-retry]')) {
    button.addEventListener('click', () => retryEntry(button.dataset.retry));
  }
}

function findEntry(key) {
  return queue.find((entry) => entry.key === key);
}

function cancelEntry(key) {
  const entry = findEntry(key);
  if (!entry) return;
  if (entry.id) backend.cancel?.(entry.id);
  queue = queue.filter((item) => item !== entry);
  saveQueue();
  renderQueue();
}

function retryEntry(key) {
  const entry = findEntry(key);
  if (!entry) return;
  queue = queue.filter((item) => item !== entry);
  renderQueue();
  enqueue(entry.url, { preset: entry.preset });
}

/* ----------------------------------------------------------------- running */

/**
 * Add one download and return immediately.
 *
 * The URL box is cleared as soon as the job is accepted, because the whole
 * point of a queue is that you can paste the next link while the first is still
 * going. Nothing here waits.
 */
async function enqueue(url, { preset = settings.preset, playlist = wantPlaylist } = {}) {
  const entry = {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    title: lastProbe?.title || url,
    preset,
    state: 'starting',
    stage: 'starting',
    progress: 0,
  };
  queue.unshift(entry);
  if (queue.length > QUEUE_MAX) queue.length = QUEUE_MAX;
  renderQueue();

  try {
    const started = await backend.start(url, preset, {
      playlist,
      subs: settings.subs,
      subLangs: settings.subLangs,
    });
    if (started.kind === 'direct') {
      // A public instance streams the file itself; there is no job to follow.
      entry.state = 'done';
      entry.stage = 'ready';
      entry.fileUrl = started.url;
      entry.filename = started.filename || entry.title;
      handOver(entry);
    } else {
      entry.id = started.id;
      entry.state = 'running';
      startPolling();
    }
  } catch (error) {
    entry.state = 'error';
    entry.error = error instanceof BackendError ? error.message : String(error?.message || error);
    if (error instanceof BackendError && error.hint) entry.error += ` ${error.hint}`;
  }
  saveQueue();
  renderQueue();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollAll, POLL_MS);
}

async function pollAll() {
  const active = queue.filter((entry) => entry.id && (entry.state === 'running' || entry.state === 'starting'));
  if (active.length === 0) {
    clearInterval(pollTimer);
    pollTimer = null;
    return;
  }

  await Promise.all(
    active.map(async (entry) => {
      try {
        const job = await backend.poll(entry.id);
        Object.assign(entry, {
          stage: job.stage,
          progress: job.progress,
          speed: job.speed,
          eta: job.eta,
          totalBytes: job.totalBytes,
          client: job.client,
          attempts: job.attempts,
          itemsDone: job.itemsDone,
          itemsTotal: job.itemsTotal,
          title: job.title || entry.title,
        });
        if (job.state === 'done') {
          entry.state = 'done';
          entry.filename = job.filename;
          entry.fileUrl = backend.fileUrl(entry.id);
          handOver(entry);
        } else if (job.state === 'error') {
          entry.state = 'error';
          entry.error = job.error || 'The download failed.';
        }
      } catch (error) {
        // A 404 means the server swept it; anything else is a real failure.
        entry.state = /no such download/i.test(String(error?.message)) ? 'expired' : 'error';
        if (entry.state === 'error') {
          entry.error = error instanceof BackendError ? error.message : 'Lost contact with the server.';
        }
      }
    }),
  );
  saveQueue();
  renderQueue();
}

/**
 * Hand a finished file to the browser.
 *
 * A synthetic click on an <a> keeps the page in place: the response carries
 * Content-Disposition: attachment, so the browser saves rather than navigates.
 * Inside an iOS home-screen app there is no download manager and the click is
 * dropped silently — so there, the row's own Save button is the whole story and
 * nothing is attempted automatically.
 */
function handOver(entry) {
  if (platform.ios && platform.standalone) return;

  const anchor = document.createElement('a');
  anchor.href = entry.fileUrl;
  // A server response names the file in Content-Disposition, but a blob URL
  // from browser mode carries no headers at all — without this the file lands
  // as a UUID with no extension.
  anchor.download = entry.filename || '';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Re-check stored downloads against the server; the files may still be there. */
async function restoreQueue() {
  try {
    queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    queue = [];
  }
  if (queue.length === 0) return;
  renderQueue();

  await Promise.all(
    queue.map(async (entry) => {
      if (!entry.id) return;
      try {
        const job = await backend.poll(entry.id);
        entry.state = job.state === 'done' ? 'done' : job.state === 'error' ? 'error' : 'running';
        entry.stage = job.stage;
        entry.progress = job.progress;
        entry.filename = job.filename || entry.filename;
        entry.error = job.error;
        if (entry.state === 'done') entry.fileUrl = backend.fileUrl(entry.id);
      } catch {
        // Swept by the TTL, or a different server is configured now.
        entry.state = entry.state === 'done' ? 'expired' : entry.state;
        if (entry.state !== 'expired' && entry.state !== 'error') entry.state = 'expired';
      }
    }),
  );
  saveQueue();
  renderQueue();
  if (queue.some((entry) => entry.state === 'running')) startPolling();
}

/* ------------------------------------------------------------------ backend */

const PRIVACY_NOTE = {
  public: 'In public-instance mode, every link you paste is sent to that instance.',
  server: 'Links go only to the server you configured. Nothing is sent anywhere else.',
  browser: 'Downloads happen on this device. Links go to the site they point at, and nowhere else.',
  browserRelay: 'Downloads happen on this device, except for hosts that refuse a web page — those go through your relay.',
  browserPiped: 'Downloads happen on this device. YouTube links are sent to the Piped instance you configured.',
};

function applyBackend() {
  backend = makeBackend(settings);
  $('privacyNote').textContent =
    settings.mode === 'browser' && settings.pipedUrl
      ? PRIVACY_NOTE.browserPiped
      : settings.mode === 'browser' && settings.relayUrl
        ? PRIVACY_NOTE.browserRelay
        : PRIVACY_NOTE[settings.mode] || PRIVACY_NOTE.server;
}

async function refreshBackendLabel() {
  const label = $('backendLabel');
  label.textContent = 'checking server…';
  try {
    const info = await backend.health();
    const where = { public: 'public instance', browser: 'no server', server: 'your server' }[settings.mode];
    label.textContent = info.ffmpeg === false ? `${info.label} · no ffmpeg` : `${info.label} · ${where}`;
    if (info.ffmpeg === false) {
      renderFeedback(
        '<div class="notice"><p><strong>ffmpeg is missing on that server.</strong> ' +
          'Audio conversion and merged high-quality video will fail until it is installed.</p></div>',
      );
    }
  } catch (error) {
    label.textContent = 'no server — open settings';
    if (settings.mode === 'server' && !settings.serverUrl) {
      renderFeedback(
        '<div class="notice"><p><strong>No server set up yet.</strong> ' +
          'Point this at one in settings — or switch to <strong>In this browser</strong>, ' +
          'which needs nothing at all for direct files and HLS streams.</p>' +
          '<button class="retry" type="button" id="openFromNotice">Open settings</button></div>',
      );
      $('openFromNotice')?.addEventListener('click', openSettings);
    } else {
      showError(error);
    }
  }
}

/* -------------------------------------------------------------------- probe */

let probeTimer = null;

function scheduleProbe() {
  clearTimeout(probeTimer);
  const url = $('url').value.trim();
  if (!looksLikeUrl(url) || !backend?.supportsProbe) {
    renderPreview(null);
    lastProbe = null;
    return;
  }
  probeTimer = setTimeout(() => runProbe(url), 450);
}

async function runProbe(url) {
  const token = ++probeToken;
  wantPlaylist = false;
  renderPreview(null, { loading: true });
  try {
    const info = await backend.probe(url);
    if (token !== probeToken) return; // a newer paste won the race
    lastProbe = info;
    renderPreview(info);
    if (info?.isLive) {
      renderFeedback(
        '<div class="notice"><p><strong>That is a live stream.</strong> ' +
          'It will keep recording until you stop it, so the file has no natural end.</p></div>',
      );
    }
  } catch (error) {
    if (token !== probeToken) return;
    lastProbe = null;
    renderPreview(null);
    // A failed probe is not a failed download — some extractors refuse metadata
    // but download fine — so this is a note, not a blocker.
    if (error instanceof BackendError && !error.retryable) showError(error);
  }
}

/* ----------------------------------------------------------------- settings */

function openSettings() {
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === settings.mode;
  $('serverUrl').value = settings.serverUrl;
  $('serverKey').value = settings.serverKey;
  $('publicUrl').value = settings.publicUrl;
  $('publicKey').value = settings.publicKey;
  $('relayUrl').value = settings.relayUrl;
  $('pipedUrl').value = settings.pipedUrl;
  $('coreUrl').value = settings.coreUrl;
  syncSettingsFields();
  setStatus('', 'Not checked yet');
  $('settings').showModal();
}

function syncSettingsFields() {
  const mode = draftMode();
  $('serverFields').hidden = mode !== 'server';
  $('browserFields').hidden = mode !== 'browser';
  $('publicFields').hidden = mode !== 'public';
  // Only our own server has a cookie store to write to.
  $('cookiesBlock').hidden = mode !== 'server';
}

/** Whichever mode radio is checked, without this file having to list them. */
const draftMode = () => document.querySelector('input[name="mode"]:checked')?.value || DEFAULT_SETTINGS.mode;

function setStatus(kind, text) {
  $('statusDot').className = `dot${kind ? ` ${kind}` : ''}`;
  $('statusText').textContent = text;
}

function draftSettings() {
  return {
    ...settings,
    mode: draftMode(),
    serverUrl: $('serverUrl').value.trim(),
    serverKey: $('serverKey').value.trim(),
    publicUrl: $('publicUrl').value.trim(),
    publicKey: $('publicKey').value.trim(),
    relayUrl: $('relayUrl').value.trim(),
    pipedUrl: $('pipedUrl').value.trim(),
    coreUrl: $('coreUrl').value.trim(),
  };
}

async function testConnection() {
  setStatus('', 'Checking…');
  const draft = draftSettings();
  if (draft.mode === 'browser') {
    // There is nothing to reach, so the useful answer is what this device can
    // and cannot do rather than a green light that means nothing.
    setStatus('ok', draft.pipedUrl
      ? 'Ready — a Piped instance is set, so YouTube goes through it'
      : draft.relayUrl
        ? 'Ready — relay set, so YouTube can be tried too'
        : 'Ready — hosts that allow it only, no relay or instance set');
    showPhoneHint([]);
    return;
  }
  try {
    const info = await makeBackend(draft).health();
    setStatus('ok', `Reachable — ${info.label}${info.ffmpeg === false ? ', but no ffmpeg' : ''}`);
    showPhoneHint(info.lanUrls || []);
    setCookieState(info.hasCookies === true);
  } catch (error) {
    setStatus('bad', error instanceof BackendError ? error.message : 'Could not reach it.');
    showPhoneHint([]);
  }
}

/**
 * Answer "how do I use this from my phone?" with the actual address, rather
 * than sending the user off to find their own IP. Only shown for a server on
 * this network — a deployed one is already reachable from anywhere.
 */
function showPhoneHint(urls) {
  const host = $('phoneHint');
  const body = $('phoneHintBody');
  if (!urls.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  body.innerHTML =
    'On the same Wi-Fi, open this in the phone\'s browser — it serves the app itself, ' +
    'so there is nothing else to set up:<br>' +
    urls.map((url) => `<strong style="font-family:var(--mono)">${escapeHtml(url)}</strong>`).join('<br>') +
    '<br>Away from home, put it behind a tunnel or a VPN — see the README.';
}

/* ------------------------------------------------------------------ cookies */

function setCookieState(present, note = '') {
  $('cookiesState').textContent = present ? '— stored' : '— not set';
  $('cookiesClear').hidden = !present;
  if (note) $('cookiesResult').textContent = note;
}

async function uploadCookies(file) {
  const result = $('cookiesResult');
  if (!file) return;
  if (file.size > 2_000_000) {
    result.textContent = 'That file is far too large to be a cookie jar.';
    return;
  }
  result.textContent = 'Uploading…';
  try {
    const text = await file.text();
    const backend = makeBackend(draftSettings());
    if (!backend.putCookies) throw new BackendError('Cookies only apply to your own server.');
    const info = await backend.putCookies(text);
    setCookieState(true, `Stored ${formatBytes(info.bytes)} of cookies. YouTube downloads will use your session.`);
  } catch (error) {
    setCookieState(false, error instanceof BackendError ? error.message : 'Could not store that file.');
  }
}

async function removeCookies() {
  try {
    await makeBackend(draftSettings()).dropCookies();
    setCookieState(false, 'Removed.');
  } catch (error) {
    $('cookiesResult').textContent = error instanceof BackendError ? error.message : 'Could not remove them.';
  }
}

/* ------------------------------------------------------------------ install */

const INSTALL_DISMISSED = 'siphon:install-dismissed';
let installPrompt = null;

/**
 * Offer installation, which is worth doing here for a concrete reason rather
 * than habit: installed, the app gets its own icon, opens full screen, and on
 * Android registers as a share target — so a link goes from the YouTube app
 * into this one in two taps instead of copy, switch, paste.
 */
function setupInstall() {
  const cta = $('installCta');
  const button = $('installBtn');

  let dismissed = false;
  try {
    dismissed = localStorage.getItem(INSTALL_DISMISSED) === '1';
  } catch { /* storage off; showing it again is the harmless side */ }

  if (dismissed || platform.standalone) return;

  $('installDismiss').addEventListener('click', () => {
    cta.hidden = true;
    try {
      localStorage.setItem(INSTALL_DISMISSED, '1');
    } catch { /* nothing to do */ }
  });

  if (platform.ios) {
    // No prompt exists on iOS; the Share sheet is the only route, so say so.
    $('installTitle').textContent = 'Add it to your Home Screen';
    $('installBody').textContent =
      'Share button at the bottom of Safari, then "Add to Home Screen". It opens full screen, like an app.';
    cta.hidden = false;
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    // Chrome shows its own prompt only if we do not stop it; taking it over
    // lets the offer sit in the page instead of ambushing the user.
    event.preventDefault();
    installPrompt = event;
    $('installTitle').textContent = 'Install this as an app';
    $('installBody').textContent =
      'Own icon, full screen, and you can share links straight from YouTube into it.';
    button.hidden = false;
    cta.hidden = false;
  });

  button.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    cta.hidden = true;
  });
}

/** Languages only matter once subtitles are actually wanted. */
function syncSubFields() {
  const wanted = settings.subs !== 'off';
  $('subLangsField').hidden = !wanted;
  // Better to say the setting will be ignored than to hand back a file that
  // quietly has no subtitles in it.
  $('subsUnsupported').hidden = !(wanted && settings.mode === 'browser');
}

/**
 * Empty the box and its preview, so the next link can go straight in.
 * Called the moment a download is accepted, never before.
 */
function clearInput() {
  const input = $('url');
  input.value = '';
  lastProbe = null;
  wantPlaylist = false;
  probeToken += 1; // abandon any probe still in flight for the old link
  renderPreview(null);
  renderFeedback('');
  renderAction();
}

/* --------------------------------------------------------------------- boot */

function readSharedUrl() {
  // Android share-target and plain ?url= links both land here. The shared text
  // is often "Title https://…", so pull the first URL out of it.
  const params = new URLSearchParams(location.search);
  const candidate = params.get('url') || params.get('text') || params.get('share') || '';
  const match = candidate.match(/https?:\/\/\S+/);
  return match ? match[0] : '';
}

function init() {
  const loaded = loadSettings();
  settings = loaded.settings;
  applyBackend();
  renderQualities();
  renderAction();
  renderQueue();

  $('go').addEventListener('click', () => {
    const url = $('url').value.trim();
    if (!looksLikeUrl(url)) return;
    enqueue(url);
    clearInput();
  });

  $('queueClear').addEventListener('click', () => {
    queue = queue.filter((entry) => entry.state === 'running' || entry.state === 'starting');
    saveQueue();
    renderQueue();
  });

  // Subtitles: remembered like the quality, since it is the same kind of
  // standing preference rather than a per-download decision.
  for (const input of document.querySelectorAll('input[name="subs"]')) {
    input.checked = input.value === settings.subs;
    input.addEventListener('change', (event) => {
      settings.subs = event.target.value;
      saveSettings();
      syncSubFields();
    });
  }
  $('subLangs').value = settings.subLangs;
  $('subLangs').addEventListener('input', (event) => {
    settings.subLangs = event.target.value.trim() || 'en';
    saveSettings();
  });
  syncSubFields();

  const urlInput = $('url');
  urlInput.addEventListener('input', () => {
    $('go') && ($('go').disabled = !looksLikeUrl(urlInput.value));
    renderFeedback('');
    scheduleProbe();
  });
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && looksLikeUrl(urlInput.value)) {
      event.preventDefault();
      urlInput.blur();
      enqueue(urlInput.value.trim());
      clearInput();
    }
  });

  $('paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        urlInput.dispatchEvent(new Event('input'));
      }
    } catch {
      // Clipboard reads need permission and a secure origin; focusing the field
      // lets the user use the keyboard's own paste instead.
      urlInput.focus();
    }
  });

  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', () => $('settings').close());
  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.addEventListener('change', syncSettingsFields);
  }
  $('useLocalhost').addEventListener('click', () => {
    // 8000 is what docker-compose publishes, so this is the right guess far
    // more often than not — and it is one tap instead of typing a URL on a
    // keyboard that wants to autocapitalise it.
    $('serverUrl').value = 'http://127.0.0.1:8000';
    $('modeServer').checked = true;
    syncSettingsFields();
    testConnection();
  });

  $('cookiesFile').addEventListener('change', (event) => uploadCookies(event.target.files?.[0]));
  $('cookiesClear').addEventListener('click', removeCookies);

  $('testConnection').addEventListener('click', testConnection);
  $('saveSettings').addEventListener('click', () => {
    settings = draftSettings();
    saveSettings();
    applyBackend();
    $('settings').close();
    renderFeedback('');
    syncSubFields();
    refreshBackendLabel();
    scheduleProbe();
  });

  const shared = readSharedUrl();
  if (shared) {
    urlInput.value = shared;
    urlInput.dispatchEvent(new Event('input'));
    // Keep the shared link out of the address bar, and out of any bookmark
    // or screenshot the user takes afterwards.
    window.history.replaceState(null, '', location.pathname);
  }

  setupInstall();
  boot(loaded.firstVisit);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

/**
 * Settle on a backend, then bring the queue back against it.
 *
 * Restoring after the mode is known matters: a restored row is re-checked
 * against whichever backend is current, and doing that against a provisional
 * one would mark live downloads as gone.
 */
async function boot(firstVisit) {
  if (firstVisit) {
    settings.mode = await pickInitialMode();
    saveSettings();
    applyBackend();
    syncSubFields();
  }
  await restoreQueue();
  refreshBackendLabel();
}

init();
