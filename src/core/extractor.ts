import * as cheerio from "cheerio";

const SLOT_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Names of `<head>` elements treated as read-only (SEO-critical). */
const SEO_TAGS = ["title"];
const SEO_META_NAMES = ["description"];
const SEO_META_PROPERTY_PREFIXES = ["og:", "twitter:"];
const SEO_LINK_RELS = ["canonical", "alternate"];

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
function selectorFor($: cheerio.CheerioAPI, el: cheerio.Element): string {
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

/**
 * Walk the template DOM looking for `{{slot}}` placeholders.  For each slot
 * name in `slots`, return a CSS selector locating the element whose direct
 * text content (or innerHTML) is the placeholder.  Slots not found in the
 * template are mapped to an empty string.
 */
export function deriveSlotSelectors(
  _originalHtml: string,
  templateHtml: string,
  slots: string[],
): Record<string, string> {
  const $ = cheerio.load(templateHtml);
  const result: Record<string, string> = {};
  const wanted = new Set(slots);
  for (const name of slots) result[name] = "";

  $("*").each((_, el) => {
    const elem = el as cheerio.Element;
    if (elem.type !== "tag") return;
    // Inspect ONLY direct text children — descendant text would resolve the
    // wrong (outer) element to the slot.
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
      result[name] = selectorFor($, elem);
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
 * Extract SEO-critical `<head>` nodes from the original page so they can be
 * spliced verbatim into the filled output.
 */
export function extractSeoHeadNodes(originalHtml: string): ExtractedSeo {
  const $ = cheerio.load(originalHtml);
  const nodes: string[] = [];

  $("head > *").each((_, el) => {
    const elem = el as cheerio.Element;
    if (elem.type !== "tag") return;
    const tag = elem.tagName.toLowerCase();
    if (SEO_TAGS.includes(tag)) {
      nodes.push($.html(elem));
      return;
    }
    if (tag === "meta") {
      const name = (elem.attribs?.name || "").toLowerCase();
      const property = (elem.attribs?.property || "").toLowerCase();
      if (SEO_META_NAMES.includes(name)) nodes.push($.html(elem));
      else if (SEO_META_PROPERTY_PREFIXES.some((p) => property.startsWith(p)))
        nodes.push($.html(elem));
      return;
    }
    if (tag === "link") {
      const rel = (elem.attribs?.rel || "").toLowerCase();
      if (SEO_LINK_RELS.includes(rel)) nodes.push($.html(elem));
      return;
    }
    if (tag === "script") {
      const type = (elem.attribs?.type || "").toLowerCase();
      if (type === "application/ld+json") nodes.push($.html(elem));
      return;
    }
  });

  return { nodes };
}

/**
 * Inject SEO-critical nodes into the filled HTML's `<head>`, replacing any
 * existing matching nodes.  Naive but deterministic: append before `</head>`.
 */
export function injectSeoHeadNodes(filledHtml: string, seo: ExtractedSeo): string {
  if (seo.nodes.length === 0) return filledHtml;
  const $ = cheerio.load(filledHtml);
  const head = $("head");
  if (head.length === 0) return filledHtml;
  // Drop any existing same-kind nodes so we don't end up with duplicates.
  head.find("title").remove();
  head.find("meta[name='description']").remove();
  head.find("meta[property^='og:']").remove();
  head.find("meta[property^='twitter:']").remove();
  head.find("link[rel='canonical']").remove();
  head.find("link[rel='alternate']").remove();
  head.find("script[type='application/ld+json']").remove();
  for (const node of seo.nodes) head.append(node);
  return $.html();
}
