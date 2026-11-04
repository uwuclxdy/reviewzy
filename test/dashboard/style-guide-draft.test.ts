import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { fileEntries } from "../../src/db/queries.ts";
import type { NewEntry } from "../../src/db/queries.ts";
import {
  discardStyleGuideDraft,
  fileStyleGuideDraft,
  readStyleGuideDraft,
  styleGuideDraftFingerprint,
} from "../../src/db/style-guide-drafts.ts";
import { readStyleGuideSection, upsertStyleGuide } from "../../src/db/style-guide.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

const tempDirs: string[] = [];

const PASSWORD = "correct horse battery staple";

/** One app with its own temp-file store per test; the password defaults to unset (open dashboard). */
function openEnv(setPassword = false) {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-style-guide-draft-"));
  tempDirs.push(dir);
  const env: Record<string, string> = { REVIEWZY_DB: join(dir, "reviewzy.db") };
  if (setPassword) env.DASHBOARD_PASSWORD = PASSWORD;
  const config = loadConfig(env);
  const store = openStore(config);
  const app = createApp(config, store);
  return {
    store,
    get: (path: string) => app.request(path),
    post: (path: string, body: FormData, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", body, headers }),
    close: () => store.close(),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const FIXTURE: NewEntry = {
  repo: "https://example.com/org/repo.git",
  file: "docs/setup.md",
  title: null,
  tag: null,
  anchorText: "Run bun install",
  anchorBefore: "Run this before anything else.",
  anchorAfter: "Then run the tests.",
  anchorHash: "h-draft",
  fileHash: "f-draft",
  agentDraft: "Fix the wording of the setup section.",
  contextJson: JSON.stringify({}),
  constraintsJson: JSON.stringify({}),
  imagesJson: null,
};

/** Creates a project the way entries do: a filing auto-mints it, and a proposal never mints one. */
function projectWith(env: { store: Store }, slug: string): void {
  fileEntries(env.store, slug, "probe-agent", [FIXTURE]);
}

const PROPOSAL = {
  markdown: "Proposed rules.",
  bannedWords: ["utilize"],
  glossary: { widget: "the widget slot" },
};

/** What an agent's re-file leaves standing: different bytes under the same one-row-per-project slot. */
const REPLACED = {
  markdown: "Re-filed rules.",
  bannedWords: ["leverage"],
  glossary: { banner: "top strip" },
};

/** The fingerprint the proposal card carries, read the way the view model reads the standing draft. */
function standingFingerprint(store: Store, slug: string): string {
  const draft = readStyleGuideDraft(store, slug);
  if (draft === null) throw new Error(`no standing draft for ${slug}`);
  return styleGuideDraftFingerprint(draft);
}

/** The fingerprint value the page actually renders, extracted from the card form's hidden field —
 * so a render regression (an empty field, a fingerprint of the wrong input) reds here, not on a
 * human. */
async function renderedFingerprint(env: { get: (path: string) => Response | Promise<Response> }, slug: string): Promise<string> {
  const html = await (await env.get(`/style-guide?project=${slug}`)).text();
  const match = /name="draft_fingerprint" value="([^"]*)"/.exec(html);
  expect(match, "the rendered page carries a draft_fingerprint hidden field").not.toBeNull();
  return match![1]!;
}

/** The draft action's POST body: the hidden fields the proposal card renders. */
function draftForm(project: string, fingerprint?: string): FormData {
  const form = new FormData();
  form.set("project", project);
  if (fingerprint !== undefined) form.set("draft_fingerprint", fingerprint);
  return form;
}

/** The save form the section editor posts: `project` empty means the global section. */
function guideForm(over: { project?: string; markdown?: string; glossary?: string; draftFingerprint?: string } = {}): FormData {
  const form = new FormData();
  form.set("project", over.project ?? "");
  if (over.draftFingerprint !== undefined) form.set("draft_fingerprint", over.draftFingerprint);
  form.set("markdown", over.markdown ?? "");
  form.set("banned_words", "");
  form.set("glossary", over.glossary ?? "");
  return form;
}

/** The htmx marker, so a request is distinguishable from a plain navigation. */
const HX = { "HX-Request": "true" };

describe("the draft region", () => {
  test("a project with a proposal renders it beside the editor, prefilled from the proposal", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    upsertStyleGuide(env.store, "alpha", { markdown: "Live rules.", bannedWords: [], glossary: {} });
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);

    const res = await env.get("/style-guide?project=alpha");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Agent proposal");
    expect(html).toContain("Proposed rules.");
    expect(html).toContain("utilize");
    expect(html).toContain("widget: the widget slot");
    expect(html).toContain("Approve proposal");
    expect(html).toContain("Discard proposal");
    expect(html).toContain("/style-guide/draft/approve");
    expect(html).toContain("/style-guide/draft/discard");
    // The editor edits the proposal while one stands, never the live section under it.
    expect(html).toContain('name="markdown"');
    expect(html).toContain("Proposed rules.");
    expect(html).not.toContain("Live rules.");
    env.close();
  });

  test("the global section and a proposal-less project render no draft card", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);

    const globalPage = await (await env.get("/style-guide")).text();
    expect(globalPage).not.toContain("Agent proposal");

    projectWith(env, "beta");
    const betaPage = await (await env.get("/style-guide?project=beta")).text();
    expect(betaPage).not.toContain("Agent proposal");
    env.close();
  });

  test("agent-authored fields render escaped in the proposal card and the prefilled editor", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", {
      markdown: '<script>alert(1)</script>\n<img src=x onerror=alert(2)>',
      bannedWords: ["<b>utilize</b>"],
      glossary: { "pic<script>": "<img src=x onerror=alert(2)>" },
    });

    const html = await (await env.get("/style-guide?project=alpha")).text();
    // Every agent byte reaches the page as an entity, never as a tag: markdown, banned words,
    // and glossary all pass through escaped JSX children and attribute values.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain("&lt;b&gt;utilize&lt;/b&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("onerror=alert(2)>");
    env.close();
  });
});

