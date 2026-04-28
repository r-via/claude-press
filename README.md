# claude-press

A tool that turns a website into an ultra-optimized static cache for Google PageSpeed.

## Scope

claude-press targets **static content only** — pages that render fully from HTML+CSS+JS. Dynamic endpoints (form submissions, search, comments, AJAX, REST APIs) are explicitly out of scope and ignored during the build.

## Incremental by default

Every run is incremental: a page that already exists in `./output/pages/` is **never rebuilt**. The sitemap's `lastmod` is ignored on purpose — the cache is treated as authoritative until you say otherwise. Only new URLs (added since the last run) are fetched and rendered.

To force-rebuild specific pages, pass them explicitly:

```bash
claude-press build https://example.com/sitemap.xml ./output \
  --force /en/blog/travel-ideas/what-to-do-in-spain/ \
  --force /fr/

claude-press build ... --force-all   # nuke and rebuild everything
```

The same rule applies to the refinement agent — already-refined pages are skipped unless explicitly targeted.

## SEO preservation

The following elements are treated as **read-only** through the entire pipeline (clustering, template synthesis, fill, refinement) and are copied byte-for-byte from source to output:

- `<title>` and `<meta name="description">`
- OpenGraph and Twitter card meta tags
- `<link rel="canonical">` (rewritten to local URL but otherwise preserved)
- `<link rel="alternate" hreflang="...">` (re-targeted to local URLs, see Multilingual)
- All `<script type="application/ld+json">` blocks (schema.org structured data)

The refinement agent is forbidden from touching these — it operates on visible body text only.

## Multilingual

For sites serving multiple languages under path prefixes (e.g. `/fr/`, `/en/`), claude-press:

