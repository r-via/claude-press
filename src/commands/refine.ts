import type { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../core/config.js";
import { refinePages } from "../core/refiner.js";

interface RefineOptions {
  force: string[];
  forceAll: boolean;
}

export function registerRefine(program: Command): void {
  program
    .command("refine")
    .description("Run the refinement agent over already-built pages")
    .argument("<output>", "Output directory")
    .option("--force <path...>", "force-refine specific URL paths", [])
    .option("--force-all", "force-refine every page", false)
    .action(async (output: string, opts: RefineOptions) => {
      const config = loadConfig();
      const outputDir = resolve(output);

      console.log(`\nclaude-press — refine\n`);
      console.log(`  output: ${outputDir}`);
      console.log(`  llm:    ${config.llm.mode} (${config.llm.refinerModel})\n`);

      const result = await refinePages(outputDir, {
        force: opts.force ?? [],
        forceAll: opts.forceAll === true,
        llm: config.llm,
      });

      console.log(
        `  scanned=${result.scanned}  refined=${result.refined}  ` +
          `skipped=${result.skipped}  unchanged=${result.unchanged}  ` +
          `errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        for (const e of result.errors) {
          console.warn(`  ! ${e.page}: ${e.reason}`);
        }
      }
    });
}
