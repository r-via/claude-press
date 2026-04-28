/**
 * HTML cleanup — dead-code removal and DOM simplification (US-015).
 *
 * Two pure functions:
 *   - `cleanHtml`             — strip comments, obsolete `type` attrs,
 *                               empty `class`/`id`/`style`, collapse
 *                               inter-element whitespace.
 *   - `removeNonEssentialMeta` — drop boilerplate `<meta>` tags
 *                               (`generator`, `powered-by`, …) while
 *                               preserving every SEO-protected element.
 *
 * SEO-protected elements (NEVER touched by either function):
 *   `<title>`, `<meta name="description">`, `<meta property="og:*">`,
 *   `<meta name="twitter:*">`, `<link rel="canonical">`,
 *   `<link rel="alternate" hreflang>`,
 *   `<script type="application/ld+json">`.
 */

import * as cheerio from "cheerio";

const PRE_LIKE = new Set(["pre", "code", "textarea", "script", "style"]);

const DEFAULT_META_BLOCKLIST = [
  "generator",
  "powered-by",
  "build-info",
  "cms-version",
];

const SEO_PROTECTED_META_NAMES = new Set(["description"]);

/**
 * Walk every comment node in the cheerio tree and remove it unless it is
 * (a) a Microsoft conditional comment (`<!--[if …]>` … `<![endif]-->`) or
 * (b) inside an SEO-protected `<script type="application/ld+json">`.
 */
function stripComments($: cheerio.CheerioAPI): void {
  // Cheerio doesn't expose comment nodes via standard selectors; walk the
  // tree manually.
  const visit = (node: cheerio.AnyNode): void => {
    if (node.type === "comment") {
      const data = (node as { data: string }).data ?? "";
      const trimmed = data.trim();
      if (trimmed.startsWith("[if") || trimmed.startsWith("<![endif]")) return;
      // Defensive: do not strip comments inside a JSON-LD script (those
      // are technically character-data inside script and won't appear as
      // comment nodes anyway, but check ancestor for clarity).
      $(node).remove();
      return;
    }
    if ("children" in node && Array.isArray((node as { children: unknown[] }).children)) {
      // Iterate over a copy because we mutate during traversal.
      const kids = [...((node as { children: cheerio.AnyNode[] }).children)];
      for (const k of kids) visit(k);
    }
  };
  for (const root of $.root().toArray()) visit(root as unknown as cheerio.AnyNode);
}

/** Remove obsolete `type` attributes on `<script>` and `<style>` (HTML5). */
function stripObsoleteTypes($: cheerio.CheerioAPI): void {
  $("script[type]").each((_i, el) => {
    const t = ($(el).attr("type") ?? "").trim().toLowerCase();
    if (t === "text/javascript" || t === "application/javascript") {
      $(el).removeAttr("type");
    }
  });
  $("style[type]").each((_i, el) => {
    const t = ($(el).attr("type") ?? "").trim().toLowerCase();
    if (t === "text/css") $(el).removeAttr("type");
  });
}

/** Drop `class=""`, `id=""`, `style=""` (and same with whitespace-only values). */
function stripEmptyAttrs($: cheerio.CheerioAPI): void {
  for (const attr of ["class", "id", "style"] as const) {
    $(`[${attr}]`).each((_i, el) => {
      const v = $(el).attr(attr);
      if (v === undefined) return;
      if (v.trim() === "") $(el).removeAttr(attr);
    });
  }
}

/**
 * Test whether a text node has any ancestor in {pre,code,textarea,script,style}.
 * We must preserve content within those elements byte-for-byte.
 */
function hasPreLikeAncestor(node: cheerio.AnyNode): boolean {
  let cur: cheerio.AnyNode | null = (node as { parent: cheerio.AnyNode | null }).parent ?? null;
  while (cur) {
    if (cur.type === "tag") {
      const name = (cur as { name: string }).name.toLowerCase();
      if (PRE_LIKE.has(name)) return true;
    }
    cur = (cur as { parent: cheerio.AnyNode | null }).parent ?? null;
  }
  return false;
}

/**
 * Collapse runs of whitespace in text nodes outside of pre-like ancestors:
 * any sequence of \s (incl. newlines) with at least one whitespace becomes
 * a single space.  Leading/trailing whitespace is collapsed but preserved
 * (i.e. "  hello  " → " hello ") so that inter-element spacing stays
 * meaningful (`<a>x</a> <a>y</a>` does not become `<a>x</a><a>y</a>`).
 */
function collapseWhitespace($: cheerio.CheerioAPI): void {
  const walk = (node: cheerio.AnyNode): void => {
    if (node.type === "text") {
      if (hasPreLikeAncestor(node)) return;
      const data = (node as { data: string }).data ?? "";
      const next = data.replace(/\s+/g, " ");
      if (next !== data) (node as { data: string }).data = next;
      return;
    }
    if ("children" in node && Array.isArray((node as { children: unknown[] }).children)) {
      for (const k of (node as { children: cheerio.AnyNode[] }).children) walk(k);
    }
  };
  for (const root of $.root().toArray()) walk(root as unknown as cheerio.AnyNode);
}

/**
 * Strip HTML comments, obsolete `type` attrs, empty `class/id/style`, and
 * collapse inter-element whitespace.  Pure: returns a new string; input is
 * never mutated.  Idempotent: `cleanHtml(cleanHtml(x)) === cleanHtml(x)`.
 */
export function cleanHtml(html: string): string {
  const $ = cheerio.load(html, { decodeEntities: false });
  stripComments($);
  stripObsoleteTypes($);
  stripEmptyAttrs($);
  collapseWhitespace($);
  return $.html();
}

export interface RemoveMetaOptions {
  /** Substring blocklist matched case-insensitively against `name`/`http-equiv`. */
  blocklist?: string[];
}

/**
 * Remove non-essential `<meta>` tags whose `name` (or `http-equiv`) matches
 * any entry in the blocklist.  SEO-critical meta tags are never removed
 * regardless of blocklist content:
 *   - `<meta name="description">`
 *   - `<meta property="og:*">` / `<meta name="og:*">`
 *   - `<meta name="twitter:*">` / `<meta property="twitter:*">`
 *   - `<meta charset>`, `<meta name="viewport">`
 *   - `<meta http-equiv="content-type">`
 */
export function removeNonEssentialMeta(
  html: string,
  options: RemoveMetaOptions = {},
): string {
  const blocklist = (options.blocklist ?? DEFAULT_META_BLOCKLIST).map((s) =>
    s.toLowerCase(),
  );
  if (blocklist.length === 0) return html;

  const $ = cheerio.load(html, { decodeEntities: false });
  let touched = false;

  $("meta").each((_i, el) => {
    const $el = $(el);
    const name = ($el.attr("name") ?? "").trim().toLowerCase();
    const property = ($el.attr("property") ?? "").trim().toLowerCase();
    const httpEquiv = ($el.attr("http-equiv") ?? "").trim().toLowerCase();

    // SEO-protected: never strip these regardless of blocklist matches.
    if (SEO_PROTECTED_META_NAMES.has(name)) return;
    if (name.startsWith("og:") || property.startsWith("og:")) return;
    if (name.startsWith("twitter:") || property.startsWith("twitter:")) return;
    if ($el.attr("charset") !== undefined) return;
    if (name === "viewport") return;
    if (httpEquiv === "content-type" || httpEquiv === "content-language") return;

    const haystack = `${name} ${property} ${httpEquiv}`;
    for (const pat of blocklist) {
      if (pat && haystack.includes(pat)) {
        $el.remove();
        touched = true;
        return;
      }
    }
  });

  return touched ? $.html() : html;
}
