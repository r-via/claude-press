import type { Command } from "commander";
import { resolve } from "node:path";

interface DiffOptions {
  samples: string;
  threshold: string;
}

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Visual regression check: screenshot original vs cache, compare pixels")
    .argument("<output>", "Output directory")
    .option("--samples <n>", "number of pages to sample", "20")
    .option("--threshold <pct>", "max pixel-delta ratio before failing", "0.02")
    .action(async (output: string, opts: DiffOptions) => {
      const outputDir = resolve(output);
      const samples = Number(opts.samples);
      const threshold = Number(opts.threshold);

      console.log(`\nclaude-press — diff\n`);
      console.log(`  output:    ${outputDir}`);
      console.log(`  samples:   ${samples}`);
      console.log(`  threshold: ${threshold}\n`);

      // TODO: spin up local serve, launch Playwright, screenshot original + local, diff
      console.log(`  (visual diff not yet implemented — scaffold only)\n`);
    });
}
