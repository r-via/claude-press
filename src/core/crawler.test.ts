import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadPages,
  urlToLocalPath,
  fetchRobotsTxt,
  filterAllowedUrls,
  type FetchLike,
} from "./crawler.js";
import type { CrawlerConfig } from "./config.js";

const baseConfig: CrawlerConfig = {
  concurrency: 4,
  delayMs: 0,
  userAgent: "test-agent/1.0",
  respectRobots: false,
};

const okFetch =
  (body: string): FetchLike =>
  async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => body,
  });

const silent = (): void => {};

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "crawler-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("urlToLocalPath", () => {
  it("maps directory-style URL to <output>/pages/<path>/index.html", () => {
    const p = urlToLocalPath("/out", "https://x.example/en/blog/post/");
    expect(p).toBe("/out/pages/en/blog/post/index.html");
  });

  it("maps root URL to <output>/pages/index.html", () => {
    expect(urlToLocalPath("/out", "https://x.example/")).toBe("/out/pages/index.html");
  });

  it("appends index.html to extensionless paths", () => {
    expect(urlToLocalPath("/out", "https://x.example/about")).toBe(
      "/out/pages/about/index.html",
    );
  });

  it("preserves explicit file extensions", () => {
    expect(urlToLocalPath("/out", "https://x.example/feed.xml")).toBe(
      "/out/pages/feed.xml",
    );
  });
});

describe("downloadPages — path mapping & manifest", () => {
  it("writes each page to its mapped local path and returns a manifest", async () => {
    await withTmpDir(async (dir) => {
      const urls = ["https://x.example/", "https://x.example/about/"];
      const result = await downloadPages(urls, dir, baseConfig, {
        fetchImpl: okFetch("<html>hi</html>"),
        log: silent,
      });
      expect(result.manifest).toHaveLength(2);
      expect(result.failures).toHaveLength(0);
      const home = await readFile(join(dir, "pages/index.html"), "utf8");
      const about = await readFile(join(dir, "pages/about/index.html"), "utf8");
      expect(home).toBe("<html>hi</html>");
      expect(about).toBe("<html>hi</html>");
      expect(result.manifest[0]).toEqual({
        url: "https://x.example/",
        localPath: join(dir, "pages/index.html"),
      });
    });
  });
});

describe("downloadPages — concurrency limiting", () => {
  it("never exceeds CrawlerConfig.concurrency simultaneous fetches", async () => {
    await withTmpDir(async (dir) => {
      let active = 0;
      let peak = 0;
      const slowFetch: FetchLike = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { ok: true, status: 200, statusText: "OK", text: async () => "x" };
      };
      // 10 distinct hosts so per-host serialization isn't the bottleneck.
      const urls = Array.from({ length: 10 }, (_, i) => `https://h${i}.example/p`);
      const result = await downloadPages(
        urls,
        dir,
        { ...baseConfig, concurrency: 3 },
        { fetchImpl: slowFetch, log: silent },
      );
      expect(result.manifest).toHaveLength(10);
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(1);
    });
  });
});

describe("downloadPages — per-host delay enforcement", () => {
  it("waits at least delayMs between requests to the same host", async () => {
    await withTmpDir(async (dir) => {
      let clock = 1000;
      const sleepCalls: number[] = [];
      const fakeNow = (): number => clock;
      const fakeSleep = async (ms: number): Promise<void> => {
        sleepCalls.push(ms);
        clock += ms;
      };
      const fetchImpl: FetchLike = async () => {
        clock += 1; // each fetch "takes" 1ms of fake time
        return { ok: true, status: 200, statusText: "OK", text: async () => "x" };
      };
      const urls = [
        "https://same.example/a",
        "https://same.example/b",
        "https://same.example/c",
      ];
      const result = await downloadPages(
        urls,
        dir,
        { ...baseConfig, delayMs: 200, concurrency: 4 },
        { fetchImpl, now: fakeNow, sleep: fakeSleep, log: silent },
      );
      expect(result.manifest).toHaveLength(3);
      // First request: no prior timestamp → no sleep.
      // Second & third: must each sleep ~delayMs minus elapsed (≈199 ms).
      expect(sleepCalls.length).toBe(2);
      for (const ms of sleepCalls) expect(ms).toBeGreaterThan(0);
    });
  });

  it("does not delay across distinct hosts", async () => {
    await withTmpDir(async (dir) => {
      const sleepCalls: number[] = [];
      let clock = 0;
      const result = await downloadPages(
        ["https://a.example/p", "https://b.example/p"],
        dir,
        { ...baseConfig, delayMs: 500, concurrency: 4 },
        {
          fetchImpl: okFetch("x"),
          now: () => clock,
          sleep: async (ms) => {
            sleepCalls.push(ms);
            clock += ms;
          },
          log: silent,
        },
      );
      expect(result.manifest).toHaveLength(2);
      expect(sleepCalls).toHaveLength(0);
    });
  });
});

