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
import { PRESETS, BackendError, makeBackend, detectEndpoint, findInstance, invidiousInstances, looksUnreachable, privacyNote, describeEndpoint, servesPages } from './api.js';

const SETTINGS_KEY = 'siphon:settings';
const POLL_MS = 700;

const NO_HELPER = Object.freeze({ kind: 'none', label: 'this device only' });

const DEFAULT_SETTINGS = Object.freeze({
  // One optional address, and what it turned out to be when it was saved.
  // Empty is the honest default: this device, and the links that need more
  // say so.
  endpoint: '',
  key: '',
  helper: NO_HELPER,
  // Whether siphon may go looking for a public instance on its own — to fill
  // in a first visit, or to replace one that has died. Someone who clears the
  // address is saying they would rather it did not, so clearing turns this off
  // and it stays off.
  autoInstance: true,
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
    const saved = migrate(JSON.parse(raw || '{}'));
    return { settings: { ...DEFAULT_SETTINGS, ...saved }, firstVisit: !raw };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, firstVisit: true };
  }
}

/**
 * Settings saved by the version with three modes, carried into this one.
 *
 * The address that mattered under the old mode becomes the helper; its kind
 * is re-detected the next time the sheet is saved, and until then the old
 * mode says enough to keep working.
 */
function migrate(saved) {
  if (!saved || typeof saved !== 'object' || !('mode' in saved) || 'helper' in saved) return saved;
  const { mode, serverUrl, serverKey, publicUrl, publicKey, relayUrl, pipedUrl, ...rest } = saved;
  const picked =
    mode === 'server'
      ? { endpoint: serverUrl || '', key: serverKey || '', helper: { kind: 'siphon', label: 'yt-dlp', ffmpeg: true } }
      : mode === 'public'
        ? { endpoint: publicUrl || '', key: publicKey || '', helper: { kind: 'cobalt', label: 'cobalt', ffmpeg: true } }
        : pipedUrl
          ? { endpoint: pipedUrl, key: '', helper: { kind: 'piped', label: 'Piped instance' } }
          : relayUrl
            ? { endpoint: relayUrl, key: '', helper: { kind: 'relay', label: 'relay' } }
            : { endpoint: '', key: '', helper: NO_HELPER };
  return { ...rest, ...picked };
}

/**
 * What a brand-new visitor gets: whatever answers at this page's own origin.
 *
 * The container serves this page and the API from one origin, and that setup
 * must keep working with nothing configured. Anywhere else — GitHub Pages, any
 * static host — nothing answers, and the device does it. One request, on the
 * first visit only; the answer is saved.
 */
async function pickInitialHelper() {
  try {
    return await detectEndpoint('');
  } catch {
    return NO_HELPER;
  }
}

const INSTANCE_OFFERED = 'siphon:instance-offered';
const SITE_RELAY_TAKEN = 'siphon:site-relay';
const TOUR_SEEN = 'siphon:tour-seen';

/**
 * What the site's owner configured, deployed beside the page.
 *
 * config.json carries the one thing that makes YouTube work for every
 * visitor with nothing to set: the address of a relay the owner deployed.
 * Same-origin, so a missing or unreadable file is simply "nothing set".
 */
let siteConfigPromise = null;
function siteConfig() {
  if (!siteConfigPromise) {
    siteConfigPromise = fetch(new URL('./config.json', location.href).href, { credentials: 'omit', signal: AbortSignal.timeout(6000) })
      .then((response) => (response.ok ? response.json() : {}))
      .then((body) => ({
        relay: String(body?.relay || '').trim().replace(/\/+$/, ''),
        relayKind: body?.relayKind === 'own' ? 'own' : 'public',
        instance: String(body?.instance || '').trim().replace(/\/+$/, ''),
        cobalt: String(body?.cobalt || '').trim().replace(/\/+$/, ''),
      }))
      .catch(() => ({ relay: '', relayKind: '', instance: '', cobalt: '' }));
  }
  return siteConfigPromise;
}

/**
 * Take the site's relay, once, when nothing else is set.
 *
 * The person still sees whose server their YouTube links will reach — the
 * notice names it, and settings show it — and clearing it is one tap. Tried
 * again on a later visit only if the relay could not be reached this time,
 * never after the person cleared it.
 */
