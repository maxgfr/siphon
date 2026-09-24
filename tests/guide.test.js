/**
 * What the guide hands a person to install has to be the thing itself.
 *
 * A userscript manager offers to install a script only from an address that
 * ends in .user.js; a folder on GitHub is a page to find the file on, then
 * its Raw button, then an install — or a paste, which never updates. And a
 * command to copy has to be one the update advice can follow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const INDEX = read('web/index.html');
const README = read('README.md');
const SCRIPT = read('bridge/siphon-bridge.user.js');
const FILE = /\/maxgfr\/siphon\/(raw\/)?main\/bridge\/siphon-bridge\.user\.js$/;

test('every link to the bridge, in the guide and the README, is the script itself', () => {
  const links = [
    // Any address with a path segment named bridge: the folder, the file.
    ...[...INDEX.matchAll(/href="((?:[^"]*\/)?bridge(?:\/[^"]*)?)"/g)].map((match) => match[1]),
    ...[...README.matchAll(/\]\(((?:[^)]*\/)?bridge(?:\/[^)]*)?)\)/g)].map((match) => match[1]),
  ];
  assert.ok(links.length >= 2, `${links.length} links found`);
  for (const link of links) assert.match(link, FILE, link);
});

test('the script says where its updates come from: the same file', () => {
  const header = /\/\/ ==UserScript==([^]*?)\/\/ ==\/UserScript==/.exec(SCRIPT)[1];
  for (const key of ['downloadURL', 'updateURL']) {
    const value = new RegExp(`^// @${key}\\s+(\\S+)$`, 'm').exec(header)?.[1] || '';
    assert.match(value, /^https:\/\//, `@${key}`);
    assert.match(value, FILE, `@${key} ${value}`);
  }
});

test('Chrome\'s Allow User Scripts switch is named wherever the bridge is offered', () => {
  // Tampermonkey on Chrome 138 and later runs nothing until it is on, and
  // the page then behaves as if there were no bridge at all.
  assert.ok(INDEX.includes('Allow User Scripts'), 'web/index.html');
  assert.ok(README.includes('Allow User Scripts'), 'README.md');
});

test('the docker command in the guide names its container, so the update advice can find it', () => {
  const command = /<code id="dockerCmd">([^<]*)<\/code>/.exec(INDEX)[1];
  assert.match(command, /^docker run -d --name siphon .*ghcr\.io\/maxgfr\/siphon$/);
  // Named, a container left stopped by a reboot holds its name, and the same
  // command pasted again is refused. Restarted with Docker, as compose's is,
  // it is simply there again.
  assert.match(command, / --restart unless-stopped /);
});
