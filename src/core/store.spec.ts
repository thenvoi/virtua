import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNCACHED } from "./cache.js";
import { createListLayout, type ListLayout } from "./layouts/list.js";
import {
  ACTION_BEFORE_MANUAL_SMOOTH_SCROLL,
  ACTION_ITEM_RESIZE,
  ACTION_ITEM_SIZE_ESTIMATOR_CHANGE,
  ACTION_ITEMS_LENGTH_CHANGE,
  ACTION_MANUAL_SCROLL,
  ACTION_RELAYOUT,
  ACTION_SCROLL,
  ACTION_SCROLL_END,
  ACTION_USER_GESTURE,
  ACTION_BURST_SETTLED,
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
    // The remap armed a burst wave (delta 7), so the wave — not scroll-end
    // — owns the release (R1): scroll-end defers, and the wave's quiescence
    // (BURST_SETTLED) commits the preserved pendingJump once, whole. In a real
    // browser the quiescence is the measurement storm settling a beat after
    // scroll-end; delta 3's scroll-level edge trigger is gone (EDGE-START
    // supersedes it), so no mid-scroll write precedes the commit anymore.
    store.$update(ACTION_SCROLL, 1);
    store.$update(ACTION_SCROLL_END);
    store.$update(ACTION_BURST_SETTLED);
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

  it("parks a backlog above one viewport through the gesture and commits whole at rest (delta 2 supersession)", () => {
    webkitFlag.value = true;
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5); // prime estimates; anchor resolves at index 5
    store._flushJump();
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_USER_GESTURE, true);
    // Index 1 grows 30 -> 100: a +70 correction, above the 50px viewport.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 100 : 30,
    );
    // The mid-gesture cap escape is superseded by ZW (contract CAP): the
    // backlog keeps parking during the gesture and commits once, whole,
    // at scroll end — one larger re-anchor at rest, the stated trade.
    expect(store._flushJump()).toEqual([0, false]); // parked, nothing through
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()[0]).toBe(70); // whole, at rest
    expect(store._flushJump()).toEqual([0, false]);
  });
  it("keeps the backlog parked at the start edge during the gesture, one commit at rest (delta 3 supersession)", () => {
    webkitFlag.value = true;
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    // Prime outside the gesture (same reason as the delta 1 test).
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5);
    store._flushJump();
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );
    expect(store._flushJump()).toEqual([0, false]); // parked (delta 1)

    // A delivered scroll near the start edge: the old delta-3 release
    // fired a compensating WRITE here, mid-gesture. Under EDGE-START +
    // ZW nothing is written while the hand is on glass; the geometry
    // stays truthful through the visible-offset machinery.
    store.$update(ACTION_SCROLL, 5);
    expect(store._flushJump()).toEqual([0, false]);
    store.$update(ACTION_SCROLL_END); // at rest…
    expect(store._flushJump()[0]).toBe(20); // …one commit, current > 0
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("keeps the backlog parked while delivered scrolls stay off the start edge (delta 3 scope)", () => {
    webkitFlag.value = true;
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5);
    store._flushJump();
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );
    expect(store._flushJump()).toEqual([0, false]); // parked (delta 1)

    // A delivered scroll never triggers a flush on its own (delta 3's
    // scroll-level trigger is gone); the backlog releases at scroll end.
    store.$update(ACTION_SCROLL, 300);
    expect(store._flushJump()).toEqual([0, false]);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([20, false]);
  });

  it("clears a parked shrink at the start edge — no write, offsets returned to true geometry (EDGE-START clear)", () => {
    webkitFlag.value = true;
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5); // prime estimates; anchor resolves at index 5
    store._flushJump();
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_USER_GESTURE, true);
    // Row 1 SHRINKS 30 → 10: a −20 correction parks (sign per the
    // reviewer's fixture: shrink is the negative pendingJump). While
    // parked it rides EVERY item offset (getItemOffset = getOffset −
    // pendingJump): row 0 — nothing above it — would render 20px BELOW
    // the top, a fork-injected blank band, even with no scroll write.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 10 : 30,
    );
    expect(store._flushJump()).toEqual([0, false]); // −20 parked (delta 1)

    // The reader moves AT the start edge while the epoch is open; the
    // flush finds current ≤ 0: NO write (a target-keyed guard would have
    // written −20 from 0) AND the debt is CLEARED — one-shot anchor
    // preservation, stale once the position is the reader's own.
    store.$update(ACTION_SCROLL, 0);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]); // no write, ever
    // The offset channel is true geometry: row 0's rendered offset equals
    // its raw layout offset (retention would leave it at +20 — the band).
    expect(store.$getItemOffset(0)).toBe(0);
    expect(
      store.$getVisibleOffset() -
        (store.$getScrollOffset() - store.$getStartSpacerSize()),
    ).toBe(0);

    // Nothing deferred to later: the debt was one-shot. Later flushes,
    // inside the content included, find no backlog to commit.
    store.$update(ACTION_SCROLL, 10);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("clears a parked growth through the elastic clock — no write at any native position, offsets true (EDGE-START clear)", () => {
    webkitFlag.value = true;
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5);
    store._flushJump();
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_USER_GESTURE, true);
    // +20 GROWTH (the positive sign): retention at the edge clips row 0
    // to −20 through the offset channel; the target-keyed guard also
    // WROTE it from −25 (−25 + 20 = "room").
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );
    store.$update(ACTION_SCROLL, -25); // the stretched position
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]); // no write AT elastic
    store.$update(ACTION_SCROLL, 0); // spring-back
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]); // no write AT the edge
    // Cleared both encounters: true geometry, nothing deferred.
    expect(store.$getItemOffset(0)).toBe(0); // retention: −20 (clipped row)
    expect(
      store.$getVisibleOffset() -
        (store.$getScrollOffset() - store.$getStartSpacerSize()),
    ).toBe(0);
    store.$update(ACTION_SCROLL, 5);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]); // one-shot, no ghost commit
  });

  it("clears the parked debt LIVE at edge-reach — true offsets before any settle flush, holds intact (EDGE-START live)", () => {
    webkitFlag.value = true;
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5);
    store._flushJump();
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_USER_GESTURE, true);
    // −20 shrink parked mid-list while the gesture hold is open.
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 10 : 30,
    );
    expect(store._flushJump()).toEqual([0, false]); // parked (delta 1)

    // The reader's SCROLL EVENT onto the edge is where the invariant
    // becomes due — not the settle flush that follows it. Pre-settle,
    // while the hold still governs: NO write (ZW absolute, and the
    // edge-reach clear is geometry-only) and the offset channel already
    // TRUE (a settle-lagged clear leaves row0 at +20 through this whole
    // interval — the reviewer's measured B gap).
    store.$update(ACTION_SCROLL, 0);
    expect(store._flushJump()).toEqual([0, false]); // no write on the event
    expect(store.$getItemOffset(0)).toBe(0); // row0 true BEFORE settle

    // The hold was NOT released by the clear: the epoch still governs the
    // timeline, and its flush now finds an empty backlog — the
    // flush-site clear is the backstop, nothing left to clear.
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]);
    // And nothing was deferred: the debt was one-shot at edge-reach.
    store.$update(ACTION_SCROLL, 10);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]);
  });
});

