import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fetch as undiciFetch } from "undici";
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

export interface DownloadPagesOptions {
  /** Inject fetch implementation (for tests). Defaults to undici fetch. */
  fetchImpl?: FetchLike;
  /** Inject clock (for tests). Defaults to Date.now. */
  now?: () => number;
  /** Inject sleep (for tests). Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger for progress lines. Defaults to console.log. */
  log?: (msg: string) => void;
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
  for (let i = 0; i < urls.length; i++) {
    await acquire();
    const url = urls[i]!;
    const task = downloadOne(url).finally(release);
    workers.push(task);
  }
  await Promise.all(workers);

  return { manifest, failures };
}
