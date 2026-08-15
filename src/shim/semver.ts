export type Semver = { major: number; minor: number; patch: number };

/**
 * Strict `major.minor.patch`, nothing else: the package version is the only string ever compared,
 * and a looser grammar would silently rank `0.1.0-rc1` against `0.1.0` by string accident.
 */
export function parseSemver(version: string): Semver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * 1 when `a` outranks `b`, -1 when it ranks below, 0 when equal, null when either side does not
 * parse. The null case is load-bearing: an unparseable daemon version must never trigger a
 * version handoff, or a stray tag in `package.json` would drain a healthy daemon forever.
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) return null;

  for (const part of ["major", "minor", "patch"] as const) {
    if (left[part] !== right[part]) return left[part] > right[part] ? 1 : -1;
  }
  return 0;
}