describe("downloadPages — error handling", () => {
  it("records failed fetches without aborting the run", async () => {
    await withTmpDir(async (dir) => {
      const fetchImpl: FetchLike = async (url) => {
        if (url.endsWith("/bad")) {
          return {
            ok: false,
            status: 500,
            statusText: "Server Error",
            text: async () => "",
          };
        }
        return { ok: true, status: 200, statusText: "OK", text: async () => "ok" };
      };
      const result = await downloadPages(
        ["https://x.example/good", "https://x.example/bad"],
        dir,
        baseConfig,
        { fetchImpl, log: silent },
      );
      expect(result.manifest).toHaveLength(1);
      expect(result.manifest[0]?.url).toBe("https://x.example/good");
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.url).toBe("https://x.example/bad");
      expect(result.failures[0]?.error).toMatch(/500/);
    });
  });

  it("captures thrown errors as failures", async () => {
    await withTmpDir(async (dir) => {
      const fetchImpl: FetchLike = async () => {
        throw new Error("network down");
      };
      const result = await downloadPages(
        ["https://x.example/p"],
        dir,
        baseConfig,
        { fetchImpl, log: silent },
      );
      expect(result.manifest).toHaveLength(0);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error).toMatch(/network down/);
    });
  });
});

describe("fetchRobotsTxt", () => {
  it("returns body on 200", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "User-agent: *\nDisallow: /private/",
    });
    const body = await fetchRobotsTxt("https://x.example", "ua/1", fetchImpl);
    expect(body).toContain("Disallow");
  });

  it("returns null on 404", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "",
    });
    const body = await fetchRobotsTxt("https://x.example", "ua/1", fetchImpl);
    expect(body).toBeNull();
  });

  it("returns null on network error", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const body = await fetchRobotsTxt("https://x.example", "ua/1", fetchImpl);
    expect(body).toBeNull();
  });
});

describe("filterAllowedUrls", () => {
  const robotsTxt = `User-agent: *
Disallow: /private/
Disallow: /admin
`;

  it("drops URLs disallowed for the user-agent", () => {
    const urls = [
      "https://x.example/",
      "https://x.example/private/secret",
      "https://x.example/blog/",
      "https://x.example/admin",
    ];
    const allowed = filterAllowedUrls(urls, robotsTxt, "claude-press/1.0");
    expect(allowed).toEqual([
      "https://x.example/",
      "https://x.example/blog/",
    ]);
  });

  it("returns all URLs unchanged when robots.txt is empty", () => {
    const urls = ["https://x.example/", "https://x.example/anywhere"];
    const allowed = filterAllowedUrls(urls, "", "ua");
    expect(allowed).toEqual(urls);
  });
});

describe("downloadPages — robots.txt enforcement", () => {
  it("skips URLs disallowed by robots.txt when respectRobots is true", async () => {
    await withTmpDir(async (dir) => {
      const seen: string[] = [];
      const fetchImpl: FetchLike = async (url) => {
        seen.push(url);
        if (url.endsWith("/robots.txt")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => "User-agent: *\nDisallow: /private/\n",
          };
        }
        return { ok: true, status: 200, statusText: "OK", text: async () => "ok" };
      };
      const urls = [
        "https://x.example/public/",
        "https://x.example/private/secret/",
      ];
      const result = await downloadPages(
        urls,
        dir,
        { ...baseConfig, respectRobots: true },
        { fetchImpl, log: silent },
      );
      expect(result.manifest).toHaveLength(1);
      expect(result.manifest[0]?.url).toBe("https://x.example/public/");
      expect(seen).toContain("https://x.example/robots.txt");
      expect(seen).not.toContain("https://x.example/private/secret/");
    });
  });

  it("crawls every URL and never fetches robots.txt when respectRobots is false", async () => {
    await withTmpDir(async (dir) => {
      const seen: string[] = [];
      const fetchImpl: FetchLike = async (url) => {
        seen.push(url);
        return { ok: true, status: 200, statusText: "OK", text: async () => "ok" };
      };
      const result = await downloadPages(
        ["https://x.example/", "https://x.example/private/secret/"],
        dir,
        { ...baseConfig, respectRobots: false },
        { fetchImpl, log: silent },
      );
      expect(result.manifest).toHaveLength(2);
      expect(seen.some((u) => u.endsWith("/robots.txt"))).toBe(false);
    });
  });

  it("falls back to allow-all when robots.txt fetch fails", async () => {
    await withTmpDir(async (dir) => {
      const fetchImpl: FetchLike = async (url) => {
        if (url.endsWith("/robots.txt")) {
          return { ok: false, status: 500, statusText: "Server Error", text: async () => "" };
        }
        return { ok: true, status: 200, statusText: "OK", text: async () => "ok" };
      };
      const result = await downloadPages(
        ["https://x.example/a/", "https://x.example/b/"],
        dir,
        { ...baseConfig, respectRobots: true },
        { fetchImpl, log: silent },
      );
      expect(result.manifest).toHaveLength(2);
    });
  });
});
