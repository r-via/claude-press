import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export interface Cluster {
  /** Stable id `cluster-<n>` assigned in cluster-creation order. */
  id: string;
  /** Hex-truncated SHA-256 of the structural skeleton (12 chars). */
  fingerprint: string;
  /** Local HTML file paths grouped under this fingerprint. */
  pages: string[];
  /**
   * Language prefix derived from the first path segment (e.g. `fr`, `en`)
   * or from `<html lang>` when no prefix is present.  Empty string for
   * single-language sites.  Pages with different prefixes always land in
   * different clusters even when their DOM skeletons match.
   */
  languagePrefix: string;
}

export interface ClusterManifest {
  generatedAt: string;
  clusters: Array<{
    id: string;
    fingerprint: string;
    pageCount: number;
    pages: string[];
    languagePrefix: string;
  }>;
}

/** ISO 639 language code: two or three lowercase letters. */
const LANG_PREFIX_RE = /^[a-z]{2,3}$/;

/**
 * Derive the language prefix for an HTML document.  Preference order:
 *   1. First non-empty path segment of `pagePath` (if it looks like a
 *      2–3 char ISO code).
 *   2. The 2–3 char prefix of the `<html lang="...">` attribute (e.g.
 *      `fr-CA` → `fr`).
 *   3. Empty string (single-language site).
 */
export function deriveLanguagePrefix(html: string, pagePath: string): string {
  const norm = pagePath.replace(/\\/g, "/");
  // Find the first segment AFTER any "pages/" prefix to skip the output root.
  const cleaned = norm.replace(/^.*\/pages\//, "").replace(/^\/+/, "");
  const firstSeg = cleaned.split("/")[0] ?? "";
  if (firstSeg && LANG_PREFIX_RE.test(firstSeg)) return firstSeg;
  // Fallback: <html lang="..."> attribute.
  const m = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html);
  if (m) {
    const code = m[1].split(/[-_]/)[0]?.toLowerCase() ?? "";
    if (LANG_PREFIX_RE.test(code)) return code;
  }
  return "";
}

/**
 * Compute a deterministic structural fingerprint for a single HTML document.
 * The skeleton is the depth-prefixed sequence of element tag names with
 * sorted+deduplicated CSS class names appended; text nodes, attribute
 * values (other than `class`), and comments are ignored.
 */
export function computeFingerprint(html: string): string {
  const $ = cheerio.load(html);
  const parts: string[] = [];

  const walk = (el: cheerio.Element, depth: number): void => {
    if (el.type !== "tag") return;
    const tag = el.tagName.toLowerCase();
    const rawClass = (el.attribs && el.attribs.class) || "";
    const classes = Array.from(
      new Set(
        rawClass
          .split(/\s+/)
          .map((c) => c.trim())
          .filter(Boolean),
      ),
    ).sort();
    const cls = classes.length > 0 ? "." + classes.join(".") : "";
    parts.push(`${depth}:${tag}${cls}`);
    for (const child of el.children || []) {
      walk(child as cheerio.Element, depth + 1);
    }
  };

  const root = $.root()[0] as unknown as cheerio.Element;
  for (const child of root.children || []) {
    walk(child as cheerio.Element, 0);
  }

  const skeleton = parts.join("|");
  return createHash("sha256").update(skeleton).digest("hex").slice(0, 12);
}

/**
 * Cluster downloaded HTML pages by exact-match structural fingerprint and
 * persist the cluster definitions to `<outputDir>/templates/_manifest.json`.
 */
export async function clusterPages(
  pagePaths: string[],
  outputDir: string,
): Promise<Cluster[]> {
  // Group by (languagePrefix, fingerprint) so identical DOM under different
  // language prefixes lands in distinct clusters per the multilingual spec.
  const byKey = new Map<
    string,
    { fingerprint: string; languagePrefix: string; pages: string[] }
  >();
  for (const p of pagePaths) {
    const html = await readFile(p, "utf8");
    const fp = computeFingerprint(html);
    const lang = deriveLanguagePrefix(html, p);
    const key = `${lang}::${fp}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.pages.push(p);
    } else {
      byKey.set(key, { fingerprint: fp, languagePrefix: lang, pages: [p] });
    }
  }

  const clusters: Cluster[] = [];
  let n = 0;
  for (const { fingerprint, languagePrefix, pages } of byKey.values()) {
    clusters.push({
      id: `cluster-${n++}`,
      fingerprint,
      pages,
      languagePrefix,
    });
  }

  const templatesDir = resolve(outputDir, "templates");
  await mkdir(templatesDir, { recursive: true });
  const manifest: ClusterManifest = {
    generatedAt: new Date().toISOString(),
    clusters: clusters.map((c) => ({
      id: c.id,
      fingerprint: c.fingerprint,
      pageCount: c.pages.length,
      pages: c.pages,
      languagePrefix: c.languagePrefix,
    })),
  };
  await writeFile(
    resolve(templatesDir, "_manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  return clusters;
}
