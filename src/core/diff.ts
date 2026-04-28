import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createServeApp } from "../commands/serve.js";

/**
 * One page's diff result: how much the cached render differs from the
 * original site, and whether that delta is within `threshold`.
 */
export interface DiffEntry {
  url: string;
  /** Local URL under the ephemeral cache server, useful for debugging. */
  localUrl: string;
  /** Pixel-delta ratio in [0, 1] — fraction of pixels that differ. */
  deltaRatio: number;
  pass: boolean;
}

export interface DiffResult {
  pass: boolean;
  threshold: number;
  entries: DiffEntry[];
}

export interface ScreenshotImpl {
  /** Take a PNG screenshot of `url` at the given viewport. */
  capture(url: string, viewport: { width: number; height: number }): Promise<Uint8Array>;
}

/**
 * `pixelmatch`-compatible signature: returns the count of differing pixels
 * between two RGBA buffers of the same width × height.
 */
export type PixelmatchImpl = (
  imgA: Uint8Array,
  imgB: Uint8Array,
  output: Uint8Array | null,
  width: number,
  height: number,
  options?: { threshold?: number },
) => number;

/** Decode a PNG buffer into raw RGBA + dimensions. */
export type PngDecoder = (
  buf: Uint8Array,
) => { width: number; height: number; data: Uint8Array };

export interface DiffConfig {
  /** How many pages to sample (random selection across all output pages). */
  samples: number;
  /** Maximum allowed delta ratio (e.g. 0.02 = 2%). */
  threshold: number;
  /**
   * Origin of the original site (e.g. `https://example.com`).  When omitted,
   * derived from `output/sitemap.xml` (first `<loc>`).
   */
  baseUrl?: string;
  /** Override viewport (defaults to 1280×800 — Architect notes). */
  viewport?: { width: number; height: number };
  /** Inject a deterministic RNG (defaults to `Math.random`). */
  random?: () => number;
  /** Inject a screenshot impl; when omitted, dynamically loads `playwright`. */
  screenshotImpl?: ScreenshotImpl;
  /** Inject `pixelmatch` (defaults to dynamic import). */
  pixelmatchImpl?: PixelmatchImpl;
  /** Inject a PNG decoder (defaults to `pngjs` dynamic import). */
  pngDecoder?: PngDecoder;
  /**
   * Override the local server port.  When omitted, the ephemeral server is
   * spawned on port 0 (OS-assigned) and torn down at the end of the run.
   */
  serverPort?: number;
}

/** Pure helper: list every output page as a relative URL path. */
export async function listOutputPages(outputDir: string): Promise<string[]> {
  const pagesDir = resolve(outputDir, "pages");
  let entries: string[] = [];
  try {
    const all = await readdir(pagesDir, { recursive: true });
    for (const name of all) {
      if (typeof name === "string" && name.endsWith("index.html")) {
        const rel = name.split(sep).join("/").replace(/\/index\.html$/, "");
        entries.push(rel === "index.html" ? "/" : `/${rel}/`);
      }
    }
  } catch {
    /* no pages dir → empty list */
  }
  return entries.sort();
}

/**
 * Pure helper: pick `n` distinct samples from `pages` using `rng`
 * (Fisher–Yates partial shuffle).  When `n >= pages.length` returns all.
 */
export function selectSamples(pages: string[], n: number, rng: () => number): string[] {
  const arr = pages.slice();
  if (n >= arr.length) return arr;
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr.slice(0, n);
}

/**
 * Pure helper: compute pixel-delta ratio between two PNG buffers.
 *
 * Decodes both via `decoder`, ensures matching dimensions, calls
 * `pixelmatch`, returns `differingPixels / totalPixels`.  Mismatched
 * dimensions are treated as 100% delta (no resize is attempted).
 */
export function computeDeltaRatio(
  pngA: Uint8Array,
  pngB: Uint8Array,
  decoder: PngDecoder,
  pixelmatch: PixelmatchImpl,
): number {
  const a = decoder(pngA);
  const b = decoder(pngB);
  if (a.width !== b.width || a.height !== b.height) return 1;
  const total = a.width * a.height;
  if (total === 0) return 0;
  const differing = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
  return differing / total;
}

async function readBaseUrlFromSitemap(outputDir: string): Promise<string | undefined> {
  try {
    const xml = await readFile(resolve(outputDir, "sitemap.xml"), "utf8");
    const m = xml.match(/<loc>\s*([^<\s]+)\s*<\/loc>/);
    if (!m) return undefined;
    return new URL(m[1]!).origin;
  } catch {
    return undefined;
  }
}

