import { describe, it, expect } from "vitest";
import { cleanHtml, removeNonEssentialMeta } from "./html-clean.js";

describe("cleanHtml", () => {
  it("removes plain HTML comments", () => {
    const out = cleanHtml(`<div><!-- nope -->kept</div>`);
    expect(out).not.toContain("<!--");
    expect(out).toContain("kept");
  });

  it("preserves IE conditional comments", () => {
    const html = `<!--[if IE]><script src="ie.js"></script><![endif]-->kept`;
    const out = cleanHtml(html);
    expect(out).toContain("[if IE]");
  });

  it("strips obsolete script/style type attrs", () => {
    const out = cleanHtml(
      `<script type="text/javascript">x</script><style type="text/css">a{}</style>`,
    );
    expect(out).not.toMatch(/script[^>]+type=/);
    expect(out).not.toMatch(/style[^>]+type=/);
  });

  it("preserves modern script types (e.g. application/ld+json, module)", () => {
    const html = `<script type="application/ld+json">{"@type":"WebPage"}</script><script type="module" src="m.js"></script>`;
    const out = cleanHtml(html);
    expect(out).toContain('type="application/ld+json"');
    expect(out).toContain('type="module"');
  });

  it("removes empty class/id/style attributes", () => {
    const out = cleanHtml(`<div class="" id="  " style="">x</div>`);
    expect(out).not.toContain("class=");
    expect(out).not.toContain("id=");
    expect(out).not.toContain("style=");
  });

  it("keeps non-empty class/id/style", () => {
    const out = cleanHtml(`<div class="hero" id="x" style="color:red">y</div>`);
    expect(out).toContain('class="hero"');
    expect(out).toContain('id="x"');
    expect(out).toContain('style="color:red"');
  });

  it("collapses runs of whitespace in text nodes outside <pre>", () => {
    const html = `<div>a    b\n\n\nc</div>`;
    const out = cleanHtml(html);
    expect(out).toContain("a b c");
  });

  it("preserves whitespace inside <pre> and <code> and <textarea>", () => {
    const html = `<pre>  a\n\n  b </pre><code>  x\n  y</code><textarea>  z\n  w</textarea>`;
    const out = cleanHtml(html);
    expect(out).toContain("  a\n\n  b ");
    expect(out).toContain("  x\n  y");
    expect(out).toContain("  z\n  w");
  });

  it("never modifies SEO elements (title, meta description, canonical, og, ld+json)", () => {
    const html =
      `<head>` +
      `<title>Hi</title>` +
      `<meta name="description" content="d">` +
      `<meta property="og:title" content="og">` +
      `<link rel="canonical" href="https://ex.com/">` +
      `<link rel="alternate" hreflang="fr" href="/fr/">` +
      `<script type="application/ld+json">{"a":1}</script>` +
      `</head>`;
    const out = cleanHtml(html);
    expect(out).toContain("<title>Hi</title>");
    expect(out).toContain('name="description"');
    expect(out).toContain('property="og:title"');
    expect(out).toContain('rel="canonical"');
    expect(out).toContain('hreflang="fr"');
    expect(out).toContain('type="application/ld+json"');
    expect(out).toContain('{"a":1}');
  });

  it("is idempotent (cleanHtml(cleanHtml(x)) === cleanHtml(x))", () => {
    const html = `<div class=""><!--c-->  hello   </div>`;
    const once = cleanHtml(html);
    const twice = cleanHtml(once);
    expect(twice).toBe(once);
  });
});

describe("removeNonEssentialMeta", () => {
  it("removes default-blocklisted meta names", () => {
    const html = `<meta name="generator" content="WP"><meta name="powered-by" content="x">`;
    const out = removeNonEssentialMeta(html);
    expect(out).not.toContain('name="generator"');
    expect(out).not.toContain('name="powered-by"');
  });

  it("preserves SEO-critical meta tags even if blocklist would match", () => {
    const html =
      `<meta name="description" content="d">` +
      `<meta property="og:title" content="og">` +
      `<meta name="twitter:card" content="summary">` +
      `<meta name="viewport" content="width=device-width">` +
      `<meta charset="utf-8">`;
    // Use an aggressive blocklist that would otherwise match.
    const out = removeNonEssentialMeta(html, {
      blocklist: ["description", "og", "twitter", "viewport", "charset"],
    });
    expect(out).toContain('name="description"');
    expect(out).toContain('property="og:title"');
    expect(out).toContain('name="twitter:card"');
    expect(out).toContain('name="viewport"');
    expect(out).toContain('charset="utf-8"');
  });

  it("returns input unchanged when no meta matches blocklist", () => {
    const html = `<meta name="description" content="d">`;
    const out = removeNonEssentialMeta(html);
    expect(out).toBe(html);
  });

  it("custom blocklist overrides default", () => {
    const html = `<meta name="generator" content="WP"><meta name="custom" content="x">`;
    const out = removeNonEssentialMeta(html, { blocklist: ["custom"] });
    expect(out).toContain('name="generator"'); // not in custom blocklist
    expect(out).not.toContain('name="custom"');
  });
});
