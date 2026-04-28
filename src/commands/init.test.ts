/**
 * Tests for the `init` command's single-page LLM dry-run (US-021).
 *
 * The real implementation pulls in undici (downloadPages), the Claude
 * Agent SDK (generate) and writes to a tempdir.  Tests inject fakes for
 * fetchSitemap / downloadPages / generate / mkdtemp / rm / log so the
 * suite stays under 100ms and never touches the network or the LLM.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInit } from "./init.js";
import type { AppConfig } from "../core/config.js";
import type { DownloadPagesResult } from "../core/crawler.js";

const baseConfig: AppConfig = {
  llm: {
    mode: "local",
    optimizerModel: "anthropic/claude-haiku-4-5",
    refinerModel: "anthropic/claude-opus-4-7",
  },
  crawler: {
    concurrency: 8,
    delayMs: 0,
    userAgent: "claude-press-test",
    respectRobots: false,
  },
};

async function workdir(): Promise<string> {
  // Use a fresh cwd so the .env-write step is observable but isolated.
  return await mkdtemp(resolve(tmpdir(), "init-cwd-"));
}

function makeFakeDownload(htmlByUrl: Record<string, string>) {
  return async (
    urls: string[],
    outputDir: string,
  ): Promise<DownloadPagesResult> => {
    const manifest: { url: string; localPath: string }[] = [];
    const failures: { url: string; error: string }[] = [];
    for (const url of urls) {
      const body = htmlByUrl[url];
      if (body === undefined) {
        failures.push({ url, error: "404 Not Found" });
        continue;
      }
      const localPath = resolve(outputDir, "pages", encodeURIComponent(url));
      await mkdir(resolve(outputDir, "pages"), { recursive: true });
      await writeFile(localPath, body, "utf8");
      manifest.push({ url, localPath });
    }
    return { manifest, failures };
  };
}

describe("runInit dry-run", () => {
  it("logs LLM dry-run pass on success and cleans up the tempdir", async () => {
    const cwd = await workdir();
    try {
      const tmpDirs: string[] = [];
      const removed: string[] = [];
      const logs: string[] = [];
      const errors: string[] = [];
      const generate = vi.fn().mockResolvedValue("This is a test page.");

      await runInit({
        site: "https://example.com/",
        cwd,
        config: baseConfig,
        log: (m) => logs.push(m),
        errorLog: (m) => errors.push(m),
        fetchSitemapImpl: async () =>
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/about/</loc></url></urlset>`,
        downloadImpl: makeFakeDownload({
          "https://example.com/about/": "<html><body>About us</body></html>",
        }),
        generateImpl: generate,
        mkdtempImpl: async (prefix) => {
          const d = await mkdtemp(prefix);
          tmpDirs.push(d);
          return d;
        },
        rmImpl: async (path, opts) => {
          removed.push(path);
          await rm(path, opts);
        },
        exit: ((code: number) => {
          throw new Error(`unexpected exit(${code})`);
        }) as never,
      });

      const all = logs.join("\n");
      expect(all).toContain("✓ LLM dry-run passed");
      expect(all).toContain(baseConfig.llm.optimizerModel);
      expect(generate).toHaveBeenCalledTimes(1);
      // Tempdir must be cleaned up.
      expect(tmpDirs).toHaveLength(1);
      expect(removed).toContain(tmpDirs[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("exits 1 with remediation hint when the LLM call fails", async () => {
    const cwd = await workdir();
    try {
      const exitCalls: number[] = [];
      const logs: string[] = [];
      const errors: string[] = [];
      const tmpDirs: string[] = [];
      const removed: string[] = [];

      await runInit({
        site: "https://example.com/",
        cwd,
        config: baseConfig,
        log: (m) => logs.push(m),
        errorLog: (m) => errors.push(m),
        fetchSitemapImpl: async () =>
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a/</loc></url></urlset>`,
        downloadImpl: makeFakeDownload({
          "https://example.com/a/": "<html></html>",
        }),
        generateImpl: async () => {
          throw new Error("invalid api key");
        },
        mkdtempImpl: async (prefix) => {
          const d = await mkdtemp(prefix);
          tmpDirs.push(d);
          return d;
        },
        rmImpl: async (path, opts) => {
          removed.push(path);
          await rm(path, opts);
        },
        exit: ((code: number) => {
          exitCalls.push(code);
          // do not throw — let runInit return after exit() is invoked.
        }) as unknown as (code: number) => never,
      });

      expect(exitCalls).toEqual([1]);
      const errBlob = errors.join("\n");
      expect(errBlob).toContain("LLM dry-run failed");
      expect(errBlob).toMatch(/check LLM_MODE and API key/);
      // Tempdir is still cleaned up even on failure.
      expect(removed).toContain(tmpDirs[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips dry-run gracefully when no sitemap is detected", async () => {
    const cwd = await workdir();
    try {
      const logs: string[] = [];
      const generate = vi.fn();
      const downloadImpl = vi.fn();

      await runInit({
        site: "https://nositemap.example/",
        cwd,
        config: baseConfig,
        log: (m) => logs.push(m),
        fetchSitemapImpl: async () => {
          throw new Error("404");
        },
        downloadImpl: downloadImpl as never,
        generateImpl: generate,
        exit: ((code: number) => {
          throw new Error(`unexpected exit(${code})`);
        }) as never,
      });

      const all = logs.join("\n");
      expect(all).toContain("⊘ skipping dry-run (no sitemap detected)");
      expect(generate).not.toHaveBeenCalled();
      expect(downloadImpl).not.toHaveBeenCalled();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("cleans up the tempdir when the page download fails", async () => {
    const cwd = await workdir();
    try {
      const tmpDirs: string[] = [];
      const removed: string[] = [];
      const exitCalls: number[] = [];
      const errors: string[] = [];

      await runInit({
        site: "https://example.com/",
        cwd,
        config: baseConfig,
        log: () => {},
        errorLog: (m) => errors.push(m),
        fetchSitemapImpl: async () =>
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/x/</loc></url></urlset>`,
        // download returns no manifest entry — simulates a failed fetch.
        downloadImpl: async () => ({
          manifest: [],
          failures: [{ url: "https://example.com/x/", error: "ECONNREFUSED" }],
        }),
        generateImpl: vi.fn(),
        mkdtempImpl: async (prefix) => {
          const d = await mkdtemp(prefix);
          tmpDirs.push(d);
          return d;
        },
        rmImpl: async (path, opts) => {
          removed.push(path);
          await rm(path, opts);
        },
        exit: ((code: number) => {
          exitCalls.push(code);
        }) as unknown as (code: number) => never,
      });

      expect(exitCalls).toEqual([1]);
      expect(errors.join("\n")).toMatch(/could not download/);
      expect(removed).toContain(tmpDirs[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
