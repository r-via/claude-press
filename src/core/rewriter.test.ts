import { describe, it, expect } from "vitest";
import {
  rewriteHtmlAssetUrls,
  rewriteCssUrls,
  rewriteHreflangUrls,
} from "./rewriter.js";
import type { AssetManifest } from "./assets.js";

describe("rewriteHtmlAssetUrls", () => {
  it("rewrites img src using absolute manifest match (root-relative output)", () => {
    const manifest: AssetManifest = {
      "https://ex.com/a.jpg": "assets/img/a-deadbeef.jpg",
    };
    const out = rewriteHtmlAssetUrls(
      `<img src="https://ex.com/a.jpg">`,
      "https://ex.com/p/",
      manifest,
    );
    expect(out).toContain('src="/assets/img/a-deadbeef.jpg"');
  });

  it("resolves a relative src against the page URL", () => {
    const manifest: AssetManifest = {
      "https://ex.com/css/style.css": "assets/css/style-aa11.css",
    };
    const out = rewriteHtmlAssetUrls(
      `<link rel="stylesheet" href="../../css/style.css">`,
      "https://ex.com/blog/post/",
      manifest,
    );
    expect(out).toContain('href="/assets/css/style-aa11.css"');
  });

  it("rewrites every candidate in a srcset", () => {
    const manifest: AssetManifest = {
      "https://ex.com/a-480.jpg": "assets/img/a-480-aa.jpg",
      "https://ex.com/a-960.jpg": "assets/img/a-960-bb.jpg",
    };
    const out = rewriteHtmlAssetUrls(
      `<img srcset="https://ex.com/a-480.jpg 480w, https://ex.com/a-960.jpg 960w">`,
      "https://ex.com/",
      manifest,
    );
    expect(out).toContain("/assets/img/a-480-aa.jpg 480w");
    expect(out).toContain("/assets/img/a-960-bb.jpg 960w");
  });

  it("leaves unmatched URLs intact and reports them", () => {
    const manifest: AssetManifest = {};
    const unmatched: string[] = [];
    const out = rewriteHtmlAssetUrls(
      `<img src="https://ex.com/missing.jpg">`,
      "https://ex.com/",
      manifest,
      { onUnmatched: (u) => unmatched.push(u) },
    );
    expect(out).toContain("https://ex.com/missing.jpg");
    expect(unmatched).toEqual(["https://ex.com/missing.jpg"]);
  });

  it("leaves data URIs and fragment refs untouched", () => {
    const manifest: AssetManifest = {};
    const html = `<img src="data:image/png;base64,AAAA"><a href="#top">x</a>`;
    const out = rewriteHtmlAssetUrls(html, "https://ex.com/", manifest);
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('href="#top"');
  });

  it("rewrites script, source, video, audio, and poster attributes", () => {
    const manifest: AssetManifest = {
      "https://ex.com/app.js": "assets/js/app-1.js",
      "https://ex.com/v.mp4": "assets/img/v-2.mp4",
      "https://ex.com/p.jpg": "assets/img/p-3.jpg",
      "https://ex.com/a.mp3": "assets/img/a-4.mp3",
    };
    const html = [
      `<script src="https://ex.com/app.js"></script>`,
      `<video src="https://ex.com/v.mp4" poster="https://ex.com/p.jpg"></video>`,
      `<audio src="https://ex.com/a.mp3"></audio>`,
    ].join("");
    const out = rewriteHtmlAssetUrls(html, "https://ex.com/", manifest);
    expect(out).toContain('src="/assets/js/app-1.js"');
    expect(out).toContain('src="/assets/img/v-2.mp4"');
    expect(out).toContain('poster="/assets/img/p-3.jpg"');
    expect(out).toContain('src="/assets/img/a-4.mp3"');
  });

  it("emits a path relative to the page when pageLocalPath is given", () => {
    const manifest: AssetManifest = {
      "https://ex.com/a.css": "assets/css/a-aa.css",
    };
    const out = rewriteHtmlAssetUrls(
      `<link rel="stylesheet" href="https://ex.com/a.css">`,
      "https://ex.com/en/blog/post/",
      manifest,
      { pageLocalPath: "pages/en/blog/post/index.html" },
    );
    // pages/en/blog/post/ → ../../../../assets/css/a-aa.css
    expect(out).toContain('href="../../../../assets/css/a-aa.css"');
  });
});

describe("rewriteCssUrls", () => {
  const manifest: AssetManifest = {
    "https://ex.com/fonts/f.woff2": "assets/fonts/f-aa.woff2",
    "https://ex.com/img/bg.png": "assets/img/bg-bb.png",
  };

  it("rewrites url() refs (single, double, no quotes)", () => {
    const css = [
      `@font-face { src: url(https://ex.com/fonts/f.woff2); }`,
      `.a { background: url("https://ex.com/img/bg.png"); }`,
      `.b { background: url('https://ex.com/img/bg.png'); }`,
    ].join("\n");
    const out = rewriteCssUrls(css, "https://ex.com/css/style.css", manifest);
    expect(out).toContain("url(/assets/fonts/f-aa.woff2)");
    expect(out).toContain('url("/assets/img/bg-bb.png")');
    expect(out).toContain("url('/assets/img/bg-bb.png')");
  });

  it("resolves relative url() refs against the CSS URL", () => {
    const out = rewriteCssUrls(
      `.a { background: url(../img/bg.png); }`,
      "https://ex.com/css/style.css",
      manifest,
    );
    expect(out).toContain("url(/assets/img/bg-bb.png)");
  });

  it("leaves unmatched and data: refs intact", () => {
    const unmatched: string[] = [];
    const css = `.a{background:url(https://ex.com/missing.png);} .b{background:url(data:image/png;base64,AAA);}`;
    const out = rewriteCssUrls(css, "https://ex.com/css/style.css", manifest, {
      onUnmatched: (u) => unmatched.push(u),
    });
    expect(out).toContain("https://ex.com/missing.png");
    expect(out).toContain("data:image/png;base64,AAA");
    expect(unmatched).toEqual(["https://ex.com/missing.png"]);
  });
});

describe("rewriteHreflangUrls", () => {
  it("rewrites hreflang links from origin to local base, preserving path", () => {
    const html = `<link rel="alternate" hreflang="fr" href="https://ex.com/fr/page/"><link rel="alternate" hreflang="en" href="https://ex.com/en/page/">`;
    const out = rewriteHreflangUrls(html, "https://ex.com/", "http://localhost:8080/");
    expect(out).toContain('href="http://localhost:8080/fr/page/"');
    expect(out).toContain('href="http://localhost:8080/en/page/"');
  });

  it("leaves non-hreflang links unchanged", () => {
    const html = `<a href="https://ex.com/fr/page/">link</a><link rel="canonical" href="https://ex.com/p/">`;
    const out = rewriteHreflangUrls(html, "https://ex.com/", "http://localhost:8080/");
    expect(out).toBe(html);
  });

  it("returns input unchanged when no hreflang links present", () => {
    const html = `<html><body>nothing</body></html>`;
    expect(rewriteHreflangUrls(html, "https://ex.com/", "http://localhost:8080/")).toBe(html);
  });

  it("ignores hreflang links pointing at a different origin", () => {
    const html = `<link rel="alternate" hreflang="de" href="https://other.com/de/page/">`;
    const out = rewriteHreflangUrls(html, "https://ex.com/", "http://localhost:8080/");
    expect(out).toContain('href="https://other.com/de/page/"');
  });
});
