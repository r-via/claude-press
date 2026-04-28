import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listOutputPages,
  selectSamples,
  computeDeltaRatio,
  runVisualDiff,
  type ScreenshotImpl,
  type PixelmatchImpl,
  type PngDecoder,
} from "./diff.js";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "diff-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writePage(outputDir: string, rel: string): Promise<void> {
  const full = join(outputDir, "pages", rel);
  await mkdir(full, { recursive: true });
  await writeFile(join(full, "index.html"), `<html><body>${rel}</body></html>`);
}

/** Fixed-sequence RNG: pulls from `seq`, wraps when exhausted. */
function fakeRng(seq: number[]): () => number {
  let i = 0;
  return () => {
    const v = seq[i % seq.length]!;
    i++;
    return v;
  };
}

/** Trivial PNG decoder that recognizes our test buffers (magic byte + len). */
const fakeDecoder: PngDecoder = (buf) => {
  // First 4 bytes: width LE uint32.  Next 4: height LE uint32.  Rest: RGBA.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  return {
    width,
    height,
    data: new Uint8Array(buf.buffer, buf.byteOffset + 8, buf.byteLength - 8),
  };
};

function makeFakePng(width: number, height: number, fill: number): Uint8Array {
  const total = width * height * 4;
  const buf = new Uint8Array(8 + total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  for (let i = 0; i < total; i++) buf[8 + i] = fill;
  return buf;
}

describe("listOutputPages", () => {
  it("lists every index.html under pages/ as a URL path", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "en/blog/a");
      await writePage(dir, "en/blog/b");
      await writePage(dir, "fr/contact");
      const pages = await listOutputPages(dir);
      expect(pages).toEqual(["/en/blog/a/", "/en/blog/b/", "/fr/contact/"]);
    });
  });

  it("returns [] when pages dir is missing", async () => {
    await withTmpDir(async (dir) => {
      expect(await listOutputPages(dir)).toEqual([]);
    });
  });
});

describe("selectSamples", () => {
  it("returns all pages when n >= count", () => {
    const pages = ["a", "b", "c"];
    const out = selectSamples(pages, 5, fakeRng([0]));
    expect(out.sort()).toEqual(["a", "b", "c"]);
  });

  it("returns exactly n pages when n < count", () => {
    const pages = ["a", "b", "c", "d", "e"];
    const out = selectSamples(pages, 2, fakeRng([0.0, 0.0]));
    expect(out).toHaveLength(2);
    // No duplicates.
    expect(new Set(out).size).toBe(2);
  });

  it("is deterministic for a given RNG sequence", () => {
    const pages = ["a", "b", "c", "d", "e"];
    const seq = [0.5, 0.5, 0.5, 0.5];
    const a = selectSamples(pages, 3, fakeRng(seq));
    const b = selectSamples(pages, 3, fakeRng(seq));
    expect(a).toEqual(b);
  });
});

describe("computeDeltaRatio", () => {
  it("returns 1 when dimensions differ", () => {
    const a = makeFakePng(2, 2, 0);
    const b = makeFakePng(3, 2, 0);
    const ratio = computeDeltaRatio(a, b, fakeDecoder, () => 0);
    expect(ratio).toBe(1);
  });

  it("returns differing/total from pixelmatch", () => {
    const a = makeFakePng(10, 10, 0); // 100 px
    const b = makeFakePng(10, 10, 0);
    const fakePm: PixelmatchImpl = (_a, _b, _o, w, h) => {
      // Pretend 25 of the 100 pixels differ.
      expect(w).toBe(10);
      expect(h).toBe(10);
      return 25;
    };
    const ratio = computeDeltaRatio(a, b, fakeDecoder, fakePm);
    expect(ratio).toBe(0.25);
  });

  it("returns 0 when both images are zero-sized", () => {
    const a = makeFakePng(0, 0, 0);
    const b = makeFakePng(0, 0, 0);
    const ratio = computeDeltaRatio(a, b, fakeDecoder, () => 0);
    expect(ratio).toBe(0);
  });
});