describe("every correction source parks mid-gesture (F7 guard coverage)", () => {
  // The F7 write-path audit: 0.53.3 routes all four size-correction sources
  // (resize batch, estimator swap, shift length-change, relayout) through
  // applyJump, which is the single park gate for BOTH the relative mid-range
  // and the absolute edge write branch in the observer. Each source gets one
  // case asserting the write stays parked while the user gesture is active
  // and releases exactly once at gesture end — the deterministic red that
  // fires in fork CI if a future refactor lets any source bypass the gate.
  const midGesture = (store: VirtualStore) => {
    webkitFlag.value = true;
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    store.$update(ACTION_USER_GESTURE, true);
  };

  it("resizes batch during a gesture park the whole batch", () => {
    const store = storeWith(10, 30);
    midGesture(store);
    store._flushJump();
    store.$update(ACTION_ITEM_RESIZE, [
      [2, 60],
      [3, 60],
      [4, 60],
      [5, 60],
    ]);
    expect(store._flushJump()).toEqual([0, false]);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()[0]).toBeGreaterThan(0); // released once, at end
    expect(store._flushJump()[0]).toBe(0);
  });

  it("estimator swap during a gesture parks (delta 5 routes through the gate)", () => {
    const store = storeWith(6, 16);
    store.$update(ACTION_VIEWPORT_RESIZE, 50);
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, () => 30);
    store.$getItemOffset(5);
    store._flushJump();
    store.$update(ACTION_SCROLL, 200);
    store.$update(ACTION_USER_GESTURE, true);
    webkitFlag.value = true;
    store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, (index: number) =>
      index === 1 ? 50 : 30,
    );
    expect(store._flushJump()).toEqual([0, false]);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([20, false]);
  });

  it("shift length-change during a gesture parks (prepend-measure interleaving)", () => {
    const store = storeWith(10, 30);
    midGesture(store);
    store._flushJump();
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, [14, true]);
    // Parked (jump 0) but already reporting shift mode — the transaction is
    // in flight; only the WRITE waits.
    expect(store._flushJump()).toEqual([0, true]);
    store.$update(ACTION_SCROLL_END);
    // Gesture end resets the mode before the merge lands, so the release
    // carries shift=false — the #357 cancel applies to corrections dispatched
    // DURING a shift transaction, not to the scroll-end backlog.
    expect(store._flushJump()).toEqual([120, false]);
  });

  it("relayout jump during a gesture parks", () => {
    const store = storeWith(10, 30);
    midGesture(store);
    store._flushJump();
    store.$update(ACTION_RELAYOUT, 25);
    expect(store._flushJump()).toEqual([0, false]);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([25, false]);
  });
});

