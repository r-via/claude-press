#!/usr/bin/env node
import { Command } from "commander";
import "dotenv/config";
import { registerInit } from "./commands/init.js";
import { registerBuild } from "./commands/build.js";
import { registerRefine } from "./commands/refine.js";
import { registerDiff } from "./commands/diff.js";
import { registerServe } from "./commands/serve.js";

const program = new Command();

program
  .name("claude-press")
  .description("Turn a website into an ultra-optimized static cache for Google PageSpeed.")
  .version("0.0.1");

registerInit(program);
registerBuild(program);
registerRefine(program);
registerDiff(program);
registerServe(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
