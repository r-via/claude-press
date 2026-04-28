import * as cheerio from "cheerio";
import type { AssetManifest } from "./assets.js";

export interface RewriteOptions {
  /** Called with each URL that could not be matched in the manifest. */
  onUnmatched?: (url: string) => void;
}

/**
 * Resolve `ref` against `baseUrl` to an absolute URL string.  Returns
 * `undefined` for refs that should never be rewritten (data URIs,
 * `javascript:`, `mailto:`, fragment-only links, empty strings).
 */
function toAbsolute(ref: string | undefined, baseUrl: string): string | undefined {
  if (!ref) return undefined;
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("data:") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("#")
  ) {
    return undefined;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Compute a relative path from a page's local file location back to an asset's
 * local path.  Both inputs are paths relative to the output root.  We always
 * emit a leading `./` or `../` so the result is unambiguously relative.
 */
function relativeFromPage(pageLocalPath: string, assetLocalPath: string): string {
  // pageLocalPath e.g. "pages/en/blog/index.html"; assetLocalPath e.g.
  // "assets/css/style-abcd1234.css".  Compute "../../../assets/css/...".
  const pageParts = pageLocalPath.split("/").slice(0, -1); // drop file
  const depth = pageParts.length;
  const up = depth === 0 ? "./" : "../".repeat(depth);
  return `${up}${assetLocalPath}`;
}

interface RewriteHtmlInput {
  html: string;
  pageUrl: string;
  manifest: AssetManifest;
  /** Path of the HTML file relative to the output dir, e.g. `pages/en/index.html`. */
  pageLocalPath?: string;
  options?: RewriteOptions;
}

export interface RewriteHtmlAssetUrlsArgs extends RewriteHtmlInput {}

/**
 * Rewrite every asset URL in `html` to its local manifest path.  Touches
 * `src`, `href`, and `srcset` on `<img>`, `<source>`, `<script>`,
 * `<link rel="stylesheet">`, `<video>`, and `<audio>` elements.  Returns the
 * rewritten HTML; unmatched URLs are left intact and reported via
 * `options.onUnmatched`.
 */
export function rewriteHtmlAssetUrls(args: RewriteHtmlAssetUrlsArgs): string;
export function rewriteHtmlAssetUrls(
  html: string,
  pageUrl: string,
  manifest: AssetManifest,
  options?: RewriteOptions & { pageLocalPath?: string },
): string;
export function rewriteHtmlAssetUrls(
  htmlOrArgs: string | RewriteHtmlAssetUrlsArgs,
  pageUrl?: string,
  manifest?: AssetManifest,
  options?: RewriteOptions & { pageLocalPath?: string },
): string {
  let html: string;
  let base: string;
  let m: AssetManifest;
  let opts: RewriteOptions;
  let pageLocalPath: string | undefined;
  if (typeof htmlOrArgs === "string") {
    html = htmlOrArgs;
    base = pageUrl!;
    m = manifest!;
    opts = options ?? {};
    pageLocalPath = options?.pageLocalPath;
  } else {
    html = htmlOrArgs.html;
    base = htmlOrArgs.pageUrl;
    m = htmlOrArgs.manifest;
    opts = htmlOrArgs.options ?? {};
    pageLocalPath = htmlOrArgs.pageLocalPath;
  }

  const $ = cheerio.load(html, { decodeEntities: false });

  const localFor = (abs: string): string | undefined => {
    const target = m[abs];
    if (!target) return undefined;
    return pageLocalPath ? relativeFromPage(pageLocalPath, target) : `/${target}`;
  };

  const rewriteAttr = (
    el: cheerio.Element,
    attr: "src" | "href",
  ): void => {
    const $el = $(el);
    const raw = $el.attr(attr);
    const abs = toAbsolute(raw, base);
    if (!abs) return;
    const local = localFor(abs);
    if (local) {
      $el.attr(attr, local);
    } else if (opts.onUnmatched) {
      opts.onUnmatched(abs);
    }
  };

  const rewriteSrcset = (el: cheerio.Element): void => {
    const $el = $(el);
    const raw = $el.attr("srcset");
    if (!raw) return;
    const out: string[] = [];
    let anyChange = false;
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const segs = trimmed.split(/\s+/);
      const candidate = segs[0];
      const descriptor = segs.slice(1).join(" ");
      const abs = toAbsolute(candidate, base);
      if (abs) {
        const local = localFor(abs);
        if (local) {
          out.push(descriptor ? `${local} ${descriptor}` : local);
          anyChange = true;
          continue;
        } else if (opts.onUnmatched) {
          opts.onUnmatched(abs);
        }
      }
      out.push(trimmed);
    }
    if (anyChange) $el.attr("srcset", out.join(", "));
  };

  $('link[rel="stylesheet"]').each((_i, el) => rewriteAttr(el, "href"));
  $("link[rel]").each((_i, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    if (
      rel.includes("icon") ||
      rel.includes("apple-touch-icon") ||
      rel.includes("preload") ||
      rel.includes("canonical") ||
      rel.includes("alternate")
    ) {
      rewriteAttr(el, "href");
    }
  });
  $("script[src]").each((_i, el) => rewriteAttr(el, "src"));
  $("img[src]").each((_i, el) => rewriteAttr(el, "src"));
  $("img[srcset]").each((_i, el) => rewriteSrcset(el));
  $("source[src]").each((_i, el) => rewriteAttr(el, "src"));
  $("source[srcset]").each((_i, el) => rewriteSrcset(el));
  $("video[src]").each((_i, el) => rewriteAttr(el, "src"));
  $("audio[src]").each((_i, el) => rewriteAttr(el, "src"));
  $("video[poster]").each((_i, el) => {
    const $el = $(el);
    const abs = toAbsolute($el.attr("poster"), base);
    if (!abs) return;
    const local = localFor(abs);
    if (local) $el.attr("poster", local);
    else if (opts.onUnmatched) opts.onUnmatched(abs);
  });

  return $.html();
}