- clusters per-language by default (a French blog post and an English one don't share a template unless explicitly opted in),
- recomputes `hreflang` cross-references against the local URL space so language switchers keep working,
- preserves the language attribute on `<html lang="...">`.

## How it works

1. Reads the target site's `sitemap.xml` (and any nested sitemaps).
2. Downloads every listed page.
3. Discovers every referenced asset (CSS, JS, images, fonts) and downloads them — for images, fetches the **largest available variant** (full-resolution source).
4. **Detects page templates with the LLM**: clusters downloaded pages by structural similarity, has Claude analyze each cluster, and emits a small set of pre-compiled, optimized templates (e.g. `blog-post`, `travel-card`, `homepage`, `archive`). For each new page: if its structure matches an existing template, content is extracted and re-injected into the template (deterministic fill); if it diverges, the LLM produces a new template, which is added to the library and reused for future similar pages.
5. Rewrites all asset URLs in HTML and CSS to point to the local `/assets/` paths (hashed for long-term caching).
6. Generates **adaptive variants on the fly**: responsive image sets (`srcset` in WebP/AVIF at multiple widths) and per-page CSS (purged + critical-inlined).
7. Runs a refinement agent that reviews the textual content of each page and rewrites it when needed (clarity, tone, SEO).

## Template-driven rebuild

This is the core architectural choice: **the LLM works on templates, not pages**. Concretely:

1. **Cluster** — pages are grouped by structural fingerprint (DOM shape, CSS classes, content blocks). On a typical WordPress site this collapses 700+ pages into 4–8 clusters.
2. **Synthesize** — for each cluster, Claude produces an optimized template: clean HTML skeleton, named content slots (`{{title}}`, `{{hero_image}}`, `{{body}}`, …), inlined critical CSS, deferred non-critical CSS/JS, proper `<picture>` markup for adaptive images.
3. **Extract & fill** — for each page in the cluster, a deterministic extractor reads the original HTML (cheerio selectors derived from the cluster analysis) and pours the content into the template. No LLM call per page.
4. **Diverge** — if a page doesn't fit any existing template (similarity below threshold), Claude is asked to produce a new template; it joins the library and is reused on the next match.

**Why this matters:** ~5 LLM calls instead of ~705. Deterministic, reproducible, cheap, and the template library becomes a versioned artifact you can review, edit, and improve over time.

## Output structure

```
./output
├── pages/         # one HTML file per URL, mirroring the original path
│   └── en/blog/travel-ideas/what-to-do-in-spain/index.html
├── templates/     # versioned template library produced by the LLM
│   ├── blog-post.html
│   ├── travel-card.html
│   ├── homepage.html
│   └── _manifest.json     # cluster definitions, slot schemas, page→template map
├── assets/        # shared, hashed, optimized assets (CSS, JS, images, fonts)
│   ├── css/
│   ├── js/
│   ├── img/
│   └── fonts/
└── sitemap.xml    # regenerated for the local cache, with output URLs and lastmod
```

Pages reference assets via stable hashed paths, so a single asset is downloaded once and cached aggressively. The output `sitemap.xml` is regenerated at the end of every build so the cache is itself crawlable.

## Commands

**`init`** — bootstrap a project: writes `.env`, detects the sitemap, runs a single-page dry-run to validate the LLM setup.

```bash
claude-press init https://example.com/
```

**`build`** — incremental crawl + render (see [Incremental by default](#incremental-by-default)).

```bash
claude-press build https://example.com/sitemap.xml ./output
```

URLs can be filtered directly from the command line — useful for testing on a subset before a full run, or for rebuilding a single page:

```bash
# Only process URLs whose path matches a glob (repeatable, OR semantics)
claude-press build https://example.com/sitemap.xml ./output \
  --only '/en/blog/**' \
  --only '/fr/'

# Process exactly these URLs (skip the sitemap entirely; treat the args as the input set)
claude-press build ./output \
  --url https://example.com/en/blog/travel-ideas/what-to-do-in-spain/ \
  --url https://example.com/fr/

# Limit to N URLs from the sitemap (useful for smoke tests)
claude-press build https://example.com/sitemap.xml ./output --limit 10
```

`--only` and `--limit` apply on top of the sitemap; `--url` bypasses sitemap fetching altogether. All three compose with `--force` and `--force-all`.

**`refine`** — runs the refinement agent over already-built pages (skips pages already refined unless `--force` is passed).

```bash
claude-press refine ./output
```

**`diff`** — visual regression check. Picks N random pages, screenshots the original site and the local cache with Playwright, compares pixel-by-pixel, fails if delta exceeds the configured threshold.

```bash
claude-press diff ./output --samples 20 --threshold 0.02
```

**`serve`** — local HTTP server.

```bash
claude-press serve ./output --port 8080
```

Resolves URLs against `./output/pages`, serves `./output/assets` with long-lived cache headers, applies gzip/brotli compression, and returns proper 404s.

### Crawler etiquette

Configurable in `.env`:

```bash
CRAWL_CONCURRENCY=8           # parallel page downloads
CRAWL_DELAY_MS=200            # min delay between requests to the same host
CRAWL_USER_AGENT=claude-press/1.0 (+https://github.com/...)
CRAWL_RESPECT_ROBOTS=true     # honor robots.txt
```

## Stack

- **Runtime**: Bun (or Node.js 22) + TypeScript
- **CLI**: `commander`
- **HTML**: `cheerio` + `parse5`
- **CSS**: `lightningcss` + `beasties` (critical CSS)
- **Images**: `sharp` (WebP/AVIF)
- **HTTP server**: `hono`
- **Tests**: `vitest`
- **LLM**: two interchangeable modes, selected via `.env`
  - **Local mode** — uses the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) and reuses your local Claude Code session (no API key needed, no extra billing).
  - **API mode** — uses the [Vercel AI SDK](https://sdk.vercel.ai) (`ai` + provider packages), model-agnostic across Anthropic, OpenAI, Google, Mistral, Ollama, etc.

### LLM configuration

Two modes (`LLM_MODE=local|api`), configured via `.env`. API mode uses `provider/model` routing (e.g. `anthropic/claude-haiku-4-5`) through the Vercel AI SDK. Local mode routes all calls through the Claude Agent SDK with no API key needed.

→ Full reference: [SPEC/archive/001-llm-configuration.md](SPEC/archive/001-llm-configuration.md)

## Asset pipeline

Images, CSS, JS, and fonts are each optimized per-asset-type: responsive image sets (AVIF/WebP/fallback at multiple widths via `sharp`), per-page CSS purging + critical inlining (`lightningcss` + `beasties`), JS minification + dead-code removal (`terser`), and font subsetting to used glyphs (WOFF2).

→ Full detail: [SPEC/archive/002-asset-pipeline.md](SPEC/archive/002-asset-pipeline.md)

## Optimizations applied

- HTML cleanup (dead code removal, DOM simplification).
- Critical CSS inlining, lazy-loading of below-the-fold styles.
- Adaptive responsive images (AVIF/WebP, multiple widths via `srcset`).
- JS/CSS minification, removal of unused third-party scripts.
- Smart preloading of key assets (LCP image, critical fonts).
- Textual refinement pass (grammar, clarity, SEO-friendly phrasing).

## Result

A local mirror of the site, identical in look and URLs, but significantly faster — and with cleaner copy.

## Engineering practices

The project follows **TDD** (test-driven development) and **DDD** (domain-driven design):

- **TDD** — every domain module ships with a `*.test.ts` file (`vitest`). Tests are written before or alongside the implementation; the suite runs on every commit. Pure functions are the default so behavior is testable without IO mocks.
- **DDD** — the codebase is organized around the problem domain, not the framework. Each bounded context (sitemap parsing, LLM transport, template synthesis, asset pipeline, refinement agent, HTTP serving) lives in its own module under `src/core/` with explicit types and a small public surface. Commands in `src/commands/` are thin orchestration layers — they wire the domain modules together but contain no business logic themselves.
