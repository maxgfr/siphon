# siphon

Paste a link, pick a quality, get the file. A mobile-first web front end for
[yt-dlp](https://github.com/yt-dlp/yt-dlp), with nothing to install on the phone.

Open it, tap **Paste**, tap **Download**. On Android you can also share a link
straight from YouTube into it, because it installs as a share target.

## Why there is a server in here

A web page cannot download a YouTube video on its own. Two hard walls, not a
missing feature:

- **CORS.** Media hosts send no cross-origin headers, so a browser refuses to
  let a page on your domain read their bytes.
- **Signed URLs.** Getting a playable stream URL out of YouTube means running
  its own JavaScript to solve a signature challenge.

So something has to run yt-dlp. This project is both halves:

| | what it is | where it runs |
|---|---|---|
| `web/` | the interface | GitHub Pages, or any static host |
| `server/` | a small API around yt-dlp | a container you run |

The frontend is useless alone and says so on first load. Point it at a server in
settings, and it works.

### "Can't the browser just do it?"

No, and it is worth knowing why before trying:

- `*.googlevideo.com` allows CORS only from `youtube.com`, so a page on your own
  domain cannot read the bytes.
- Getting the signed stream URL in the first place means running YouTube's own
  player JavaScript. [YouTube.js](https://github.com/LuanRT/YouTube.js), the
  reference InnerTube client, states plainly that browser use requires proxying
  through your own server, and ships a proxy in its browser example.
- A service worker is a fake server, but it has no extra network privileges: its
  requests obey the same CORS rules, JavaScript cannot read an opaque
  (`mode: "no-cors"`) response body, and the spec forbids answering a navigation
  with one.
- `ffmpeg.wasm` is real and useful — it merges video and audio in the browser —
  but only once you already have the bytes.

Projects advertising a backend-free YouTube downloader are using someone else's
server underneath: the well-known ffmpeg.wasm one routes through Piped, and the
large yt-dlp web UIs (MeTube, siphon-ui) are all self-hosted. The one genuine
exception is a browser extension, whose host permissions do bypass CORS — but on
mobile that only exists on Firefox for Android.

That is why this project offers your own server first and a public instance as a
fallback: those are the two options that actually exist.

## The shortest setup: you are the client

You do not have to host anything. Put the interface on GitHub Pages, run yt-dlp
on the computer you are sitting at, and point one at the other:

```sh
docker compose up -d                      # yt-dlp, on your machine, port 8000
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

Everything in one container — the image serves the interface *and* the API, so
there is no CORS to configure and no second thing to deploy:

```sh
git clone https://github.com/maxgfr/siphon
cd siphon
docker compose up -d
```

Open `http://localhost:8000`. That is the whole setup.

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

All server-side, all environment variables:

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

# tests
pip install pytest httpx
pytest server/tests -q
```

The frontend has no build step — three files, plain ES modules, no framework, no
bundler. Edit and reload.

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

## Licence

MIT.
