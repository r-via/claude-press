import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { fetch as undiciFetch } from "undici";
import type { CrawlerConfig } from "./config.js";
import { getRobotsForHost, type RobotsCache } from "./crawler.js";

export type AssetType = "css" | "js" | "img" | "fonts";

export interface AssetRef {
  /** Absolute URL of the asset. */
  url: string;
  /** Bucket the asset is sorted into on disk under `assets/<type>/`. */
  type: AssetType;
}

/** Maps original absolute asset URL → local path relative to `outputDir`. */
export interface AssetManifest {
  [originalUrl: string]: string;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface DownloadAssetsOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Shared robots.txt cache (across pages + assets). Created if absent. */
  robotsCache?: RobotsCache;
}

export interface DownloadAssetsResult {
  manifest: AssetManifest;
  failures: { url: string; error: string }[];
}

const FONT_EXTS = new Set([".woff", ".woff2", ".ttf", ".otf", ".eot"]);
const IMG_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".bmp",
]);

/**
 * Parse a `srcset` attribute value and return the URL of the largest
 * candidate.  Width descriptors (`Nw`) take precedence — the candidate
 * with the highest width wins.  If no `w` descriptors are present, the
 * highest density (`Nx`) wins (bare candidates default to density 1).
 * If no descriptors are present at all, the first candidate is returned.
 * Returns `null` for empty/blank/invalid input.
 */
export function pickLargestSrcsetCandidate(srcset: string): string | null {
  if (typeof srcset !== "string") return null;
  const trimmed = srcset.trim();
  if (!trimmed) return null;
  type Cand = { url: string; w?: number; x?: number; idx: number };
  const cands: Cand[] = [];
  for (const raw of trimmed.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const tokens = part.split(/\s+/);
    const url = tokens[0];
    if (!url) continue;
    const cand: Cand = { url, idx: cands.length };
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (/^\d+(?:\.\d+)?w$/i.test(tok)) {
        const n = parseInt(tok, 10);
        if (!Number.isNaN(n)) cand.w = n;
      } else if (/^\d+(?:\.\d+)?x$/i.test(tok)) {
        const n = parseFloat(tok);
        if (!Number.isNaN(n)) cand.x = n;
      }
    }
    cands.push(cand);
  }
  if (cands.length === 0) return null;
  const haveW = cands.some((c) => c.w !== undefined);
  if (haveW) {
    let best = cands[0]!;
    for (const c of cands) {
      if ((c.w ?? -1) > (best.w ?? -1)) best = c;
    }
    return best.url;
  }
  const haveX = cands.some((c) => c.x !== undefined);
  if (haveX) {
    let best = cands[0]!;
    for (const c of cands) {
      if ((c.x ?? 1) > (best.x ?? 1)) best = c;
    }
    return best.url;
  }
  return cands[0]!.url;
}

function classifyByExt(url: string): AssetType | undefined {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    if (ext === ".css") return "css";
    if (ext === ".js" || ext === ".mjs") return "js";
    if (FONT_EXTS.has(ext)) return "fonts";
    if (IMG_EXTS.has(ext)) return "img";
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Parse `htmlPath` and return every asset reference resolved against `baseUrl`.
 * Output is deduplicated by absolute URL.  Inline `data:` and `javascript:`
 * URLs are skipped.
 */
export async function discoverAssets(
  htmlPath: string,
  baseUrl: string,
): Promise<AssetRef[]> {
  const html = await readFile(htmlPath, "utf8");
  const $ = cheerio.load(html);
  const refs: AssetRef[] = [];
  const seen = new Set<string>();

  const push = (raw: string | undefined, type: AssetType): void => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (
      trimmed.startsWith("data:") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("mailto:") ||
      trimmed.startsWith("#")
    ) {
      return;
    }
    let abs: string;
    try {
      abs = new URL(trimmed, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    refs.push({ url: abs, type });
  };

  $('link[rel="stylesheet"]').each((_i, el) => push($(el).attr("href"), "css"));

  $("link[rel]").each((_i, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    const href = $(el).attr("href");
    if (!href) return;
    if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
      push(href, "img");
    }
    if (rel.includes("preload")) {
      const as = ($(el).attr("as") ?? "").toLowerCase();
      if (as === "font") push(href, "fonts");
      else if (as === "image") push(href, "img");
      else if (as === "style") push(href, "css");
      else if (as === "script") push(href, "js");
      else {
        const t = classifyByExt(new URL(href, baseUrl).toString());
        if (t) push(href, t);
      }
    }
  });

  $("script[src]").each((_i, el) => push($(el).attr("src"), "js"));
  $("img[src]").each((_i, el) => push($(el).attr("src"), "img"));
  $("source[src]").each((_i, el) => push($(el).attr("src"), "img"));

  const pickLargest = (ss: string | undefined, type: AssetType): void => {
    if (!ss) return;
    const winner = pickLargestSrcsetCandidate(ss);
    if (winner) push(winner, type);
  };
  $("img[srcset]").each((_i, el) => pickLargest($(el).attr("srcset"), "img"));
  $("source[srcset]").each((_i, el) =>
    pickLargest($(el).attr("srcset"), "img"),
  );

  // Inline <style> blocks: pick out url(...) refs (typically @font-face).
  $("style").each((_i, el) => {
    const css = $(el).text();
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      let abs: string;
      try {
        abs = new URL(raw, baseUrl).toString();
      } catch {
        continue;
      }
      const t = classifyByExt(abs) ?? "fonts";
      push(raw, t);
    }
  });

  return refs;
}

