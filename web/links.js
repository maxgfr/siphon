/**
 * Links in a piece of text — what a paste, a drop or a share carries.
 *
 * A share is often "Title https://…", a paste is often a whole list, and a
 * dropped bookmark is a uri-list with comment lines. All of them come down
 * to the http(s) links inside, each once, in the order written.
 */

import { withScheme } from './endpoint.js';

const LINK = /https?:\/\/[^\s<>"'`]+/g;
// A link at the end of a sentence carries the sentence's punctuation.
const TRAILING = /[)\]}>.,;:!?'"]+$/;

/** Whether one value is one http(s) URL and nothing else. */
export function looksLikeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Every http(s) link in the text, each once, trailing punctuation dropped. */
export function urlsIn(text) {
  const found = [];
  for (const raw of String(text || '').match(LINK) || []) {
    const link = raw.replace(TRAILING, '');
    if (looksLikeUrl(link) && !found.includes(link)) found.push(link);
  }
  return found;
}

/**
 * A host — with a dot in it, and a name or an address at the end — then a
 * port, a path, or neither, and nothing else: what a link typed without its
 * scheme looks like, and what "clip.mp4" or a sentence does not.
 */
const BARE = /^(?:localhost|[\w-]+(?:\.[\w-]+)*\.(?:[a-z]{2,}|\d{1,3}))(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * The link in the field, as it will be fetched: a URL as it is, or a link
 * typed without its scheme — "youtu.be/…", as a phone keyboard offers ".com"
 * and never "https://" — given the one it most likely has, as the helper
 * field gives it. '' for anything else.
 */
export function asLink(value) {
  const text = String(value || '').trim();
  if (looksLikeUrl(text)) return text;
  if (!BARE.test(text)) return '';
  const link = withScheme(text);
  return looksLikeUrl(link) ? link : '';
}
