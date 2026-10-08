import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRef,
  type Ref,
  useImperativeHandle,
  useState,
} from "react";
import { Virtualizer, type VirtualizerHandle } from "./index.js";
import {
  cleanupScroll,
  findFirstVisibleItem,
  getItem,
  getVirtualizer,
  relativeTop,
  SUBPIXEL,
} from "../../spec/browser/index.js";
import { render, rerender } from "../../spec/browser/react.js";
import { delay, nextFrame, range } from "../../spec/utils.js";
// The witness mock wraps core's scroll observer, so its TYPE surface must be
// named where it lives; the zone rule exists to keep runtime code layered —
// these are type-only imports and the vi.mock path string must resolve to
// core/observer.js exactly.
/* eslint-disable import/no-restricted-paths */
import type * as Observed from "../core/observer.js";
import type { VirtualStore } from "../core/store.js";
import type { ScrollObserver } from "../core/observer.js";
/* eslint-enable import/no-restricted-paths */

afterEach(cleanupScroll);

// P7a, React level — retained-delta correction proof (FORK-CHANGES.md deltas
// 4–6). Same witness machinery as src/jam-corrections.browser.spec.tsx (see
// its header for the two-window contract); the mock path is relative to this
// directory. Instances run Chromium AND WebKit (fork vitest.config change),
// so every case here executes on the engine family whose correction behavior
// the retired deltas 1–3 protected.

const witness: {
  open: boolean;
  flushes: [number, boolean][];
  writes: ("absolute" | "relative")[];
} = { open: false, flushes: [], writes: [] };

vi.mock("../core/observer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Observed>();
  return {
    ...actual,
    createScrollObserver: (
      store: VirtualStore,
      ...rest: Parameters<typeof actual.createScrollObserver> extends [
        VirtualStore,
        ...infer R,
      ]
        ? R
        : never
    ) => {
      const scroller = rest[1] as HTMLElement;
      const originalFlushJump = store._flushJump;
      store._flushJump = () => {
        const result = originalFlushJump();
        if (witness.open) {
          witness.flushes.push(result);
        }
        return result;
      };
      const observer: ScrollObserver = actual.createScrollObserver(
        store,
        ...rest,
      );
      const originalFixScrollJump = observer._fixScrollJump;
      observer._fixScrollJump = () => {
        if (!witness.open) {
          return originalFixScrollJump();
        }
        const originalScrollTo = scroller.scrollTo;
        const originalScrollBy = scroller.scrollBy;
        scroller.scrollTo = ((...a: Parameters<HTMLElement["scrollTo"]>) => {
          witness.writes.push("absolute");
          return originalScrollTo.apply(scroller, a);
        }) as typeof scroller.scrollTo;
        scroller.scrollBy = ((...a: Parameters<HTMLElement["scrollBy"]>) => {
          witness.writes.push("relative");
          return originalScrollBy.apply(scroller, a);
        }) as typeof scroller.scrollBy;
        try {
          return originalFixScrollJump();
        } finally {
          scroller.scrollTo = originalScrollTo;
          scroller.scrollBy = originalScrollBy;
        }
      };
      return observer;
    },
  };
});

const openWitness = () => {
  witness.flushes = [];
  witness.writes = [];
  witness.open = true;
};
const closeWitness = () => {
  witness.open = false;
};

beforeEach(() => {
  witness.open = false;
  witness.flushes = [];
  witness.writes = [];
});

const suppressCorrections = (viewport: HTMLElement) => {
  const realScrollTo = viewport.scrollTo.bind(viewport);
  const realScrollBy = viewport.scrollBy.bind(viewport);
  let suppress = false;
  viewport.scrollTo = ((...a: Parameters<HTMLElement["scrollTo"]>) => {
    if (suppress) return;
    return realScrollTo(...a);
  }) as typeof viewport.scrollTo;
  viewport.scrollBy = ((...a: Parameters<HTMLElement["scrollBy"]>) => {
    if (suppress) return;
    return realScrollBy(...a);
  }) as typeof viewport.scrollBy;
  return {
    arm: () => {
      suppress = true;
      openWitness();
    },
    disarm: () => {
      suppress = false;
      closeWitness();
    },
  };
};

const settle = async (viewport: HTMLElement) => {
  let lastScrollTime = performance.now();
  const onScroll = () => {
    lastScrollTime = performance.now();
  };
  viewport.addEventListener("scroll", onScroll);
  do {
    await nextFrame();
    await nextFrame();
  } while (performance.now() - lastScrollTime < 200);
  viewport.removeEventListener("scroll", onScroll);
};

const onceScroll = (viewport: HTMLElement) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  viewport.addEventListener("scroll", () => resolve(), { once: true });
  return promise;
};

