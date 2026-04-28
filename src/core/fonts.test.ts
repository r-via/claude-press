import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  subsetFonts,
  injectFontDisplaySwap,
  type SubsetImpl,
} from "./fonts.js";

async function tmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "fonts-test-"));
}

// A deterministic fake subsetter: returns a buffer whose bytes encode the
// glyph subset text, so tests can assert (a) it was called per font and
// (b) the output is smaller than the original when the glyph set is a
// proper subset of the original.  Real subset-font/wasm is too heavy for
// unit tests.
const fakeSubset: SubsetImpl = async (font, text) => {
  // Pretend each character of `text` consumes one byte; real fonts shrink
  // proportionally to glyph count, so this is a faithful enough stand-in.
  const header = Buffer.from("WOFF2");
  const glyphs = Buffer.from(text, "utf8");
  // Echo a tiny suffix so that two different subset texts produce two
  // different sized outputs — useful if a future test needs that property.
  return Buffer.concat([header, glyphs, Buffer.from([font.length & 0xff])]);
};

describe("subsetFonts", () => {
  it("subsets every font under assets/fonts/ and reports byte savings", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/fonts"), { recursive: true });
      await mkdir(resolve(dir, "pages"), { recursive: true });
      // Fake font binaries — large enough that fakeSubset's output is smaller.
      const big = Buffer.alloc(2048, 0xab);
      await writeFile(resolve(dir, "assets/fonts/main.woff2"), big);
      await writeFile(resolve(dir, "assets/fonts/extra.ttf"), big);
      await writeFile(
        resolve(dir, "pages/index.html"),
        "<html><body><p>Hello world</p></body></html>",
      );

      const result = await subsetFonts(dir, {}, { subsetImpl: fakeSubset });
      expect(result.fontsProcessed).toBe(2);
      expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
      expect(result.perFont).toHaveLength(2);
      // Output file is now the (smaller) WOFF2 buffer.
      const out = await readFile(resolve(dir, "assets/fonts/main.woff2"));
      expect(out.length).toBeLessThan(big.length);
      expect(out.subarray(0, 5).toString()).toBe("WOFF2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("converts non-WOFF2 fonts to WOFF2 in-place", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/fonts"), { recursive: true });
      await mkdir(resolve(dir, "pages"), { recursive: true });
      const big = Buffer.alloc(1024, 0xcd);
      await writeFile(resolve(dir, "assets/fonts/legacy.ttf"), big);
      await writeFile(
        resolve(dir, "pages/x.html"),
        "<html><body>abc</body></html>",
      );
      let receivedFormat = "";
      const spy: SubsetImpl = async (font, text, opts) => {
        receivedFormat = opts.targetFormat;
        return fakeSubset(font, text, opts);
      };
      const result = await subsetFonts(dir, {}, { subsetImpl: spy });
      expect(receivedFormat).toBe("woff2");
      expect(result.fontsProcessed).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records an error and keeps original on subset failure", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/fonts"), { recursive: true });
      await mkdir(resolve(dir, "pages"), { recursive: true });
      const orig = Buffer.from("ORIGINAL_FONT_BYTES");
      await writeFile(resolve(dir, "assets/fonts/broken.woff"), orig);
      await writeFile(
        resolve(dir, "pages/x.html"),
        "<html><body>x</body></html>",
      );
      const failing: SubsetImpl = async () => {
        throw new Error("corrupt font");
      };
      const result = await subsetFonts(dir, {}, { subsetImpl: failing });
      expect(result.fontsProcessed).toBe(0);
      expect(result.perFont).toHaveLength(1);
      expect(result.perFont[0].error).toMatch(/corrupt font/);
      // Original is left intact.
      const after = await readFile(resolve(dir, "assets/fonts/broken.woff"));
      expect(after.toString()).toBe("ORIGINAL_FONT_BYTES");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty report when assets/fonts/ does not exist", async () => {
    const dir = await tmp();
    try {
      const result = await subsetFonts(dir, {}, { subsetImpl: fakeSubset });
      expect(result.fontsProcessed).toBe(0);
      expect(result.bytesBefore).toBe(0);
      expect(result.perFont).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("collects glyphs from all output pages (union)", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets/fonts"), { recursive: true });
      await mkdir(resolve(dir, "pages/sub"), { recursive: true });
      const font = Buffer.alloc(512, 0x01);
      await writeFile(resolve(dir, "assets/fonts/f.woff2"), font);
      await writeFile(
        resolve(dir, "pages/index.html"),
        "<html><body>ABC</body></html>",
      );
      await writeFile(
        resolve(dir, "pages/sub/x.html"),
        "<html><body>XYZ</body></html>",
      );
      let capturedText = "";
      const spy: SubsetImpl = async (f, text, opts) => {
        capturedText = text;
        return fakeSubset(f, text, opts);
      };
      await subsetFonts(dir, {}, { subsetImpl: spy });
      for (const ch of "ABCXYZ") expect(capturedText).toContain(ch);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("injectFontDisplaySwap", () => {
  it("adds font-display: swap to a @font-face block that lacks it", () => {
    const css = `@font-face { font-family: "X"; src: url("x.woff2") format("woff2"); }`;
    const out = injectFontDisplaySwap(css);
    expect(out).toContain("font-display: swap");
  });

  it("replaces an existing font-display value", () => {
    const css = `@font-face { font-family: "X"; font-display: block; src: url("x.woff2"); }`;
    const out = injectFontDisplaySwap(css);
    expect(out).toContain("font-display: swap");
    expect(out).not.toContain("font-display: block");
  });

  it("leaves CSS without @font-face unchanged", () => {
    const css = `body { color: red; } .foo { font-family: sans-serif; }`;
    expect(injectFontDisplaySwap(css)).toBe(css);
  });

  it("processes multiple @font-face blocks", () => {
    const css =
      `@font-face { font-family: "A"; src: url("a.woff2"); }\n` +
      `body { font-family: "A"; }\n` +
      `@font-face { font-family: "B"; font-display: optional; src: url("b.woff2"); }`;
    const out = injectFontDisplaySwap(css);
    const matches = out.match(/font-display:\s*swap/g) ?? [];
    expect(matches.length).toBe(2);
    expect(out).not.toContain("font-display: optional");
  });
});
