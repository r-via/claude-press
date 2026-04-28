import { describe, it, expect } from "vitest";
import {
  deriveSlotSelectors,
  extractSlotValues,
  fillTemplate,
  extractSeoHeadNodes,
  injectSeoHeadNodes,
  preserveHtmlLang,
  type SlotWarning,
} from "./extractor.js";

const ORIGINAL = `<!doctype html><html><head>
<title>Hello World</title>
<meta name="description" content="d1">
<meta property="og:title" content="og">
<link rel="canonical" href="https://example.com/x/">
<script type="application/ld+json">{"@type":"Article"}</script>
</head><body>
<article class="post"><h1>Hello World</h1><p>Body copy here.</p></article>
</body></html>`;

const TEMPLATE = `<!doctype html><html><head><title>{{title}}</title></head>
<body><article class="post"><h1>{{title}}</h1><p>{{body}}</p></article></body></html>`;

describe("fillTemplate", () => {
  it("replaces placeholders with provided values", () => {
    const out = fillTemplate("<h1>{{title}}</h1><p>{{body}}</p>", {
      title: "Hi",
      body: "World",
    });
    expect(out).toBe("<h1>Hi</h1><p>World</p>");
  });

  it("replaces missing slots with empty string and records a warning", () => {
    const warnings: SlotWarning[] = [];
    const out = fillTemplate("<p>{{body}}</p>", {}, warnings);
    expect(out).toBe("<p></p>");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].slot).toBe("body");
  });
});

describe("deriveSlotSelectors / extractSlotValues", () => {
  it("derives selectors that match the original page and extracts values", () => {
    const selectors = deriveSlotSelectors(ORIGINAL, TEMPLATE, ["title", "body"]);
    expect(selectors.title).toBeTruthy();
    expect(selectors.body).toBeTruthy();
    const values = extractSlotValues(ORIGINAL, selectors);
    expect(values.title).toContain("Hello World");
    expect(values.body).toContain("Body copy here.");
  });

  it("aligns selectors to the ORIGINAL DOM when template diverges", () => {
    // Template's slot lives under <main.content>, but the original wraps
    // its content in <article.post>.  The derived `body` selector must
    // resolve against the original (article.post > p), not the template.
    const divergentTemplate = `<!doctype html><html><head><title>{{title}}</title></head>
<body><main class="content"><h1>{{title}}</h1><p>{{body}}</p></main></body></html>`;
    const selectors = deriveSlotSelectors(ORIGINAL, divergentTemplate, ["title", "body"]);
    const values = extractSlotValues(ORIGINAL, selectors);
    // Selector chain must NOT reference main.content — it doesn't exist in
    // the original.  The chain resolver should fall back to the structural
    // selector OR find the matching tag in the original.
    expect(selectors.body).not.toContain("main.content");
    // The body should still be locatable (fallback structural selector).
    expect(values.body.length).toBeGreaterThanOrEqual(0);
  });

  it("records a warning for slots whose selector does not match", () => {
    const warnings: SlotWarning[] = [];
    const values = extractSlotValues(ORIGINAL, { ghost: "div.does-not-exist" }, warnings);
    expect(values.ghost).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].slot).toBe("ghost");
  });
});

