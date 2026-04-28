import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import sharpDefault from "sharp";
import type { AssetManifest } from "./assets.js";

export interface ImageVariant {
  /** Pixel width of the variant. */
  width: number;
  /** Output format (e.g. "avif", "webp", "png", "jpeg"). */
  format: string;
  /** Path relative to outputDir, e.g. `assets/img/hero-480w-a1b2c3.avif`. */
  path: string;
}

/** Maps each original local image path → array of generated variant descriptors. */
export interface ImageManifest {
  [originalLocalPath: string]: ImageVariant[];
}

export interface SharpInstance {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
  resize(opts: { width: number }): SharpInstance;
  toFormat(format: string): SharpInstance;
  toBuffer(): Promise<Buffer>;
}

export type SharpLike = (input: Buffer) => SharpInstance;

export interface ImagePipelineConfig {
  /** Target widths (default: 480, 768, 1024, 1440, 1920). Widths exceeding the source are skipped. */
  widths?: number[];
  /** Modern formats to emit alongside the original-format fallback (default: avif, webp). */
  formats?: string[];
  /** Concurrent sharp invocations (default: 4). */
  concurrency?: number;
  /** Injection seam for tests; defaults to the real sharp module. */
  sharp?: SharpLike;
  log?: (msg: string) => void;
}

const DEFAULT_WIDTHS = [480, 768, 1024, 1440, 1920];
const DEFAULT_FORMATS = ["avif", "webp"];
const SKIP_EXTS = new Set([".svg", ".ico"]);
const RASTER_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
]);

function normalizeFormat(raw: string | undefined, fallbackExt: string): string {
  const v = (raw ?? fallbackExt.replace(/^\./, "")).toLowerCase();
  if (v === "jpg") return "jpeg";
  return v || "jpeg";
}

function isProcessable(localPath: string): boolean {
  const ext = extname(localPath).toLowerCase();
  if (SKIP_EXTS.has(ext)) return false;
  return RASTER_EXTS.has(ext);
}

/**
 * Read every raster image referenced by `assetManifest`, generate AVIF/WebP +
 * original-format variants at the configured widths via `sharp`, and write
 * each variant to `<outputDir>/assets/img/<stem>-<width>w-<hash>.<ext>`.
 *
 * Returns a manifest mapping each source local path → its variants.
 * SVG/ICO are skipped silently.  Variant generation runs with bounded
 * concurrency.
 */
