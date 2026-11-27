import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPLY_JSON_SCHEMA } from "./reply.js";
import { AGENT_TOOLS, type JsonSchema, type ProviderTool } from "./tools.js";

/** The system prompt, the template of the context message, and a hash of everything that shapes what the model is told: both texts, the tools and the reply format. */
export type LoadedPrompt = { system: string; contextTemplate: string; hash: string };

export const PROMPT_FILE: string = fileURLToPath(new URL("../prompts/reference-v1.md", import.meta.url));

/** The one line of the prompt file that ends the system prompt and begins the context template. */
const MARKER = "<!-- context template -->";

/** A change to any of the four inputs is a different prompt, so a recorded turn names the version of it that was in force. */
export function promptHash(system: string, contextTemplate: string, tools: readonly ProviderTool[], replySchema: JsonSchema): string {
  return createHash("sha256").update(JSON.stringify([system, contextTemplate, tools, replySchema])).digest("hex");
}

/**
 * Reads a prompt file: the system prompt, then a line holding only `marker`, then a template; the file's own newlines are
 * in neither. `templateName` is how the template is called in the error for a file that lacks one.
 */
export function readPromptFile(file: string, marker: string, templateName = "template"): { system: string; template: string } {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const at = lines.flatMap((line, index) => (line.trimEnd() === marker ? [index] : []));
  const [first] = at;
  if (at.length !== 1 || first === undefined) throw new Error(`${file} must have exactly one line ${marker}`);

  const system = lines.slice(0, first).join("\n").trim();
  const template = lines.slice(first + 1).join("\n").trim();
  if (system === "" || template === "") throw new Error(`${file} must have a system prompt before the line ${marker} and a ${templateName} after it`);

  return { system, template };
}

/** Reads the prompt file: the system prompt, then a marker line, then the context template; the file's own newlines are in neither. */
export function loadPrompt(file: string = PROMPT_FILE): LoadedPrompt {
  const { system, template } = readPromptFile(file, MARKER, "context template");
  return { system, contextTemplate: template, hash: promptHash(system, template, AGENT_TOOLS, REPLY_JSON_SCHEMA) };
}

/** What the context message says about now and about the venue. */
export type ContextValues = { utc: string; weekday: string; local: string; zone: string; offset: string; venue: string };

/** Fills each `{{name}}` of the template from `values`, in one pass, so a value that looks like a placeholder is left as it is. A placeholder with no value is a mistake in the template, so it throws; `templateName` is how the error calls the template. */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>, templateName = "template"): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_placeholder, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) throw new Error(`the ${templateName} names {{${name}}}, which has no value`);
    return value;
  });
}

/** The context message: the template filled from what it says about now and about the venue. */
export function renderContext(template: string, values: ContextValues): string {
  return renderTemplate(template, values, "context template");
}
