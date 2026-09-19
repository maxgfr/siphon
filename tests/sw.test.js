/**
 * The offline shell is only a shell if every module the app loads is in it.
 *
 * The service worker precaches a list written by hand, and the app's imports
 * are written by hand somewhere else; the two drift. A module missing from
 * the list is fetched from the network on the first visit — before the
 * worker controls the page, so the runtime cache never sees it — and the next
 * visit with no network opens to an import that fails. This walks the imports
 * from app.js and checks each one is listed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** Every `./x.js` a module names: static imports, and workers spawned by URL. */
function localModules(source) {
  const found = new Set();
  for (const match of source.matchAll(/from\s+'\.\/([\w-]+\.js)'/g)) found.add(match[1]);
  for (const match of source.matchAll(/new URL\('\.\/([\w-]+\.js)', import\.meta\.url\)/g)) found.add(match[1]);
  return [...found];
}

function reachableFrom(entry) {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const child of localModules(readFileSync(join(WEB, name), 'utf8'))) walk(child);
  };
  walk(entry);
  return [...seen];
}

test('every module the app loads is precached by the service worker', () => {
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  const shell = new Set([...sw.matchAll(/'\.\/([\w.-]+)'/g)].map((match) => match[1]));
  const missing = reachableFrom('app.js').filter((name) => !shell.has(name));
  assert.deepEqual(missing, [], `not in sw.js SHELL: ${missing.join(', ')}`);
});

test('and the shell names nothing that does not exist, or the whole install fails', () => {
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  for (const match of sw.matchAll(/'\.\/([\w.-]+)'/g)) {
    assert.doesNotThrow(() => readFileSync(join(WEB, match[1])), `${match[1]} is listed but missing`);
  }
});