describe("the draft actions", () => {
  test("approving publishes the proposal into the live section and clears it", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);

    const res = await env.post("/style-guide/draft/approve", draftForm("alpha", await renderedFingerprint(env, "alpha")), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Proposal approved");
    expect(html).not.toContain("Agent proposal");

    expect(readStyleGuideSection(env.store, "alpha")).toEqual(PROPOSAL);
    expect(readStyleGuideDraft(env.store, "alpha")).toBeNull();
    env.close();
  });

  test("a plain approve redirects back to the project's section", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);

    const res = await env.post("/style-guide/draft/approve", draftForm("alpha", standingFingerprint(env.store, "alpha")));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/style-guide?project=alpha");
    env.close();
  });

  test("discarding removes the proposal and leaves the live section alone", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    upsertStyleGuide(env.store, "alpha", { markdown: "Live rules.", bannedWords: [], glossary: {} });
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);

    const res = await env.post("/style-guide/draft/discard", draftForm("alpha", standingFingerprint(env.store, "alpha")), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Proposal discarded");
    expect(html).not.toContain("Agent proposal");

    expect(readStyleGuideDraft(env.store, "alpha")).toBeNull();
    expect(readStyleGuideSection(env.store, "alpha")).toEqual({ markdown: "Live rules.", bannedWords: [], glossary: {} });
    env.close();
  });

  test("approving with no proposal waiting refuses, and the live section is untouched", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    upsertStyleGuide(env.store, "alpha", { markdown: "Live rules.", bannedWords: [], glossary: {} });

    const res = await env.post("/style-guide/draft/approve", draftForm("alpha"), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Proposal not approved");

    expect(readStyleGuideSection(env.store, "alpha")).toEqual({ markdown: "Live rules.", bannedWords: [], glossary: {} });
    env.close();
  });

  test("the actions on an unknown project render the unknown-project notice", async () => {
    const env = openEnv();
    const res = await env.post("/style-guide/draft/approve", draftForm("nope"), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Project nope doesn&#39;t exist");
    expect(env.store.db.query("SELECT id FROM projects WHERE slug = 'nope'").all()).toEqual([]);
    env.close();
  });

  test("approving a proposal that re-filed after the page rendered refuses and publishes nothing", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);
    const seenFingerprint = standingFingerprint(env.store, "alpha");
    // The re-file updates the standing row in place, so this is the guard the row id cannot give.
    fileStyleGuideDraft(env.store, "alpha", REPLACED);

    const res = await env.post("/style-guide/draft/approve", draftForm("alpha", seenFingerprint), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Proposal not approved");
    expect(html).toContain("The proposal changed on disk");

    expect(readStyleGuideSection(env.store, "alpha")).toBeNull();
    expect(readStyleGuideDraft(env.store, "alpha")).toEqual(REPLACED);
    env.close();
  });

  test("discarding a proposal that re-filed after the page rendered refuses and drops nothing", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);
    const seenFingerprint = standingFingerprint(env.store, "alpha");
    fileStyleGuideDraft(env.store, "alpha", REPLACED);

    const res = await env.post("/style-guide/draft/discard", draftForm("alpha", seenFingerprint), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Proposal not discarded");
    expect(html).toContain("The proposal changed on disk");

    expect(readStyleGuideDraft(env.store, "alpha")).toEqual(REPLACED);
    env.close();
  });

  test("an action carrying no fingerprint refuses while a proposal stands", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);

    const res = await env.post("/style-guide/draft/approve", draftForm("alpha"), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Proposal not approved");
    expect(html).toContain("The proposal changed on disk");
    expect(readStyleGuideDraft(env.store, "alpha")).toEqual(PROPOSAL);
    env.close();
  });

  test("a fingerprint carried for a gone proposal answers no-proposal-waiting, not the stale notice", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);
    const seenFingerprint = standingFingerprint(env.store, "alpha");
    discardStyleGuideDraft(env.store, "alpha");

    const res = await env.post("/style-guide/draft/approve", draftForm("alpha", seenFingerprint), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No proposal is waiting");
    expect(html).not.toContain("The proposal changed on disk");
    env.close();
  });
});

