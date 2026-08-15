import { Hono } from "hono";
import type { Config } from "../config.ts";
import { mountMcp, originGate } from "../mcp/route.ts";
import { NAME, VERSION } from "../version.ts";

export type HealthBody = {
  name: string;
  version: string;
  pid: number;
  startedAt: string;
};

/**
 * The shim reads `/health` to decide whether a lockfile's daemon is live and whether it
 * outranks the shim's own version, so `version` and `pid` are a contract, not diagnostics.
 */
export function createApp(config: Config, startedAt: Date = new Date()): Hono {
  const app = new Hono();

  // App-wide because `docs/design.md` makes Origin validation unconditional rather than per-route:
  // `/health` hands out a pid and a version, and the dashboard mounts on this app later. An absent
  // `Origin` passes, so the shim's liveness probe is unaffected; only a browser sends one at all.
  app.use(originGate(config));

  app.get("/health", (c) =>
    c.json<HealthBody>({
      name: NAME,
      version: VERSION,
      pid: process.pid,
      startedAt: startedAt.toISOString(),
    }),
  );

  mountMcp(app, config);

  return app;
}
