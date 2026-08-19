import { describe, expect, test } from "bun:test";
import { ConfigError, HOST, loadConfig, startupWarnings } from "../src/config.ts";

describe("loadConfig", () => {
  test("applies documented defaults when nothing is set", () => {
    const config = loadConfig({});
    expect(config.REVIEWZY_PORT).toBe(3123);
    expect(config.ARCHIVE_AFTER_DAYS).toBe(90);
    expect(config.NTFY_PRIORITY).toBe(3);
    expect(config.REVIEWZY_DB).toMatch(/reviewzy\.db$/);
    expect(config.host).toBe(HOST);
    expect(config.baseUrl).toBe("http://127.0.0.1:3123");
  });

  test("treats an empty variable as unset rather than as a bad value", () => {
    const config = loadConfig({ REVIEWZY_TOKEN: "", REVIEWZY_PORT: "" });
    expect(config.REVIEWZY_TOKEN).toBeUndefined();
    expect(config.REVIEWZY_PORT).toBe(3123);
  });

  test("refuses a bad port, naming the variable", () => {
    expect(() => loadConfig({ REVIEWZY_PORT: "99999" })).toThrow(ConfigError);
    expect(() => loadConfig({ REVIEWZY_PORT: "99999" })).toThrow(/REVIEWZY_PORT/);
  });

  test("refuses a non-url base url, naming the variable", () => {
    expect(() => loadConfig({ REVIEWZY_BASE_URL: "not a url" })).toThrow(/REVIEWZY_BASE_URL/);
  });

  test("an explicit base url overrides the loopback default", () => {
    const config = loadConfig({ REVIEWZY_BASE_URL: "https://copy.example.com" });
    expect(config.baseUrl).toBe("https://copy.example.com");
  });

  test("REVIEWZY_DEV is unset by default and accepts only `1`", () => {
    expect(loadConfig({}).REVIEWZY_DEV).toBeUndefined();
    expect(loadConfig({ REVIEWZY_DEV: "" }).REVIEWZY_DEV).toBeUndefined();
    expect(loadConfig({ REVIEWZY_DEV: "1" }).REVIEWZY_DEV).toBe("1");
    expect(() => loadConfig({ REVIEWZY_DEV: "0" })).toThrow(/REVIEWZY_DEV/);
  });
});

describe("startupWarnings", () => {
  test("warns once per unset credential", () => {
    const warnings = startupWarnings(loadConfig({}));
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("REVIEWZY_TOKEN");
    expect(warnings.join("\n")).toContain("DASHBOARD_PASSWORD");
  });

  test("stays silent once both credentials are set", () => {
    const config = loadConfig({ REVIEWZY_TOKEN: "t", DASHBOARD_PASSWORD: "p" });
    expect(startupWarnings(config)).toEqual([]);
  });
});
