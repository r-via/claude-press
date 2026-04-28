/**
 * Font subsetting + `font-display: swap` injection (US-010).
 *
 * - `subsetFonts(outputDir, assetManifest, options?)`: scans every output HTML
 *   page under `<outputDir>/pages/` for the union of used codepoints, then
 *   subsets each font under `<outputDir>/assets/fonts/` to those glyphs and
 *   re-encodes as WOFF2 in-place.  Reports total bytes saved + per-font
 *   breakdown.
 * - `injectFontDisplaySwap(css)`: pure string transform that ensures every
 *   `@font-face { ... }` block contains `font-display: swap`, replacing any
 *   existing value.
 *
 * Subsetting is delegated to the `subset-font` package (harfbuzz-via-wasm,
 * no native addons).  Tests inject a fake `subsetImpl` so the suite stays
 * fast and deterministic without bundling real font binaries.  See
 * README § "Asset pipeline" → Fonts.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as cheerio from "cheerio";
import type { AssetManifest } from "./assets.js";

export interface FontSubsetResult {
  /** Local relative path of the font file (e.g. `assets/fonts/foo.woff2`). */
  localPath: string;
  bytesBefore: number;
  bytesAfter: number;
  /** Set when subsetting failed and the original was left in place. */
  error?: string;
}

export interface FontOptResult {
  fontsProcessed: number;
  bytesBefore: number;
  bytesAfter: number;
  perFont: FontSubsetResult[];
}

export type SubsetImpl = (
  font: Buffer,
  text: string,
  opts: { targetFormat: "woff2" },
) => Promise<Buffer>;

export interface SubsetFontsOptions {
  /**
   * Override the underlying subsetter — defaults to dynamically loading
   * `subset-font`.  Tests inject a deterministic mock here.
   */
  subsetImpl?: SubsetImpl;
  log?: (msg: string) => void;
}

const FONT_EXTS = new Set([".woff", ".woff2", ".ttf", ".otf"]);

async function* walkHtmlFiles(dir: string): AsyncIterable<string> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
  for (const e of entries) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      yield* walkHtmlFiles(p);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".html")) {
      yield p;
    }
  }
}

async function* walkFontFiles(dir: string): AsyncIterable<string> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
  for (const e of entries) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFontFiles(p);
    } else if (e.isFile()) {
      const lower = e.name.toLowerCase();
      for (const ext of FONT_EXTS) {
        if (lower.endsWith(ext)) {
          yield p;
          break;
        }
      }
    }
  }
}

/**
 * Collect the union of every codepoint that appears in any text node of any
 * HTML page under `<outputDir>/pages/`.  Returns the codepoints as a string
 * (each character appearing exactly once) — the format `subset-font` expects.
 */