describe("the save is the approval", () => {
  test("a section save writes the live guide and clears the standing proposal", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);

    const res = await env.post(
      "/style-guide/save",
      guideForm({ project: "alpha", markdown: "Human words.", draftFingerprint: await renderedFingerprint(env, "alpha") }),
      HX,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Guide saved");
    expect(html).not.toContain("Agent proposal");

    expect(readStyleGuideSection(env.store, "alpha")).toEqual({ markdown: "Human words.", bannedWords: [], glossary: {} });
    expect(readStyleGuideDraft(env.store, "alpha")).toBeNull();
    env.close();
  });

  test("a save against a proposal that re-filed mid-edit refuses, writing nothing", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);
    const seenFingerprint = standingFingerprint(env.store, "alpha");
    fileStyleGuideDraft(env.store, "alpha", REPLACED);

    const res = await env.post(
      "/style-guide/save",
      guideForm({ project: "alpha", markdown: "Human words.", draftFingerprint: seenFingerprint }),
      HX,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Guide not saved");
    expect(html).toContain("The proposal changed on disk");
    // The refusal keeps the human's typed words for another try.
    expect(html).toContain("Human words.");

    expect(readStyleGuideSection(env.store, "alpha")).toBeNull();
    expect(readStyleGuideDraft(env.store, "alpha")).toEqual(REPLACED);
    env.close();
  });

  test("a refused save leaves the standing proposal in place", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    fileStyleGuideDraft(env.store, "alpha", PROPOSAL);

    const res = await env.post(
      "/style-guide/save",
      guideForm({ project: "alpha", markdown: "Human words.", glossary: "just words" }),
      HX,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Guide not saved");
    expect(html).toContain("has no colon");

    expect(readStyleGuideSection(env.store, "alpha")).toBeNull();
    expect(readStyleGuideDraft(env.store, "alpha")).toEqual(PROPOSAL);
    env.close();
  });
});

describe("session guard", () => {
  test("the draft actions inherit the guard: unsigned posts are refused", async () => {
    const env = openEnv(true);
    const res = await env.post("/style-guide/draft/approve", draftForm("alpha"), HX);
    expect(res.status).toBe(401);
    expect(res.headers.get("HX-Redirect")).toBe("/login");
    env.close();
  });
});
