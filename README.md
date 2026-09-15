# siphon

Paste a link, pick a quality, get the file. A mobile-first downloader with
nothing to install on the phone — and, for a lot of links, nothing to run
anywhere at all.

Open it, tap **Paste**, tap **Download**. On Android you can also share a link
straight from YouTube into it, because it installs as a share target.

## Three ways to get the file

Settings picks which one does the fetching. They answer the same four questions,
so the rest of the app is identical whichever you choose.

On a first visit siphon picks for you, from the one fact that distinguishes the
two situations: whether the page's own origin answers `/api/health`. The
container serves both halves, so it does, and that setup keeps working with
nothing configured. A static host does not, so browser mode is chosen — which
works on arrival instead of opening on an instruction to go and set something
up. Once you have chosen a mode yourself, nothing overrides it.

| | what runs it | what it covers | what it costs |
|---|---|---|---|
| **In this browser** | the page you are looking at | direct files, HLS, pages that declare their media | nothing |
| **Your own server** | `server/`, running yt-dlp | everything yt-dlp supports | a container |
| **A public instance** | someone else's [cobalt](https://github.com/imputnet/cobalt) | whatever they allow | your links, seen by them |

### What the browser can actually do

Browser mode is not a wrapper around somebody's API. The extractor runs in the
page: it reads the link, parses the HLS ladder, picks a rendition for the
quality you asked for, downloads and decrypts the segments, and when a file has
to be merged or converted it loads
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) and does that here too.
Nothing is uploaded, no link leaves the device, and the finished file never
existed anywhere else.

It covers more than it sounds like, because the media a site *wants* other
people's pages to play is media it has to let a page read:

- a direct `.mp4`, `.webm`, `.m4a`, `.mp3` — the file is the link
- an `.m3u8` HLS stream, including AES-128 encrypted ones, remuxed to MP4
- a page whose markup declares its video: `og:video`, `<video src>`,
  `<source>`, JSON-LD `contentUrl`, or an `.m3u8` sitting in inline JSON
- MP3 and M4A extraction from any of the above, tagged and with cover art

`ffmpeg.wasm` is only fetched when a job actually needs it. A progressive MP4 at
the quality you asked for is handed over exactly as it arrived, so the common
case costs no 32 MB download and no conversion pass.

### Where it stops, and why that is not fixable

A browser will not let a page read a cross-origin response unless the host says
it may. That is not a bug to route around, and the usual ideas do not work: a
service worker has no extra network privileges, JavaScript cannot read an opaque
`no-cors` body, and `ffmpeg.wasm` only helps once you already have the bytes.

