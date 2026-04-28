import { describe, it, expect } from "vitest";
import { injectLcpPreload, injectFontPreloads } from "./preload.js";

describe("injectLcpPreload", () => {
  it("injects a preload for the first <img> inside <main>", () => {
    const html = `<!doctype html><html><head><title>t</title></head><body><main><img src="/hero.jpg" alt="h"></main></body></html>`;
    const out = injectLcpPreload(html);
    expect(out).toContain(
      `<link rel="preload" as="image" href="/hero.jpg" fetchpriority="high">`,
    );
    // injected inside <head>
    expect(out.indexOf("rel=\"preload\"")).toBeLessThan(out.indexOf("</head>"));
  });

  it("prefers <main> over earlier <body> images when both exist", () => {
    const html = `<!doctype html><html><head></head><body><img src="/before.jpg"><main><img src="/main.jpg"></main></body></html>`;
    const out = injectLcpPreload(html);
    // main wins (heuristic prefers main/article)
    expect(out).toContain('href="/main.jpg"');
    expect(out).not.toContain('href="/before.jpg"');
  });

  it("falls back to first <img> in <body> when no main/article", () => {
    const html = `<!doctype html><html><head></head><body><div><img src="/first.jpg"></div><img src="/second.jpg"></body></html>`;
    const out = injectLcpPreload(html);
    expect(out).toContain('href="/first.jpg"');
  });

  it("selects the highest-width srcset entry from a <picture>", () => {
    const html = `<!doctype html><html><head></head><body><main><picture>
      <source type="image/avif" srcset="/h-480.avif 480w, /h-1920.avif 1920w, /h-1024.avif 1024w">
      <img src="/h.jpg">
    </picture></main></body></html>`;
    const out = injectLcpPreload(html);
    expect(out).toContain('href="/h-1920.avif"');
    expect(out).toContain('fetchpriority="high"');
  });

  it("is a no-op when no <img> or <picture> exists", () => {
    const html = `<!doctype html><html><head></head><body><p>just text</p></body></html>`;
    const out = injectLcpPreload(html);
    expect(out).not.toContain('rel="preload"');
  });

  it("is idempotent when a matching preload already exists", () => {
    const html = `<!doctype html><html><head><link rel="preload" as="image" href="/hero.jpg"></head><body><main><img src="/hero.jpg"></main></body></html>`;
    const out = injectLcpPreload(html);
    // should still have exactly one preload for /hero.jpg
    const matches = out.match(/rel="preload"[^>]*href="\/hero\.jpg"/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("injectFontPreloads", () => {
  it("injects a font preload for each WOFF2 url found in @font-face", () => {
    const html = `<!doctype html><html><head><style>
      @font-face { font-family: A; src: url('/fonts/a.woff2') format('woff2'); }
      @font-face { font-family: B; src: url("/fonts/b.woff2") format('woff2'); }
    </style></head><body></body></html>`;
    const out = injectFontPreloads(html);
    expect(out).toMatch(
      /<link rel="preload" as="font" type="font\/woff2" href="\/fonts\/a\.woff2" crossorigin(?:="")?>/,
    );
    expect(out).toMatch(
      /<link rel="preload" as="font" type="font\/woff2" href="\/fonts\/b\.woff2" crossorigin(?:="")?>/,
    );
  });

  it("dedupes when the same WOFF2 url appears twice", () => {
    const html = `<!doctype html><html><head><style>
      @font-face { font-family: A; src: url('/fonts/a.woff2'); }
      @font-face { font-family: B; src: url('/fonts/a.woff2'); }
    </style></head><body></body></html>`;
    const out = injectFontPreloads(html);
    const matches = out.match(/href="\/fonts\/a\.woff2"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("is a no-op when no @font-face / WOFF2 urls are present", () => {
    const html = `<!doctype html><html><head><style>body{color:red}</style></head><body></body></html>`;
    const out = injectFontPreloads(html);
    expect(out).not.toContain('rel="preload"');
  });

  it("skips fonts already declared as preload", () => {
    const html = `<!doctype html><html><head>
      <link rel="preload" as="font" type="font/woff2" href="/fonts/a.woff2" crossorigin>
      <style>@font-face { font-family: A; src: url('/fonts/a.woff2'); }</style>
    </head><body></body></html>`;
    const out = injectFontPreloads(html);
    const matches = out.match(/href="\/fonts\/a\.woff2"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("ignores non-WOFF2 url(...) references", () => {
    const html = `<!doctype html><html><head><style>
      @font-face { font-family: A; src: url('/fonts/a.ttf') format('truetype'); }
    </style></head><body></body></html>`;
    const out = injectFontPreloads(html);
    expect(out).not.toContain('rel="preload"');
  });

  it("ignores url() references outside @font-face blocks", () => {
    const html = `<!doctype html><html><head><style>
      .bg { background: url('/fonts/decoy.woff2'); }
    </style></head><body></body></html>`;
    const out = injectFontPreloads(html);
    expect(out).not.toContain('rel="preload"');
  });
});