function hashedFilename(url: string, type: AssetType, body: Buffer): string {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  let stem = "asset";
  let ext = "";
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "asset";
    ext = extname(last);
    stem = ext ? last.slice(0, -ext.length) : last;
    if (!stem) stem = "asset";
  } catch {
    /* ignore */
  }
  if (!ext) {
    ext =
      type === "css"
        ? ".css"
        : type === "js"
          ? ".js"
          : type === "fonts"
            ? ".woff2"
            : ".bin";
  }
  return `${stem}-${hash}${ext}`;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/**
 * Fetch every asset in `refs` (deduplicated) and write each to
 * `<outputDir>/assets/<type>/<stem>-<hash><ext>` with sha256-content-hashed
 * filenames.  Concurrency and per-host delay are enforced from `config`.
 */
export async function downloadAssets(
  refs: AssetRef[],
  outputDir: string,
  config: CrawlerConfig,
  options: DownloadAssetsOptions = {},
): Promise<DownloadAssetsResult> {
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchLike);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((m: string) => console.log(m));
  const robotsCache: RobotsCache = options.robotsCache ?? new Map();

  const manifest: AssetManifest = {};
  const failures: { url: string; error: string }[] = [];

  // Deduplicate by absolute URL (refs may already be deduped, but be safe).
  const unique = new Map<string, AssetRef>();
  for (const r of refs) if (!unique.has(r.url)) unique.set(r.url, r);

  // robots.txt enforcement (README § Crawler etiquette).  Reuses the same
  // robotsCache as downloadPages when callers thread it through, so each
  // host's /robots.txt is fetched at most once per build.  The asset
  // fetchImpl returns `arrayBuffer()` only; adapt it to a text-fetch
  // shape that getRobotsForHost expects.
  const robotsFetch = async (
    url: string,
    init?: { headers?: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }> => {
    const r = await fetchImpl(url, init);
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      text: async () => Buffer.from(await r.arrayBuffer()).toString("utf8"),
    };
  };
  if (config.respectRobots) {
    const allowed = new Map<string, AssetRef>();
    let dropped = 0;
    for (const [url, ref] of unique) {
      let host: string;
      let scheme: string;
      try {
        const u = new URL(url);
        host = u.host;
        scheme = u.protocol;
      } catch {
        allowed.set(url, ref);
        continue;
      }
      const robot = await getRobotsForHost(host, scheme, config.userAgent, robotsCache, robotsFetch);
      if (!robot || robot.isAllowed(url, config.userAgent) !== false) {
        allowed.set(url, ref);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) log(`  → ${dropped} assets disallowed by robots.txt`);
    unique.clear();
    for (const [k, v] of allowed) unique.set(k, v);
  }

  const concurrency = Math.max(1, config.concurrency);
  let inFlight = 0;
  const queue: (() => void)[] = [];
  const acquire = (): Promise<void> =>
    new Promise((resolveSlot) => {
      if (inFlight < concurrency) {
        inFlight++;
        resolveSlot();
      } else {
        queue.push(() => {
          inFlight++;
          resolveSlot();
        });
      }
    });
  const release = (): void => {
    inFlight--;
    const next = queue.shift();
    if (next) next();
  };

  const lastRequestByHost = new Map<string, number>();
  const hostQueues = new Map<string, Promise<void>>();
  const reserveHostSlot = async (host: string): Promise<void> => {
    const prior = hostQueues.get(host) ?? Promise.resolve();
    let releaseSlot!: () => void;
    const slot = new Promise<void>((res) => {
      releaseSlot = res;
    });
    hostQueues.set(
      host,
      prior.then(() => slot),
    );
    await prior;
    const last = lastRequestByHost.get(host);
    if (last !== undefined) {
      const elapsed = now() - last;
      const wait = config.delayMs - elapsed;
      if (wait > 0) await sleep(wait);
    }
    lastRequestByHost.set(host, now());
    releaseSlot();
  };

  const downloadOne = async (ref: AssetRef): Promise<void> => {
    let host: string;
    try {
      host = new URL(ref.url).host;
    } catch (err) {
      failures.push({ url: ref.url, error: `invalid URL: ${(err as Error).message}` });
      return;
    }
    await reserveHostSlot(host);
    log(`  → fetching asset ${ref.url}`);
    try {
      const res = await fetchImpl(ref.url, {
        headers: { "user-agent": config.userAgent },
      });
      if (!res.ok) {
        failures.push({
          url: ref.url,
          error: `HTTP ${res.status} ${res.statusText}`,
        });
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = hashedFilename(ref.url, ref.type, buf);
      const relPath = `assets/${ref.type}/${filename}`;
      const absPath = resolve(outputDir, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, buf);
      manifest[ref.url] = relPath;
    } catch (err) {
      failures.push({ url: ref.url, error: (err as Error).message });
    }
  };

  const tasks: Promise<void>[] = [];
  for (const ref of unique.values()) {
    await acquire();
    tasks.push(downloadOne(ref).finally(release));
  }
  await Promise.all(tasks);

  return { manifest, failures };
}
