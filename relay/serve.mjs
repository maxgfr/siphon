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
 * It is still a server, and it is running on the machine you are sitting at;
 * a phone cannot use it unless it can reach that machine. It is also what CI
 * uses to drive a real YouTube download, which is the reason it exists.
 *
 * ALLOWED_HOSTS and ALLOWED_ORIGINS are read from the environment, exactly as
 * the Worker reads them from its bindings.
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
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
  Readable.fromWeb(response.body).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    await send(await worker.fetch(toRequest(req), process.env), res);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`relay: ${error?.message || error}`);
  }
});

server.listen(PORT, HOST, () => {
  const hosts = process.env.ALLOWED_HOSTS || '(youtube defaults)';
  const origins = process.env.ALLOWED_ORIGINS || '(any — set ALLOWED_ORIGINS before exposing this)';
  console.log(`relay listening on http://${HOST}:${PORT}`);
  console.log(`  hosts:   ${hosts}`);
  console.log(`  origins: ${origins}`);
  console.log(`paste http://${HOST}:${PORT} into siphon under Settings → Helper`);
});
