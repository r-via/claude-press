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

The core architectural choice: **the LLM works on templates, not pages, and visually rather than textually**. Two complementary mechanisms keep cost low and fidelity high — a deterministic structural matcher decides *which* pages need an LLM call, and a visual synthesis loop produces the templates without ever showing raw HTML to the model.

### 1. Cluster — deterministic, no LLM

Every downloaded page gets a **structural fingerprint** computed by cheerio: ordered sequence of tag names + nesting depth + de-noised CSS classes (WordPress-specific cruft like `vc_*`, `wpb_*`, `nd_options_*`, locale slot ids, post-id classes are stripped before hashing). Pages with the same fingerprint share a cluster. On a typical WordPress site this collapses 700+ pages into 4–8 clusters.

The fingerprint is also language-aware: the language prefix from the URL path or `<html lang>` is prepended to the hash so a French blog post and an English one don't share a template unless explicitly opted in.

### 2. Match — deterministic, no LLM

For every page, before any LLM is touched, the build runs a **deterministic match check** against the existing template library:

- **Exact fingerprint match** → reuse the cluster's template directly. Zero LLM cost.
- **Fuzzy match** (Jaccard similarity ≥ 0.7 on tag bigrams of the de-noised skeleton) → reuse the closest cluster's template; the slot extractor adapts to small structural variations.
- **No match** → divergent page. Trigger the synthesis loop (step 3) to produce a new template, which joins the library and is reused on the next matching page.

This is why incremental runs over a stable WP site are essentially free: a new article with the same blog-post shape as 200 existing ones reuses their template — only its content is extracted and injected.

### 3. Synthesize — vision-first, only on cluster representatives or divergent pages

For each cluster (or each divergent page), one LLM call produces an optimized template **from the visual appearance of the page, not from its HTML**. The LLM is never given full page HTML — that's expensive (~240k tokens for a 1 MB WP page), noisy (theme classes, inline styles, third-party widgets), and biases the model toward replicating the WordPress soup it should be replacing.

Concretely:

