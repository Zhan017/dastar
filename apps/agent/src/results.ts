/** The most characters of a tool's result the model is shown. */
export const RESULT_CHARS = 8_000;

/** C0 controls other than newline and tab, DEL, and the C1 controls: nothing a reader needs, and some of it steers a terminal. */
const isControl = (code: number): boolean => code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);

/**
 * What the model is shown of a tool's result: the control characters removed, then cut to at most `max` characters
 * (string length), the last of them a note that it was cut. The cap counts what is sent, so the removal comes first.
 */
export function capResult(text: string, max: number = RESULT_CHARS): string {
  let clean = "";
  for (let i = 0; i < text.length; i++) {
    if (!isControl(text.charCodeAt(i))) clean += text.charAt(i);
  }
  if (clean.length <= max) return clean;

  const note = `… [cut at ${max} characters]`;
  let keep = Math.max(0, max - note.length);
  // a cut between the halves of a surrogate pair would leave half a character: drop the first half too
  const last = clean.charCodeAt(keep - 1);
  if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return clean.slice(0, keep) + note;
}
