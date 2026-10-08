import type { ItemResize, ItemsRange } from "../types.js";

/**
 * Prices one still-unmeasured row by its raw mounted index.
 *
 * @internal
 */
export type ItemSizeEstimator = (index: number) => number;

/**
 * @internal
 */
export interface Layout {
  $getRange(startOffset: number, endOffset: number): ItemsRange;
  $getItemOffset(index: number): number;
  $getItemSize(index: number): number;
  $isSizeEqual(index: number, size?: number): boolean;
  $getTotalSize(): number;
  $getLength(): number;
  $setLength(length: number, isShift?: boolean): number;
  $resize(
    resizes: readonly ItemResize[],
    shouldKeep: (index: number) => boolean,
    scrollOffset: number,
    viewportSize: number,
  ): number;
  $isEstimating(): boolean;
  /**
   * Installs (or clears) the per-index size estimator, invalidating cached
   * estimates from the first still-unmeasured index onward. Returns whether
   * anything needs recompensating. Implemented only by layouts that price
   * unmeasured rows per index; the store skips the dispatch when absent.
   *
   * @internal
   */
  $setEstimator?(estimator: ItemSizeEstimator | null): boolean;
}
