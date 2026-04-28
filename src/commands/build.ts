import type { Command } from "commander";
import { relative, resolve } from "node:path";
import { mkdir, access, readFile, writeFile, readdir } from "node:fs/promises";
import { expandSitemap } from "../core/sitemap.js";
import { loadConfig } from "../core/config.js";
import { downloadPages, type RobotsCache } from "../core/crawler.js";
import { discoverAssets, downloadAssets, type AssetRef } from "../core/assets.js";
import {
  rewriteHtmlAssetUrls,
  rewriteCssUrls,
  rewriteHreflangUrls,
  rewriteCanonicalUrl,
} from "../core/rewriter.js";
import {
  clusterPages,
  computeSkeleton,
  deriveLanguagePrefix,
  detectDivergentPages,
  type Cluster,
} from "../core/clustering.js";
import { createHash } from "node:crypto";
import { synthesizeTemplates } from "../core/templates.js";
import {
  deriveSlotSelectors,
  extractSlotValues,
  fillTemplate,
  extractSeoHeadNodes,
  injectSeoHeadNodes,
  preserveHtmlLang,
} from "../core/extractor.js";
import { generateResponsiveImages, rewriteImgToPicture } from "../core/images.js";
import { purgePageCss, inlineCriticalCss } from "../core/css.js";
import { minifyJsAssets, deferNonEssentialScripts } from "../core/js.js";
import { subsetFonts, injectFontDisplaySwap } from "../core/fonts.js";
import { generateOutputSitemap } from "../core/sitemap-gen.js";
import { cleanHtml, removeNonEssentialMeta } from "../core/html-clean.js";
import { injectLcpPreload, injectFontPreloads } from "../core/preload.js";

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
      // Shared robots.txt cache → /robots.txt is fetched once per host
      // even though pages and assets each call out separately.
      const robotsCache: RobotsCache = new Map();
      const { manifest, failures } = await downloadPages(toFetch, outputDir, config.crawler, {
        robotsCache,
      });
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
      const assetResult = await downloadAssets(allRefs, outputDir, config.crawler, {
        robotsCache,
      });
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
      const sitemapOrigin = new URL(sitemap).origin;
      for (const entry of manifest) {
        const html = await readFile(entry.localPath, "utf8");
        const pageLocalPath = relative(outputDir, entry.localPath).split(/[\\/]/).join("/");
        let next = rewriteHtmlAssetUrls(html, entry.url, assetResult.manifest, {
          pageLocalPath,
          onUnmatched: () => {
            unmatchedCount++;
          },
        });
        // Multilingual: re-target hreflang cross-references to the local URL
        // space so language switchers keep working (README § Multilingual).
        // Path-only output: omit the localBaseUrl so each href becomes a
        // root-relative path that works regardless of where the cache is
        // served (file://, localhost, production CDN).
        next = rewriteHreflangUrls(next, sitemapOrigin);
        // SEO: rewrite <link rel="canonical"> from the original origin to a
        // root-relative path so the deployed cache is treated as
        // authoritative (README § "SEO preservation").
        next = rewriteCanonicalUrl(next, sitemapOrigin, {
          onCrossDomain: (h) =>
            console.warn(`    ! cross-domain canonical left intact: ${h}`),
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

      // Divergence detection — pages whose structure doesn't fit any
      // cluster's representative get their own ad-hoc single-page cluster
      // routed through synthesizeTemplates so the LLM produces a new
      // template (README § "Template-driven rebuild" step 4).
      const pageSkeletons: Array<{
        path: string;
        skeleton: string;
        languagePrefix: string;
      }> = [];
      for (const p of allPagePaths) {
        try {
          const html = await readFile(p, "utf8");
          pageSkeletons.push({
            path: p,
            skeleton: computeSkeleton(html),
            languagePrefix: deriveLanguagePrefix(html, p),
          });
        } catch {
          /* unreadable page — ignore */
        }
      }
      const { divergent } = detectDivergentPages(pageSkeletons, clusters);
      const divergentClusters: Cluster[] = [];
      for (let i = 0; i < divergent.length; i++) {
        const p = divergent[i] ?? "";
        const meta = pageSkeletons.find((x) => x.path === p);
        const sk = meta?.skeleton ?? "";
        if (!p) continue;
        divergentClusters.push({
          id: `cluster-divergent-${i}`,
          fingerprint: createHash("sha256").update(sk).digest("hex").slice(0, 12),
          skeleton: sk,
          pages: [p],
          languagePrefix: meta?.languagePrefix ?? "",
        });
      }
      if (divergentClusters.length > 0) {
        console.log(
          `  → ${divergentClusters.length} divergent pages routed to new templates`,
        );
      }

      console.log(`  Synthesizing templates with the LLM...`);
      const allClusters: Cluster[] = [...clusters, ...divergentClusters];
      const library = await synthesizeTemplates(allClusters, outputDir, { llm: config.llm });
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
            const withSeo = injectSeoHeadNodes(filled, seo);
            const out = preserveHtmlLang(originalHtml, withSeo);
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
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            console.warn(`    ! pages dir missing, skipping <picture> rewrite`);
          } else {
            throw err;
          }
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

      console.log(`  Cleaning HTML (dead code, empty attrs, whitespace)...`);
      let htmlCleanedPages = 0;
      let htmlCleanBytesBefore = 0;
      let htmlCleanBytesAfter = 0;
      const finalPagesForClean: string[] = [];
      try {
        const existing = await readdir(resolve(outputDir, "pages"), { recursive: true });
        for (const name of existing) {
          if (typeof name === "string" && name.endsWith("index.html")) {
            finalPagesForClean.push(resolve(outputDir, "pages", name));
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
      for (const p of finalPagesForClean) {
        try {
          const html = await readFile(p, "utf8");
          htmlCleanBytesBefore += Buffer.byteLength(html, "utf8");
          const cleaned = cleanHtml(html);
          const stripped = removeNonEssentialMeta(cleaned);
          htmlCleanBytesAfter += Buffer.byteLength(stripped, "utf8");
          if (stripped !== html) {
            await writeFile(p, stripped);
            htmlCleanedPages++;
          }
        } catch (err) {
          console.warn(`    ! ${p}: HTML cleanup failed: ${(err as Error).message}`);
        }
      }
      console.log(
        `  → ${htmlCleanedPages} pages cleaned, ${htmlCleanBytesBefore - htmlCleanBytesAfter} bytes saved\n`,
      );

      console.log(`  Purging unused CSS and inlining critical CSS...`);
      let cssProcessedPages = 0;
      const finalPagesForCss: string[] = [];
      try {
        const existing = await readdir(resolve(outputDir, "pages"), { recursive: true });
        for (const name of existing) {
          if (typeof name === "string" && name.endsWith("index.html")) {
            finalPagesForCss.push(resolve(outputDir, "pages", name));
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
        console.warn(`    ! pages dir missing, skipping CSS optimization`);
      }
      for (const p of finalPagesForCss) {
        try {
          const html = await readFile(p, "utf8");
          const purged = await purgePageCss(html, outputDir);
          const inlined = await inlineCriticalCss(purged, outputDir);
          if (inlined !== html) {
            await writeFile(p, inlined);
            cssProcessedPages++;
          }
        } catch (err) {
          console.warn(`    ! ${p}: CSS optimization failed: ${(err as Error).message}`);
        }
      }
      console.log(`  → ${cssProcessedPages} pages CSS-optimized\n`);

      console.log(`  Injecting LCP image and font preload hints...`);
      let preloadPages = 0;
      let preloadHints = 0;
      const finalPagesForPreload: string[] = [];
      try {
        const existing = await readdir(resolve(outputDir, "pages"), { recursive: true });
        for (const name of existing) {
          if (typeof name === "string" && name.endsWith("index.html")) {
            finalPagesForPreload.push(resolve(outputDir, "pages", name));
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
      for (const p of finalPagesForPreload) {
        try {
          const html = await readFile(p, "utf8");
          const before = (html.match(/rel="preload"/g) ?? []).length;
          const withLcp = injectLcpPreload(html);
          const withFonts = injectFontPreloads(withLcp);
          const after = (withFonts.match(/rel="preload"/g) ?? []).length;
          if (withFonts !== html) {
            await writeFile(p, withFonts);
            preloadPages++;
            preloadHints += after - before;
          }
        } catch (err) {
          console.warn(`    ! ${p}: preload injection failed: ${(err as Error).message}`);
        }
      }
      console.log(`  → ${preloadHints} preload hints injected across ${preloadPages} pages\n`);

      console.log(`  Minifying JS assets...`);
      const jsResult = await minifyJsAssets(outputDir);
      const saved = jsResult.bytesBefore - jsResult.bytesAfter;
      console.log(
        `  → ${jsResult.filesProcessed} files minified (${jsResult.filesFailed} failed), ${saved} bytes saved\n`,
      );

      console.log(`  Deferring non-essential third-party scripts...`);
      let deferredPages = 0;
      const finalPagesForJs: string[] = [];
      try {
        const existing = await readdir(resolve(outputDir, "pages"), { recursive: true });
        for (const name of existing) {
          if (typeof name === "string" && name.endsWith("index.html")) {
            finalPagesForJs.push(resolve(outputDir, "pages", name));
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
        console.warn(`    ! pages dir missing, skipping JS defer pass`);
      }
      for (const p of finalPagesForJs) {
        try {
          const html = await readFile(p, "utf8");
          const next = await deferNonEssentialScripts(html);
          if (next !== html) {
            await writeFile(p, next);
            deferredPages++;
          }
        } catch (err) {
          console.warn(`    ! ${p}: JS defer failed: ${(err as Error).message}`);
        }
      }
      console.log(`  → ${deferredPages} pages updated with deferred scripts\n`);

      console.log(`  Subsetting fonts and injecting font-display: swap...`);
      const fontResult = await subsetFonts(outputDir, assetResult.manifest, {
        log: (m) => console.warn(`    ${m}`),
      });
      const fontSaved = fontResult.bytesBefore - fontResult.bytesAfter;
      console.log(
        `  → ${fontResult.fontsProcessed} fonts subsetted, ${fontSaved} bytes saved`,
      );

      // Inject `font-display: swap` into every CSS file under assets/css/.
      let cssFontDisplayUpdated = 0;
      try {
        const cssFiles = await readdir(resolve(outputDir, "assets", "css"));
        for (const name of cssFiles) {
          if (!name.endsWith(".css")) continue;
          const p = resolve(outputDir, "assets", "css", name);
          const css = await readFile(p, "utf8");
          const next = injectFontDisplaySwap(css);
          if (next !== css) {
            await writeFile(p, next);
            cssFontDisplayUpdated++;
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }

      // Inject into inline <style> blocks in output HTML pages.
      let htmlFontDisplayUpdated = 0;
      const finalPagesForFonts: string[] = [];
      try {
        const existing = await readdir(resolve(outputDir, "pages"), {
          recursive: true,
        });
        for (const name of existing) {
          if (typeof name === "string" && name.endsWith("index.html")) {
            finalPagesForFonts.push(resolve(outputDir, "pages", name));
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
      for (const p of finalPagesForFonts) {
        const html = await readFile(p, "utf8");
        const next = html.replace(
          /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
          (_m, open: string, body: string, close: string) =>
            open + injectFontDisplaySwap(body) + close,
        );
        if (next !== html) {
          await writeFile(p, next);
          htmlFontDisplayUpdated++;
        }
      }
      console.log(
        `  → font-display: swap injected into ${cssFontDisplayUpdated} CSS files, ${htmlFontDisplayUpdated} HTML pages\n`,
      );

      console.log(`  Regenerating output sitemap.xml...`);
      await generateOutputSitemap(outputDir, sitemapOrigin);
      let urlCount = 0;
      try {
        const existing = await readdir(resolve(outputDir, "pages"), {
          recursive: true,
        });
        for (const name of existing) {
          if (typeof name === "string" && name.endsWith("index.html")) urlCount++;
        }
      } catch {
        /* no pages dir */
      }
      console.log(`  → sitemap.xml written (${urlCount} URLs)\n`);
    });
}