const EST_ROWS = 500;
const EST_BASE = 30;
const EST_SWAPPED = 45;

const EstimatorList = ({
  ref,
}: {
  ref: Ref<{ swap: () => void }>;
}) => {
  const [swapped, setSwapped] = useState(false);
  useImperativeHandle(ref, () => ({ swap: () => setSwapped(true) }), []);
  // a real swap: distinct reference, different per-index pricing
  const estimator = swapped
    ? (index: number) => (index < 100 ? EST_BASE : EST_SWAPPED)
    : () => EST_BASE;
  return (
    <div style={{ height: 400, overflowY: "auto" }}>
      <Virtualizer data={range(EST_ROWS)} itemSize={estimator}>
        {(i) => <div>{i}</div>}
      </Virtualizer>
    </div>
  );
};

describe("estimator swap during scrolling (delta 5)", () => {
  it("recompensates the visible anchor through one relative correction", async () => {
    const ref = createRef<{ swap: () => void }>();
    const root = render(<EstimatorList ref={ref} />);
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "0")).toBeDefined();

    viewport.scrollTop = 6000; // deep into unmeasured estimated territory
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150; // gesture active
    await first;
    const anchor = findFirstVisibleItem(container, viewport)!;
    const afterFirst = relativeTop(viewport, anchor);

    openWitness();
    ref.current!.swap(); // new estimator, new reference — during the gesture
    await expect
      .poll(() => witness.flushes.some(([jump]) => jump !== 0))
      .toBe(true);
    await nextFrame();
    closeWitness();
    await nextFrame();

    // Rows ABOVE the anchor were priced at 30 and are now priced at 45 while
    // still unmeasured — a geometry mutation that must compensate exactly.
    expect(witness.flushes.some(([jump]) => jump !== 0)).toBe(true);
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");

    expect(Math.abs(relativeTop(viewport, anchor) - afterFirst)).toBeLessThanOrEqual(
      SUBPIXEL,
    );
  });

  it("verify-red: with the correction suppressed the anchor moves by the repricing", async () => {
    const ref = createRef<{ swap: () => void }>();
    const root = render(<EstimatorList ref={ref} />);
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "0")).toBeDefined();
    viewport.scrollTop = 6000;
    await settle(viewport);
    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);

    const suppressor = suppressCorrections(viewport);
    suppressor.arm();
    ref.current!.swap();
    await delay(100);
    suppressor.disarm();
    await nextFrame();

    // 100 rows above the anchor repriced 30 → 45 = +1500px unaccounted.
    expect(Math.abs(relativeTop(viewport, anchor) - before)).toBeGreaterThan(
      1000,
    );
  });
});

