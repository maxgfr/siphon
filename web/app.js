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
import { PRESETS, BackendError, makeBackend } from './api.js';

const SETTINGS_KEY = 'siphon:settings';
const POLL_MS = 700;

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'server',
  serverUrl: '',
  serverKey: '',
  publicUrl: '',
  publicKey: '',
  preset: 'video_best',
});

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let backend = null;
let state = 'idle';
let probeToken = 0;
let activeJob = null;
let pollTimer = null;
let lastProbe = null;
const recent = [];

/* ---------------------------------------------------------------- settings */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
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
  const meta = [info.uploader, formatDuration(info.duration), info.extractor].filter(Boolean).join(' · ');
  host.hidden = false;
  host.className = 'preview';
  host.innerHTML =
    (info.thumbnail
      ? `<img src="${escapeHtml(info.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : '') +
    '<div class="preview-body">' +
    `<p class="preview-title">${escapeHtml(info.title || 'Untitled')}</p>` +
    (meta ? `<p class="preview-meta">${escapeHtml(meta)}</p>` : '') +
    '</div>';
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

/** Swap the action bar between the button and the live progress readout. */
function renderAction() {
  const slot = $('actionSlot');
  if (state !== 'working') {
    slot.innerHTML =
      '<button class="btn-go" type="button" id="go">' +
      '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 4v11M12 15l-5-5M12 15l5-5M5 20h14" /></svg>' +
      '<span id="goText">Download</span></button>';
    const go = $('go');
    go.disabled = !looksLikeUrl($('url').value);
    go.addEventListener('click', startDownload);
    return;
  }

  slot.innerHTML =
    '<div class="progress" role="status" aria-live="polite">' +
    '<div class="progress-head"><span class="progress-stage" id="stage">Starting…</span>' +
    '<span class="progress-pct" id="pct"></span></div>' +
    '<div class="bar"><div class="bar-fill indeterminate" id="barFill"></div></div>' +
    '<p class="progress-foot"><span id="speed"></span><span id="eta"></span>' +
    '<button type="button" class="cancel" id="cancel">Cancel</button></p></div>';
  $('cancel').addEventListener('click', cancelDownload);
}

const STAGE_TEXT = {
  starting: 'Starting…',
  downloading: 'Downloading',
  processing: 'Converting…',
  ready: 'Ready',
  failed: 'Failed',
};

function renderProgress(job) {
  const stage = $('stage');
  const pct = $('pct');
  const fill = $('barFill');
  if (!stage || !fill) return;

  stage.textContent = STAGE_TEXT[job.stage] || 'Working…';

  // A percentage is only shown while it means something. During conversion
  // yt-dlp has no total to report, so the bar goes indeterminate rather than
  // sitting at a lying 100%.
  const determinate = job.stage === 'downloading' && job.totalBytes;
  if (determinate) {
    const percent = Math.round((job.progress || 0) * 100);
    fill.classList.remove('indeterminate');
    fill.style.width = `${percent}%`;
    pct.textContent = `${percent}%`;
  } else {
    fill.classList.add('indeterminate');
    fill.style.width = '';
    pct.textContent = '';
  }

  $('speed').textContent = job.speed ? `${formatBytes(job.speed)}/s` : '';
  $('eta').textContent = job.eta ? `${formatDuration(job.eta)} left` : '';
}

function renderHistory() {
  const section = $('history');
  const list = $('historyList');
  section.hidden = recent.length === 0;
  list.innerHTML = '';
  for (const entry of recent) {
    const item = document.createElement('li');
    item.innerHTML =
      '<div class="h-body">' +
      `<div class="h-title">${escapeHtml(entry.title)}</div>` +
      `<div class="h-meta">${escapeHtml(entry.meta)}</div>` +
      '</div>' +
      `<a class="h-save" href="${escapeHtml(entry.url)}" download>Save</a>`;
    list.appendChild(item);
  }
}

/* ------------------------------------------------------------------ backend */

function applyBackend() {
  backend = makeBackend(settings);
  $('privacyNote').textContent =
    settings.mode === 'public'
      ? 'In public-instance mode, every link you paste is sent to that instance.'
      : 'Links go only to the server you configured. Nothing is sent anywhere else.';
}

async function refreshBackendLabel() {
  const label = $('backendLabel');
  label.textContent = 'checking server…';
  try {
    const info = await backend.health();
    const where = settings.mode === 'public' ? 'public instance' : 'your server';
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
          'This page needs something running yt-dlp for it. Open settings to point it at one.</p>' +
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

/* ----------------------------------------------------------------- download */

async function startDownload() {
  const url = $('url').value.trim();
  if (!looksLikeUrl(url)) return;

  renderFeedback('');
  state = 'working';
  renderAction();

  try {
    const started = await backend.start(url, settings.preset);

    if (started.kind === 'direct') {
      // Public instances stream the file themselves: hand it to the browser and
      // let its own download UI take over.
      finish({
        url: started.url,
        title: started.filename || lastProbe?.title || 'download',
        meta: 'via public instance',
      });
      return;
    }

    activeJob = started.id;
    pollJob();
  } catch (error) {
    state = 'error';
    renderAction();
    showError(error);
  }
}

async function pollJob() {
  if (!activeJob) return;
  try {
    const job = await backend.poll(activeJob);

    if (job.state === 'done') {
      const meta = [formatBytes(job.totalBytes), PRESETS.find((p) => p.id === settings.preset)?.label]
        .filter(Boolean)
        .join(' · ');
      finish({
        url: backend.fileUrl(activeJob),
        title: job.filename || job.title || lastProbe?.title || 'download',
        meta: meta || 'done',
      });
      activeJob = null;
      return;
    }

    if (job.state === 'error') {
      activeJob = null;
      state = 'error';
      renderAction();
      showError(new BackendError(job.error || 'The download failed.'));
      return;
    }

    renderProgress(job);
    pollTimer = setTimeout(pollJob, POLL_MS);
  } catch (error) {
    activeJob = null;
    state = 'error';
    renderAction();
    showError(error);
  }
}

/**
 * Hand the finished file to the browser.
 *
 * A synthetic click on an <a> is what keeps the page in place: the response
 * carries `Content-Disposition: attachment`, so the browser saves it instead of
 * navigating. `download` only takes effect same-origin, which is why the header
 * — not this attribute — is what actually does the work.
 */
function finish(entry) {
  state = 'done';
  renderAction();

  recent.unshift(entry);
  if (recent.length > 8) recent.pop();
  renderHistory();

  // Inside an iOS home-screen app there is no download manager, and a synthetic
  // click is silently dropped. The file has to be a link the user taps, opened
  // out into Safari where saving exists.
  if (platform.ios && platform.standalone) {
    renderFeedback(
      '<div class="notice"><p><strong>Ready.</strong> iOS will not save a file from ' +
        'inside an installed app, so this opens in Safari — then use the share button ' +
        'to put it in Files.</p>' +
        `<a class="save-now" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">` +
        'Open and save</a></div>',
    );
    return;
  }

  const anchor = document.createElement('a');
  anchor.href = entry.url;
  anchor.download = '';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  renderFeedback(
    '<div class="notice"><p><strong>Saved.</strong> Check your downloads. ' +
      'If nothing appeared, use the Save button below.</p></div>',
  );
}

