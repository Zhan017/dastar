import { randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import { openToken, sealToken, type TokenRef } from "../src/tokens.js";

const KEY = randomBytes(32);
const REF: TokenRef = { sessionId: "0199a000-0000-7000-8000-0000000000aa", reservationId: "0199a000-0000-7000-8000-0000000000bb" };
const TOKEN = "k7Qm2xVw9rTn4Zb1LdYc8HsPfA3eUo6JgXi0NvRtEyM";

/** A copy of the sealed bytes with one byte changed. */
function flipped(sealed: Buffer, index: number): Buffer {
  const copy = Buffer.from(sealed);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe("sealToken and openToken", () => {
  it("a sealed token opens with the same key and row", () => {
    const sealed = sealToken(KEY, REF, TOKEN);
    expect(openToken(KEY, REF, sealed)).toBe(TOKEN);
    expect(sealed[0]).toBe(0x01);
    expect(sealed.length).toBe(1 + 12 + Buffer.byteLength(TOKEN) + 16);
    expect(sealed.includes(Buffer.from(TOKEN))).toBe(false);
    // a new nonce each time: the same token seals to different bytes, and both open
    const again = sealToken(KEY, REF, TOKEN);
    expect(again.equals(sealed)).toBe(false);
    expect(openToken(KEY, REF, again)).toBe(TOKEN);
  });

  it("a tampered byte, another key, another row, another version or a short buffer does not open", () => {
    const sealed = sealToken(KEY, REF, TOKEN);
    const nonceAt = 1;
    const ciphertextAt = 1 + 12;
    const tagAt = sealed.length - 1;
    expect(openToken(KEY, REF, flipped(sealed, nonceAt))).toBeNull();
    expect(openToken(KEY, REF, flipped(sealed, ciphertextAt))).toBeNull();
    expect(openToken(KEY, REF, flipped(sealed, tagAt))).toBeNull();
    expect(openToken(randomBytes(32), REF, sealed)).toBeNull();
    expect(openToken(KEY, { ...REF, reservationId: "0199a000-0000-7000-8000-0000000000cc" }, sealed)).toBeNull();
    expect(openToken(KEY, { ...REF, sessionId: "0199a000-0000-7000-8000-0000000000dd" }, sealed)).toBeNull();
    const otherVersion = Buffer.from(sealed);
    otherVersion[0] = 0x02;
    expect(openToken(KEY, REF, otherVersion)).toBeNull();
    expect(openToken(KEY, REF, sealed.subarray(0, 20))).toBeNull();
    // the shortest that could hold a token is one byte of ciphertext: with none, the buffer is too short
    expect(openToken(KEY, REF, Buffer.alloc(1 + 12 + 16, 0x01))).toBeNull();
    expect(openToken(KEY, REF, Buffer.alloc(0))).toBeNull();
    // the intact bytes still open after all of that
    expect(openToken(KEY, REF, sealed)).toBe(TOKEN);
  });

  it("a key that is not 32 bytes gives null and does not throw", () => {
    const sealed = sealToken(KEY, REF, TOKEN);
    expect(openToken(randomBytes(16), REF, sealed)).toBeNull();
    expect(openToken(Buffer.alloc(0), REF, sealed)).toBeNull();
  });

  it("ids compare without case", () => {
    const upper: TokenRef = { sessionId: REF.sessionId.toUpperCase(), reservationId: REF.reservationId.toUpperCase() };
    expect(openToken(KEY, upper, sealToken(KEY, REF, TOKEN))).toBe(TOKEN);
    expect(openToken(KEY, REF, sealToken(KEY, upper, TOKEN))).toBe(TOKEN);
  });
});
