# siphon

Paste a link, pick a quality, get the file. A mobile-first downloader with
nothing to install on the phone — and, for a lot of links, nothing to run
anywhere at all.

Open it, tap **Paste**, tap **Download**. On Android you can also share a link
straight from YouTube into it, because it installs as a share target.

## One address, and it works out the rest

The device does the downloading. That is the default and it needs nothing: paste
a direct file, an HLS stream or a page that declares its video, and the whole
job — fetch, merge, convert, tag — happens in the tab you have open.

Some sites refuse a web page outright, YouTube above all, and no amount of
JavaScript changes that. For those, siphon takes **one optional address**, and
works out on its own what is behind it:

| what you point it at | what it is asked to do |
|---|---|
| **your own siphon server** (`server/`) | with ffmpeg: everything, every site yt-dlp knows. Without ffmpeg: it resolves links, and this device does the work |
| **a [cobalt](https://github.com/imputnet/cobalt) instance** | whatever this device could not read itself |
| **an [Invidious](https://github.com/iv-org/invidious) or [Piped](https://github.com/TeamPiped/Piped) instance** | YouTube |
| **a relay** (`relay/`) | carry the bytes of hosts that refuse a page, and nothing else |
| nothing at all | this device only, and links that need more say so |

You never pick a mode. Saving the address probes it once — a siphon server
answers `/api/health` with its own name, cobalt answers its root, Piped answers
`/config`, Invidious names itself at `/api/v1/stats`, a relay fetches something
for you — and what it turns out to be is remembered alongside it. Point it at a blog and it tells you so rather than
failing later on a real link.

On a first visit with nothing saved, the same probe runs against the page's own
origin. The container serves both halves, so it answers and everything works
with no configuration; a static host does not, so the device does it. Either
way the first screen works rather than opening on an instruction.

### Finding a public instance

When nothing is behind the page, a YouTube link would fail on arrival —
correctly, but nobody pastes a link in order to read about CORS. So on that
first visit, *after* the screen is usable, siphon asks the cobalt, Invidious
and Piped projects for their own published instance lists, probes what comes
back, and fills in the first address that actually answers. **Find a public instance** in
settings does the same on demand.

The directory is a hint; the probe is the truth. A list can be stale, a host
can be down, an instance can be blocked by YouTube this week, and none of that
is visible in a JSON file — so nothing is used until it has answered for
itself, through the same detection a typed-in address goes through. cobalt is
preferred, because it reaches more than one site; of the two that reach only
YouTube, Invidious comes before Piped, because far more of its public
instances are still standing.

Two rules make this safe to do automatically, and they hold everywhere:
whichever instance is chosen is **named on screen** the moment it is, and
clearing it is one tap. It is someone else's server and it sees the links it is
asked about. The search runs once per browser, never behind your back
afterwards: if you clear the address, it stays cleared.

### The split: the server says where, the device fetches

This is the shape [cobalt](https://github.com/imputnet/cobalt) found, and it is
the right one. The single thing a browser genuinely cannot do is convince a site
it is not a browser: YouTube checks who is asking, and a page is the wrong
answer whatever headers it sets. Everything *after* that — downloading,
merging, converting — a browser does perfectly well, and doing it there costs
the server no disk, no CPU and no bandwidth.

So a siphon server exposes two small endpoints beside the full job API:

- `POST /api/resolve` runs yt-dlp's extractor and nothing else, and hands back
  the formats with their URLs — the part that needs the server's identity, its
  IP and your cookies.
- `GET /api/tunnel?url=…` carries the bytes of a URL a resolve just named, for
  the hosts that refuse a page. It only ever fetches hosts a recent resolve
  produced, with the headers that resolve said they need, so it is a tunnel and
  not an open proxy.

A server **with** ffmpeg still takes the whole job: yt-dlp doing the entire
download is more capable than anything else on offer, and it is your machine.
A server **without** ffmpeg — or one you deliberately run thin — resolves, and
your phone does the rest. Nothing in the UI changes either way.

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

So YouTube needs a helper, and three of the four need nothing of yours
running at all:

- **An [Invidious](https://github.com/iv-org/invidious) or
  [Piped](https://github.com/TeamPiped/Piped) instance.** Either API answers
  a web page directly and proxies the media with the headers the browser
  needs — Invidious when asked with `local=true`, Piped always — so the
  browser mode's own pipeline — the planner, ffmpeg.wasm, the queue — runs on
  top of it unchanged. Paste an instance's address into the one address field
  in settings and YouTube works from a phone with nothing deployed. It is
  someone else's server: it sees every YouTube link you paste, instances come
  and go, and YouTube blocks them in waves. There is no default baked in,
  deliberately, for the same reason there is none for cobalt: the first visit
  goes and *finds* one that answers today, and says which. When one is set it
  is tried first and a relay is the fallback.
- **[A relay](relay/)** — one file that adds the missing header and forwards
  nothing else. No yt-dlp, no ffmpeg, no state, and nothing to maintain when
  YouTube changes, because the part that changes is running in your browser.
  One click puts it on a free Cloudflare Worker; `node relay/serve.mjs` runs
  the same file on your own machine with no account at all, on your home IP,
  which YouTube treats far more gently than a datacentre's. It is still a
  server, so it is optional and empty by default; leave it unset and YouTube
  links say exactly why they failed.
- **Your own server**, below, which is the only option with a cookie jar and a
  proof-of-origin provider — and so the only one that clears a determined bot
  wall.

Projects advertising a backend-free YouTube downloader are, as far as we can
tell, all using someone else's server for that last hop. This one is honest
about which hop that is — and an Invidious or Piped instance *is* that: the
instance is the hop, and the app says so in its privacy line.

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
| **[the bridge](bridge/)** — a userscript on siphon's page | yes — the userscript manager lends its host permissions | installing one script in Tampermonkey or Violentmonkey |
| [Termux](https://termux.dev) on Android | n/a — real yt-dlp, on the phone | a terminal app, and a build or two |
| a WebView shell (Capacitor, Cordova) | yes — the native layer fetches | an APK to install and keep signed |
| a browser extension | yes — host permissions bypass it | desktop, or Firefox for Android only |
| a relay | no — it satisfies CORS rather than skipping it | one free Worker |

### What the open-source projects actually do

It is worth checking, because "runs in the browser" is claimed far more often
than it is true. Read from their source rather than their READMEs:

| project | how it really gets the video |
|---|---|
| [Piped](https://github.com/TeamPiped/Piped), [Invidious](https://github.com/iv-org/invidious) | a backend in Java / Crystal; the SPA is a client of it |
| [cobalt](https://github.com/imputnet/cobalt) | an `api/` server it describes as "a fancy proxy" — though it now runs ffmpeg **in the browser** (`web/src/lib/task-manager/runners/ffmpeg.ts`), the same choice made here |
| [FreeTube](https://github.com/FreeTubeApp/FreeTube) | Electron: the shell fetches, not a web page |
| [YouTube.js](https://github.com/LuanRT/YouTube.js) | a library; its own browser example ships a service worker *and* a Cloudflare Worker, i.e. a relay |
| [cat-catch](https://github.com/xifangczy/cat-catch) | an extension with `webRequest` and `<all_urls>`, whose page script proxies `MediaSource.prototype.addSourceBuffer` to capture what *any* site's player is playing |
| [Local YouTube Downloader](https://greasyfork.org/en/scripts/484735-local-youtube-downloader) | a userscript that runs **on youtube.com's own origin**, so InnerTube and googlevideo are same-origin |

So no full-frontend YouTube client works from a foreign origin. The ones that
work have a server, a native shell, or run *on the site*. The transferable idea
is the last one, and its general form is not "run on youtube.com" but **run
with a userscript manager's privileges**: a script granted `GM_xmlhttpRequest`
with `@connect *` fetches any URL with no cross-origin rule at all, because the
manager is itself an extension.

### The bridge

That is what [`bridge/siphon-bridge.user.js`](bridge/) is. It runs only on
siphon's own page, and does one thing: when the page asks for a URL, it
fetches it with the manager's privileges and hands the bytes back. siphon's
`net.js` treats it as a route between *direct* and *relay* — tried before the
relay, because it is on this device and involves no server of anyone's.

Nothing else changes. Every extractor already here — direct files, HLS, pages,
YouTube through youtubei.js — works on hosts that refuse the page, because the
thing that refused them is gone. **No relay, no instance, no server.** Install
one script, and YouTube downloads in browser mode on desktop Chrome or Firefox
(Tampermonkey, Violentmonkey) and on Firefox for Android (Violentmonkey).

The page never trusts the bridge with a decision: it hands over a URL and gets
bytes, and messages are matched on `event.source === window`, so another frame
cannot inject a response. The script sends requests `anonymous`, so a site's
cookies never ride along with a fetch the page asked for.

`npm run test:bridge` proves it against a media host that sends **no** CORS
headers: without the bridge the page is refused, exactly as by YouTube; with
the shipped userscript injected and `GM_xmlhttpRequest` played by a Node fetch
— which has no same-origin policy, like the real thing — a direct file arrives
byte-identical, an HLS ladder is fetched and remuxed, and a page is scraped
and converted to MP3.

Sources for the project survey:
[Piped instances in 2026](https://sumguy.com/invidious-piped-redlib-nitter-2026/),
[Piped vs Invidious](https://dev.to/selfhostingsh/invidious-vs-piped-4ijn),
[Local YouTube Downloader on Greasy Fork](https://greasyfork.org/en/scripts/484735-local-youtube-downloader),
[Universal Video Sniffer](https://greasyfork.org/en/scripts/557721-universal-video-sniffer),
[sniff-hls](https://github.com/nuoyax/sniff-hls).

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

### What the device alone does not do

Worth knowing before you rely on it with no helper set:

- **Subtitles only where a link offers them.** A direct file or a scraped page
  has none to offer, so there is nothing to embed; when a helper resolves a
  link that does have them, one is muxed into the video. A separate `.srt`
  beside the file still needs your own server.
- **No cookies.** There is nowhere safe to put them and nothing that would use
  them.
- **Sites that build their player in JavaScript** hide the file from a markup
  scrape. yt-dlp has a hand-written extractor for each of those; this has four
  general ones.
- **Converting a big file still needs it in memory.** ffmpeg.wasm wants the
  whole input and the whole output at once, and a phone may not have it — the
  row says so above half a gigabyte rather than letting the tab die quietly.
  Downloads that need *no* conversion, which is most of them, never touch the
  heap at all: they stream straight to disk.

## The shortest setup: you are the client

For anything the device does not cover on its own — YouTube, a site that hides
its player behind JavaScript, subtitles, a whole playlist — you want yt-dlp. You
still do not have to host it anywhere. Put the interface on GitHub
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

## A download that breaks does not start again

Every host that serves media supports byte ranges, so a connection that dies at
80% is picked up from 80%: the next attempt asks for the rest and appends it.
Four attempts with a widening pause between them, and if the host turns out to
ignore ranges and send the whole file again, what was held is thrown away
rather than prepended to itself. A refusal — a 404, a private video — is not
retried at all, because repeating it would only make the same answer arrive
later.

The same applies to the helper. If the public instance in use stops answering,
siphon takes the next one off the list it found the first from, says which, and
retries. It does that only for failures that are about the helper rather than
the video: a private video is private on every instance in the world.

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
On the device the first two apply: a subtitle track the link offers is fetched
and muxed into the video as `mov_text`, with its language tag set so a player's
menu says "English" rather than "Track 1". Asking for subtitles on a file that
would otherwise have needed no conversion means it now gets one — that is the
cost of asking, and it is only paid when a track was actually found. The
languages are a preference list, not a filter: ask for `fr,en`, be offered only
Japanese, and you get Japanese rather than nothing.


Auto-generated captions are always included in the request: most of YouTube has
no human subtitles, and asking only for those returns a file with none at all
and no explanation. Audio presets ignore the setting, since an MP3 has nowhere
to put them.

## Playlists and albums

Paste a playlist, a channel or an album and siphon offers to take the lot. It is
offered, never assumed: a `watch?v=…&list=…` link is a video that happens to sit
in a playlist, so **This one** stays the default and **All 40** is one tap away.

**With a full server**, everything arrives as a single `.zip`, because one job
can only hand back one file. Inside, tracks are numbered in playlist order —
that ordering exists nowhere else once the files are on your disk. The archive
is stored rather than deflated: media is already compressed, so deflating it
would burn CPU over a whole playlist to save nothing.

**On the device**, a playlist becomes a row per video instead. A tab cannot
build an archive without holding all of it, and one row each is the better
shape anyway: every file arrives on its own, with its own progress, and a
failure halfway through costs one video rather than fifty.

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

The app has three settings, all optional and all empty to begin with: the
**helper** address, its **access key** if it wants one, and, under Advanced,
where **ffmpeg.wasm** is fetched from if you would rather not depend on a CDN.

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
| `TUNNEL_HOST_TTL` | `7200` | Seconds a host named by a resolve stays fetchable through `/api/tunnel`. Long enough for a download, short enough that the tunnel is never an open proxy. |
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

Point the address at a [cobalt](https://github.com/imputnet/cobalt),
[Invidious](https://github.com/iv-org/invidious) or
[Piped](https://github.com/TeamPiped/Piped) instance and it is used for whatever
this device could not read by itself — and with nothing saved, siphon will go
and find one, as above.

An Invidious or Piped instance is asked for a video's streams and hands back
URLs that go through its own proxy, which is the only kind a page can fetch:
the device then downloads, merges and converts as it does for any other link,
and the instance never sees more than the video id. Their subtitle tracks come
along, so **In the video** works with an instance too. cobalt is asked for the
finished file instead, since that is the shape of its API.

It is worth being plain about what that means. Shared instances rate-limit,
require captchas or API keys, and come and go, and **every link that reaches one
is seen by whoever runs it**. No instance is hard-coded as a default: the seed
list in `web/instances.js` is a fallback for when the projects' own directories
cannot be reached, every address is probed before use, and the one in use is
named on the main screen. Treat this as the fallback, not the plan — your own
server is the plan.

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

# the bridge, against a media host that sends no CORS headers at all.
# Needs playwright and ffmpeg.
npm run test:bridge

# the split: a server that only resolves, a device that downloads through its
# tunnel, against a media host that refuses the page. Needs playwright, ffmpeg.
npm run test:split

# what YouTube's API says to a bare request from this machine — one hand-built
# call per client, then the same through youtubei.js, no browser, no relay.
# The baseline a red below is read against.
npm run test:innertube

# YouTube, for real, through the local relay. Needs a network that reaches
# youtube.com; runs in CI, where it is informative rather than gating.
npm run test:youtube
```

All of it runs on every pull request. `fast` (the server suite and the unit
tests) and `browser` (the four Playwright suites) gate the merge. `youtube`
does not: a runner is a datacentre IP, and whether YouTube answers one on a
given day is YouTube's decision, not this code's. A red there says *look*,
never *do not merge* — and the log says exactly why: every step announces
itself, every refusal is printed with its body, and the probe that runs first
shows what YouTube says to that machine with nothing of ours in between. As of
this writing that answer, on a GitHub runner, is "Sign in to confirm you're
not a bot" for every client — the wall the relay section above describes,
seen from inside it.

The frontend has no build step and no dependencies: plain ES modules, no
framework, no bundler. Edit and reload. `package.json` carries only the test
tooling — Playwright for the browser suites, youtubei.js for the probe —
and nothing in `web/` imports from it.

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

Every number here comes from a run, and the last section says plainly what is
still unproven.

| suite | what it is | result |
|---|---|---|
| `pytest server/tests` | the server, including two against real yt-dlp | 119 pass |
| `npm test` | the extractor, the relay, resuming, detection, instance finding | 118 pass |
| `npm run test:e2e` | the device alone, real Chromium, two origins, a fake Invidious | 33 pass |
| `npm run test:deployed` | the app as a static deploy: HTTPS, subpath, service worker | 36 pass |
| `npm run test:bridge` | a userscript lifting CORS on a host that refuses | 8 pass |
| `npm run test:split` | a server that only resolves, a device that downloads | 24 pass |
| `npm run test:youtube` | YouTube, for real, in CI | informative — see below |

### The device alone

Finding a public instance is covered with both the directories and the probe
stubbed: that a listed address is only used once it has answered for itself,
that an instance listed as offline is never even contacted, that a directory
which changed shape is ignored rather than thrown on, that a siphon server or a
relay appearing in such a list is not mistaken for an instance, that the
Invidious directory's `[name, details]` pairs are read with onion, API-less
and CORS-less entries left out, and that the number of strangers contacted on
a first visit is capped — and spread across the directories, so a long cobalt
list cannot crowd the YouTube-only kinds out of that budget. Detection is covered for every kind, including an
Invidious instance whose stats endpoint is switched off — the default — which
is then known by the one sentence it refuses with.

The unit tests cover what needs no network: HLS attribute and playlist parsing,
byte-range continuation, IV derivation, YouTube URL shapes, page-scraping
precedence, the whole preset → format decision table, and the InnerTube fetch
wrapper. The relay is in there too — `relay/worker.js` is a plain module with a
`fetch(request, env)` export and nothing Workers-specific inside, so `node
--test` calls it directly with a stubbed upstream, which makes the headers it
chooses to forward directly observable. Endpoint detection is covered with a
stubbed fetch: each kind of helper, the refusals, and the sentences that follow.

`npm run test:e2e` then drives a real headless Chromium with the app on one
origin and the media on another, so the CORS path under test is the real one:

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
- A YouTube link with no helper fails with a sentence naming the reason.
- **A host that drops the connection a third of the way through** is resumed:
  the next request asks for `bytes=<what arrived>-`, and the file that lands is
  byte-identical to the source. Ten more cases cover the same logic with the
  network stubbed — a host that ignores the range, a stream that ends early
  while claiming more, a refusal that must not be retried, and the error that
  names how far it got when the attempts run out.
- A finished row survives a reload with its Save button intact, because the file
  is in OPFS.
- **An Invidious instance carries YouTube.** A fake one speaking the real API —
  `/api/v1/stats` naming the software, `/api/v1/videos/{id}` with numbers as
  strings and media paths relative to the instance, `/videoplayback`, WebVTT at
  `/api/v1/captions` — is typed into the settings sheet, recognised from the
  address alone, and named in the header and the privacy line. A YouTube link
  is then resolved by it with `local=true` (the only form a page can fetch),
  the file arrives through its proxy byte-identical, and is named after the
  video. With **In the video** on, its caption is fetched and embedded as
  `mov_text` beside the untouched picture and sound. The page itself contacts
  neither googlevideo nor youtube.com at any point — checked on the wire.

### The split

`npm run test:split` puts a media host that sends no CORS headers behind a
server that has no ffmpeg and exposes only `/api/resolve` and `/api/tunnel`,
with an access key on both. It proves the client half of the arrangement:

- A link the page cannot make sense of falls through to the server, which names
  the formats; the preview shows the title the server reported.
- An already-merged file comes back **byte-identical through the tunnel**, and
  no media file is ever served to the page's own origin.
- A video-only and an audio-only track are fetched separately and merged on the
  device by ffmpeg.wasm; an HLS ladder the server found is fetched segment by
  segment and remuxed.
- Audio extraction and tagging happen on the device too.
- A **subtitle track the server names is fetched and muxed in** as `mov_text`,
  with the video and audio intact beside it.
- A **playlist becomes a row per video**: three entries, three rows, three
  finished files, and the interface says it will take them one at a time rather
  than promising an archive it cannot build.
- The server is never asked to run a job, the tunnel refuses a request with no
  key, and it refuses a host no resolve ever named.

The server half — the shape `/api/resolve` returns, which formats are dropped,
the client ladder on a bot wall, the headers the tunnel carries and the ones it
strips, range requests, and the access key on both — is covered by the Python
tests. Two of those do not stub yt-dlp at all: they serve a file over a
loopback socket and let the real extractor look at it, which is the only way
the defect below would have been caught.

### What running the real server found

Every test above described the server with a *canned* yt-dlp answer, and that
is exactly how three defects got through. Starting the real service and asking
it to resolve a plain `.mp4` produced, of all things, a paragraph about YouTube
cookies:

- **Unknown codecs were read as absent codecs.** yt-dlp writes `"none"` when a
  track is definitely not there and leaves the field unset when it does not
  know. A direct file comes back with both unset, so the only format there was
  got dropped as codec-less.
- **The empty result then raised a message that was itself a bot-wall marker**,
  which sent the resolve round YouTube's client ladder.
- **The ladder, and the cookie advice at the end of it, applied to every site.**
  Three pointless retries for a link that was never YouTube's, and then advice
  that could not possibly help.

All three are fixed, the codec rule is now a tri-state, the ladder and the
advice are scoped to YouTube hosts by hostname (so `youtube.com.evil.example`
does not qualify), and the loopback tests fail if any of it comes back.

### As deployed

`npm run test:deployed` covers what only happens on a real static host: HTTPS,
where the service worker actually registers, and a `/siphon/` subpath. Among
the 35 checks: a first visit to a host with no API lands on a screen that
works; a first visit to a host that answers `/api/health` recognises your own
server; settings written by the older three-mode version are migrated, each
one to the right helper, with the unrelated preferences intact; a deploy
landing under a returning visitor replaces the old worker and its cache and
renders the new app; with the network cut the shell still opens; and the
settings sheet, driven the way a person drives it — one address, an
unreachable one refused with its reason on screen and the sheet left open, a
siphon server recognised from its address alone with the cookie jar appearing
beside it, all of it surviving a reload, and nothing scrolling sideways at
phone width.

### YouTube, and what is still unproven

The `youtube` job runs the whole thing against the real site on a GitHub
runner. It is informative rather than gating, and running it found three real
bugs in code that had never met the live service: the Node relay forwarded a
`content-encoding` header over a body `fetch` had already decoded, so every
client waited forever for a gzip stream; it streamed POST bodies as
`transfer-encoding: chunked`, which Google's frontends refuse; and the
InnerTube fetch wrapper dropped the library's own request init, sending
`/player` a body with no session context at all. All three are fixed and
covered.

What the job reports now is YouTube's own answer, and on a datacentre IP that
answer is **"Sign in to confirm you're not a bot"** — from hand-built requests,
from youtubei.js driven in Node, and from the browser through the relay alike.
`npm run test:innertube` asks that question directly from whatever machine you
run it on, which is the baseline a red is read against.

**So this is not verified:** a completed YouTube download from the browser
mode. The code is correct up to the wall, checked request by request, but no
machine available here has an IP YouTube will answer. From a home connection —
`node relay/serve.mjs` on your own machine, its address in settings — that is
the case the fix is for, and it is the one measurement still missing.

## Licence

MIT.
