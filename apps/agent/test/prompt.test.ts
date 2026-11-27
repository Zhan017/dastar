import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { PROMPT_FILE, loadPrompt, promptHash, readPromptFile, renderContext, renderTemplate } from "../src/prompt.js";
import { REPLY_JSON_SCHEMA } from "../src/reply.js";
import { AGENT_TOOLS } from "../src/tools.js";

const MARKER = "<!-- context template -->";

describe("the prompt file", () => {
  it("has a system prompt and a context template with exactly its six placeholders", () => {
    const { system, contextTemplate } = loadPrompt();
    expect(PROMPT_FILE.endsWith("apps/agent/prompts/reference-v1.md")).toBe(true);
    expect(system.length).toBeGreaterThan(0);
    expect(contextTemplate.length).toBeGreaterThan(0);
    expect([...contextTemplate.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()).toEqual(["local", "offset", "utc", "venue", "weekday", "zone"]);
    expect(system).not.toContain("{{");
    expect(system).not.toContain(MARKER);
    expect(system).toBe(system.trim());
    expect(contextTemplate).toBe(contextTemplate.trim());
  });

  it("the hash changes with each of its four inputs and only them", () => {
    const { system, contextTemplate, hash } = loadPrompt();
    expect(promptHash(system, contextTemplate, AGENT_TOOLS, REPLY_JSON_SCHEMA)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // one description changed
    const changedTools = AGENT_TOOLS.map((tool, index) => (index === 0 ? { ...tool, description: `${tool.description} ` } : tool));
    // one status dropped from the reply's schema
    const changedSchema = structuredClone(REPLY_JSON_SCHEMA);
    (changedSchema as unknown as { properties: { claims: { items: { properties: { status: { enum: string[] } } } } } }).properties.claims.items.properties.status.enum.pop();

    const variants = [
      promptHash(`${system} `, contextTemplate, AGENT_TOOLS, REPLY_JSON_SCHEMA),
      promptHash(system, `${contextTemplate} `, AGENT_TOOLS, REPLY_JSON_SCHEMA),
      promptHash(system, contextTemplate, changedTools, REPLY_JSON_SCHEMA),
      promptHash(system, contextTemplate, AGENT_TOOLS, changedSchema),
    ];
    for (const variant of variants) expect(variant).not.toBe(hash);
    expect(new Set([hash, ...variants]).size).toBe(5);
  });

  it("is read from a file by its marker line, with the file's newlines in neither part, and refused without exactly one", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-prompt-"));
    try {
      const write = (name: string, text: string) => {
        const file = join(dir, name);
        writeFileSync(file, text);
        return file;
      };
      const loaded = loadPrompt(write("ok.md", `\nSay hello.\n\nSay goodbye.\n${MARKER}\nIt is {{utc}}.\n\n`));
      expect(loaded.system).toBe("Say hello.\n\nSay goodbye.");
      expect(loaded.contextTemplate).toBe("It is {{utc}}.");
      expect(loadPrompt(write("crlf.md", `One.\r\n${MARKER}\r\nTwo.\r\n`))).toMatchObject({ system: "One.", contextTemplate: "Two." });

      for (const [name, text] of [["none.md", "Say hello.\n"], ["two.md", `A\n${MARKER}\nB\n${MARKER}\nC\n`], ["inline.md", `A ${MARKER} B\n`]] as const) {
        const file = write(name, text);
        expect(() => loadPrompt(file), name).toThrow(file);
      }
      for (const [name, text] of [["no-system.md", `${MARKER}\nB\n`], ["no-template.md", `A\n${MARKER}\n`]] as const) {
        const file = write(name, text);
        expect(() => loadPrompt(file), name).toThrow(file);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderContext", () => {
  const values = { utc: "2064-01-07T16:00:00.000Z", weekday: "Monday", local: "2064-01-07 17:00", zone: "Europe/Berlin", offset: "+01:00", venue: "Test" };

  it("fills the template", () => {
    expect(renderContext(loadPrompt().contextTemplate, values)).toBe(
      "The time now is 2064-01-07T16:00:00.000Z (UTC). At the venue it is Monday 2064-01-07 17:00, time zone Europe/Berlin (UTC+01:00). The venue is Test.",
    );
  });

  it("fills in one pass, so a value that looks like a placeholder stays as written, and refuses a placeholder it has no value for", () => {
    expect(renderContext("{{venue}} {{utc}}", { ...values, venue: "{{utc}}" })).toBe("{{utc}} 2064-01-07T16:00:00.000Z");
    expect(() => renderContext("{{nothing}}", values)).toThrow("nothing");
    expect(() => renderContext("{{toString}}", values)).toThrow("toString");
  });
});

describe("renderTemplate", () => {
  it("fills each placeholder once and leaves a value that looks like one", () => {
    expect(renderTemplate("{{a}} and {{b}} and {{a}}", { a: "{{b}}", b: "two" })).toBe("{{b}} and two and {{b}}");
    expect(renderTemplate("no placeholders", {})).toBe("no placeholders");
    expect(() => renderTemplate("{{nothing}}", { a: "x" })).toThrow("nothing");
    expect(() => renderTemplate("{{toString}}", {})).toThrow("toString");
  });
});

describe("readPromptFile", () => {
  it("splits at its marker and refuses a file without exactly one", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-prompt-file-"));
    try {
      const write = (name: string, text: string) => {
        const file = join(dir, name);
        writeFileSync(file, text);
        return file;
      };
      const marker = "<!-- elsewhere -->";
      expect(readPromptFile(write("ok.md", `\nFirst.\n\nSecond.\n${marker}\nA {{b}}.\n\n`), marker)).toEqual({ system: "First.\n\nSecond.", template: "A {{b}}." });
      expect(readPromptFile(write("crlf.md", `One.\r\n${marker}\r\nTwo.\r\n`), marker)).toEqual({ system: "One.", template: "Two." });

      // the marker of another prompt is not this one's
      const other = write("other.md", `One.\n${MARKER}\nTwo.\n`);
      expect(() => readPromptFile(other, marker)).toThrow(other);

      for (const [name, text] of [["none.md", "Say hello.\n"], ["two.md", `A\n${marker}\nB\n${marker}\nC\n`], ["inline.md", `A ${marker} B\n`]] as const) {
        const file = write(name, text);
        expect(() => readPromptFile(file, marker), name).toThrow(file);
      }
      for (const [name, text] of [["no-system.md", `${marker}\nB\n`], ["no-template.md", `A\n${marker}\n`]] as const) {
        const file = write(name, text);
        expect(() => readPromptFile(file, marker), name).toThrow(file);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
