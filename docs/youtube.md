# YouTube from a web page, in 2026

What a browser can and cannot do about YouTube, what the open-source projects
actually do, and what this project measured — from GitHub's runners, on
2026-09-16 — before deciding what it ships. The README says what to do; this
says why.

## The wall

A browser will not let a page read a cross-origin response unless the host says
it may. That is not a bug to route around: a service worker has no extra
network privileges, JavaScript cannot read an opaque `no-cors` body, and
`ffmpeg.wasm` only helps once you already have the bytes.

**YouTube is the host that says no.** Its InnerTube API sends no cross-origin
headers, and `*.googlevideo.com` allows only `youtube.com`, so the request fails
before it leaves the browser. Signing the stream URL is the *easy* half — that
is just JavaScript, and [YouTube.js](https://github.com/LuanRT/YouTube.js) does
it in the page — but a signed URL you are not allowed to fetch is no use.

And the wall has been rebuilt behind the CORS one:

- YouTube no longer puts direct links in the page. Playback is a POST with a
  Protobuf body to a single streaming endpoint, the answer is a multiplexed
  `application/vnd.yt-ump` blob, and most requests need a proof-of-origin
  token minted by YouTube's own bot-detection script inside a real session
  — without it, a 403. That is SABR, and it is why the old browser tricks
  died ([Koudela, 2026](https://medium.com/@vlastimil.koudela/how-to-download-from-youtube-in-2026-and-why-the-old-browser-trick-died-b44474d7e350)).
- Every "no install" site Reddit recommends is a server: cobalt (its own
  API, [blocked for YouTube and keyed since](https://github.com/imputnet/cobalt/discussions/860)),
  or an SEO site running yt-dlp on its own box. The community's actual
  answer for power users is yt-dlp on your machine
  ([r/DataHoarder, r/youtubedl consensus](https://www.notelm.ai/blog/youtube-downloader-reddit-picks);
  [what still works in 2026](https://joinotto.com/blog/youtube-video-downloader-reddit)).
  Self-hosting a cobalt instance is the documented fix
  ([run an instance](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md)).
- The open-source frontends — Invidious, Piped — are backends with a web
  client, and their public instances have closed the video API to pages
  (measured below); the [official list](https://docs.invidious.io/instances/)
  is five clearnet instances today.

## What moves the wall, and what does not

CORS is enforced by whatever is running the page, so changing *that* can lift
it. Changing where the page runs cannot.

**An emulator or a simulator buys nothing.** Chrome in an Android emulator is
Chrome: same origin policy, same refusal. The wall is in the browser, not in
the hardware under it.

**A different host for the page does buy something**, because it is no longer a
browser tab making the request:

| route | lifts CORS | what it costs |
|---|---|---|
| **[the bridge](../bridge/)** — a userscript on siphon's page | yes — the userscript manager lends its host permissions | installing one script in Tampermonkey or Violentmonkey |
| [Termux](https://termux.dev) on Android | n/a — real yt-dlp, on the phone | a terminal app, and a build or two |
| a WebView shell (Capacitor, Cordova) | yes — the native layer fetches | an APK to install and keep signed |
| a browser extension | yes — host permissions bypass it | desktop, or Firefox for Android only |
| a relay | no — it satisfies CORS rather than skipping it | one free Worker |

The transferable idea is the bridge's, and its general form is not "run on
youtube.com" but **run with a userscript manager's privileges**: a script
granted `GM_xmlhttpRequest` with `@connect *` fetches any URL with no
cross-origin rule at all, because the manager is itself an extension.

**Termux is the best of these on Android** and needs nothing from this project
that is not already here: install Python, ffmpeg and yt-dlp, run `server/` on
the phone, and open `http://localhost:8000` — the server serves the interface
too, so there is no CORS and no mixed content. Expect the usual Termux friction
on compiled dependencies (plain `uvicorn` rather than `uvicorn[standard]` is the
easy path), and note this is untested here.

A WebView shell is the only route that is both backend-free *and* works for
YouTube on a stock phone, because the native HTTP layer is not bound by CORS at
all. It is not in this repo: it trades "nothing to install" — the premise the
whole project is built on — for that one site.

## What the open-source projects actually do

"Runs in the browser" is claimed far more often than it is true. Read from
their source rather than their READMEs:

| project | how it really gets the video |
|---|---|
| [Piped](https://github.com/TeamPiped/Piped), [Invidious](https://github.com/iv-org/invidious) | a backend in Java / Crystal; the SPA is a client of it |
| [cobalt](https://github.com/imputnet/cobalt) | an `api/` server it describes as "a fancy proxy" — though it now runs ffmpeg **in the browser** (`web/src/lib/task-manager/runners/ffmpeg.ts`), the same choice made here |
| [FreeTube](https://github.com/FreeTubeApp/FreeTube) | Electron: the shell fetches, not a web page |
| [YouTube.js](https://github.com/LuanRT/YouTube.js) | a library; its own browser example ships a service worker *and* a Cloudflare Worker, i.e. a relay |
| [cat-catch](https://github.com/xifangczy/cat-catch) | an extension with `webRequest` and `<all_urls>`, whose page script proxies `MediaSource.prototype.addSourceBuffer` to capture what *any* site's player is playing |
| [Local YouTube Downloader](https://greasyfork.org/en/scripts/484735-local-youtube-downloader) | a userscript that runs **on youtube.com's own origin**, so InnerTube and googlevideo are same-origin |

So no full-frontend YouTube client works from a foreign origin. The ones that
work have a server, a native shell, or run *on the site*.

The useful question for a page on GitHub Pages is a narrower one: **which of
those servers are run in public, and answer a page?**

| project | public instances? | usable from a page? | here |
|---|---|---|---|
| [Invidious](https://github.com/iv-org/invidious) | yes — the project publishes [its own list](https://docs.invidious.io/instances/) | **less and less.** The stats endpoint sends CORS everywhere; the *videos* endpoint a page needs is being closed to other apps — measured below | bundled list, refreshed daily, walked in seconds — a chance, not a plan |
| [Piped](https://github.com/TeamPiped/Piped) | a [list](https://piped-instances.kavin.rocks/), mostly dark since YouTube's 2024–25 blocks | yes, the same way | supported; ranked after Invidious |
| [cobalt](https://github.com/imputnet/cobalt) | a [list](https://cobalt.directory/) (the older `instances.cobalt.best` left DNS in 2026), but most now want an API key or a Turnstile pass | yes, when one lets you in | supported; asked for the finished file |
| [Materialious](https://github.com/Materialious/Materialious), [Yattee](https://github.com/yattee/yattee), [Clipious](https://github.com/lamarios/clipious) | — | — | clients of Invidious's API: any instance that serves them serves this app |
| [NewPipe](https://github.com/TeamNewPipe/NewPipe), [LibreTube](https://github.com/libre-tube/LibreTube), [FreeTube](https://github.com/FreeTubeApp/FreeTube) | — | no: native apps, the extractor runs in the app | — |
| yt-dlp behind an HTTP API (dozens of small projects) | no public ones worth naming — a public yt-dlp box is abuse bait and dies fast | — | that is what `server/` is, for you to run |

Sources for the survey:
[Piped instances in 2026](https://sumguy.com/invidious-piped-redlib-nitter-2026/),
[Piped vs Invidious](https://dev.to/selfhostingsh/invidious-vs-piped-4ijn),
[Local YouTube Downloader on Greasy Fork](https://greasyfork.org/en/scripts/484735-local-youtube-downloader),
[Universal Video Sniffer](https://greasyfork.org/en/scripts/557721-universal-video-sniffer),
[sniff-hls](https://github.com/nuoyax/sniff-hls).

## What was measured, 2026-09-16

Every line below is from a GitHub Actions runner's log, quoted rather than
summarised. A runner is a datacentre IP, which is the case YouTube treats
most harshly — and also the case a deployed site is in.

### YouTube itself, to a bare request

`tests/innertube-probe.mjs`: one hand-built InnerTube call per client, then the
same through youtubei.js, no browser, no relay.

```
WEB          HTTP 200  playability=LOGIN_REQUIRED (Sign in to confirm you're not a bot)  formats=0
MWEB         HTTP 200  playability=LOGIN_REQUIRED  formats=0
TV_EMBEDDED  HTTP 200  playability=ERROR (YouTube is no longer supported in this application or device.)
IOS          HTTP 200  playability=LOGIN_REQUIRED  formats=0
ANDROID_VR   HTTP 200  playability=LOGIN_REQUIRED  formats=0
0/8 hand-built variants got a playable answer
```

The same from the browser through the relay (`npm run test:youtube`): *YouTube
turned every client away. Last answer: Sign in to confirm you're not a bot.*

### The public Invidious instances, asked as a page asks

All seven on the bundled list, each asked its stats endpoint and then the video
endpoint with an `Origin` header, exactly as a page sends it:

```
invidious.f5.si            stats HTTP 200 cors="*"   videos HTTP 200 cors="*" — (empty body)
inv.nadeko.net             stats HTTP 200 cors="*"   videos HTTP 403 cors=NONE — Endpoint disabled
yewtu.be                   stats HTTP 200 cors="*"   videos HTTP 403 cors=NONE — 403 Forbidden (openresty)
invidious.nerdvpn.de       ETIMEDOUT                 ETIMEDOUT
yt.chocolatemoo53.com      stats HTTP 200 cors="*"   videos HTTP 403 cors=NONE — forbidden
invidious.tiekoetter.com   stats HTTP 200 cors="*"   videos HTTP 403 cors=NONE — 403 Forbidden
inv.thepixora.com          HTTP 303                  HTTP 303 (to its own page)
```

So it is neither YouTube nor a firewall: **the operators have closed the video
endpoint** — one by config ("Endpoint disabled"), several at the reverse proxy,
one to browsers specifically — to survive YouTube's blocking of instances that
serve third-party clients. The probe that recognises an instance is its stats
endpoint, which still answers everyone; the endpoint a download needs is a
different door, and it is shut on every public instance measured. The page's
own request is a plain GET with `credentials: omit` and no custom header, so
nothing on this side is what they are refusing.

Three earlier walks the same day told the same story less sharply: three
instances gave the page nothing at all (no status, no answer), each eating the
full probe budget — every call to an instance is bounded to fifteen seconds
since; a bare request found them all up while the browser's died in half a
second with `net::ERR_FAILED`, an answer the browser refused rather than a host
that was down.

### The public CORS proxies

`scripts/relay-config.mjs`, run daily: each proxy is asked to fetch
`youtube.com/robots.txt` for a page.

```
corsproxy.io        robots: HTTP 401     (a key is required)
api.cors.lol        robots: HTTP 429     (rate-limited)
proxy.corsfix.com   robots: HTTP 403     (origin refused)
api.codetabs.com    robots: HTTP 522     (down)
api.allorigins.win  robots: HTTP 522     (down)
cors.eu.org         robots: HTTP 403
thingproxy          ENOTFOUND            (gone)
→ no relay passed; the site keeps none
```

A later run the same day: `api.allorigins.win` answered robots with CORS once,
then `HTTP 522` for every Invidious instance asked through it. Not one free
proxy carries the page's requests, so the site ships with no relay, and a fresh
visitor is not pointed at a dead one.

### The public cobalt instances

The same run walks cobalt's directory. The first measurement found the
directory it was written against, `instances.cobalt.best`, gone from DNS
(`fetch failed` from the runner, no answer from any resolver). The second
reached its successor and was turned away at the door:

```
cobalt instances:
no   directory https://cobalt.directory/api/working?type=api: HTTP 403 — <!DOCTYPE html>…<title>Just a moment...</title>
no   directory https://cobalt.directory/api/tests: HTTP 403 — <!DOCTYPE html>…<title>Just a moment...</title>
```

That is a browser challenge, served to anything that is not a browser. The run
now reads the list the site is built from — the opt-in list
[its repository](https://codeberg.org/hyperdefined/cobalt.directory) keeps at
`backend/instances`, through Codeberg's plain API — and names each directory
and the source with what it said. The third measurement reached that file
(the API answered it with its content, where a folder had been expected) and
the reader was taught its shape; the next log says what it lists.
`cobalt.tools` itself is keyed, Turnstile-gated and blocked by YouTube.

## What follows

The three shapes of "it works" are the three the project ships, in the order a
visitor meets them: something the site's owner runs once for everyone (the
relay, `SIPHON_RELAY_URL`); something someone else runs and the daily
measurement found working today (an instance in `config.json`); and something
that is yours (the bridge, or the server). There is no fourth, and the README
will not pretend there is.

**What is not verified:** a completed YouTube download from the browser mode
through a public instance or a relay on a datacentre IP. The code is correct up
to the wall, checked request by request, and every suite that can run without
YouTube's cooperation is green. From a home connection — `node relay/serve.mjs`
on your own machine, its address in settings, or the bridge — that is the case
the code is written for, and the one measurement a runner cannot make.

**The server is measured separately.** `npm run test:server` starts
`server/app.py` on a runner and asks it for the same video, first plain and then
with the proof-of-origin provider beside it — the `docker-compose.potoken.yml`
arrangement. Its log says what yt-dlp said, client by client; see the
`server-youtube` job on any pull request for today's answer.
