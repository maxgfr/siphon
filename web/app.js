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
import { PRESETS, BackendError, makeBackend, detectEndpoint, findInstance, bundledInfo, privacyNote, describeEndpoint, servesPages, withScheme, phoneRoute } from './api.js';
import { looksLikeUrl, urlsIn } from './links.js';

const SETTINGS_KEY = 'siphon:settings';
const POLL_MS = 700;
/**
 * How many polls in a row may fail before a running download is given up
 * on. One missed poll is a phone changing cells or a laptop lid closing for
 * a moment; the server is still working, and marking the row failed would
 * have the person start the same download again beside it. Ten seconds or
 * so of silence is a different thing, and is reported.
 */
const POLL_MISSES = 12;

const NO_HELPER = Object.freeze({ kind: 'none', label: 'this device only' });

const DEFAULT_SETTINGS = Object.freeze({
  // One optional address, and what it turned out to be when it was saved.
  // Empty is the honest default: this device, and the links that need more
  // say so.
  endpoint: '',
  key: '',
  helper: NO_HELPER,
  // Where ffmpeg.wasm is fetched from. Blank is the copy deployed beside the
  // app, and there is no field for it: it is here for tests and for anyone
  // who edits storage by hand.
  coreUrl: '',
  // What the Advanced section asks yt-dlp for, per job. Applied by your own
  // server; kept, greyed, with any other helper.
  ytdlp: { sponsorblock: false, clipStart: '', clipEnd: '', rateLimit: '', client: '' },
  preset: 'video_best',
  subs: 'off',
  subLangs: 'en',
});

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let backend = null;
let probeToken = 0;
let lastProbe = null;
/** The link lastProbe describes: its title and entries are that link's, and no other's. */
let probedUrl = '';
const probeOf = (url) => (lastProbe && probedUrl === url ? lastProbe : null);
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
 * The relay is the one thing adopted without being asked, because it is the
 * site owner's own and keeps every download on this device. A public
 * instance is never adopted by default — not the measured cobalt in
 * config.json, not the bundled lists: those are one tap away in settings,
 * chosen and named, never chosen for the person.
 *
 * The person still sees whose server their YouTube links will reach — the
 * notice names it, and settings show it — and clearing it is one tap. Tried
 * again on a later visit only if the relay could not be reached this time,
 * never after the person cleared it: the guide names it then, one tap away.
 */
async function adoptSiteRelay() {
  if (settings.helper.kind !== 'none' || settings.endpoint) return false;
  try {
    if (localStorage.getItem(SITE_RELAY_TAKEN) === '1') return false;
  } catch { /* storage off: once per session is the harmless side */ }
  const site = await siteConfig();
  if (!site.relay) return false;
  let helper;
  try {
    helper = await detectEndpoint(site.relay);
  } catch {
    return false;
  }
  try {
    localStorage.setItem(SITE_RELAY_TAKEN, '1');
  } catch { /* nothing to do */ }
  // A helper the person chose in the meantime wins; so does an address that
  // turned out to be something else than the measurement said.
  if (helper.kind !== 'relay' || settings.helper.kind !== 'none' || settings.endpoint) return false;
  takeSiteRelay(site, helper);
  return true;
}

/**
 * The guide's "Use it", for a visitor who cleared the site's relay and wants
 * it back: it is not adopted again on its own, so this is the way back, with
 * no address to know.
 */
async function useSiteRelay() {
  const site = await siteConfig();
  try {
    const helper = await detectEndpoint(site.relay);
    if (helper.kind !== 'relay') throw new Error('The site\'s relay does not answer as one right now.');
    takeSiteRelay(site, helper);
    fillTour();
  } catch (error) {
    showError(error);
  }
}

