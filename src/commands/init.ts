import type { Command } from "commander";
import { writeFile, access, copyFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fetchSitemap, isSitemapIndex, parseLocs, expandSitemap } from "../core/sitemap.js";
import { downloadPages, type DownloadPagesResult } from "../core/crawler.js";
import { generate } from "../core/llm/index.js";
import { loadConfig, type AppConfig } from "../core/config.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface RunInitOptions {
  site: string;
  cwd?: string;
  config?: AppConfig;
  fetchSitemapImpl?: typeof fetchSitemap;
  expandSitemapImpl?: typeof expandSitemap;
  downloadImpl?: typeof downloadPages;
  generateImpl?: typeof generate;
  mkdtempImpl?: (prefix: string) => Promise<string>;
  rmImpl?: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  exit?: (code: number) => never;
}

/**
 * Initialise a project: write `.env`, detect the sitemap, then run a
 * single-page LLM dry-run so config errors surface in seconds rather
 * than mid-build (README § Commands → init).
 */
export async function runInit(options: RunInitOptions): Promise<void> {
  const cwd = options.cwd ?? resolve(".");
  const log = options.log ?? ((m: string) => console.log(m));
  const errorLog = options.errorLog ?? ((m: string) => console.error(m));
  const exit = options.exit ?? ((c: number) => process.exit(c) as never);
  const fetchSitemapFn = options.fetchSitemapImpl ?? fetchSitemap;
  const expandSitemapFn = options.expandSitemapImpl ?? expandSitemap;
  const downloadFn = options.downloadImpl ?? downloadPages;
  const generateFn = options.generateImpl ?? generate;
  const mkdtempFn = options.mkdtempImpl ?? ((p: string) => mkdtemp(p));
  const rmFn =
    options.rmImpl ?? ((p: string, o?: { recursive?: boolean; force?: boolean }) => rm(p, o));

  log(`\nclaude-press — init\n`);

  // 1. Write .env if missing
  const envPath = resolve(cwd, ".env");
  const examplePath = resolve(cwd, ".env.example");
  if (!(await exists(envPath))) {
    if (await exists(examplePath)) {
      await copyFile(examplePath, envPath);
      log(`  ✓ wrote .env (from .env.example)`);
    } else {
      await writeFile(envPath, "LLM_MODE=local\n", "utf8");
      log(`  ✓ wrote minimal .env`);
    }
  } else {
    log(`  ✓ .env already exists, leaving untouched`);
  }

  // 2. Detect sitemap
  const base = options.site.endsWith("/") ? options.site.slice(0, -1) : options.site;
  const candidates = [`${base}/sitemap_index.xml`, `${base}/sitemap.xml`];
  let detected: string | undefined;
  let firstUrl: string | undefined;
  for (const url of candidates) {
    try {
      const xml = await fetchSitemapFn(url, "claude-press/0.0.1 (init)");
      if (isSitemapIndex(xml) || /<urlset[\s>]/i.test(xml)) {
        detected = url;
        if (isSitemapIndex(xml)) {
          const entries = await expandSitemapFn(url, "claude-press/0.0.1 (init)");
          firstUrl = entries[0]?.loc;
          log(`  ✓ sitemap found: ${url} (${entries.length} URLs)`);
        } else {
          const locs = parseLocs(xml);
          firstUrl = locs[0];
          log(`  ✓ sitemap found: ${url} (${locs.length} URLs)`);
        }
        break;
      }
    } catch {
      // try next
    }
  }

  if (!detected) {
    log(`  ✗ no sitemap found at ${candidates.join(" or ")}`);
    log(`    pass it explicitly to "claude-press build <sitemap-url> ./output"`);
    log(`  ⊘ skipping dry-run (no sitemap detected)`);
    log(`\n  Next: claude-press build <sitemap-url> ./output\n`);
    return;
  }

  // 3. Single-page LLM dry-run (README § Commands → init)
  if (!firstUrl) {
    log(`  ⊘ skipping dry-run (sitemap empty)`);
    log(`\n  Next: claude-press build ${detected} ./output\n`);
    return;
  }

  const config = options.config ?? loadConfig();
  const tmpDir = await mkdtempFn(resolve(tmpdir(), "claude-press-init-"));
  try {
    log(`  → running LLM dry-run on ${firstUrl}`);
    let dlResult: DownloadPagesResult;
    try {
      dlResult = await downloadFn(
        [firstUrl],
        tmpDir,
        { ...config.crawler, concurrency: 1 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorLog(`  ✗ dry-run failed: could not download ${firstUrl}: ${msg}`);
      errorLog(`    check network connectivity and CRAWL_USER_AGENT in .env`);
      exit(1);
      return;
    }
    const entry = dlResult.manifest[0];
    if (!entry) {
      const fail = dlResult.failures[0];
      errorLog(
        `  ✗ dry-run failed: could not download ${firstUrl}` +
          (fail ? `: ${fail.error}` : ""),
      );
      errorLog(`    check network connectivity and CRAWL_USER_AGENT in .env`);
      exit(1);
      return;
    }

    const html = await readFile(entry.localPath, "utf8");
    try {
      const reply = await generateFn(
        `Summarize this page in one short sentence:\n\n${html.slice(0, 4000)}`,
        config.llm,
        { systemPrompt: "You are a concise web-page summariser." },
      );
      const summary = reply.trim().split("\n")[0]?.slice(0, 120) ?? "";
      log(`  ✓ LLM dry-run passed (${config.llm.optimizerModel})`);
      if (summary) log(`    summary: ${summary}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorLog(`  ✗ LLM dry-run failed: ${msg}`);
      errorLog(`    check LLM_MODE and API key in .env`);
      exit(1);
      return;
    }
  } finally {
    await rmFn(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  log(`\n  Next: claude-press build ${detected} ./output\n`);
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Bootstrap a project: write .env, detect sitemap, dry-run a single page")
    .argument("<site>", "Root URL of the site, e.g. https://example.com/")
    .action(async (site: string) => {
      await runInit({ site });
    });
}
