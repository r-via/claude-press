import type { Command } from "commander";
import { relative, resolve } from "node:path";
import { mkdir, access, readFile, writeFile, readdir } from "node:fs/promises";
import { expandSitemap } from "../core/sitemap.js";
import { loadConfig } from "../core/config.js";
import { downloadPages } from "../core/crawler.js";
import { discoverAssets, downloadAssets, type AssetRef } from "../core/assets.js";
import { rewriteHtmlAssetUrls, rewriteCssUrls } from "../core/rewriter.js";
import { clusterPages } from "../core/clustering.js";
import { synthesizeTemplates } from "../core/templates.js";
import {
  deriveSlotSelectors,
  extractSlotValues,
  fillTemplate,
  extractSeoHeadNodes,
  injectSeoHeadNodes,
} from "../core/extractor.js";
import { generateResponsiveImages, rewriteImgToPicture } from "../core/images.js";

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

      console.log(`  Generating responsive image variants...`);
      const imageManifest = await generateResponsiveImages(
        assetResult.manifest,
        outputDir,
        { log: (m) => console.warn(`    ${m}`) },
      );
      const imageCount = Object.keys(imageManifest).length;
      const variantCount = Object.values(imageManifest).reduce(
        (n, v) => n + v.length,
        0,
      );
      console.log(`  → ${imageCount} images, ${variantCount} variants generated\n`);

      console.log(`  Rewriting asset URLs in pages...`);
      let rewrittenPages = 0;
      let unmatchedCount = 0;
      for (const entry of manifest) {
        const html = await readFile(entry.localPath, "utf8");
        const pageLocalPath = relative(outputDir, entry.localPath).split(/[\\/]/).join("/");
        const next = rewriteHtmlAssetUrls(html, entry.url, assetResult.manifest, {
          pageLocalPath,
          onUnmatched: () => {
            unmatchedCount++;
          },
        });
        if (next !== html) {
          await writeFile(entry.localPath, next);
          rewrittenPages++;
        }
      }
      console.log(`  → ${rewrittenPages} pages rewritten (${unmatchedCount} unmatched refs)\n`);

      console.log(`  Rewriting asset URLs in CSS...`);
      let rewrittenCss = 0;
      const cssDir = resolve(outputDir, "assets", "css");
      const reverseManifest = new Map<string, string>();
      for (const [origUrl, localPath] of Object.entries(assetResult.manifest)) {
        reverseManifest.set(localPath, origUrl);
      }
      try {
        const cssFiles = await readdir(cssDir);
        for (const name of cssFiles) {
          const localRel = `assets/css/${name}`;
          const origUrl = reverseManifest.get(localRel);
          if (!origUrl) continue;
          const absPath = resolve(cssDir, name);
          const css = await readFile(absPath, "utf8");
          const next = rewriteCssUrls(css, origUrl, assetResult.manifest, {
            cssLocalPath: localRel,
          });
          if (next !== css) {
            await writeFile(absPath, next);
            rewrittenCss++;
          }
        }
      } catch {
        /* no css dir */
      }
      console.log(`  → ${rewrittenCss} CSS files rewritten\n`);

      console.log(`  Clustering pages by structural fingerprint...`);
      const allPagePaths: string[] = [];
      try {
        const existing = await readdir(resolve(outputDir, "pages"), { recursive: true });
        for (const name of existing) {
          if (typeof name === "string" && name.endsWith("index.html")) {
            allPagePaths.push(resolve(outputDir, "pages", name));
          }
        }
      } catch {
        /* no pages dir */
      }
      for (const m of manifest) {
        if (!allPagePaths.includes(m.localPath)) allPagePaths.push(m.localPath);
      }
      const clusters = await clusterPages(allPagePaths, outputDir);
      console.log(`  → ${clusters.length} clusters`);
      for (const c of clusters) {
        console.log(`     ${c.id} (${c.fingerprint}): ${c.pages.length} pages`);
      }
      console.log("");

      console.log(`  Synthesizing templates with the LLM...`);
      const library = await synthesizeTemplates(clusters, outputDir, { llm: config.llm });
      const totalSlots = library.templates.reduce((n, t) => n + t.slots.length, 0);
      console.log(
        `  → ${library.templates.length} templates produced (${totalSlots} total slots)\n`,
      );

      console.log(`  Filling templates per page...`);
      let totalFilled = 0;
      const fillCounts = new Map<string, number>();
      for (const tpl of library.templates) {
        const tplPath = resolve(outputDir, "templates", tpl.file);
        let templateHtml: string;
        try {
          templateHtml = await readFile(tplPath, "utf8");
        } catch (err) {
          console.warn(`    ! template ${tpl.file} unreadable, skipping cluster: ${(err as Error).message}`);
          fillCounts.set(tpl.clusterId, 0);
          continue;
        }
        let perTpl = 0;
        for (const pagePath of tpl.pages) {
          try {
            const originalHtml = await readFile(pagePath, "utf8");
            const selectors = deriveSlotSelectors(originalHtml, templateHtml, tpl.slots);
            const values = extractSlotValues(originalHtml, selectors);
            const filled = fillTemplate(templateHtml, values);
            const seo = extractSeoHeadNodes(originalHtml);
            const out = injectSeoHeadNodes(filled, seo);
            await writeFile(pagePath, out);
            perTpl++;
            totalFilled++;
          } catch (err) {
            console.warn(`    ! ${pagePath}: ${(err as Error).message}`);
          }
        }
        fillCounts.set(tpl.clusterId, perTpl);
      }
      for (const [cid, n] of fillCounts) {
        console.log(`     ${cid}: ${n} pages filled`);
      }
      console.log(`  → ${totalFilled} pages rebuilt from templates\n`);

      if (imageCount > 0) {
        console.log(`  Rewriting <img> → <picture> on output pages...`);
        let pictureRewritten = 0;
        const finalPagePaths: string[] = [];
        try {
          const existing = await readdir(resolve(outputDir, "pages"), { recursive: true });
          for (const name of existing) {
            if (typeof name === "string" && name.endsWith("index.html")) {
              finalPagePaths.push(resolve(outputDir, "pages", name));
            }
          }
        } catch {
          /* no pages dir */
        }
        for (const p of finalPagePaths) {
          const html = await readFile(p, "utf8");
          const next = rewriteImgToPicture(html, imageManifest);
          if (next !== html) {
            await writeFile(p, next);
            pictureRewritten++;
          }
        }
        console.log(`  → ${pictureRewritten} pages updated with <picture>\n`);
      }
    });
}
