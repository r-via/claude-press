/**
 * JS minification and non-essential script handling (US-009).
 *
 * - `minifyJsAssets(outputDir)`: minifies every `.js` file under
 *   `<outputDir>/assets/js/` in-place using `terser` (compress + mangle),
 *   reporting total before/after byte counts.
 * - `deferNonEssentialScripts(html, blocklist?)`: walks the HTML with
 *   cheerio and either defers (`defer` attribute) or removes `<script>`
 *   tags whose `src` matches a blocklist of known non-essential third-party
 *   patterns.  Inline `<script>` blocks are minified in-place.
 *
 * Pure where possible — only `minifyJsAssets` performs file I/O.  See
 * README § "Asset pipeline" → JS and § "Optimizations applied".
 */

import * as cheerio from "cheerio";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { minify, type MinifyOptions } from "terser";

export interface JsOptResult {
  filesProcessed: number;
  filesFailed: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface DeferOptions {
  /**
   * Array of substring patterns matched against the `<script>` `src`.
   * Default: well-known analytics / chat / heatmap providers.
   */
  blocklist?: string[];
  /**
   * `"remove"` deletes the offending `<script>` from the DOM entirely.
   * `"defer"` (default) leaves the tag but adds `defer` so it loads
   * asynchronously without blocking parsing.
   */
  strategy?: "remove" | "defer";
}

const DEFAULT_BLOCKLIST = [
  "google-analytics",
  "gtag/js",
  "googletagmanager",
  "fbevents",
  "facebook.net",
  "hotjar",
  "intercom",
  "segment.io",
  "mixpanel",
  "doubleclick",
];

// Asset-file minification: aggressive toplevel mangling + dead-code removal.
// Each `.js` under assets/ is treated as a self-contained module so renaming
// top-level identifiers is safe and yields the largest size win.
const TERSER_ASSET_OPTS: MinifyOptions = {
  compress: { dead_code: true, drop_console: false, toplevel: true },
  mangle: { toplevel: true },
};

// Inline-script minification: keep toplevel intact since inline `<script>`s
// commonly define globals consumed by other scripts on the page.  We still
// compress + mangle locals.
const TERSER_INLINE_OPTS: MinifyOptions = {
  compress: { dead_code: true, drop_console: false },
  mangle: true,
};

async function* walkJsFiles(dir: string): AsyncIterable<string> {
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
      yield* walkJsFiles(p);
    } else if (e.isFile() && e.name.endsWith(".js")) {
      yield p;
    }
  }
}

/**
 * Minify every `.js` file under `<outputDir>/assets/js/` (recursively),
 * overwriting each in-place with the compressed + mangled output.  Files
 * that fail to parse are left untouched and counted under `filesFailed`
 * — terser is intentionally non-fatal so a single broken vendor script
 * cannot abort the build.
 */
export async function minifyJsAssets(outputDir: string): Promise<JsOptResult> {
  const jsDir = resolve(outputDir, "assets", "js");
  const result: JsOptResult = {
    filesProcessed: 0,
    filesFailed: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
  for await (const path of walkJsFiles(jsDir)) {
    try {
      const before = await readFile(path, "utf8");
      result.bytesBefore += Buffer.byteLength(before, "utf8");
      if (before.trim().length === 0) {
        result.bytesAfter += Buffer.byteLength(before, "utf8");
        result.filesProcessed++;
        continue;
      }
      const out = await minify(before, TERSER_ASSET_OPTS);
      if (typeof out.code !== "string") {
        result.bytesAfter += Buffer.byteLength(before, "utf8");
        result.filesFailed++;
        continue;
      }
      await writeFile(path, out.code);
      result.bytesAfter += Buffer.byteLength(out.code, "utf8");
      result.filesProcessed++;
    } catch (err) {
      // terser bailed (syntax error, unsupported construct, …).  Keep the
      // original on disk and tally the failure so the operator sees it.
      const before = await readFile(path, "utf8").catch(() => "");
      result.bytesAfter += Buffer.byteLength(before, "utf8");
      result.filesFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      // Use stat to ensure path printed exists; harmless side-effect.
      await stat(path).catch(() => undefined);
      console.warn(`[js] minify failed for ${path}: ${msg}`);
    }
  }
  return result;
}

/**
 * For each `<script src=...>` whose `src` matches the blocklist, either
 * remove it or add `defer`.  Inline `<script>` blocks (no `src`) are
 * minified via terser in-place — failures leave the original intact.
 *
 * Pure with respect to the input HTML: returns a new HTML string and
 * does no I/O.  The function is *async* because terser's API is async.
 */
export async function deferNonEssentialScripts(
  html: string,
  options: DeferOptions = {},
): Promise<string> {
  const blocklist = options.blocklist ?? DEFAULT_BLOCKLIST;
  const strategy = options.strategy ?? "defer";
  const $ = cheerio.load(html);

  const isBlocked = (src: string): boolean =>
    blocklist.some((p) => src.includes(p));

  const scripts = $("script").toArray();
  for (const el of scripts) {
    const $el = $(el);
    const src = $el.attr("src");
    if (src) {
      if (isBlocked(src)) {
        if (strategy === "remove") {
          $el.remove();
        } else {
          $el.attr("defer", "");
        }
      }
      continue;
    }
    // Inline script — minify the body.
    const body = $el.html() ?? "";
    if (body.trim().length === 0) continue;
    try {
      const out = await minify(body, TERSER_INLINE_OPTS);
      if (typeof out.code === "string") {
        $el.text(out.code);
      }
    } catch {
      // Leave the original inline body alone on terser failure.
    }
  }

  return $.html();
}
