#!/usr/bin/env bun
import { ConfigError, HOST, loadConfig, startupWarnings } from "../config.ts";
import { VERSION } from "../version.ts";
import { createApp } from "./app.ts";

/** Boots the daemon. Returns the server so a caller (tests, the shim) can shut it down. */
export function startDaemon(config = loadConfig()) {
  for (const warning of startupWarnings(config)) {
    console.error(`reviewzy: warning: ${warning}`);
  }

  const server = Bun.serve({
    hostname: HOST,
    port: config.REVIEWZY_PORT,
    fetch: createApp(config).fetch,
  });

  // The bound port, not `config.baseUrl`: a port-0 boot resolves to something the config never held.
  console.error(`reviewzy ${VERSION} listening on http://${HOST}:${server.port} (pid ${process.pid})`);
  return server;
}

if (import.meta.main) {
  let server: ReturnType<typeof startDaemon>;
  try {
    server = startDaemon();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const stop = () => {
    void server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