/**
 * Rewrite `href` attributes on `<link rel="alternate" hreflang="...">` tags
 * from `originalBaseUrl` to `localBaseUrl`, preserving the path.  Other links
 * are left untouched.  Pages with no hreflang links are returned unchanged.
 *
 * When `localBaseUrl` is falsy (empty string / undefined) OR is identical to
 * `originalBaseUrl`'s origin, the rewrite emits **path-only** hrefs (the
 * `pathname + search + hash` portion of the original URL).  This is the
 * useful default when the cache is served from a not-yet-known host —
 * relative-root paths work regardless of where the cache is mounted.
 */
export function rewriteHreflangUrls(
  html: string,
  originalBaseUrl: string,
  localBaseUrl?: string,
): string {
  if (!/hreflang/i.test(html)) return html;

  const $ = cheerio.load(html, { decodeEntities: false });
  let touched = false;

  let originOriginal: string;
  try {
    originOriginal = new URL(originalBaseUrl).origin;
  } catch {
    return html;
  }

  let originLocal: string | null = null;
  if (localBaseUrl) {
    try {
      originLocal = new URL(localBaseUrl).origin;
    } catch {
      originLocal = localBaseUrl.replace(/\/+$/, "");
    }
    // Identical origin → degenerate to path-only rewrite (otherwise the
    // call is a no-op, which silently breaks the integration wiring).
    if (originLocal === originOriginal) originLocal = null;
  }

  $('link[rel="alternate"][hreflang]').each((_i, el) => {
    const $el = $(el);
    const raw = $el.attr("href");
    if (!raw) return;
    let absolute: URL;
    try {
      absolute = new URL(raw, originalBaseUrl);
    } catch {
      return;
    }
    if (absolute.origin !== originOriginal) return;
    const path = absolute.pathname + absolute.search + absolute.hash;
    const next = originLocal === null ? path : `${originLocal}${path}`;
    if (next !== raw) {
      $el.attr("href", next);
      touched = true;
    }
  });

  return touched ? $.html() : html;
}

const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * Rewrite every `url(...)` reference in `css` to its local manifest path.
 * `cssUrl` is the absolute URL the CSS file was originally fetched from and
 * is used to resolve relative references.  Unmatched URLs are left intact and
 * reported via `options.onUnmatched`.
 */
export function rewriteCssUrls(
  css: string,
  cssUrl: string,
  manifest: AssetManifest,
  options: RewriteOptions & { cssLocalPath?: string } = {},
): string {
  const cssLocalPath = options.cssLocalPath;
  return css.replace(URL_RE, (whole, quote: string, ref: string) => {
    const abs = toAbsolute(ref, cssUrl);
    if (!abs) return whole;
    const target = manifest[abs];
    if (!target) {
      options.onUnmatched?.(abs);
      return whole;
    }
    const local = cssLocalPath
      ? relativeFromPage(cssLocalPath, target)
      : `/${target}`;
    return `url(${quote}${local}${quote})`;
  });
}
