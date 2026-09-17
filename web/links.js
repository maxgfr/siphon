/**
 * Links in a piece of text — what a paste, a drop or a share carries.
 *
 * A share is often "Title https://…", a paste is often a whole list, and a
 * dropped bookmark is a uri-list with comment lines. All of them come down
 * to the http(s) links inside, each once, in the order written.
 */

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
