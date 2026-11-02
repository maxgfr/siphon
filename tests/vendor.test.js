/**
 * The app has no build step, so llm-connect's sealedStore is copied into
 * web/vendor/ rather than imported from the package. A copy edited by hand,
 * or left behind when the package moves on, would be crypto nobody reviewed:
 * it has to be the package's file, byte for byte, under its header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(ROOT, 'node_modules', 'llm-connect');

test('web/vendor/llm-connect-sealed-store.js is llm-connect\'s build/sealed-store.js', () => {
  const vendored = readFileSync(join(ROOT, 'web', 'vendor', 'llm-connect-sealed-store.js'), 'utf8');
  const { version } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
  const header = vendored.slice(0, vendored.indexOf('\n\n') + 2);
  assert.match(header, new RegExp(`^// Vendored from llm-connect@${version.replaceAll('.', '\\.')}, build/sealed-store\\.js`), 'the header names the installed version');
  assert.match(header, /Do not edit/);
  assert.equal(vendored.slice(header.length), readFileSync(join(PACKAGE, 'build', 'sealed-store.js'), 'utf8'));
});

test('and it imports nothing, so it runs as it is', () => {
  const vendored = readFileSync(join(ROOT, 'web', 'vendor', 'llm-connect-sealed-store.js'), 'utf8');
  assert.doesNotMatch(vendored, /^\s*import\s/m);
});
