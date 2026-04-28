import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Cluster, ClusterManifest } from "./clustering.js";
import type { LlmConfig } from "./config.js";
import { generate as defaultGenerate } from "./llm/index.js";

export interface TemplateEntry {
  clusterId: string;
  fingerprint: string;
  /** Template file name, relative to `<outputDir>/templates/`. */
  file: string;
  /** Names of `{{slot}}` placeholders discovered in the template. */
  slots: string[];
  /** Local page paths covered by this template. */
  pages: string[];
}

export interface TemplateLibrary {
  templates: TemplateEntry[];
}

/** Generator function signature accepted by `synthesizeTemplates`. */
export type SynthesizeGenerator = (prompt: string, systemPrompt: string) => Promise<string>;

const SYSTEM_PROMPT = [
  "You convert a representative HTML page into a clean, optimized HTML5 template.",
  "Rules:",
  "- Output ONLY the template HTML, no commentary, no Markdown fences.",
  "- Replace concrete content (titles, body copy, hero images, lists) with named",
  "  placeholders of the form `{{slot_name}}` using snake_case identifiers.",
  "- Preserve <title>, meta description, OpenGraph/Twitter, canonical, hreflang,",
  "  and ld+json blocks verbatim — these are SEO-critical.",
  "- Inline a placeholder for critical CSS as `{{critical_css}}` inside <head>.",
  "- Defer non-critical CSS/JS via async/defer or `{{deferred_assets}}`.",
  "- Keep the document well-formed and valid HTML5.",
  "- The template MUST contain at least one {{slot}} placeholder.",
].join("\n");

const SLOT_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function extractSlots(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(SLOT_REGEX)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return Array.from(found).sort();
}

function buildPrompt(html: string, fingerprint: string): string {
  return [
    `Cluster fingerprint: ${fingerprint}`,
    "",
    "Below is a representative page from this cluster. Produce one optimized",
    "HTML template covering pages of this shape, using `{{slot}}` placeholders",
    "for everything that varies between pages.",
    "",
    "----- BEGIN PAGE HTML -----",
    html,
    "----- END PAGE HTML -----",
  ].join("\n");
}

/**
 * Strip Markdown code fences if the LLM defied the system prompt and added them.
 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```(?:html?)?\s*\n?([\s\S]*?)\n?```\s*$/i;
  const m = trimmed.match(fence);
  return m && m[1] ? m[1].trim() : trimmed;
}

export interface SynthesizeOptions {
  /** Inject a generator (used by tests); defaults to the configured LLM transport. */
  generate?: SynthesizeGenerator;
  /** Required when `generate` is omitted — used to build the default generator. */
  llm?: LlmConfig;
}

/**
 * For every cluster, ask the LLM to synthesize an optimized HTML template
 * with named `{{slot}}` placeholders, persist it under
 * `<outputDir>/templates/<cluster-id>.html`, and update the cluster
 * manifest with template metadata.
 *
 * Empty clusters (no pages) are skipped gracefully.
 */
export async function synthesizeTemplates(
  clusters: Cluster[],
  outputDir: string,
  options: SynthesizeOptions = {},
): Promise<TemplateLibrary> {
  const generate: SynthesizeGenerator =
    options.generate ??
    ((prompt, system) => {
      if (!options.llm) {
        throw new Error(
          "synthesizeTemplates: either `generate` or `llm` config must be provided",
        );
      }
      return defaultGenerate(prompt, options.llm, { systemPrompt: system });
    });

  const templatesDir = resolve(outputDir, "templates");
  await mkdir(templatesDir, { recursive: true });

  const entries: TemplateEntry[] = [];
  for (const cluster of clusters) {
    const samplePath = cluster.pages[0];
    if (!samplePath) continue;

    const sample = await readFile(samplePath, "utf8");
    const raw = await generate(buildPrompt(sample, cluster.fingerprint), SYSTEM_PROMPT);
    const template = stripFences(raw);
    const slots = extractSlots(template);
    if (slots.length === 0) {
      throw new Error(
        `Template for ${cluster.id} (${cluster.fingerprint}) has no {{slot}} placeholders`,
      );
    }

    const file = `${cluster.id}.html`;
    await writeFile(resolve(templatesDir, file), template);

    entries.push({
      clusterId: cluster.id,
      fingerprint: cluster.fingerprint,
      file,
      slots,
      pages: cluster.pages,
    });
  }

  // Merge into existing _manifest.json (clusterPages writes it first).
  const manifestPath = resolve(templatesDir, "_manifest.json");
  let manifest: ClusterManifest & { templates?: TemplateEntry[] };
  try {
    const existing = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(existing);
  } catch {
    manifest = {
      generatedAt: new Date().toISOString(),
      clusters: clusters.map((c) => ({
        id: c.id,
        fingerprint: c.fingerprint,
        pageCount: c.pages.length,
        pages: c.pages,
      })),
    };
  }
  manifest.templates = entries;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { templates: entries };
}