describe("settle-keyed hold past gesture end (FORK-CHANGES.md delta 1, jam.3 revision)", () => {
  // The jam.3 seam: on WebKit the hold spans the momentum tail, not just the
  // gesture. The observer's wheel/touch seam reports the gesture; when it
  // ends while the scroll position is still changing (touch lift-off, wheel
  // pulses stopping before deceleration does), the store re-keys the hold on
  // settle state and releases it once, at the observer's scroll-end — the
  // 150ms position-stability debounce (FORK-CHANGES.md delta 1).
  const midTail = (store: VirtualStore) => {
    webkitFlag.value = true;
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300); // position moving: direction != IDLE
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_USER_GESTURE, false); // released mid-tail
  };

  it("parks a correction delivered after the gesture released, until the position settles (delta 1 revision)", () => {
    const store = storeWith(10, 30);
    midTail(store);
    store._flushJump();
    // Rows the deceleration reveals measure mid-tail: jam.2 would write this
    // +25 through (hold gone at gesture end) and WKWebView would revert it —
    // the one-frame drop-and-return. jam.3 parks it.
    store.$update(ACTION_RELAYOUT, 25);
    expect(store._flushJump()).toEqual([0, false]); // parked through the tail
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([25, false]); // one flush at settle
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("releases the whole tail backlog exactly once, as a single anchored commit (delta 1 revision)", () => {
    const store = storeWith(10, 30);
    midTail(store);
    store._flushJump();
    store.$update(ACTION_RELAYOUT, 10); // revealed early: parked
    store.$update(ACTION_SCROLL, 500); // tail keeps moving (off the start edge)
    store.$update(ACTION_RELAYOUT, 20); // revealed mid-tail: parked
    store.$update(ACTION_SCROLL, 650);
    store.$update(ACTION_RELAYOUT, 5); // revealed late: parked
    expect(store._flushJump()).toEqual([0, false]); // three corrections, zero writes
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([35, false]); // one merged commit
    expect(store._flushJump()).toEqual([0, false]); // and nothing more
  });

  it("a gesture released with the position stable does not arm the settle hold (delta 1 revision scope)", () => {
    const store = storeWith(10, 30);
    webkitFlag.value = true;
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_USER_GESTURE, false); // armed: still moving
    store.$update(ACTION_SCROLL_END); // settled: hold and arm both released
    store._flushJump();
    // A later stroke that ends after its scroll-end (direction IDLE at
    // release) must not re-arm — #942's immediate writes govern a stable
    // position, and no stale settle arm may survive the release.
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_USER_GESTURE, false);
    store.$update(ACTION_RELAYOUT, 25);
    expect(store._flushJump()).toEqual([25, false]);
  });

  it("the settle-window seam reads the hold exactly where the park condition does (jam.3 final)", () => {
    // The observer's re-arm decision must not drift from the park semantics:
    // it extends only while a hold parks (armed AND native mode). False
    // under a marked imperative mode (#942 owns that release), false for a
    // release of a stable position, false after scroll-end — an accessor
    // leaking any of these would delay manual/smooth releases (P4's
    // scroll-to specs pin those timelines).
    const store = storeWith(10, 30);
    webkitFlag.value = true;
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_USER_GESTURE, false);
    expect(store.$isSettleHeld()).toBe(true); // armed mid-tail: hold parks
    store.$update(ACTION_MANUAL_SCROLL); // imperative operation now owns it
    expect(store.$isSettleHeld()).toBe(false);
    store.$update(ACTION_SCROLL_END);
    expect(store.$isSettleHeld()).toBe(false); // released, no stale arm
    store.$update(ACTION_SCROLL, 500);
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_USER_GESTURE, false); // re-armed, native mode
    expect(store.$isSettleHeld()).toBe(true);
    store.$update(ACTION_SCROLL_END);
    expect(store.$isSettleHeld()).toBe(false);
  });

  it("keeps the tail backlog parked at the start edge, one commit at rest (delta 3 supersession, EDGE-START)", () => {
    const store = storeWith(10, 30);
    midTail(store);
    store._flushJump();
    store.$update(ACTION_RELAYOUT, 25);
    expect(store._flushJump()).toEqual([0, false]); // parked (delta 1 revision)
    // The false-ceiling release during the tail is retired: EDGE-START
    // geometry-only spans both states, and the visible-offset machinery
    // keeps the range truthful while parked. The commit lands once, at
    // rest, with room below the edge.
    store.$update(ACTION_SCROLL, 5);
    expect(store._flushJump()).toEqual([0, false]);
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()[0]).toBe(25);
    expect(store._flushJump()).toEqual([0, false]);
  });

  it("defers the one-viewport cap escape through the tail and commits whole at rest (delta 2 supersession, CAP)", () => {
    const store = storeWith(10, 30);
    midTail(store);
    store._flushJump();
    // 1.5 viewports parked DURING the settle hand-off: ZW wins over the
    // escape — the backlog keeps parking and commits once, whole, after
    // the tail (deliberate supersession of the mid-hold escape; the
    // retained programmatic/burst escape is guarded in the burst block).
    store.$update(ACTION_RELAYOUT, 600);
    expect(store._flushJump()).toEqual([0, false]); // parked through the tail
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()[0]).toBe(600); // one full-magnitude commit
    expect(store._flushJump()).toEqual([0, false]); // backlog cleared
  });

  it("keeps #942's immediate writes while a marked imperative scroll is in flight during the tail", () => {
    const store = storeWith(10, 30);
    midTail(store); // settle armed
    // A marked imperative operation takes over the release contract (the
    // manual/smooth machinery is #942's); the settle term must not silently
    // park its backlog under it.
    store.$update(ACTION_MANUAL_SCROLL);
    store._flushJump();
    store.$update(ACTION_RELAYOUT, 25);
    expect(store._flushJump()).toEqual([25, false]);
  });
});

