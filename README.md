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

## Quick start

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
