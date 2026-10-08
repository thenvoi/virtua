import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { Virtualizer, type VirtualizerHandle } from "./react/index.js";
import {
  cleanupScroll,
  findFirstVisibleItem,
  getItem,
  getVirtualizer,
  relativeTop,
  scrollToEnd,
  SUBPIXEL,
} from "../spec/browser/index.js";
import { render, rerender } from "../spec/browser/react.js";
import { nextFrame, range } from "../spec/utils.js";
import type * as Observed from "./core/observer.js";
import type { VirtualStore } from "./core/store.js";
import type { ScrollObserver } from "./core/observer.js";

afterEach(cleanupScroll);

// P7a — Band fork correction-branch proof (FORK-CHANGES.md: deltas 1–3
// retired in favor of upstream #942). These cases pin, deterministically on
// Chromium/Firefox/WebKit, that the correction branches Band's vendored
// WKWebView deferral protected keep the reader's row still. They do not
// reproduce native trackpad momentum — the packaged macOS gate (P7b in tjam)
// owns that half.
//
// Two observation windows per correction (plan U1 step 5):
// - PROVENANCE: a narrow synchronous interval around the observer's
//   _fixScrollJump. The upstream observer exposes _sync/_dispose/
//   _fixScrollJump/_scroll — not scrollTo/scrollBy — and writes through the
//   scroller element inside _fixScrollJump: an absolute `scroller.scrollTo`
//   at the edges, a relative `scroller.scrollBy` mid-range. The vi.mock
//   factory wraps createScrollObserver so that, while an interval is open,
//   the store's _flushJump result is recorded (calling the original exactly
//   once and returning it unchanged — a second call would read a cleared
//   jump) and the scroller's writes are labeled. Imperative writes outside
//   the interval are ignored by construction.
// - OUTCOME: the anchor row's viewport position sampled BEFORE the inducing
//   mutation and compared AFTER the compensation dispatched (upstream's own
//   prepend-case pattern), within SUBPIXEL (exact on WebKit/Chromium, 1px on
//   Firefox). Dispatch entry/exit are never compared with each other — a
//   correct compensation moves the anchor back during the dispatch.

const witness: {
  open: boolean;
  flushes: [number, boolean][];
  writes: ("absolute" | "relative")[];
} = { open: false, flushes: [], writes: [] };

