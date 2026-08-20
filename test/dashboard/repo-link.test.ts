import { describe, expect, test } from "bun:test";
import { parseRepoLink, REPO_ICON } from "../../src/dashboard/repo-link.ts";
import type { RepoLink, RepoProvider } from "../../src/dashboard/repo-link.ts";

describe("parseRepoLink", () => {
  const recognized: { name: string; raw: string; want: RepoLink }[] = [
    {
      name: "github over https",
      raw: "https://github.com/uwuclxdy/clauth.git",
      want: { provider: "github", path: "uwuclxdy/clauth", href: "https://github.com/uwuclxdy/clauth" },
    },
    {
      name: "github over scp-like ssh",
      raw: "git@github.com:uwuclxdy/clauth.git",
      want: { provider: "github", path: "uwuclxdy/clauth", href: "https://github.com/uwuclxdy/clauth" },
    },
    {
      name: "github over ssh url",
      raw: "ssh://git@github.com/uwuclxdy/clauth.git",
      want: { provider: "github", path: "uwuclxdy/clauth", href: "https://github.com/uwuclxdy/clauth" },
    },
    {
      name: "github over git protocol",
      raw: "git://github.com/uwuclxdy/clauth.git",
      want: { provider: "github", path: "uwuclxdy/clauth", href: "https://github.com/uwuclxdy/clauth" },
    },
    {
      name: "gitlab with a nested group",
      raw: "https://gitlab.com/group/subgroup/repo.git",
      want: { provider: "gitlab", path: "group/subgroup/repo", href: "https://gitlab.com/group/subgroup/repo" },
    },
    {
      name: "self-hosted gitlab",
      raw: "git@gitlab.example.com:team/repo.git",
      want: { provider: "gitlab", path: "team/repo", href: "https://gitlab.example.com/team/repo" },
    },
    {
      name: "gitea by name",
      raw: "https://gitea.example.com/user/repo.git",
      want: { provider: "gitea", path: "user/repo", href: "https://gitea.example.com/user/repo" },
    },
    {
      name: "forgejo by name",
      raw: "https://forgejo.example.com/user/repo.git",
      want: { provider: "forgejo", path: "user/repo", href: "https://forgejo.example.com/user/repo" },
    },
    {
      name: "codeberg",
      raw: "https://codeberg.org/user/repo.git",
      want: { provider: "codeberg", path: "user/repo", href: "https://codeberg.org/user/repo" },
    },
    {
      name: "bitbucket",
      raw: "https://bitbucket.org/user/repo.git",
      want: { provider: "bitbucket", path: "user/repo", href: "https://bitbucket.org/user/repo" },
    },
    {
      name: "sourcehut with a tilde namespace",
      raw: "https://git.sr.ht/~user/repo",
      want: { provider: "sourcehut", path: "~user/repo", href: "https://git.sr.ht/~user/repo" },
    },
    {
      name: "gitee",
      raw: "https://gitee.com/user/repo.git",
      want: { provider: "gitee", path: "user/repo", href: "https://gitee.com/user/repo" },
    },
    {
      name: "azure devops",
      raw: "https://dev.azure.com/org/project/_git/repo",
      want: { provider: "azure", path: "org/project/_git/repo", href: "https://dev.azure.com/org/project/_git/repo" },
    },
    {
      name: "unknown host carrying git in its name falls back to gitea",
      raw: "https://git.example.com/user/repo.git",
      want: { provider: "gitea", path: "user/repo", href: "https://git.example.com/user/repo" },
    },
  ];

  for (const c of recognized) {
    test(c.name, () => expect(parseRepoLink(c.raw)).toEqual(c.want));
  }

  test("strips an uppercase .GIT suffix", () => {
    expect(parseRepoLink("https://github.com/uwuclxdy/clauth.GIT")).toEqual({
      provider: "github",
      path: "uwuclxdy/clauth",
      href: "https://github.com/uwuclxdy/clauth",
    });
  });

  test("strips a trailing slash after the .git", () => {
    expect(parseRepoLink("https://github.com/uwuclxdy/clauth.git/")).toEqual({
      provider: "github",
      path: "uwuclxdy/clauth",
      href: "https://github.com/uwuclxdy/clauth",
    });
  });

  test("keeps a non-default port on the link", () => {
    expect(parseRepoLink("https://gitea.example.com:8443/user/repo.git")).toEqual({
      provider: "gitea",
      path: "user/repo",
      href: "https://gitea.example.com:8443/user/repo",
    });
  });

  test("keeps an http scheme instead of forcing https", () => {
    expect(parseRepoLink("http://git.example.com/user/repo.git")).toEqual({
      provider: "gitea",
      path: "user/repo",
      href: "http://git.example.com/user/repo",
    });
  });

  const undetected: { name: string; raw: string }[] = [
    { name: "a host that names no provider", raw: "https://example.com/org/repo.git" },
    { name: "an empty string", raw: "" },
    { name: "whitespace", raw: "   " },
    { name: "a local filesystem path", raw: "/home/user/repo" },
    { name: "a bare host without a scheme", raw: "github.com/user/repo" },
    { name: "a javascript scheme", raw: "javascript:alert(1)" },
  ];

  for (const c of undetected) {
    test(`returns null for ${c.name}`, () => expect(parseRepoLink(c.raw)).toBeNull());
  }
});

describe("REPO_ICON", () => {
  test("carries a brand glyph for every provider", () => {
    const providers = Object.keys(REPO_ICON) as RepoProvider[];
    expect(providers).toHaveLength(9);
    for (const provider of providers) {
      const path = REPO_ICON[provider];
      expect(path, `${provider} has an icon path`).toBeTruthy();
      expect(path.trim(), `${provider} icon is a filled path`).toMatch(/^[Mm]/);
    }
  });
});
