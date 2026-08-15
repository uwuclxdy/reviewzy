import { describe, expect, test } from "bun:test";
import { compareSemver, parseSemver } from "../../src/shim/semver.ts";

describe("parseSemver", () => {
  test("parses plain major.minor.patch", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
  });

  test("refuses anything that is not three dot-separated numbers", () => {
    expect(parseSemver("0.1")).toBeNull();
    expect(parseSemver("1.2.3.4")).toBeNull();
    expect(parseSemver("v0.1.0")).toBeNull();
    expect(parseSemver("latest")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  test("compares numerically, not lexically: 0.10.0 outranks 0.9.0", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
  });

  test("a major outranks any minor and patch", () => {
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("0.99.99", "1.0.0")).toBe(-1);
  });

  test("minor outranks patch", () => {
    expect(compareSemver("0.2.0", "0.1.99")).toBe(1);
  });

  test("patch is the last tiebreaker", () => {
    expect(compareSemver("0.1.2", "0.1.1")).toBe(1);
  });

  test("equal versions compare as 0", () => {
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
  });

  test("an unparseable side is not comparable, so no handoff can fire on it", () => {
    expect(compareSemver("0.1.0", "oops")).toBeNull();
    expect(compareSemver("oops", "0.1.0")).toBeNull();
  });
});
