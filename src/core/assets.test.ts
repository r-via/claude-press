import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAssets,
  downloadAssets,
  pickLargestSrcsetCandidate,
  type FetchLike,
  type AssetRef,
} from "./assets.js";
import type { CrawlerConfig } from "./config.js";

const baseConfig: CrawlerConfig = {
  concurrency: 4,
  delayMs: 0,
  userAgent: "test-agent/1.0",
  respectRobots: false,
};

const silent = (): void => {};

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "assets-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const okFetch =
  (body: Buffer | string): FetchLike =>
  async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => {
      const b = typeof body === "string" ? Buffer.from(body) : body;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  });

describe("discoverAssets", () => {
  it("extracts CSS, JS, IMG, and font references with correct types", async () => {
    await withTmpDir(async (dir) => {
      const html = `<!doctype html><html><head>
        <link rel="stylesheet" href="/style.css">
        <link rel="preload" as="font" href="/fonts/inter.woff2">
        <link rel="icon" href="/favicon.ico">
        <script src="/app.js"></script>
        <style>@font-face{font-family:x;src:url("/fonts/x.woff2") format("woff2");}</style>
      </head><body>
        <img src="/img/hero.png" srcset="/img/hero-480.png 480w, /img/hero-960.png 960w">
        <picture><source srcset="/img/hero.avif"></picture>
      </body></html>`;
      const file = join(dir, "page.html");
      await writeFile(file, html);
      const refs = await discoverAssets(file, "https://x.example/");
      const byType = (t: AssetRef["type"]): string[] =>
        refs.filter((r) => r.type === t).map((r) => r.url);
      expect(byType("css")).toContain("https://x.example/style.css");
      expect(byType("js")).toContain("https://x.example/app.js");
      expect(byType("img")).toEqual(
        expect.arrayContaining([
          "https://x.example/img/hero.png",
          // largest-variant only — the 480w sibling is skipped
          "https://x.example/img/hero-960.png",
          "https://x.example/img/hero.avif",
          "https://x.example/favicon.ico",
        ]),
      );
      expect(byType("img")).not.toContain("https://x.example/img/hero-480.png");
      expect(byType("fonts")).toEqual(
        expect.arrayContaining([
          "https://x.example/fonts/inter.woff2",
          "https://x.example/fonts/x.woff2",
        ]),
      );
    });
  });

  it("deduplicates repeated URLs", async () => {
    await withTmpDir(async (dir) => {
      const html =
        `<html><body><img src="/a.png"><img src="/a.png"><img src="/a.png"></body></html>`;
      const file = join(dir, "page.html");
      await writeFile(file, html);
      const refs = await discoverAssets(file, "https://x.example/");
      const a = refs.filter((r) => r.url === "https://x.example/a.png");
      expect(a).toHaveLength(1);
    });
  });

  it("skips data: and javascript: URLs", async () => {
    await withTmpDir(async (dir) => {
      const html = `<html><body>
        <img src="data:image/png;base64,AAA">
        <script src="javascript:void(0)"></script>
      </body></html>`;
      const file = join(dir, "page.html");
      await writeFile(file, html);
      const refs = await discoverAssets(file, "https://x.example/");
      expect(refs).toHaveLength(0);
    });
  });
});

describe("pickLargestSrcsetCandidate", () => {
  it("returns largest-width URL for w-descriptor srcset", () => {
    expect(
      pickLargestSrcsetCandidate(
        "/img/a-480.png 480w, /img/a-1024.png 1024w, /img/a-768.png 768w",
      ),
    ).toBe("/img/a-1024.png");
  });

  it("returns highest-density URL for x-descriptor srcset", () => {
    expect(
      pickLargestSrcsetCandidate("/img/a.png 1x, /img/a@2x.png 2x, /img/a@3x.png 3x"),
    ).toBe("/img/a@3x.png");
  });

  it("returns first candidate for bare-URL srcset", () => {
    expect(pickLargestSrcsetCandidate("/img/a.png, /img/b.png, /img/c.png")).toBe(
      "/img/a.png",
    );
  });

  it("returns null for empty/blank srcset", () => {
    expect(pickLargestSrcsetCandidate("")).toBeNull();
    expect(pickLargestSrcsetCandidate("   ")).toBeNull();
    expect(pickLargestSrcsetCandidate(",, ,,")).toBeNull();
  });

  it("prefers w over x when both shapes appear (w wins)", () => {
    // w-descriptor present anywhere → w-mode classification
    expect(
      pickLargestSrcsetCandidate("/a.png 1x, /b.png 800w, /c.png 400w"),
    ).toBe("/b.png");
  });

  it("emits one ref per srcset element from discoverAssets", async () => {
    await withTmpDir(async (dir) => {
      const html = `<html><body>
        <img src="/img/x.png" srcset="/img/x-480.png 480w, /img/x-960.png 960w, /img/x-1440.png 1440w">
        <picture><source srcset="/p-1x.png 1x, /p-2x.png 2x, /p-3x.png 3x"></picture>
      </body></html>`;
      const file = join(dir, "page.html");
      await writeFile(file, html);
      const refs = await discoverAssets(file, "https://x.example/");
      const imgs = refs.filter((r) => r.type === "img").map((r) => r.url);
      // src=/img/x.png + largest srcset entry (1440) + largest source (3x)
      expect(imgs).toContain("https://x.example/img/x.png");
      expect(imgs).toContain("https://x.example/img/x-1440.png");
      expect(imgs).toContain("https://x.example/p-3x.png");
      expect(imgs).not.toContain("https://x.example/img/x-480.png");
      expect(imgs).not.toContain("https://x.example/img/x-960.png");
      expect(imgs).not.toContain("https://x.example/p-1x.png");
      expect(imgs).not.toContain("https://x.example/p-2x.png");
    });
  });
});