vi.mock("./core/observer.js", async (importOriginal) => {
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

// Suppress element writes to prove a case can fail: with the writes stubbed,
// the position never moves and the anchor sits at the raw geometry delta.
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

// Wait until scrolling has ended (debounce) and nothing changes for a few frames.
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

const List = ({
  items,
  shift,
}: {
  items: readonly string[];
  shift?: boolean;
}) => (
  <div style={{ height: 400, overflowY: "auto" }}>
    <Virtualizer data={items} itemSize={30} shift={shift}>
      {(item) => (
        <div key={item} style={{ height: 30 }}>
          {item}
        </div>
      )}
    </Virtualizer>
  </div>
);

describe("prepend committed between two scroll deliveries while scrolling toward the start (#367)", () => {
  it("preserves the ongoing upward motion: one relative correction, continuous trajectory", async () => {
    const ADDED = 40;
    let items = range(200, (i) => `item-${i}`);
    const root = render(<List items={items} />);
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "item-0")).toBeDefined();

    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150; // first delivered scroll — gesture becomes active
    await first;
    const anchor = findFirstVisibleItem(container, viewport)!;
    const afterFirst = relativeTop(viewport, anchor);

    // the older page commits in the gap between the two deliveries
    items = [...range(ADDED, (i) => `item-${i - ADDED}`), ...items];
    openWitness();
openWitness();
    rerender(root, <List items={items} shift />);
    // React root renders commit asynchronously — the shift correction lands
    // with the commit, so the witness stays open until a NONZERO jump
    // dispatches (zero-jump flushes from unrelated state bumps may come first).
    await expect
      .poll(() => witness.flushes.some(([jump]) => jump !== 0))
      .toBe(true);
    await nextFrame();
    closeWitness();

    // OUTCOME (plan U1 step 5): between the compensation dispatch and the
    // next deliberate scroll, the anchor row sits exactly where it sat
    // before the prepend committed. With the correction suppressed the rows
    // keep their document positions, the anchor drifts by the full shift
    // (or unmounts) and this fails before the trajectory step can mask it.
    expect(anchor.isConnected).toBe(true);
    expect(Math.abs(relativeTop(viewport, anchor) - afterFirst)).toBeLessThanOrEqual(
      SUBPIXEL,
    );

    const second = onceScroll(viewport);
    viewport.scrollTop -= 100; // the gesture's next delivered scroll
    await second;
    await nextFrame();

    // PROVENANCE: the shift transaction's correction was dispatched (a
    // nonzero flush), and every write while the witness was open was the
    // relative branch — an absolute write would overwrite the concurrent
    // scrolling, the #367 defect. Measurement follow-ups may legitimately
    // compensate in additional relative dispatches; none may go absolute.
    expect(witness.flushes.some(([jump]) => jump !== 0)).toBe(true);
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");

    // OUTCOME: scrolling UP 100px moves the anchor DOWN by 100 on screen; the
    // compensation contributed none of its own displacement.
    expect(
      Math.abs(relativeTop(viewport, anchor) - (afterFirst + 100)),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("edge corrections use the absolute branch", () => {
  it("absolute-top: removing rows at the start with shift dispatches the edge write at to <= 0", async () => {
    // Two measured rows above the viewport are removed from the start with
    // shift=true; the shift shrink prices both removals (-200) and the
    // scroll sits exactly at the old row-2 edge (from 200): to = 0 → the
    // absolute branch. (Filter-away-at-top is the shape Band's feed
    // produces; a zero-height ResizeObserver entry is engine-fragile, so
    // the edge is reached through the length-change path.)
    const handle = createRef<VirtualizerHandle>();
    let items = range(20, (i) => `row-${i}`);
    const root = render(
      <div style={{ height: 300, overflowY: "auto" }}>
        <Virtualizer ref={handle} data={items} itemSize={100}>
          {(item) => (
            <div key={item} style={{ height: 100 }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();

    viewport.scrollTop = 200; // top of row-2; rows 0–1 fully above
    await settle(viewport);
    // precondition: both rows above are MEASURED at 100 (their entries exist).
    await expect.poll(() => handle.current!.isUnmeasuredItem(0)).toBe(false);
    await expect.poll(() => handle.current!.isUnmeasuredItem(1)).toBe(false);
    const anchor = getItem(container, "row-2")!;
    const before = relativeTop(viewport, anchor); // 0 — top of viewport

    items = items.slice(2);
    openWitness();
    rerender(
      root,
      <div style={{ height: 300, overflowY: "auto" }}>
        <Virtualizer ref={handle} data={items} itemSize={100} shift>
          {(item) => (
            <div key={item} style={{ height: 100 }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    await expect
      .poll(() => witness.flushes.some(([jump]) => jump !== 0))
      .toBe(true);
    await nextFrame();
    closeWitness();

    // to(0) <= 0 → absolute; the reader keeps row-2 at the same spot.
    expect(witness.writes).toContain("absolute");
    expect(witness.writes).not.toContain("relative");
    expect(Math.abs(relativeTop(viewport, anchor) - before)).toBeLessThanOrEqual(
      SUBPIXEL,
    );
  });

  it("absolute-end: rows above the viewport growing at the bottom dispatches from >= end", async () => {
    const handle = createRef<VirtualizerHandle>();
    const root = render(
      <div style={{ height: 300, overflowY: "auto" }}>
        <Virtualizer ref={handle} data={range(20)} itemSize={100} keepMounted={[2]}>
          {(i) => (
            <div key={i} style={{ height: 100 }}>
              {i}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "0")).toBeDefined();

    scrollToEnd(viewport); // from >= end
    await settle(viewport);
    await expect.poll(() => getItem(container, "19")).toBeDefined();
    // keepMounted items render after the visible range in DOM order, so
    // select by content, not by position. precondition: row 2 measured.
    await expect.poll(() => getItem(container, "2")).toBeDefined();
    await expect.poll(() => handle.current!.isUnmeasuredItem(2)).toBe(false);

    // OUTCOME (plan U1 step 5): sample a visible row BEFORE the growth; the
    // absolute end-write must re-anchor it, not merely land at the end.
    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);

    // grow row 2 by 400px through a direct DOM mutation — the engine-robust
    // trigger proven by the resize case in the react-level suite.
    const grown = getItem(container, "2") as HTMLElement;
    openWitness();
    grown.style.height = "500px";
    await expect
      .poll(() => witness.flushes.some(([jump]) => jump !== 0))
      .toBe(true);
    await nextFrame();
    closeWitness();

    expect(witness.writes).toContain("absolute");

    // The same row, unMOVED by the growth — the outcome this case pins; the
    // distance-to-end check alone could pass by accident under suppression.
    expect(anchor.isConnected).toBe(true);
    expect(Math.abs(relativeTop(viewport, anchor) - before)).toBeLessThanOrEqual(
      SUBPIXEL,
    );

    // growing content above while the reader is at the end: the absolute
    // write re-anchors exactly at the grown end — not past it, not short.
    await expect
      .poll(() => viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight))
      .toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("suppression proves the #367 case can fail", () => {
  it("with element writes stubbed out, the anchor sits displaced by the raw growth", async () => {
    const ADDED = 40;
    let items = range(200, (i) => `item-${i}`);
    const root = render(<List items={items} />);
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "item-0")).toBeDefined();
    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150;
    await first;
    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);

    items = [...range(ADDED, (i) => `item-${i - ADDED}`), ...items];
    const suppressor = suppressCorrections(viewport);
    suppressor.arm();
    rerender(root, <List items={items} shift />);
    await expect
      .poll(() => witness.flushes.some(([jump]) => jump !== 0))
      .toBe(true);
    suppressor.disarm();
    await nextFrame();

    // the geometry above grew ADDED*30 = 1200px while the position did not.
    expect(Math.abs(relativeTop(viewport, anchor) - before)).toBeGreaterThan(
      1000,
    );
  });
});
