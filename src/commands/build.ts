import type { Command } from "commander";
import { resolve } from "node:path";
import { mkdir, access } from "node:fs/promises";
import { expandSitemap } from "../core/sitemap.js";
import { loadConfig } from "../core/config.js";
import { downloadPages } from "../core/crawler.js";
import { discoverAssets, downloadAssets, type AssetRef } from "../core/assets.js";

interface BuildOptions {
  force: string[];
  forceAll: boolean;
}

async function pageAlreadyBuilt(outputDir: string, url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const path = resolve(outputDir, "pages", u.pathname.replace(/^\/+/, ""), "index.html");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function registerBuild(program: Command): void {
  program
    .command("build")
    .description("Crawl the sitemap and render pages to ./output (incremental by default)")
    .argument("<sitemap>", "Sitemap URL")
    .argument("<output>", "Output directory")
    .option("--force <path...>", "force-rebuild specific URL paths", [])
    .option("--force-all", "force-rebuild every page", false)
    .action(async (sitemap: string, output: string, opts: BuildOptions) => {
      const config = loadConfig();
      const outputDir = resolve(output);
      await mkdir(resolve(outputDir, "pages"), { recursive: true });
      await mkdir(resolve(outputDir, "templates"), { recursive: true });
      await mkdir(resolve(outputDir, "assets"), { recursive: true });

      console.log(`\nclaude-press — build\n`);
      console.log(`  sitemap: ${sitemap}`);
      console.log(`  output:  ${outputDir}`);
      console.log(`  llm:     ${config.llm.mode} (${config.llm.optimizerModel})\n`);

      console.log(`  Expanding sitemap...`);
      const entries = await expandSitemap(sitemap, config.crawler.userAgent);
      console.log(`  → ${entries.length} URLs\n`);

      const forceSet = new Set(opts.force);
      const toFetch: string[] = [];
      let skipped = 0;
      for (const entry of entries) {
        const u = new URL(entry.loc);
        const forced = opts.forceAll || forceSet.has(u.pathname);
        if (!forced && (await pageAlreadyBuilt(outputDir, entry.loc))) {
          skipped++;
          continue;
        }
        toFetch.push(entry.loc);
      }
      console.log(`  ${toFetch.length} to build, ${skipped} cached\n`);

      console.log(`  Downloading pages...`);
      const { manifest, failures } = await downloadPages(toFetch, outputDir, config.crawler);
      console.log(`  → ${manifest.length} fetched, ${failures.length} failed\n`);
      for (const f of failures) {
        console.warn(`    ! ${f.url}: ${f.error}`);
      }

      console.log(`  Discovering assets...`);
      const allRefs: AssetRef[] = [];
      const seenAssetUrls = new Set<string>();
      for (const entry of manifest) {
        const refs = await discoverAssets(entry.localPath, entry.url);
        for (const r of refs) {
          if (seenAssetUrls.has(r.url)) continue;
          seenAssetUrls.add(r.url);
          allRefs.push(r);
        }
      }
      console.log(`  → ${allRefs.length} unique assets discovered`);

      console.log(`  Downloading assets...`);
      const assetResult = await downloadAssets(allRefs, outputDir, config.crawler);
      console.log(
        `  → ${Object.keys(assetResult.manifest).length} fetched, ${assetResult.failures.length} failed\n`,
      );
      for (const f of assetResult.failures) {
        console.warn(`    ! ${f.url}: ${f.error}`);
      }

      // TODO: cluster → synthesize templates → fill → URL rewriting
      console.log(`  (cluster + template pipeline not yet implemented)\n`);
    });
}
