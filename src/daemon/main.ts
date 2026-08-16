#!/usr/bin/env bun
import { ConfigError, HOST, loadConfig, startupWarnings } from "../config.ts";
import { SWEEP_INTERVAL_MS, sweepArchive } from "../db/sweep.ts";
import { openStore } from "../db/store.ts";
import { Notifier } from "../notify.ts";
import { VERSION } from "../version.ts";
import { createApp } from "./app.ts";

/**
 * Boots the daemon: opens the store first so a bad db fails before a port is bound, then serves.
 * Returns the server, store, notifier, and sweep timer so a caller (tests, the shim) can shut
 * them down. `hooks.onDrain` is what the `/drain` route hands off to; omitting it leaves the
 * route refusing new requests without ending the process, which is exactly what an in-process
 * test wants.
 */
export function startDaemon(
  config = loadConfig(),
  hooks: { onDrain?: () => void | Promise<void> } = {},
  sweepIntervalMs = SWEEP_INTERVAL_MS,
) {
  for (const warning of startupWarnings(config)) {
    console.error(`reviewzy: warning: ${warning}`);
  }

  const store = openStore(config);
  // Built here rather than inside `createApp` so the stop path below can dispose it: the debounce
  // timers are unref'd and could never hold the daemon open, but a pending ping cancelled at
  // shutdown is cleaner than one racing the store's close.
  const notifier = new Notifier({ config, baseUrl: config.baseUrl });

  // Unref'd like the notifier's timers, so a pending tick can never hold the daemon open. The
  // stop path clears it before the store closes, so no tick fires on a closed database.
  const sweepTimer = setInterval(
    () => sweepArchive(store, Date.now(), config.ARCHIVE_AFTER_DAYS),
    sweepIntervalMs,
  );
  sweepTimer.unref();

  let server: ReturnType<typeof Bun.serve>;
  try {
    // One sweep before the port binds, so the dashboard never serves a queue the retention
    // window has already retired. A failure lands in the same catch as a bind failure and
    // closes the store either way, so neither leak.
    sweepArchive(store, Date.now(), config.ARCHIVE_AFTER_DAYS);
    server = Bun.serve({
      hostname: HOST,
      port: config.REVIEWZY_PORT,
      fetch: createApp(config, store, new Date(), hooks.onDrain, notifier).fetch,
    });
  } catch (error) {
    // A bind failure (e.g. a shim racing an already-running daemon on the same port) must not
    // leak the store's open sqlite connection, and the armed sweep timer must not outlive it.
    clearInterval(sweepTimer);
    store.close();
    throw error;
  }

  // The bound port, not `config.baseUrl`: a port-0 boot resolves to something the config never held.
  console.error(`reviewzy ${VERSION} listening on http://${HOST}:${server.port} (pid ${process.pid})`);
  return { server, store, notifier, sweepTimer };
}

if (import.meta.main) {
  let daemon: ReturnType<typeof startDaemon>;
  try {
    // The drain hook closes over `stop`, which is declared below it: a function declaration is
    // hoisted, and the hook only ever runs after `startDaemon` has returned, so the shutdown it
    // names is always the daemon that just booted.
    daemon = startDaemon(loadConfig(), { onDrain: () => stop() });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  // Graceful only (`false`): waits out in-flight requests before closing the store and exiting.
  // SIGINT, SIGTERM, and the `/drain` route all land here, so a handoff drain and an operator's
  // Ctrl-C shut down through one path.
  let stopping = false;
  function stop(): void {
    if (stopping) return;
    stopping = true;
    void (async () => {
      // An in-flight await_approved long-poll must flush before the graceful stop waits it out:
      // the /drain route resolves waiters for the same reason, and an operator's Ctrl-C would
      // otherwise hold the daemon up for the whole remaining wait.
      daemon.store.resolveInFlightWaiters();
      await daemon.server.stop(false);
      // Cleared before the store closes: an armed tick firing on a closed database would crash.
      clearInterval(daemon.sweepTimer);
      // After the server stops, nothing can arm a new debounce, so this cancels exactly the set
      // in-flight filings left behind; an in-flight ping already past its window still races the
      // close, which is the accepted "dropped at exit" case.
      daemon.notifier.dispose();
      daemon.store.close();
      process.exit(0);
    })();
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
