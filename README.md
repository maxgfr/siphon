# yt-dlp-web

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
large yt-dlp web UIs (MeTube, yt-dlp-web-ui) are all self-hosted. The one genuine
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

### 2. Tailscale — from anywhere, still your own machine

The best of the three, and free. Install [Tailscale](https://tailscale.com) on
both the computer and the phone, sign in to the same account, then:

```sh
tailscale serve --bg 8000
```

That publishes the app inside your private network at a real HTTPS address
(`https://<machine>.<tailnet>.ts.net`, needs MagicDNS and HTTPS enabled once in
the admin console). Open it on the phone from anywhere — mobile data included.
No port forwarding, nothing exposed to the internet, and a genuine certificate,
so **Add to Home Screen** gives you a proper installed app.

A free one-off alternative, with no account, is a quick Cloudflare tunnel —
but it puts the app on a public URL, so set `AUTH_TOKEN` first:

```sh
cloudflared tunnel --url http://localhost:8000
```

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

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/maxgfr/yt-dlp-web)

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
git clone https://github.com/maxgfr/yt-dlp-web
cd yt-dlp-web
docker compose up -d
```

Open `http://localhost:8000`. That is the whole setup.

To reach it from your phone, put it behind something with a real hostname and
HTTPS — Tailscale, a Cloudflare tunnel, or a reverse proxy. **Browsers block a
page served over HTTPS from calling a plain-HTTP server**, so a hosted frontend
needs an HTTPS backend.

### Using the GitHub Pages frontend instead

If you would rather not expose the interface, publish `web/` to Pages (the
included workflow does it on every push to `main`) and point it at your server
in **Settings → Your own server**. Then set `ALLOWED_ORIGINS` on the server to
your Pages URL so it stops accepting requests from anywhere:

```sh
ALLOWED_ORIGINS=https://maxgfr.github.io docker compose up -d
```

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
