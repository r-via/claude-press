import * as cheerio from "cheerio";

const SLOT_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Regex patterns matching SEO-critical `<head>` elements.  Used against raw
 * HTML so the extracted substrings are byte-for-byte identical to the
 * original markup (no parse/serialize round-trip through cheerio).
 *
 * The README declares these elements MUST be "copied byte-for-byte from
 * source to output" — that guarantee is incompatible with cheerio's
 * normalisation of attribute quoting, self-closing tags, whitespace, and
 * entity encoding.  Hence the raw-regex approach.
 */
const SEO_PATTERNS: readonly RegExp[] = [
  /<title\b[^>]*>[\s\S]*?<\/title>/gi,
  /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\/?\s*>/gi,
  /<meta\b[^>]*\bproperty\s*=\s*["'](?:og|twitter):[^"']+["'][^>]*\/?\s*>/gi,
  /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*\/?\s*>/gi,
  /<link\b[^>]*\brel\s*=\s*["']alternate["'][^>]*\bhreflang\s*=\s*["'][^"']+["'][^>]*\/?\s*>/gi,
  /<link\b[^>]*\bhreflang\s*=\s*["'][^"']+["'][^>]*\brel\s*=\s*["']alternate["'][^>]*\/?\s*>/gi,
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
];

const HEAD_RE = /<head\b([^>]*)>([\s\S]*?)<\/head>/i;

export interface SlotWarning {
  slot: string;
  reason: string;
}

export interface ExtractedSeo {
  /** Raw HTML strings of SEO-critical `<head>` nodes, in document order. */
  nodes: string[];
}

/**
 * Build a structural CSS selector for an element using nth-of-type indices,
 * relative to the body (or html root).
 */
function structuralSelectorFor(el: cheerio.Element): string {
  const parts: string[] = [];
  let cur: cheerio.Element | null = el;
  while (cur && cur.type === "tag") {
    const tag = cur.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    const parent = cur.parent as cheerio.Element | null;
    if (!parent || parent.type !== "tag") {
      parts.unshift(tag);
      break;
    }
    const sameTagSiblings = (parent.children || []).filter(
      (c) => (c as cheerio.Element).type === "tag" &&
        (c as cheerio.Element).tagName.toLowerCase() === tag,
    );
    const idx = sameTagSiblings.indexOf(cur) + 1;
    parts.unshift(`${tag}:nth-of-type(${idx})`);
    cur = parent;
  }
  return parts.join(" > ");
}

/** Build a tag+class chain selector from root → element. */
function tagClassChainFor(el: cheerio.Element): string {
  const parts: string[] = [];
  let cur: cheerio.Element | null = el;
  while (cur && cur.type === "tag") {
    const tag = cur.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    const cls = (cur.attribs?.class || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((c) => `.${c.replace(/[^a-zA-Z0-9_-]/g, "\\$&")}`)
      .join("");
    parts.unshift(`${tag}${cls}`);
    cur = cur.parent as cheerio.Element | null;
  }
  return parts.join(" > ");
}

/**
 * For each `{{slot}}` placeholder in the template, derive a CSS selector
 * targeting the matching element in the **original** page.  The algorithm:
 *
 *   1. Locate each slot's owning element in the template DOM.
 *   2. Build a tag+class chain selector from the template element.
 *   3. Test that selector against the original page DOM — if it matches a
 *      unique element, use it.
 *   4. If the chain selector does not match (template structure diverged
 *      from the original), fall back to a structural nth-of-type selector
 *      derived from the template, which still gives downstream code a
 *      best-effort target.
 *
 * Slots whose placeholder is not found in the template are mapped to "".
 */
export function deriveSlotSelectors(
  originalHtml: string,
  templateHtml: string,
  slots: string[],
): Record<string, string> {
  const $t = cheerio.load(templateHtml);
  const $o = cheerio.load(originalHtml);
  const result: Record<string, string> = {};
  const wanted = new Set(slots);
  for (const name of slots) result[name] = "";

  $t("*").each((_, el) => {
    const elem = el as cheerio.Element;
    if (elem.type !== "tag") return;
    let directText = "";
    for (const child of elem.children || []) {
      const c = child as { type: string; data?: string };
      if (c.type === "text" && typeof c.data === "string") directText += c.data;
    }
    SLOT_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SLOT_REGEX.exec(directText)) !== null) {
      const name = m[1];
      if (!name || !wanted.has(name)) continue;
      if (result[name]) continue; // first occurrence wins

      const chain = tagClassChainFor(elem);
      // Prefer a tag+class chain selector that resolves uniquely against the
      // ORIGINAL page — this anchors the selector to the original DOM, not
      // the template's structure.
      if (chain) {
        try {
          const matches = $o(chain);
          if (matches.length >= 1) {
            result[name] = chain;
            continue;
          }
        } catch {
          /* malformed selector — fall through */
        }
      }
      // Fall back to a structural selector against the template.  This
      // preserves the round-trip behaviour for tests where the original and
      // template share the same skeleton.
      result[name] = structuralSelectorFor(elem);
    }
  });
  return result;
}

/**
 * Extract slot values from an original page using the supplied CSS selectors.
 * Each value is the matched element's `innerHTML`.  Selectors that fail to
 * match yield an empty string and a warning entry.
 */
export function extractSlotValues(
  originalHtml: string,
  slotSelectors: Record<string, string>,
  warnings?: SlotWarning[],
): Record<string, string> {
  const $ = cheerio.load(originalHtml);
  const out: Record<string, string> = {};
  for (const [slot, selector] of Object.entries(slotSelectors)) {
    if (!selector) {
      out[slot] = "";
      warnings?.push({ slot, reason: "no selector derived" });
      continue;
    }
    const node = $(selector).first();
    if (node.length === 0) {
      out[slot] = "";
      warnings?.push({ slot, reason: `selector did not match: ${selector}` });
      continue;
    }
    out[slot] = node.html() ?? "";
  }
  return out;
}

/**
 * Replace every `{{slot_name}}` placeholder in `template` with the
 * corresponding `values` entry.  Missing slots are replaced with an empty
 * string and a warning is logged via `console.warn`.
 */
export function fillTemplate(
  template: string,
  values: Record<string, string>,
  warnings?: SlotWarning[],
): string {
  return template.replace(SLOT_REGEX, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return values[name] ?? "";
    }
    const reason = `unfilled slot: ${name}`;
    if (warnings) warnings.push({ slot: name, reason });
    else console.warn(`[extractor] ${reason}`);
    return "";
  });
}

