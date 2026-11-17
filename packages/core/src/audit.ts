// Text scrubbing for the transcripts an audit reads. Every pattern here runs in linear time on any input:
// a lookbehind keeps a scan from starting inside a run it would only scan again, and no two adjacent
// pieces of a pattern can match the same character, so no position can be matched in two ways.

const HEX = "[0-9a-fA-F]";
const HOUR = String.raw`(?:[01]\d|2[0-3])`;
const MINSEC = String.raw`[0-5]\d`;
const MONTH = String.raw`(?:0[1-9]|1[0-2])`;
const DAY = String.raw`(?:0[1-9]|[12]\d|3[01])`;
const CLOCK = `${HOUR}:${MINSEC}`;

const UUID = `${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`;
/** A date, with an optional time and zone: 2030-06-07, 2030-06-07T19:00:00.000+02:00. A day past 31 is not a date. */
const DATE = String.raw`\d{4}-${MONTH}-${DAY}(?:[T ]${CLOCK}(?::${MINSEC}(?:\.\d{1,9})?)?(?:Z|[+-]${CLOCK})?)?`;
const TIME = `${CLOCK}(?::${MINSEC})?`;

/** The spans kept as written: a uuid, an ISO date or date-time, a bare time. Each stands alone, not inside a longer word. */
const PROTECTED = new RegExp(String.raw`(?<!\w)(?:${UUID}|${DATE}|${TIME})(?!\w)`, "g");

/** The local part may only begin where a run of its characters begins, so one run is scanned once. */
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Digit groups read as one number: an optional plus, then groups joined by at most one space, dot, or hyphen;
 * a group may be parenthesized. A separator is required between plain groups, so a run of digits is one group.
 */
const DIGIT_GROUPS = /\+?(?:\(\d+\)|\d+)(?:[ .-]?\(\d+\)|[ .-]\d+|(?<=\))\d+)*/g;

function maskNumber(run: string): string {
  const digits = run.replace(/\D/g, "").length;
  if (digits >= 16) return "[number]";
  if (digits >= 7) return "[phone]";
  return run;
}

function maskGap(gap: string): string {
  if (gap === "") return gap;
  const mailed = gap.includes("@") ? gap.replace(EMAIL, "[email]") : gap;
  return mailed.replace(DIGIT_GROUPS, maskNumber);
}

/**
 * Masks what a transcript should not keep: an email as `[email]`, a number of 7 to 15 digits as `[phone]`, one of
 * 16 or more as `[number]`. A uuid, an ISO date or date-time, and a time of day stay as written. The protected
 * spans are found first and kept by position, and only the text between them is masked, so no input can pass for
 * a placeholder. Never throws, and scrubbing twice gives what scrubbing once does.
 */
export function scrubText(text: string): string {
  let out = "";
  let last = 0;
  PROTECTED.lastIndex = 0;
  for (let m = PROTECTED.exec(text); m !== null; m = PROTECTED.exec(text)) {
    out += maskGap(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + maskGap(text.slice(last));
}