describe("non-gesture burst batching (FORK-CHANGES.md delta 7)", () => {
  // A re-point/remount transaction — the room-switch shape — commits a whole
  // batch of size corrections with no gesture at all. On every engine the
  // batch lands as ONE anchored commit through the remap-delta machinery,
  // not per-row writes. Ordinary in-place resizes (no remap armed) stay on
  // #942's immediate path: the batching is scoped to the transaction.
  const repoint = (store: VirtualStore) => {
    store._flushJump();
    expect(
      store.$remapItems({ previousLength: 10, order: [...Array(10).keys()] }),
    ).toBe(true);
  };

  it("commits a re-point's size batch as one anchored write on a WebKit-classified engine (delta 7)", () => {
    webkitFlag.value = true;
    const store = storeWith(10, 30);
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    repoint(store);
    // The remount/re-point wave: several previously-visible rows re-measure.
    store.$update(ACTION_ITEM_RESIZE, [
      [2, 60],
      [3, 60],
      [4, 60],
      [5, 60],
    ]);
    expect(store._flushJump()).toEqual([0, false]); // batch parked
    store.$update(ACTION_BURST_SETTLED); // observer's quiescence window elapsed
    expect(store._flushJump()[0]).toBeGreaterThan(0); // one anchored commit
    expect(store._flushJump()).toEqual([0, false]); // and nothing more
  });

  it("batches the burst on non-WebKit engines too — the vehicle is the remap, not the gesture (delta 7)", () => {
    webkitFlag.value = false; // Chromium/Firefox
    const store = storeWith(10, 30);
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    repoint(store);
    store.$update(ACTION_ITEM_RESIZE, [
      [2, 60],
      [3, 60],
      [4, 60],
      [5, 60],
    ]);
    expect(store._flushJump()).toEqual([0, false]); // parked, engine-agnostic
    store.$update(ACTION_BURST_SETTLED);
    expect(store._flushJump()[0]).toBeGreaterThan(0);
  });

  it("leaves ordinary in-place resizes on #942's immediate path (delta 7 scope)", () => {
    webkitFlag.value = false;
    const store = storeWith(10, 30);
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    // NO remap: this is a resize during plain scroll, not a transaction.
    store.$update(ACTION_ITEM_RESIZE, [
      [2, 60],
      [3, 60],
    ]);
    expect(store._flushJump()[0]).toBeGreaterThan(0); // written immediately
  });

  it("does not preempt an active WebKit settle hold — that release owns the one commit (delta 1 x 7)", () => {
    webkitFlag.value = true;
    const store = storeWith(10, 30);
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_USER_GESTURE, false); // settle armed mid-tail
    store._flushJump();
    store.$remapItems({ previousLength: 10, order: [...Array(10).keys()] });
    store.$update(ACTION_ITEM_RESIZE, [[2, 60]]);
    expect(store._flushJump()).toEqual([0, false]); // parked (both holds)
    store.$update(ACTION_BURST_SETTLED); // burst quiescence must not commit
    expect(store._flushJump()).toEqual([0, false]); // while the tail holds it
    store.$update(ACTION_SCROLL_END); // the tail's release commits once
    expect(store._flushJump()[0]).toBeGreaterThan(0);
  });

  it("does not arm on a rejected remap — invalid windows keep #942 immediacy (delta 7 scope)", () => {
    webkitFlag.value = false;
    const store = storeWith(10, 30);
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    store._flushJump();
    // order.length mismatch -> rejected, burst must NOT arm.
    expect(store.$remapItems({ previousLength: 10, order: [0, 1, 2] })).toBe(
      false,
    );
    store.$update(ACTION_ITEM_RESIZE, [[2, 60]]);
    expect(store._flushJump()[0]).toBeGreaterThan(0); // still immediate
  });

  it("keeps the cap escape immediate for a gesture-less burst (CAP retained half)", () => {
    // The ZW suppression of the escape keys on the gesture/settle flags;
    // a re-point burst with no user session escapes exactly as before —
    // a >1-viewport wave commits through the transaction (contract CAP,
    // FORK-CHANGES delta 2).
    webkitFlag.value = true;
    const store = storeWith(10, 30);
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300); // no gesture, no hold
    store._flushJump();
    expect(
      store.$remapItems({ previousLength: 10, order: [...Array(10).keys()] }),
    ).toBe(true);
    store.$update(ACTION_RELAYOUT, 600); // 1.5 viewports
    expect(store._flushJump()[0]).toBe(600); // escaped immediately
    store.$update(ACTION_BURST_SETTLED);
    expect(store._flushJump()).toEqual([0, false]);
  });
});

