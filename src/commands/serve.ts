import type { Command } from "commander";
import { resolve, join } from "node:path";
import { stat, readFile } from "node:fs/promises";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";

interface ServeOptions {
  port: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

async function tryRead(path: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return undefined;
    const buf = await readFile(path);
    // Hono needs Uint8Array<ArrayBuffer>; copy to a fresh ArrayBuffer-backed view.
    const ab = new ArrayBuffer(buf.byteLength);
    const out = new Uint8Array(ab);
    out.set(buf);
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Build the Hono app that serves an `output/` directory.  Extracted so the
 * `diff` command can mount the same routes on an ephemeral port without
 * duplicating route logic.
 */
export function createServeApp(outputDir: string): Hono {
  const app = new Hono();

  // Compress responses (gzip/deflate via Hono's built-in middleware) when
  // the client advertises support via `Accept-Encoding`. Compressible MIME
  // types only (HTML, CSS, JS, JSON, SVG, XML — handled by Hono's default
  // content-type filter); already-compressed binary assets (AVIF, WebP,
  // WOFF2, PNG, JPEG) are skipped automatically.
  // README § Commands `serve`: "applies gzip/brotli compression".
  app.use("*", compress({ threshold: 0 }));

  app.get("/sitemap.xml", async (c) => {
    const buf = await tryRead(join(outputDir, "sitemap.xml"));
    if (!buf) return c.notFound();
    return c.body(buf, 200, { "content-type": MIME[".xml"]! });
  });

  app.get("/assets/*", async (c) => {
    const rel = c.req.path.replace(/^\/assets\//, "");
    const buf = await tryRead(join(outputDir, "assets", rel));
    if (!buf) return c.notFound();
    return c.body(buf, 200, {
      "content-type": mimeFor(rel),
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  app.get("*", async (c) => {
    const rel = c.req.path.replace(/^\/+/, "");
    const candidates = [
      join(outputDir, "pages", rel, "index.html"),
      join(outputDir, "pages", rel),
    ];
    for (const path of candidates) {
      const buf = await tryRead(path);
      if (buf) {
        return c.body(buf, 200, {
          "content-type": mimeFor(path),
          "cache-control": "public, max-age=300",
        });
      }
    }
    return c.notFound();
  });

  return app;
}

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("Serve the optimized cache locally")
    .argument("<output>", "Output directory")
    .option("--port <n>", "port to listen on", "8080")
    .action(async (output: string, opts: ServeOptions) => {
      const outputDir = resolve(output);
      const port = Number(opts.port);
      const app = createServeApp(outputDir);

      console.log(`\nclaude-press — serve\n`);
      console.log(`  serving ${outputDir}`);
      console.log(`  http://localhost:${port}\n`);

      serve({ fetch: app.fetch, port });
    });
}
