import { Hono } from "hono";
import type { Config } from "../config.ts";
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
export function createApp(_config: Config, startedAt: Date = new Date()): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json<HealthBody>({
      name: NAME,
      version: VERSION,
      pid: process.pid,
      startedAt: startedAt.toISOString(),
    }),
  );

  return app;
}