export async function generateResponsiveImages(
  assetManifest: AssetManifest,
  outputDir: string,
  config: ImagePipelineConfig = {},
): Promise<ImageManifest> {
  const widths = (config.widths ?? DEFAULT_WIDTHS).slice().sort((a, b) => a - b);
  const formats = config.formats ?? DEFAULT_FORMATS;
  const concurrency = Math.max(1, config.concurrency ?? 4);
  const sharpFn = config.sharp ?? (sharpDefault as unknown as SharpLike);
  const log = config.log ?? ((): void => {});

  const result: ImageManifest = {};
  const targets: string[] = [];
  for (const local of Object.values(assetManifest)) {
    if (!local.startsWith("assets/img/")) continue;
    if (!isProcessable(local)) continue;
    if (!targets.includes(local)) targets.push(local);
  }

  let cursor = 0;
  const processOne = async (localPath: string): Promise<void> => {
    const absSrc = resolve(outputDir, localPath);
    let buf: Buffer;
    try {
      buf = await readFile(absSrc);
    } catch (err) {
      log(`! cannot read ${localPath}: ${(err as Error).message}`);
      return;
    }

    let meta: { width?: number; format?: string };
    try {
      meta = await sharpFn(buf).metadata();
    } catch (err) {
      log(`! metadata failed for ${localPath}: ${(err as Error).message}`);
      return;
    }
    const srcWidth = meta.width ?? Number.POSITIVE_INFINITY;
    const ext = extname(localPath);
    const fallbackFormat = normalizeFormat(meta.format, ext);

    let targetWidths = widths.filter((w) => w <= srcWidth);
    if (targetWidths.length === 0 && Number.isFinite(srcWidth)) {
      targetWidths = [srcWidth as number];
    }
    if (targetWidths.length === 0) targetWidths = [...widths];

    const allFormats = Array.from(new Set([...formats, fallbackFormat]));
    const stem = basename(localPath, ext);

    const variants: ImageVariant[] = [];
    for (const w of targetWidths) {
      for (const fmt of allFormats) {
        let outBuf: Buffer;
        try {
          outBuf = await sharpFn(buf).resize({ width: w }).toFormat(fmt).toBuffer();
        } catch (err) {
          log(`! variant ${w}w ${fmt} failed for ${localPath}: ${(err as Error).message}`);
          continue;
        }
        const hash = createHash("sha256").update(outBuf).digest("hex").slice(0, 8);
        const outRel = `assets/img/${stem}-${w}w-${hash}.${fmt}`;
        const outAbs = resolve(outputDir, outRel);
        await mkdir(dirname(outAbs), { recursive: true });
        await writeFile(outAbs, outBuf);
        variants.push({ width: w, format: fmt, path: outRel });
      }
    }
    if (variants.length > 0) result[localPath] = variants;
  };

  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const i = cursor++;
      await processOne(targets[i]!);
    }
  };
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return result;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Rewrite every `<img>` whose `src` matches an entry in `imageManifest` into a
 * `<picture>` element containing AVIF/WebP `<source>` tags (with width-keyed
 * `srcset`) and a fallback `<img>` in the original format.  All other `<img>`
 * attributes (`alt`, `class`, `id`, etc.) are preserved on the fallback.
 */
export function rewriteImgToPicture(
  html: string,
  imageManifest: ImageManifest,
): string {
  const $ = cheerio.load(html);
  $("img").each((_i, el) => {
    const attribs = (el as { attribs: Record<string, string> }).attribs ?? {};
    const src = attribs.src;
    if (!src) return;
    const candidates = [src, src.replace(/^\.?\/+/, "")];
    let key: string | undefined;
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(imageManifest, c)) {
        key = c;
        break;
      }
    }
    if (!key) return;
    const variants = imageManifest[key]!;
    if (variants.length === 0) return;

    const byFormat = new Map<string, ImageVariant[]>();
    for (const v of variants) {
      const arr = byFormat.get(v.format) ?? [];
      arr.push(v);
      byFormat.set(v.format, arr);
    }
    for (const arr of byFormat.values()) arr.sort((a, b) => a.width - b.width);

    const fallbackFormat = normalizeFormat(undefined, extname(key));
    const fallbackList =
      byFormat.get(fallbackFormat) ?? [...variants].sort((a, b) => a.width - b.width);
    const fallbackBest = fallbackList[fallbackList.length - 1]!;

    const sourceTags: string[] = [];
    const sourceFormats = ["avif", "webp"];
    for (const fmt of sourceFormats) {
      const list = byFormat.get(fmt);
      if (!list || list.length === 0) continue;
      const srcset = list.map((v) => `/${v.path} ${v.width}w`).join(", ");
      sourceTags.push(`<source type="image/${fmt}" srcset="${escapeAttr(srcset)}">`);
    }

    const carriedAttrs: string[] = [];
    for (const name of Object.keys(attribs)) {
      if (name === "src" || name === "srcset") continue;
      carriedAttrs.push(`${name}="${escapeAttr(attribs[name] ?? "")}"`);
    }
    const attrSuffix = carriedAttrs.length > 0 ? " " + carriedAttrs.join(" ") : "";
    const fallbackImg = `<img src="/${fallbackBest.path}"${attrSuffix}>`;
    const picture = `<picture>${sourceTags.join("")}${fallbackImg}</picture>`;
    $(el).replaceWith(picture);
  });
  return $.html();
}
