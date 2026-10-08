import { describe, expect, it, vi } from "vitest";
import { UNCACHED } from "../cache.js";
import { createListLayout } from "./list.js";
import { range } from "../../../spec/utils.js";

const sum = (values: readonly number[]): number => {
  return values.reduce((acc, c) => acc + c, 0);
};

const initLayoutWithSizes = (sizes: readonly number[], defaultSize: number) => {
  const layout = createListLayout(sizes.length, defaultSize, [
    sizes.slice(),
    defaultSize,
  ]);
  layout.$getTotalSize();
  return layout;
};

describe("initialize", () => {
  it("should use the item size as the default size", () => {
    const itemLength = 10;
    const layout = createListLayout(itemLength, 23);
    const snapshot = layout.$snapshot();
    expect(snapshot).toMatchInlineSnapshot(`
      [
        [
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
        ],
        23,
      ]
    `);
    expect(layout.$getLength()).toBe(itemLength);
    expect(snapshot[0].length).toBe(itemLength);
    expect(layout.$getTotalSize()).toBe(23 * itemLength);
  });

  it("should not estimate the default size with the item size", () => {
    expect(createListLayout(10, 23).$isEstimating()).toBe(false);
    expect(createListLayout(10).$isEstimating()).toBe(true);
  });

  it("should restore the sizes and the default size from the snapshot", () => {
    const itemLength = 10;
    const layout = createListLayout(itemLength, 123, [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      123,
    ]);
    const snapshot = layout.$snapshot();
    expect(snapshot).toMatchInlineSnapshot(`
      [
        [
          0,
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          9,
        ],
        123,
      ]
    `);
    expect(layout.$getLength()).toBe(itemLength);
    expect(snapshot[0].length).toBe(itemLength);
    expect(layout.$getTotalSize()).toBe(sum([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it("should fill the sizes if the snapshot is shorter", () => {
    const itemLength = 10;
    const layout = createListLayout(itemLength, 123, [[0, 1, 2, 3, 4], 123]);
    const snapshot = layout.$snapshot();
    expect(snapshot).toMatchInlineSnapshot(`
      [
        [
          0,
          1,
          2,
          3,
          4,
          -1,
          -1,
          -1,
          -1,
          -1,
        ],
        123,
      ]
    `);
    expect(layout.$getLength()).toBe(itemLength);
    expect(snapshot[0].length).toBe(itemLength);
    expect(layout.$getTotalSize()).toBe(sum([0, 1, 2, 3, 4]) + 123 * 5);
  });

  it("should drop the sizes if the snapshot is longer", () => {
    const itemLength = 10;
    const layout = createListLayout(itemLength, 123, [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      123,
    ]);
    const snapshot = layout.$snapshot();
    expect(snapshot).toMatchInlineSnapshot(`
      [
        [
          0,
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          9,
        ],
        123,
      ]
    `);
    expect(layout.$getLength()).toBe(itemLength);
    expect(snapshot[0].length).toBe(itemLength);
    expect(layout.$getTotalSize()).toBe(sum([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });
});

describe("snapshot", () => {
  it("should return the measured sizes and the default size", () => {
    const layout = createListLayout(4, 40);
    layout.$resize([[1, 10]], () => false, 0, 0);
    layout.$resize([[2, 20]], () => false, 0, 0);
    expect(layout.$snapshot()).toEqual([[-1, 10, 20, -1], 40]);
  });

  it("should return a copy", () => {
    const layout = initLayoutWithSizes(
      range(10, (i) => (i + 1) * 10),
      40,
    );
    const snapshot = layout.$snapshot();
    const clonedSnapshot = structuredClone(snapshot);
    snapshot[0][0] = 999;
    snapshot[1] = 123;
    expect(snapshot).not.toEqual(clonedSnapshot);
    expect(layout.$snapshot()).toEqual(clonedSnapshot);
  });
});

describe("setLength", () => {
  it("should increase cache length with shifting", () => {
    const layout = createListLayout(10, 40);
    const initialTotalSize = layout.$getTotalSize();
    const res = layout.$setLength(15, true);
    expect(res).toEqual(40 * 5);
    expect(layout.$snapshot()).toMatchInlineSnapshot(`
      [
        [
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
          -1,
        ],
        40,
      ]
    `);
    expect(layout.$getTotalSize()).toBe(initialTotalSize + res);
  });

  it("should increase filled cache length with shifting", () => {
    const sizes = range(10, (i) => (i + 1) * 10);
    const layout = initLayoutWithSizes(sizes, 40);
    const initialTotalSize = layout.$getTotalSize();
    const res = layout.$setLength(15, true);
    expect(res).toEqual(40 * 5);
    expect(layout.$snapshot()).toMatchInlineSnapshot(`
      [
        [
          -1,
          -1,
          -1,
          -1,
          -1,
          10,
          20,
          30,
          40,
          50,
          60,
          70,
          80,
          90,
          100,
        ],
        40,
      ]
    `);
    expect(layout.$getTotalSize()).toBe(initialTotalSize + res);
  });

  it("should decrease cache length with shifting", () => {
    const layout = createListLayout(10, 40);
    const initialTotalSize = layout.$getTotalSize();
    const res = layout.$setLength(5, true);
    expect(res).toEqual(-(40 * 5));
    expect(layout.$snapshot()).toMatchInlineSnapshot(`
      [
        [
          -1,
          -1,
          -1,
          -1,
          -1,
        ],
        40,
      ]
    `);
    expect(layout.$getTotalSize()).toBe(initialTotalSize + res);
  });

  it("should decrease filled cache length with shifting", () => {
    const sizes = range(10, (i) => (i + 1) * 10);
    const layout = initLayoutWithSizes(sizes, 40);
    const initialTotalSize = layout.$getTotalSize();
    const res = layout.$setLength(5, true);
    expect(res).toEqual(-sum(sizes.slice(0, 5)));
    expect(layout.$snapshot()).toMatchInlineSnapshot(`
      [
        [
          60,
          70,
          80,
          90,
          100,
        ],
        40,
      ]
    `);
    expect(layout.$getTotalSize()).toBe(initialTotalSize + res);
  });
});

// Ported from Band's vendored core/cache.test.ts (delta 5). The vendored suite
// peeked at `_estimates` / `_computedOffsetIndex`; the 0.53.3 list layout keeps
// those private, so the assertions go through the public layout surface —
// re-pricing after a swap proves invalidation, and correct offsets prove the
// rollback never leaves stale estimates in an offset walk.
describe("itemSize estimator", () => {
  it("returns the measured size for a measured index without consulting the estimator", () => {
    const layout = createListLayout(3, 16);
    layout.$resize([[0, 40]], () => false, 0, 0);
    const estimator = vi.fn(() => 999);
    layout.$setEstimator(estimator);

    expect(layout.$getItemSize(0)).toBe(40);
    expect(estimator).not.toHaveBeenCalled();
  });

  it("calls the estimator once for an unmeasured index and caches the result", () => {
    const layout = createListLayout(3, 16);
    const estimator = vi.fn((index: number) => 30 + index);
    layout.$setEstimator(estimator);

    expect(layout.$getItemSize(2)).toBe(32);
    expect(layout.$getItemSize(2)).toBe(32);
    expect(estimator).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default size for a non-finite or non-positive result, never a caller-specific number", () => {
    for (const bad of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY]) {
      const layout = createListLayout(3, 40);
      layout.$setEstimator(() => bad);
      expect(layout.$getItemSize(0)).toBe(40);
    }
  });

  it("returns the default size when no estimator is installed", () => {
    expect(createListLayout(3, 40).$getItemSize(0)).toBe(40);
  });

  it("is a no-op for the same estimator reference and does not re-price", () => {
    const layout = createListLayout(3, 16);
    const estimator = vi.fn(() => 30);
    layout.$setEstimator(estimator);
    expect(layout.$getItemSize(1)).toBe(30); // prime the estimate

    expect(layout.$setEstimator(estimator)).toBe(false);
    expect(layout.$getItemSize(1)).toBe(30);
    expect(estimator).toHaveBeenCalledTimes(1);
  });

  it("reprices still-unmeasured rows from the first unmeasured index on a real swap, leaving measured rows alone", () => {
    const layout = createListLayout(4, 16, [[20, UNCACHED, UNCACHED, UNCACHED], 16]);
    layout.$setEstimator(() => 30);
    expect(layout.$getItemSize(1)).toBe(30);
    expect(layout.$getItemSize(2)).toBe(30);

    const next = vi.fn((index: number) => (index === 0 ? 999 : 99));
    expect(layout.$setEstimator(next)).toBe(true);

    expect(layout.$getItemSize(1)).toBe(99); // the stale 30 was invalidated
    expect(layout.$getItemSize(2)).toBe(99);
    expect(layout.$getItemSize(0)).toBe(20); // measured, never re-priced
    expect(layout.$getItemOffset(3)).toBe(20 + 99 * 2); // offset(3) = size0+size1+size2
    expect(next).not.toHaveBeenCalledWith(0);
  });

  it("returns false without invalidating anything when every row is measured", () => {
    const layout = createListLayout(2, 16, [[10, 20], 16]);
    expect(layout.$setEstimator(() => 999)).toBe(false);
    expect(layout.$getItemOffset(1)).toBe(10);
    expect(layout.$getItemSize(1)).toBe(20);
  });

  it("opts out of automatic estimation when created with a callback itemSize", () => {
    expect(createListLayout(10, () => 30).$isEstimating()).toBe(false);
  });
});

describe("setLength pricing with an estimator", () => {
  it("prices newly appended indices through the estimator instead of the flat default", () => {
    const layout = createListLayout(2, 16);
    layout.$setEstimator((index) => 100 + index);

    expect(layout.$setLength(4)).toBe(102 + 103); // append 2 rows at indices 2,3
    expect(layout.$getItemSize(2)).toBe(102);
    expect(layout.$getItemSize(3)).toBe(103);
  });

  it("prices removed-from-end indices through the estimator that priced them, not a flat default", () => {
    const layout = createListLayout(4, 16);
    layout.$setEstimator((index) => 100 + index);
    layout.$getItemSize(2);
    layout.$getItemSize(3);

    expect(layout.$setLength(2)).toBe(-(102 + 103)); // drop indices 2,3
  });

  it("prices removed-from-start (shift) indices the same way", () => {
    const layout = createListLayout(4, 16);
    layout.$setEstimator((index) => 100 + index);
    layout.$getItemSize(0);
    layout.$getItemSize(1);

    expect(layout.$setLength(2, true)).toBe(-(100 + 101)); // drop indices 0,1
  });

  it("prices newly prepended (shift) indices through the estimator", () => {
    const layout = createListLayout(2, 16);
    layout.$setEstimator(() => 55);

    expect(layout.$setLength(4, true)).toBe(55 + 55); // prepend 2 rows at 0,1
    expect(layout.$getItemSize(0)).toBe(55);
    expect(layout.$getItemSize(1)).toBe(55);
  });

  it("still falls back to the flat default when no estimator is installed", () => {
    const layout = createListLayout(2, 16);
    expect(layout.$setLength(4)).toBe(32);
    expect(layout.$setLength(2)).toBe(-32);
  });
});
