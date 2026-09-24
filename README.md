# siphon

Paste a link, pick a quality, get the file. It runs in your browser: nothing to
install on the phone, and for most links nothing to run anywhere. For the
links a web page is not allowed to read — YouTube above all — it works with
one thing you point it at: an instance someone else runs, a relay you deploy
in a click, or your own yt-dlp server.

## Four ways to use it

| | what you need | YouTube | best for |
|---|---|---|---|
| **1. The page alone** — [maxgfr.github.io/siphon](https://maxgfr.github.io/siphon/) | nothing | through an Invidious, Piped or cobalt instance you paste in settings — or the bridge, a userscript | direct files, HLS streams, pages that declare their video; phones |
| **2. Your own server** | one `docker run` on any machine you own | yes — the most capable: every site yt-dlp knows, playlists, subtitles, your cookies | everything, and anything that needs your identity |
| **3. A quick deploy** | one click: a relay on Cloudflare, or the server on Render or Fly | yes | a phone, from anywhere, with no machine at home |
| **4. Public servers** | nothing | whatever the daily measurement found working today | a chance, not a plan — see below |

The same page serves all four: it takes one optional address in settings and
works out what is behind it. Nothing is ever chosen for you silently — the
header names what is in use, and the guide behind the **?** says what YouTube
needs right now.

## 1. The page alone

1. **Open the page.** On a phone, add it to the home screen — it installs as
   an app and as a share target.
2. **Paste a link.** Tap **Paste**, or share a link straight into the app.
3. **Pick a quality, tap Download.** Fetching, merging, converting and tagging
   happen on your device. Nothing is uploaded; no link leaves it.

The extractor runs in the page: it reads the link, parses the HLS ladder, picks
a rendition for the quality you asked for, downloads and decrypts the segments,
and when a file has to be merged or converted it loads
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) — deployed beside the
app, fetched only when a job needs it — and does that here too. It covers what
the web serves media as, rather than one site at a time:

- a direct `.mp4`, `.webm`, `.m4a`, `.mp3` — the file is the link; a
  download link with no extension, sent as `application/octet-stream`, is
  known by the name it is sent under or by its first bytes
- an `.m3u8` HLS stream, including AES-128 encrypted ones, remuxed to MP4
- a page whose markup declares its video: `og:video`, `<video src>`,
  `<source>`, a JSON-LD `VideoObject`'s `contentUrl`, or an `.m3u8` in inline
  JSON
- MP3 and M4A extraction from any of the above, tagged and with cover art;
  from an HLS stream it takes the audio-only rendition, or the lightest one

A progressive MP4 at the quality you asked for is handed over exactly as it
arrived, streamed straight to disk, so the common case costs no conversion;
so is an `.mp3` asked for as MP3, which keeps its own tags.
A download that breaks resumes where it stopped rather than starting over.

### YouTube from the page alone: an external instance

A browser will not let a page read a response the host did not offer it, and
YouTube offers none — its API sends no cross-origin headers and its media
servers allow only youtube.com. That is the browser's rule, not a bug to
route around ([why, with the research](docs/youtube.md)). What *does* answer a
page is one of the open-source projects that put a server in front of
YouTube, and any public instance of them is one address away:

