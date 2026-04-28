import { fetch } from "undici";

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
const LASTMOD_RE = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/g;

export async function fetchSitemap(url: string, userAgent: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return await res.text();
}

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

export function parseLocs(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(LOC_RE)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

export function parseEntries(xml: string): SitemapEntry[] {
  // Naive but works for well-formed sitemaps. Pairs <loc>/<lastmod> by URL block.
  const blocks = xml.split(/<\/url>/i);
  const entries: SitemapEntry[] = [];
  for (const block of blocks) {
    const locMatch = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/);
    if (!locMatch?.[1]) continue;
    const lastModMatch = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/);
    entries.push({
      loc: locMatch[1],
      ...(lastModMatch?.[1] ? { lastmod: lastModMatch[1] } : {}),
    });
  }
  return entries;
}

/** Recursively expand a sitemap (or sitemap index) into a flat URL list. */
export async function expandSitemap(
  url: string,
  userAgent: string,
): Promise<SitemapEntry[]> {
  const xml = await fetchSitemap(url, userAgent);
  if (isSitemapIndex(xml)) {
    const childUrls = parseLocs(xml);
    const all: SitemapEntry[] = [];
    for (const child of childUrls) {
      const entries = await expandSitemap(child, userAgent);
      all.push(...entries);
    }
    return all;
  }
  return parseEntries(xml);
}

