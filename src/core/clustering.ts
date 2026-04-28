import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export interface Cluster {
  /** Stable id `cluster-<n>` assigned in cluster-creation order. */
  id: string;
  /** Hex-truncated SHA-256 of the structural skeleton (12 chars). */
  fingerprint: string;
  /**
   * Raw structural skeleton string of the representative page (the first
   * page added to this cluster).  Used by similarity computation and
   * divergence detection — see {@link computeSimilarity} and
   * {@link detectDivergentPages}.
   */
  skeleton: string;
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
    skeleton: string;
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
 * Compute the raw structural skeleton string of an HTML document.
 * The skeleton is the depth-prefixed sequence of element tag names with
 * sorted+deduplicated CSS class names appended (parts joined by `|`);
 * text nodes, attribute values (other than `class`), and comments are
 * ignored.  Used both as input to {@link computeFingerprint} (exact-match
 * clustering) and to {@link computeSimilarity} (fuzzy divergence
 * detection).
 */
export function computeSkeleton(html: string): string {
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

  return parts.join("|");
}

/**
 * Compute a deterministic structural fingerprint for a single HTML document.
 * Hex-truncated SHA-256 (12 chars) of the raw skeleton — see
 * {@link computeSkeleton}.
 */
export function computeFingerprint(html: string): string {
  return createHash("sha256").update(computeSkeleton(html)).digest("hex").slice(0, 12);
}

/**
 * Jaccard similarity (0–1) between two structural skeletons computed on
 * tag-sequence bigrams.  Identical skeletons return 1.0; skeletons with
 * no shared bigrams return 0.0.  Two empty-or-degenerate skeletons (each
 * < 2 parts) return 1.0 when they're byte-identical, 0.0 otherwise — too
 * little signal to do bigram math.
 *
 * Used by {@link detectDivergentPages} to decide whether a page's
 * structure is close enough to a cluster's representative to be filled
 * from that cluster's template, or whether it deserves its own template.
 */
export function computeSimilarity(skeletonA: string, skeletonB: string): number {
  const bigramsOf = (s: string): Set<string> => {
    const tokens = s.split("|").filter((t) => t.length > 0);
    const out = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i++) {
      out.add(`${tokens[i]}>>${tokens[i + 1]}`);
    }
    return out;
  };
  const a = bigramsOf(skeletonA);
  const b = bigramsOf(skeletonB);
  if (a.size === 0 && b.size === 0) {
    return skeletonA === skeletonB ? 1 : 0;
  }
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
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
    { fingerprint: string; skeleton: string; languagePrefix: string; pages: string[] }
  >();
  for (const p of pagePaths) {
    const html = await readFile(p, "utf8");
    const skeleton = computeSkeleton(html);
    const fp = createHash("sha256").update(skeleton).digest("hex").slice(0, 12);
    const lang = deriveLanguagePrefix(html, p);
    const key = `${lang}::${fp}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.pages.push(p);
    } else {
      byKey.set(key, { fingerprint: fp, skeleton, languagePrefix: lang, pages: [p] });
    }
  }

  const clusters: Cluster[] = [];
  let n = 0;
  for (const { fingerprint, skeleton, languagePrefix, pages } of byKey.values()) {
    clusters.push({
      id: `cluster-${n++}`,
      fingerprint,
      skeleton,
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
      skeleton: c.skeleton,
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

/** Default Jaccard threshold above which a page is considered to fit a cluster. */
export const DEFAULT_DIVERGENCE_THRESHOLD = 0.7;

export interface DivergenceResult {
  /** Pages whose best-similarity cluster scored ≥ threshold, mapped to that cluster. */
  fitted: Map<string, Cluster>;
  /** Pages whose best similarity to any cluster fell below threshold. */
  divergent: string[];
}

/**
 * Classify each page as either fitting an existing cluster (Jaccard
 * similarity on tag-bigrams ≥ `threshold`) or divergent (no cluster
 * crosses the bar).  Used by `build.ts` to route divergent pages to
 * their own LLM-synthesized template, fulfilling README §
 * "Template-driven rebuild" step 4.
 *
 * Pure function — no IO; caller computes skeletons via
 * {@link computeSkeleton}.
 */
export function detectDivergentPages(
  pages: Array<{ path: string; skeleton: string }>,
  clusters: Cluster[],
  threshold: number = DEFAULT_DIVERGENCE_THRESHOLD,
): DivergenceResult {
  const fitted = new Map<string, Cluster>();
  const divergent: string[] = [];
  for (const page of pages) {
    let best: { cluster: Cluster; score: number } | null = null;
    for (const c of clusters) {
      const score = computeSimilarity(page.skeleton, c.skeleton);
      if (best === null || score > best.score) best = { cluster: c, score };
    }
    if (best && best.score >= threshold) {
      fitted.set(page.path, best.cluster);
    } else {
      divergent.push(page.path);
    }
  }
  return { fitted, divergent };
}
