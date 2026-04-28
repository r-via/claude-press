import type { Command } from "commander";
import { writeFile, access, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchSitemap, isSitemapIndex, parseLocs, expandSitemap } from "../core/sitemap.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Bootstrap a project: write .env, detect sitemap, dry-run a single page")
    .argument("<site>", "Root URL of the site, e.g. https://example.com/")
    .action(async (site: string) => {
      const cwd = resolve(".");
      console.log(`\nclaude-press — init\n`);

      // 1. Write .env if missing
      const envPath = resolve(cwd, ".env");
      const examplePath = resolve(cwd, ".env.example");
      if (!(await exists(envPath))) {
        if (await exists(examplePath)) {
          await copyFile(examplePath, envPath);
          console.log(`  ✓ wrote .env (from .env.example)`);
        } else {
          await writeFile(envPath, "LLM_MODE=local\n", "utf8");
          console.log(`  ✓ wrote minimal .env`);
        }
      } else {
        console.log(`  ✓ .env already exists, leaving untouched`);
      }

      // 2. Detect sitemap
      const base = site.endsWith("/") ? site.slice(0, -1) : site;
      const candidates = [
        `${base}/sitemap_index.xml`,
        `${base}/sitemap.xml`,
      ];
      let detected: string | undefined;
      for (const url of candidates) {
        try {
          const xml = await fetchSitemap(url, "claude-press/0.0.1 (init)");
          if (isSitemapIndex(xml) || /<urlset[\s>]/i.test(xml)) {
            detected = url;
            const count = isSitemapIndex(xml)
              ? (await expandSitemap(url, "claude-press/0.0.1 (init)")).length
              : parseLocs(xml).length;
            console.log(`  ✓ sitemap found: ${url} (${count} URLs)`);
            break;
          }
        } catch {
          // try next
        }
      }
      if (!detected) {
        console.log(`  ✗ no sitemap found at ${candidates.join(" or ")}`);
        console.log(`    pass it explicitly to "claude-press build <sitemap-url> ./output"`);
      }

      console.log(`\n  Next: claude-press build ${detected ?? "<sitemap-url>"} ./output\n`);
    });
}