- **An [Invidious](https://github.com/iv-org/invidious) or
  [Piped](https://github.com/TeamPiped/Piped) instance.** Paste its address
  into **Settings → Helper**. The instance is asked for the video's streams
  and hands back URLs through its own proxy — the only kind a page can fetch
  — and the device downloads, merges and converts as for any other link; its
  subtitle tracks come along too. The instance sees the video id and nothing
  else.
- **A [cobalt](https://github.com/imputnet/cobalt) instance.** The instance
  does the whole download and streams the finished file back; the page needs
  nothing more from the media host.

You never pick a kind: **Test** probes the address and says what it is. For
an Invidious or Piped instance it also asks the one question that matters —
whether the instance will answer *this page* for a video — and says so with
a green or an amber light before you save. That matters because most public
instances now keep the video endpoint shut to other apps to survive YouTube's
blocking; the stats endpoint that names them still answers everyone.

**What the sheet offers is measured, not assumed.** `.github/workflows/instances.yml`
runs `scripts/instances.mjs` daily on a machine with real network: it reads
the lists the projects publish (Invidious's [own](https://docs.invidious.io/instances/),
Piped's [directory](https://piped-instances.kavin.rocks/), the opt-in list
behind [cobalt.directory](https://cobalt.directory/)), then asks every
instance exactly what this page asks — the video endpoint with an `Origin`
header, then the first bytes of the media it names — and writes the ones that
answered into `web/instances.json` as `open`. Those are the chips in settings.
On a day none answered there are no chips, only the field for an address you
know and a sentence saying so with the date: offering an instance that will
refuse would look like a broken app. **Find a public instance** is always
there: it asks the Invidious project's own directory,
[api.invidious.io/instances.json](https://api.invidious.io/instances.json),
keeps the entries whose `api` field is `true`, and tests each one as the
page would — then the day's list beside the app, then the other projects'
directories. **Nothing is set by default:** a first visit is this device
only, and an instance is something you pick and see named, never something
picked for you. When the instance in use stops answering mid-download, the
next few from the list are tried inside the same job, naming the one that
delivered.

**The measured state of it:** on 2026-09-17, the first full run asked 7
Invidious, 5 Piped and 12 cobalt instances, and none answered a page for a
video — the Invidious ones keep the endpoint shut or send no cross-origin
header, the Piped ones sit behind a challenge or YouTube's bot wall, and every
public cobalt wants a key or reports YouTube demanding a login. The path is
real, tested end to end against instances speaking the real APIs, and offered
honestly: a public instance that answers a page is a find, not a plan.
[docs/youtube.md](docs/youtube.md) quotes every line of every measurement.

### No server anywhere: the bridge

A userscript manager (Tampermonkey, Violentmonkey) is itself an extension with
host permissions, and it lends them to scripts. [`bridge/siphon-bridge.user.js`](https://github.com/maxgfr/siphon/raw/main/bridge/siphon-bridge.user.js)
is one script that runs only on siphon's page and fetches on its behalf, so
every extractor already here — direct, HLS, pages, YouTube through
youtubei.js — works on hosts that refuse the page. Install it once, from
that link: the manager opens its install page for it, and checks the same
address for updates. The app then uses it automatically, ahead of any
helper. Desktop Chrome and Firefox, and Firefox for Android. In Chrome, open
the manager's extension details and turn on **Allow User Scripts** as well:
until it is on, Chrome runs no userscript at all, and the page carries on
as if there were no bridge. It runs on your IP, which YouTube treats far
more gently than a datacentre's. It fetches public http(s) addresses only,
with GET, HEAD or POST — never this machine or your network — because its
`localhost:8000` match cannot tell siphon from anything else served on that
port.

A userscript manager hands a response over only once all of it has arrived,
so the page asks the bridge for a file a few megabytes at a time: the bar
moves, the file still goes to disk as it comes, and a broken connection costs
one piece rather than the whole file. Version 1.2 of the script also stops the
transfer when you cancel, and reports where a redirect landed, which a
playlist's relative addresses depend on; update it if yours is older.

## 2. Your own server, with yt-dlp

The most capable way, and the one every other route falls back to. One
command, nothing to clone:

```sh
docker run -d --name siphon --restart unless-stopped -p 8000:8000 -v siphon:/tmp/siphon ghcr.io/maxgfr/siphon
```

Open `http://localhost:8000`. The image serves the interface *and* the API
from one origin, so there is no CORS and nothing else to deploy; it is
published for amd64 and arm64, so the same command works on an Apple Silicon
Mac or a Raspberry Pi. Every push is also tagged with its short commit sha.
The `siphon` volume is where the downloads and an uploaded cookie jar live,
and the name is what the update below finds the container by. The restart
policy brings it back after a reboot; with a name, the same command run
again would be refused, and `docker start siphon` is what starts a stopped one.

Or use the hosted page and point it at the machine you are sitting at: open
[the page](https://maxgfr.github.io/siphon/), **Settings → Use this
computer**, Save. Browsers treat `localhost` as a secure context, so the
HTTPS page may call it; Chrome's private-network preflight is answered.
Verified in a real browser. Newer Chrome also asks you, once, whether the
page may reach apps on this device — its local network access permission:
allow it, or the page cannot reach the server. `ALLOWED_ORIGINS` names that
page by default and nothing else, so another site open in the same browser
is refused — name your own page there if you host a copy.

`docker compose up -d` does the same, with somewhere obvious to put
`AUTH_TOKEN`. To build from source:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### From your phone

- **Same Wi-Fi.** The address is the computer's own on your network with the
  port, something like `http://192.168.1.42:8000`. **Settings → Test** on the
  computer prints it when the server can tell. In Docker it cannot, since the
  container sees only its own bridge network, so Test gives the port and an
  example address and asks for `LAN_URL`. Set `LAN_URL` to the address and
  Test names it exactly. Open it in the phone's browser and download as you
  would on the computer; a bookmark brings it back. It will not install as
  an app from there: plain `http` is a secure context only on `localhost`,
  so the phone gets no service worker, no share target, and a **Paste**
  button that only focuses the field. The share
  sheet — a link from the YouTube app in two taps — needs HTTPS: install
  [the hosted page](https://maxgfr.github.io/siphon/) and set its helper to
  an HTTPS address for this machine, the tunnel below or
  [Tailscale](https://tailscale.com)'s `tailscale serve`. On installed iOS
  the finished file is offered as a link to tap, since a home-screen app
  there has no download manager.
- **From anywhere, still on your machine.** A Cloudflare quick tunnel needs
  no account and no router settings:

  ```sh
  docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
  docker compose -f docker-compose.yml -f docker-compose.tunnel.yml logs cloudflared | grep trycloudflare.com
  ```

  It is a **public** URL: set `AUTH_TOKEN` first and paste the same value
  into the app's settings; the address changes on every restart. A mesh VPN
  ([Tailscale](https://tailscale.com), [NetBird](https://github.com/netbirdio/netbird),
  [ZeroTier](https://github.com/zerotier/ZeroTierOne), plain WireGuard)
  keeps it private instead. Forwarding a router port works but is the option
  to reach for last.
- **A deployed server** — way 3 below — needs no machine at home, at the
  price of a datacentre IP, which YouTube treats with far more suspicion.

### Making YouTube work on the server

YouTube turns anonymous downloads away with *"Sign in to confirm you're not a
bot"*. The server works through that in three steps, and you only reach for
the next one if the previous fails:

1. **The client ladder — automatic.** A bot wall is retried against another
   of YouTube's clients (`tv`, `web_safari`, `android_vr`…), yt-dlp's own
   default first; only bot walls retry, a private video fails at once. The
   row says *"Retrying — YouTube asked for a login"* rather than resetting
   the bar.
2. **Your cookies.** Export `cookies.txt` from a browser where you are signed
   in (any Netscape-format extension) and upload it in **Settings → YouTube
   sign-in**. The jar is written owner-only and never readable back; a JSON
   export is refused rather than stored. Only upload it to a server you
   control, and consider a throwaway account.
3. **A proof-of-origin provider.** Some clients want a token minted by
   YouTube's own JavaScript. The community provider runs as a sidecar:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.potoken.yml up -d
   ```

   The plugin is already in the image; the overlay starts the provider and
   points siphon at it. Every later compose command needs the same `-f`
   files: a bare `docker compose up -d` brings siphon back without the
   provider. Name them once in a `.env` beside the compose files and every
   command without `-f` reads them (`;` between them on Windows):

   ```sh
   echo COMPOSE_FILE=docker-compose.yml:docker-compose.potoken.yml >> .env
   ```

   An explicit `-f` replaces `COMPOSE_FILE`, so the tunnel and build
   commands above would bring siphon back without the provider: put every
   overlay you use in it instead, for example
   `COMPOSE_FILE=docker-compose.yml:docker-compose.potoken.yml:docker-compose.tunnel.yml`,
   and run those commands without their `-f`.

If all three fail it is almost certainly the IP: datacentre ranges get the
strictest treatment, which is why your own machine is the first option here.
And check the version: yt-dlp is what YouTube breaks, and it releases about
monthly, so the image is rebuilt every Monday with the newest one, and
taking it is the whole update. Started with compose, that is
`docker compose pull && docker compose up -d`, run with the files you
started with, by `-f` or by the `COMPOSE_FILE` of step 3, or an overlay
drops out. Started with the one command at the top, it is
`docker pull ghcr.io/maxgfr/siphon && docker rm -f siphon && docker run -d --name siphon --restart unless-stopped -p 8000:8000 -v siphon:/tmp/siphon ghcr.io/maxgfr/siphon`,
with any `-e` you gave it the first time; the volume keeps the cookies. A
server started before that command named its container has another name,
which `docker ps` shows: remove that one instead.
**Test** in settings shows the running version and says when it is more
than 45 days old. Running the server outside the image? yt-dlp has needed a
JavaScript runtime for YouTube since late 2025 (it solves the signature
challenge with YouTube's own player script); the image ships
[Deno](https://deno.com), and **Test** in settings says when a server has
none. The `server-youtube` job measures
this path on every pull request, from a runner, plain and with the provider;
what it found on 2026-09-16 is that a datacentre IP with the runtime and the
provider is still refused on every client until there is a session — the
cookies of step 2 ([the log](docs/youtube.md#the-server-itself-yt-dlp-on-a-runner)).

### The server also resolves for the device

A server exposes two small endpoints beside the full job API: `POST
/api/resolve` runs yt-dlp's extractor and hands back the formats, and `GET
/api/tunnel?url=…` carries the bytes of a URL a resolve just named, for hosts
that refuse a page. A server **with** ffmpeg takes the whole job; a server
**without** — or one you run thin — resolves, and the device downloads, merges
and converts. The tunnel only fetches hosts a recent resolve produced, with
the headers that resolve named. A redirect is followed only to a public
address, and a cookie or key granted to one host never follows it to
another. The host a redirect lands on is carried too, with none of the first
host's credentials, since a playlist's segments are fetched from where it
landed. What keeps strangers' pages off it is `ALLOWED_ORIGINS` and the
key, as for the rest of the API; the key a file link carries in its query
is kept out of the server's access log.

### Configuration

The app has two settings, both optional: the **helper** address and its
**access key** if it wants one. An address typed without a scheme gets
`https://`, or `http://` for `localhost` and an address on your own network
(`192.168.…`, `10.…`, a `.local` name), which is how a server there answers.
The key belongs to the address it was typed for: type an address on another
origin and the field empties, so the key is not sent to a stranger's
instance; type the first one back and the key returns. **Test** names the
address and says what it is, and for an Invidious or Piped instance whether
it answers this page for a video, before you save. Under **Advanced** are
yt-dlp's options, applied by your own server to every download it makes, and
checked on Save the way the server reads them, so a slip is shown beside the
field rather than failing every download after it.
With any other helper they are kept, greyed, until one is set, and so they
are on a server without ffmpeg, which only resolves and leaves the download
to this device:

| option | what it does |
|---|---|
| **Remove sponsor segments** | cuts sponsors, self-promotion and "like and subscribe" out of YouTube videos, from the community's [SponsorBlock](https://sponsor.ajay.app) data |
| **Clip** | only the part between two times, as `1:23`, `01:02:03` or seconds, `150`; only that span is fetched, re-encoded so it starts and ends exactly there, with the subtitles and chapters moved to match |
| **Speed limit** | bytes per second, as `500K` or `2M`; not applied to a clip, a live stream or HLS only ffmpeg reads, which ffmpeg fetches and yt-dlp does not slow down |
| **YouTube client** | which of YouTube's clients to try first; the ladder still follows. A client the server's yt-dlp no longer has counts as no choice |
| **YouTube sign-in** | your `cookies.txt`, stored on the server owner-only — step 2 of *Making YouTube work* above |

Each value is narrowed by the server before it reaches yt-dlp — a number, a
name off a list — so the API is a short vocabulary, not a way to pass
arbitrary options. ffmpeg.wasm needs no setting: the converter is deployed
beside the app.

The server takes environment variables:

| variable | default | what it does |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://maxgfr.github.io` | Comma-separated origins allowed to call the API from another origin; a page's full address is read as its origin, the only part a browser sends. The server's own page needs no entry. Name your page if you host a copy; `*` without `AUTH_TOKEN` lets any site open in your browser use the server, and the server says so at startup. |
| `AUTH_TOKEN` | *(unset)* | Shared secret. **Set it the moment the server is reachable from the internet.** Paste the same value into the app's settings. The server warns at startup without one. |
| `MAX_CONCURRENT_JOBS` | `3` | Downloads running at once. |
| `JOB_TTL_SECONDS` | `3600` | How long a finished file stays on disk. Swept on a timer, and what a previous run left is swept at startup. |
| `DOWNLOAD_DIR` | system temp | Where files land while you fetch them. |
| `COOKIES_FILE` | inside `DOWNLOAD_DIR` | Where the uploaded YouTube session is kept. Put it on a volume. |
| `POT_PROVIDER_URL` | *(unset)* | The proof-of-origin provider, e.g. `http://potoken:4416`. |
| `PLAYLIST_LIMIT` | `50` | Most items one playlist download will fetch. |
| `TUNNEL_HOST_TTL` | `7200` | Seconds a host named by a resolve stays fetchable through the tunnel. |
| `ALLOW_PRIVATE_HOSTS` | off | Lets the server fetch from LAN addresses (a NAS). Off by default: on, the service is an SSRF probe for whoever can reach it. |
| `PORT` | `8000` | Listen port. |
| `LAN_URL` | *(unset)* | The address **Test** tells you to open on a phone, e.g. `http://192.168.1.42:8000`. Without it the server names its own network address, if it is listening there. It names nothing in a container, behind a proxy or over HTTPS. |

By default the server refuses anything that is not a public `http(s)`
address — no `file://`, no `localhost`, no `10.x`, no `100.64/10`, no
`169.254.169.254`. It checks the link you give it, every format it is about
to download, and — for every connection the process opens, redirects
included — the address the connection actually goes to. ffmpeg, which
fetches a clip, a live stream and HLS yt-dlp cannot read itself, opens
connections of its own, so it is pointed at a proxy inside the server that
makes the same check for each one, every redirect included. It may speak
http(s) there and nothing else: no `file://`, and a stream in rtmp or rtsp
is refused. The provider and a proxy you configure are reachable on the
port they are named with, and no other. Behind an `HTTP(S)_PROXY`, though,
the proxy makes the connections, so past the link and its formats it is the
proxy that has to refuse private addresses; and since ffmpeg can go through
only one of the two proxies, what only ffmpeg fetches — a clip, a live
stream — is refused there. `ALLOW_PRIVATE_HOSTS` lifts the address checks,
and ffmpeg then connects directly. Qualities are an allow-list and subtitle
languages are codes, not patterns, so the API cannot smuggle yt-dlp options.

## 3. A quick deploy

Nothing at home, a phone anywhere, about a minute each.

**A free relay — the lightest.** One file that adds the missing cross-origin
header and forwards nothing else. The extraction still runs in your browser,
so there is nothing to update when YouTube changes and nothing to store.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/maxgfr/siphon/tree/main/relay)

Paste the `*.workers.dev` address into **Settings → Helper**. Add
`ALLOWED_ORIGINS` to the Worker as a **Secret** (Settings → Variables and
Secrets), which no later deploy can drop, set to your page's origin
(`https://you.github.io`, no path) so nobody else spends your quota.
`ALLOWED_HOSTS` keeps it from being an open proxy. With a relay set, the
bundled Invidious list is walked through it first — the instances refuse a
*page*, not a plain client — and InnerTube through the relay is the fallback.
`node relay/serve.mjs` runs the same file on your own machine with no account,
on your home IP, for the browser on that machine: the page is HTTPS, and a
browser lets it call plain http on `127.0.0.1` only, so a phone needs the
Worker. Details in [`relay/`](relay/).

**Running the site for others?** Deploy the relay once and set the repository
variable `SIPHON_RELAY_URL` to its address (Settings → Secrets and variables
→ Actions → Variables). The Pages deploy writes it into `web/config.json`,
with `https://` in front if it has no scheme, and every visitor with nothing
set gets it as their helper, named on screen, clearable in one tap.

**The whole server, hosted.** Render reads `render.yaml`, builds the
container and generates an `AUTH_TOKEN` for you; copy it from the dashboard
into the app's settings with the URL. The free plan sleeps after 15 idle
minutes and has no disk that survives it, so YouTube cookies uploaded in
settings last until the first sleep. For cookies that stay, use Fly below,
whose volume keeps them, or a paid Render plan with the disk `render.yaml`
has commented out.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/maxgfr/siphon)

```sh
# or Fly, which does not sleep the same way
fly launch --no-deploy
TOKEN=$(openssl rand -hex 16); echo "Access key: $TOKEN"
fly secrets set AUTH_TOKEN="$TOKEN"
fly deploy
```

Paste the key the second line prints into the app's settings: once it is
set, Fly shows a secret's digest, never its value.

A hosted server runs on a datacentre IP, so it meets YouTube's bot wall more
often than the same code at home. Cookies are the answer there — the
provider above is a compose sidecar, which neither `render.yaml` nor
`fly.toml` runs — and the [measurement](docs/verified.md#youtube-and-what-is-still-unproven)
says what a bare runner gets.

**Your own copy of the page.** Enable Pages once by hand (Settings → Pages →
Source → *GitHub Actions*; the workflow's token cannot create the site), and
`.github/workflows/pages.yml` publishes `web/` on every push to `main`, with
the converter vendored beside it. Point the page at your server in settings
and set `ALLOWED_ORIGINS` on the server to the page's origin
(`https://you.github.io`, no path).

## 4. Public servers, measured daily

`web/config.json` is what a fresh visitor starts from, and
`.github/workflows/relay-config.yml` decides what goes in it — from a runner
with real network, by asking each candidate exactly what the page asks, with
the page's own Origin: `https://<owner>.github.io` for the repository it runs
in, or the repository variable `SIPHON_ORIGIN` for a custom domain, so a relay
locked to your page is measured as your page reaches it:

- **relays**: your own (`SIPHON_RELAY_URL`) first, then the public CORS
  proxies — fetch `youtube.com/robots.txt` for a page, then an Invidious
  instance's video endpoint through it, then the first 64 KB of that
  instance's media through it;
- **cobalt instances**: the directory at [cobalt.directory](https://cobalt.directory/)
  (and, behind its browser challenge, the opt-in list its
  [repository](https://codeberg.org/hyperdefined/cobalt.directory) keeps at
  `backend/instances`) — each instance listed as up for YouTube is sent the sample link as
  the app would send it, and the first whose tunnel streams bytes is kept.

The first that passes is written in and Pages redeploys; nothing passing
leaves the file empty. Only the relay is taken up by a visitor with nothing
set: a cobalt instance found this way is recorded for the guide and the
measurement, never adopted — a public instance is a stranger's server that
sees every link routed through it, so it is something you pick in settings,
where it is named, and never something picked for you.

**Today's answer is empty.** Not one public proxy carried the page's requests,
and the 12 cobalt instances on the opt-in list are keyed, refuse a runner, or
report YouTube demanding a login; the log of every attempt is quoted in
[docs/youtube.md](docs/youtube.md). The measurement keeps running in case
that changes; it is not the plan. The paths that are not refused are the ones
that are yours: the bridge, the relay, the server.

## What else it does

- **A queue.** Paste, tap, and the box clears for the next link; one typed
  without `https://` is taken with it. Each download
  is a row with its own progress; several run at once; rows survive a reload,
  and a server that does not answer for a moment then is asked again rather
  than given up on. Cancel stops a row where it is, a conversion on the device
  included. The list holds 20 rows: the oldest finished one makes room for a
  new one, never one still running. Saving settings, a new helper included,
  leaves a running download to finish. More links than your server takes at
  once wait their turn rather than fail. Closing or reloading the page while
  a download runs on this device asks first, where the browser allows it:
  that download lives in the tab. A row changes in place as it moves,
  so a keyboard or a finger on its button stays there, and a screen reader
  is told when a download is ready or has failed.
- **Away from your server.** With your own server set and out of reach —
  away from home, the tunnel down — a link this device can read itself is
  downloaded on it instead, and its row says so.
- **Several links at once.** Paste a whole list, drop a selection of links on
  the page, or share a message full of them: each becomes its own row, in
  order, at the quality chosen. `Ctrl+V` with nothing focused lands in the
  field too, and "Title https://…" from a share — pasted into the field, or
  put in whole by the keyboard — becomes just the link.
- **Send to siphon.** A bookmarklet in the guide: drag it to the bookmarks
  bar, and on any video page one click opens the app with that page's link —
  the desktop counterpart of the phone's share sheet.
- **Resume.** A connection that dies at 80% is picked up from 80%. A refusal —
  a 404, a private video — is not retried, because repeating it would only
  make the same answer arrive later. A row's **Try again**, once a download
  has failed, starts it over.
- **Subtitles.** Off, embedded, or as separate `.srt` files beside the video
  (the last needs your server). Auto-generated captions are included; the
  languages are a preference list, so `fr,en` offered only Japanese gets
  Japanese rather than nothing.
- **Playlists.** Offered, never assumed: a video inside a playlist stays one
  video unless you tap **All**, and **This one** of a link that is only a list
  is its first video. A full server delivers one `.zip`, numbered in
  playlist order; the device takes them one row each, a YouTube playlist or
  channel through your server. `PLAYLIST_LIMIT` caps it.
- **Tagged audio.** MP3 and M4A carry title, artist, date and cover art; an
  `.mp3` link taken as MP3 is not converted, and keeps the tags it came with.
  Video keeps its metadata and chapters.

What the device alone does not do: record a live stream, subtitles for a
link that offers none, cookies (nowhere safe to put them), sites that build
their player in JavaScript (yt-dlp has a hand-written extractor for each; the
page has four general ones), and converting a file above half a gigabyte
without warning you first — ffmpeg.wasm wants the whole input in memory.

## Development

```sh
pip install -r server/requirements.txt pytest httpx       # yt-dlp[default] carries the signature solver
# and a JavaScript runtime beside it — Deno — which yt-dlp needs for YouTube since late 2025;
# the Docker image ships one, and the settings sheet says when a server has none.
WEB_DIR=web uvicorn server.app:app --reload --port 8000   # the server; add --host 0.0.0.0 to open it from a phone
pytest server/tests -q                                    # the server, and the deploy commands in these docs
npm test                                                  # the extractor, detection, the measurements
npm run test:e2e        # the device, a fake Invidious, Piped and cobalt; needs playwright, ffmpeg
npm run test:deployed   # the app as a static deploy over HTTPS; needs playwright, openssl
npm run test:bridge     # the userscript against a host that refuses
npm run test:split      # a server that only resolves, a device that downloads
npm run test:innertube  # what YouTube says to a bare request from this machine
npm run test:youtube    # YouTube, for real, from the browser mode; CI, informative
npm run test:server     # YouTube, for real, from server/app.py; CI, informative
```

`fast` and `browser` gate every merge; `youtube` and `server-youtube` are
informative. The frontend has no build step: plain ES modules, no framework.
`package.json` carries only the test tooling. Tests live in `tests/`, not under
`web/`, because the Pages workflow publishes that whole directory.

| file | what it is |
|---|---|
| `web/app.js` | the screen, the queue, the settings sheet, the guide |
| `web/api.js` | the one backend; the server and cobalt clients |
| `web/inbrowser.js` | the device backend — jobs, HLS assembly, decryption |
| `web/extract.js` | what a link is, and what to download for a preset; the Invidious and Piped resolvers |
| `web/net.js` | fetching under CORS: direct, the bridge, the relay or tunnel |
| `web/endpoint.js`, `web/instances.js` | what an address is; finding a public instance |
| `web/media.js`, `web/ffmpeg-worker.js` | ffmpeg.wasm, loaded on demand |
| `server/app.py` | the yt-dlp server: jobs, resolve, tunnel, cookies |
| `relay/worker.js` | the relay, for Cloudflare Workers or Node |
| `bridge/siphon-bridge.user.js` | the userscript |
| `scripts/` | the daily measurements and the converter vendoring |

Every claim above is checked in [docs/verified.md](docs/verified.md); the
research and the measurements behind the YouTube sections are in
[docs/youtube.md](docs/youtube.md).

## Licence

MIT.
