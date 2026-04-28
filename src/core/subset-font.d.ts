// Local type declarations for `subset-font` (no upstream @types package).
declare module "subset-font" {
  interface SubsetOptions {
    targetFormat?: "woff2" | "woff" | "truetype" | "sfnt";
    preserveNameIds?: number[];
    variationAxes?: Record<string, number | { min: number; max: number }>;
    noLayoutClosure?: boolean;
  }
  function subsetFont(
    font: Buffer | Uint8Array,
    text: string,
    opts?: SubsetOptions,
  ): Promise<Buffer>;
  export default subsetFont;
}
