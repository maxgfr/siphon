/**
 * The Advanced options, checked in the sheet before they are saved.
 *
 * Your server refuses a job whose clip or speed limit it cannot read, with the
 * reason. Saved as typed, a slip failed every later download of every link,
 * until the person thought to look in Settings → Advanced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateYtdlp, fromAdvanced } from '../web/options.js';

const valid = { sponsorblock: false, clipStart: '', clipEnd: '', rateLimit: '', client: '' };

test('nothing asked for, and what the server reads, pass', () => {
  assert.equal(validateYtdlp(valid), null);
  for (const [clipStart, clipEnd] of [['1:23', '2:00'], ['150', '01:02:03.5'], ['0', ''], ['', '1:30'], ['0:05', '1:00:00']]) {
    assert.equal(validateYtdlp({ ...valid, clipStart, clipEnd }), null, `${clipStart} to ${clipEnd}`);
  }
  for (const rateLimit of ['500K', '2M', '1.5m', '300k/s', '2MiB', '1000']) {
    assert.equal(validateYtdlp({ ...valid, rateLimit }), null, rateLimit);
  }
});

test('a clip time that is not one is refused, naming the field and the shape', () => {
  for (const clipStart of ['abc', '1:99', '1:2:3:4', '-5', '1:60:00']) {
    const problem = validateYtdlp({ ...valid, clipStart });
    assert.equal(problem?.field, 'optClipStart', clipStart);
    assert.match(problem.message, /1:23/, clipStart);
  }
  assert.equal(validateYtdlp({ ...valid, clipEnd: 'soon' })?.field, 'optClipEnd');
});

test('a clip that ends before it starts is refused', () => {
  const problem = validateYtdlp({ ...valid, clipStart: '0:05', clipEnd: '0:02' });
  assert.equal(problem?.field, 'optClipEnd');
  assert.match(problem.message, /end after it starts/);
});

test('a speed limit that is not one is refused', () => {
  for (const rateLimit of ['fast', '0', '2 T', 'M']) {
    assert.equal(validateYtdlp({ ...valid, rateLimit })?.field, 'optRate', rateLimit);
  }
});

test('sponsor removal and a clip together are refused, as the server refuses them', () => {
  assert.equal(validateYtdlp({ ...valid, sponsorblock: true, clipStart: '0:10' })?.field, 'optSponsor');
  assert.equal(validateYtdlp({ ...valid, sponsorblock: true }), null);
});

test('a refusal over these options is known for one, so the row can say where to change it', () => {
  for (const message of ['Clip times look like 1:23, 01:02:03, or seconds as 150.', 'The clip has to end after it starts.',
    'A speed limit looks like 500K or 2M.', 'Sponsor removal and a clip cannot be combined. Turn one of them off.']) {
    assert.ok(fromAdvanced(message), message);
  }
  assert.equal(fromAdvanced('That video is private.'), false);
});
