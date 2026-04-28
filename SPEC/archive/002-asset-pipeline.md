# Asset Pipeline (archived from SPEC.md)

*Archived: 2026-04-28 — All asset features shipped (US-007 through US-010). Summary retained in "Optimizations applied" section.*

---

## Asset pipeline

**Images** — the crawler always downloads the highest-resolution source available (e.g. WordPress's full-size original, not the auto-generated thumbnails). From that single source, `sharp` generates a responsive set on the fly:

- multiple widths (e.g. 480, 768, 1024, 1440, 1920px),
- two modern formats (AVIF + WebP) with a JPEG/PNG fallback,
- emitted as a proper `<picture>` / `srcset` so the browser picks the right one per device.

**CSS** — original stylesheets are downloaded once, then per-page processed:

- `lightningcss` purges rules unused on that page,
- `beasties` extracts the above-the-fold critical CSS and inlines it in `<head>`,
- the rest is loaded async to avoid render-blocking.

**JS** — `terser` minifies, dead code is dropped, third-party scripts flagged as non-essential are deferred or removed.

**Fonts** — subset to actually-used glyphs, served as WOFF2 with `font-display: swap`.
