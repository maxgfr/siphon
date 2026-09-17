# What was verified

Every number here comes from a run, and the last section says plainly what is
still unproven.

| suite | what it is | result |
|---|---|---|
| `pytest server/tests` | the server, including two against real yt-dlp on loopback, the per-job yt-dlp options, and the converter vendoring | 158 pass |
| `npm test` | the extractor, the relay, resuming, detection, instance finding, the list refresh and the daily measurement of which instances answer a page, the relay-side walk, the page check, the cobalt measurement, its directories' shapes and the source behind them | 179 pass |
| `npm run test:e2e` | the device alone, real Chromium, two origins; a fake Invidious, a fake Piped and a fake cobalt each carrying a YouTube link; the bundled converter | 48 pass |
| `npm run test:deployed` | the app as a static deploy: HTTPS, subpath, service worker, the chips from the measured list and none when it is empty, an instance whose video endpoint is shut, the yt-dlp options riding with a job, the guide, the site's relay or cobalt instance | 68 pass |
| `npm run test:bridge` | a userscript lifting CORS on a host that refuses | 8 pass |
| `npm run test:split` | a server that only resolves, a device that downloads | 24 pass |
| `npm run test:youtube` | YouTube, for real, from the browser mode in CI — through the relay, Piped, and the bundled Invidious list | informative — see [youtube.md](youtube.md) |
| `npm run test:server` | YouTube, for real, from `server/app.py` in CI — plain, then with the proof-of-origin provider | informative — the `server-youtube` job |

The four gating suites and the two informative ones run on every pull request:
`fast` (the server suite and the unit tests) and `browser` (the four Playwright
suites) gate the merge; `youtube` and `server-youtube` do not, because a runner
is a datacentre IP and whether YouTube answers one on a given day is YouTube's
decision, not this code's. A red there says *look*, never *do not merge* — and
the log says exactly why: every step announces itself, every refusal is printed
with its body.

## The device alone

Finding a public instance is covered with the bundled list, the directories
and the probe all stubbed: that the bundled list is tried first and alone when
one of it answers, that the directories are asked only when it does not, that
a listed address is only used once it has answered for itself, that an
instance listed as offline is never even contacted, that a directory which
changed shape is ignored rather than thrown on, that a siphon server or a relay
appearing in such a list is not mistaken for an instance, that the Invidious
directory's `[name, details]` pairs are read with onion, API-less and CORS-less
entries left out, that cobalt's directory is read in every shape it has had
and its source repository behind it, and that the number of strangers
contacted on a first visit is capped — and spread across the directories, so a
long cobalt list cannot crowd the YouTube-only kinds out of that budget.
Detection is covered for every kind, including an Invidious instance whose
stats endpoint is switched off — the default — which is then known by the one
sentence it refuses with. The replica walk is pinned with a stubbed network: a
bot-walled instance leads to the next ones and the answer names the one that
delivered, a private video stops at the first, the walk is capped, and the
error after a full walk says how many were tried. The refresh script is
covered against a fixture of the API's pairs and one of the docs page's
markup, Piped's directory and its seed; and its measurement against a fake
internet of instances — one open, one refusing the video endpoint, one
answering it without the cross-origin header, one whose proxy will not
stream, a keyed cobalt — with each verdict said and only the open ones
kept, with their kind. The measured list is probed first by the search, and
the file beside the app is read whole: the lists, the measured ones of a
usable kind, the date.

The unit tests cover what needs no network: HLS attribute and playlist parsing,
byte-range continuation, IV derivation, YouTube URL shapes, page-scraping
precedence, the whole preset → format decision table, and the InnerTube fetch
wrapper. The relay is in there too — `relay/worker.js` is a plain module with a
`fetch(request, env)` export and nothing Workers-specific inside, so `node
--test` calls it directly with a stubbed upstream.

`npm run test:e2e` then drives a real headless Chromium with the app on one
origin and the media on another, so the CORS path under test is the real one:

- A progressive MP4 arrives byte-identical to the source, and the 32 MB
  converter is never requested — verified on the wire, not assumed.
- The converter is loaded from the app's own origin with nothing configured —
  the requests to `/app/vendor/ffmpeg/` are counted on the wire — and the
  deployed suite checks the default resolves under the `/siphon/` subpath.
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
  network stubbed.
- A finished row survives a reload with its Save button intact, because the
  file is in OPFS.
- **An Invidious instance carries YouTube.** A fake one speaking the real API —
  `/api/v1/stats` naming the software, `/api/v1/videos/{id}` with numbers as
  strings and media paths relative to the instance, `/videoplayback`, WebVTT at
  `/api/v1/captions` — is typed into the settings sheet, recognised from the
  address alone, and named in the header and the privacy line. A YouTube link
  is then resolved by it with `local=true` (the only form a page can fetch),
  the file arrives through its proxy byte-identical, and is named after the
  video. With **In the video** on, its caption is fetched and embedded as
  `mov_text` beside the untouched picture and sound.