describe("runVisualDiff", () => {
  it("samples respect the configured count and pass when delta <= threshold", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "a");
      await writePage(dir, "b");
      await writePage(dir, "c");

      const screenshotImpl: ScreenshotImpl = {
        capture: async () => makeFakePng(10, 10, 0),
      };
      const pm: PixelmatchImpl = () => 1; // 1/100 = 1% delta
      const result = await runVisualDiff(dir, {
        samples: 2,
        threshold: 0.02,
        baseUrl: "https://example.com",
        random: fakeRng([0, 0]),
        screenshotImpl,
        pixelmatchImpl: pm,
        pngDecoder: fakeDecoder,
      });

      expect(result.entries).toHaveLength(2);
      expect(result.pass).toBe(true);
      for (const e of result.entries) {
        expect(e.deltaRatio).toBeCloseTo(0.01);
        expect(e.pass).toBe(true);
        expect(e.url.startsWith("https://example.com/")).toBe(true);
        expect(e.localUrl.startsWith("http://127.0.0.1:")).toBe(true);
      }
    });
  });

  it("fails when any page exceeds the threshold", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "a");
      await writePage(dir, "b");

      let calls = 0;
      const screenshotImpl: ScreenshotImpl = {
        capture: async () => makeFakePng(10, 10, 0),
      };
      // 1st page: 0 differing; 2nd page: 50 differing (50%) → fail.
      const pm: PixelmatchImpl = () => {
        calls++;
        return calls === 1 ? 0 : 50;
      };

      const result = await runVisualDiff(dir, {
        samples: 2,
        threshold: 0.02,
        baseUrl: "https://example.com",
        random: fakeRng([0]),
        screenshotImpl,
        pixelmatchImpl: pm,
        pngDecoder: fakeDecoder,
      });

      expect(result.pass).toBe(false);
      const failing = result.entries.filter((e) => !e.pass);
      expect(failing).toHaveLength(1);
      expect(failing[0]!.deltaRatio).toBe(0.5);
    });
  });

  it("treats screenshot errors as max delta but continues other pages", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "a");
      await writePage(dir, "b");

      let nth = 0;
      const screenshotImpl: ScreenshotImpl = {
        capture: async () => {
          nth++;
          if (nth === 1) throw new Error("Playwright unavailable: chromium not installed");
          return makeFakePng(10, 10, 0);
        },
      };
      const pm: PixelmatchImpl = () => 0;

      const result = await runVisualDiff(dir, {
        samples: 2,
        threshold: 0.05,
        baseUrl: "https://example.com",
        random: fakeRng([0]),
        screenshotImpl,
        pixelmatchImpl: pm,
        pngDecoder: fakeDecoder,
      });

      expect(result.entries).toHaveLength(2);
      // The page whose screenshot threw must be marked failing with delta=1.
      const failed = result.entries.filter((e) => !e.pass);
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0]!.deltaRatio).toBe(1);
    });
  });

  it("derives baseUrl from output sitemap.xml when omitted", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "a");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "sitemap.xml"),
        `<?xml version="1.0"?><urlset><url><loc>https://derived.example/a/</loc></url></urlset>`,
      );

      const captured: string[] = [];
      const screenshotImpl: ScreenshotImpl = {
        capture: async (url) => {
          captured.push(url);
          return makeFakePng(4, 4, 0);
        },
      };
      const result = await runVisualDiff(dir, {
        samples: 1,
        threshold: 1,
        random: fakeRng([0]),
        screenshotImpl,
        pixelmatchImpl: () => 0,
        pngDecoder: fakeDecoder,
      });
      expect(result.entries).toHaveLength(1);
      expect(captured.some((u) => u.startsWith("https://derived.example/"))).toBe(true);
    });
  });

  it("throws a descriptive error when baseUrl cannot be resolved", async () => {
    await withTmpDir(async (dir) => {
      await writePage(dir, "a");
      await expect(
        runVisualDiff(dir, {
          samples: 1,
          threshold: 0.02,
          screenshotImpl: { capture: async () => makeFakePng(2, 2, 0) },
          pixelmatchImpl: () => 0,
          pngDecoder: fakeDecoder,
        }),
      ).rejects.toThrow(/Cannot determine origin/);
    });
  });
});
