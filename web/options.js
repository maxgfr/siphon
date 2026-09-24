/**
 * The Advanced options, read the way your server reads them.
 *
 * The server refuses a job whose clip or speed limit it cannot read, with the
 * reason — every job, of every link, for as long as the setting stays. So the
 * sheet checks them before it saves, with the same grammar (server/app.py:
 * parse_timestamp, parse_rate_limit, create_job), and says which field is
 * wrong while the person is still looking at it.
 */

const TIMESTAMP = /^(?:(\d{1,3}):)?(?:(\d{1,2}):)?(\d{1,2}(?:\.\d{1,3})?)$/;
const SECONDS = /^\d+(?:\.\d{1,3})?$/;
const RATE = /^(\d+(?:\.\d+)?)\s*([kmg]?)(?:i?b)?(?:\/s)?$/i;

const TIMESTAMP_SHAPE = 'Clip times look like 1:23, 01:02:03, or seconds as 150.';
const RATE_SHAPE = 'A speed limit looks like 500K or 2M.';

/** '1:23' → 83; '' → null; NaN for what is not a time. */
function seconds(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (SECONDS.test(value)) return Number(value);
  const match = TIMESTAMP.exec(value);
  if (!match) return Number.NaN;
  let [, hours, minutes] = match;
  const secs = Number(match[3]);
  // One prefix is minutes, two are hours and minutes; past the first colon
  // the parts are clock digits, so 1:99 is not a time.
  if (hours !== undefined && minutes === undefined) [hours, minutes] = [undefined, hours];
  if (minutes !== undefined && secs >= 60) return Number.NaN;
  if (hours !== undefined && Number(minutes) >= 60) return Number.NaN;
  return secs + 60 * Number(minutes || 0) + 3600 * Number(hours || 0);
}

/** Whether a speed limit reads as a positive number of bytes per second, or is empty. */
function rateOk(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  const match = RATE.exec(value);
  if (!match) return false;
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()];
  return Math.floor(Number(match[1]) * scale) > 0;
}

/**
 * What is wrong with the options, if anything: the id of the field to fix,
 * and the server's own sentence about it. null when the server would take them.
 */
export function validateYtdlp({ sponsorblock = false, clipStart = '', clipEnd = '', rateLimit = '' } = {}) {
  const start = seconds(clipStart);
  const end = seconds(clipEnd);
  if (Number.isNaN(start)) return { field: 'optClipStart', message: TIMESTAMP_SHAPE };
  if (Number.isNaN(end)) return { field: 'optClipEnd', message: TIMESTAMP_SHAPE };
  if (!rateOk(rateLimit)) return { field: 'optRate', message: RATE_SHAPE };
  if (start !== null && end !== null && end <= start) return { field: 'optClipEnd', message: 'The clip has to end after it starts.' };
  if (sponsorblock && (start !== null || end !== null)) {
    return { field: 'optSponsor', message: 'Sponsor removal and a clip cannot be combined. Turn one of them off.' };
  }
  return null;
}

/**
 * Whether a refusal is one of these options', which the row then says where
 * to change: a setting saved before the sheet checked it fails every job.
 */
export function fromAdvanced(message) {
  return /^(Clip times look like|The clip has to end after it starts|A speed limit looks like|Sponsor removal and a clip|Unknown YouTube client)/.test(String(message || ''));
}
