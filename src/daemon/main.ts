#!/usr/bin/env bun
import { ConfigError, HOST, loadConfig, startupWarnings } from "../config.ts";
import { openStore } from "../db/store.ts";
import { VERSION } from "../version.ts";
import { createApp } from "./app.ts";

/**
 * Boots the daemon: opens the store first so a bad db fails before a port is bound, then serves.
 * Returns both so a caller (tests, the shim) can shut them down.
 */
export function startDaemon(config = loadConfig()) {
  for (const warning of startupWarnings(config)) {
    console.error(`reviewzy: warning: ${warning}`);
  }

  const store = openStore(config);

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: HOST,
      port: config.REVIEWZY_PORT,
      fetch: createApp(config).fetch,
    });
  } catch (error) {
    // A bind failure (e.g. a shim racing an already-running daemon on the same port) must not
    // leak the store's open sqlite connection.
    store.close();
    throw error;
  }

  // The bound port, not `config.baseUrl`: a port-0 boot resolves to something the config never held.
  console.error(`reviewzy ${VERSION} listening on http://${HOST}:${server.port} (pid ${process.pid})`);
  return { server, store };
}

if (import.meta.main) {
  let daemon: ReturnType<typeof startDaemon>;
  try {
    daemon = startDaemon();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  // Graceful only (`false`): waits out in-flight requests before closing the store and exiting.
  // The real drain protocol (resolving in-flight long-polls, versioned handoff) is queue task 4.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await daemon.server.stop(false);
      daemon.store.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
