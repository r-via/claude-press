import { describe, it, expect } from "vitest";
import { isSitemapIndex, parseLocs, parseEntries } from "./sitemap.js";

describe("sitemap parser", () => {
  it("detects sitemap index", () => {
    const xml = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x/a.xml</loc></sitemap></sitemapindex>`;
    expect(isSitemapIndex(xml)).toBe(true);
  });

  it("detects regular urlset", () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://x/p</loc></url></urlset>`;
    expect(isSitemapIndex(xml)).toBe(false);
  });

  it("extracts <loc> entries", () => {
    const xml = `<urlset><url><loc>https://x/a</loc></url><url><loc>https://x/b</loc></url></urlset>`;
    expect(parseLocs(xml)).toEqual(["https://x/a", "https://x/b"]);
  });

  it("pairs loc + lastmod", () => {
    const xml = `<urlset>
      <url><loc>https://x/a</loc><lastmod>2026-01-01</lastmod></url>
      <url><loc>https://x/b</loc></url>
    </urlset>`;
    const entries = parseEntries(xml);
    expect(entries).toEqual([
      { loc: "https://x/a", lastmod: "2026-01-01" },
      { loc: "https://x/b" },
    ]);
  });
});
