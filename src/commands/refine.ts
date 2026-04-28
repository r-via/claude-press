import type { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../core/config.js";

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
    .action(async (output: string, _opts: RefineOptions) => {
      const config = loadConfig();
      const outputDir = resolve(output);

      console.log(`\nclaude-press — refine\n`);
      console.log(`  output: ${outputDir}`);
      console.log(`  llm:    ${config.llm.mode} (${config.llm.refinerModel})\n`);

      // TODO: walk ./pages, dedupe already-refined, call refinement agent
      console.log(`  (refinement agent not yet implemented — scaffold only)\n`);
    });
}