**YouTube is the host that says no.** Its InnerTube API sends no cross-origin
headers, and `*.googlevideo.com` allows only `youtube.com`, so the request fails
before it leaves the browser. Signing the stream URL is the *easy* half — that
is just JavaScript, and [YouTube.js](https://github.com/LuanRT/YouTube.js) does
it in the page — but a signed URL you are not allowed to fetch is no use.

So YouTube in browser mode needs one of two things:

- **[A relay](relay/)** — one file, on a free Cloudflare Worker, that adds the
  missing header and forwards nothing else. No yt-dlp, no ffmpeg, no state, and
  nothing to maintain when YouTube changes, because the part that changes is
  running in your browser. It is still a server, so it is optional and empty by
  default; leave it unset and YouTube links say exactly why they failed.
- **Your own server**, below, which is the only option with a cookie jar and a
  proof-of-origin provider — and so the only one that clears a determined bot
  wall.

Projects advertising a backend-free YouTube downloader are, as far as we can
tell, all using someone else's server for that last hop. This one is honest
about which hop that is.

### What actually moves the wall — and what does not

CORS is enforced by whatever is running the page, so changing *that* can lift
it. Changing where the page runs cannot.

**An emulator or a simulator buys nothing.** Chrome in an Android emulator is
Chrome: same origin policy, same refusal. The wall is in the browser, not in
the hardware under it. Nothing is gained by pretending to be a phone.

**A different host for the page does buy something**, because it is no longer a
browser tab making the request:

| route | lifts CORS | what it costs |
|---|---|---|
| [Termux](https://termux.dev) on Android | n/a — real yt-dlp, on the phone | a terminal app, and a build or two |
| a WebView shell (Capacitor, Cordova) | yes — the native layer fetches | an APK to install and keep signed |
| a browser extension | yes — host permissions bypass it | desktop, or Firefox for Android only |
| a relay | no — it satisfies CORS rather than skipping it | one free Worker |

**Termux is the best of these on Android** and needs nothing from this project
that is not already here: install Python, ffmpeg and yt-dlp, run `server/` on
the phone, and open `http://localhost:8000` — the container serves the
interface as well as the API, so there is no CORS to satisfy and no mixed
content, exactly as in **Quick start** below. `localhost` is a secure context,
so an installed PWA can call it too. It is the "you are the client" setup with
the phone as the client. Expect the usual Termux friction on the compiled
dependencies — plain `uvicorn` rather than `uvicorn[standard]` is the easy path
— and note this is untested here, unlike the browser-mode results below.

A WebView shell is the only route that is both backend-free *and* works for
YouTube on a stock phone, because the native HTTP layer is not bound by CORS at
all. It is not in this repo: it trades "nothing to install" — the premise the
whole project is built on — for that one site.

### Browser mode does not do everything

Worth knowing before you switch to it:

- **No subtitles yet.** The app says so rather than handing back a file that
  quietly has none.
- **One video at a time.** A playlist is offered whole by the server, because it
  can build a zip; a tab cannot, so browser mode takes the video you linked.
- **No cookies.** There is nowhere safe to put them and nothing that would use
  them.
- **Sites that build their player in JavaScript** hide the file from a markup
  scrape. yt-dlp has a hand-written extractor for each of those; this has four
  general ones.
- **Big files live in memory during conversion.** Remuxing a two-hour video in
  wasm on a phone is not a good idea. Finished files go to the origin private
  file system, not the heap, so a row still survives a reload.

## The shortest setup: you are the client

For anything browser mode does not cover — YouTube without a relay, a site that
hides its player behind JavaScript, subtitles, a whole playlist — you want
yt-dlp. You still do not have to host it anywhere. Put the interface on GitHub
Pages, run yt-dlp on the computer you are sitting at, and point one at the
other:

```sh
docker run -d -p 8000:8000 -v siphon:/tmp/siphon ghcr.io/maxgfr/siphon
```

Then open the Pages URL, go to **Settings → Use this computer**, and Save.

The video now goes from the site straight to your disk. The only thing that
comes off the internet is a few kilobytes of static HTML. No hosted backend, no
bandwidth bill, and no third party ever sees which links you paste.

This works because browsers treat `localhost` as a secure context, so an HTTPS
page is allowed to call it — the usual mixed-content rule does not apply.
Chrome adds a Private Network Access preflight on top, which the server answers
(`allow_private_network`), and the origin allow-list still decides who may call:
set `ALLOWED_ORIGINS` to your Pages URL and a page on any other domain is
refused by the browser before the request is sent.

Verified in a real browser: a page on `https://maxgfr.github.io` drove yt-dlp on
`http://127.0.0.1`, with no mixed-content or private-network block, and the file
arrived. The same page served from a different hostname was refused.

**On a phone this particular trick cannot work** — there is nothing running on
the phone. See the next section for what to do instead.

## Using it from your phone

Three routes, easiest first.

### 1. Same Wi-Fi — nothing to set up

Open **Settings → Test** on your computer and the app prints the address to use,
something like `http://192.168.1.42:8000`. Type that into the phone's browser.

The container serves the interface as well as the API, so the phone gets
everything from one plain-HTTP origin — no CORS, no mixed content, no
configuration. Then **Add to Home Screen** and it behaves like an app: its own
icon, full screen, and on Android it registers as a share target, so you can
share a link straight from the YouTube app into it.

Needs your computer awake and on the same network.

Installing it is worth the two taps. On Android the browser offers an **Install**
button and the app then registers as a share target — a link goes from the
YouTube app into this one without copying anything. On iOS there is no install
prompt, so the app tells you the route: **Share → Add to Home Screen**.

One iOS quirk is handled rather than ignored: a home-screen web app there has no
download manager, and a scripted download is silently dropped. So on installed
iOS the finished file is offered as a link you tap, which opens in Safari where
saving works. Everywhere else the file just downloads.

### 2. From anywhere, still on your own machine

Your phone needs a way to reach your computer once it leaves the Wi-Fi. Pick
whichever you dislike least — the app does not care which.

**A tunnel — no VPN, no account, no router settings.** Cloudflare will hand you
a public HTTPS address that points at your machine:

```sh
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
docker compose logs cloudflared | grep trycloudflare.com
```

That prints the address. Open it on the phone.

Two things to know before you do. It is a **public** URL: anyone who has it can
use your downloader on your connection, so set `AUTH_TOKEN` in
`docker-compose.yml` first and put the same value in the app's settings — the
server prints a warning at startup when it has no key. And the address changes
every restart, which is the price of needing no account. A named tunnel (a free
Cloudflare account plus a domain you own) gives a fixed one.

**A mesh VPN — nothing public at all.** Your devices see each other privately and
the service is never exposed to the internet.
[Tailscale](https://tailscale.com) is the least work,
[NetBird](https://github.com/netbirdio/netbird) and
[ZeroTier](https://github.com/zerotier/ZeroTierOne) are alternatives,
[Headscale](https://github.com/juanfont/headscale) is a self-hosted control
server if you want no third party in the loop, and plain WireGuard is the
do-it-yourself version. All of them need an app on both devices.

**Forwarding a port on your router** also works, but it is the option to reach
for last: it puts the service on the open internet, you have to obtain a
certificate yourself, and many ISPs now use carrier-grade NAT, which makes it
impossible regardless.

### 3. A deployed server — the computer can be off

Deploy it (next section) and the phone works from anywhere with nothing of yours
running. The trade-off is worth knowing before you pick it: **YouTube treats
datacenter IP ranges with much more suspicion than home connections**, so a
hosted instance runs into "Sign in to confirm you're not a bot" far more often
than the same code on your own machine. If downloads start failing that way,
route 2 is usually the cure.

## Deploy the server in one click

The frontend needs a backend with an HTTPS hostname. Two ways to get one without
touching a terminal for more than a minute:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/maxgfr/siphon)

Render reads `render.yaml`, builds the container, and generates an `AUTH_TOKEN`
for you — copy it from the dashboard into the app's settings along with the URL.
The free plan sleeps when idle, so the first download after a pause waits for a
cold start.

```sh
# or Fly, which does not sleep the same way
fly launch --no-deploy
fly secrets set AUTH_TOKEN=$(openssl rand -hex 16)
fly deploy
```

Either way you end up with an `https://…` address. Paste it into
**Settings → Your own server**, paste the key under it, and the app works from
any phone, anywhere.

## Quick start (local)

One command. Nothing to clone, nothing to build:

```sh
docker run -d -p 8000:8000 -v siphon:/tmp/siphon ghcr.io/maxgfr/siphon
```

Open `http://localhost:8000`. That is the whole setup.

The image serves the interface *and* the API from one origin, so there is no
CORS to configure and no second thing to deploy. It is published for amd64 and
arm64, so the same command works on an Apple Silicon Mac or a Raspberry Pi.

The package takes this repository's visibility, so nothing has to be unlocked
for the command above to work. **On a private fork it will be private too**,
and making it pullable is Packages → siphon → Package settings → Change
visibility → Public — a personal token is needed for that, so the workflow
cannot do it for you.

Nothing is pinned to `latest` if you would rather not be: every push is also
tagged with its short commit sha, and a `v*` tag publishes under that name.

`docker compose up -d` does the same thing with the settings in
`docker-compose.yml` — a named volume, a restart policy, and somewhere obvious
to put `AUTH_TOKEN`. It pulls the same image rather than building one. To build
from source, which is what you want if you are changing the server:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

To reach it from your phone, put it behind something with a real hostname and
HTTPS — Tailscale, a Cloudflare tunnel, or a reverse proxy. **Browsers block a
page served over HTTPS from calling a plain-HTTP server**, so a hosted frontend
needs an HTTPS backend.

### Using the GitHub Pages frontend instead

**Enable Pages once by hand first:** Settings → Pages → Source → *GitHub
Actions*. The workflow cannot do this for you — its token may deploy to Pages
but not create the site, which needs repository admin.

After that, publish `web/` to Pages (the included workflow does it on every push
to `main`) and point it at your server
in **Settings → Your own server**. Then set `ALLOWED_ORIGINS` on the server to
your Pages URL so it stops accepting requests from anywhere:

```sh
ALLOWED_ORIGINS=https://maxgfr.github.io docker compose up -d
```

## A queue, not one download at a time

Paste a link, tap Download, and the box clears straight away so the next link can
go in behind it. Each download becomes its own row with its own progress, and
several run at once — `MAX_CONCURRENT_JOBS` decides how many.

The rows survive a reload. Finished files stay on the server until the TTL
sweeps them, so after a refresh siphon asks the server about each one and either
brings the Save button back or marks the row as gone. A failed row says why and
offers to try again rather than leaving you to retype the link.

## Subtitles

Off, burned into the container, or as separate `.srt` files beside the video.
Auto-generated captions are always included in the request: most of YouTube has
no human subtitles, and asking only for those returns a file with none at all
and no explanation. Audio presets ignore the setting, since an MP3 has nowhere
to put them.

## Playlists and albums

Paste a playlist, a channel or an album and siphon offers to take the lot. It is
offered, never assumed: a `watch?v=…&list=…` link is a video that happens to sit
in a playlist, so **This one** stays the default and **All 40** is one tap away.

Everything arrives as a single `.zip`, because a browser can only be handed one
file. Inside, tracks are numbered in playlist order — that ordering exists
nowhere else once the files are on your disk. The archive is stored rather than
deflated: media is already compressed, so deflating it would burn CPU over a
whole playlist to save nothing.

A dead video in the middle does not abandon the other thirty-nine, and
`PLAYLIST_LIMIT` (50 by default) stops one paste turning into hours of disk.
When a playlist is longer than the cap, the interface says so before you start
rather than quietly delivering less than it promised.

## Tagged audio, not just converted audio

MP3 and M4A downloads carry their title, artist, date and cover art. An untagged
file lands in a music library as "Unknown Artist" with a blank square, which is
the difference between a download you keep and one you redo by hand. Video keeps
its metadata and chapter marks too.

## Making YouTube work

YouTube turns anonymous downloads away with *"Sign in to confirm you're not a
bot"*. It scores each request on the IP's history, whether a proof-of-origin
token is present, and whether there is a session behind it. siphon works through
that in three escalating steps, and you only reach for the next one if the
previous fails.

### 1. The client ladder — automatic, nothing to do

YouTube exposes several clients (`tv`, `web_safari`, `android_vr`, `mweb`…) and
they are not policed equally. The set that works without a token shifts every
few months.

So a bot wall is not treated as a failure: siphon retries the same download
against a different client, in order, and only gives up once the ladder is
exhausted. The first rung is always yt-dlp's own default, because that tracks
upstream better than anything pinned here. The interface says
*"YouTube asked for a login — trying another client"* rather than silently
resetting the bar.

Only bot walls retry. A private video or a dead link fails immediately —
retrying four times would just make you wait four times as long for the same
answer.

### 2. Your cookies — for what the ladder cannot clear

Export `cookies.txt` from a browser where you are signed in (any Netscape-format
cookie extension) and upload it in **Settings → YouTube sign-in**. Downloads then
carry your own session and stop looking anonymous.

Two details that are easy to get wrong, and that siphon handles for you:

- **The TV client is dropped once cookies exist.** It authenticates differently,
  and pairing it with a logged-in session tends to invalidate that session — so
  the fix would become the cause. The ladder changes shape when a jar is present.
- **A JSON cookie export is rejected, not stored.** Accepting it would produce a
  bot wall later, which looks exactly like the problem you were trying to solve.

The jar is written owner-only, is never readable back over the API, and is not
served as a static file. It is still a logged-in session: only upload it to a
server you control, and consider a throwaway account.

### 3. A proof-of-origin provider — the hard cases

Some clients now want a token minted by YouTube's own JavaScript, which yt-dlp
cannot produce. The community provider can, as a sidecar:

```sh
docker compose -f docker-compose.yml -f docker-compose.potoken.yml up -d
```

The plugin is already in the image; the overlay starts the provider and points
siphon at it. Costs a container. Try cookies first.

### If all three fail

It is almost certainly the IP. Datacentre ranges get the strictest treatment, so
a deployed instance hits this far more often than the same code on your home
connection — which is why running it on your own machine is the first option in
this README, not the last.

And check the version: `yt-dlp` is pinned as a floor, not a ceiling, but a
container built months ago is running a months-old yt-dlp that may still be
trying a client YouTube has since closed. `docker compose build --pull` is the
fix, and the interface shows the running version next to the wordmark.

## Configuration

Browser mode has two settings and both are in the app, because nothing of yours
is running: the **relay** address, and where **ffmpeg.wasm** is fetched from if
you would rather not depend on a CDN. Both are optional and both start empty.

The server has the rest. All server-side, all environment variables:

| variable | default | what it does |
|---|---|---|
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to call the API. Set this to your frontend's URL once the server is reachable from outside. |
| `AUTH_TOKEN` | *(unset)* | Shared secret. **Set it the moment the server is reachable from the internet**, or you are running an open downloader for anyone who finds it. Paste the same value into the app's settings. |
| `MAX_CONCURRENT_JOBS` | `3` | Downloads running at once. |
| `JOB_TTL_SECONDS` | `3600` | How long a finished file stays on disk before it is swept. |
| `DOWNLOAD_DIR` | system temp | Where files land while you fetch them. |
| `ALLOW_PRIVATE_HOSTS` | off | Lets the server fetch from private/LAN addresses. Off by default — see below. |
| `COOKIES_FILE` | inside `DOWNLOAD_DIR` | Where the uploaded YouTube session is kept. Put it on a volume so it survives a restart. |
| `POT_PROVIDER_URL` | *(unset)* | Address of a proof-of-origin provider, e.g. `http://potoken:4416`. Unset means the plugin stays inert. |
| `PLAYLIST_LIMIT` | `50` | Most items one playlist download will fetch. |
| `PORT` | `8000` | Listen port. |

### Security

The server fetches URLs that whoever can reach it chooses, which is the classic
setup for SSRF. So by default it refuses anything that is not a public
`http(s)` address: no `file://`, no `localhost`, no `10.x`, and no
`169.254.169.254` — the cloud metadata endpoint that hands out the host's
credentials. Hostnames are resolved and *every* resulting address is checked,
because a public name is free to point at `127.0.0.1`.

`ALLOW_PRIVATE_HOSTS=1` turns that off. It exists for one real case — pulling
from a NAS on your own LAN — and should not be on for a server anyone else can
reach.

Requested qualities are an allow-list, not a format string, so the API cannot be
used to smuggle arbitrary yt-dlp options.

## The public-instance fallback

Settings also offers **a public instance**: the app asks a
[cobalt](https://github.com/imputnet/cobalt) instance for a direct link instead
of running anything itself. No server to deploy, but shared instances rate-limit,
require captchas or API keys, and come and go — and every link you paste is sent
to whoever runs it. There is no default instance baked in, deliberately: you have
to supply an address you actually trust. Treat this as the fallback, not the plan.

## Development

```sh
# server
pip install -r server/requirements.txt
WEB_DIR=web uvicorn server.app:app --reload --port 8000

# server tests
pip install pytest httpx
pytest server/tests -q

# frontend tests — the extractor's pure logic, no browser needed
npm test

# browser mode, end to end — builds its own fixtures with ffmpeg, serves the
# app and the media on two origins, and drives Chromium through the real UI.
# Needs playwright and ffmpeg; SIPHON_CORE_URL points at a local ffmpeg.wasm.
npm run test:e2e

# the app as deployed — HTTPS, a /siphon/ subpath, the service worker actually
# running, a first visit to a host with no API behind it, and the settings sheet.
# Needs playwright and openssl.
npm run test:deployed
```

The frontend has no build step and no dependencies: plain ES modules, no
framework, no bundler. Edit and reload. `package.json` exists only so
`node --test` can reach the extractor; nothing in `web/` imports from it.

Tests live in `tests/`, not under `web/`, because the Pages workflow publishes
that whole directory — anything left in it is served to the public site.

Where it lives:

| file | what it is |
|---|---|
| `app.js` | the screen and the queue |
| `api.js` | picks a backend; the server and cobalt clients |
| `inbrowser.js` | the browser backend — job table, HLS assembly, decryption |
| `extract.js` | what a link is, and what to download for a preset |
| `m3u8.js`, `net.js` | HLS parsing; fetching under CORS, with the relay fallback |
| `media.js`, `ffmpeg-worker.js` | ffmpeg.wasm, loaded on demand |
| `store.js` | finished files, in the origin private file system |

## What was verified

Against yt-dlp 2026.08.19, in a headless Chromium on a Pixel 7 profile:

- 29 server tests pass, covering the SSRF guard (including a hostname that
  resolves to loopback), the preset allow-list, and the auth token on every
  endpoint.
- The full path works end to end: paste a link → metadata resolves → pick MP3 →
  the browser receives a real `.mp3`.
- Progress is real, not decorative: on a throttled 16 MB download the bar
  advanced 3% → 56% → complete with live speed and ETA, and the whole file
  arrived.
- No horizontal scroll at phone width, and every visible control is at least
  40 px tall.
- A failed link produces a sentence, not a stack trace.
- The Android share target prefills the link and scrubs it from the address bar.

### Browser mode

54 unit tests cover the parts that can be checked without a network. 41 of them
are the extractor's pure logic: HLS attribute and playlist parsing, byte-range
continuation, IV derivation, YouTube URL shapes, page-scraping precedence, and
the whole preset → format decision table.

The other 13 are the relay. `relay/worker.js` is a plain module with a
`fetch(request, env)` export and nothing Workers-specific inside, so `node
--test` calls it directly with a stubbed upstream — which makes the headers it
chooses to forward directly observable. Covered: preflight reflection, the host
allow-list (including that `youtube.com.evil.example` does not pass the suffix
match), the origin allow-list, the refusal of `file://`, loopback, RFC1918 and
`169.254.169.254`, that cookies and `Authorization` cross in neither direction,
that a `Range` request and its `206` survive, and that a dead upstream is a 502
rather than a crash.

Then `npm run test:e2e`, which drives a real headless Chromium with the app on
one origin and the media on another, so the CORS path under test is the real
one. All 21 checks pass:

- A progressive MP4 arrives byte-identical to the source, and the 32 MB
  converter is never requested — verified on the wire, not assumed.
- An HLS master is parsed, the right rendition chosen (`Best` → 1280×720;
  `480p` → 640×360 out of 180/360/720), segments fetched and remuxed into an
  MP4 that ffmpeg reads back as h264 + aac.
- An AES-128 encrypted rendition is decrypted in the page with WebCrypto and
  remuxed the same way.
- MP3 comes back as real MP3 with no video stream and its title tag set; M4A
  comes back as AAC in an MP4 container with the video dropped.
- A plain HTML page's `og:video` is found, fetched, and named after the page,
  and its `og:image` arrives in the MP3 as an attached cover.
- A YouTube link with no relay fails with a sentence naming the reason, not a
  stack trace.
- A finished row survives a reload with its Save button intact, because the file
  is in OPFS.
- No uncaught errors in the page across all of it.

### As deployed

`npm run test:deployed` covers what only happens on a real static host, neither
of which the suite above touches — it runs over plain HTTP, where the service
worker never registers, and against a host that answers the API. 26 checks
pass:

- A first visit to a host with no `/api/health` lands in browser mode, with a
  header that says it is ready rather than a notice telling the visitor to go
  and configure something.
- A first visit to a host that *does* answer keeps server mode and names the
  yt-dlp it found, so the container setup does not regress.
- A mode the user already chose is never overridden, in any of the three.
- A deploy landing under a returning visitor: the previous worker and its cache
  are replaced, the old cache is swept, and the new app renders rather than the
  cached old one — on that visit and the next.
- With the network cut, the shell still opens, which is the only reason the
  worker exists.
- The settings sheet, driven the way a person drives it: every mode shows its
  own fields and no others, the cookie jar appears only for the server we run
  ourselves, **Test** names the missing relay rather than showing a green light
  that means nothing, the choice survives a reload, and nothing scrolls sideways
  at phone width.

**Not verified here:** how YouTube itself answers. The environment this was
built in cannot reach YouTube or a CDN at all — the egress gateway refuses the
connection — so the InnerTube client and the signature solving were written
against youtubei.js's documented behaviour and reviewed, not run. The relay's
own decisions are covered by the tests above; what is untested is the reply
coming back. No emulator would have helped: the block is a network policy, and
CORS would apply identically inside one anyway.

## Licence

MIT.