describe("downloadAssets", () => {
  it("writes each asset to assets/<type>/<stem>-<hash><ext> and returns a manifest", async () => {
    await withTmpDir(async (dir) => {
      const refs: AssetRef[] = [
        { url: "https://x.example/style.css", type: "css" },
        { url: "https://x.example/app.js", type: "js" },
        { url: "https://x.example/img/hero.png", type: "img" },
      ];
      const bodies: Record<string, string> = {
        "https://x.example/style.css": "body{color:red}",
        "https://x.example/app.js": "console.log(1)",
        "https://x.example/img/hero.png": "PNGDATA",
      };
      const fetchImpl: FetchLike = async (url) => {
        const body = bodies[url];
        if (body === undefined) {
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        const b = Buffer.from(body);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () =>
            b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
        };
      };
      const result = await downloadAssets(refs, dir, baseConfig, {
        fetchImpl,
        log: silent,
      });
      expect(Object.keys(result.manifest)).toHaveLength(3);
      const cssRel = result.manifest["https://x.example/style.css"]!;
      expect(cssRel).toMatch(/^assets\/css\/style-[0-9a-f]{8}\.css$/);
      const jsRel = result.manifest["https://x.example/app.js"]!;
      expect(jsRel).toMatch(/^assets\/js\/app-[0-9a-f]{8}\.js$/);
      const imgRel = result.manifest["https://x.example/img/hero.png"]!;
      expect(imgRel).toMatch(/^assets\/img\/hero-[0-9a-f]{8}\.png$/);
      const cssBody = await readFile(join(dir, cssRel), "utf8");
      expect(cssBody).toBe("body{color:red}");
    });
  });

  it("fetches a duplicated URL only once", async () => {
    await withTmpDir(async (dir) => {
      let calls = 0;
      const fetchImpl: FetchLike = async () => {
        calls++;
        const b = Buffer.from("X");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () =>
            b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
        };
      };
      const refs: AssetRef[] = [
        { url: "https://x.example/a.css", type: "css" },
        { url: "https://x.example/a.css", type: "css" },
        { url: "https://x.example/a.css", type: "css" },
      ];
      const result = await downloadAssets(refs, dir, baseConfig, {
        fetchImpl,
        log: silent,
      });
      expect(calls).toBe(1);
      expect(Object.keys(result.manifest)).toHaveLength(1);
    });
  });

  it("records failed fetches without aborting the run", async () => {
    await withTmpDir(async (dir) => {
      const fetchImpl: FetchLike = async (url) => {
        if (url.endsWith("/bad.css")) {
          return {
            ok: false,
            status: 500,
            statusText: "Server Error",
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        const b = Buffer.from("ok");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () =>
            b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
        };
      };
      const refs: AssetRef[] = [
        { url: "https://x.example/good.css", type: "css" },
        { url: "https://x.example/bad.css", type: "css" },
      ];
      const result = await downloadAssets(refs, dir, baseConfig, {
        fetchImpl,
        log: silent,
      });
      expect(Object.keys(result.manifest)).toEqual(["https://x.example/good.css"]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error).toMatch(/500/);
    });
  });

  it("captures thrown errors as failures", async () => {
    await withTmpDir(async (dir) => {
      const fetchImpl: FetchLike = async () => {
        throw new Error("boom");
      };
      const refs: AssetRef[] = [{ url: "https://x.example/x.js", type: "js" }];
      const result = await downloadAssets(refs, dir, baseConfig, {
        fetchImpl,
        log: silent,
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error).toMatch(/boom/);
    });
  });

  it("generates content-hash filenames (different bodies → different filenames)", async () => {
    await withTmpDir(async (dir) => {
      const fetchImpl: FetchLike = async (url) => {
        const body = url.endsWith("a.css") ? "AAA" : "BBB";
        const b = Buffer.from(body);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () =>
            b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
        };
      };
      const refs: AssetRef[] = [
        { url: "https://x.example/a.css", type: "css" },
        { url: "https://x.example/b.css", type: "css" },
      ];
      const result = await downloadAssets(refs, dir, baseConfig, {
        fetchImpl,
        log: silent,
      });
      const files = await readdir(join(dir, "assets/css"));
      expect(files).toHaveLength(2);
      expect(new Set(files).size).toBe(2);
      void result;
    });
  });

  it("respects the per-host delay", async () => {
    await withTmpDir(async (dir) => {
      let clock = 0;
      const sleeps: number[] = [];
      const fetchImpl: FetchLike = async () => {
        clock += 1;
        const b = Buffer.from("x");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () =>
            b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
        };
      };
      const refs: AssetRef[] = [
        { url: "https://same.example/a.css", type: "css" },
        { url: "https://same.example/b.css", type: "css" },
        { url: "https://same.example/c.css", type: "css" },
      ];
      const result = await downloadAssets(
        refs,
        dir,
        { ...baseConfig, delayMs: 200 },
        {
          fetchImpl,
          now: () => clock,
          sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
          },
          log: silent,
        },
      );
      expect(Object.keys(result.manifest)).toHaveLength(3);
      expect(sleeps).toHaveLength(2);
      for (const s of sleeps) expect(s).toBeGreaterThan(0);
    });
  });
});
