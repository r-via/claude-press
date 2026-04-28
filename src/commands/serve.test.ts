/**
 * Tests for `serve` command's compression middleware (US-018).
 *
 * The Hono app returned by `createServeApp()` must apply gzip/deflate
 * compression to compressible MIME types when the client advertises
 * support via the `Accept-Encoding` header. Already-compressed binary
 * assets (AVIF, WebP, WOFF2, …) are skipped automatically by the
 * middleware's content-type filter.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gunzipSync, inflateSync } from "node:zlib";
import { createServeApp } from "./serve.js";

async function tmp(): Promise<string> {
  return await mkdtemp(resolve(tmpdir(), "serve-test-"));
}

async function seedHtmlPage(dir: string, body: string): Promise<void> {
  await mkdir(resolve(dir, "pages"), { recursive: true });
  await writeFile(resolve(dir, "pages", "index.html"), body);
}

describe("createServeApp — compression", () => {
  it("compresses HTML responses when client advertises gzip", async () => {
    const dir = await tmp();
    try {
      const body = "<!doctype html><html><body>" + "hello world ".repeat(200) + "</body></html>";
      await seedHtmlPage(dir, body);
      const app = createServeApp(dir);

      const res = await app.request("/", {
        headers: { "Accept-Encoding": "br, gzip" },
      });

      expect(res.status).toBe(200);
      const enc = res.headers.get("Content-Encoding");
      expect(enc === "gzip" || enc === "deflate" || enc === "br").toBe(true);

      const buf = Buffer.from(await res.arrayBuffer());
      let decoded: Buffer;
      if (enc === "gzip") decoded = gunzipSync(buf);
      else if (enc === "deflate") decoded = inflateSync(buf);
      else decoded = buf;
      expect(decoded.toString("utf8")).toBe(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns uncompressed responses when no Accept-Encoding is sent", async () => {
    const dir = await tmp();
    try {
      const body = "<!doctype html><html><body>plain</body></html>";
      await seedHtmlPage(dir, body);
      const app = createServeApp(dir);

      const res = await app.request("/");

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBeNull();
      const text = await res.text();
      expect(text).toBe(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compresses CSS responses from /assets/", async () => {
    const dir = await tmp();
    try {
      await mkdir(resolve(dir, "assets", "css"), { recursive: true });
      const css = ".a{color:red}".repeat(100);
      await writeFile(resolve(dir, "assets", "css", "style.css"), css);
      const app = createServeApp(dir);

      const res = await app.request("/assets/css/style.css", {
        headers: { "Accept-Encoding": "gzip" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBe("gzip");
      const buf = Buffer.from(await res.arrayBuffer());
      expect(gunzipSync(buf).toString("utf8")).toBe(css);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