- **A Piped instance carries YouTube** the same way: `/config` naming an image
  proxy, `/streams/{id}` with every media URL rewritten through the instance's
  own proxy. Recognised, and — because this one does — said to answer this
  page for a video; the file arrives through the proxy byte-identical.
- **A cobalt instance is asked for the finished file**: recognised from its
  root, a direct file still downloads on the device rather than through it,
  a YouTube link is POSTed with the quality asked for, and the file arrives
  from the instance's tunnel under the name it gave, byte-identical.
- In every instance case the page itself contacts neither googlevideo nor
  youtube.com at any point — checked on the wire.

The settings sheet, the guide and the site's own config are driven in the
deployed suite, in a real browser over HTTPS under a `/siphon/` subpath with
the service worker actually registered: a first visit to a host with no API
lands on a screen that works; a first visit to a host that answers
`/api/health` recognises your own server; settings written by the older
three-mode version are migrated; the measured list becomes chips with the date it was
measured, tapping one fills the address in and tests it, and on a day none
answered there is no chip and no Find, only the field and a sentence saying
so; an unreachable address is refused with
its reason and the sheet left open; **an Invidious instance whose video
endpoint is shut is recognised and then said to be shut, with an amber light,
before anyone saves it**, and every status names the address it is about, so
two instances never read the same; a siphon server is recognised from its
address with the cookie jar appearing beside it; **the Advanced section's
yt-dlp options** are live with a server set, greyed and kept with none, and
what is typed there — SponsorBlock, a clip, a speed limit, a client — rides
with the job the page posts, in the server's vocabulary, and survives a
reload; a first visit on a site whose owner set
`SIPHON_RELAY_URL` takes the relay with nothing to do, is told whose it is,
and the header says "relay for YouTube"; a measured cobalt instance in
`config.json` is adopted when there is no relay and named as public; the guide
is on the first screen, says what is set and what would make YouTube work,
stays closed once closed, and comes back from the ? in the header; a visitor
who cleared the helper is not handed it again; a deploy landing under a
returning visitor replaces the old worker and its cache; with the network cut
the shell still opens; and nothing scrolls sideways at phone width. Nothing is
contacted off the machine in any of it.

## The split

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
loopback socket and let the real extractor look at it.

## What running the real server found

Every Python test once described the server with a *canned* yt-dlp answer, and
that is exactly how three defects got through. Starting the real service and
asking it to resolve a plain `.mp4` produced, of all things, a paragraph about
YouTube cookies:

- **Unknown codecs were read as absent codecs.** yt-dlp writes `"none"` when a
  track is definitely not there and leaves the field unset when it does not
  know. A direct file comes back with both unset, so the only format there was
  got dropped as codec-less.
- **The empty result then raised a message that was itself a bot-wall marker**,
  which sent the resolve round YouTube's client ladder.
- **The ladder, and the cookie advice at the end of it, applied to every site.**

All three are fixed, the codec rule is a tri-state, the ladder and the advice
are scoped to YouTube hosts by hostname (so `youtube.com.evil.example` does not
qualify), and the loopback tests fail if any of it comes back.

## The bridge

`npm run test:bridge` proves the userscript against a media host that sends
**no** CORS headers: without the bridge the page is refused, exactly as by
YouTube; with the shipped userscript injected and `GM_xmlhttpRequest` played by
a Node fetch — which has no same-origin policy, like the real thing — a direct
file arrives byte-identical, an HLS ladder is fetched and remuxed, and a page is
scraped and converted to MP3.

## YouTube, and what is still unproven

The `youtube` job runs the browser mode against the real site on a GitHub
runner. Running it found three real bugs in code that had never met the live
service: the Node relay forwarded a `content-encoding` header over a body
`fetch` had already decoded, so every client waited forever for a gzip stream;
it streamed POST bodies as `transfer-encoding: chunked`, which Google's
frontends refuse; and the InnerTube fetch wrapper dropped the library's own
request init, sending `/player` a body with no session context at all. All
three are fixed and covered.

What the job reports now is YouTube's own answer to a datacentre IP, quoted in
[youtube.md](youtube.md): "Sign in to confirm you're not a bot" from every
client, and every public Invidious instance refusing the video endpoint to a
page. `npm run test:innertube` asks the first question directly from whatever
machine you run it on, which is the baseline a red is read against.

The `server-youtube` job runs `server/app.py` against the same video on the
same kind of runner, plain and then with the proof-of-origin provider beside
it, and its log says what yt-dlp said client by client. That is the
measurement for the README's first recommendation, made on every pull request.
Its first runs (2026-09-16, quoted in [youtube.md](youtube.md)) found the
runtime present, the provider answering, and YouTube refusing every client
with *Sign in to confirm you're not a bot* — the datacentre-IP case, where
cookies are the lever a runner does not have. Reading yt-dlp's own lines in
that log is also what found the missing JavaScript runtime in the image.

**So this is not verified:** a completed YouTube download from the browser
mode on a datacentre IP. The code is correct up to the wall, checked request by
request. From a home connection — the bridge, or `node relay/serve.mjs` on
your own machine — that is the case the code is written for, and the one
measurement a runner cannot make.
