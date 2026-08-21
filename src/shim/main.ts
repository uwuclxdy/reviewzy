import * as readline from "node:readline";
import { loadConfig } from "../config.ts";
import { ensureDaemon } from "./daemon.ts";
import { lockfilePath } from "./lockfile.ts";
import { VERSION } from "../version.ts";

/**
 * The shim owns zero protocol logic: one stdin JSON-RPC line in, one POST to the daemon's `/mcp`,
 * the daemon's answer back out on stdout. The only interpretation it does is mechanical transport
 * mapping, because the Streamable HTTP transport demands headers a stdio frame does not carry:
 * `Mcp-Method` from the frame's method, `MCP-Protocol-Version` from its `_meta` revision,
 * `Mcp-Name` from `params.name`/`params.uri` on the named calls, and an SSE answer from the legacy
 * leg unwrapped into its `data:` frames. Validation of all of it stays server-side, where the
 * security control lives.
 */
type LooseFrame = {
  method?: unknown;
  params?: { _meta?: Record<string, unknown>; name?: unknown; uri?: unknown } | undefined;
};

const NAMED_METHODS = new Set(["tools/call", "prompts/get"]);

/**
 * The header sentinel the transport spec defines for values that cannot be plain ASCII. Tool names
 * are only SHOULD-constrained to header-safe characters, so this is a real case, not decoration.
 */
function headerValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function deriveHeaders(frame: LooseFrame | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (frame === undefined || typeof frame.method !== "string") return headers;

  headers["mcp-method"] = frame.method;

  const meta = frame.params?._meta;
  const revision = meta?.["io.modelcontextprotocol/protocolVersion"];
  if (typeof revision === "string") headers["mcp-protocol-version"] = revision;

  const name = NAMED_METHODS.has(frame.method)
    ? frame.params?.name
    : frame.method === "resources/read"
      ? frame.params?.uri
      : undefined;
  if (typeof name === "string") headers["mcp-name"] = headerValue(name);

  return headers;
}

/**
 * A transport failure must still reach the client as a JSON-RPC frame (stdout carries frames
 * only), carrying the request's own id so the client can match it. A notification gets silence:
 * the protocol never answers one, not even with an error.
 */
function transportError(frame: LooseFrame | undefined, message: string): string | null {
  // A notification is the ABSENCE of the `id` key; reading `id === null` as "no id" would answer
  // an error frame to a message the protocol says can never be answered.
  const isNotification = frame === undefined || !("id" in frame);
  if (isNotification) {
    console.error(`reviewzy: ${message} (notification dropped)`);
    return null;
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id: (frame as { id: unknown }).id,
    error: { code: -32603, message },
  });
}

/**
 * Forwards one stdin line. Returns the response frame to write, or null when nothing may be
 * written: a notification the daemon accepted, or any body-less reply.
 */
export async function forwardLine(line: string, port: number, token?: string): Promise<string | null> {
  let frame: LooseFrame | undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null) frame = parsed as LooseFrame;
  } catch {
    // Not JSON: the daemon is the validator, and its error frame is the client's answer.
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...deriveHeaders(frame),
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body: line });
  } catch (error) {
    return transportError(frame, `daemon unreachable on port ${port}: ${(error as Error).message}`);
  }

  // `202 Accepted` is the transport's "notification received": no response frame exists for it.
  if (response.status === 202) return null;

  const text = await response.text();
  // A 200 with an empty body answers nothing; for a request, that is a transport error, not
  // silence (a notification still gets silence, since transportError drops those).
  if (text === "") {
    return transportError(frame, `daemon replied http ${response.status} with an empty body`);
  }

  // The legacy leg answers every request as an SSE body: a stateless server has no session to
  // hang a follow-up GET stream on, so the transport frames the reply inline. stdout carries
  // JSON-RPC frames only, so each event's `data:` payload is relayed as its own line; events
  // without data (comments, keep-alives) carry no frame and are skipped.
  if ((response.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    const frames: string[] = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).replace(/^ /, ""));
      if (data.length > 0) frames.push(data.join("\n"));
    }
    if (frames.length === 0) {
      return transportError(frame, `daemon replied http ${response.status} with an sse body carrying no data frame`);
    }
    return frames.join("\n");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return transportError(frame, `daemon replied http ${response.status} with a non-json body`);
  }
  if (typeof parsed === "object" && parsed !== null && "jsonrpc" in parsed) return text;

  // E.g. the daemon's 401 OAuth challenge body: a real reply, but not a frame; stdout must never
  // carry it raw.
  return transportError(frame, `daemon replied http ${response.status} with a non-json-rpc body`);
}

/**
 * The published stdio entrypoint. Establishes the singleton daemon, then bridges stdin to it one
 * line at a time until stdin closes; the daemon is detached, so it outlives the shim. All logging
 * goes to stderr — stdout belongs to the protocol.
 */
export async function runShim(): Promise<void> {
  const config = loadConfig();

  // A client that vanished mid-session turns stdout writes into EPIPE; without a handler that is
  // an uncaught exception and a crash, and the daemon the shim bridged is left running with nobody
  // told. Draining to stdin EOF and exiting cleanly is the portable shutdown.
  process.stdout.on("error", () => {});

  const handle = await ensureDaemon({
    lockfile: lockfilePath(process.env),
    port: config.REVIEWZY_PORT,
    shimVersion: VERSION,
    token: config.REVIEWZY_TOKEN,
    dev: config.REVIEWZY_DEV === "1",
    env: process.env,
  });
  console.error(
    `reviewzy: shim ${VERSION} bridging stdio to daemon ${handle.version} (pid ${handle.pid}, port ${handle.port})`,
  );

  const lines = readline.createInterface({ input: process.stdin, terminal: false });

  // stdin EOF is the shim's exit signal, but an in-flight request must finish first: exiting the
  // instant the pipe closes would drop a response frame for a request the client already sent.
  let pending = 0;
  lines.on("line", (line: string) => {
    if (line.trim() === "") return;
    pending += 1;
    void forwardLine(line, handle.port, config.REVIEWZY_TOKEN)
      .then((frame) => {
        if (frame !== null) process.stdout.write(`${frame}\n`);
      })
      .catch((error: unknown) => {
        console.error(`reviewzy: forwarding failed: ${(error as Error).message}`);
      })
      .finally(() => {
        pending -= 1;
      });
  });

  await new Promise<void>((resolve) => lines.once("close", () => resolve()));
  const deadline = Date.now() + 5_000;
  while (pending > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The daemon stays up for the next session; only the bridge goes away.
  process.exit(0);
}

