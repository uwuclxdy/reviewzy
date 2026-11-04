import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { projectIdBySlug } from "../db/queries.ts";
import { fileStyleGuideDraft } from "../db/style-guide-drafts.ts";
import type { Store } from "../db/store.ts";
import { SLUG } from "./file-entries.ts";

/**
 * The wire schema is loose on purpose, for the same reason as `file_entries`: a plain z.object
 * would strip a misspelled top-level key (`banned_word`) before the handler saw it, and the guide
 * would file with none of the words it was meant to ban. The handler re-parses against the strict
 * twin and refuses the key by name, with the fix.
 */
const FileStyleGuideShape = {
  project: z
    .string()
    .min(1)
    .describe(
      "The project slug to propose the guide for. It must exist: file an entry into it first if it doesn't. An unknown slug is refused and creates nothing.",
    ),
  markdown: z
    .string()
    .describe(
      "The proposed guide markdown: the project's own rules, which render below the global guide once published. Stored raw, never trimmed.",
    ),
  banned_words: z
    .array(z.string().min(1))
    .refine((words) => new Set(words).size === words.length, "banned words must be unique")
    .optional()
    .describe("Words the project's copy must never use, as unique non-empty strings. Omit it (or send []) to propose none."),
  // Held loose like file_entries's context and constraints: a zod record (or any plain-object
  // accumulator) swallows a `__proto__` term through the Object.prototype setter (measured on
  // this zod), so the object is typed and accumulated at the handler, where the refusal can name
  // the key and the fix.
  glossary: z
    .unknown()
    .optional()
    .describe(
      "Project terms as an object of term: definition. A term the global glossary also defines resolves to this project's definition once published. Omit it (or send {}) to propose none.",
    ),
};
const FileStyleGuideArgs = z.looseObject(FileStyleGuideShape);

/** Strict twin of the wire shape: the handler re-parses against it to refuse an unrecognized top-level key by name. */
const StrictFileStyleGuideArgs = z.strictObject(FileStyleGuideShape);

const FiledDraftOutput = z.object({
  project: z.string(),
  status: z.literal("draft"),
});

/** A refusal is an ordinary thrown Error: the SDK answers it as a tool result with `isError: true`, never as a json-rpc protocol error. */
function refuse(where: string, problem: string, fix: string): never {
  throw new Error(`file_style_guide refused: ${where}: ${problem}. fix: ${fix}`);
}

/**
 * Types the caller's glossary object. An empty key names no term — the merge renders it as no
 * item, so accepting one would drop the definition the caller sent — and a non-string value would
 * store a definition the dashboard renders as something it is not; both refuse. The accumulator is
 * null-prototype so a `__proto__` term stores as an own key, matching the dashboard form's parse
 * and the merge's render.
 */
function validateGlossary(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    refuse(
      "glossary",
      `glossary must be an object of term: definition, got ${JSON.stringify(raw)?.slice(0, 60)}`,
      'send an object such as {"widget": "the widget slot"}, or omit glossary',
    );
  }
  const glossary: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "") {
      refuse("glossary", "a glossary key is the empty string, and the merge would render it as no term", "give every term at least one character");
    }
    if (typeof value !== "string") {
      // repr the key: a raw one can carry a newline or quote into the model-facing message and
      // forge a "fix:" clause (the same escape file-entries.ts applies to unrecognized keys).
      refuse(
        `glossary.${JSON.stringify(key)}`,
        `a glossary definition must be a string, got ${JSON.stringify(value)?.slice(0, 60)}`,
        `send glossary.${JSON.stringify(key)} as a string, or drop the term`,
      );
    }
    glossary[key] = value;
  }
  return glossary;
}

/**
 * Registers the contract's sixth tool: a project style guide proposal. It writes a draft row and
 * nothing else — the tool has no path to `style_guides`, which is what keeps a proposal inert
 * until the dashboard's human action publishes or rewrites it. A project is never minted here:
 * only `file_entries` creates projects, so an unknown slug is refused by name.
 */
export function registerFileStyleGuideTool(server: McpServer, store: Store): void {
  server.registerTool(
    "file_style_guide",
    {
      title: "Propose a project style guide",
      description:
        "Propose a style guide for a project: its markdown rules, banned words, and glossary, filed as a draft for the human to approve, edit, or discard on the dashboard. A draft never changes what agents read — the style-guide resource and fetch_approved's rider keep serving the approved guide until the human publishes this one. One draft per project: filing again replaces the standing proposal. Only a project guide can be proposed; the global guide has no drafts.",
      inputSchema: FileStyleGuideArgs,
      outputSchema: FiledDraftOutput,
    },
    async (args) => {
      const strict = StrictFileStyleGuideArgs.safeParse(args);
      if (!strict.success) {
        const keys = strict.error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : []));
        refuse(
          "arguments",
          `unrecognized key(s) ${keys.map((k) => JSON.stringify(k).slice(0, 60)).join(", ")}`,
          "file_style_guide takes only project, markdown, banned_words, and glossary; drop the extra key or spell it snake_case",
        );
      }

      if (!SLUG.test(args.project)) {
        refuse(
          `project "${args.project}"`,
          "a project slug is 1-63 chars of lowercase letters, digits, and inner hyphens",
          'lower-case the name and separate words with hyphens, e.g. "my-app"',
        );
      }

      if (projectIdBySlug(store, args.project) === null) {
        refuse(
          `project "${args.project}"`,
          "no such project, and a proposal never creates one",
          "file an entry into it with file_entries first, then file the guide again",
        );
      }

      fileStyleGuideDraft(store, args.project, {
        markdown: args.markdown,
        bannedWords: args.banned_words ?? [],
        glossary: validateGlossary(args.glossary),
      });

      const output = { project: args.project, status: "draft" as const };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