async function adoptSiteRelay() {
  if (settings.helper.kind !== 'none' || settings.endpoint) return false;
  try {
    if (localStorage.getItem(SITE_RELAY_TAKEN) === '1') return false;
  } catch { /* storage off: once per session is the harmless side */ }
  const { relay, relayKind, instance, cobalt } = await siteConfig();
  // The relay first — it keeps the download on this device — and, failing
  // one, a cobalt instance the daily measurement saw deliver a YouTube file:
  // that one does the whole download itself and sees every link.
  const address = relay || cobalt;
  if (!address) return false;
  let helper;
  try {
    helper = await detectEndpoint(address);
  } catch {
    return false;
  }
  try {
    localStorage.setItem(SITE_RELAY_TAKEN, '1');
  } catch { /* nothing to do */ }
  // A helper the person chose in the meantime wins; so does an address that
  // turned out to be something else than the measurement said.
  const expected = relay ? 'relay' : 'cobalt';
  if (helper.kind !== expected || settings.helper.kind !== 'none' || settings.endpoint) return false;

  if (!relay) {
    settings = { ...settings, endpoint: cobalt, key: '', helper };
    saveSettings();
    applyBackend();
    refreshBackendLabel();
    renderFeedback(
      '<div class="notice"><p><strong>Using a public instance.</strong> ' +
        `Links this device cannot read itself go to <strong>${escapeHtml(hostOf(cobalt))}</strong>, a public cobalt instance ` +
        'that does the download and sees those links — it was the one that delivered YouTube today. Change or clear it in settings.</p></div>',
    );
    return true;
  }

  settings = { ...settings, endpoint: relay, key: '', helper, siteInstance: instance };
  saveSettings();
  applyBackend();
  refreshBackendLabel();
  // Whose server the links reach is the one thing to be plain about: the
  // site's own relay is the owner's; a public proxy is a stranger's, and it
  // sees every link that goes through it.
  renderFeedback(
    '<div class="notice"><p><strong>This site has a relay.</strong> ' +
      `YouTube links, and hosts that refuse a web page, go through <strong>${escapeHtml(hostOf(relay))}</strong>` +
      (relayKind === 'own'
        ? ', which this site runs; everything else stays on this device.'
        : ' — a public proxy that sees those links; everything else stays on this device.') +
      ' Change or clear it in settings.</p></div>',
  );
  return true;
}

/**
 * Nothing behind the page, so go and find a public instance.
 *
 * Runs after the first screen is already usable, because it talks to
 * directories and then to several strangers, and none of that should hold up
 * a paste. When one answers it is applied and *named* — the person has to be
 * able to see whose server their links are about to reach, and to undo it.
 *
 * Once per browser: if the search finds nothing, or the person clears the
 * address afterwards, it is not tried again behind their back.
 */