describe("burst ownership of its release across timers (R1, jam.3)", () => {
  // A scroll-end timer armed BEFORE a remap can fire mid-wave: the burst's
  // quiescence window (from its last delivery) extends past the scroll-end.
  // The live burst must own its release — scroll-end neither flushes the
  // partial wave nor disarms it — and the merged backlog commits once at
  // wave quiescence. All orderings yield exactly one write (FORK-CHANGES.md
  // delta 7).
  it("a live-wave burst at scroll-end keeps its release; the merged backlog commits once at wave quiescence", () => {
    const store = storeWith(10, 30);
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    store.$update(ACTION_USER_GESTURE, true);
    store._flushJump();
    expect(
      store.$remapItems({ previousLength: 10, order: [...Array(10).keys()] }),
    ).toBe(true); // burst armed mid-gesture; scroll-end timer already live
    store.$update(ACTION_ITEM_RESIZE, [
      [0, 60],
      [1, 60],
      [2, 60],
    ]); // wave delivery (+90) — parked
    store.$update(ACTION_SCROLL_END); // fires while the wave is still live
    expect(store._flushJump()).toEqual([0, false]); // no partial commit
    store.$update(ACTION_RELAYOUT, 40); // later wave correction (+40)
    expect(store._flushJump()).toEqual([0, false]); // still parked (burst owns)
    store.$update(ACTION_BURST_SETTLED); // wave quiescence
    expect(store._flushJump()).toEqual([130, false]); // one merged commit
    expect(store._flushJump()).toEqual([0, false]); // and nothing more
  });

  it("scroll-end's state resets still run while the burst defers its flush", () => {
    webkitFlag.value = true;
    const store = storeWith(10, 30);
    store.$update(ACTION_VIEWPORT_RESIZE, 400);
    store.$update(ACTION_SCROLL, 300);
    store.$update(ACTION_USER_GESTURE, true);
    store.$update(ACTION_USER_GESTURE, false); // settle armed (direction != IDLE)
    store._flushJump();
    store.$remapItems({ previousLength: 10, order: [...Array(10).keys()] });
    store.$update(ACTION_RELAYOUT, 30); // parked under hold AND burst
    store.$update(ACTION_SCROLL_END);
    expect(store._flushJump()).toEqual([0, false]); // deferred to the burst
    // The position IS settled now: with the burst flag still live the next
    // RELAYOUT parks ONLY via the burst term — a hold leak would park it
    // even after the burst commits, which the tail below rejects.
    store.$update(ACTION_RELAYOUT, 40);
    store.$update(ACTION_BURST_SETTLED);
    expect(store._flushJump()).toEqual([70, false]); // one merged commit
    store.$update(ACTION_RELAYOUT, 25);
    expect(store._flushJump()).toEqual([25, false]); // nothing parks after
  });
});