describe("remap after a prepend (delta 6)", () => {
  it("completing the shift transaction keeps the anchor and dispatches nothing further", async () => {
    const ADDED = 20;
    const handle = createRef<VirtualizerHandle>();
    // The first seven rows are 60px tall while every other row is 30px, so
    // measured identity is observable: with the remap applied, the 60px cache
    // entries must sit at the shifted indices; with a no-op remap they stay
    // behind, still claiming indices 0–6 are 60px.
    const heightOf = (item: string) => {
      const n = Number(item.slice("item-".length));
      return n >= 0 && n < 7 ? 60 : 30;
    };
    let items = range(200, (i) => `item-${i}`);
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer ref={handle} data={items} itemSize={30}>
          {(item) => (
            <div key={item} style={{ height: heightOf(item) }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "item-0")).toBeDefined();
    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150;
    await first;
    const anchor = findFirstVisibleItem(container, viewport)!;
    const afterFirst = relativeTop(viewport, anchor);

    items = [...range(ADDED, (i) => `item-${i - ADDED}`), ...items];
    openWitness();
    rerender(
      root,
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer ref={handle} data={items} itemSize={30} shift>
          {(item) => (
            <div key={item} style={{ height: heightOf(item) }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    // React root renders commit asynchronously; the shift correction lands
    // with the commit, so keep the witness open until a NONZERO jump lands.
    await expect
      .poll(() => witness.flushes.some(([jump]) => jump !== 0))
      .toBe(true);
    await nextFrame();
    closeWitness();

    // the shift commit's correction: a nonzero flush, and only relative writes
    expect(witness.flushes.some(([jump]) => jump !== 0)).toBe(true);
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");

    // identity remap completing the shift transaction: every new index i >=
    // ADDED names previous index i - ADDED; the prepended rows name -1.
    openWitness();
    expect(
      handle.current!.remapItems({
        previousLength: 200,
        order: [
          ...range(ADDED, () => -1),
          ...range(200, (i) => i),
        ],
      }),
    ).toBe(true);
    await nextFrame();
    closeWitness();

    // The remap itself must not displace the reader: geometry was already
    // compensated by the shift transaction it completes. (Unrelated
    // measurement follow-ups may write; the anchor check is the contract.)
    expect(Math.abs(relativeTop(viewport, anchor) - afterFirst)).toBeLessThanOrEqual(
      SUBPIXEL,
    );

    // Remap-specific outcome: a same-length reorder moves identity that NO
    // shift transaction can express — the measured 60px row (index 20 = old
    // item-0) swaps with an unmeasured row far below (index 100), and the
    // cache sizes must follow the content. Under a no-op remap the measured
    // entry stays behind at index 20: every later correction, offset, and
    // removal would then be priced for the wrong rows. This is what makes
    // the case distinguish remapItems from `() => true`; the mounted
    // reader's rows are unaffected either way (both swapped rows sit above
    // the mounted range and their total below it is unchanged), so the
    // anchor-stability contract still holds.
    const swapped = [...items];
    const movedRow = swapped[20]!;
    swapped[20] = swapped[100]!;
    swapped[100] = movedRow;
    items = swapped;
    rerender(
      root,
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer ref={handle} data={items} itemSize={30}>
          {(item) => (
            <div key={item} style={{ height: heightOf(item) }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const order = range(items.length, (i) => i);
    const movedOrder = order[20]!;
    order[20] = order[100]!;
    order[100] = movedOrder;
    openWitness();
    expect(
      handle.current!.remapItems({ previousLength: items.length, order }),
    ).toBe(true);
    await nextFrame();
    closeWitness();
    expect(witness.flushes.every(([jump]) => jump === 0)).toBe(true);
    // The measured size followed the content, and the never-measured slot
    // reads the estimate — under a stale identity these two are swapped.
    expect(handle.current!.getItemSize(100)).toBe(60);
    expect(handle.current!.getItemSize(20)).toBe(30);
    expect(Math.abs(relativeTop(viewport, anchor) - afterFirst)).toBeLessThanOrEqual(
      SUBPIXEL,
    );

    const second = onceScroll(viewport);
    viewport.scrollTop -= 100;
    await second;
    await nextFrame();
    // up-100 gesture ⇒ anchor +100 down on screen; remap contributed nothing.
    expect(
      Math.abs(relativeTop(viewport, anchor) - (afterFirst + 100)),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("cached row identity across a correction-producing resize (delta 4)", () => {
  it("reuses mounted rows while the correction dispatches — caching alone produces no jump", async () => {
    const DATA = range(200, (i) => `row-${i}`);
    const renderRow = vi.fn((item: string) => <div>{item}</div>);
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        {/* index 49's bottom rests exactly at the viewport top once settled
        at 3000; keepMounted guarantees that fully-above row is mounted on
        every engine regardless of the range boundary, so the grown-row
        selection below is deterministic, not subpixel-dependent. */}
        <Virtualizer data={DATA} itemSize={60} keepMounted={[49]}>
          {renderRow}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();

    viewport.scrollTop = 3000;
    await settle(viewport);
    const mountedBefore = new Set(renderRow.mock.calls.map(([item]) => item));
    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);

    // Grow a mounted row ABOVE the viewport directly on the DOM — the
    // consumer did not re-render, so the render function and data keep their
    // identity. A row whose bottom rests at or above the viewport top is
    // compensated by shouldKeep (idle, upward rule).
    const viewportTop = viewport.getBoundingClientRect().top;
    const grown = [...container.children]
      .reverse()
      .find(
        (e) =>
          e !== anchor &&
          e.getBoundingClientRect().bottom <= viewportTop + 1,
      ) as HTMLElement;
    openWitness();
    grown.style.height = `${grown.getBoundingClientRect().height + 180}px`;
    await expect
      .poll(() => witness.flushes.some(([jump]) => jump !== 0))
      .toBe(true);
    await nextFrame();
    closeWitness();
    await nextFrame();

    // PROVENANCE: the resize correction dispatched exactly one nonzero jump.
    expect(witness.flushes.some(([jump]) => jump !== 0)).toBe(true);

    // IDENTITY: the correction-driven re-render must not have re-invoked the
    // render function for any already-mounted row — the element cache held.
    // (Freshly mounted indices entering the range may be invoked; that's the
    // virtualizer working, not the cache failing.)
    const reInvoked = renderRow.mock.calls
      .slice([...mountedBefore].length)
      .filter(([item]) => mountedBefore.has(item));
    expect(reInvoked).toEqual([]);

    // OUTCOME: the anchor stayed put across the correction.
    expect(Math.abs(relativeTop(viewport, anchor) - before)).toBeLessThanOrEqual(
      SUBPIXEL,
    );
  });

});
