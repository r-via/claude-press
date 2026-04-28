import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetch as undiciFetch } from "undici";
import robotsParser from "robots-parser";
import type { CrawlerConfig } from "./config.js";

export interface PageManifestEntry {
  url: string;
  localPath: string;
}

export interface DownloadPagesResult {
  manifest: PageManifestEntry[];
  failures: { url: string; error: string }[];
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

/** Minimal interface a parsed robots.txt instance must expose. */
export interface RobotChecker {
  isAllowed(url: string, ua?: string): boolean | undefined;
}

/** Per-host cache of parsed robots.txt; `null` = fetch failed → allow all. */
export type RobotsCache = Map<string, RobotChecker | null>;

export interface DownloadPagesOptions {
  /** Inject fetch implementation (for tests). Defaults to undici fetch. */
  fetchImpl?: FetchLike;
  /** Inject clock (for tests). Defaults to Date.now. */
  now?: () => number;
  /** Inject sleep (for tests). Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger for progress lines. Defaults to console.log. */
  log?: (msg: string) => void;
  /** Shared robots.txt cache (across pages + assets). Created if absent. */
  robotsCache?: RobotsCache;
}

/**
 * Fetch a host's `/robots.txt`.  Returns the body on success, `null` on
 * 4xx/5xx/network error (which the caller treats as "allow all").
 */
export async function fetchRobotsTxt(
  baseUrl: string,
  userAgent: string,
  fetchImpl: FetchLike = undiciFetch as unknown as FetchLike,
): Promise<string | null> {
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", baseUrl).toString();
  } catch {
    return null;
  }
  try {
    const res = await fetchImpl(robotsUrl, { headers: { "user-agent": userAgent } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Filter `urls` keeping only those allowed by `robotsTxt` for `userAgent`.
 * Robots.txt is parsed via the `robots-parser` package; URLs that throw or
 * are not matched by any rule fall through as allowed.
 */
export function filterAllowedUrls(
  urls: string[],
  robotsTxt: string,
  userAgent: string,
  baseUrl?: string,
): string[] {
  const ref = baseUrl ?? urls[0];
  if (!ref) return urls;
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", ref).toString();
  } catch {
    return urls;
  }
  const robot = robotsParser(robotsUrl, robotsTxt);
  return urls.filter((u) => {
    const allowed = robot.isAllowed(u, userAgent);
    return allowed !== false;
  });
}

/**
 * Resolve (and lazily fetch + parse) the robots.txt entry for `host`.
 * Returns `null` when robots.txt is unreachable — caller treats as allow-all.
 */
export async function getRobotsForHost(
  host: string,
  scheme: string,
  userAgent: string,
  cache: RobotsCache,
  fetchImpl: FetchLike,
): Promise<RobotChecker | null> {
  if (cache.has(host)) return cache.get(host) ?? null;
  const baseUrl = `${scheme}//${host}`;
  const body = await fetchRobotsTxt(baseUrl, userAgent, fetchImpl);
  if (body == null) {
    cache.set(host, null);
    return null;
  }
  const robotsUrl = `${baseUrl}/robots.txt`;
  const robot = robotsParser(robotsUrl, body) as RobotChecker;
  cache.set(host, robot);
  return robot;
}

/**
 * Map a URL to its on-disk path under `<outputDir>/pages/`.
 * Preserves the URL's path structure, appending `index.html` when needed.
 */
export function urlToLocalPath(outputDir: string, url: string): string {
  const u = new URL(url);
  let pathname = u.pathname;
  if (pathname.endsWith("/") || pathname === "") {
    pathname = pathname + "index.html";
  } else if (!/\.[a-zA-Z0-9]+$/.test(pathname)) {
    // No file extension — treat as a directory-style URL.
    pathname = pathname + "/index.html";
  }
  const stripped = pathname.replace(/^\/+/, "");
  return resolve(outputDir, "pages", stripped);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/**
 * Download every URL in `urls` and persist each as raw HTML under
 * `<outputDir>/pages/...`.  Concurrency is capped at `config.concurrency`,
 * and a `config.delayMs` minimum gap is enforced between requests to the
 * same host.
 */
export async function downloadPages(
  urls: string[],
  outputDir: string,
  config: CrawlerConfig,
  options: DownloadPagesOptions = {},
): Promise<DownloadPagesResult> {
  const fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchLike);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((m: string) => console.log(m));
  const robotsCache: RobotsCache = options.robotsCache ?? new Map();

  // robots.txt enforcement (README § Crawler etiquette).  When enabled,
  // fetch /robots.txt once per host, parse, and drop disallowed URLs from
  // the work list before any page download starts.  Cache is shared with
  // downloadAssets via the `robotsCache` option.
  let workUrls = urls;
  if (config.respectRobots) {
    const byHost = new Map<string, { scheme: string; urls: string[] }>();
    for (const u of urls) {
      try {
        const url = new URL(u);
        const entry = byHost.get(url.host) ?? { scheme: url.protocol, urls: [] };
        entry.urls.push(u);
        byHost.set(url.host, entry);
      } catch {
        /* leave invalid URLs in the list — downloadOne records the failure */
      }
    }
    const allowed: string[] = [];
    let dropped = 0;
    for (const [host, { scheme, urls: hostUrls }] of byHost) {
      const robot = await getRobotsForHost(host, scheme, config.userAgent, robotsCache, fetchImpl);
      if (!robot) {
        for (const u of hostUrls) allowed.push(u);
        continue;
      }
      for (const u of hostUrls) {
        if (robot.isAllowed(u, config.userAgent) === false) {
          dropped++;
        } else {
          allowed.push(u);
        }
      }
    }
    if (dropped > 0) log(`  → ${dropped} URLs disallowed by robots.txt`);
    // Preserve any URLs that failed URL parsing (kept out of byHost).
    const seen = new Set(allowed);
    for (const u of urls) {
      try {
        new URL(u);
      } catch {
        if (!seen.has(u)) allowed.push(u);
      }
    }
    workUrls = allowed;
  }

  const manifest: PageManifestEntry[] = [];
  const failures: { url: string; error: string }[] = [];
  const lastRequestByHost = new Map<string, number>();
  const hostQueues = new Map<string, Promise<void>>();

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

  /** Reserve a per-host slot that respects the min delay. */
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
    // Release the slot immediately so the next host request can start its own
    // delay computation from this timestamp.
    releaseSlot();
  };

  const downloadOne = async (url: string): Promise<void> => {
    let host: string;
    try {
      host = new URL(url).host;
    } catch (err) {
      failures.push({ url, error: `invalid URL: ${(err as Error).message}` });
      return;
    }
    await reserveHostSlot(host);
    log(`  → fetching ${url}`);
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": config.userAgent },
      });
      if (!res.ok) {
        failures.push({ url, error: `HTTP ${res.status} ${res.statusText}` });
        return;
      }
      const html = await res.text();
      const localPath = urlToLocalPath(outputDir, url);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, html, "utf8");
      manifest.push({ url, localPath });
    } catch (err) {
      failures.push({ url, error: (err as Error).message });
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < workUrls.length; i++) {
    await acquire();
    const url = workUrls[i]!;
    const task = downloadOne(url).finally(release);
    workers.push(task);
  }
  await Promise.all(workers);

  return { manifest, failures };
}
