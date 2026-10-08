import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNCACHED } from "./cache.js";
import { createListLayout, type ListLayout } from "./layouts/list.js";
import {
  ACTION_BEFORE_MANUAL_SMOOTH_SCROLL,
  ACTION_ITEM_RESIZE,
  ACTION_ITEM_SIZE_ESTIMATOR_CHANGE,
  ACTION_ITEMS_LENGTH_CHANGE,
  ACTION_MANUAL_SCROLL,
  ACTION_SCROLL,
  ACTION_SCROLL_END,
  ACTION_USER_GESTURE,
  ACTION_VIEWPORT_RESIZE,
  createVirtualStore,
  UPDATE_VIRTUAL_STATE,
  type VirtualStore,
} from "./store.js";

// Ported from Band's vendored core/store.test.ts (deltas 5 and 6). Two
// adaptations for the fork: the 0.53.3 store takes a Layout instead of a
// (length, itemSize) pair, and the vendored WebKit mid-gesture deferral
// (deltas 1–3, re-added by the F7 fallback in v0.53.3-jam.2) does not fire
// in these tests — vitest's jsdom user agent carries a Chrome token, which
// isWebKit() excludes by design — so corrections are written immediately
// here exactly as in a Chromium tab. The WebKit branch is guarded in the
// deferral block below and adjudicated by the browser suites (P7a) on a
// real WebKit.
const webkitFlag = vi.hoisted(() => ({ value: false }));
vi.mock("./environment.js", () => ({
  isIOSWebKit: () => false,
  isWebKit: () => webkitFlag.value,
}));
beforeEach(() => {
  webkitFlag.value = false;
});

const storeWith = (length: number, itemSize?: number) =>
  createVirtualStore(createListLayout(length, itemSize));

describe("item size estimator geometry compensation (FORK-CHANGES.md delta 5)", () => {
  it("applies no jump when a swapped estimator recomputes identical values for what was already estimated", () => {
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    // Discriminates a no-op dispatch (which would still report the flat
    // default 16) from the estimator actually being consulted.
    expect(store.$getItemSize(0)).toBe(30);
    store.$getItemOffset(5); // prime estimates for the whole range
    store._flushJump();

    // Same values, different function reference — a real swap, but nothing a
    // still-unmeasured row resolves to actually changed.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("compensates the scrolled-to anchor's offset delta via applyJump when the estimator changes a row ahead of it", () => {
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5); // prime estimates; anchor resolves at index 5 for scrollOffset 200
    store._flushJump();

    // Index 1 grows from 30 to 50 (+20); everything from index 2 on shifts by
    // the same +20, so the anchor's own offset shifts by exactly +20 too.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );
    // The unit environment classifies as Chromium (see the header note), so
    // the correction is written immediately, like every upstream correction
    // outside a WebKit gesture; the parked variant is the deferral block's
    // first test.
    expect(store._flushJump()).toEqual([20, false]);
  });

  it("does not consult the estimator, and applies no jump, for a measured row (measurements never depend on the estimator)", () => {
    const store = storeWith(6, 16);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$update(ACTION_ITEM_RESIZE, [[0, 40]]);
    expect(store.$getItemSize(0)).toBe(40);
    expect(store.$isUnmeasuredItem(0)).toBe(false);

    store._flushJump();
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 999);
    // Index 0 is measured; an estimator swap must not touch it or shift
    // anything, since nothing currently unmeasured sits before it.
    expect(store.$getItemSize(0)).toBe(40);
    expect(store._flushJump()).toEqual([0, false]);
    // But an unmeasured row (index 1) IS consulting the new estimator —
    // discriminates a no-op dispatch (which would report the flat default
    // 16) from the swap actually landing.
    expect(store.$getItemSize(1)).toBe(999);
  });
});