async function loadDefaultPixelmatch(): Promise<PixelmatchImpl> {
  const mod = (await import("pixelmatch")) as { default: PixelmatchImpl } | PixelmatchImpl;
  return (typeof mod === "function" ? mod : (mod as { default: PixelmatchImpl }).default);
}

async function loadDefaultPngDecoder(): Promise<PngDecoder> {
  const mod = await import("pngjs");
  const PNG = (mod as { PNG: { sync: { read(buf: Uint8Array): { width: number; height: number; data: Uint8Array } } } }).PNG;
  return (buf) => {
    const decoded = PNG.sync.read(buf);
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  };
}

async function loadDefaultScreenshotImpl(): Promise<ScreenshotImpl> {
  // Dynamic import — keeps Playwright entirely out of the test path.
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch (err) {
    throw new Error(
      `Playwright unavailable: ${(err as Error).message}. Install with \`npm install playwright\` then \`npx playwright install chromium\`.`,
    );
  }
  const browser = await pw.chromium.launch();
  return {
    async capture(url, viewport) {
      const ctx = await browser.newContext({ viewport });
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: "networkidle" });
        const buf = await page.screenshot({ type: "png", fullPage: false });
        return new Uint8Array(buf);
      } finally {
        await ctx.close();
      }
    },
  };
}

/**
 * Run the visual-regression diff: sample N pages, screenshot each on the
 * original site and the locally-served cache, compare pixel-by-pixel,
 * report per-page delta ratios + an overall pass flag.
 *
 * Heavy dependencies (Playwright, pixelmatch, pngjs) are lazily imported
 * so the test suite can inject mocks via `DiffConfig` without ever loading
 * the real packages.
 */
export async function runVisualDiff(
  outputDir: string,
  options: DiffConfig,
): Promise<DiffResult> {
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const rng = options.random ?? Math.random;
  const threshold = options.threshold;

  const baseUrl = options.baseUrl ?? (await readBaseUrlFromSitemap(outputDir));
  if (!baseUrl) {
    throw new Error(
      `Cannot determine origin: pass {baseUrl} or ensure ${outputDir}/sitemap.xml has a <loc> entry.`,
    );
  }

  const allPages = await listOutputPages(outputDir);
  const sampled = selectSamples(allPages, options.samples, rng);

  // Resolve heavy deps only once we know we need them and only when not injected.
  const screenshot =
    options.screenshotImpl ?? (await loadDefaultScreenshotImpl());
  const pixelmatch =
    options.pixelmatchImpl ?? (await loadDefaultPixelmatch());
  const decoder = options.pngDecoder ?? (await loadDefaultPngDecoder());

  // Spin up the local cache server on an ephemeral port.
  const app = createServeApp(outputDir);
  const server = serve({ fetch: app.fetch, port: options.serverPort ?? 0 });
  // @hono/node-server exposes a Node http.Server-compatible address().
  let localOrigin: string;
  try {
    const addr = (server as unknown as { address(): AddressInfo | string | null }).address();
    if (!addr || typeof addr === "string") {
      throw new Error("ephemeral server did not bind to an inet address");
    }
    localOrigin = `http://127.0.0.1:${addr.port}`;
  } catch (err) {
    (server as unknown as { close(): void }).close?.();
    throw err;
  }

  const entries: DiffEntry[] = [];
  try {
    for (const path of sampled) {
      const origUrl = new URL(path, baseUrl + "/").toString();
      const localUrl = new URL(path, localOrigin + "/").toString();
      let deltaRatio = 1;
      try {
        const [a, b] = await Promise.all([
          screenshot.capture(origUrl, viewport),
          screenshot.capture(localUrl, viewport),
        ]);
        deltaRatio = computeDeltaRatio(a, b, decoder, pixelmatch);
      } catch (err) {
        // Treat capture errors as max-delta so the page fails the gate but
        // doesn't tank the whole run.
        console.warn(`    ! diff ${path}: ${(err as Error).message}`);
      }
      entries.push({
        url: origUrl,
        localUrl,
        deltaRatio,
        pass: deltaRatio <= threshold,
      });
    }
  } finally {
    (server as unknown as { close(): void }).close?.();
  }

  return {
    pass: entries.every((e) => e.pass),
    threshold,
    entries,
  };
}

// Path-relative re-exports kept short for IDE jump-to-definition.
export { relative };
