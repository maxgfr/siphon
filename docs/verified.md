# What was verified

Every claim here is checked by one of these suites, and the last section says
plainly what is still unproven. How many checks each suite makes is what the
suite prints when it runs, and nowhere else: this file and the README used to
repeat the counts, and fell behind them.

| suite | what it is | in CI |
|---|---|---|
| `pytest server/tests` | the server, including two against real yt-dlp on loopback, the per-job yt-dlp options, the sweep that leaves a running job alone, the tunnel's answer for an upstream it cannot reach and where its redirects ended, clip times typed as plain seconds, the converter vendoring, and the deploy commands the README and the deploy files give — the Fly steps run against a stub, the compose ones checked against the files they read, the Pages deploy's owner relay run as the workflow runs it, the README's `docker run` held to the guide's and its volume to the image's, the update given for both ways of starting the server, every link to the bridge the script itself | gating — `fast` |
| `npm test` | the extractor, the relay and where its redirects ended, resuming, detection, instance finding, the list refresh and the daily measurement of which instances answer a page, the relay-side walk, the page check, the cobalt measurement, its directories' shapes and the source behind them, the links in a pasted or dropped text, the age of a server's yt-dlp, the owner's relay given its `https://` or refused before it is measured, the access key checked before an address is saved, YouTube behind a tunnel answered by the server rather than by the tunnel's refusal, and the service worker's shell holding every module the app loads | gating — `fast` |
| `npm run test:e2e` | the device alone, real Chromium, two origins; a fake Invidious, a fake Piped and a fake cobalt each carrying a YouTube link; a pasted list of links; the bundled converter | gating — `browser` |
| `npm run test:deployed` | the app as a static deploy: HTTPS, subpath, service worker, the chips from the measured list and none when it is empty, an instance whose video endpoint is shut, the yt-dlp options riding with a job, the guide and its bookmarklet, a dropped link, a paste with nothing focused, the site's relay taken and a cobalt instance in config.json left alone, Find offered on a day the measured list is empty | gating — `browser` |
| `npm run test:bridge` | a userscript lifting CORS on a host that refuses, a window at a time, cancelled and redirected | gating — `browser` |
| `npm run test:split` | a server that only resolves, a device that downloads | gating — `browser` |
| `npm run test:youtube` | YouTube, for real, from the browser mode in CI — through the relay, Piped, and the bundled Invidious list | informative — see [youtube.md](youtube.md) |
| `npm run test:server` | YouTube, for real, from `server/app.py` in CI — plain, then with the proof-of-origin provider | informative — the `server-youtube` job |

The four gating suites and the two informative ones run on every pull request:
`fast` (the server suite and the unit tests) and `browser` (the four Playwright
suites) gate the merge; `youtube` and `server-youtube` do not, because a runner
is a datacentre IP and whether YouTube answers one on a given day is YouTube's
decision, not this code's. So the measurement step tolerates its own failure
and the job stays green: the step's red cross and the job summary say what
YouTube answered, and the log says exactly why — every step announces itself,
every refusal is printed with its body — without the commit on `main` being
marked red for an answer that is YouTube's.

## The device alone

Finding a public instance is covered with the bundled list, the directories
and the probe all stubbed: that the Invidious directory is asked first,
filtered to the entries whose `api` field is `true`, and alone when one of
it answers; that the measured list and then the full list beside the app
follow when it does not, and the other directories after those; that a
listed address is only used once it has answered for itself, that an
instance listed as offline is never even contacted, that a directory which
changed shape is ignored rather than thrown on, that a siphon server or a relay
appearing in such a list is not mistaken for an instance, that the Invidious
directory's `[name, details]` pairs are read with onion and API-off entries
left out (the `api` flag is a boolean, and a claim the probe then checks),
that cobalt's directory is read in every shape it has had and its source
repository behind it, and that the number of strangers contacted in one
search is capped — and spread across the other directories, so a long cobalt
list cannot crowd Piped out of that budget. Nothing is adopted by default:
the deployed suite checks that a first visit with a cobalt instance in
`config.json` stays "this device only" and contacts nobody, and that Find is
offered on a day the measured list is empty.
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
stream, a keyed cobalt, a cobalt that answers a runner but refuses the
preflight a page's POST needs — with each verdict said and only the open
ones kept, with their kind. Both daily scripts ask with the Origin of the
repository's own page, checked by running them as the workflow does, with
the variable set, against the real relay locked to that page. The measured list is probed first by the search, and
the file beside the app is read whole: the lists, the measured ones of a
usable kind, the date.

