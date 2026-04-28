import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterPages } from "./clustering.js";
import { synthesizeTemplates, type SynthesizeGenerator } from "./templates.js";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "templates-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const blogPost = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head>` +
  `<body><article class="post"><h1>${title}</h1><p>${body}</p></article></body></html>`;

const fakeTemplate = `<!doctype html><html><head><title>{{title}}</title></head>
<body><article class="post"><h1>{{title}}</h1><p>{{body}}</p></article></body></html>`;

describe("synthesizeTemplates", () => {
  it("writes one template per non-empty cluster and updates _manifest.json", async () => {
    await withTmpDir(async (dir) => {
      const pagesDir = join(dir, "pages");
      await mkdir(pagesDir, { recursive: true });
      const p1 = join(pagesDir, "a.html");
      const p2 = join(pagesDir, "b.html");
      await writeFile(p1, blogPost("A", "x"));
      await writeFile(p2, blogPost("B", "y"));

      const clusters = await clusterPages([p1, p2], dir);
      expect(clusters).toHaveLength(1);

      const calls: Array<{ prompt: string; system: string }> = [];
      const fakeGen: SynthesizeGenerator = async (prompt, system) => {
        calls.push({ prompt, system });
        return fakeTemplate;
      };

      const lib = await synthesizeTemplates(clusters, dir, { generate: fakeGen });

      expect(calls).toHaveLength(1);
      expect(lib.templates).toHaveLength(1);
      expect(lib.templates[0].clusterId).toBe("cluster-0");
      expect(lib.templates[0].file).toBe("cluster-0.html");
      expect(lib.templates[0].slots.sort()).toEqual(["body", "title"]);
      expect(lib.templates[0].pages.sort()).toEqual([p1, p2].sort());

      const written = await readFile(join(dir, "templates", "cluster-0.html"), "utf8");
      expect(written).toContain("{{title}}");
      expect(written).toContain("{{body}}");

      const manifest = JSON.parse(
        await readFile(join(dir, "templates", "_manifest.json"), "utf8"),
      );
      expect(manifest.templates).toHaveLength(1);
      expect(manifest.templates[0].clusterId).toBe("cluster-0");
      expect(manifest.templates[0].slots).toEqual(["body", "title"]);
    });
  });

  it("skips clusters with zero pages", async () => {
    await withTmpDir(async (dir) => {
      await mkdir(join(dir, "templates"), { recursive: true });
      const empty = [{ id: "cluster-0", fingerprint: "deadbeefcafe", pages: [] }];
      const fakeGen: SynthesizeGenerator = async () => {
        throw new Error("generator must not be called for empty clusters");
      };
      const lib = await synthesizeTemplates(empty, dir, { generate: fakeGen });
      expect(lib.templates).toHaveLength(0);
    });
  });

  it("strips markdown fences from LLM output", async () => {
    await withTmpDir(async (dir) => {
      const pagesDir = join(dir, "pages");
      await mkdir(pagesDir, { recursive: true });
      const p = join(pagesDir, "p.html");
      await writeFile(p, blogPost("X", "y"));
      const clusters = await clusterPages([p], dir);
      const fakeGen: SynthesizeGenerator = async () =>
        "```html\n" + fakeTemplate + "\n```";
      const lib = await synthesizeTemplates(clusters, dir, { generate: fakeGen });
      const written = await readFile(join(dir, "templates", lib.templates[0].file), "utf8");
      expect(written.startsWith("```")).toBe(false);
      expect(written).toContain("{{title}}");
    });
  });

  it("rejects templates that contain no slot placeholders", async () => {
    await withTmpDir(async (dir) => {
      const pagesDir = join(dir, "pages");
      await mkdir(pagesDir, { recursive: true });
      const p = join(pagesDir, "p.html");
      await writeFile(p, blogPost("X", "y"));
      const clusters = await clusterPages([p], dir);
      const fakeGen: SynthesizeGenerator = async () => "<html><body>static</body></html>";
      await expect(
        synthesizeTemplates(clusters, dir, { generate: fakeGen }),
      ).rejects.toThrow(/no \{\{slot\}\} placeholders/);
    });
  });
});
