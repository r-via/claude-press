import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { purgeCss, inlineCriticalCss, purgePageCss } from "./css.js";

async function tmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "css-test-"));
}

describe("purgeCss", () => {
  it("removes rules whose selectors do not match", () => {
    const css = `.used { color: red; } .unused { color: blue; }`;
    const html = `<html><body><p class="used">x</p></body></html>`;
    const out = purgeCss(css, html);
    expect(out).toContain(".used");
    expect(out).not.toContain(".unused");
  });

  it("keeps rules whose selectors match", () => {
    const css = `h1 { font-size: 2em; } p { margin: 0; }`;
    const html = `<html><body><h1>x</h1><p>y</p></body></html>`;
    const out = purgeCss(css, html);
    expect(out).toContain("h1");
    expect(out).toContain("p ");
  });

  it("preserves at-rules verbatim", () => {
    const css = `@media (max-width: 600px) { .x { color: red; } } @font-face { font-family: F; src: url(f.woff2); } .unused { x: y; }`;
    const html = `<html><body><div></div></body></html>`;
    const out = purgeCss(css, html);
    expect(out).toContain("@media");
    expect(out).toContain("@font-face");
    expect(out).not.toContain(".unused");
  });

  it("keeps rules with at-least-one matching selector group", () => {
    const css = `.a, .b { color: red; }`;
    const html = `<html><body><p class="b">x</p></body></html>`;
    expect(purgeCss(css, html)).toContain(".a, .b");
  });

  it("strips pseudo-classes when matching", () => {
    const css = `.btn:hover { color: red; } .ghost:hover { color: blue; }`;
    const html = `<html><body><a class="btn">x</a></body></html>`;
    const out = purgeCss(css, html);
    expect(out).toContain(".btn");
    expect(out).not.toContain(".ghost");
  });
});

describe("inlineCriticalCss", () => {
  it("returns html unchanged when no stylesheets are referenced", async () => {
    const html = `<!doctype html><html><head><title>x</title></head><body><p>x</p></body></html>`;
    const dir = await tmp();
    try {
      const out = await inlineCriticalCss(html, dir);
      expect(out).toBe(html);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defers remaining stylesheets via media=print onload trick", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/css"), { recursive: true });
      await writeFile(
        resolve(dir, "assets/css/style.css"),
        `.x { color: red; } .y { color: blue; }`,
      );
      const html = `<!doctype html><html><head><link rel="stylesheet" href="assets/css/style.css"></head><body><p class="x">x</p></body></html>`;
      const out = await inlineCriticalCss(html, dir);
      // No synchronous render-blocking <link rel=stylesheet> in <head>:
      // remaining links must use media=print onload pattern (or be removed by Beasties).
      // Strip <noscript>...</noscript> blocks (their <link> is intentional
      // for users with JS disabled — not render-blocking when JS runs).
      const renderable = out.replace(/<noscript>[\s\S]*?<\/noscript>/gi, "");
      const matches = renderable.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi) ?? [];
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) {
        expect(m).toMatch(/media=["']print["']/);
        expect(m).toMatch(/onload=/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("purgePageCss", () => {
  it("rewrites referenced local CSS files in place with purged content", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/css"), { recursive: true });
      const cssPath = resolve(dir, "assets/css/style.css");
      await writeFile(cssPath, `.used { color: red; } .unused { color: blue; }`);
      const html = `<!doctype html><html><head><link rel="stylesheet" href="assets/css/style.css"></head><body><p class="used">x</p></body></html>`;
      await purgePageCss(html, dir);
      const after = await readFile(cssPath, "utf8");
      expect(after).toContain(".used");
      expect(after).not.toContain(".unused");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores remote and data URIs gracefully", async () => {
    const dir = await tmp();
    try {
      const html = `<html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body></body></html>`;
      await expect(purgePageCss(html, dir)).resolves.toBe(html);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
