import type { Command } from "commander";
import { resolve } from "node:path";
import { runVisualDiff } from "../core/diff.js";

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

      let result;
      try {
        result = await runVisualDiff(outputDir, { samples, threshold });
      } catch (err) {
        console.error(`  ! diff failed: ${(err as Error).message}\n`);
        process.exitCode = 1;
        return;
      }

      for (const e of result.entries) {
        const tag = e.pass ? "PASS" : "FAIL";
        console.log(`  [${tag}] ${(e.deltaRatio * 100).toFixed(2)}%  ${e.url}`);
      }
      console.log("");

      if (!result.pass) {
        const failing = result.entries.filter((e) => !e.pass);
        console.error(`  ${failing.length} page(s) exceeded threshold ${threshold}:`);
        for (const e of failing) console.error(`    ! ${e.url}  (${e.deltaRatio.toFixed(4)})`);
        console.error("");
        process.exitCode = 1;
        return;
      }

      console.log(`  all ${result.entries.length} sampled pages within threshold\n`);
    });
}
