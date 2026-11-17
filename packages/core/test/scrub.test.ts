import { describe, it, expect } from "vitest";
import { scrubText } from "../src/index.js";

const CASES: [string, string][] = [
  ["write to jane.doe+tables@example.co.uk", "write to [email]"],
  ["mail a1@b2.io or call 555 123 4567", "mail [email] or call [phone]"],
  ["call +49 30 1234567", "call [phone]"],
  ["(030) 123-4567", "[phone]"],
  ["+1 (415) 555-0132 on 2030-06-07", "[phone] on 2030-06-07"],
  ["booking code 12345678", "booking code [phone]"],
  ["1234567", "[phone]"],
  ["123456", "123456"],
  ["card 4111 1111 1111 1111", "card [number]"],
  ["ref 123456789012345678901", "ref [number]"],
  ["reservation 12345678-1234-1234-1234-123456789012", "reservation 12345678-1234-1234-1234-123456789012"],
  ["0199A000-0000-7000-8000-000000000001", "0199A000-0000-7000-8000-000000000001"],
  ["2030-06-07T19:00:00Z and 2030-06-07T19:00:00.000+02:00", "2030-06-07T19:00:00Z and 2030-06-07T19:00:00.000+02:00"],
  ["on 2030-06-07 at 19:00", "on 2030-06-07 at 19:00"],
  ["table 12 for 4 at 19:30, €1,234.56", "table 12 for 4 at 19:30, €1,234.56"],
  ["+7 1555-12-34", "[phone]"],
  ["jane-2030-06-07@x.com", "[email]"],
  ["reply+0199a000-0000-7000-8000-000000000001@mail.example.com", "[email]"],
  ["josé@example.com", "[email]"],
  ["müller@example.de", "[email]"],
  ["o'brien@example.com", "[email]"],
  ["jane@bücher.de", "[email]"],
  ["josé@example.com", "[email]"],
  ["(555) 123–4567", "[phone]"],
  ["555 123 4567", "[phone]"],
  ["555 123 4567", "[phone]"],
  ["030/123456", "[phone]"],
  ["0171/1234567", "[phone]"],
  ["+49 30 1234567", "[phone]"],
  ["555 - 123 - 4567", "[phone]"],
  ["4111–1111–1111–1111", "[number]"],
  ["", ""],
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Token = { text: string; kept: boolean };

describe("scrubText", () => {
  it("masks emails, phones, and long numbers, and keeps ids, dates, and times", () => {
    for (const [input, expected] of CASES) expect(scrubText(input), input).toBe(expected);
  });

  it("is idempotent and never changes a UUID or an ISO date or time", () => {
    const rnd = mulberry32(20261111);
    const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
    const pad = (n: number, width: number): string => String(n).padStart(width, "0");
    const hex = (n: number): string => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
    const digits = (n: number): string => Array.from({ length: n }, () => String(int(0, 9))).join("");

    const uuid = (): string => {
      const s = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
      return rnd() < 0.5 ? s : s.toUpperCase();
    };
    const date = (): string => `${pad(int(1990, 2090), 4)}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)}`;
    const clock = (): string => `${pad(int(0, 23), 2)}:${pad(int(0, 59), 2)}`;
    const dateTime = (): string => {
      const base = `${date()}T${clock()}:${pad(int(0, 59), 2)}`;
      const form = int(0, 2);
      if (form === 0) return `${base}Z`;
      if (form === 1) return `${base}${pick(["+", "-"])}${pad(int(0, 14), 2)}:${pad(pick([0, 30, 45]), 2)}`;
      return `${base}.${pad(int(0, 999), 3)}Z`;
    };
    const email = (): string => `${pick(["a", "jane.doe", "u12", "x+y"])}@${pick(["b.io", "example.com", "h3.co.uk"])}`;
    const phone = (): string => {
      let left = int(1, 20);
      let out = rnd() < 0.5 ? "+" : "";
      let first = true;
      while (left > 0) {
        const size = Math.min(left, int(1, 4));
        out += (first ? "" : pick([" ", "-", ".", ""])) + digits(size);
        left -= size;
        first = false;
      }
      return out;
    };
    const word = (): string => pick(["table", "booking", "for", "at", "on", "Grüße", "ref", "x"]);
    const punct = (): string => pick([..."(),.;:!?€$"]);

    const token = (): Token => {
      const kind = int(0, 8);
      switch (kind) {
        case 0: return { text: uuid(), kept: true };
        case 1: return { text: date(), kept: true };
        case 2: return { text: dateTime(), kept: true };
        case 3: return { text: clock(), kept: true };
        case 4: return { text: email(), kept: false };
        case 5: return { text: phone(), kept: false };
        case 6: return { text: digits(int(1, 25)), kept: false };
        case 7: return { text: word(), kept: false };
        default: return { text: punct(), kept: false };
      }
    };

    for (let i = 0; i < 1000; i++) {
      const tokens = Array.from({ length: int(1, 30) }, token);
      const input = tokens.map((t) => t.text).join(" ");
      const once = scrubText(input);
      expect(scrubText(once), input).toBe(once);
      let from = 0;
      for (const t of tokens) {
        if (!t.kept) continue;
        const at = once.indexOf(t.text, from);
        expect(at, `${t.text} in ${once} (from ${input})`).toBeGreaterThanOrEqual(0);
        from = at + t.text.length;
      }
    }
  });

  it("never throws, and leaves text without digits or @ alone", () => {
    for (const s of ["\ud800 lone", "nul\u0000x", " private", "🙂 emoji", "Grüße, Jürgen!"]) {
      expect(scrubText(s)).toBe(s);
    }
  });

  it("scrubs 20000 characters of digits and separators quickly", () => {
    const inputs = [
      "1 2-3.(4) ".repeat(2000), "1".repeat(20000), "a@".repeat(10000), "+1 ".repeat(6667),
      "1 – 2 /(3) ".repeat(1700),
      "é.".repeat(10000) + "@", "ü@".repeat(10000), "a@" + "b".repeat(19998),
    ];
    for (const input of inputs) {
      const started = performance.now();
      scrubText(input);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});
