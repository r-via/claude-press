import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refinePages, type RefineGenerator } from "./refiner.js";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "refiner-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const seoHead = [
  `<title>Original Title</title>`,
  `<meta name="description" content="orig desc">`,
  `<meta property="og:title" content="OG Title">`,
  `<link rel="canonical" href="https://example.com/p/">`,
  `<script type="application/ld+json">{"@context":"https://schema.org"}</script>`,
].join("\n");

const samplePage = (body: string): string =>
  `<!doctype html><html lang="en"><head>\n${seoHead}\n</head><body>${body}</body></html>`;

async function writePage(dir: string, rel: string, html: string): Promise<string> {
  const full = join(dir, "pages", rel, "index.html");
  await mkdir(join(dir, "pages", rel), { recursive: true });
  await writeFile(full, html);
  return full;
}

describe("refinePages", () => {
  it("extracts visible body text excluding script/style/noscript and rewrites in-place", async () => {
    await withTmpDir(async (dir) => {
      const body =
        `<article><h1>Hello world</h1><p>Some prose here.</p>` +
        `<script>console.log("x")</script>` +
        `<style>.x{color:red}</style>` +
        `<noscript>fallback noscript</noscript>` +
        `<p>Another paragraph.</p></article>`;
      await writePage(dir, "post", samplePage(body));

      const captured: string[][] = [];
      const gen: RefineGenerator = async (segments) => {
        captured.push(segments);
        return segments.map((s) => `R(${s})`);
      };

      const result = await refinePages(dir, { generate: gen });
      expect(result.scanned).toBe(1);
      expect(result.refined).toBe(1);
      expect(result.skipped).toBe(0);
      expect(captured).toHaveLength(1);
      // Only visible body text — script/style/noscript excluded.
      expect(captured[0]).toEqual([
        "Hello world",
        "Some prose here.",
        "Another paragraph.",
      ]);

      const written = await readFile(
        join(dir, "pages", "post", "index.html"),
        "utf8",
      );
      expect(written).toContain("R(Hello world)");
      expect(written).toContain("R(Some prose here.)");
      expect(written).toContain("R(Another paragraph.)");
      // Non-text targets untouched.
      expect(written).toContain(`console.log("x")`);
      expect(written).toContain("fallback noscript");
    });
  });

  it("preserves SEO head elements byte-for-byte after refinement", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "p", samplePage(`<p>Body text to rewrite.</p>`));
      const gen: RefineGenerator = async (segs) => segs.map((s) => `${s} (refined)`);
      await refinePages(dir, { generate: gen });
      const written = await readFile(join(dir, "pages", "p", "index.html"), "utf8");
      expect(written).toContain(`<title>Original Title</title>`);
      expect(written).toContain(`<meta name="description" content="orig desc">`);
      expect(written).toContain(`<meta property="og:title" content="OG Title">`);
      expect(written).toContain(`<link rel="canonical" href="https://example.com/p/">`);
      expect(written).toContain(
        `<script type="application/ld+json">{"@context":"https://schema.org"}</script>`,
      );
      expect(written).toContain("Body text to rewrite. (refined)");
    });
  });

  it("writes _refined.json manifest and skips already-refined pages on re-run", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "p", samplePage(`<p>Hello.</p>`));
      let calls = 0;
      const gen: RefineGenerator = async (segs) => {
        calls += 1;
        return segs.map((s) => `${s}!`);
      };
      const r1 = await refinePages(dir, { generate: gen });
      expect(r1.refined).toBe(1);
      expect(calls).toBe(1);

      const manifest = JSON.parse(
        await readFile(join(dir, "_refined.json"), "utf8"),
      );
      expect(manifest.pages["p/index.html"]).toBeTruthy();

      const r2 = await refinePages(dir, { generate: gen });
      expect(r2.skipped).toBe(1);
      expect(r2.refined).toBe(0);
      expect(calls).toBe(1);
    });
  });

  it("force-refines a specific page when --force matches", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "a", samplePage(`<p>A.</p>`));
      await writePage(dir, "b", samplePage(`<p>B.</p>`));
      let calls = 0;
      const gen: RefineGenerator = async (segs) => {
        calls += 1;
        return segs.map((s) => `${s}*`);
      };
      await refinePages(dir, { generate: gen });
      expect(calls).toBe(2);

      const r = await refinePages(dir, { generate: gen, force: ["/a/"] });
      expect(r.refined).toBe(1);
      expect(r.skipped).toBe(1);
      expect(calls).toBe(3);
    });
  });

  it("force-refines every page when forceAll is set", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "a", samplePage(`<p>A.</p>`));
      await writePage(dir, "b", samplePage(`<p>B.</p>`));
      const gen: RefineGenerator = async (segs) => segs.map((s) => `${s}*`);
      await refinePages(dir, { generate: gen });
      const r = await refinePages(dir, { generate: gen, forceAll: true });
      expect(r.refined).toBe(2);
      expect(r.skipped).toBe(0);
    });
  });

  it("records LLM errors and leaves the page unchanged", async () => {
    await withTmpDir(async (dir) => {
      const original = samplePage(`<p>Untouched.</p>`);
      await writePage(dir, "p", original);
      const gen: RefineGenerator = async () => {
        throw new Error("boom");
      };
      const r = await refinePages(dir, { generate: gen });
      expect(r.refined).toBe(0);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].reason).toMatch(/boom/);
      const after = await readFile(
        join(dir, "pages", "p", "index.html"),
        "utf8",
      );
      expect(after).toBe(original);
    });
  });

  it("counts pages where the generator returned no improvements as unchanged", async () => {
    await withTmpDir(async (dir) => {
      const original = samplePage(`<p>Already good.</p>`);
      await writePage(dir, "p", original);
      const gen: RefineGenerator = async (segs) => segs.slice();
      const r = await refinePages(dir, { generate: gen });
      expect(r.unchanged).toBe(1);
      expect(r.refined).toBe(0);
      const after = await readFile(
        join(dir, "pages", "p", "index.html"),
        "utf8",
      );
      expect(after).toBe(original);
    });
  });
});