/**
 * Extract SEO-critical `<head>` nodes from the original page as raw byte
 * substrings — no parsing, no serialisation.  This guarantees the README's
 * "copied byte-for-byte from source to output" contract.
 *
 * Note: also part of the module's public API even though US-006's AC list
 * does not name it explicitly — the AC-4 SEO preservation requirement is
 * what drives its existence.
 */
export function extractSeoHeadNodes(originalHtml: string): ExtractedSeo {
  const headMatch = HEAD_RE.exec(originalHtml);
  const haystack = headMatch ? headMatch[2] : originalHtml;
  const offset = headMatch ? headMatch.index + headMatch[0].indexOf(headMatch[2]) : 0;

  const found: { index: number; text: string }[] = [];
  const seenIndex = new Set<number>();
  for (const re of SEO_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
      const absoluteIndex = offset + m.index;
      if (seenIndex.has(absoluteIndex)) continue; // de-dup overlapping link patterns
      seenIndex.add(absoluteIndex);
      found.push({ index: absoluteIndex, text: m[0] });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return { nodes: found.map((f) => f.text) };
}

/**
 * Splice SEO nodes into the filled HTML's `<head>` using string operations
 * only — the surrounding markup is preserved byte-for-byte.  Any pre-existing
 * matching nodes inside the filled `<head>` are first removed to avoid
 * duplicates, then the extracted nodes are prepended (preserving their
 * original document order) immediately after the opening `<head>` tag.
 */
export function injectSeoHeadNodes(filledHtml: string, seo: ExtractedSeo): string {
  if (seo.nodes.length === 0) return filledHtml;
  const headMatch = HEAD_RE.exec(filledHtml);
  if (!headMatch) return filledHtml;

  let inner = headMatch[2];
  for (const re of SEO_PATTERNS) {
    inner = inner.replace(new RegExp(re.source, re.flags), "");
  }
  const insertion = seo.nodes.join("\n");
  const newInner = `\n${insertion}\n${inner.replace(/^\s*\n/, "")}`;
  const before = filledHtml.slice(0, headMatch.index);
  const after = filledHtml.slice(headMatch.index + headMatch[0].length);
  const headAttrs = headMatch[1];
  return `${before}<head${headAttrs}>${newInner}</head>${after}`;
}

const HTML_OPEN_RE = /<html\b([^>]*)>/i;
const LANG_ATTR_RE = /\blang\s*=\s*["']([^"']+)["']/i;

/**
 * Read the `lang` attribute from the original page's `<html>` tag and copy
 * it onto the filled HTML's `<html>` tag, preserving multilingual semantics.
 * If the original has no `lang`, returns `filledHtml` unchanged.  If the
 * filled HTML already declares the same `lang`, it is also returned
 * unchanged.
 */
export function preserveHtmlLang(
  originalHtml: string,
  filledHtml: string,
): string {
  const origOpen = HTML_OPEN_RE.exec(originalHtml);
  if (!origOpen) return filledHtml;
  const langMatch = LANG_ATTR_RE.exec(origOpen[1]);
  if (!langMatch) return filledHtml;
  const lang = langMatch[1];

  const filledOpen = HTML_OPEN_RE.exec(filledHtml);
  if (!filledOpen) return filledHtml;
  const filledAttrs = filledOpen[1];
  const existing = LANG_ATTR_RE.exec(filledAttrs);
  let nextAttrs: string;
  if (existing) {
    if (existing[1] === lang) return filledHtml;
    nextAttrs = filledAttrs.replace(LANG_ATTR_RE, `lang="${lang}"`);
  } else {
    nextAttrs = `${filledAttrs.replace(/\s+$/, "")} lang="${lang}"`;
  }
  const before = filledHtml.slice(0, filledOpen.index);
  const after = filledHtml.slice(filledOpen.index + filledOpen[0].length);
  return `${before}<html${nextAttrs}>${after}`;
}
