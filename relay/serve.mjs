/**
 * The relay, on your own machine.
 *
 *   node relay/serve.mjs            # http://127.0.0.1:8787
 *
 * worker.js is a plain `fetch(request, env)` handler with nothing
 * Cloudflare-specific in it, so it runs anywhere that has the Fetch API — and
 * Node has had one since 18. This bridges Node's http server to it and nothing
 * more: same allow-lists, same header rules, same code that runs on Workers.
 *
 * Why you might want this rather than the Worker:
 *
 * - No account, no deploy, no `wrangler`. One command.
 * - A page on GitHub Pages may call it: browsers treat 127.0.0.1 as a secure
 *   context, so the HTTPS site talking to a plain-HTTP relay on localhost is
 *   allowed — the same rule the README leans on for "you are the client".
 * - Your home IP, not a datacentre's. YouTube treats those very differently.
 *
 * It is for the browser on this machine. A phone on the same Wi-Fi can reach
 * the machine and still not use it: the hosted page is HTTPS, and a browser
 * lets an HTTPS page call plain http on loopback only — anything else is
 * mixed content, blocked however reachable it is. A phone needs the Worker,
 * or an HTTPS address in front of this. It is also what CI uses to drive a
 * real YouTube download, which is the reason it exists.
 *
 * ALLOWED_HOSTS and ALLOWED_ORIGINS are read from the environment, exactly as
 * the Worker reads them from its bindings.
 */
import { createServer } from 'node:http';
import { Readable, pipeline } from 'node:stream';
import worker from './worker.js';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

/** Node's request, as the Request the worker expects. */
function toRequest(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host || `${HOST}:${PORT}`}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

/** The worker's Response, written back out through Node. */
async function send(response, res) {
  const headers = {};
  for (const [key, value] of response.headers) headers[key] = value;
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  // pipeline, not pipe: an upstream that drops mid-body is an error on the
  // stream, and with pipe nothing handled it — the whole process exited, and
  // every later request found nobody listening.
  pipeline(Readable.fromWeb(response.body), res, () => {});
}

const server = createServer(async (req, res) => {
  try {
    await send(await worker.fetch(toRequest(req), process.env), res);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`relay: ${error?.message || error}`);
  }
});

const address = (host) => `http://${host.includes(':') ? `[${host}]` : host}:${PORT}`;
const loopback = /^(127\.|localhost$|::1$)/i.test(HOST);
const everywhere = HOST === '0.0.0.0' || HOST === '::';

server.listen(PORT, HOST, () => {
  const hosts = process.env.ALLOWED_HOSTS || '(youtube defaults)';
  const origins = process.env.ALLOWED_ORIGINS || '(any — set ALLOWED_ORIGINS before exposing this)';
  console.log(`relay listening on ${address(HOST)}`);
  console.log(`  hosts:   ${hosts}`);
  console.log(`  origins: ${origins}`);
  // The address to paste is one the HTTPS page may call, which is loopback
  // only. Listening everywhere includes it; listening on one LAN address
  // does not, and reachable from the LAN is not usable from it.
  if (loopback) {
    console.log(`paste ${address(HOST)} into siphon under Settings → Helper`);
  } else if (everywhere) {
    console.log(`paste ${address('127.0.0.1')} into siphon under Settings → Helper, on this machine`);
    console.log('  other devices cannot use it from the hosted page: that page is HTTPS, and a browser');
    console.log('  lets it call plain http on 127.0.0.1 only. A phone needs the Worker (relay/README.md).');
  } else {
    console.log(`the hosted page cannot use ${address(HOST)}: it is HTTPS, and a browser lets it call`);
    console.log('  plain http on 127.0.0.1 only. Leave HOST unset for this machine; a phone needs the');
    console.log('  Worker (relay/README.md).');
  }
});
