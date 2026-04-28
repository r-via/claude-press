/**
 * Smart preloading — inject `<link rel="preload">` hints for the likely
 * LCP image and critical web fonts (US-016).
 *
 * Two pure functions, both `(html: string) => string`:
 *   - `injectLcpPreload`    — finds the first `<img>` (or `<picture>`)
 *     inside `<main>`, `<article>`, or the first content container of
 *     `<body>` and injects an image preload with `fetchpriority="high"`.
 *   - `injectFontPreloads`  — scans inline `<style>` blocks in `<head>`
 *     for WOFF2 `url(...)` references inside `@font-face` rules and
 *     injects one font preload per unique href.
 *
 * Both functions are idempotent: if a `<link rel="preload">` for the
 * same `href` is already present, the corresponding injection is a no-op
 * for that resource.
 *
 * Pure: cheerio in / serialised HTML out.  No file I/O, no LLM, no side
 * effects.  Side-effects (file writes) live in `commands/build.ts`.
 *
 * See README § "Optimizations applied" — "Smart preloading of key
 * assets (LCP image, critical fonts)".
 */

import * as cheerio from "cheerio";

/**
 * Collect every `href` already declared as `<link rel="preload">` in the
 * document.  Used by both injectors to skip duplicate hints.
 */
function existingPreloadHrefs($: cheerio.CheerioAPI): Set<string> {
  const set = new Set<string>();
  $('link[rel="preload"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (href) set.add(href);
  });
  return set;
}

/**
 * Pick the highest-width entry from a `srcset` attribute value.
 * Supports the `<url> <width>w` and `<url> <density>x` formats.
 * Falls back to the first URL when no descriptors are present.
 */
function pickHighestSrcsetUrl(srcset: string): string | undefined {
  const candidates = srcset
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/);
      const url = parts[0];
      const desc = parts[1] ?? "";
      let weight = 0;
      const wMatch = desc.match(/^(\d+(?:\.\d+)?)w$/);
      const xMatch = desc.match(/^(\d+(?:\.\d+)?)x$/);
      if (wMatch) weight = parseFloat(wMatch[1]);
      else if (xMatch) weight = parseFloat(xMatch[1]) * 1000; // density bias
      return { url, weight };
    });
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0]?.url;
}

/**
 * Locate the candidate LCP element.  Heuristic: prefer the first
 * `<img>` or `<picture>` inside `<main>` or `<article>`; otherwise the
 * first one anywhere in `<body>`.  Returns the cheerio element or
 * `undefined` if no image is present.
 */
function findLcpElement($: cheerio.CheerioAPI): cheerio.Cheerio<any> | undefined {
  const containers = ["main", "article"];
  for (const sel of containers) {
    const root = $(sel).first();
    if (root.length === 0) continue;
    const found = root.find("img, picture").first();
    if (found.length > 0) return found;
  }
  const body = $("body").first();
  if (body.length === 0) return undefined;
  const fallback = body.find("img, picture").first();
  return fallback.length > 0 ? fallback : undefined;
}

/**
 * Resolve the preload `href` for a given LCP candidate.  For
 * `<picture>` returns the highest-width entry from the first `<source>
 * srcset>` (or the inner `<img>` src when no source tags carry srcset).
 * For `<img>` returns the `src` (or highest-width `srcset` entry when
 * `src` is absent).
 */
function lcpHrefFor(
  el: cheerio.Cheerio<any>,
  $: cheerio.CheerioAPI,
): string | undefined {
  const tag = (el.get(0) as any)?.tagName?.toLowerCase?.();
  if (tag === "picture") {
    const sources = el.find("source");
    for (let i = 0; i < sources.length; i++) {
      const srcset = $(sources[i]).attr("srcset");
      if (srcset) {
        const url = pickHighestSrcsetUrl(srcset);
        if (url) return url;
      }
    }
    const innerImg = el.find("img").first();
    if (innerImg.length > 0) {
      const ss = innerImg.attr("srcset");
      if (ss) {
        const url = pickHighestSrcsetUrl(ss);
        if (url) return url;
      }
      return innerImg.attr("src");
    }
    return undefined;
  }
  if (tag === "img") {
    const src = el.attr("src");
    if (src) return src;
    const ss = el.attr("srcset");
    if (ss) return pickHighestSrcsetUrl(ss);
  }
  return undefined;
}

/**
 * Inject a `<link rel="preload" as="image" href="…" fetchpriority="high">`
 * for the page's likely LCP image, idempotently.  Returns the input
 * unchanged when no LCP candidate is found or when a preload for the
 * same href already exists.
 */
export function injectLcpPreload(html: string): string {
  const $ = cheerio.load(html);
  const lcp = findLcpElement($);
  if (!lcp) return html;
  const href = lcpHrefFor(lcp, $);
  if (!href) return html;
  if (existingPreloadHrefs($).has(href)) return html;
  const head = $("head").first();
  if (head.length === 0) return html;
  head.append(
    `<link rel="preload" as="image" href="${href}" fetchpriority="high">`,
  );
  return $.html();
}

const FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/gi;
const URL_RE = /url\(\s*(['"]?)([^'")]+\.woff2)(?:\?[^'")]*)?\1\s*\)/gi;

/**
 * Inject one `<link rel="preload" as="font" type="font/woff2" href="…"
 * crossorigin>` per unique WOFF2 url referenced inside an `@font-face`
 * rule of any inline `<style>` block in `<head>`.  Idempotent (skips
 * any href already declared as `rel="preload"`).
 */
export function injectFontPreloads(html: string): string {
  const $ = cheerio.load(html);
  const head = $("head").first();
  if (head.length === 0) return html;

  const existing = existingPreloadHrefs($);
  const found = new Set<string>();

  head.find("style").each((_i, el) => {
    const css = $(el).text() ?? "";
    let m: RegExpExecArray | null;
    FONT_FACE_RE.lastIndex = 0;
    while ((m = FONT_FACE_RE.exec(css)) !== null) {
      const block = m[1];
      let u: RegExpExecArray | null;
      URL_RE.lastIndex = 0;
      while ((u = URL_RE.exec(block)) !== null) {
        const href = u[2];
        if (!existing.has(href)) found.add(href);
      }
    }
  });

  if (found.size === 0) return html;
  for (const href of found) {
    head.append(
      `<link rel="preload" as="font" type="font/woff2" href="${href}" crossorigin>`,
    );
  }
  return $.html();
}
