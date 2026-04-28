import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clusterPages,
  computeFingerprint,
  deriveLanguagePrefix,
} from "./clustering.js";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "clustering-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const blogPost = (title: string, body: string): string => `
<!doctype html><html><head><title>${title}</title></head>
<body><article class="post"><h1>${title}</h1><p>${body}</p></article></body></html>`;

const homepage = `
<!doctype html><html><head><title>Home</title></head>
<body><main class="home"><section class="hero"><h1>Welcome</h1></section></main></body></html>`;

describe("computeFingerprint", () => {
  it("ignores text content — same skeleton ⇒ same fingerprint", () => {
    const a = computeFingerprint(blogPost("First", "alpha"));
    const b = computeFingerprint(blogPost("Second", "wholly different prose"));
    expect(a).toBe(b);
  });

  it("differs when DOM structure differs", () => {
    const a = computeFingerprint(blogPost("x", "y"));
    const b = computeFingerprint(homepage);
    expect(a).not.toBe(b);
  });

  it("ignores class ordering and duplicates", () => {
    const a = computeFingerprint(`<div class="b a a"><span>x</span></div>`);
    const b = computeFingerprint(`<div class="a b"><span>y</span></div>`);
    expect(a).toBe(b);
  });

  it("returns a 12-char hex string", () => {
    const fp = computeFingerprint(homepage);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("deriveLanguagePrefix", () => {
  it("uses first path segment under pages/ when it looks like an ISO code", () => {
    expect(deriveLanguagePrefix("<html><body>x</body></html>", "/o/pages/fr/blog/post.html")).toBe("fr");
    expect(deriveLanguagePrefix("<html><body>x</body></html>", "/o/pages/en-US/x.html")).toBe("");
  });
  it("falls back to <html lang>", () => {
    expect(deriveLanguagePrefix(`<html lang="fr-CA"><body>x</body></html>`, "/o/pages/index.html")).toBe("fr");
  });
  it("returns empty string when neither source has a code", () => {
    expect(deriveLanguagePrefix("<html><body>x</body></html>", "/o/pages/index.html")).toBe("");
  });
});

describe("clusterPages", () => {
  it("groups identical-structure pages and writes _manifest.json", async () => {
    await withTmpDir(async (dir) => {
      const pagesDir = join(dir, "pages");
      await mkdir(pagesDir, { recursive: true });
      const p1 = join(pagesDir, "post-1.html");
      const p2 = join(pagesDir, "post-2.html");
      const p3 = join(pagesDir, "home.html");
      await writeFile(p1, blogPost("A", "one"));
      await writeFile(p2, blogPost("B", "two"));
      await writeFile(p3, homepage);

      const clusters = await clusterPages([p1, p2, p3], dir);

      expect(clusters).toHaveLength(2);
      const big = clusters.find((c) => c.pages.length === 2)!;
      const small = clusters.find((c) => c.pages.length === 1)!;
      expect(big.pages.sort()).toEqual([p1, p2].sort());
      expect(small.pages).toEqual([p3]);

      const manifestRaw = await readFile(
        join(dir, "templates", "_manifest.json"),
        "utf8",
      );
      const manifest = JSON.parse(manifestRaw);
      expect(manifest.clusters).toHaveLength(2);
      expect(manifest.clusters[0]).toHaveProperty("id");
      expect(manifest.clusters[0]).toHaveProperty("fingerprint");
      expect(manifest.clusters[0]).toHaveProperty("pageCount");
      expect(manifest.clusters[0]).toHaveProperty("pages");
      expect(typeof manifest.generatedAt).toBe("string");
    });
  });

  it("partitions identical-DOM pages by language path prefix (AC1, AC6)", async () => {
    await withTmpDir(async (dir) => {
      const pagesDir = join(dir, "pages");
      const fr = join(pagesDir, "fr");
      const en = join(pagesDir, "en");
      await mkdir(fr, { recursive: true });
      await mkdir(en, { recursive: true });
      const pFr = join(fr, "post.html");
      const pEn = join(en, "post.html");
      await writeFile(pFr, blogPost("Bonjour", "salut"));
      await writeFile(pEn, blogPost("Hello", "hi"));

      const clusters = await clusterPages([pFr, pEn], dir);
      expect(clusters).toHaveLength(2);
      const langs = clusters.map((c) => c.languagePrefix).sort();
      expect(langs).toEqual(["en", "fr"]);
    });
  });

  it("single-language site clusters normally with empty languagePrefix", async () => {
    await withTmpDir(async (dir) => {
      const pagesDir = join(dir, "pages");
      await mkdir(pagesDir, { recursive: true });
      const a = join(pagesDir, "a.html");
      const b = join(pagesDir, "b.html");
      await writeFile(a, blogPost("A", "x"));
      await writeFile(b, blogPost("B", "y"));
      const clusters = await clusterPages([a, b], dir);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].languagePrefix).toBe("");
      expect(clusters[0].pages.length).toBe(2);
    });
  });

  it("assigns stable cluster-<n> ids", async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, "p.html");
      await writeFile(p, homepage);
      const clusters = await clusterPages([p], dir);
      expect(clusters[0].id).toBe("cluster-0");
    });
  });
});
