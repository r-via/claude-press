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
}

export interface ClusterManifest {
  generatedAt: string;
  clusters: Array<{
    id: string;
    fingerprint: string;
    pageCount: number;
    pages: string[];
  }>;
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
  const byFingerprint = new Map<string, string[]>();
  for (const p of pagePaths) {
    const html = await readFile(p, "utf8");
    const fp = computeFingerprint(html);
    const existing = byFingerprint.get(fp);
    if (existing) {
      existing.push(p);
    } else {
      byFingerprint.set(fp, [p]);
    }
  }

  const clusters: Cluster[] = [];
  let n = 0;
  for (const [fingerprint, pages] of byFingerprint) {
    clusters.push({ id: `cluster-${n++}`, fingerprint, pages });
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
    })),
  };
  await writeFile(
    resolve(templatesDir, "_manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  return clusters;
}
