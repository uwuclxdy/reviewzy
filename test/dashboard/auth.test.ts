import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { mountDashboard } from "../../src/dashboard/mount.ts";
import { fileEntries } from "../../src/db/queries.ts";
import type { NewEntry } from "../../src/db/queries.ts";
import { openStore } from "../../src/db/store.ts";
import { mountMcp } from "../../src/mcp/route.ts";

const tempDirs: string[] = [];

const PASSWORD = "correct horse battery staple";

/**
 * One app with its own temp-file store per test. The password defaults to set; pass `false` for the
 * unset mode, where the dashboard must behave exactly as it does today.
 */
function openEnv(setPassword = true) {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-auth-"));
  tempDirs.push(dir);
  const env: Record<string, string> = { REVIEWZY_DB: join(dir, "reviewzy.db") };
  if (setPassword) env.DASHBOARD_PASSWORD = PASSWORD;
  const config = loadConfig(env);
  const store = openStore(config);
  const app = createApp(config, store);
  return {
    store,
    config,
    get: (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }),
    post: (path: string, body: FormData | null, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", ...(body === null ? {} : { body }), headers }),
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
  anchorText: "Run bun install",
  anchorBefore: "Run this before anything else.",
  anchorAfter: "Then run the tests.",
  anchorHash: "h-auth",
  fileHash: "f-auth",
  agentDraft: "Fix the wording of the setup section.",
  contextJson: JSON.stringify({ where: "setup docs" }),
  constraintsJson: JSON.stringify({}),
};

/** One app with a seeded draft; returns the env plus the entry id. */
function envWithDraft() {
  const env = openEnv();
  const batch = fileEntries(env.store, "alpha", "probe-agent", [FIXTURE]);
  return { env, id: batch.results[0]!.id };
}

/** The htmx marker, so a request is distinguishable from a plain navigation. */
const HX = { "HX-Request": "true" };

function loginForm(password: string, next: string | undefined = undefined): FormData {
  const form = new FormData();
  form.set("password", password);
  if (next !== undefined) form.set("next", next);
  return form;
}

function saveForm(text: string): FormData {
  const form = new FormData();
  form.set("text", text);
  return form;
}

/** The session cookie from a login response, or null when the response never set one. */
function sessionCookie(res: Response): string | null {
  const set = res.headers.getSetCookie().find((value) => value.startsWith("reviewzy_session="));
  return set === undefined ? null : set.split(";")[0]!;
}

/** Logs in and returns the cookie value, so a test can act as a signed-in client. */
async function signIn(env: ReturnType<typeof openEnv>): Promise<string> {
  const res = await env.post("/login", loginForm(PASSWORD));
  const cookie = sessionCookie(res);
  if (cookie === null) throw new Error("login did not set a session cookie");
  return cookie;
}

describe("guard with the password set", () => {
  test("GET pages redirect to the login, carrying the path as next", async () => {
    const { env, id } = envWithDraft();
    const list = await env.get("/");
    expect(list.status).toBe(303);
    expect(list.headers.get("location")).toBe("/login?next=%2F");
    const editor = await env.get(`/entries/${id}`);
    expect(editor.status).toBe(303);
    expect(editor.headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/entries/${id}`)}`);
    // The query string survives, so a login lands back on the same filter.
    const filtered = await env.get("/?q=wording");
    expect(filtered.status).toBe(303);
    expect(filtered.headers.get("location")).toBe("/login?next=%2F%3Fq%3Dwording");
    env.close();
  });

  test("htmx POSTs to editing routes are refused with 401 and HX-Redirect", async () => {
    const { env, id } = envWithDraft();
    const posts: [string, FormData][] = [
      [`/entries/${id}/save`, saveForm("prose")],
      [`/entries/${id}/approve`, new FormData()],
      [`/entries/${id}/reject`, new FormData()],
      ["/batch-approve", new FormData()],
    ];
    for (const [path, body] of posts) {
      const res = await env.post(path, body, HX);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("HX-Redirect"), path).toBe("/login");
      expect(res.headers.getSetCookie().length, path).toBe(0);
    }
    env.close();
  });

  test("a plain POST is refused with a 303 to the login", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/save`, saveForm("prose"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    env.close();
  });

  test("an htmx GET is refused like an htmx POST, so the login never swaps into the list", async () => {
    const env = openEnv();
    const res = await env.get("/", HX);
    expect(res.status).toBe(401);
    expect(res.headers.get("HX-Redirect")).toBe("/login");
    env.close();
  });

  test("static assets stay public", async () => {
    const env = openEnv();
    const res = await env.get("/static/tokens.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    env.close();
  });

  test("the mcp endpoint, health, and drain keep their own gates", async () => {
    const env = openEnv();
    // The mcp surface answers its own 405 for a wrong method, never the dashboard's login.
    const mcp = await env.get("/mcp");
    expect(mcp.status).toBe(405);
    const health = await env.get("/health");
    expect(health.status).toBe(200);
    const drain = await env.get("/drain");
    expect(drain.status).toBe(405);
    env.close();
  });

  test("the pass-through for mcp, health, and drain holds even when the guard mounts ahead of them", async () => {
    // `createApp` always mounts the mcp endpoint before the dashboard, so the guard never actually
    // reaches those paths and its exemptions for them are unreachable there. This arrangement puts
    // the guard first, which is the one that would break every agent session if the exemptions
    // were removed: the pass-through list is the guard's own contract, independent of mount order.
    const { config, store } = openEnv();
    const app = new Hono();
    mountDashboard(app, config, store);
    mountMcp(app, config, store);
    // Each of these would be a 303 to the login if the guard caught the request.
    expect((await app.request("/mcp")).status).toBe(405);
    expect((await app.request("/health")).status).toBe(404);
    expect((await app.request("/drain")).status).toBe(404);
    // The guard is live in this arrangement: the dashboard's own routes still refuse unsigned.
    expect((await app.request("/")).status).toBe(303);
    store.close();
  });

  test("a forged or malformed cookie is treated as absent, never an error", async () => {
    const { env } = envWithDraft();
    const real = await signIn(env);
    // Flip the payload's first character: still well-formed base64url, but the payload no longer
    // matches, so the constant check refuses it before the signature is ever verified.
    const forgedPayload = real[0] === "a" ? "b" + real.slice(1) : "a" + real.slice(1);
    // Flip a character in the signature half instead: the payload stays intact, so only the
    // signature check can catch this one.
    const dot = real.indexOf(".");
    const sigFirst = real[dot + 1]!;
    const forgedSig = real.slice(0, dot + 1) + (sigFirst === "a" ? "b" : "a") + real.slice(dot + 2);
    const byPayload = await env.get("/", { Cookie: forgedPayload });
    expect(byPayload.status).toBe(303);
    expect(byPayload.headers.get("location")).toBe("/login?next=%2F");
    const bySig = await env.get("/", { Cookie: forgedSig });
    expect(bySig.status).toBe(303);
    expect(bySig.headers.get("location")).toBe("/login?next=%2F");
    const byGarbage = await env.get("/", { Cookie: "reviewzy_session=not-a-cookie" });
    expect(byGarbage.status).toBe(303);
    const htmx = await env.post("/batch-approve", new FormData(), { ...HX, Cookie: forgedSig });
    expect(htmx.status).toBe(401);
    expect(htmx.headers.get("HX-Redirect")).toBe("/login");
    env.close();
  });
});

describe("login", () => {
  test("GET /login renders the password form, public", async () => {
    const env = openEnv();
    const res = await env.get("/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("navbar-brand");
    expect(html).toContain('<form method="post" action="/login"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('name="password"');
    expect(html).toContain("btn-primary");
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Wrong password");
    env.close();
  });

  test("a wrong password re-renders with one message, no cookie, and a cleared field", async () => {
    const env = openEnv();
    const res = await env.post("/login", loginForm("wrong-password"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Wrong password. Try again.");
    expect(html).not.toContain("wrong-password");
    expect(res.headers.getSetCookie().length).toBe(0);
    env.close();
  });

  test("the failure re-render keeps the next destination", async () => {
    const env = openEnv();
    const res = await env.post("/login", loginForm("wrong", "/entries/x"));
    const html = await res.text();
    expect(html).toContain('name="next" value="/entries/x"');
    env.close();
  });

  test("a correct password sets the session cookie and redirects", async () => {
    const env = openEnv();
    const res = await env.post("/login", loginForm(PASSWORD));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(sessionCookie(res)).not.toBeNull();
    // The cookie is a signed payload: two base64url halves joined by a dot.
    const cookie = sessionCookie(res)!;
    expect(cookie).toMatch(/^reviewzy_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const setCookie = res.headers.getSetCookie()[0]!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Max-Age"); // browser-session cookie
    expect(setCookie).not.toContain("Secure"); // loopback http only; a Secure cookie would never be sent there
    env.close();
  });

  test("the cookie passes the guard on the list, the editor, and an editing route", async () => {
    const { env, id } = envWithDraft();
    const cookie = await signIn(env);

    const list = await env.get("/", { Cookie: cookie });
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain("Entries");
    expect(listHtml).not.toContain("Sign in");

    const editor = await env.get(`/entries/${id}`, { Cookie: cookie });
    expect(editor.status).toBe(200);

    const save = await env.post(`/entries/${id}/save`, saveForm("Run the command to install."), {
      ...HX,
      Cookie: cookie,
    });
    expect(save.status).toBe(200);
    env.close();
  });

  test("next is honored for a local path", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post("/login", loginForm(PASSWORD, `/entries/${id}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/entries/${id}`);
    const cookie = sessionCookie(res)!;
    const editor = await env.get(`/entries/${id}`, { Cookie: cookie });
    expect(editor.status).toBe(200);
    env.close();
  });

  test("next cannot redirect off the dashboard", async () => {
    const env = openEnv();
    // The backslash is the interesting one: the URL parser rewrites it to a slash, so `/\evil.example`
    // would otherwise resolve to the off-dashboard authority `evil.example`.
    for (const evil of ["//evil.example", "https://evil.example", "///evil.example", "/\\evil.example"]) {
      const res = await env.post("/login", loginForm(PASSWORD, evil));
      expect(res.status, evil).toBe(303);
      expect(res.headers.get("location"), evil).toBe("/");
    }
    env.close();
  });

  test("a CRLF or an oversized next is rejected outright", async () => {
    const env = openEnv();
    // A CRLF would split the Location header if it ever reached the redirect; the length cap keeps
    // the value small enough for every header a browser will send. Both currently answer with "/",
    // and these pins keep them that way.
    const crlf = await env.post("/login", loginForm(PASSWORD, "/\r\nevil.example"));
    expect(crlf.status).toBe(303);
    expect(crlf.headers.get("location")).toBe("/");
    const long = await env.post("/login", loginForm(PASSWORD, "/" + "a".repeat(3000)));
    expect(long.status).toBe(303);
    expect(long.headers.get("location")).toBe("/");
    env.close();
  });

  test("a malformed login body re-renders the form, never a 500", async () => {
    const env = openEnv();
    // A JSON body (or any non-form content type) fails formData parsing; the route must treat it
    // as a failed attempt like any other, not crash into a 500 at the credential boundary.
    const res = await env.post("/login", null, { "content-type": "application/json" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Wrong password. Try again.");
    expect(res.headers.getSetCookie().length).toBe(0);
    env.close();
  });

  test("a login attempt costs at least the fixed delay, so failure cannot be timed apart from success", async () => {
    const env = openEnv();
    const t0 = performance.now();
    const res = await env.post("/login", loginForm("wrong"));
    const elapsed = performance.now() - t0;
    // A lower bound only: slowness cannot flake a lower-bound assert, but removing or shrinking
    // the delay turns this red.
    expect(elapsed).toBeGreaterThan(200);
    expect(res.status).toBe(200);
    env.close();
  });

  test("a next pointing back at the login page is not honored, so the redirect never loops", async () => {
    const env = openEnv();
    const cookie = await signIn(env);
    // Without the guard, GET /login?next=/login would redirect to itself forever.
    for (const next of ["%2Flogin", "%2Flogin%2F"]) {
      const res = await env.get(`/login?next=${next}`, { Cookie: cookie });
      expect(res.status, next).toBe(303);
      expect(res.headers.get("location"), next).toBe("/");
    }
    env.close();
  });

  test("the trailing-slash spellings of the auth routes work like the canonical ones", async () => {
    const env = openEnv();
    const form = await env.get("/login/");
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('<form method="post" action="/login"');
    expect(html).not.toContain("Wrong password");
    const cookie = await signIn(env);
    const logout = await env.post("/logout/", null, { Cookie: cookie });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("location")).toBe("/login");
    expect(logout.headers.getSetCookie()[0]).toContain("Max-Age=0");
    env.close();
  });

  test("GET /login while signed in redirects to next or the list", async () => {
    const env = openEnv();
    const cookie = await signIn(env);
    const plain = await env.get("/login", { Cookie: cookie });
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/");
    const next = await env.get("/login?next=%2Fentries%2Fx", { Cookie: cookie });
    expect(next.status).toBe(303);
    expect(next.headers.get("location")).toBe("/entries/x");
    env.close();
  });
});

describe("logout", () => {
  test("clears the cookie and returns to the login, and the guard is back in force", async () => {
    const env = openEnv();
    const cookie = await signIn(env);
    const res = await env.post("/logout", null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    const setCookie = res.headers.getSetCookie()[0]!;
    expect(setCookie).toContain("reviewzy_session=;");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    // The session is the cookie, so logout can only clear the browser's copy: replaying the old
    // value still passes the guard (no server-side revocation, by the no-boot-salt design), while
    // a browser that honored the clear is back at the login.
    const replay = await env.get("/", { Cookie: cookie });
    expect(replay.status).toBe(200);
    const after = await env.get("/");
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toBe("/login?next=%2F");
    env.close();
  });

  test("is idempotent when not signed in", async () => {
    const env = openEnv();
    const res = await env.post("/logout", null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
    env.close();
  });
});

describe("with the password unset", () => {
  test("the dashboard behaves exactly as before: open, with no login surface", async () => {
    const env = openEnv(false);
    const batch = fileEntries(env.store, "alpha", "probe-agent", [FIXTURE]);
    const id = batch.results[0]!.id;

    const list = await env.get("/");
    expect(list.status).toBe(200);
    const editor = await env.get(`/entries/${id}`);
    expect(editor.status).toBe(200);
    const save = await env.post(`/entries/${id}/save`, saveForm("Run the command to install."), HX);
    expect(save.status).toBe(200);

    const login = await env.get("/login");
    expect(login.status).toBe(404);
    const loginPost = await env.post("/login", loginForm("anything"));
    expect(loginPost.status).toBe(404);
    const logout = await env.post("/logout", null);
    expect(logout.status).toBe(404);
    env.close();
  });
});