async function collectUsedGlyphs(pagesDir: string): Promise<string> {
  const seen = new Set<string>();
  for await (const path of walkHtmlFiles(pagesDir)) {
    let html: string;
    try {
      html = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const $ = cheerio.load(html);
    // Drop scripts/styles so we don't subset to JS/CSS source code glyphs.
    $("script, style, noscript").remove();
    const text = $("body").text() + " " + $("title").text();
    for (const ch of text) seen.add(ch);
  }
  return [...seen].join("");
}

let _cachedSubsetImpl: SubsetImpl | undefined;
async function defaultSubsetImpl(): Promise<SubsetImpl> {
  if (_cachedSubsetImpl) return _cachedSubsetImpl;
  // Dynamic import keeps the wasm load lazy + makes the dep optional in tests.
  const mod = (await import("subset-font")) as
    | { default: SubsetImpl }
    | SubsetImpl;
  const fn = (typeof mod === "function" ? mod : mod.default) as SubsetImpl;
  _cachedSubsetImpl = fn;
  return fn;
}

/**
 * Subset every font asset to the union of glyphs used across output HTML
 * pages, re-encoding the result as WOFF2 in place.  Fonts that fail to
 * subset (corrupt source, unsupported format) are left untouched and
 * recorded with an `error` in the per-font report.
 */
export async function subsetFonts(
  outputDir: string,
  _assetManifest: AssetManifest,
  options: SubsetFontsOptions = {},
): Promise<FontOptResult> {
  const log = options.log ?? (() => undefined);
  const fontsDir = resolve(outputDir, "assets", "fonts");
  const pagesDir = resolve(outputDir, "pages");

  // If neither dir exists, return an empty report — nothing to do.
  try {
    await stat(fontsDir);
  } catch {
    return { fontsProcessed: 0, bytesBefore: 0, bytesAfter: 0, perFont: [] };
  }

  const usedText = await collectUsedGlyphs(pagesDir);
  // subset-font requires non-empty text.  If pages have no text whatsoever
  // (empty build) fall back to the printable ASCII range so output is still
  // a valid font and not a corrupt zero-glyph file.
  const subsetText = usedText.length > 0 ? usedText : ASCII_FALLBACK;

  const subsetImpl = options.subsetImpl ?? (await defaultSubsetImpl());
  const result: FontOptResult = {
    fontsProcessed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    perFont: [],
  };

  for await (const path of walkFontFiles(fontsDir)) {
    let original: Buffer;
    try {
      original = await readFile(path);
    } catch (err) {
      log(`[fonts] read failed for ${path}: ${(err as Error).message}`);
      continue;
    }
    const before = original.byteLength;
    result.bytesBefore += before;
    try {
      const out = await subsetImpl(original, subsetText, {
        targetFormat: "woff2",
      });
      await writeFile(path, out);
      const after = out.byteLength;
      result.bytesAfter += after;
      result.fontsProcessed++;
      result.perFont.push({
        localPath: path,
        bytesBefore: before,
        bytesAfter: after,
      });
    } catch (err) {
      const msg = (err as Error).message;
      log(`[fonts] subset failed for ${path}: ${msg}`);
      result.bytesAfter += before;
      result.perFont.push({
        localPath: path,
        bytesBefore: before,
        bytesAfter: before,
        error: msg,
      });
    }
  }
  return result;
}

const ASCII_FALLBACK =
  " !\"#$%&'()*+,-./0123456789:;<=>?@" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`" +
  "abcdefghijklmnopqrstuvwxyz{|}~";

/**
 * Ensure every `@font-face { ... }` block declares `font-display: swap`.
 * - Adds the declaration when absent.
 * - Replaces any other `font-display` value.
 * - Returns the input unchanged when no `@font-face` block exists.
 *
 * Pure string transform — does NOT parse the full CSS grammar; it scans for
 * `@font-face` blocks via brace matching.  This is sufficient for the
 * intra-block edit and avoids pulling lightningcss for a single declaration.
 */
export function injectFontDisplaySwap(css: string): string {
  if (!css.includes("@font-face")) return css;
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const idx = css.indexOf("@font-face", i);
    if (idx === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, idx);
    // Find opening brace.
    const open = css.indexOf("{", idx);
    if (open === -1) {
      out += css.slice(idx);
      break;
    }
    // Find matching closing brace at depth 0 (no nested @font-face in spec
    // — but be defensive and balance just in case).
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      const ch = css[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) break;
      j++;
    }
    if (j >= n) {
      // Malformed — leave the rest alone.
      out += css.slice(idx);
      break;
    }
    const head = css.slice(idx, open + 1);
    const body = css.slice(open + 1, j);
    const tail = css.slice(j, j + 1); // the closing }
    out += head + rewriteFontFaceBody(body) + tail;
    i = j + 1;
  }
  return out;
}

function rewriteFontFaceBody(body: string): string {
  // Replace any existing font-display declaration.
  const re = /font-display\s*:\s*[^;}]+;?/i;
  if (re.test(body)) {
    return body.replace(re, "font-display: swap;");
  }
  // Inject before the closing of the block.  Preserve trailing whitespace.
  const trimmedRight = body.replace(/\s+$/, "");
  const trailing = body.slice(trimmedRight.length);
  // Ensure the previous declaration ends with a semicolon.
  const needsSemi =
    trimmedRight.length > 0 && !trimmedRight.trimEnd().endsWith(";");
  return (
    trimmedRight + (needsSemi ? ";" : "") + " font-display: swap;" + trailing
  );
}
