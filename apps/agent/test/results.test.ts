import { describe, it, expect } from "vitest";
import { RESULT_CHARS, capResult } from "../src/results.js";

const NOTE = "… [cut at 8000 characters]";

/** Half of a surrogate pair standing alone: a high half not followed by a low one, or a low half not preceded by a high one. */
const hasLoneHalf = (text: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])/.test(text) || /(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(text);

describe("capResult", () => {
  it("leaves a result of the cap's size as it is", () => {
    expect(RESULT_CHARS).toBe(8_000);
    const text = "a".repeat(8_000);
    expect(capResult(text)).toBe(text);
    expect(capResult("")).toBe("");
  });

  it("cuts a longer result to exactly the cap, ending with a note of the cut", () => {
    const cut = capResult("a".repeat(8_001));
    expect(cut.length).toBe(8_000);
    expect(cut.endsWith(NOTE)).toBe(true);
    expect(cut).toBe("a".repeat(8_000 - NOTE.length) + NOTE);
    expect(capResult("a".repeat(500), 100)).toBe("a".repeat(100 - "… [cut at 100 characters]".length) + "… [cut at 100 characters]");
  });

  it("keeps a surrogate pair whole or drops it whole where the cut falls", () => {
    const keep = 8_000 - NOTE.length;
    const pair = "\u{1F600}";

    const across = capResult("a".repeat(keep - 1) + pair + "z".repeat(100));
    expect(hasLoneHalf(across)).toBe(false);
    expect(across).toBe("a".repeat(keep - 1) + NOTE);

    const before = capResult("a".repeat(keep - 2) + pair + "z".repeat(100));
    expect(hasLoneHalf(before)).toBe(false);
    expect(before).toBe("a".repeat(keep - 2) + pair + NOTE);
    expect(before.length).toBe(8_000);
  });

  it("removes control characters, keeping newline and tab", () => {
    expect(capResult("a\u0000b\u0007c\u007fd\u009fe")).toBe("abcde");
    expect(capResult("a\nb\tc")).toBe("a\nb\tc");
    expect(capResult("a\r\nb\u001b[31mc")).toBe("a\nb[31mc");
    expect(capResult("café    x")).toBe("café    x");
  });

  it("removes the control characters first, so the cap counts what is sent", () => {
    const text = ("a" + "\u0000").repeat(8_000);
    expect(capResult(text)).toBe("a".repeat(8_000));
    const cut = capResult("a".repeat(8_000) + "\u0000".repeat(50));
    expect(cut).toBe("a".repeat(8_000));
  });
});
