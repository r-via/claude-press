/**
 * Per-page CSS purging and critical CSS inlining (US-008).
 *
 * - `purgeCss(css, html)`: drops top-level rules whose selectors do not
 *   match any element in the given HTML.  At-rules (`@media`, `@font-face`,
 *   `@keyframes`, `@supports`, …) are kept verbatim.
 * - `inlineCriticalCss(html, outputDir)`: runs Beasties to extract above-
 *   the-fold critical CSS, inline it in `<head>`, and convert remaining
 *   `<link rel="stylesheet">` tags into async-loaded references via the
 *   `media="print" onload="this.media='all'"` pattern.
 * - `purgePageCss(html, outputDir)`: convenience wrapper that walks every
 *   `<link rel="stylesheet">` whose href resolves to a local CSS file under
 *   `<outputDir>`, purges it against the page HTML, and rewrites it back.
 *
 * Pure functions where possible; file I/O and the Beasties call live in the
 * orchestrator wrappers.  See README § "Asset pipeline" → CSS.
 */

import * as cheerio from "cheerio";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Beasties from "beasties";

/**
 * Purge CSS rules whose selectors do not match the given HTML.
 *
 * Iterates top-level rules sequentially; at-rules (`@media`, `@keyframes`,
 * `@font-face`, `@supports`, etc.) are kept verbatim — only plain
 * "selector { decls }" rules are filtered.  Pure function.
 */
export function purgeCss(cssContent: string, htmlContent: string): string {
  const $ = cheerio.load(htmlContent);
  const out: string[] = [];
  let i = 0;
  const n = cssContent.length;

  const skipWhitespace = (): void => {
    while (i < n && /\s/.test(cssContent[i]!)) i++;
  };

  // Walk top-level: either an @-rule (kept verbatim) or a regular rule.
  while (i < n) {
    skipWhitespace();
    if (i >= n) break;

    if (cssContent[i] === "@") {
      // Capture the at-rule including its block (if any) verbatim.
      const start = i;
      // Read prelude up to ; or {
      while (i < n && cssContent[i] !== ";" && cssContent[i] !== "{") i++;
      if (i < n && cssContent[i] === ";") {
        i++;
        out.push(cssContent.slice(start, i));
      } else if (i < n && cssContent[i] === "{") {
        // Skip balanced braces
        let depth = 0;
        while (i < n) {
          const ch = cssContent[i]!;
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
          i++;
        }
        out.push(cssContent.slice(start, i));
      } else {
        // EOF without terminator
        out.push(cssContent.slice(start, i));
      }
      continue;
    }

    // Regular rule: read selector list up to {
    const selStart = i;
    while (i < n && cssContent[i] !== "{") i++;
    if (i >= n) break;
    const selectorList = cssContent.slice(selStart, i).trim();

    // Read body up to balanced }
    const bodyStart = i;
    let depth = 0;
    while (i < n) {
      const ch = cssContent[i]!;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    const body = cssContent.slice(bodyStart, i);

    if (selectorMatchesHtml($, selectorList)) {
      out.push(`${selectorList} ${body}`);
    }
  }

  return out.join("\n");
}

function selectorMatchesHtml($: cheerio.CheerioAPI, selectorList: string): boolean {
  // Comma-separated selector groups; keep rule if ANY group matches.
  const groups = selectorList.split(",").map((s) => s.trim()).filter(Boolean);
  for (const sel of groups) {
    if (selectorMatchesGroup($, sel)) return true;
  }
  return false;
}

function selectorMatchesGroup($: cheerio.CheerioAPI, selector: string): boolean {
  // Strip pseudo-classes / pseudo-elements that cheerio cannot evaluate
  // (`:hover`, `::before`, `:nth-child(...)` with non-numeric args, etc.).
  // Keep structural selectors (tag/class/id/descendant/child).
  const cleaned = selector
    .replace(/::[a-zA-Z-]+(\([^)]*\))?/g, "")
    .replace(/:[a-zA-Z-]+(\([^)]*\))?/g, "")
    .trim();
  if (!cleaned) {
    // Pure pseudo selector (e.g. `:root`); keep the rule conservatively.
    return true;
  }
  try {
    return $(cleaned).length > 0;
  } catch {
    // Cheerio choked — keep the rule rather than risk dropping used styles.
    return true;
  }
}

/**
 * Inline critical CSS into `<head>` and defer non-critical stylesheets via
 * `media="print" onload="this.media='all'"`.  Uses Beasties under the hood;
 * stylesheets referenced by `<link rel="stylesheet">` are resolved relative
 * to `outputDir`.
 *
 * Pages with no `<link rel="stylesheet">` short-circuit and are returned
 * untouched.
 */
export async function inlineCriticalCss(html: string, outputDir: string): Promise<string> {
  const $probe = cheerio.load(html);
  if ($probe('link[rel="stylesheet"]').length === 0) {
    return html;
  }

  const beasties = new Beasties({
    path: outputDir,
    preload: "media",
    pruneSource: false,
    logLevel: "silent",
  });
  let processed: string;
  try {
    processed = await beasties.process(html);
  } catch {
    // Beasties failed (e.g. stylesheet not on disk).  Fall back to manually
    // deferring every stylesheet so we still eliminate render-blocking
    // resources.
    processed = html;
  }

  // Belt-and-suspenders: ensure no synchronous `<link rel="stylesheet">`
  // remains in <head>.  Convert any leftover to async pattern.
  const $ = cheerio.load(processed);
  $('link[rel="stylesheet"]').each((_i, el) => {
    const $el = $(el);
    if ($el.attr("media") === "print" && $el.attr("onload")) return; // already async
    $el.attr("media", "print");
    $el.attr("onload", "this.media='all'");
  });
  return $.html();
}

/**
 * For every local stylesheet referenced by the page, purge its rules against
 * the page HTML and write the purged CSS back to disk.  Local stylesheets
 * are detected by relative or root-absolute hrefs that resolve to a file
 * under `outputDir`.
 */
export async function purgePageCss(html: string, outputDir: string): Promise<string> {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links = $('link[rel="stylesheet"]').toArray();
  for (const el of links) {
    const href = $(el).attr("href");
    if (!href) continue;
    if (/^https?:\/\//i.test(href) || href.startsWith("data:")) continue;
    const rel = href.replace(/^\.?\/+/, "").split(/[?#]/)[0]!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const cssAbs = resolve(outputDir, rel);
    let css: string;
    try {
      css = await readFile(cssAbs, "utf8");
    } catch {
      continue;
    }
    const purged = purgeCss(css, html);
    if (purged !== css) {
      await writeFile(cssAbs, purged);
    }
  }
  return html;
}