describe("item size estimator dispatch order across a prepend (delta 5)", () => {
  // Both tests share the same setup: 3 rows, distinct per-index estimates
  // already cached under an old estimator, then a shift=true (prepend)
  // growth to 4 rows under a genuinely distinct new estimator whose values
  // for index >= 1 deliberately match what the old estimator gave the SAME
  // row content at its old (pre-shift) index — modeling "same row, new
  // position" fidelity, so a correct implementation must reproduce those
  // exact numbers at the shifted position.
  const estimatorOld = (index: number) => 100 + index * 10; // 0:100, 1:110, 2:120
  const estimatorNew = (index: number) =>
    index === 0 ? 999 : 100 + (index - 1) * 10;

  function primedStore() {
    const store = storeWith(3, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_SCROLL, 300);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, estimatorOld);
    store.$getItemOffset(2); // prime estimates for indices 0 and 1 under the old estimator
    return store;
  }

  it("the shipped order (length change, then swap for a prepend) prices old rows at their new post-shift index", () => {
    const store = primedStore();
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [4, true]);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, estimatorNew);

    expect(store.$getItemSize(0)).toBe(999); // the newly prepended row
    expect(store.$getItemSize(1)).toBe(100); // was index 0 (size 100), now shifted here
    expect(store.$getItemSize(2)).toBe(110); // was index 1 (size 110), now shifted here
  });

  it("the wrong order (swap before the length change) prices old rows against the wrong index and the shift carries the mistake forward", () => {
    const store = primedStore();
    // Swap first: the anchor/total read inside the swap consults
    // estimatorNew against the OLD (pre-shift) index space, caching a wrong
    // value at each index it touches; the subsequent shift then unshifts
    // those already-wrong cached values instead of resetting them.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, estimatorNew);
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [4, true]);

    expect(store.$getItemSize(1)).not.toBe(100);
    expect(store.$getItemSize(2)).not.toBe(110);
  });

  it("the Virtualizer's prepend ordering (length change, then estimator swap) yields the correct pricing", () => {
    // Mirrors what react/Virtualizer.tsx dispatches when shift is set and
    // both the estimator and the count changed in the same render.
    const store = primedStore();
    const oldItemsLength = store.$getItemsLength();
    const count = 4;
    const shift = true;
    if (shift || count < oldItemsLength) {
      if (count !== oldItemsLength) {
        store.$update(ACTION_ITEMS_LENGTH_CHANGE, [count, shift]);
      }
      store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, estimatorNew);
    } else {
      store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, estimatorNew);
      if (count !== oldItemsLength) {
        store.$update(ACTION_ITEMS_LENGTH_CHANGE, [count, shift]);
      }
    }

    expect(store.$getItemSize(0)).toBe(999);
    expect(store.$getItemSize(1)).toBe(100);
    expect(store.$getItemSize(2)).toBe(110);
  });
});

// Raw-size snapshot through the layout's remap seam, for the assertions below.
function rawSizes(layout: ListLayout): number[] {
  return [...layout.$remapSource()];
}

