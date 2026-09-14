# The relay

One file, for one problem: hosts that refuse to let a web page read their
files.

siphon's **In this browser** mode does the whole download itself — reads the
link, solves the signature, picks a quality, fetches the stream, merges with
ffmpeg.wasm. For most media that is the end of it and nothing here is needed.
But a browser will not let a page read a cross-origin response unless the host
says it may, and YouTube says that to nobody. This adds the missing header.

It is worth being precise about what that means, because "no backend" stops
being true the moment you deploy this:

|  | in-browser mode alone | with this relay |
|---|---|---|
| where extraction runs | your device | your device |
| where the bytes go | site → your device | site → relay → your device |
| what sees your links | nothing | the relay |
| what runs yt-dlp | nothing | nothing |
| works for YouTube | no | yes, usually |

The relay never learns which videos you keep, holds no state between requests,
and has nothing to update when YouTube changes — the part that changes is
running in your browser. That is the whole reason to prefer it over a second
copy of the server.

## Deploy

```sh
cd relay
npx wrangler deploy
npx wrangler secret put ALLOWED_ORIGINS     # https://yourname.github.io
```

Then paste the worker's address into siphon under **Settings → In this browser
→ Relay**.

Free-tier Workers allow 100,000 requests a day, which a personal downloader
will not come close to: one video is a handful of requests, not one per
megabyte, because the response body is streamed rather than chunked.

## The two guards

**`ALLOWED_HOSTS`** is what keeps this from being an open proxy. The worker
fetches only the media hosts it lists, so a stranger who finds the URL cannot
point it at anything else. It defaults to YouTube's hosts; widen it only for
hosts you actually want to download from.

**`ALLOWED_ORIGINS`** is what keeps other people's pages from spending your
quota. Leave it unset and the worker answers anyone. Set it to your own
frontend's URL and it answers only that. It is checked in the worker rather
than left to CORS, because CORS only stops a browser reading the answer — it
does not stop the worker making the request.

Cookies are never forwarded in either direction, so the relay cannot act as a
signed-in user of anything it fetches, and cannot hand one page another page's
session.

## What it does not fix

YouTube scores requests partly on the IP they come from, and a Cloudflare
address is a datacentre address — the category it treats with the most
suspicion. So a relay hits *"Sign in to confirm you're not a bot"* more often
than the same code on a home connection, and there is nothing the relay can do
about that: it has no cookie jar and no proof-of-origin provider, by design.

When that happens, the answer is the server mode, which has both. The relay is
the light option, not the complete one.