/** Make the site's relay the helper, and say whose it is. */
function takeSiteRelay({ relay, relayKind, instance }, helper) {
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

/**
 * A finished file's address, if it is one. A row links to whatever a backend
 * handed back, and a backend can be someone else's server: anything that is
 * not a download — a `javascript:` URL above all — is no link at all.
 */
const fileHref = (url) => {
  try {
    return ['http:', 'https:', 'blob:'].includes(new URL(url, location.href).protocol) ? url : '';
  } catch {
    return '';
  }
};

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

const isActive = (entry) => entry.state === 'running' || entry.state === 'starting';

function saveQueue() {
  try {
    // Only what is needed to redraw a row and re-find the file on the server.
    // The cap is on finished rows; one still running is kept whatever its place.
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify(queue.filter((entry, index) => index < QUEUE_MAX || isActive(entry)).map(({ key, id, url, title, preset, state, error, filename }) => ({
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
  // A device download (ids from this tab start `b-`) that is gone was cut
  // off by a reload or swept; "the server" would be the wrong place to blame.
  if (entry.state === 'expired') return String(entry.id || '').startsWith('b-') ? 'Interrupted, or no longer on this device' : 'No longer on the server';
  if (entry.state === 'done') return entry.filename || 'Ready';
  const stage = STAGE_TEXT[entry.stage] || 'Working…';
  return entry.itemsTotal ? `${stage} ${entry.itemsDone || 1}/${entry.itemsTotal}` : stage;
}

/** What goes inside a row's <li>. */
function rowHtml(entry) {
  const active = entry.state === 'running' || entry.state === 'starting';
  // A stream's progress is counted in segments, and is real before its size
  // is known — a video rendition and a separate audio one have no total
  // until the second playlist has been read.
  const determinate = entry.stage === 'downloading' && (entry.totalBytes || entry.progress > 0);
  const percent = Math.round((entry.progress || 0) * 100);

  const bits = [];
  if (active && entry.speed) bits.push(`${formatBytes(entry.speed)}/s`);
  if (active && entry.eta) bits.push(`${formatDuration(entry.eta)} left`);
  if (!active && entry.totalBytes) bits.push(formatBytes(entry.totalBytes));
  if (entry.attempts > 0 && entry.client) bits.push(`attempt ${entry.attempts + 1} · ${entry.client}`);

  return (
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
    // The name rides on the link itself: a blob URL carries no headers, so
    // without it the Save button hands over a UUID — and after a reload, a
    // UUID ending in .txt, since the file read back from OPFS has no type.
    (entry.state === 'done' && fileHref(entry.fileUrl)
      ? `<a class="q-act primary" href="${escapeHtml(fileHref(entry.fileUrl))}" download="${escapeHtml(entry.filename || '')}">Save</a>`
      : '') +
    (active ? `<button class="q-act" type="button" data-cancel="${escapeHtml(entry.key)}">Cancel</button>` : '') +
    (entry.state === 'error' || entry.state === 'expired' ? `<button class="q-act" type="button" data-retry="${escapeHtml(entry.key)}">Try again</button>` : '') +
    '</div>'
  );
}

/**
 * Make `node`'s children look like `model`'s, touching only what differs.
 *
 * A poll lands every 700 ms. A row drawn again from scratch each time took
 * with it the Cancel a keyboard was on — focus fell to the page — and the
 * button a finger was pressing, so a press that spanned a poll was no click
 * at all. Patched, an element stays the same element for as long as it is
 * the same kind of thing in the same place: the percentage and the bar
 * change, the button under the finger does not.
 */
function patch(node, model) {
  const have = [...node.childNodes];
  const want = [...model.childNodes];
  want.forEach((next, index) => {
    const current = have[index];
    if (!current) {
      node.appendChild(next);
    } else if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      node.replaceChild(next, current);
    } else if (next.nodeType !== Node.ELEMENT_NODE) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    } else {
      for (const { name } of [...current.attributes]) if (!next.hasAttribute(name)) current.removeAttribute(name);
      for (const { name, value } of [...next.attributes]) if (current.getAttribute(name) !== value) current.setAttribute(name, value);
      patch(current, next);
    }
  });
  for (const extra of have.slice(want.length)) extra.remove();
}

/** What a screen reader is told when a row reaches an end. */
function outcome(entry) {
  if (entry.state === 'done') return `Ready: ${entry.filename || entry.title}.`;
  if (entry.state === 'error') return `Failed: ${entry.title}. ${entry.error || ''}`.trim();
  if (entry.state === 'expired') return `${rowLabel(entry)}: ${entry.title}.`;
  return '';
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

  // Rows are keyed by their entry. The ones whose entry is gone go first, so
  // a row that stays is never moved: moving an element takes focus off it.
  const rows = new Map([...list.children].map((item) => [item.dataset.key, item]));
  const keys = new Set(queue.map((entry) => entry.key));
  for (const [key, item] of rows) if (!keys.has(key)) item.remove();

  const said = [];
  const model = document.createElement('li');
  queue.forEach((entry, index) => {
    let item = rows.get(entry.key);
    if (!item) {
      item = document.createElement('li');
      item.dataset.key = entry.key;
    } else if (item.dataset.state !== entry.state && outcome(entry)) {
      said.push(outcome(entry));
    }
    item.dataset.state = entry.state;
    item.classList.toggle('q-error', entry.state === 'error' || entry.state === 'expired');
    model.innerHTML = rowHtml(entry);
    patch(item, model);
    if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null);
  });
  // The rows change without a word; this is the word, for whoever cannot see them.
  if (said.length) $('queueStatus').textContent = said.join(' ');
}

function findEntry(key) {
  return queue.find((entry) => entry.key === key);
}

/**
 * Let go of a row's file. The row is the only way back to it, so a file whose
 * row is gone is a leak: on disk in OPFS until a later visit's sweep, and a
 * converted one in this tab's memory, behind its blob URL, until the tab
 * closes. The backend's cancel is what frees both.
 */
function release(entry) {
  if (entry.id) backend.cancel?.(entry.id);
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
  const probe = probeOf(url);
  const entries = probe?.entries || [];
  if (playlist && !backend?.supportsPlaylist && entries.length > 0) {
    for (const entry of entries.slice(0, probe.limit || entries.length)) {
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
    title: title || probeOf(url)?.title || url,
    preset,
    state: 'starting',
    stage: 'starting',
    progress: 0,
  };
  queue.unshift(entry);
  trimQueue();
  renderQueue();

  try {
    const started = await backend.start(url, preset, {
      playlist,
      subs: settings.subs,
      subLangs: settings.subLangs,
      ytdlp: { ...DEFAULT_SETTINGS.ytdlp, ...(settings.ytdlp || {}) },
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

/**
 * Past the cap, the oldest finished rows go, and never one still running:
 * letting go of it would cancel its download, and a row still starting has no
 * job yet to cancel, so its download would run on with no row. While more
 * than the cap are running the list is simply longer.
 */
function trimQueue() {
  let over = queue.length - QUEUE_MAX;
  for (let index = queue.length - 1; index >= 0 && over > 0; index -= 1) {
    if (isActive(queue[index])) continue;
    release(queue[index]);
    queue.splice(index, 1);
    over -= 1;
  }
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
        entry.misses = 0;
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
        }
      } catch (error) {
        // A 404 means the server swept it. A refusal — the key is wrong —
        // will not change by asking again. Anything else is the network,
        // and the server is still working: only a silence that lasts is a
        // failure.
        if (/no such download/i.test(String(error?.message))) {
          entry.state = 'expired';
          return;
        }
        entry.misses = (entry.misses || 0) + 1;
        const final = error instanceof BackendError && error.retryable === false;
        if (!final && entry.misses < POLL_MISSES) return;
        entry.state = 'error';
        entry.error = error instanceof BackendError ? error.message : 'Lost contact with the server.';
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
  const href = fileHref(entry.fileUrl);
  if (!href || (platform.ios && platform.standalone)) return;

  const anchor = document.createElement('a');
  anchor.href = href;
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
      if (!entry.id) {
        // Saved while it was still being identified: no job was started, and
        // nothing would ever report on it. Try again is the way on.
        if (entry.state === 'starting') {
          entry.state = 'error';
          entry.error = 'Interrupted before it started.';
        }
        return;
      }
      try {
        const job = await backend.poll(entry.id);
        entry.state = job.state === 'done' ? 'done' : job.state === 'error' ? 'error' : 'running';
        entry.stage = job.stage;
        entry.progress = job.progress;
        entry.filename = job.filename || entry.filename;
        entry.error = job.error;
        if (entry.state === 'done') entry.fileUrl = backend.fileUrl(entry.id);
      } catch (error) {
        // Swept by the TTL, or a different server is configured now: the
        // answer is that there is no such download. Anything else — the
        // phone between networks, the app opened away from the server — is
        // not an answer. A running row is followed as any other, with the
        // same patience for silence; a finished one keeps its link.
        if (/no such download/i.test(String(error?.message))) entry.state = 'expired';
        else if (entry.state === 'done') entry.fileUrl = backend.fileUrl(entry.id);
      }
    }),
  );
  saveQueue();
  renderQueue();
  if (queue.some((entry) => entry.state === 'running')) startPolling();
}

/* ------------------------------------------------------------------ backend */

function applyBackend() {
  // The new backend takes over the old one's jobs: a download running on
  // this device when settings are saved keeps its row and finishes.
  backend = makeBackend(settings, backend);
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
    probedUrl = url;
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
  // Nothing saved, nothing to keep from another address: a key that turns
  // up in the field, typed or filled in, is for the address that follows.
  keyOrigin = settings.endpoint || settings.key ? originOf(settings.endpoint) : null;
  keyHeld = '';
  const options = { ...DEFAULT_SETTINGS.ytdlp, ...(settings.ytdlp || {}) };
  $('optSponsor').checked = options.sponsorblock === true;
  $('optClipStart').value = options.clipStart;
  $('optClipEnd').value = options.clipEnd;
  $('optRate').value = options.rateLimit;
  $('optClient').value = options.client;
  // A client no longer offered — tv_embedded, saved before yt-dlp retired
  // it — would leave the list showing nothing. The server takes it as no
  // preference, and so does the sheet.
  if ($('optClient').selectedIndex < 0) $('optClient').value = '';
  reflectHelper(settings.helper, settings.endpoint);
  renderSuggested();
  $('settings').showModal();
}

/** The yt-dlp options from the sheet, as the settings keep them. */
function readYtdlp() {
  return {
    sponsorblock: $('optSponsor').checked,
    clipStart: $('optClipStart').value.trim(),
    clipEnd: $('optClipEnd').value.trim(),
    rateLimit: $('optRate').value.trim(),
    client: $('optClient').value,
  };
}

/**
 * Say what the yt-dlp options apply to. They are your own server's — yt-dlp
 * runs there — so with any other helper they wait, greyed but kept.
 */
function scopeYtdlp(helper) {
  // A server without ffmpeg only resolves: this device downloads, and has no
  // yt-dlp to hand a clip or a speed limit to.
  const thin = helper?.kind === 'siphon' && helper.ffmpeg === false;
  const yours = helper?.kind === 'siphon' && !thin;
  $('ytdlpBlock').classList.toggle('off', !yours);
  $('ytdlpScope').textContent = yours
    ? 'Applied by your server, which runs yt-dlp, to every download it makes.'
    : thin
      ? 'Your server has no ffmpeg, so it only resolves links and this device downloads: these need the server to make the download. They are kept until it does.'
      : 'These apply when the helper is your own siphon server, which runs yt-dlp. They are kept until then.';
  offerClients(helper);
}

/**
 * Offer the YouTube clients your server's yt-dlp has, and only those. yt-dlp
 * drops the ones YouTube retires, and asked for one it no longer knows it
 * skips it without a word: a choice that does nothing. A server that does
 * not say which it has, and any other helper, leaves them all.
 */
function offerClients(helper) {
  const has = helper?.kind === 'siphon' && Array.isArray(helper.ytClients) ? new Set(helper.ytClients) : null;
  const select = $('optClient');
  for (const option of select.options) {
    const gone = Boolean(option.value) && has !== null && !has.has(option.value);
    option.hidden = gone;
    option.disabled = gone;
  }
  if (select.selectedOptions[0]?.disabled) select.value = '';
}

/** How many instances to offer as chips; the rest are one "Find" away. */
const SUGGESTED = 3;

/**
 * The instances the daily measurement saw answer a page for a video, as
 * chips: tap one and the address is filled in and tested. No chip is offered
 * on a day none did — the field is still there for an address you know —
 * and the sentence beside it says which of the two it is, and when it was
 * measured. "Find a public instance" is always there: it asks the Invidious
 * project's directory for the instances with their API on and tests each
 * one, which is the live answer on any day.
 */
async function renderSuggested() {
  const box = $('suggested');
  const { open, measured } = await bundledInfo().catch(() => ({ open: [], measured: '' }));
  const list = open.slice(0, SUGGESTED);
  box.hidden = list.length === 0;
  $('findInstance').hidden = false;
  $('openNote').textContent = open.length
    ? `Measured ${measured || 'recently'}: ${open.length === 1 ? 'this instance answered' : `these ${open.length} instances answered`} a web page for a video. Tap one to fill it in and test it, paste another, or Find asks the Invidious directory for more.`
    : `${measured ? `Measured ${measured}: no` : 'No'} public instance answered a web page for a video, so none is offered. Find asks the Invidious directory for the instances with their API on and tests each; or paste one you know, or use a relay or your own server — those are never refused.`;
  box.innerHTML = list
    .map((entry) => `<button type="button" class="chip-btn" data-address="${escapeHtml(entry.url)}">${escapeHtml(hostOf(entry.url))}<small> · ${escapeHtml(entry.kind)}</small></button>`)
    .join('');
  for (const chip of box.querySelectorAll('[data-address]')) {
    chip.addEventListener('click', () => {
      $('endpoint').value = chip.dataset.address;
      $('endpointKey').value = '';
      testConnection();
    });
  }
}

/**
 * Show, in the sheet, what a helper is and what follows from it.
 *
 * The sentence names the address it is about. Two Invidious instances get
 * the same description otherwise, and switching from one to the other then
 * reads as the sheet not having noticed.
 */
function reflectHelper(helper, address = '') {
  setStatus(helper.kind === 'none' ? '' : 'ok', named(address ? hostOf(address) : '', describeEndpoint(helper)));
  // Only our own server has a cookie store to write to.
  $('cookiesBlock').hidden = helper.kind !== 'siphon';
  if (helper.kind === 'siphon') setCookieState(helper.hasCookies === true);
  showPhoneHint(helper, address);
  scopeYtdlp(helper);
}

const named = (host, text) => (host ? `${host} — ${text}` : text);

function setStatus(kind, text) {
  $('statusDot').className = `dot${kind ? ` ${kind}` : ''}`;
  $('statusText').textContent = text;
}

function draftSettings() {
  return {
    ...settings,
    // "inv.nadeko.net", as a phone keyboard leaves it, with its scheme.
    endpoint: withScheme($('endpoint').value).replace(/\/+$/, ''),
    key: $('endpointKey').value.trim(),
    ytdlp: readYtdlp(),
  };
}

/**
 * The origin the access key in the sheet was entered for.
 *
 * A key is the password of one server. The field is a password field, so a
 * key saved for your own server is still in it, unseen, when another address
 * is typed above it — and would go to that address, a stranger's instance
 * perhaps, with every probe and every download. So it goes with the address
 * it was entered for: an address on another origin empties it, as a chip or
 * Find already did, and the same origin typed back brings it back.
 *
 * A key typed while the address box is empty and nothing is saved was
 * entered for no address yet, as a password manager fills it: it is null
 * then, and the key stays for whatever address is typed after it. Bound to
 * this page's own origin, the first letter of that address took it away.
 */
let keyOrigin = '';
/** That origin's key, while the field is emptied for another. */
let keyHeld = '';

const originOf = (address) => {
  try {
    return new URL(withScheme(address) || location.href, location.href).origin;
  } catch {
    return '';
  }
};

function guardKey() {
  const field = $('endpointKey');
  if (keyOrigin === null) return;
  if (originOf($('endpoint').value) === keyOrigin) {
    if (!field.value) field.value = keyHeld;
  } else if (field.value) {
    keyHeld = field.value;
    field.value = '';
  }
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
  const draft = draftSettings();
  // The address as it is asked and saved, scheme and all, is what the box shows.
  if ($('endpoint').value.trim() !== draft.endpoint) $('endpoint').value = draft.endpoint;
  const host = draft.endpoint ? hostOf(draft.endpoint) : '';
  setStatus('', host ? `Checking ${host}…` : 'Checking…');
  try {
    const helper = await detectEndpoint(draft.endpoint, draft.key);
    if (seq !== probeSeq) return null;
    if (helper.kind === 'siphon' && helper.keyAccepted === false) {
      // The server is there and wants a key this sheet does not have right.
      // Saying so now beats saving the address and reading a 401 at the
      // first download.
      setStatus(
        'bad',
        named(host, draft.key ? 'Your server, but it rejected that access key. It is the AUTH_TOKEN the server was started with.' : 'Your server, and it wants an access key — the AUTH_TOKEN it was started with.'),
      );
      $('cookiesBlock').hidden = true;
      showPhoneHint(helper, draft.endpoint);
      scopeYtdlp(null);
      return null;
    }
    reflectHelper(helper, draft.endpoint);
    // Recognising an instance is its stats endpoint answering, which every
    // public one still does. The endpoint a download needs is another door,
    // shut to pages on most of them now — so it is asked here, once, and the
    // answer is the sentence a person needs before they save the address.
    if (helper.kind === 'invidious' || helper.kind === 'piped') {
      setStatus('', named(host, `${describeEndpoint(helper)} Checking that it answers this page for a video…`));
      const open = await servesPages(draft.endpoint, helper);
      if (seq !== probeSeq) return null;
      setStatus(
        open ? 'ok' : 'warn',
        named(
          host,
          open
            ? `${describeEndpoint(helper)} It answers this page for a video.`
            : `${describeEndpoint(helper)} But it does not answer this page for a video: its video endpoint is closed to other apps, so YouTube links will fail through it. Try another instance, a relay, or your own server.`,
        ),
      );
    }
    return helper;
  } catch (error) {
    if (seq !== probeSeq) return null;
    setStatus('bad', named(host, error?.message || 'Could not reach it.'));
    $('cookiesBlock').hidden = true;
    showPhoneHint(null);
    scopeYtdlp(null);
    return null;
  }
}

const testConnection = probeDraft;

/**
 * Answer "how do I use this from my phone?" with the actual address, rather
 * than sending the user off to find their own IP. Only shown for a server on
 * this network — a deployed one is already reachable from anywhere. When the
 * server could not tell its address (a container sees only its own network),
 * it says how to find it and how to have it named here.
 *
 * Plain http on a phone is not a secure context: the page works there, but
 * installs as no app and takes no links from the share sheet. That takes
 * HTTPS, so it says where HTTPS is.
 */
function showPhoneHint(helper, address = '') {
  const host = $('phoneHint');
  const body = $('phoneHintBody');
  const route = phoneRoute(helper, address);
  host.hidden = !route;
  if (!route) return;
  const code = (text) => `<strong style="font-family:var(--mono)">${escapeHtml(text)}</strong>`;
  const port = route.port ? `:${route.port}` : '';
  const where = route.urls
    ? 'On the same Wi-Fi, open this in the phone\'s browser — it serves the app itself, ' +
      `so there is nothing else to set up:<br>${route.urls.map(code).join('<br>')}`
    : `On the same Wi-Fi, open this computer's network address${port && ` with port ${route.port}`} in the phone's browser, ` +
      `something like <code>http://192.168.1.42${port}</code>. The server could not tell which it is: set ` +
      '<code>LAN_URL</code> on it and Test names it here. Started by hand, it also needs <code>--host 0.0.0.0</code>.';
  const plain = !route.urls || route.urls.some((url) => /^http:/i.test(url));
  const https = location.protocol === 'https:'
    ? 'this page'
    : '<a href="https://maxgfr.github.io/siphon/" target="_blank" rel="noopener">the hosted page</a>';
  body.innerHTML = `${where}<br>${
    plain
      ? `Plain http works, but will not install as an app or appear in the share sheet. For that, and away from home, use ${https} with an HTTPS helper — a tunnel or tailscale serve; see the README.`
      : 'Away from home, put it behind a tunnel or a VPN — see the README.'
  }`;
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
  // Abandon any probe for the old link, in flight or still waiting to start:
  // one that started now would put back the preview of a link already queued.
  clearTimeout(probeTimer);
  probeTimer = null;
  probeToken += 1;
  renderPreview(null);
  renderFeedback('');
  renderAction();
}

/**
 * Several links at once — a pasted list, a dropped selection, a shared
 * message full of them. Each becomes its own row, in the order given, with
 * the quality chosen; the field is left empty for the next one.
 */
async function enqueueMany(links) {
  clearInput();
  renderFeedback(`<div class="notice"><p>${links.length} links queued.</p></div>`);
  for (const link of links) await enqueue(link);
}

/** Put one link in the field, as if typed. */
function fillUrl(value) {
  const input = $('url');
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/**
 * What a paste or a drop carries. One link fills the field — "Title https://…"
 * from a share becomes just the link; several are queued straight away.
 * Returns whether there was anything to take.
 */
function takeText(text) {
  const links = urlsIn(text);
  if (links.length > 1) {
    enqueueMany(links);
    return true;
  }
  if (links.length === 1) {
    fillUrl(links[0]);
    return true;
  }
  return false;
}

/** Whether a drag carries text — the only kind of drop this page takes. */
const carriesText = (dt) => Array.from(dt?.types || []).some((type) => type === 'text/uri-list' || type === 'text/plain' || type === 'text');

/* --------------------------------------------------------------------- boot */

function readSharedUrl() {
  // Android share-target and plain ?url= links both land here. The shared text
  // is often "Title https://…", so pull the first URL out of it.
  const params = new URLSearchParams(location.search);
  // urlsIn, not a bare match: "Look https://youtu.be/…." shares the
  // sentence's full stop too, and a YouTube id with a dot on it is no id.
  const candidate = params.get('url') || params.get('text') || params.get('share') || '';
  return urlsIn(candidate)[0] || '';
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
    const active = (entry) => entry.state === 'running' || entry.state === 'starting';
    for (const entry of queue) if (!active(entry)) release(entry);
    queue = queue.filter(active);
    saveQueue();
    renderQueue();
  });
  // One listener for every row's buttons: rows are patched in place, and a
  // listener added at each render would pile up on the buttons that stay.
  $('queueList').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-cancel], [data-retry]');
    if (button?.dataset.cancel) cancelEntry(button.dataset.cancel);
    else if (button?.dataset.retry) retryEntry(button.dataset.retry);
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
  urlInput.addEventListener('input', (event) => {
    // "Title https://…" put in whole — a paste into the field, a keyboard's
    // clipboard chip, dictation — becomes just the link, as it does through
    // the Paste button. Only text put in at once: a link typed by hand is
    // left as typed, stray space and all, rather than cut short under the
    // fingers.
    const whole = /^insertFrom|^insertReplacementText$/.test(event.inputType || '') || (event.inputType === 'insertText' && (event.data || '').length > 1);
    if (whole && !event.isComposing && !looksLikeUrl(urlInput.value)) {
      const links = urlsIn(urlInput.value);
      if (links.length === 1) urlInput.value = links[0];
    }
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

  // A paste into the field of a whole list queues the lot; one link, or
  // anything else, is left to the field itself — and to the input handler
  // above, which keeps just the link of "Title https://…".
  urlInput.addEventListener('paste', (event) => {
    const links = urlsIn(event.clipboardData?.getData('text') || '');
    if (links.length > 1) {
      event.preventDefault();
      enqueueMany(links);
    }
  });
  // Ctrl+V with nothing focused — the desktop habit — lands in the field too.
  document.addEventListener('paste', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    if ($('settings').open) return;
    if (takeText(event.clipboardData?.getData('text') || '')) event.preventDefault();
  });
  // A link dragged from another window and dropped anywhere on the page.
  document.addEventListener('dragover', (event) => {
    if (carriesText(event.dataTransfer)) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    const dt = event.dataTransfer;
    if (!dt) return;
    const text = dt.getData('text/uri-list') || dt.getData('text/plain') || dt.getData('text');
    if (takeText(text)) event.preventDefault();
  });

  $('paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && !takeText(text)) fillUrl(text.trim());
    } catch {
      // Clipboard reads need permission and a secure origin; focusing the field
      // lets the user use the keyboard's own paste instead.
      urlInput.focus();
    }
  });

  $('openSettings').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', () => $('settings').close());
  $('endpoint').addEventListener('input', guardKey);
  $('endpointKey').addEventListener('input', () => {
    const unbound = !$('endpoint').value.trim() && !settings.endpoint && !settings.key;
    keyOrigin = unbound ? null : originOf($('endpoint').value);
    keyHeld = '';
  });
  $('useLocalhost').addEventListener('click', () => {
    // 8000 is what docker-compose publishes, so this is the right guess far
    // more often than not — and it is one tap instead of typing a URL on a
    // keyboard that wants to autocapitalise it.
    $('endpoint').value = 'http://127.0.0.1:8000';
    guardKey();
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
    settings = { ...draftSettings(), helper };
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
  // The site's own relay, if the owner set one up — and nothing else: no
  // public instance is ever adopted by default. Someone who wants one finds
  // it in settings, where it is named. This does not hold up a paste: the
  // screen is already usable.
  await adoptSiteRelay();
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
  // The bookmarklet: from any video page on a computer, one click opens this
  // app — at its own address, subpath and all — with that page's link. The
  // link is for dragging to the bookmarks bar; a tap here would only send
  // this page to itself, so the tap says so instead.
  const app = new URL('./', location.href).href;
  $('bookmarklet').href = `javascript:void(location.href=${JSON.stringify(app)}+'?url='+encodeURIComponent(location.href))`;
  $('bookmarklet').addEventListener('click', (event) => {
    event.preventDefault();
    renderFeedback('<div class="notice"><p>Drag <strong>Send to siphon</strong> to the bookmarks bar; it is for other pages, not this one.</p></div>');
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
    // Nothing is set. On a site with a relay, that is someone who cleared it
    // (it is never adopted twice) or one it has not reached yet: either way
    // the relay is named, and taken with one tap rather than an address to
    // find and type. Whose it is is said before the tap, as the notice after
    // it says: the owner's own, or a public proxy that sees the links.
    const { relay, relayKind } = await siteConfig();
    const at = `at <strong>${escapeHtml(hostOf(relay))}</strong>`;
    text = relay
      ? (relayKind === 'own'
        ? `This site runs a relay for YouTube, ${at}, and it is not in use. `
        : `This site offers a public proxy for YouTube, ${at}, which sees the links it carries, and it is not in use. `) +
        '<button class="chip-btn" type="button" id="useSiteRelay">Use it</button> Or one of these, each about a minute:'
      : 'YouTube refuses web pages, so it needs one thing that is yours. Each takes about a minute:';
  }
  status.innerHTML = text;
  $('useSiteRelay')?.addEventListener('click', useSiteRelay);
  options.hidden = settled;
}


init();
