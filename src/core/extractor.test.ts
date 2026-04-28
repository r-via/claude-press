import { describe, it, expect } from "vitest";
import {
  deriveSlotSelectors,
  extractSlotValues,
  fillTemplate,
  extractSeoHeadNodes,
  injectSeoHeadNodes,
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
    expect(joined).toContain('application/ld+json');
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
    expect(out).toContain("Body copy here.");
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
