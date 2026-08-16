import type { Config } from "./config.ts";

/** The debounce window: filings for one project inside it merge into a single ping per transport. */
const DEFAULT_WINDOW_MS = 1000;

/** Every ping's deadline; a hung transport can hold nothing, since the ping itself is fire-and-forget. */
const PING_TIMEOUT_MS = 5_000;

/**
 * Everything a notification run needs, all injectable for tests: `config` arms the transports,
 * `baseUrl` builds the dashboard link, and `fetch`/`windowMs` let a test point pings at real local
 * servers and collapse bursts quickly.
 */
export type NotifierOptions = {
  config: Config;
  baseUrl: string;
  fetch?: typeof fetch;
  windowMs?: number;
};

/** One project's merged filings waiting out the debounce window. */
type Pending = {
  count: number;
  batchId: string;
  timer: Timer;
};

/**
 * Fires filing notifications for `file_entries`. Debounce is trailing, keyed per project slug:
 * each `notifyBatch` inside the window replaces the timer and merges into the pending ping (count
 * sums, batch id goes latest), so an agent loop re-filing a burst lands as one ping at window end.
 *
 * Delivery is fire-and-forget: `notifyBatch` returns immediately, and a failing transport logs to
 * stderr naming itself — it can never touch the filing result. The timer is unref'd, so a pending
 * ping never holds the daemon open at shutdown; `dispose()` cancels it outright. All timing lives
 * here: nothing upstream waits on or measures a window.
 */
export class Notifier {
  readonly #config: Config;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #windowMs: number;
  readonly #pending = new Map<string, Pending>();

  constructor(options: NotifierOptions) {
    this.#config = options.config;
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * Called after a filing that changed the store: the caller (file_entries) computes `count` from
   * its results and only calls here for a batch that created or updated at least one entry, so a
   * zero count never arrives. Silent when every transport is unarmed.
   */
  notifyBatch(project: string, batchId: string, count: number): void {
    // Guard on the real arming conditions, not just the urls: a topic-less ntfy url arms nothing,
    // and a timer armed for a transport that can never ping is dead work per filing. The config is
    // fixed for the daemon's life, so this never flips mid-debounce.
    const ntfyArmed = this.#config.NTFY_URL !== undefined && this.#config.NTFY_TOPIC !== undefined;
    if (!ntfyArmed && this.#config.WEBHOOK_URL === undefined) return;

    const existing = this.#pending.get(project);
    if (existing !== undefined) {
      existing.count += count;
      existing.batchId = batchId;
      // The callback captures its values at arm time, and clearing the stale timer guarantees it
      // never fires, so the one live timer always carries the merged count and batch id.
      clearTimeout(existing.timer);
      existing.timer = this.#arm(project, existing.count, existing.batchId);
      return;
    }
    this.#pending.set(project, { count, batchId, timer: this.#arm(project, count, batchId) });
  }

  /** Cancels every pending debounce. The stop path calls this before closing the store. */
  dispose(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
  }

  #arm(project: string, count: number, batchId: string): Timer {
    const timer = setTimeout(() => {
      this.#pending.delete(project);
      this.#ping(project, batchId, count);
    }, this.#windowMs);
    // A pending ping dropped at exit is acceptable, so the timer must never hold the process open.
    timer.unref();
    return timer;
  }

  #ping(project: string, batchId: string, count: number): void {
    const dashboardUrl = `${this.#baseUrl}/?project=${encodeURIComponent(project)}`;
    void this.#pingNtfy(project, count, dashboardUrl);
    void this.#pingWebhook(project, batchId, count, dashboardUrl);
  }

  async #pingNtfy(project: string, count: number, dashboardUrl: string): Promise<void> {
    const url = this.#config.NTFY_URL;
    const topic = this.#config.NTFY_TOPIC;
    // ntfy is armed only when both are set; a url alone posts to a topic named nothing.
    if (url === undefined || topic === undefined) return;
    const noun = count === 1 ? "entry" : "entries";
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          Topic: topic,
          Title: `reviewzy: ${project}`,
          Priority: String(this.#config.NTFY_PRIORITY),
          Click: dashboardUrl,
        },
        body: `${count} new ${noun} from ${project} await review`,
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(`reviewzy: ntfy notification failed: server answered ${response.status}`);
      }
    } catch (error) {
      console.error(`reviewzy: ntfy notification failed: ${(error as Error).message}`);
    }
  }

  async #pingWebhook(project: string, batchId: string, count: number, dashboardUrl: string): Promise<void> {
    const url = this.#config.WEBHOOK_URL;
    if (url === undefined) return;
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, batch_id: batchId, count, dashboard_url: dashboardUrl }),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(`reviewzy: webhook notification failed: server answered ${response.status}`);
      }
    } catch (error) {
      console.error(`reviewzy: webhook notification failed: ${(error as Error).message}`);
    }
  }
}
