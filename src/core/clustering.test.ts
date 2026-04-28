import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clusterPages,
  computeFingerprint,
  computeSimilarity,
  computeSkeleton,
  denoiseClasses,
  detectDivergentPages,
  deriveLanguagePrefix,
  type Cluster,
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

  it("persists skeleton field on each cluster and in _manifest.json", async () => {
    await withTmpDir(async (dir) => {
      const p = join(dir, "p.html");
      await writeFile(p, blogPost("A", "x"));
      const clusters = await clusterPages([p], dir);
      expect(clusters[0].skeleton).toBe(computeSkeleton(blogPost("A", "x")));
      const manifest = JSON.parse(
        await readFile(join(dir, "templates", "_manifest.json"), "utf8"),
      );
      expect(manifest.clusters[0].skeleton).toBe(clusters[0].skeleton);
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

describe("computeSimilarity", () => {
  it("returns 1.0 for identical skeletons", () => {
    const s = computeSkeleton(blogPost("A", "x"));
    expect(computeSimilarity(s, s)).toBe(1);
  });

  it("returns < 0.7 for structurally different pages", () => {
    const a = computeSkeleton(blogPost("A", "x"));
    const b = computeSkeleton(homepage);
    expect(computeSimilarity(a, b)).toBeLessThan(0.7);
  });

  it("returns 0 for fully disjoint skeletons", () => {
    const a = computeSkeleton(`<html><body><div><span>x</span></div></body></html>`);
    const b = computeSkeleton(`<html><body><ul><li><a>y</a></li></ul></body></html>`);
    expect(computeSimilarity(a, b)).toBeLessThan(0.5);
  });
});

describe("detectDivergentPages", () => {
  const mkCluster = (id: string, skeleton: string): Cluster => ({
    id,
    fingerprint: id,
    skeleton,
    pages: [],
    languagePrefix: "",
  });

  it("partitions fitted vs divergent given a 0.7 threshold", () => {
    const cluster = mkCluster("c0", computeSkeleton(blogPost("A", "x")));
    const fittingPage = {
      path: "/p/fit.html",
      skeleton: computeSkeleton(blogPost("B", "y")),
    };
    const divergentPage = {
      path: "/p/div.html",
      skeleton: computeSkeleton(homepage),
    };
    const result = detectDivergentPages(
      [fittingPage, divergentPage],
      [cluster],
      0.7,
    );
    expect(result.fitted.get("/p/fit.html")).toBe(cluster);
    expect(result.divergent).toContain("/p/div.html");
    expect(result.fitted.has("/p/div.html")).toBe(false);
  });

  it("uses default threshold 0.7 when omitted", () => {
    const cluster = mkCluster("c0", computeSkeleton(blogPost("A", "x")));
    const page = {
      path: "/p/q.html",
      skeleton: computeSkeleton(blogPost("Z", "qq")),
    };
    const result = detectDivergentPages([page], [cluster]);
    expect(result.fitted.has("/p/q.html")).toBe(true);
  });

  it("classifies all pages divergent when no clusters exist", () => {
    const result = detectDivergentPages(
      [{ path: "/p/a.html", skeleton: "0:html|1:body" }],
      [],
    );
    expect(result.divergent).toEqual(["/p/a.html"]);
    expect(result.fitted.size).toBe(0);
  });
});

describe("denoiseClasses", () => {
  it("strips all named WordPress noise patterns", () => {
    const input = [
      "vc_row", "wpb_wrapper", "nd_options_foo", "post-123",
      "postid-456", "page-id-789", "category-42", "real-class",
    ];
    expect(denoiseClasses(input)).toEqual(["real-class"]);
  });

  it("preserves non-noise classes unchanged", () => {
    const input = ["article", "hero", "sidebar", "post-title"];
    expect(denoiseClasses(input)).toEqual(["article", "hero", "sidebar", "post-title"]);
  });

  it("returns empty array when all classes are noise", () => {
    expect(denoiseClasses(["vc_col", "wpb_text", "post-99"])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(denoiseClasses([])).toEqual([]);
  });
});

describe("computeSkeleton de-noising", () => {
  it("produces identical skeleton for pages differing only by WP noise classes", () => {
    const pageA = `<html><body><div class="content vc_row post-123"><h1>A</h1></div></body></html>`;
    const pageB = `<html><body><div class="content vc_col post-456"><h1>B</h1></div></body></html>`;
    expect(computeSkeleton(pageA)).toBe(computeSkeleton(pageB));
  });

  it("produces different skeleton when genuine classes differ", () => {
    const pageA = `<html><body><div class="content hero"><h1>A</h1></div></body></html>`;
    const pageB = `<html><body><div class="content sidebar"><h1>B</h1></div></body></html>`;
    expect(computeSkeleton(pageA)).not.toBe(computeSkeleton(pageB));
  });

  it("clusterPages groups pages differing only by noise classes into one cluster", async () => {
    await withTmpDir(async (dir) => {
      const pagesDir = join(dir, "pages");
      await mkdir(pagesDir, { recursive: true });
      const p1 = join(pagesDir, "a.html");
      const p2 = join(pagesDir, "b.html");
      await writeFile(p1, `<html><body><article class="entry vc_row post-1 wpb_x"><h1>A</h1><p>x</p></article></body></html>`);
      await writeFile(p2, `<html><body><article class="entry vc_col post-2 wpb_y"><h1>B</h1><p>y</p></article></body></html>`);
      const clusters = await clusterPages([p1, p2], dir);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].pages).toHaveLength(2);
    });
  });
});