async function offerPublicInstance() {
  if (!settings.autoInstance) return;
  try {
    if (localStorage.getItem(INSTANCE_OFFERED) === '1') return;
  } catch {
    /* storage off: offering once per session is the harmless side */
  }
  const found = await findInstance({ detect: (address) => detectEndpoint(address), verify: servesPages }).catch(() => null);
  try {
    localStorage.setItem(INSTANCE_OFFERED, '1');
  } catch { /* nothing to do */ }
  // A helper the person chose in the meantime wins over anything found here.
  if (!found || settings.helper.kind !== 'none' || settings.endpoint) return;

  settings = { ...settings, endpoint: found.endpoint, key: '', helper: found.helper };
  saveSettings();
  applyBackend();
  refreshBackendLabel();
  renderFeedback(
    '<div class="notice"><p><strong>Using a public instance.</strong> ' +
      `Nothing of yours is running, so links this device cannot read itself go to ` +
      `<strong>${escapeHtml(hostOf(found.endpoint))}</strong>, which is someone else's server and sees them. ` +
      'Change or clear it in settings.</p>' +
      '<button class="retry" type="button" id="instanceSettings">Settings</button> ' +
      '<button class="retry" type="button" id="instanceClear">Use this device only</button></div>',
  );
  $('instanceSettings')?.addEventListener('click', openSettings);
  $('instanceClear')?.addEventListener('click', () => {
    settings = { ...settings, endpoint: '', key: '', helper: NO_HELPER, autoInstance: false };
    saveSettings();
    applyBackend();
    refreshBackendLabel();
    renderFeedback('');
  });
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

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
  const count = Math.min(info.count, info.limit);
  const capped = info.count > info.limit ? ` (capped from ${info.count})` : '';
  // A server builds one archive; a tab cannot, so it takes them one at a time
  // — which is better anyway: separate files, each with its own progress.
  note.textContent = backend?.supportsPlaylist
    ? `${count} files${capped}, arriving as one .zip`
    : `${count} downloads${capped}, one after another`;
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
      (entry.note ? `<p class="q-msg">${escapeHtml(entry.note)}</p>` : '') +
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

/**
 * An instance that has stopped answering is replaced, once, and the download
 * retried.
 *
 * Instances come and go — that is the deal with using someone else's server —
 * and the list that found this one has others on it. Doing nothing with that
 * list means a dead instance looks like a dead app.
 *
 * Bounded on purpose: at most a couple of switches in a session, never for a
 * failure that is about the video rather than the helper, and never silently.
 */
const SWITCH_LIMIT = 2;
/** The helpers that are someone else's public instance, and so have peers to fall back to. */
const PUBLIC_KINDS = new Set(['cobalt', 'piped', 'invidious']);
let switches = 0;
const spentInstances = new Set();

async function switchInstance(entry) {
  if (!settings.autoInstance) return false;
  if (!PUBLIC_KINDS.has(settings.helper.kind)) return false;
  if (switches >= SWITCH_LIMIT || !looksUnreachable(entry.error || '')) return false;

  switches += 1;
  spentInstances.add(settings.endpoint);
  const dead = hostOf(settings.endpoint);
  const found = await findInstance({
    detect: (address) => detectEndpoint(address),
    verify: servesPages,
    exclude: [...spentInstances],
  }).catch(() => null);
  if (!found) {
    renderFeedback(
      '<div class="notice error" role="alert"><p><strong>' + escapeHtml(dead) + ' stopped answering,</strong> ' +
        'and no other public instance answered either. Try again later, or run your own server.</p></div>',
    );
    return false;
  }

  settings = { ...settings, endpoint: found.endpoint, key: '', helper: found.helper };
  saveSettings();
  applyBackend();
  refreshBackendLabel();
  renderFeedback(
    '<div class="notice"><p><strong>Switched instance.</strong> ' +
      `${escapeHtml(dead)} stopped answering, so this is now going through ` +
      `<strong>${escapeHtml(hostOf(found.endpoint))}</strong>. Change or clear it in settings.</p></div>`,
  );
  return true;
}

/** An entry has just failed: switch instance and try again, or leave it failed. */
async function afterFailure(entry) {
  if (await switchInstance(entry)) retryEntry(entry.key);
}

function retryEntry(key) {
  const entry = findEntry(key);
  if (!entry) return;
  queue = queue.filter((item) => item !== entry);
  renderQueue();
  // A row is one video, even when it came from a playlist, so a retry is one
  // video too — not the whole list again.
  enqueueOne(entry.url, { preset: entry.preset, title: entry.title });
}

/* ----------------------------------------------------------------- running */

/**
 * Take a link, or a whole playlist.
 *
 * A server can hand back a playlist as one archive. A tab cannot build one, so
 * there a playlist becomes a row per video — which is the better shape anyway:
 * each file arrives on its own, with its own progress, and a failure loses one
 * video rather than fifty.
 */
async function enqueue(url, { preset = settings.preset, playlist = wantPlaylist } = {}) {
  const entries = lastProbe?.entries || [];
  if (playlist && !backend?.supportsPlaylist && entries.length > 0) {
    for (const entry of entries.slice(0, lastProbe.limit || entries.length)) {
      // eslint-disable-next-line no-await-in-loop -- the queue is the point
      await enqueueOne(entry.url, { preset, playlist: false, title: entry.title });
    }
    return;
  }
  await enqueueOne(url, { preset, playlist });
}

/**
 * Add one download and return immediately.
 *
 * The URL box is cleared as soon as the job is accepted, because the whole
 * point of a queue is that you can paste the next link while the first is still
 * going. Nothing here waits.
 */
async function enqueueOne(url, { preset = settings.preset, playlist = false, title = null } = {}) {
  const entry = {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${queue.length}`,
    url,
    title: title || lastProbe?.title || url,
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
    afterFailure(entry);
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
          note: job.note,
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
          afterFailure(entry);
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

function applyBackend() {
  backend = makeBackend(settings);
  $('privacyNote').textContent = privacyNote(settings.helper);
}

async function refreshBackendLabel() {
  const label = $('backendLabel');
  label.textContent = 'checking…';
  try {
    const info = await backend.health();
    label.textContent = info.label;
  } catch (error) {
    // The helper is not answering. The device still works on its own, so this
    // is a note on the header, not a wall across the screen.
    label.textContent = `${settings.helper.label} unreachable — open settings`;
    showError(error);
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
  $('endpoint').value = settings.endpoint;
  $('endpointKey').value = settings.key;
  $('coreUrl').value = settings.coreUrl;
  reflectHelper(settings.helper);
  renderSuggested();
  $('settings').showModal();
}

/** How many instances to offer as chips; the rest are one "Find" away. */
const SUGGESTED = 3;

/**
 * The first few Invidious instances from the bundled list, as chips.
 *
 * "Find a public instance" runs a search; these are the answer to "just give
 * me one": tap it and the address is filled in and tested, and the sheet
 * says what it found. The list is the project's own, refreshed daily, so the
 * chips are today's instances, not the ones committed months ago.
 */
async function renderSuggested() {
  const box = $('suggested');
  const list = (await invidiousInstances().catch(() => [])).slice(0, SUGGESTED);
  box.hidden = list.length === 0;
  box.innerHTML = list
    .map((address) => `<button type="button" class="chip-btn" data-address="${escapeHtml(address)}">${escapeHtml(hostOf(address))}</button>`)
    .join('');
  for (const chip of box.querySelectorAll('[data-address]')) {
    chip.addEventListener('click', () => {
      $('endpoint').value = chip.dataset.address;
      $('endpointKey').value = '';
      testConnection();
    });
  }
}

/** Show, in the sheet, what a helper is and what follows from it. */
function reflectHelper(helper) {
  setStatus(helper.kind === 'none' ? '' : 'ok', describeEndpoint(helper));
  // Only our own server has a cookie store to write to.
  $('cookiesBlock').hidden = helper.kind !== 'siphon';
  if (helper.kind === 'siphon') setCookieState(helper.hasCookies === true);
  showPhoneHint(helper.lanUrls || []);
}

function setStatus(kind, text) {
  $('statusDot').className = `dot${kind ? ` ${kind}` : ''}`;
  $('statusText').textContent = text;
}

function draftSettings() {
  return {
    ...settings,
    endpoint: $('endpoint').value.trim().replace(/\/+$/, ''),
    key: $('endpointKey').value.trim(),
    coreUrl: $('coreUrl').value.trim(),
  };
}

/**
 * Find out what the address in the sheet is. Returns the helper, or null with
 * the reason shown in the status line.
 */
/**
 * Which probe is the current one. A tap on a chip, then a cleared field, then
 * Test: three probes in flight, and only the last one's answer may reach the
 * screen — an earlier, slower one landing afterwards would describe an
 * address that is no longer in the box.
 */
let probeSeq = 0;

async function probeDraft() {
  const seq = ++probeSeq;
  setStatus('', 'Checking…');
  const draft = draftSettings();
  try {
    const helper = await detectEndpoint(draft.endpoint, draft.key);
    if (seq !== probeSeq) return null;
    reflectHelper(helper);
    // Recognising an instance is its stats endpoint answering, which every
    // public one still does. The endpoint a download needs is another door,
    // shut to pages on most of them now — so it is asked here, once, and the
    // answer is the sentence a person needs before they save the address.
    if (helper.kind === 'invidious' || helper.kind === 'piped') {
      setStatus('', `${describeEndpoint(helper)} Checking that it answers this page for a video…`);
      const open = await servesPages(draft.endpoint, helper);
      if (seq !== probeSeq) return null;
      setStatus(
        open ? 'ok' : 'warn',
        open
          ? `${describeEndpoint(helper)} It answers this page for a video.`
          : `${describeEndpoint(helper)} But it does not answer this page for a video: its video endpoint is closed to other apps, so YouTube links will fail through it. Try another instance, a relay, or your own server.`,
      );
    }
    return helper;
  } catch (error) {
    if (seq !== probeSeq) return null;
    setStatus('bad', error?.message || 'Could not reach it.');
    $('cookiesBlock').hidden = true;
    showPhoneHint([]);
    return null;
  }
}

const testConnection = probeDraft;

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
    // The block is only shown once the address proved to be a siphon server.
    const target = makeBackend({ ...draftSettings(), helper: { kind: 'siphon', label: 'yt-dlp', ffmpeg: true } });
    const info = await target.putCookies(text);
    setCookieState(true, `Stored ${formatBytes(info.bytes)} of cookies. YouTube downloads will use your session.`);
  } catch (error) {
    setCookieState(false, error instanceof BackendError ? error.message : 'Could not store that file.');
  }
}

async function removeCookies() {
  try {
    await makeBackend({ ...draftSettings(), helper: { kind: 'siphon', label: 'yt-dlp', ffmpeg: true } }).dropCookies();
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
  // The device can embed a subtitle a resolver found, but it cannot write a
  // separate file and it cannot invent one for a link that offers none. Saying
  // so beats handing back a video that quietly has no subtitles in it.
  $('subsUnsupported').hidden = !(wanted && !backend?.full);
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
  // Normalise what is stored: a settings blob written by an older version is
  // migrated on read, and leaving that only in memory means every reload does
  // it again and nothing else ever sees the current shape.
  if (!loaded.firstVisit) saveSettings();
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
  $('useLocalhost').addEventListener('click', () => {
    // 8000 is what docker-compose publishes, so this is the right guess far
    // more often than not — and it is one tap instead of typing a URL on a
    // keyboard that wants to autocapitalise it.
    $('endpoint').value = 'http://127.0.0.1:8000';
    testConnection();
  });

  $('cookiesFile').addEventListener('change', (event) => uploadCookies(event.target.files?.[0]));
  $('cookiesClear').addEventListener('click', removeCookies);

  $('findInstance').addEventListener('click', async () => {
    const button = $('findInstance');
    button.disabled = true;
    setStatus('', 'Looking for one that answers…');
    try {
      const found = await findInstance({ detect: (address) => detectEndpoint(address), verify: servesPages });
      if (!found) {
        setStatus('bad', 'No public instance will answer this page for a video right now. Most keep that door shut; a relay or your own server is not refused.');
        return;
      }
      $('endpoint').value = found.endpoint;
      $('endpointKey').value = '';
      reflectHelper(found.helper);
    } catch {
      setStatus('bad', 'Could not reach the instance lists.');
    } finally {
      button.disabled = false;
    }
  });

  $('testConnection').addEventListener('click', testConnection);
  $('saveSettings').addEventListener('click', async () => {
    // Saving is what settles what the address is; an address that cannot be
    // reached is not saved, and the reason stays on screen.
    const helper = await probeDraft();
    if (!helper) return;
    // An address typed in by hand is a decision. Nothing should quietly
    // replace it afterwards, so saving one turns the automatic search off.
    settings = { ...draftSettings(), helper, autoInstance: !draftSettings().endpoint };
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
    settings.helper = await pickInitialHelper();
    saveSettings();
    applyBackend();
    syncSubFields();
  }
  await restoreQueue();
  refreshBackendLabel();
  setupTour();
  // The site's own relay first — the owner set it up for exactly this — and
  // only failing that, on a genuine first visit, a public instance. Neither
  // holds up a paste: the screen is already usable. Someone who has used the
  // app before with no helper chose that, and is not searched for again.
  const adopted = await adoptSiteRelay();
  if (!adopted && firstVisit && settings.helper.kind === 'none' && !settings.endpoint) offerPublicInstance();
  fillTour();
}

/* --------------------------------------------------------------------- tour */

/**
 * The guide: three steps, and what YouTube needs.
 *
 * Shown once, on the first screen, and again from the ? in the header. The
 * YouTube part is not a fixed text — it says what is set right now and what
 * would make it work, so it is the one place a first visitor has to read.
 */
function setupTour() {
  const tour = $('tour');
  let seen = false;
  try {
    seen = localStorage.getItem(TOUR_SEEN) === '1';
  } catch { /* storage off: showing it again is the harmless side */ }

  $('openTour').addEventListener('click', () => {
    fillTour();
    tour.hidden = false;
    tour.scrollIntoView?.({ block: 'nearest' });
  });
  $('tourDismiss').addEventListener('click', () => {
    tour.hidden = true;
    try {
      localStorage.setItem(TOUR_SEEN, '1');
    } catch { /* nothing to do */ }
  });
  $('copyDocker').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('dockerCmd').textContent);
      $('copyDocker').textContent = 'Copied';
    } catch {
      $('copyDocker').textContent = 'Select and copy';
    }
  });
  if (!seen) tour.hidden = false;
}

async function fillTour() {
  const kind = settings.helper.kind;
  const host = escapeHtml(hostOf(settings.endpoint));
  const status = $('tourYoutube');
  const options = $('tourOptions');
  let text;
  let settled = false;
  if (kind === 'siphon') {
    text = `<strong>Ready.</strong> Your server at <strong>${host}</strong> handles YouTube, playlists and subtitles.`;
    settled = true;
  } else if (kind === 'relay') {
    text = `<strong>Ready.</strong> YouTube goes through the relay at <strong>${host}</strong>; everything else stays on this device.`;
    settled = true;
  } else if (kind === 'cobalt' || kind === 'piped' || kind === 'invidious') {
    text =
      `A public instance is set (<strong>${host}</strong>) and YouTube is tried through it. Public instances are ` +
      'closing their doors one by one, so if a link fails, one of these makes it work for good:';
  } else {
    const { relay } = await siteConfig();
    text = relay
      ? 'This site has a relay for YouTube. It is applied when nothing else is set; clear the helper in settings to use it.'
      : 'YouTube refuses web pages, so it needs one thing that is yours. Each takes about a minute:';
  }
  status.innerHTML = text;
  options.hidden = settled;
}


init();