function cancelDownload() {
  clearTimeout(pollTimer);
  if (activeJob) backend.cancel?.(activeJob);
  activeJob = null;
  state = 'idle';
  renderAction();
  renderFeedback('');
}

/* ----------------------------------------------------------------- settings */

function openSettings() {
  $('modeServer').checked = settings.mode === 'server';
  $('modePublic').checked = settings.mode === 'public';
  $('serverUrl').value = settings.serverUrl;
  $('serverKey').value = settings.serverKey;
  $('publicUrl').value = settings.publicUrl;
  $('publicKey').value = settings.publicKey;
  syncSettingsFields();
  setStatus('', 'Not checked yet');
  $('settings').showModal();
}

function syncSettingsFields() {
  const isPublic = $('modePublic').checked;
  $('serverFields').hidden = isPublic;
  $('publicFields').hidden = !isPublic;
}

function setStatus(kind, text) {
  $('statusDot').className = `dot${kind ? ` ${kind}` : ''}`;
  $('statusText').textContent = text;
}

function draftSettings() {
  return {
    ...settings,
    mode: $('modePublic').checked ? 'public' : 'server',
    serverUrl: $('serverUrl').value.trim(),
    serverKey: $('serverKey').value.trim(),
    publicUrl: $('publicUrl').value.trim(),
    publicKey: $('publicKey').value.trim(),
  };
}

async function testConnection() {
  setStatus('', 'Checking…');
  try {
    const info = await makeBackend(draftSettings()).health();
    setStatus('ok', `Reachable — ${info.label}${info.ffmpeg === false ? ', but no ffmpeg' : ''}`);
    showPhoneHint(info.lanUrls || []);
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
  settings = loadSettings();
  applyBackend();
  renderQualities();
  renderAction();
  renderHistory();

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
      startDownload();
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
  $('modeServer').addEventListener('change', syncSettingsFields);
  $('modePublic').addEventListener('change', syncSettingsFields);
  $('useLocalhost').addEventListener('click', () => {
    // 8000 is what docker-compose publishes, so this is the right guess far
    // more often than not — and it is one tap instead of typing a URL on a
    // keyboard that wants to autocapitalise it.
    $('serverUrl').value = 'http://127.0.0.1:8000';
    $('modeServer').checked = true;
    syncSettingsFields();
    testConnection();
  });

  $('testConnection').addEventListener('click', testConnection);
  $('saveSettings').addEventListener('click', () => {
    settings = draftSettings();
    saveSettings();
    applyBackend();
    $('settings').close();
    renderFeedback('');
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
  refreshBackendLabel();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
