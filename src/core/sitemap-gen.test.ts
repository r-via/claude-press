import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateOutputSitemap } from "./sitemap-gen.js";

let workDir: string;

beforeEach(async () => {
  workDir = resolve(tmpdir(), `sitemap-gen-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function writePage(rel: string, html = "<html></html>"): Promise<void> {
  const full = resolve(workDir, "pages", rel);
  await mkdir(resolve(full, ".."), { recursive: true });
  await writeFile(full, html);
}

describe("generateOutputSitemap", () => {
  it("derives URLs from directory structure", async () => {
    await writePage("index.html");
    await writePage("en/blog/post/index.html");
    await writePage("fr/index.html");

    await generateOutputSitemap(workDir, "https://example.com");
    const xml = await readFile(resolve(workDir, "sitemap.xml"), "utf8");

    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/en/blog/post/</loc>");
    expect(xml).toContain("<loc>https://example.com/fr/</loc>");
  });

  it("emits valid XML with sitemaps.org namespace", async () => {
    await writePage("index.html");
    await generateOutputSitemap(workDir, "https://example.com");
    const xml = await readFile(resolve(workDir, "sitemap.xml"), "utf8");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("includes <lastmod> in YYYY-MM-DD format for every URL", async () => {
    await writePage("a/index.html");
    await writePage("b/index.html");
    await generateOutputSitemap(workDir, "https://x.test");
    const xml = await readFile(resolve(workDir, "sitemap.xml"), "utf8");
    const lastmods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
    expect(lastmods.length).toBe(2);
    for (const d of lastmods) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("produces a valid empty <urlset> when no pages exist", async () => {
    await mkdir(resolve(workDir, "pages"), { recursive: true });
    await generateOutputSitemap(workDir, "https://example.com");
    const xml = await readFile(resolve(workDir, "sitemap.xml"), "utf8");
    expect(xml).toContain("<urlset");
    expect(xml).toContain("</urlset>");
    expect(xml).not.toContain("<url>");
  });

  it("normalises trailing slashes on baseUrl", async () => {
    await writePage("about/index.html");
    await generateOutputSitemap(workDir, "https://example.com///");
    const xml = await readFile(resolve(workDir, "sitemap.xml"), "utf8");
    expect(xml).toContain("<loc>https://example.com/about/</loc>");
    expect(xml).not.toContain("example.com//");
  });

  it("works when the pages directory is missing entirely", async () => {
    // No pages dir created.
    await generateOutputSitemap(workDir, "https://example.com");
    const xml = await readFile(resolve(workDir, "sitemap.xml"), "utf8");
    expect(xml).toContain("<urlset");
    expect(xml).not.toContain("<url>");
  });
});