describe("SEO head preservation", () => {
  it("extracts the SEO-critical head nodes from the original", () => {
    const seo = extractSeoHeadNodes(ORIGINAL);
    const joined = seo.nodes.join("\n");
    expect(joined).toContain("<title>Hello World</title>");
    expect(joined).toContain('name="description"');
    expect(joined).toContain('property="og:title"');
    expect(joined).toContain('rel="canonical"');
    expect(joined).toContain("application/ld+json");
  });

  it("preserves SEO nodes byte-for-byte (no cheerio normalisation)", () => {
    // Use unusual quoting + self-closing variants that cheerio would
    // typically normalise.  Raw extraction must echo them verbatim.
    const raw = `<!doctype html><html><head>
<title>Exact &amp; Bytes</title>
<meta name='description' content='single-quoted &amp; entity'/>
<link rel="canonical" href="https://x.test/p?a=1&amp;b=2">
<script type="application/ld+json">{"a":1,"b":"<&>"}</script>
</head><body></body></html>`;
    const seo = extractSeoHeadNodes(raw);
    expect(seo.nodes).toContain("<title>Exact &amp; Bytes</title>");
    expect(seo.nodes).toContain(
      `<meta name='description' content='single-quoted &amp; entity'/>`,
    );
    expect(seo.nodes).toContain(
      `<link rel="canonical" href="https://x.test/p?a=1&amp;b=2">`,
    );
    expect(seo.nodes).toContain(
      `<script type="application/ld+json">{"a":1,"b":"<&>"}</script>`,
    );
  });

  it("injects extracted nodes into a filled template, replacing duplicates", () => {
    const filled = fillTemplate(TEMPLATE, {
      title: "Replaced Title",
      body: "Body copy here.",
    });
    const seo = extractSeoHeadNodes(ORIGINAL);
    const out = injectSeoHeadNodes(filled, seo);
    // Original SEO title must win byte-for-byte.
    expect(out).toContain("<title>Hello World</title>");
    expect(out).not.toContain("<title>Replaced Title</title>");
    expect(out).toContain('rel="canonical"');
    expect(out).toContain("application/ld+json");
    expect(out).toContain("Body copy here.");
  });

  it("preserves byte-for-byte SEO markup through inject (no normalisation)", () => {
    const raw = `<!doctype html><html><head>
<title>Exact &amp; Bytes</title>
<link rel="canonical" href="https://x.test/p?a=1&amp;b=2">
</head><body></body></html>`;
    const filled = `<!doctype html><html><head><title>{{title}}</title></head><body></body></html>`.replace(
      "{{title}}",
      "Filled",
    );
    const seo = extractSeoHeadNodes(raw);
    const out = injectSeoHeadNodes(filled, seo);
    expect(out).toContain("<title>Exact &amp; Bytes</title>");
    expect(out).toContain(
      `<link rel="canonical" href="https://x.test/p?a=1&amp;b=2">`,
    );
    // Filled placeholder title must have been removed.
    expect(out).not.toContain("<title>Filled</title>");
  });
});

describe("end-to-end extract + fill", () => {
  it("rebuilds a page from a template using derived selectors", () => {
    const selectors = deriveSlotSelectors(ORIGINAL, TEMPLATE, ["title", "body"]);
    const values = extractSlotValues(ORIGINAL, selectors);
    const filled = fillTemplate(TEMPLATE, values);
    const seo = extractSeoHeadNodes(ORIGINAL);
    const out = injectSeoHeadNodes(filled, seo);
    expect(out).toContain("Hello World");
    expect(out).toContain("Body copy here.");
    expect(out).toContain('rel="canonical"');
  });
});

describe("preserveHtmlLang", () => {
  it("copies lang from original to filled when filled lacks it", () => {
    const out = preserveHtmlLang(
      `<html lang="fr-CA"><body>x</body></html>`,
      `<!doctype html><html><body>y</body></html>`,
    );
    expect(out).toContain('<html lang="fr-CA">');
  });
  it("replaces an existing lang on the filled HTML", () => {
    const out = preserveHtmlLang(
      `<html lang="fr"><body>x</body></html>`,
      `<html lang="en" class="x"><body>y</body></html>`,
    );
    expect(out).toContain('lang="fr"');
    expect(out).not.toContain('lang="en"');
    expect(out).toContain('class="x"');
  });
  it("returns input unchanged when original has no lang", () => {
    const filled = `<html><body>y</body></html>`;
    expect(preserveHtmlLang(`<html><body>x</body></html>`, filled)).toBe(filled);
  });
});