describe("virtual store item remapping (FORK-CHANGES.md delta 6)", () => {
  it("uses current raw sizes for same-length identity changes", () => {
    const layout = createListLayout(3, 16);
    const store = createVirtualStore(layout);
    store.$update(ACTION_ITEM_RESIZE, [
      [0, 10],
      [1, 20],
      [2, 30],
    ]);

    expect(store.$remapItems({ previousLength: 3, order: [2, 0, 1] })).toBe(
      true,
    );
    expect(rawSizes(layout)).toEqual([30, 10, 20]);
    expect(store.$isUnmeasuredItem(0)).toBe(false);
  });

  it("uses the exact retained raw window for a length change", () => {
    const layout = createListLayout(3, 16);
    const store = createVirtualStore(layout);
    store.$update(ACTION_ITEM_RESIZE, [
      [0, 10],
      [1, 20],
      [2, 30],
    ]);
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [5]);

    expect(
      store.$remapItems({ previousLength: 3, order: [2, -1, 0, 1, -1] }),
    ).toBe(true);
    expect(rawSizes(layout)).toEqual([30, UNCACHED, 10, 20, UNCACHED]);
  });

  it("rejects a superseded retained window without mutating sizes", () => {
    const layout = createListLayout(3, 16);
    const store = createVirtualStore(layout);
    store.$update(ACTION_ITEM_RESIZE, [[0, 10]]);
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [5]);
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [4]);
    const before = rawSizes(layout);

    expect(store.$remapItems({ previousLength: 3, order: [0, 1, 2, -1] })).toBe(
      false,
    );
    expect(rawSizes(layout)).toEqual(before);
  });

  it("rejects invalid order entries without mutating sizes", () => {
    const layout = createListLayout(3, 16);
    const store = createVirtualStore(layout);
    store.$update(ACTION_ITEM_RESIZE, [[0, 10]]);
    const before = rawSizes(layout);

    expect(store.$remapItems({ previousLength: 3, order: [0, 3, 1] })).toBe(
      false,
    );
    expect(rawSizes(layout)).toEqual(before);
  });

  it("rejects remapping while automatic estimation is active", () => {
    const layout = createListLayout(3);
    const store = createVirtualStore(layout);
    const before = rawSizes(layout);

    expect(store.$remapItems({ previousLength: 3, order: [2, 0, 1] })).toBe(
      false,
    );
    expect(rawSizes(layout)).toEqual(before);
  });

  it("rejects non-finite source sizes without mutating sizes", () => {
    const layout = createListLayout(2, 16);
    const store = createVirtualStore(layout);
    store.$update(ACTION_ITEM_RESIZE, [[0, Number.NaN]]);
    const before = rawSizes(layout);

    expect(store.$remapItems({ previousLength: 2, order: [0, 1] })).toBe(false);
    expect(rawSizes(layout)).toEqual(before);
  });

  it("notifies virtual state subscribers asynchronously after remapping", () => {
    const store = createVirtualStore(createListLayout(2, 16));
    const syncValues: (boolean | undefined)[] = [];
    store.$subscribe(UPDATE_VIRTUAL_STATE, (sync) => syncValues.push(sync));

    expect(store.$remapItems({ previousLength: 2, order: [1, 0] })).toBe(true);
    expect(syncValues).toEqual([false]);
  });

  it("bumps the state version on a successful remap, so version-gated consumers observe it", () => {
    const store = createVirtualStore(createListLayout(2, 16));
    const before = store.$getStateVersion();

    expect(store.$remapItems({ previousLength: 2, order: [1, 0] })).toBe(true);
    expect(store.$getStateVersion()).not.toBe(before);
  });

  it("preserves jump while clearing shift mode after remapping", () => {
    const store = createVirtualStore(createListLayout(3, 16));
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [5, true]);

    expect(
      store.$remapItems({ previousLength: 3, order: [2, -1, 0, 1, -1] }),
    ).toBe(true);
    expect(store._flushJump()).toEqual([32, false]);
  });

  it("clears a previously flushed shift jump before remapping", () => {
    const store = createVirtualStore(createListLayout(3, 16));
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [5, true]);

    expect(store._flushJump()).toEqual([32, true]);
    expect(
      store.$remapItems({ previousLength: 3, order: [2, -1, 0, 1, -1] }),
    ).toBe(true);
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("preserves a pending jump while clearing the frozen range", () => {
    const store = createVirtualStore(createListLayout(4, 16));
    store.$update(ACTION_ITEM_RESIZE, [
      [0, 10],
      [1, 20],
      [2, 30],
      [3, 40],
    ]);
    store.$update(ACTION_VIEWPORT_RESIZE, 20);
    store.$update(ACTION_BEFORE_MANUAL_SMOOTH_SCROLL, 60);
    expect(store.$getRange(0)[1]).toBe(3);

    store.$update(ACTION_MANUAL_SCROLL);
    store.$update(ACTION_ITEM_RESIZE, [[0, 15]]);
    // Identity permutation: the parked smooth-scroll correction stays (delta 6
    // preserves it), but the frozen range clears.
    expect(store.$remapItems({ previousLength: 4, order: [0, 1, 2, 3] })).toBe(
      true,
    );
    expect(store.$getRange(0)[1]).toBeLessThan(3);

    // A delivered scroll at the start edge releases the backlog mid-gesture
    // (delta 3); scroll end (upstream's release) then finds nothing left —
    // the preserved pendingJump arrives to the reader unchanged either way.
    store.$update(ACTION_SCROLL, 1);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([5, false]);
  });
});

