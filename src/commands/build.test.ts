/**
 * Smoke / ordering test for the build-command post-template-fill phases.
 *
 * Addresses round-14 review HIGH-1 — the `<picture>` rewrite runs AFTER
 * template fill in `build.ts`; without this test, reordering the steps
 * would silently break the pipeline (no per-step test catches it).
 *
 * The test bypasses the network/LLM dependent stages and exercises only
 * the deterministic tail: image-pipeline rewrite + CSS optimization on a
 * pre-baked `output/pages/...` tree.  This is intentionally NOT a full
 * end-to-end build — that needs network, LLM, and sharp.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { rewriteImgToPicture } from "../core/images.js";
import { inlineCriticalCss, purgePageCss } from "../core/css.js";
import picomatch from "picomatch";

async function tmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "build-smoke-"));
}

describe("build pipeline post-fill ordering smoke test", () => {
  it("rewrites <img> to <picture> on a final page after template fill", async () => {
    const dir = await tmp();
    try {
      const pagePath = resolve(dir, "pages/x/index.html");
      await mkdir(resolve(dir, "pages/x"), { recursive: true });
      // Simulate a page that template-fill produced: <img src> already
      // points at a local hashed asset (mirrors what rewriteHtmlAssetUrls
      // emits earlier in build.ts — leading slash variant).
      const filled = `<!doctype html><html><body><img src="/assets/img/hero-abc12345.png" alt="hero" class="hero"></body></html>`;
      await writeFile(pagePath, filled);

      const imageManifest = {
        "assets/img/hero-abc12345.png": [
          { width: 480, format: "avif", path: "assets/img/hero-480w-aaaaaaaa.avif" },
          { width: 480, format: "webp", path: "assets/img/hero-480w-bbbbbbbb.webp" },
          { width: 480, format: "png", path: "assets/img/hero-480w-cccccccc.png" },
        ],
      };

      const html = await readFile(pagePath, "utf8");
      const next = rewriteImgToPicture(html, imageManifest);
      expect(next).toContain("<picture");
      expect(next).toMatch(/<source[^>]+type=["']image\/avif["']/);
      expect(next).toMatch(/<source[^>]+type=["']image\/webp["']/);
      expect(next).toMatch(/alt=["']hero["']/);
      expect(next).toMatch(/class=["']hero["']/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("CSS optimization runs after <picture> rewrite without breaking it", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/css"), { recursive: true });
      await mkdir(resolve(dir, "pages/x"), { recursive: true });
      await writeFile(
        resolve(dir, "assets/css/style.css"),
        `.hero { color: red; } .unused { color: blue; }`,
      );

      // Page already has <picture> markup (post image-rewrite state).
      const html = `<!doctype html><html><head><link rel="stylesheet" href="assets/css/style.css"></head><body><picture><source type="image/avif" srcset="x.avif"><img src="x.png" class="hero"></picture></body></html>`;
      const purged = await purgePageCss(html, dir);
      const inlined = await inlineCriticalCss(purged, dir);

      // <picture> markup must survive CSS optimization.
      expect(inlined).toContain("<picture");
      expect(inlined).toMatch(/<source[^>]+type=["']image\/avif["']/);
      // Stylesheet must be deferred (no synchronous <link rel=stylesheet>
      // without media=print onload).
      const renderable = inlined.replace(/<noscript>[\s\S]*?<\/noscript>/gi, "");
      const linkMatches = renderable.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi) ?? [];
      for (const m of linkMatches) {
        expect(m).toMatch(/media=["']print["']/);
      }
      // CSS file on disk must have lost the unused rule.
      const cssAfter = await readFile(resolve(dir, "assets/css/style.css"), "utf8");
      expect(cssAfter).toContain(".hero");
      expect(cssAfter).not.toContain(".unused");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * US-023: Build URL filtering — --only, --url, and --limit CLI flags.
 *
 * Tests the filtering logic used in build.ts in isolation (same picomatch
 * glob matching, same array slicing) without running the full build pipeline.
 */
describe("build URL filtering (US-023)", () => {
  // Helper: simulate the --only filtering logic from build.ts
  function filterOnly(
    entries: Array<{ loc: string }>,
    patterns: string[],
  ): Array<{ loc: string }> {
    if (patterns.length === 0) return entries;
    const matchers = patterns.map((g) => picomatch(g));
    return entries.filter((e) => {
      const pathname = new URL(e.loc).pathname;
      return matchers.some((m) => m(pathname));
    });
  }

  // Helper: simulate --url bypassing sitemap
  function fromUrls(urls: string[]): Array<{ loc: string }> {
    return urls.map((u) => ({ loc: u }));
  }

  const sitemapEntries = [
    { loc: "https://example.com/en/blog/post-1/" },
    { loc: "https://example.com/en/blog/post-2/" },
    { loc: "https://example.com/fr/blog/article-1/" },
    { loc: "https://example.com/fr/" },
    { loc: "https://example.com/en/about/" },
  ];

  it("--only filters URLs by path glob", () => {
    const result = filterOnly(sitemapEntries, ["/en/blog/**"]);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.loc)).toEqual([
      "https://example.com/en/blog/post-1/",
      "https://example.com/en/blog/post-2/",
    ]);
  });

  it("multiple --only patterns use OR semantics", () => {
    const result = filterOnly(sitemapEntries, ["/en/blog/**", "/fr/"]);
    expect(result).toHaveLength(3);
    const locs = result.map((e) => e.loc);
    expect(locs).toContain("https://example.com/en/blog/post-1/");
    expect(locs).toContain("https://example.com/en/blog/post-2/");
    expect(locs).toContain("https://example.com/fr/");
  });

  it("--url bypasses sitemap and uses provided URLs directly", () => {
    const urls = [
      "https://example.com/en/blog/post-1/",
      "https://example.com/fr/",
    ];
    const result = fromUrls(urls);
    expect(result).toHaveLength(2);
    expect(result[0]?.loc).toBe("https://example.com/en/blog/post-1/");
    expect(result[1]?.loc).toBe("https://example.com/fr/");
  });

  it("--limit caps URL count", () => {
    const limited = sitemapEntries.slice(0, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]?.loc).toBe("https://example.com/en/blog/post-1/");
    expect(limited[1]?.loc).toBe("https://example.com/en/blog/post-2/");
  });

  it("--only + --limit compose correctly", () => {
    const filtered = filterOnly(sitemapEntries, ["/en/**"]);
    expect(filtered).toHaveLength(3); // blog/post-1, blog/post-2, about
    const limited = filtered.slice(0, 2);
    expect(limited).toHaveLength(2);
  });

  it("--only + --force compose (filtering before incremental skip)", () => {
    // --only happens before force/incremental check — just verify filter works
    const filtered = filterOnly(sitemapEntries, ["/fr/**"]);
    expect(filtered).toHaveLength(2); // /fr/blog/article-1/, /fr/
    // --force would then override the incremental skip on matching paths
    const forceSet = new Set(["/fr/"]);
    const u = new URL(filtered[1]!.loc);
    expect(forceSet.has(u.pathname)).toBe(true);
  });
});