1. **Render** the representative page with **Playwright** (headless Chromium) at three viewports — mobile (390 × 844), tablet (768 × 1024), desktop (1440 × 900). Screenshots go to `tmp/screenshots/`.
2. **Detect slots** — a deterministic cheerio pre-pass walks the original DOM and emits the list of named slots (`title`, `hero_image`, `breadcrumbs`, `body`, `gallery`, `cta`, …) plus a stable CSS selector for each. This is the **content contract** between the template and the original page. The LLM receives only the slot names and their semantic role, never the raw HTML or the actual text. See [Slot detection — separating content from chrome](#slot-detection--separating-content-from-chrome) below for how the detector decides what's a slot.
3. **Generate** — the vision-capable LLM (Sonnet 4.6 / Opus 4.7 / GPT-5 / Gemini 2.5) receives the screenshots + the slot list and produces a clean modern HTML/CSS template *from scratch* with `{{slot}}` placeholders. No WordPress class names, no inline `<style>` soup.
4. **Render-diff loop** — the candidate template is rendered with placeholder content, screenshotted at the same viewports, and compared pixel-by-pixel against the originals (SSIM ≥ 0.95 *and* pixel-delta < 2%). On miss, the diff image is fed back to the LLM with "regions still off: …" annotations. Repeat up to N iterations (default 5).
5. **Persist** — once converged, the template is written to `output/templates/<cluster-id>.html` and `_manifest.json` records the slot → selector mapping.

**Why visual rather than textual** — a screenshot says in ~50–200 KB everything the LLM needs about layout, hierarchy, spacing, color, and emphasis. The same page as HTML is 5–10× larger and full of distractions that pull the model toward "preserve this `<div>` because it has a class I don't recognize" rather than "produce a clean equivalent of what I see".

**Local mode** uses the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server (configured in [`.mcp.json`](.mcp.json)) so the Claude Code agent drives the render-diff loop autonomously through MCP tool calls. **API mode** drives the loop from Node — Playwright invoked directly via its Node API, screenshots sent as image inputs to the chosen provider through the Vercel AI SDK.

**Failure handling** — if the visual loop doesn't converge (LLM error, max iterations exceeded, missing vision support), the build logs the failure and falls back to a **passthrough template** that wraps the original `<body>` content with the slot markers extracted in step 2. The rest of the pipeline (image variants, CSS purging, preload hints, refinement) still runs on the page. The pipeline never aborts mid-build.

### 4. Extract & fill — deterministic, no LLM

For every page (cluster representative or otherwise), the deterministic extractor:

1. Reads the original HTML.
2. Pulls each slot's value via the cheerio selector recorded in `_manifest.json` — verbatim text, with attributes and inline formatting preserved.
3. Pours the values into the matched template, replacing `{{slot}}` placeholders.
4. Splices the SEO `<head>` block (`<title>`, meta description, OpenGraph, Twitter, canonical, hreflang, JSON-LD) byte-for-byte from the original into the filled template's `<head>`.

**No LLM call per page, ever, in the steady state.** The visual loop runs only for cluster representatives and divergent pages — typically 5–10 calls for a site with 700+ pages, no matter how many times you re-run `build`.

### Slot detection — separating content from chrome

The hardest question in template synthesis is *which DOM nodes are content (slots, varying per page) and which are chrome (static, shared across the cluster)?*. The slot detector composes four signals, ordered from most reliable to most heuristic. The first three are deterministic; the fourth is a fallback only used when the first three find nothing.

**1. Intra-cluster differential — the dominant signal.** A cluster always contains ≥ 2 pages with the same structural fingerprint. The detector dom-diffs them node-by-node:

- A node whose text and attributes are **identical across every page in the cluster** is chrome (header, nav, footer, sidebar widgets, cookie banner, copyright). It's emitted as a literal in the template, not a slot.
- A node that **varies between pages** is content. It becomes a named slot, with the cheerio selector that locates it.

On a 543-article blog cluster the WPML language switcher, primary menu, footer, and "back to top" widget appear identically everywhere — reliably classified as chrome without any heuristic. Only the genuinely page-specific blocks become slots.

**2. Explicit semantic markers.** WordPress with Yoast + a modern theme already declares the canonical content via:

- **OpenGraph / meta** — `og:title`, `og:description`, `og:image`, `article:published_time`, `article:author`, `article:section`. Gold-standard: pre-named slots locatable without any inference.
- **JSON-LD `<script type="application/ld+json">`** — `Article.headline`, `Article.articleBody`, `BreadcrumbList`, `Person`, `ImageObject`. Same role for richer types.
- **Microdata / `itemprop`** when present.

When these markers exist they're trusted directly — no need to guess.

**3. HTML5 semantic structure.** `<main>`, `<article>`, `<section>` are content zones; `<nav>`, `<aside>`, `<header role="banner">`, `<footer>` are chrome zones. The detector restricts slot candidates to content zones and treats varying nodes inside chrome zones as edge cases (e.g. a "current language" flag inside `<nav>` that differs per locale — kept as chrome with a tiny `{{lang}}` slot).

**4. DOM heuristics (fallback only).** When the three signals above find nothing — old themes without semantic tags, no OG/JSON-LD, no microdata — the detector applies a small named heuristic table:

- First `<h1>` inside `<main>` → `title`.
- First `<img>` inside `<main>` → `hero_image`.
- Direct `<p>` children of `<article>` → `body`.
- `.breadcrumbs`, `[itemtype*=BreadcrumbList]`, `nav[aria-label*=breadcrumb]` → `breadcrumbs`.
- `<time datetime>` → `published_time`.
- `[rel=author]`, `.author`, `.byline` → `author`.

These heuristics are explicit, scoped, and disablable. They never override signals 1–3.

**The render-diff loop is the arbiter.** If the slot detector misses a region (a sidebar block that *does* vary per page but the diff didn't catch because cluster size was too small, for instance), the synthesis loop's pixel-diff will surface it: the screenshot of the filled template shows an empty or misaligned zone where the original had content. The LLM is fed the diff image with "regions still off" annotations and the missing slot is added to the manifest before the next iteration. The slot detector and the render-diff loop are complementary safety nets.

### Why text fidelity is preserved

A common worry with vision-driven synthesis is "the LLM will paraphrase or drop content". It cannot, because **the LLM never sees the content**. Slot values are extracted by cheerio from the original DOM and injected into the template by string replacement. The visual loop converges on *layout*; the text always comes from the source page, byte-for-byte. The refinement agent (step 7 of the pipeline, separate command) is the only stage that may rewrite visible body text, and it operates on the filled output — opt-in, scoped to body copy, and explicitly forbidden from touching SEO-sensitive elements.

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
- **Visual rendering**: `playwright` (Chromium, headless) for the vision-first template synthesis loop, plus the `diff` command's regression check
- **Image diff**: `pixelmatch` + `pngjs` (SSIM/pixel-delta against the original)
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