describe("stale jump discard across a remap (FORK-CHANGES.md delta 6)", () => {
  // A genuine reorder or filter rebuilds sizes for a DIFFERENT row at each
  // index. A jump or pendingJump parked by an EARLIER, unrelated estimator
  // swap describes a correction for the OLD mapping and must not survive.
  // The vendored copy deferred through its desktop-WebKit guard; here the
  // deferral role is filled by upstream's own smooth-scroll path:
  // ACTION_MANUAL_SCROLL + ACTION_BEFORE_MANUAL_SMOOTH_SCROLL park applyJump
  // results in pendingJump until scroll end (the engine flags are mocked off
  // outside the deferral block below, so no gesture deferral fires here).
  const parkPendingJump = (store: VirtualStore) => {
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5); // prime estimates for the whole range
    store._flushJump();
    store.$update(ACTION_MANUAL_SCROLL);
    store.$update(ACTION_BEFORE_MANUAL_SMOOTH_SCROLL, 200);
    // Index 1 grows 30 -> 50 (+20) — deferred into pendingJump by the
    // frozen smooth-scroll range.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );
  };

  it("discards a deferred estimator-swap pendingJump across a non-identity remap, so scroll-end releases nothing", () => {
    const store = createVirtualStore(createListLayout(6, 16));
    parkPendingJump(store);

    // A genuine (non-identity) same-length reorder lands before the gesture
    // ends — every index now refers to a different row than the pendingJump
    // was computed against.
    expect(
      store.$remapItems({ previousLength: 6, order: [1, 0, 2, 3, 4, 5] }),
    ).toBe(true);

    // Ending the gesture must not release the obsolete pre-remap delta.
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("discards an immediate (non-deferred) estimator-swap jump across a non-identity remap", () => {
    const store = createVirtualStore(createListLayout(6, 16));
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_SCROLL_END);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5); // prime estimates for the whole range
    store._flushJump();

    // Index 1 grows 30 -> 50 (+20), applied immediately (no gesture in
    // progress) — the same write branch every idle correction takes.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );

    expect(
      store.$remapItems({ previousLength: 6, order: [1, 0, 2, 3, 4, 5] }),
    ).toBe(true);
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("discards a deferred estimator-swap pendingJump across a non-shift length-changing remap", () => {
    const store = createVirtualStore(createListLayout(6, 16));
    parkPendingJump(store);

    // A PLAIN (non-shift) growth to 7 rows never calls applyJump, so it
    // leaves the parked +20 untouched — and never sets _scrollMode to
    // SCROLL_BY_SHIFT, unlike a real prepend.
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [7, false]);
    expect(
      store.$remapItems({ previousLength: 6, order: [0, 1, 2, 3, 4, 5, -1] }),
    ).toBe(true);

    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("discards an immediate estimator-swap jump across a non-shift length-changing remap", () => {
    const store = createVirtualStore(createListLayout(6, 16));
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_SCROLL_END);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5);
    store._flushJump();

    // +20 applied immediately, same as the identity-remap test above.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );

    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [7, false]);
    expect(
      store.$remapItems({ previousLength: 6, order: [0, 1, 2, 3, 4, 5, -1] }),
    ).toBe(true);
    expect(store._flushJump()).toEqual([0, false]);
  });
});

describe("WebKit mid-gesture deferral (FORK-CHANGES.md deltas 1–3)", () => {
  // The engine flags are mocked here and the deferral tests drive the
  // observer's gesture seam (ACTION_USER_GESTURE) explicitly; the delta 5/6
  // blocks above run with both off, matching vitest's Chromium-classified
  // jsdom UA (it carries a Chrome token, which isWebKit() excludes) doing
  // programmatic scrolls.

  it("parks a correction through an active gesture when the engine classifies as WebKit (delta 1)", () => {
    webkitFlag.value = true;
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    // Prime the estimator OUTSIDE the gesture so its geometry delta (+70,
    // which only delta 2's cap would apply mid-gesture) cannot pollute the
    // parked value asserted below.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5); // prime estimates; anchor resolves at index 5
    store._flushJump();
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_USER_GESTURE, true);
    // With a user gesture active on a WebKit-classified engine, the +20
    // must park (delta 1's seam; without the gesture flag it writes through
    // — see the next test).
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );
    expect(store._flushJump()).toEqual([0, false]);

    // Gesture end releases the parked correction unchanged.
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([20, false]);
  });

  it("keeps #942's immediate writes for programmatic scrolls on a WebKit-classified engine (delta 1 seam)", () => {
    webkitFlag.value = true;
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5);
    store._flushJump();
    // A delivered scroll WITHOUT the observer's gesture flag — what
    // scrollBy/scrollTo produce, as in upstream's compensation suites: the
    // deferral must not fire; WKWebView only reverts USER-gesture writes.
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );
    expect(store._flushJump()).toEqual([20, false]);
  });

  it("classifies engines by user agent: WebKit true; Chrome, Edge, and Firefox false (delta 1)", async () => {
    // isWebKit memoizes per module instance, so each UA gets a fresh import.
    const cases: [string, boolean][] = [
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        true,
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        false,
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0",
        false,
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
        false,
      ],
    ];
    const descriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "userAgent",
    ) ?? { configurable: true, get: () => "" };
    for (const [ua, expected] of cases) {
      vi.resetModules();
      Object.defineProperty(navigator, "userAgent", {
        value: ua,
        configurable: true,
      });
      try {
        const env =
          await vi.importActual<typeof import("./environment.js")>(
            "./environment.js",
          );
        expect([ua, env.isWebKit()]).toEqual([ua, expected]);
      } finally {
        Object.defineProperty(navigator, "userAgent", descriptor);
      }
    }
    vi.resetModules();
  });
});
