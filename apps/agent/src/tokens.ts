import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The row a sealed token belongs to: a token sealed for one session and reservation opens for no other. */
export type TokenRef = { sessionId: string; reservationId: string };

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The version byte, the nonce, at least one byte of ciphertext and the tag. */
const MIN_SEALED_BYTES = 1 + NONCE_BYTES + 1 + TAG_BYTES;

/** What the seal is bound to besides the key, so a sealed token moved to another row fails to open. Ids compare without case. */
const additionalData = (ref: TokenRef): Buffer => Buffer.from(`${ref.sessionId}:${ref.reservationId}`.toLowerCase());

/** The token encrypted with AES-256-GCM under `key` (32 bytes): the version byte 0x01, a random 12-byte nonce, the ciphertext, then the 16-byte tag. */
export function sealToken(key: Buffer, ref: TokenRef, token: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData(ref));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, ciphertext, cipher.getAuthTag()]);
}

/** The token a sealed value holds, or null when it is too short, has another version, was sealed under another key or for another row, or has been changed. Never throws. */
export function openToken(key: Buffer, ref: TokenRef, sealed: Buffer): string | null {
  if (sealed.length < MIN_SEALED_BYTES || sealed[0] !== VERSION) return null;
  try {
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const ciphertext = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(additionalData(ref));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // a failed tag, or a key that is not 32 bytes: either way there is no token to give back
    return null;
  }
}
