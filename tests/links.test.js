/**
 * The links in a piece of text — what a paste, a drop or a share carries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeUrl, urlsIn } from '../web/links.js';

test('one link is one link', () => {
  assert.equal(looksLikeUrl(' https://example.com/v '), true);
  assert.equal(looksLikeUrl('ftp://example.com/v'), false);
  assert.equal(looksLikeUrl('example.com/v'), false);
  assert.equal(looksLikeUrl(''), false);
  assert.equal(looksLikeUrl(null), false);
});

test('a share is "Title https://…", and the link is what is kept', () => {
  assert.deepEqual(urlsIn('Look at this https://youtu.be/jNQXAC9IVRw?si=abc'), ['https://youtu.be/jNQXAC9IVRw?si=abc']);
});

test('a pasted list is every link in it, in order, each once', () => {
  const text = [
    'Two clips:',
    'https://a.example/one.mp4',
    'and <https://b.example/two.m3u8>, then https://a.example/one.mp4 again.',
  ].join('\n');
  assert.deepEqual(urlsIn(text), ['https://a.example/one.mp4', 'https://b.example/two.m3u8']);
});

test('the sentence\'s punctuation is not part of the link', () => {
  assert.deepEqual(urlsIn('(see https://a.example/v).'), ['https://a.example/v']);
  assert.deepEqual(urlsIn('"https://a.example/v?x=1"!'), ['https://a.example/v?x=1']);
});

test('a dropped bookmark is a uri-list, comment lines and all', () => {
  assert.deepEqual(urlsIn('# The clip\r\nhttps://a.example/v\r\n'), ['https://a.example/v']);
});

test('text with no link in it is nothing to take', () => {
  assert.deepEqual(urlsIn('just words'), []);
  assert.deepEqual(urlsIn(''), []);
  assert.deepEqual(urlsIn(undefined), []);
});
