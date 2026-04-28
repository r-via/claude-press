import { readdir, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Regenerate `sitemap.xml` at the root of the output directory by scanning
 * every `index.html` under `<outputDir>/pages/` and emitting a valid
 * sitemap.org `<urlset>` document.
 *
 * Each `<url>` entry contains:
 *   - `<loc>`     — `baseUrl + derived-path` (trailing slash for directories)
 *   - `<lastmod>` — file mtime in ISO 8601 date form (YYYY-MM-DD)
 *
 * The `baseUrl` is normalised so any trailing slashes are stripped before
 * concatenation; derived paths always begin with `/`.
 */
export async function generateOutputSitemap(
  outputDir: string,
  baseUrl: string,
): Promise<void> {
  const pagesDir = resolve(outputDir, "pages");
  const base = baseUrl.replace(/\/+$/, "");

  let entries: string[] = [];
  try {
    entries = (await readdir(pagesDir, { recursive: true })) as string[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    entries = [];
  }

  const urls: { loc: string; lastmod: string }[] = [];
  for (const name of entries) {
    if (typeof name !== "string") continue;
    if (!name.endsWith("index.html")) continue;
    // strip the trailing "index.html" — keep the directory part (with slash)
    const rel = name.split(sep).join("/");
    const dir = rel.replace(/index\.html$/, "");
    const path = "/" + dir; // dir already ends with "/" or is empty
    const filePath = resolve(pagesDir, name);
    let lastmod: string;
    try {
      const s = await stat(filePath);
      lastmod = s.mtime.toISOString().slice(0, 10);
    } catch {
      lastmod = new Date().toISOString().slice(0, 10);
    }
    urls.push({ loc: base + path, lastmod });
  }

  // Stable order — sort by URL so output is deterministic across runs.
  urls.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`);
  for (const u of urls) {
    lines.push(`  <url>`);
    lines.push(`    <loc>${escapeXml(u.loc)}</loc>`);
    lines.push(`    <lastmod>${u.lastmod}</lastmod>`);
    lines.push(`  </url>`);
  }
  lines.push(`</urlset>`);
  lines.push(``);

  const xml = lines.join("\n");
  await writeFile(resolve(outputDir, "sitemap.xml"), xml);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
