// Text scrubbing for the transcripts an audit reads. Emails are masked first, over the whole text, since an address
// can hold what would otherwise be kept (a date or an id before the @); then ids, dates, and times are kept by
// position and the text between them is masked for numbers. Every pattern here runs in linear time on any input:
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

/**
 * An address: letters, digits, and combining marks of any script, with `._%+-` and an apostrophe, before the @
 * (so an accented name or one with an apostrophe is one address); the same without the punctuation but with hyphens in
 * each dot-separated label of the domain. The lookbehind uses the local part's own class, so a scan only starts at
 * the start of a run of those characters and each run is scanned once; a dot is not in a label's class, so the
 * labels split one way.
 */
const LOCAL = String.raw`[\p{L}\p{N}\p{M}._%+'-]`;
const LABEL = String.raw`[\p{L}\p{N}\p{M}-]+`;
const EMAIL = new RegExp(String.raw`(?<!${LOCAL})${LOCAL}+@${LABEL}(?:\.${LABEL})+`, "gu");

/** A space: the plain one, a no-break space, a figure space, a thin space, a narrow no-break space. */
const SPACE = String.raw`[ \u00A0\u2007\u2009\u202F]`;
/** A mark between digit groups: a dot, a slash, a hyphen, a dash from U+2010 to U+2015, or a minus sign. */
const MARK = String.raw`[./\-\u2010-\u2015\u2212]`;
/** One joiner: a space, or a mark with at most one space on either side. The two forms start on different characters. */
const JOIN = `(?:${SPACE}(?:${MARK}${SPACE}?)?|${MARK}${SPACE}?)`;
/**
 * Digit groups read as one number: an optional plus, then groups each joined to the last by one joiner; a group
 * may be parenthesized, and a parenthesized group needs no joiner. A joiner is required between plain groups, so
 * a run of digits is one group and each position is matched one way: a joiner is followed by a digit or a
 * parenthesis, never by another joiner.
 */
const DIGIT_GROUPS = new RegExp(String.raw`\+?(?:\(\d+\)|\d+)(?:${JOIN}?\(\d+\)|${JOIN}\d+|(?<=\))\d+)*`, "g");

function maskNumber(run: string): string {
  const digits = run.replace(/\D/g, "").length;
  if (digits >= 16) return "[number]";
  if (digits >= 7) return "[phone]";
  return run;
}

function maskGap(gap: string): string {
  return gap === "" ? gap : gap.replace(DIGIT_GROUPS, maskNumber);
}

/**
 * Masks what a transcript should not keep: an email as `[email]`, a number of 7 to 15 digits as `[phone]`, one of
 * 16 or more as `[number]`. A uuid, an ISO date or date-time, and a time of day stay as written. Emails go first,
 * over the whole text, because an address can contain what would otherwise be kept (a date or an id in its local
 * part) and is masked as one. The protected spans are then found and kept by position, and only the text between
 * them is masked for digit groups, so no input can pass for a placeholder. Never throws, and scrubbing twice gives
 * what scrubbing once does.
 */
export function scrubText(text: string): string {
  const mailed = text.includes("@") ? text.replace(EMAIL, "[email]") : text;
  let out = "";
  let last = 0;
  PROTECTED.lastIndex = 0;
  for (let m = PROTECTED.exec(mailed); m !== null; m = PROTECTED.exec(mailed)) {
    out += maskGap(mailed.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + maskGap(mailed.slice(last));
}