The unit tests cover what needs no network: HLS attribute and playlist parsing,
byte-range continuation, IV derivation, YouTube URL shapes, page-scraping
precedence, the whole preset → format decision table, and the InnerTube fetch
wrapper. The relay is in there too — `relay/worker.js` is a plain module with a
`fetch(request, env)` export and nothing Workers-specific inside, so `node
--test` calls it directly with a stubbed upstream, and with Node's real fetch
against a local host that answers zstd to whoever offers it.

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
- **A pasted list is one row per link.** Two links inside a sentence, with
  punctuation stuck to them, are pasted into the field: the page says how
  many it queued, the field is left empty, two rows appear, and both files
  land byte-identical.
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
- **Twenty-five links pasted are twenty-five rows**, and every one finishes:
  none is dropped to keep the list short or cancelled to make room. A Save
  in settings, or a change of helper, leaves a running download running, and
  it finishes whole from the one request it started with.
- A direct MP3 asked for as MP3 arrives byte-identical without loading the
  converter; MP3 from an HLS ladder is real MP3, fetched from the audio-only
  rendition alone; M4A through cobalt is a request the instance accepts.
- A conversion cancelled part-way does not hold up the next. Cancel keeps the
  keyboard on it across polls, the row moves on in place rather than being
  drawn again, and a press held across a poll still cancels. A finished or
  failed download is said to a screen reader by name, a failure with its
  reason, and so is the settings sheet's verdict.
- A private video is reported as private, asked of the instance once; Piped's
  TTML caption is asked for as WebVTT and embedded with its words.
- Your own server's key goes with it: a key typed before the address stays
  for that address, typing another address lets go of it, typing the server
  back brings it back, and a cobalt instance never sees it,
  in a probe or with a download. An address typed without `http://` is given
  it and never asked of the page's own host. The YouTube clients offered are
  the ones the server's yt-dlp has, `tv_embedded` never among them, and a
  server on this computer says how a phone reaches it and that plain http
  will not install or take links from the share sheet.

The settings sheet, the guide and the site's own config are driven in the
deployed suite, in a real browser over HTTPS under a `/siphon/` subpath with
the service worker actually registered: a first visit to a host with no API
lands on a screen that works; a first visit to a host that answers
`/api/health` recognises your own server; settings written by the older
three-mode version are migrated; the measured list becomes chips with the date it was
measured, tapping one fills the address in and tests it, and on a day none
answered there is no chip, only the field, a sentence saying so, and Find,
which asks the live directory rather than the day's file; an unreachable
address is refused with
its reason and the sheet left open; **an Invidious instance whose video
endpoint is shut is recognised and then said to be shut, with an amber light,
before anyone saves it**, and every status names the address it is about, so
two instances never read the same; a siphon server is recognised from its
address with the cookie jar appearing beside it; **the Advanced section's
yt-dlp options** are live with a server set, greyed and kept with none, and
what is typed there — SponsorBlock, a clip, a speed limit, a client — rides
with the job the page posts, in the server's vocabulary, and survives a
reload — greyed too, saying why, with a server that has no ffmpeg; the clip
fields bring up a keyboard with a colon on it, and a client saved before
yt-dlp retired it reads as no preference; a first visit on a site whose
owner set `SIPHON_RELAY_URL` takes the relay with nothing to do, is told whose it is,
and the header says "relay for YouTube"; a cobalt instance in `config.json`
with no relay beside it is not adopted — the first visit stays on this device
and never contacts it; the guide
is on the first screen, says what is set and what would make YouTube work,
stays closed once closed, and comes back from the ? in the header; **the
bookmarklet it offers opens this very deploy, subpath and all**, and tapping
it in place says to drag it instead; a link dropped anywhere on the page, and
one pasted with nothing focused, land in the field with the words around
them stripped; a visitor
who cleared the helper is not handed it again; a deploy landing under a
returning visitor replaces the old worker and its cache; with the network cut
the shell still opens; and nothing scrolls sideways at phone width, a row
titled with a long link included, its Try again and Save on screen. Rows come
back from a reload as they were: one saved before its job started offers Try
again, a job the server missed a poll for is followed again, a finished one
keeps its Save link, only the running job is counted as running, and Clear
finished leaves it running on the server. The guide names a relay the visitor
cleared and takes it back in one tap, links the relay deploy and the bridge
script itself, says what Chrome needs before a userscript runs, and hands out
a `docker run` with its container named. A title pasted with its link becomes
just the link. A shared link is not kept in Cache Storage, and with the
network cut it still opens the shell with the link in the field. Nothing is
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
scraped and converted to MP3. A slow file comes through in windows, the bar
moving while it arrives rather than jumping at the end; a cancel stops the
host sending; and a playlist behind a redirect is read relative to where it
landed, which the userscript reports.

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
