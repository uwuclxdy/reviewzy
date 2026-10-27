import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { openStore } from "../../src/db/store.ts";

const tempDirs: string[] = [];

function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-notfound-"));
  tempDirs.push(dir);
  const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
  const store = openStore(config);
  const app = createApp(config, store);
  return {
    get: (path: string) => app.request(path),
    close: () => store.close(),
  };
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("unknown routes", () => {
  test("a GET to a path no route serves answers the themed not-found page", async () => {
    const app = serveApp();
    try {
      const res = await app.get("/definitely-not-a-route");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")?.startsWith("text/html")).toBe(true);
      const body = await res.text();
      expect(body).toContain('<html lang="en" data-theme="dark">');
      expect(body).toContain("<title>Entry not found · reviewzy</title>");
    } finally {
      app.close();
    }
  });
});
