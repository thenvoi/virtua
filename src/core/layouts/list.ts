import { UNCACHED, fill, findIndex } from "../cache.js";
import type { ItemSizeEstimator, Layout } from "./types.js";
import type { CacheSnapshot } from "../types.js";
import { max, min, sort } from "../utils.js";
/**
 * @internal
 */
export interface ListLayout extends Layout {
  $findIndex(offset: number): number;
  $snapshot(): CacheSnapshot;
  $setEstimator(estimator: ItemSizeEstimator | null): boolean;
  $remapSource(): readonly number[];
  $replaceSizes(sizes: readonly number[]): void;
}

/**
 * @internal
 */
export const createListLayout = (
  length: number,
  itemSize?: number | ItemSizeEstimator | undefined,
  snapshot?: CacheSnapshot | undefined,
): ListLayout => {
  // Fork delta 5: itemSize may also be a per-index estimator callback, priced
  // once per still-unmeasured row and cached (FORK-CHANGES.md delta 5). The
  // callback form and automatic estimation from measured sizes are exclusive.
  const scalarItemSize = typeof itemSize === "number" ? itemSize : undefined;
  let itemSizeEstimator: ItemSizeEstimator | null =
    typeof itemSize === "function" ? itemSize : null;

  let defaultItemSize = (snapshot && snapshot[1]) || scalarItemSize || 40;

  let computedOffsetIndex = -1;
  let _totalMeasuredSize = 0;
  let shouldAutoEstimateItemSize = !scalarItemSize && !itemSizeEstimator;
  let prevStartIndex = 0;

  const restoredSizes = snapshot && snapshot[0];

  const sizes: number[] = restoredSizes
    ? // https://github.com/inokawa/virtua/issues/441
      fill(
        restoredSizes.slice(0, min(length, restoredSizes.length)),
        max(0, length - restoredSizes.length),
      )
    : fill([], length);
  const offsets: number[] = fill([], length + 1);

  // Per-index price cache for the estimator callback, kept separate from
  // `sizes` so $isSizeEqual keeps meaning "not yet ResizeObserver-measured",
  // not "estimated". The callback is never invoked twice for an index the
  // layout has already priced.
  const estimates: number[] = fill([], length);

  const getSize = (index: number): number => {
    const size = sizes[index]!;
    if (size !== UNCACHED) return size;

    const cached = estimates[index]!;
    if (cached !== UNCACHED) return cached;

    const estimator = itemSizeEstimator;
    if (!estimator) return defaultItemSize;

    // Defensive, domain-agnostic guard: a broken caller callback falls back to
    // the layout's own configured default, never a caller-specific number.
    const raw = estimator(index);
    const value = Number.isFinite(raw) && raw > 0 ? raw : defaultItemSize;
    estimates[index] = value;
    return value;
  };

  const getOffset = (index: number): number => {
    if (!length) return 0;
    if (computedOffsetIndex >= index) {
      return offsets[index]!;
    }

    if (computedOffsetIndex < 0) {
      // first offset must be 0 to avoid returning NaN, which can cause infinite rerender.
      // https://github.com/inokawa/virtua/pull/160
      offsets[0] = 0;
      computedOffsetIndex = 0;
    }
    let i = computedOffsetIndex;
    let top = offsets[i]!;
    while (i < index) {
      top += getSize(i);
      offsets[++i] = top;
    }
    // mark as measured
    computedOffsetIndex = index;
    return top;
  };

  return {
    $getRange: (startOffset, endOffset) => {
      // Clamp because prevStartIndex may exceed the limit when children decreased a lot after scrolling
      prevStartIndex = min(prevStartIndex, length - 1);

      let start: number;
      let end: number;
      if (getOffset(prevStartIndex) <= startOffset) {
        // search forward
        // start <= end, prevStartIndex <= start
        end = findIndex(getOffset, length, endOffset, prevStartIndex);
        start = findIndex(getOffset, length, startOffset, prevStartIndex, end);
      } else {
        // search backward
        // start <= end, start <= prevStartIndex
        start = findIndex(
          getOffset,
          length,
          startOffset,
          undefined,
          prevStartIndex,
        );
        end = findIndex(getOffset, length, endOffset, start);
      }
      prevStartIndex = start;
      return [start, end];
    },
    $findIndex: (offset) => findIndex(getOffset, length, offset),
    $getItemOffset: getOffset,
    $getItemSize: getSize,
    $isSizeEqual: (index, size = UNCACHED) => sizes[index] === size,
    $resize: (resizes, shouldKeep, scrollOffset, viewportSize) => {
      let jump = resizes.reduce(
        (acc, [index, size]) =>
          shouldKeep(index) ? acc + (size - getSize(index)) : acc,
        0,
      );
      // Update item sizes
      for (const [index, size] of resizes) {
        _totalMeasuredSize +=
          sizes[index] === UNCACHED ? size : size - getSize(index);
        sizes[index] = size;
        // mark as dirty
        computedOffsetIndex = min(index, computedOffsetIndex);
      }
      // Estimate initial item size from measured sizes
      if (
        shouldAutoEstimateItemSize &&
        viewportSize &&
        // If the total size is lower than the viewport, the item may be a empty state
        _totalMeasuredSize > viewportSize
      ) {
        let measuredCountBeforeStart = 0;
        const startIndex = findIndex(getOffset, length, scrollOffset + jump);
        // This function will be called after measurement so measured size array must be longer than 0
        const measuredSizes: number[] = [];
        sizes.forEach((s, i) => {
          if (s !== UNCACHED) {
            // https://github.com/inokawa/virtua/issues/907
            if (s) {
              measuredSizes.push(s);
            }
            if (i < startIndex) {
              measuredCountBeforeStart++;
            }
          }
        });

        // Discard cache for now
        computedOffsetIndex = -1;

        // Calculate median
        sort(measuredSizes);
        const len = measuredSizes.length;
        const mid = (len / 2) | 0;
        const median =
          len % 2 === 0
            ? (measuredSizes[mid - 1]! + measuredSizes[mid]!) / 2
            : measuredSizes[mid]!;

        const prevDefaultItemSize = defaultItemSize;

        // Calculate diff of unmeasured items before start
        jump +=
          ((defaultItemSize = median) - prevDefaultItemSize) *
          max(startIndex - measuredCountBeforeStart, 0);
        shouldAutoEstimateItemSize = false;
      }
      return jump;
    },
    $getTotalSize: () => getOffset(length),
    $getLength: () => length,
    $setLength: (nextLength, isShift) => {
      const oldLength = length;
      const diff = nextLength - length;

      computedOffsetIndex = isShift
        ? // Discard cache for now
          -1
        : min(nextLength - 1, computedOffsetIndex);
      length = nextLength;

      if (diff > 0) {
        // Added
        fill(offsets, diff);
        fill(sizes, diff, isShift);
        fill(estimates, diff, isShift);
        // Price each newly added index through whichever estimator the caller
        // has installed by now, so shift/scroll compensation during a prepend
        // or append reflects the real per-index guess instead of a flat
        // multiply. Without an estimator this is the previous flat behavior.
        let total = 0;
        const start = isShift ? 0 : oldLength;
        for (let i = start; i < start + diff; i++) {
          total += getSize(i);
        }
        return total;
      } else {
        // Removed — price every removed index before splicing, so a removed
        // row that was only ever estimated (never measured) is priced by
        // whichever estimator computed it. The caller controls timing:
        // dispatch a shrink before swapping estimators so removals still see
        // the old one.
        let total = 0;
        const removedStart = isShift ? 0 : nextLength;
        for (let i = removedStart; i < removedStart - diff; i++) {
          total -= getSize(i);
        }
        offsets.splice(diff);
        if (isShift) {
          sizes.splice(0, -diff);
          estimates.splice(0, -diff);
        } else {
          sizes.splice(diff);
          estimates.splice(diff);
        }
        return total;
      }
    },
    $setEstimator: (estimator) => {
      if (itemSizeEstimator === estimator) return false;
      itemSizeEstimator = estimator;

      let first = -1;
      for (let i = 0; i < length; i++) {
        if (sizes[i] === UNCACHED) {
          first = i;
          break;
        }
      }
      // No unmeasured row exists right now, so nothing in `estimates` was in
      // use — a real measurement always wins over an estimate, so there is
      // nothing to invalidate or recompensate for.
      if (first === -1) return false;

      for (let i = first; i < estimates.length; i++) {
        estimates[i] = UNCACHED;
      }
      // Roll back only to the first invalidated index — offsets computed
      // before it never depended on the estimator and need no recompute.
      computedOffsetIndex = min(computedOffsetIndex, first - 1);
      return true;
    },
    $isEstimating: () => shouldAutoEstimateItemSize,
    $snapshot: () => [sizes.slice(), defaultItemSize],
    $remapSource: () => sizes,
    // Remap is an arbitrary identity reorder, not a uniform shift: an
    // estimate computed for old index i has no guaranteed relationship to
    // whatever is now at new index i. Discard the estimates wholesale, and
    // the offset cache — remap already rebuilds sizes from the source order.
    $replaceSizes: (next) => {
      sizes.length = next.length;
      for (let index = 0; index < next.length; index++) {
        sizes[index] = next[index]!;
      }
      for (let index = 0; index < estimates.length; index++) {
        estimates[index] = UNCACHED;
      }
      computedOffsetIndex = -1;
    },
  };
};
