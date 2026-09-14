/**
 * The one error type the UI knows how to render.
 *
 * It lives in its own module because both halves of the app throw it — api.js
 * for the backends and extract.js for the in-browser extractor — and importing
 * one from the other would make the pair circular.
 */
export class BackendError extends Error {
  constructor(message, { hint = '', retryable = true } = {}) {
    super(message);
    this.name = 'BackendError';
    this.hint = hint;
    this.retryable = retryable;
  }
}
