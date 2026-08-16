import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const defaultDbPath = () =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "reviewzy", "reviewzy.db");

/** Every value the daemon reads from the environment. `.env.example` mirrors this list. */
const ConfigSchema = z.object({
  REVIEWZY_PORT: z.coerce.number().int().min(1).max(65535).default(3123),
  REVIEWZY_DB: z.string().min(1).default(defaultDbPath),
  REVIEWZY_BASE_URL: z.url().optional(),

  REVIEWZY_TOKEN: z.string().min(1).optional(),
  DASHBOARD_PASSWORD: z.string().min(1).optional(),

  ARCHIVE_AFTER_DAYS: z.coerce.number().int().min(1).default(90),

  NTFY_URL: z.url().optional(),
  NTFY_TOPIC: z.string().min(1).optional(),
  NTFY_PRIORITY: z.coerce.number().int().min(1).max(5).default(3),
  WEBHOOK_URL: z.url().optional(),
});

export type Config = z.infer<typeof ConfigSchema> & { host: string; baseUrl: string };

/** The daemon binds loopback unconditionally, so a missing credential can never expose a network surface. */
export const HOST = "127.0.0.1";

/** Refuses to start on a bad value rather than silently falling back to a default. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // An empty string in the environment is an unset variable, not a value that fails `min(1)`.
  const present = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );

  const parsed = ConfigSchema.safeParse(present);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`reviewzy: bad environment configuration\n${detail}\nfix the named variable in .env, or unset it to take the default.`);
  }

  return {
    ...parsed.data,
    host: HOST,
    baseUrl: parsed.data.REVIEWZY_BASE_URL ?? `http://${HOST}:${parsed.data.REVIEWZY_PORT}`,
  };
}

/** Bad input from the operator, distinct from a bug in the daemon. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Written to stderr at boot. Empty when both credentials are set. */
export function startupWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (!config.REVIEWZY_TOKEN) {
    warnings.push(
      "REVIEWZY_TOKEN is unset: the mcp endpoint accepts any request from this machine. set it in .env to require a bearer token.",
    );
  }
  if (!config.DASHBOARD_PASSWORD) {
    warnings.push(
      "DASHBOARD_PASSWORD is unset: the dashboard is open to any process on this machine. set it in .env to require a login.",
    );
  }
  if (config.NTFY_URL !== undefined && config.NTFY_TOPIC === undefined) {
    warnings.push(
      "NTFY_TOPIC is unset: ntfy notifications stay off even though NTFY_URL is set. set NTFY_TOPIC in .env to arm them.",
    );
  }
  return warnings;
}
