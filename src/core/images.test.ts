import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateResponsiveImages,
  rewriteImgToPicture,
  type ImageManifest,
  type SharpInstance,
  type SharpLike,
} from "./images.js";
import type { AssetManifest } from "./assets.js";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "images-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Fake sharp transformer.  Each call yields a fresh state machine so the
 * generator's per-variant invocations are independent.  `srcWidth` is what
 * `metadata()` returns; `resize`/`toFormat` track the current operation so
 * `toBuffer()` can produce a deterministic pseudo-encoded buffer.
 */
function makeFakeSharp(srcWidth: number, srcFormat = "png"): SharpLike {
  return (input: Buffer): SharpInstance => {
    let curWidth = srcWidth;
    let curFormat = srcFormat;
    const inst: SharpInstance = {
      metadata: async () => ({ width: srcWidth, height: srcWidth, format: srcFormat }),
      resize: (opts) => {
        curWidth = opts.width;
        return inst;
      },
      toFormat: (f) => {
        curFormat = f;
        return inst;
      },
      toBuffer: async () =>
        Buffer.from(`fake|${curFormat}|${curWidth}|${input.length}`),
    };
    return inst;
  };
}

describe("generateResponsiveImages", () => {
  it("emits AVIF + WebP + fallback variants at every requested width", async () => {
    await withTmpDir(async (dir) => {
      await mkdir(join(dir, "assets/img"), { recursive: true });
      await writeFile(join(dir, "assets/img/hero-abc12345.png"), "FAKEPNG");
      const assetManifest: AssetManifest = {
        "https://x.example/hero.png": "assets/img/hero-abc12345.png",
      };
      const manifest = await generateResponsiveImages(assetManifest, dir, {
        widths: [480, 768, 1024],
        formats: ["avif", "webp"],
        sharp: makeFakeSharp(2000),
      });
      const variants = manifest["assets/img/hero-abc12345.png"]!;
      expect(variants).toBeDefined();
      // 3 widths × 3 formats (avif, webp, png fallback)
      expect(variants).toHaveLength(9);
      const widths = new Set(variants.map((v) => v.width));
      expect(widths).toEqual(new Set([480, 768, 1024]));
      const formats = new Set(variants.map((v) => v.format));
      expect(formats).toEqual(new Set(["avif", "webp", "png"]));
      for (const v of variants) {
        expect(v.path).toMatch(
          /^assets\/img\/hero-abc12345-\d+w-[0-9a-f]{8}\.(avif|webp|png)$/,
        );
      }
    });
  });

  it("skips widths larger than the source image", async () => {
    await withTmpDir(async (dir) => {
      await mkdir(join(dir, "assets/img"), { recursive: true });
      await writeFile(join(dir, "assets/img/small-deadbeef.png"), "X");
      const assetManifest: AssetManifest = {
        "https://x.example/small.png": "assets/img/small-deadbeef.png",
      };
      const manifest = await generateResponsiveImages(assetManifest, dir, {
        widths: [480, 768, 1024, 1440, 1920],
        formats: ["avif", "webp"],
        sharp: makeFakeSharp(800),
      });
      const variants = manifest["assets/img/small-deadbeef.png"]!;
      const widths = new Set(variants.map((v) => v.width));
      // 480 and 768 fit in 800; 1024+ are skipped
      expect(widths).toEqual(new Set([480, 768]));
    });
  });

  it("writes content-hashed filenames to disk", async () => {
    await withTmpDir(async (dir) => {
      await mkdir(join(dir, "assets/img"), { recursive: true });
      await writeFile(join(dir, "assets/img/h-aaaaaaaa.png"), "P");
      const manifest = await generateResponsiveImages(
        { "https://x/h.png": "assets/img/h-aaaaaaaa.png" },
        dir,
        {
          widths: [480],
          formats: ["avif"],
          sharp: makeFakeSharp(2000),
        },
      );
      const v = manifest["assets/img/h-aaaaaaaa.png"]!;
      for (const variant of v) {
        const body = await readFile(join(dir, variant.path), "utf8");
        expect(body).toContain("fake|");
      }
    });
  });

  it("skips SVG and ICO assets", async () => {
    await withTmpDir(async (dir) => {
      await mkdir(join(dir, "assets/img"), { recursive: true });
      await writeFile(join(dir, "assets/img/icon-aa.svg"), "<svg/>");
      await writeFile(join(dir, "assets/img/fav-bb.ico"), "ICO");
      const manifest = await generateResponsiveImages(
        {
          "https://x/icon.svg": "assets/img/icon-aa.svg",
          "https://x/fav.ico": "assets/img/fav-bb.ico",
        },
        dir,
        { sharp: makeFakeSharp(2000) },
      );
      expect(Object.keys(manifest)).toHaveLength(0);
    });
  });
});

describe("rewriteImgToPicture", () => {
  const manifest: ImageManifest = {
    "assets/img/hero-abc.png": [
      { width: 480, format: "avif", path: "assets/img/hero-480w-aa.avif" },
      { width: 768, format: "avif", path: "assets/img/hero-768w-bb.avif" },
      { width: 480, format: "webp", path: "assets/img/hero-480w-cc.webp" },
      { width: 768, format: "webp", path: "assets/img/hero-768w-dd.webp" },
      { width: 480, format: "png", path: "assets/img/hero-480w-ee.png" },
      { width: 768, format: "png", path: "assets/img/hero-768w-ff.png" },
    ],
  };

  it("wraps matched <img> in <picture> with AVIF + WebP <source> tags and a fallback", () => {
    const html = `<html><body><img src="assets/img/hero-abc.png" alt="Hero" class="lead" id="h1"></body></html>`;
    const out = rewriteImgToPicture(html, manifest);
    expect(out).toContain("<picture>");
    expect(out).toContain('<source type="image/avif" srcset="/assets/img/hero-480w-aa.avif 480w, /assets/img/hero-768w-bb.avif 768w">');
    expect(out).toContain('<source type="image/webp"');
    // Fallback is the largest png, with original attributes preserved
    expect(out).toMatch(/<img src="\/assets\/img\/hero-768w-ff\.png"[^>]*alt="Hero"[^>]*class="lead"[^>]*id="h1"/);
  });

  it("preserves original attributes (alt, class, id) on the fallback img", () => {
    const html = `<img src="assets/img/hero-abc.png" alt="A" class="b" id="c" loading="lazy">`;
    const out = rewriteImgToPicture(html, manifest);
    expect(out).toContain('alt="A"');
    expect(out).toContain('class="b"');
    expect(out).toContain('id="c"');
    expect(out).toContain('loading="lazy"');
  });

  it("leaves <img> unchanged when src has no manifest entry", () => {
    const html = `<img src="assets/img/unknown.png" alt="x">`;
    const out = rewriteImgToPicture(html, manifest);
    expect(out).not.toContain("<picture>");
    expect(out).toContain('<img src="assets/img/unknown.png"');
  });
});
