import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { minifyJsAssets, deferNonEssentialScripts } from "./js.js";

async function tmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "js-test-"));
}

describe("minifyJsAssets", () => {
  it("reduces output size and overwrites file in-place", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/js"), { recursive: true });
      const path = resolve(dir, "assets/js/app.js");
      const src =
        "function helloWorld(name) { var greeting = 'hello, ' + name; return greeting; }\nhelloWorld('world');\n";
      await writeFile(path, src);
      const result = await minifyJsAssets(dir);
      expect(result.filesProcessed).toBe(1);
      expect(result.filesFailed).toBe(0);
      expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
      const after = await readFile(path, "utf8");
      expect(after.length).toBeLessThan(src.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("eliminates dead code via terser compress", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/js"), { recursive: true });
      const path = resolve(dir, "assets/js/dead.js");
      const src =
        "function used() { return 1; } if (false) { var deadVariableName = 'never_executed'; }\nused();";
      await writeFile(path, src);
      await minifyJsAssets(dir);
      const after = await readFile(path, "utf8");
      expect(after).not.toContain("deadVariableName");
      expect(after).not.toContain("never_executed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts but does not throw on syntax-error JS files", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/js"), { recursive: true });
      await writeFile(resolve(dir, "assets/js/broken.js"), "function ( { ! invalid syntax @@@");
      const result = await minifyJsAssets(dir);
      expect(result.filesFailed).toBe(1);
      expect(result.filesProcessed).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns zero-stats result when js dir is missing", async () => {
    const dir = await tmp();
    try {
      const result = await minifyJsAssets(dir);
      expect(result.filesProcessed).toBe(0);
      expect(result.bytesBefore).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("deferNonEssentialScripts", () => {
  it("adds defer to blocklisted external scripts", async () => {
    const html = `<html><head>
      <script src="https://www.google-analytics.com/analytics.js"></script>
      <script src="/assets/js/app.js"></script>
    </head><body></body></html>`;
    const out = await deferNonEssentialScripts(html);
    // Blocklisted GA script gets defer
    const gaMatch = out.match(/<script[^>]*google-analytics[^>]*>/i);
    expect(gaMatch).toBeTruthy();
    expect(gaMatch![0]).toMatch(/\bdefer\b/);
    // Non-blocklisted local script left intact
    const appMatch = out.match(/<script[^>]*\/assets\/js\/app\.js[^>]*>/i);
    expect(appMatch).toBeTruthy();
    expect(appMatch![0]).not.toMatch(/\bdefer\b/);
  });

  it("removes blocklisted scripts when strategy is remove", async () => {
    const html = `<html><head>
      <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
      <script src="/assets/js/app.js"></script>
    </head><body></body></html>`;
    const out = await deferNonEssentialScripts(html, { strategy: "remove" });
    expect(out).not.toContain("fbevents");
    expect(out).toContain("/assets/js/app.js");
  });

  it("minifies inline scripts in-place", async () => {
    // Inline-script minification preserves top-level identifiers (other
    // scripts on the page may consume them as globals) but compresses
    // whitespace and mangles local names.
    const inline =
      "function compute(arg1Name) { var localValue = arg1Name + 1; return localValue; } compute(2);";
    const html = `<html><head><script>${inline}</script></head><body></body></html>`;
    const out = await deferNonEssentialScripts(html);
    const m = out.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    expect(m).toBeTruthy();
    const body = m![1]!;
    expect(body.length).toBeLessThan(inline.length);
    // Local identifier inside `compute` should be mangled.
    expect(body).not.toContain("localValue");
    // Top-level function name is preserved (callable from outside).
    expect(body).toContain("compute");
  });

  it("leaves inline scripts intact on terser parse failure", async () => {
    const broken = "function ( { invalid @@@";
    const html = `<html><head><script>${broken}</script></head><body></body></html>`;
    const out = await deferNonEssentialScripts(html);
    expect(out).toContain(broken);
  });

  it("respects a custom blocklist", async () => {
    const html = `<html><head>
      <script src="/vendor/customtracker.js"></script>
      <script src="/assets/js/app.js"></script>
    </head><body></body></html>`;
    const out = await deferNonEssentialScripts(html, {
      blocklist: ["customtracker"],
    });
    const cm = out.match(/<script[^>]*customtracker[^>]*>/i);
    expect(cm).toBeTruthy();
    expect(cm![0]).toMatch(/\bdefer\b/);
  });
});
