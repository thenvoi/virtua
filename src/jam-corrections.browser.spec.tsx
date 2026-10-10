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
import { delay, nextFrame, range } from "../spec/utils.js";
import type * as Observed from "./core/observer.js";
import {
  ACTION_SCROLL_END,
  ACTION_USER_GESTURE,
  type VirtualStore,
} from "./core/store.js";
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
  seq: ("scroll-end" | "gesture" | ["flush", number])[];
} = { open: false, flushes: [], writes: [], seq: [] };
// Seam for the one case that must fire a scroll-end at an exact point of a
// measurement wave (timers alone cannot be aligned against ResizeObserver
// deliveries): the wrapped store.$update, assigned inside the mock's
// observer factory, so the marker still lands on the witness timeline.
const seam: { update?: VirtualStore["$update"] } = {};

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
          witness.seq.push(["flush", result[0]]);
        }
        return result;
      };
      const originalUpdate = store.$update;
      store.$update = (...args: Parameters<VirtualStore["$update"]>): void => {
        if (witness.open) {
          if (args[0] === ACTION_SCROLL_END) witness.seq.push("scroll-end");
          else if (args[0] === ACTION_USER_GESTURE && args[1])
            witness.seq.push("gesture");
        }
        originalUpdate(...args);
      };
      seam.update = store.$update;
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
  witness.seq = [];
  witness.open = true;
};
const closeWitness = () => {
  witness.open = false;
};

beforeEach(() => {
  witness.open = false;
  witness.flushes = [];
  witness.writes = [];
  witness.seq = [];
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
    expect(
      Math.abs(relativeTop(viewport, anchor) - afterFirst),
    ).toBeLessThanOrEqual(SUBPIXEL);

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
    expect(
      Math.abs(relativeTop(viewport, anchor) - before),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });

  it("absolute-end: rows above the viewport growing at the bottom dispatches from >= end", async () => {
    const handle = createRef<VirtualizerHandle>();
    const root = render(
      <div style={{ height: 300, overflowY: "auto" }}>
        <Virtualizer
          ref={handle}
          data={range(20)}
          itemSize={100}
          keepMounted={[2]}
        >
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
    expect(
      Math.abs(relativeTop(viewport, anchor) - before),
    ).toBeLessThanOrEqual(SUBPIXEL);

    // growing content above while the reader is at the end: the absolute
    // write re-anchors exactly at the grown end — not past it, not short.
    await expect
      .poll(
        () =>
          viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight),
      )
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

describe("cumulative mid-gesture paging batch (F7 magnitude pin)", () => {
  it("prices a quarter-viewport paging batch once, at gesture end, in one relative write", async () => {
    // The F7 trigger shape, deterministic: paging a page of history DURING a
    // decelerating gesture — the shift transaction prices +120px (30% of the
    // viewport) through applyJump, exactly the cumulative write the owner's
    // frames showed. On a WebKit-classified engine the write must stay
    // parked while the observer's gesture seam is active — no nonzero flush
    // may precede the scroll-end marker — and land as exactly one relative
    // write at gesture end. On other engines #942 governs: the batch is
    // priced immediately, mid-gesture. Either branch ends with the anchor
    // row exactly where it started; a guard that misses this write path
    // flips the ordering assertion, deterministically, in fork CI.
    const ADDED = 4;
    let items = range(200, (i) => `item-${i}`);
    const root = render(<List items={items} />);
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "item-0")).toBeDefined();

    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150; // gesture active: direction UP, debounce armed
    await first;
    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);

    openWitness();
    // The seam is driven with GESTURE-TYPE signals, not real wheel/touch
    // events: WebKit scrolls the viewport for dispatched WheelEvents even
    // when preventDefault-ed (the assertion below needs pulses with ZERO
    // motion), and synthetic Touch objects are unavailable/inconsistent
    // across the three engines. Plain Events of the same type invoke the
    // observer's own onTouchStart/onTouchEnd handlers — the identical
    // production seam path — with no default action anywhere.
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart"); // seam ON, gesture held open
    // The paging commit lands while the gesture is still active.
    items = [...range(ADDED, (i) => `item-${i - ADDED}`), ...items];
    rerender(root, <List items={items} shift />);
    // Deceleration tail: re-issued starts hold the touch (and the seam) open,
    // then one lift ends the gesture.
    for (let k = 0; k < 2; k++) {
      await delay(80);
      touch("touchstart");
    }
    await delay(40);
    touch("touchend"); // release: debounce runs out → scroll end → price

    const webkitEngine =
      /AppleWebKit/.test(navigator.userAgent) &&
      !/Chrom(e|ium)|Edg\//.test(navigator.userAgent);
    if (webkitEngine) {
      // Parked while the seam is active: the first nonzero flush lands on
      // the timeline only after the scroll-end marker. (The release itself
      // may already be recorded by the time this polls — so compare
      // positions on the interleaved timeline, never array contents.)
      await expect.poll(() => witness.seq.includes("scroll-end")).toBe(true);
      await expect
        .poll(() => {
          const priced = witness.seq.findIndex(
            (e) => Array.isArray(e) && e[1] !== 0,
          );
          return priced > witness.seq.indexOf("scroll-end");
        })
        .toBe(true);
    } else {
      // #942 immediate pricing on Chromium/Firefox.
      await expect
        .poll(() => witness.flushes.some(([jump]) => jump !== 0))
        .toBe(true);
    }

    await nextFrame();
    closeWitness();
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");
    expect(anchor.isConnected).toBe(true);
    // OUTCOME: the batch net-zeroed against the anchor — the owner's
    // quarter-viewport 1-frame displacement, bounded to subpixel.
    expect(
      Math.abs(relativeTop(viewport, anchor) - before),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("momentum tail past gesture release (jam.3 settle-keyed hold)", () => {
  it("parks tail-revealed corrections until the position settles, then commits once on WebKit", async () => {
    // The owner's deceleration shape, deterministic: the gesture releases
    // while the position keeps moving (lift-off / wheel pulses stopping
    // before the tail does), rows the tail reveals measure mid-tail, and
    // their corrections must stay parked — WKWebView reverts a write into a
    // still-moving scroller, the one-frame drop-and-return. On WebKit the
    // witness timeline must show NO flush before the stability window has
    // elapsed and EXACTLY ONE anchored flush after it (delta 1 revision).
    // On Chromium/Firefox #942's immediate pricing governs (drive: plain
    // Event touch pulses + delivered position deltas — the engine-safe
    // equivalent, per the F7 follow-on).
    const ROW = 100;
    const items = range(60, (i) => `row-${i}`);
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer data={items} itemSize={ROW}>
          {(item) => (
            <div key={item} style={{ height: ROW }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();

    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150; // a delivered scroll: the engine is scrolling
    await first;
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart"); // seam ON (the identical production entry)
    touch("touchend"); // release at lift-off — jam.2 stops holding HERE

    // The momentum tail: position deltas keep arriving with the gesture
    // flag gone. Each pulse re-arms the observer's stability window.
    // travelPx records the DELIBERATE travel applied after the anchor's
    // before-sample (R2): the expected relative position is
    // before + travelPx — the correction must contribute nothing to it,
    // and a suppressed compensation moves the anchor by the growth.
    let travelPx = 0;
    let countTravel = false;
    const pulse = async (delta: number) => {
      const scrolled = onceScroll(viewport);
      viewport.scrollTop -= delta;
      if (countTravel) travelPx += delta;
      await scrolled;
    };
    for (let k = 0; k < 2; k++) {
      await delay(50);
      await pulse(50);
    }
    // Stay off the start edge: the delta-3 early release must not fire —
    // the backlog releases at settle, through the single flush path.
    expect(viewport.scrollTop).toBeGreaterThan(400);

    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);
    countTravel = true;

    openWitness();
    // The row directly above the reader's anchor grows +150px — the
    // correction the deceleration reveals, priced mid-tail. Fully above the
    // viewport top by construction (findFirstVisibleItem returned the row
    // below it) and mounted through the buffer, so resize() keeps it and
    // prices the full delta.
    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;

    const webkitEngine =
      /AppleWebKit/.test(navigator.userAgent) &&
      !/Chrom(e|ium)|Edg\//.test(navigator.userAgent);

    // Keep the tail moving while the wave measures (async poll callbacks
    // re-armed each frame keep the stability window open).
    await expect
      .poll(async () => {
        await pulse(40);
        return parseFloat(container.style.height);
      })
      .toBe(60 * ROW + 150);

    if (webkitEngine) {
      // Parked while the position changes: zero commits so far.
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
      for (let k = 0; k < 3; k++) {
        await delay(50);
        await pulse(40);
        expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
      }
      // Settle: stop moving; the stability window elapses — the fire at
      // +150 extends once to SETTLE_STABILITY (delta 1, jam.3 final) —
      // then scroll-end and the one anchored flush, ordered strictly
      // after the scroll-end marker. The timeout covers the extended
      // window plus a loaded machine's timer slack.
      await expect
        .poll(() => witness.seq.includes("scroll-end"), { timeout: 3000 })
        .toBe(true);
      await expect
        .poll(() => {
          const priced = witness.seq.findIndex(
            (e) => Array.isArray(e) && e[1] !== 0,
          );
          return priced > witness.seq.indexOf("scroll-end");
        })
        .toBe(true);
    } else {
      // #942 immediate pricing: the correction lands mid-tail — the
      // leak-proof side: an engine-gate leak parks it and times this out.
      await expect
        .poll(() => witness.flushes.some(([jump]) => jump !== 0))
        .toBe(true);
    }

    await delay(200); // let any premature or double commit land
    await nextFrame();
    closeWitness();
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");
    expect(anchor.isConnected).toBe(true);
    // OUTCOME (R2 amended form): expected = before + the deliberate pulse
    // travel, NO growth term — the compensation cancels the growth out of
    // the relative position. Compensated: relativeTop' = (D0 + g) -
    // (s0 - travelPx + g) = before + travelPx. Suppressed: before +
    // travelPx + g — rejected by the full growth (the document-space form
    // this replaces was blind to exactly that difference).
    expect(
      Math.abs(relativeTop(viewport, anchor) - (before + travelPx)),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("delivered-event gap inside the settle window (delta 1, jam.3 final)", () => {
  it("a tail gap past the plain debounce keeps the hold: one merged commit, never two", async () => {
    // The owner's ~50px residual shape: on a 120 Hz tail the DELIVERED
    // scroll events can gap longer than the 150 ms debounce — the
    // scroll-end timer fires mid-gap, and pre-fix that released the hold
    // and flushed, so stragglers measured after the gap landed
    // post-release (two writes; WKWebView reverts one). The final
    // observer re-arms such a fire once to SETTLE_STABILITY (300 ms
    // total position silence) while the hold is active, so the
    // straggler delivery parks into the same merged commit.
    // Leak-proof: without the extension WebKit has scroll-end and a
    // write before the gap poll (red here); if the extension leaked to
    // non-WebKit engines they would park instead of #942's immediate
    // pricing — the two-write assertion there catches it.
    const ROW = 100;
    const items = range(60, (i) => `row-${i}`);
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer data={items} itemSize={ROW}>
          {(item) => (
            <div key={item} style={{ height: ROW }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();

    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150; // a delivered scroll: the engine is moving
    await first;
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    touch("touchend"); // release into the moving position — hold armed

    let travelPx = 0;
    let countTravel = false;
    const pulse = async (delta: number) => {
      const scrolled = onceScroll(viewport);
      viewport.scrollTop -= delta;
      if (countTravel) travelPx += delta;
      await scrolled;
    };
    for (let k = 0; k < 2; k++) {
      await delay(50);
      await pulse(50);
    }
    expect(viewport.scrollTop).toBeGreaterThan(400); // off the start edge

    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);
    countTravel = true;

    openWitness();
    // Delivery 1 lands mid-tail — the row above the straddling anchor,
    // fully above the viewport top and mounted through the buffer.
    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;
    await expect
      .poll(async () => {
        await pulse(40);
        return parseFloat(container.style.height);
      })
      .toBe(60 * ROW + 150);

    const webkitEngine =
      /AppleWebKit/.test(navigator.userAgent) &&
      !/Chrom(e|ium)|Edg\//.test(navigator.userAgent);

    // The straggler delivery grows the SAME row again: one more measured
    // delta (the continuation of an in-place layout shift), and that row is
    // the mounted one — no new mount can be required mid-window (the
    // backward buffer extends only at scroll-end, which the hold defers).
    if (webkitEngine) {
      // The gap: position silence PAST the plain debounce but inside the
      // stability window. The fire at +150 re-armed the hold — no
      // scroll-end marker and no commit may exist at +220.
      await delay(220);
      expect(witness.seq.includes("scroll-end")).toBe(false);
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
      // The straggler's delta, landed while still inside the window (with
      // the fix the release cannot precede it).
      grown!.style.height = `${2 * ROW + 80}px`;
      await expect
        .poll(() => parseFloat(container.style.height))
        .toBe(60 * ROW + 180);
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
      await expect
        .poll(() => witness.seq.includes("scroll-end"), { timeout: 3000 })
        .toBe(true);
    } else {
      // #942 immediate pricing, untouched: delivery 1 already wrote
      // mid-tail...
      await expect
        .poll(() => witness.flushes.some(([jump]) => jump !== 0))
        .toBe(true);
      await delay(220); // ...the plain debounce released as before —
      expect(witness.seq.includes("scroll-end")).toBe(true); // the extension
      // must NOT reach here: scroll-end already fired at the plain 150 ms.
      grown!.style.height = `${2 * ROW + 80}px`;
      await expect
        .poll(() => parseFloat(container.style.height))
        .toBe(60 * ROW + 180);
    }

    await expect
      .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length, {
        timeout: 3000,
      })
      .toBe(webkitEngine ? 1 : 2);
    await delay(250); // let any premature or double commit land
    await nextFrame();
    closeWitness();
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(
      webkitEngine ? 1 : 2,
    );
    if (webkitEngine) {
      expect(
        witness.seq.findIndex((e) => Array.isArray(e) && e[1] !== 0) >
          witness.seq.indexOf("scroll-end"),
      ).toBe(true);
    }
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");
    expect(anchor.isConnected).toBe(true);
    // The R2 amended outcome: before + deliberate travel, no growth.
    expect(
      Math.abs(relativeTop(viewport, anchor) - (before + travelPx)),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("dense tail with a mid-gap: event-driven hold (jam.3 final, probe a)", () => {
  it("covers the whole ~1 s tail and flushes once after the last signal", async () => {
    // The owner's hard-fling shape: the OS momentum model streams signals
    // for close to a second — dense ~40 ms cadence with one legacy ~200 ms
    // delivery gap in the middle. The hold must ride ALL of it (no fixed
    // budget): the gap fire re-arms the stability window instead of
    // releasing, and the ONE flush lands ~window after the LAST signal.
    // Under no extension at all the gap fire releases and the post-gap
    // corrections write a second time — red here (the gap sits past the
    // plain debounce).
    const ROW = 100;
    const items = range(60, (i) => `row-${i}`);
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer data={items} itemSize={ROW}>
          {(item) => (
            <div key={item} style={{ height: ROW }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150;
    await first;
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    touch("touchend"); // release into the tail

    let travelPx = 0;
    let countTravel = false;
    const pulse = async (delta: number) => {
      const scrolled = onceScroll(viewport);
      viewport.scrollTop -= delta;
      if (countTravel) travelPx += delta;
      await scrolled;
    };
    for (let k = 0; k < 3; k++) {
      await delay(40);
      await pulse(20);
    }
    expect(viewport.scrollTop).toBeGreaterThan(400);

    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);
    countTravel = true;
    openWitness();

    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;

    // Dense phase continues (the measurement lands mid-tail).
    await expect
      .poll(async () => {
        await pulse(20);
        return parseFloat(container.style.height);
      })
      .toBe(60 * ROW + 150);
    for (let k = 0; k < 6; k++) {
      await delay(40);
      await pulse(20);
    }
    const webkitEngine =
      /AppleWebKit/.test(navigator.userAgent) &&
      !/Chrom(e|ium)|Edg\//.test(navigator.userAgent);
    // Mid-tail: WebKit has parked everything (zero commits); the #942
    // engines wrote the correction immediately (exactly one).
    if (webkitEngine) {
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    } else {
      await expect
        .poll(() => witness.flushes.some(([jump]) => jump !== 0))
        .toBe(true);
    }
    // The legacy mid-gap: silence PAST the 150 debounce but inside the
    // stability window — the held fire must extend, not release. On the
    // #942 engines the plain debounce released here, as it always did.
    await delay(210);
    if (webkitEngine) {
      expect(witness.seq.includes("scroll-end")).toBe(false);
    } else {
      await expect
        .poll(() => witness.seq.includes("scroll-end"), { timeout: 1000 })
        .toBe(true);
    }
    for (let k = 0; k < 4; k++) {
      await delay(40);
      await pulse(20);
    }
    // The long tail continues past the old 300 ms budget.
    for (let k = 0; k < 8; k++) {
      await delay(40);
      await pulse(20);
    }
    if (webkitEngine) {
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    }
    // A late measurement landing INSIDE the trailing window (the reviewer's
    // +50-at-+290 shape): accepted epoch semantics — the correction parks
    // behind the still-held window and rides its single re-sync; the visible
    // consequence is the row's own reflow at the merge. Restarting the
    // window on merge activity was adjudicated a non-item (it would only
    // defer the invisible at-rest re-sync and starve it on a continuously
    // measuring list). Non-WebKit: #942's immediate second write, as always.
    await delay(120);
    const topAbove = findFirstVisibleItem(container, viewport)!
      .previousElementSibling as HTMLElement | null;
    expect(topAbove).toBeTruthy();
    topAbove!.style.height = `${ROW + 30}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 180);
    if (webkitEngine) {
      // Parked, not written — the deadline rides the LAST pulse (+300), so
      // the merged commit lands after this check, asserted below.
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    }

    // Quiet: one flush, after the marker, on WebKit; the #942 engines
    // wrote both deltas immediately at their resizes.
    if (webkitEngine) {
      await expect
        .poll(() => witness.seq.includes("scroll-end"), { timeout: 3000 })
        .toBe(true);
    }
    // eslint-disable-next-line no-console
    if (webkitEngine) {
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length, {
          timeout: 3000,
        })
        .toBe(1);
      await delay(250);
      await nextFrame();
      closeWitness();
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
      expect(
        witness.seq.findIndex((e) => Array.isArray(e) && e[1] !== 0) >
          witness.seq.indexOf("scroll-end"),
      ).toBe(true);
    } else {
      // #942 engines: corrections land as immediate per-resize writes; how
      // many renders a 1.2 s synthetic journey spends on them is the
      // engine's own unchanged business — at least one, and stability.
      await expect
        .poll(() => witness.flushes.some(([jump]) => jump !== 0))
        .toBe(true);
      await delay(250);
      await nextFrame();
      closeWitness();
    }
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");
    expect(anchor.isConnected).toBe(true);
    expect(
      Math.abs(relativeTop(viewport, anchor) - (before + travelPx)),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("flick during a pending flush: preemption (jam.3 final, probes e/f/h)", () => {
  it("writes nothing while the gesture stream runs, one flush after it rests", async () => {
    // The owner's third face: a rubber-band flick begun while the settle
    // release is scheduled — his next gesture must not be eaten by the
    // pending programmatic write. macOS delivers elastic overshoot as
    // wheel/scroll activity; the synthetic stream here is wheel-only (the
    // gappy-delivery worst case: no scroll events to slide the timer).
    // Under the shipped one-shot extension the stream cannot push the
    // armed timer: the flush lands mid-flick and the zero-write assertion
    // reddens. Under the event-driven hold every wheel slides the
    // deadline: zero writes during the stream (e + h), then exactly ONE
    // anchored flush once position and backlog rest (f). Non-WebKit
    // engines never park a correction here (#942 immediate) — the
    // one-write total pins that nothing leaked to them.
    const ROW = 100;
    const items = range(60, (i) => `row-${i}`);
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer data={items} itemSize={ROW}>
          {(item) => (
            <div key={item} style={{ height: ROW }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150;
    await first;
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    touch("touchend"); // release into the tail
    let travelPx = 0;
    let countTravel = false;
    const pulse = async (delta: number) => {
      const scrolled = onceScroll(viewport);
      viewport.scrollTop -= delta;
      if (countTravel) travelPx += delta;
      await scrolled;
    };
    for (let k = 0; k < 2; k++) {
      await delay(50);
      await pulse(50);
    }
    expect(viewport.scrollTop).toBeGreaterThan(400);

    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);
    countTravel = true; // deliberate travel after the sample is ZERO below
    openWitness();
    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 150);

    // The flick: on a Mac trackpad rubber-band this phase is pure
    // WHEEL/SCROLL traffic — no touch events exist — so it is simulated
    // wheel-only for ~480 ms, starting 50 ms after the tail's last
    // signal, the scheduled release's window open. The stopper cancels
    // the wheel default action (untrusted wheels scroll WebKit for real;
    // the dispatch must be cancelable for that): the stream is pure
    // SIGNAL, no position change — exactly the gappy-delivery shape.
    // Without the wheel-fold the pending timer fires mid-stream (its
    // only push sources are scroll events and the touching/wheeling
    // flags, none of which a trackpad flick sets); with it every wheel
    // slides the deadline and nothing writes until the stream rests.
    await delay(50);
    const stopper = (e: Event) => e.preventDefault();
    viewport.addEventListener("wheel", stopper);
    const wheel = () =>
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -10,
          bubbles: true,
          cancelable: true,
        }),
      );
    for (let k = 0; k < 12; k++) {
      await delay(80);
      await wheel();
      if (k === 9) {
        // Deep inside the stream — past where any timer-only flush could
        // land (last signal + 300 window, even restart-chained): nothing
        // may be written while hand on glass. Non-WebKit wrote once at
        // the resize (#942 immediate) and nothing since.
        expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(
          /AppleWebKit/.test(navigator.userAgent) &&
            !/Chrom(e|ium)|Edg\//.test(navigator.userAgent)
            ? 0
            : 1,
        );
      }
    }
    viewport.removeEventListener("wheel", stopper);

    await expect
      .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length, {
        timeout: 3000,
      })
      .toBe(1);
    await delay(250); // let a premature or double commit land
    await nextFrame();
    closeWitness();
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");
    expect(anchor.isConnected).toBe(true);
    expect(
      Math.abs(relativeTop(viewport, anchor) - (before + travelPx)),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("re-point burst commits once (jam.3 delta 7)", () => {
  it("a remap transaction's size wave lands as ONE batched anchored write, on every engine", async () => {
    // The room-switch shape without any gesture: the list re-points and a
    // batch of rows re-measures. jam.2 wrote each ResizeObserver delivery
    // separately — the visible jump. The burst batching is engine-agnostic
    // (no revert is involved; the vehicle is the remap, not the engine):
    // the whole wave parks and lands as ONE anchored commit at quiescence,
    // the same stability window as scroll-end.
    const ROW = 100;
    const items = range(30, (i) => `row-${i}`);
    const handle = createRef<VirtualizerHandle>();
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer ref={handle} data={items} itemSize={ROW}>
          {(item) => (
            <div key={item} style={{ height: ROW }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    viewport.scrollTop = 1250;
    await settle(viewport);
    // Scroll-end extends the buffer backwards and commits asynchronously;
    // the row we grow is only in the DOM once that render lands. Poll it —
    // Firefox can lag a frame behind settle() (the other cases' pattern).
    await expect
      .poll(() => getItem(container, "row-10"), { timeout: 5000 })
      .toBeDefined();

    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);
    // No travel counter here: this window has no deliberate motion at all.

    openWitness();
    // The transaction: identity re-point of a same-length list (the
    // room-switch remap arm of delta 6's machinery).
    expect(
      handle.current!.remapItems({
        previousLength: 30,
        order: range(30, (i) => i),
      }),
    ).toBe(true);
    // The wave arrives in TWO deliveries, a frame apart — jam.2 writes
    // twice here. Both rows sit fully above the viewport top, so every
    // pixel is anchor-relevant.
    const grownA = getItem(container, "row-10") as HTMLElement;
    grownA.style.height = `${ROW + 140}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(30 * ROW + 140);
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    expect(witness.writes.length).toBe(0);
    const grownB = getItem(container, "row-11") as HTMLElement;
    grownB.style.height = `${ROW + 40}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(30 * ROW + 140 + 40);
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    expect(witness.writes.length).toBe(0); // the whole wave parked
    // Quiescence: 150ms after the LAST wave correction lands, the batch
    // commits exactly once.
    await expect
      .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length)
      .toBe(1);
    await delay(250); // a premature or per-delivery commit would show by now
    closeWitness();
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
    expect(witness.writes.length).toBe(1);
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");
    expect(anchor.isConnected).toBe(true);
    // OUTCOME (R2): no deliberate travel happens inside this window, so
    // every scrollTop movement in it is the correction itself — the anchor
    // must sit where it sat, VIEWPORT-relative. A no-op write leaves it
    // displaced by the wave's full 180px, which the document-space form was
    // blind to (it cancelled the compensation against the observed scroll
    // delta and measured only layout growth).
    expect(
      Math.abs(relativeTop(viewport, anchor) - before),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

describe("remap during active scroll, scroll-end mid-wave (R1 regression)", () => {
  it("the scroll-end leaves the live burst alone: one merged relative write on every engine", async () => {
    // The race the independent review caught: the scroll-end timer armed by
    // a delivered scroll fires WHILE the remap's wave is still landing.
    // Pre-fix it flushed the partial backlog and disarmed the burst, and
    // the deliveries after it wrote per-row. Now a live burst owns its
    // release — the merged commit lands at wave quiescence, ONE write,
    // strictly after the scroll-end marker. Timers alone cannot be aligned
    // against the ResizeObserver deliveries, so the case fires the
    // scroll-end at the exact mid-wave point through the witness-wrapped
    // store seam (the marker still lands on the timeline).
    const ROW = 100;
    const items = range(60, (i) => `row-${i}`);
    const handle = createRef<VirtualizerHandle>();
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer ref={handle} data={items} itemSize={ROW}>
          {(item) => (
            <div key={item} style={{ height: ROW }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    viewport.scrollTop = 1250;
    await settle(viewport);

    const scrolled = onceScroll(viewport);
    viewport.scrollTop -= 60; // scroll active; the scroll-end timer is armed
    await scrolled;
    // findFirstVisibleItem returns the row straddling the viewport top, so
    // its previous sibling sits fully above — every growth of it is a
    // kept-row correction. Small +10 steps keep the parked backlog inside
    // the buffer (a large park would evict the top rows from the render
    // range while it is held).
    // Mount precondition (the burst case's pattern): the backward buffer
    // extension armed by this scroll renders a frame later on Firefox —
    // sample only from the settled DOM, never a retry away.
    const anchorKey = (
      findFirstVisibleItem(container, viewport)!.textContent ?? ""
    ).trim();
    const aboveKey = `row-${Number(anchorKey.slice(4)) - 1}`;
    await expect
      .poll(() => getItem(container, aboveKey), { timeout: 5000 })
      .toBeDefined();

    const anchor = findFirstVisibleItem(container, viewport)!;
    const above = anchor.previousElementSibling as HTMLElement | null;
    expect(above).toBeTruthy();

    const before = relativeTop(viewport, anchor);

    openWitness();
    expect(
      handle.current!.remapItems({
        previousLength: 60,
        order: range(60, (i) => i),
      }),
    ).toBe(true);
    // Wave delivery 1 lands BEFORE the scroll-end.
    above!.style.height = `${ROW + 10}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 10);
    // The scroll-end timer fires NOW — mid-wave. It must neither flush the
    // partial backlog nor disarm the burst (its own resets may run).
    seam.update!(ACTION_USER_GESTURE, false);
    seam.update!(ACTION_SCROLL_END);
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    // Wave deliveries 2-4 land after the scroll-end, inside the burst's
    // still-live quiescence window.
    above!.style.height = `${ROW + 20}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 20);
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    above!.style.height = `${ROW + 30}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 30);
    above!.style.height = `${ROW + 40}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 40);
    // The wave's own quiescence commits the merged backlog — once.
    await expect
      .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length)
      .toBe(1);
    expect(
      witness.seq.findIndex((e) => Array.isArray(e) && e[1] !== 0) >
        witness.seq.indexOf("scroll-end"),
    ).toBe(true);
    await delay(250); // a torn transaction would have written more by now
    closeWitness();
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
    expect(witness.writes.length).toBe(1);
    expect(witness.writes).toContain("relative");
    expect(witness.writes).not.toContain("absolute");
    expect(anchor.isConnected).toBe(true);
    // OUTCOME: viewport-relative — the only scroll in this window is the
    // -60 that predates the sample; every later movement is the
    // correction itself.
    expect(
      Math.abs(relativeTop(viewport, anchor) - before),
    ).toBeLessThanOrEqual(SUBPIXEL);
  });
});

// jam.3 FINAL write-discipline contract (FORK-CHANGES.md §8): ZW (zero
// writes during a gesture), EDGE-START (start-edge corrections commit
// geometry only — the scroller is never written at or into the elastic
// region), CAP (the >1-viewport escape commits whole, at rest; a backlog
// accumulated mid-gesture defers to the rest commit), and P (a gesture-ON
// preempts an armed settle epoch — the new gesture owns the timeline).
// Probe (iv) — the retained idle bottom-pinning write — is the
// absolute-end case above, unmodified.
describe("start-edge geometry-only and gesture preemption (jam.3 final contract EDGE/ZW/P)", () => {
  const ROW = 100;
  const items = range(60, (i) => `row-${i}`);
  const renderList = () => {
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer data={items} itemSize={ROW}>
          {(item) => (
            <div key={item} style={{ height: ROW }}>
              {item}
            </div>
          )}
        </Virtualizer>
      </div>,
    );
    return root;
  };
  const isWebkit = () =>
    /AppleWebKit/.test(navigator.userAgent) &&
    !/Chrom(e|ium)|Edg\//.test(navigator.userAgent);

  it("start edge with a parked backlog during the tail: geometry-only at the edge, in BOTH states (probe i)", async () => {
    // The owner's top-edge shape, deterministic: a WebKit momentum tail
    // parks a +150 correction above the anchor, and the reader then moves
    // the scroller to the very top (scrollTop 0, user-owned position)
    // WHILE the gesture/settle hold still owns the timeline. From here the
    // fork must touch the scroller ZERO times — during the gesture (ZW)
    // AND at rest (EDGE-START keys on the CURRENT position: at the edge
    // the scroll position is OS/user-owned; AND the parked debt is
    // DROPPED there (park → CLEAR — it rides EVERY item offset, so
    // retaining it at the edge displaces the whole list with no write).
    // The parity re-anchor is probed from mid-viewport (next case).
    const root = renderList();
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    viewport.scrollTop = 3000;
    await settle(viewport);

    const first = onceScroll(viewport);
    viewport.scrollTop -= 150;
    await first;
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    touch("touchend"); // release into the tail
    const pulse = async (delta: number) => {
      const scrolled = onceScroll(viewport);
      viewport.scrollTop -= delta;
      await scrolled;
    };
    for (let k = 0; k < 2; k++) {
      await delay(50);
      await pulse(50);
    }
    expect(viewport.scrollTop).toBeGreaterThan(2500);

    openWitness();
    const anchor = findFirstVisibleItem(container, viewport)!;
    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 150);

    // The user moves to the top edge while the tail's epoch is still open.
    const toTop = onceScroll(viewport);
    viewport.scrollTop = 0;
    await toTop;
    await delay(250);
    if (isWebkit()) {
      expect(witness.writes.length).toBe(0);
      expect(viewport.scrollTop).toBe(0);
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
      expect(parseFloat(container.style.height)).toBe(60 * ROW + 150);
      // The old target-keyed guard wrote relative +150 from scrollTop 0
      // (row0 clipped at −150 via the consumed position); a RETENTION-only
      // fix passes the write checks yet still renders row0 at −150 through
      // the offset channel. Rest: the epoch closes AT the edge — zero
      // writes AND the debt cleared, offsets back to true geometry.
      await expect
        .poll(() => witness.seq.includes("scroll-end"), { timeout: 3000 })
        .toBe(true);
      await delay(300); // any rest write / retained offset (old forms) lands by now
      closeWitness();
      expect(witness.writes.length).toBe(0);
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
      expect(viewport.scrollTop).toBe(0);
      expect(parseFloat(container.style.height)).toBe(60 * ROW + 150);
      expect(container.style.transform).toBeFalsy();
      // DOM-geometry oracle (never the store's compensated accessor):
      // row0 == true offset (0) − native position (0).
      expect(
        Math.abs(
          getItem(container, "row-0")!.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            (0 - viewport.scrollTop),
        ),
      ).toBeLessThanOrEqual(SUBPIXEL);
    } else {
      // #942 engines: the growth priced immediately while still mid-list
      // (ONE relative write — pre-change parity), nothing after the user
      // took the top. The rest commit finds an empty backlog.
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length)
        .toBe(1);
      await delay(450); // the #942 engines' plain debounce ends the epoch
      closeWitness();
      expect(witness.writes.length).toBe(1);
      expect(witness.writes).toContain("relative");
      expect(viewport.scrollTop).toBe(0);
    }
  });

  it("the parked backlog's re-anchor is ONE whole write when the position is inside the content (probe i, parity)", async () => {
    // The contract's other half: EDGE-START removes the edge write, it
    // does not touch the inside-content re-anchor. The backlog parks
    // mid-tail (current > 0); the rest commit moves the position by the
    // backlog whole, exactly once, and the anchor lands where it was
    // before the growth (full #942 parity — the same shape the momentum
    // case proves on a moving tail, asserted from a resting position).
    const root = renderList();
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    viewport.scrollTop = 3000;
    await settle(viewport);
    const first = onceScroll(viewport);
    viewport.scrollTop -= 150;
    await first;
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    touch("touchend");
    const pulse = async (delta: number) => {
      const scrolled = onceScroll(viewport);
      viewport.scrollTop -= delta;
      await scrolled;
    };
    for (let k = 0; k < 2; k++) {
      await delay(50);
      await pulse(50);
    }
    expect(viewport.scrollTop).toBeGreaterThan(2500);

    openWitness();
    const anchor = findFirstVisibleItem(container, viewport)!;
    const before = relativeTop(viewport, anchor);
    const parkedAt = viewport.scrollTop;
    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 150);
    if (isWebkit()) {
      // Parked, not written: the anchor stays STILL — the parked desync
      // applies the growth through the item-offset mapping
      // (getItemOffset = offset − pendingJump): rows below the change
      // hold their screen place with zero scroll writes. The one
      // inside-content rest commit converts the parked desync into the
      // real re-anchor — landing exactly here, once.
      expect(
        Math.abs(relativeTop(viewport, anchor) - before),
      ).toBeLessThanOrEqual(SUBPIXEL);
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length, {
          timeout: 3000,
        })
        .toBe(1);
      await delay(250);
      closeWitness();
      expect(witness.writes.length).toBe(1);
      expect(witness.writes).toContain("relative");
      expect(witness.writes).not.toContain("absolute");
      expect(viewport.scrollTop).toBe(parkedAt + 150);
      expect(
        Math.abs(relativeTop(viewport, anchor) - before),
      ).toBeLessThanOrEqual(SUBPIXEL);
    } else {
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length)
        .toBe(1);
      await delay(450);
      closeWitness();
      expect(witness.writes.length).toBe(1);
      expect(
        Math.abs(relativeTop(viewport, anchor) - before),
      ).toBeLessThanOrEqual(SUBPIXEL);
    }
  });

  it("elastic stretch passthrough: no fork spacer, no write; spring-back stays aligned (probes ii-a/ii-b)", async () => {
    // The scroller claims a native rubber-band position (scrollTop -25 via
    // a configurable own accessor — the DOM stays at 0, as a compositor
    // stretch leaves layout). Nothing may be injected to "compensate":
    // no start spacer / container translation, no scroll write, geometry
    // equal to measured truth. In a real browser the first row renders 25
    // px below the viewport top DURING the stretch — the OS owns that
    // offset; here the assertion is that the fork adds NOTHING to it
    // (headless DOM cannot stretch). Then spring back and re-settle: the
    // first row stays aligned with the viewport top, still zero writes.
    const root = renderList();
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    const row0 = getItem(container, "row-0")!;
    await settle(viewport);

    openWitness();
    const native = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    )!.set!;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => -25,
      set: (v: number) => native.call(viewport, v),
    });
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    await delay(80);
    expect(viewport.scrollTop).toBe(-25); // the stretch is visible to the fork
    expect(witness.writes.length).toBe(0);
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    expect(container.style.transform).toBeFalsy(); // no fork translation
    expect(parseFloat(container.style.height)).toBe(60 * ROW);
    // Measured-geometry pin (the (ii-a) "row0 == true offset − native
    // position" check; the reviewer's real-WebKit reading is 25 at native
    // −25, from the compositor's own stretch — a headless DOM renders at
    // the REAL position 0, and what is pinned is that the fork adds
    // NOTHING on top: offset-channel retention or a spacer would land
    // ±Δ off this line, not the native 25).
    expect(
      Math.abs(
        row0.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          (0 - 0),
      ),
    ).toBeLessThanOrEqual(SUBPIXEL);

    // (ii-b) spring-back: the native getter returns, the position is the
    // OS-owned 0 again, the epoch closes over an empty backlog, and the
    // SAME relative invariant as (ii-a) governs: row position == true
    // content offset − native scrollTop. Here the backlog above row 0 is
    // zero, so the invariant reduces to "aligned with the viewport top"
    // — with a backlog above it would sit at its true offset instead.
    Reflect.deleteProperty(viewport, "scrollTop");
    // The DOM never moved from 0, so an assignment would fire no scroll
    // event — the spring-back is announced the same synthetic way the
    // stretch was.
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    await settle(viewport);
    closeWitness();
    expect(witness.writes.length).toBe(0);
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    expect(container.style.transform).toBeFalsy();
    expect(parseFloat(container.style.height)).toBe(60 * ROW);
    expect(
      Math.abs(relativeTop(viewport, row0) - (0 - viewport.scrollTop)),
    ).toBeLessThanOrEqual(
      SUBPIXEL, // invariant form: true content offset (0) − native position
    );
  });

  const reviewerEdgeVariant = async (delta: number) => {
    // The reviewer's EXACT repro as a permanent regression, sign labels
    // per the record: −60 = SHRINK of row 10 (a row above the viewport),
    // +60 = GROWTH. 40 rows × 100px, viewport 400, position 1250:
    // touchstart → resize row 10 → move to scrollTop 0 (the reader's
    // own) → release → settle past the release. Expected, both signs:
    // ZERO scroll writes (the target-keyed form wrote relative +60 AT
    // the edge from the growth — row0 clipped at −60), and the parked
    // debt CLEARED LIVE the moment the reader's scroll REACHES the edge
    // (the settle flush only backstops paths that never transit a scroll
    // there) — getItemOffset = getOffset − pendingJump carries the debt
    // through EVERY row offset, so retaining it — even settle-lagged —
    // renders row0 60px BELOW the top on the shrink (a blank band with
    // nothing above it) and 60px ABOVE it on the growth: an
    // offset-channel displacement with no write at all.
    // ORACLE (reviewer rule): measured DOM geometry — row0's position
    // relative to the viewport top against the fixture's raw layout
    // (row0's true offset is 0) — never the store's compensated
    // accessors, which ARE the displacement.
    const ROWS = 40;
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer data={range(ROWS, (i) => `row-${i}`)} itemSize={100}>
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
    viewport.scrollTop = 1250;
    await settle(viewport);
    // Row 10 sits at 1000..1100, inside the backward buffer at 1250 but
    // mounted only a frame later on Firefox (the (v) hardening): poll
    // before sample.
    await expect
      .poll(() => getItem(container, "row-10"), { timeout: 5000 })
      .toBeDefined();
    openWitness();
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    (getItem(container, "row-10") as HTMLElement).style.height =
      `${100 + delta}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(ROWS * 100 + delta);
    const toTop = onceScroll(viewport);
    viewport.scrollTop = 0;
    await toTop;
    // Edge-REACH sample, pre-touchend and pre-settle (reviewer's missing
    // sample, both signs): the reader's own scroll event onto the edge
    // must ALREADY render true geometry while the hold is open — the
    // offset-channel debt cleared on the event, not settle-lagged. This
    // rect is the B-gap discriminant: ±60 here = the clear waiting for
    // the flush. BOUNDED POLL (one render round-trip: the scroll event,
    // the store clear, and the range re-render land a frame after the
    // DOM scroll the wait resolves on; under full-suite contention that
    // frame is not instantaneous, exactly like the (v) mount-race class).
    // The window closes before any flush is POSSIBLE: this sample sits
    // inside the held gesture (touchend below), and the epoch's release
    // horizon is the last signal + SETTLE_STABILITY (300 ms,
    // observer.ts:46) — no deadline can run while the gesture owns the
    // timeline, so a settle-lagged clear (the leak form) strands red.
    await expect
      .poll(
        () =>
          Math.abs(
            getItem(container, "row-0")!.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top,
          ),
        { timeout: 1000 },
      )
      .toBeLessThanOrEqual(SUBPIXEL); // DOM at 0: true offset − physical position
    // State 1 (gesture still owned): WebKit wrote nothing AND the debt was
    // CLEARED at the reader's edge-reach scroll; the #942 engines already
    // wrote once, at the resize, from
    // inside the content (current 1250 > 0 — the retained write).
    await expect
      .poll(() => witness.writes.length, { timeout: 300 })
      .toBe(isWebkit() ? 0 : 1);
    touch("touchend");
    await expect
      .poll(() => witness.seq.includes("scroll-end"), { timeout: 3000 })
      .toBe(true); // settle, past the release
    await delay(300); // a late at-edge write (old guard) would be in
    closeWitness();
    // State 2 (at rest at the edge): still zero writes.
    expect(witness.writes.length).toBe(isWebkit() ? 0 : 1);
    expect(viewport.scrollTop).toBe(0); // the position is the reader's
    // The geometry discriminant: row0 == true offset (0) − native
    // position (0) == the viewport top — the retained band/clipping
    // (±Δ) and the written clip (−Δ) both land RED here.
    expect(
      Math.abs(
        getItem(container, "row-0")!.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          (0 - viewport.scrollTop),
      ),
    ).toBeLessThanOrEqual(SUBPIXEL);
    expect(parseFloat(container.style.height)).toBe(ROWS * 100 + delta);
    expect(container.style.transform).toBeFalsy(); // offset channel, not this
  };

  it("parked +60 GROWTH carried through the top edge: never written at the edge (reviewer backlog probe)", async () => {
    await reviewerEdgeVariant(60);
  });

  it("parked −60 SHRINK carried through the top edge: no write, no blank band (reviewer backlog probe)", async () => {
    await reviewerEdgeVariant(-60);
  });

  const reviewerElasticVariant = async (delta: number) => {
    // The reviewer's elastic variant on his fixture, BOTH carry signs
    // through the clock (−60 = SHRINK of row 10, 100→40; +60 = GROWTH):
    // the parked correction survives native −25 → spring-back 0 with
    // zero writes AND true item offsets at every native position. Sign
    // note for the record: +60 is the sign the target-keyed guard WROTE
    // at native −25, finding "room" at −25 + 60 = 35; RETENTION — the
    // failure this probe exists to keep dead — leaves row0 clipped at
    // −60 (growth) or floating at +60 (shrink) through the clock via the
    // offset channel. 40 × 100, viewport 400, at 1250: touchstart →
    // resize row 10 → the reader moves to 0 → release INTO the clock →
    // stretch to native −25 (held past the stability deadline, the flush
    // lands there) → spring back. Oracle: measured DOM geometry against
    // the fixture's raw layout — never the store's compensated accessor,
    // which IS the displacement. Headless note: the DOM cannot render a
    // negative scrollTop, so the stretch phase is observed as the
    // accessor read (−25, store-visible) with the DOM at 0 — the fork's
    // displacement would show on the spring-back pixels.
    const ROWS = 40;
    const root = render(
      <div style={{ height: 400, overflowY: "auto" }}>
        <Virtualizer data={range(ROWS, (i) => `row-${i}`)} itemSize={100}>
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
    viewport.scrollTop = 1250;
    await settle(viewport);
    await expect
      .poll(() => getItem(container, "row-10"), { timeout: 5000 })
      .toBeDefined();
    openWitness();
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    (getItem(container, "row-10") as HTMLElement).style.height =
      `${100 + delta}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(ROWS * 100 + delta);
    const toTop = onceScroll(viewport);
    viewport.scrollTop = 0;
    await toTop;
    touch("touchend"); // release INTO the clock

    // Stretch: the scroller reads −25 (DOM at 0; the compositor owns the
    // 25 px, never the fork). Held past the stability deadline so the
    // epoch's flush lands AT the stretched position.
    const native = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    )!.set!;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => -25,
      set: (v: number) => native.call(viewport, v),
    });
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    // PHASE-LOCKED pre-settle sample of the −25 leg (reviewer P2): the
    // measured-row check must land INSIDE the pre-settle window or it
    // silently demotes to a flush-backstop guard — the first placement
    // ran after delay(350), past SETTLE_STABILITY (300 ms,
    // observer.ts:46), i.e. post scroll-end. The phase itself is an
    // assertion: no scroll-end in the witness yet — the last signal
    // (this dispatch, or the touchend a few ms before it) armed a
    // 300 ms stability window the sample below cannot outlast, so a
    // future reordering that lets the flush into the window fails
    // LOUDLY here instead of quietly guarding the backstop twice.
    expect(witness.seq.includes("scroll-end")).toBe(false);
    // The measured row, pre-settle: with the clear applied at the
    // reader's edge-reach scroll BEFORE touchend, the stretch phase is
    // the no-backlog (ii-a) shape — the synthetic DOM never moved from
    // 0 (the compositor's 25 is not rendered; the fork adds NOTHING).
    // With the live-clear block removed, this rect sits at ±60 until
    // the flush lands — which the phase-lock above has just proven is
    // STILL IN THE FUTURE — so this pin goes red like the signed
    // pre-touchend controls; the pass path needs no round-trip (the
    // geometry has been true since the edge-reach render).
    await expect
      .poll(
        () =>
          Math.abs(
            getItem(container, "row-0")!.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top,
          ),
        { timeout: 200 },
      )
      .toBeLessThanOrEqual(SUBPIXEL);
    await delay(350);
    expect(viewport.scrollTop).toBe(-25); // the stretch is store-visible
    // The flush at native −25 (BACKSTOP window): the target-keyed form
    // wrote +60 HERE (the growth sign; −25 + 60 = "room"); the
    // current-keyed form writes nothing for either sign, and with the
    // live clear the epoch has no debt left to even backstop.
    expect(witness.writes.length).toBe(isWebkit() ? 0 : 1); // #942: immediate 1250 write
    Reflect.deleteProperty(viewport, "scrollTop");
    viewport.dispatchEvent(new Event("scroll", { bubbles: true })); // spring-back
    if (isWebkit()) {
      await expect
        .poll(() => witness.seq.includes("scroll-end"), { timeout: 3000 })
        .toBe(true);
    }
    await delay(300);
    closeWitness();
    // (the debt died at the reader's edge-reach, before the clock even
    // opened — the epoch's flush backstops with nothing to do; spring-back
    // finds true geometry at EVERY native position it passed through)
    expect(witness.writes.length).toBe(isWebkit() ? 0 : 1);
    expect(viewport.scrollTop).toBe(0);
    // Post-clock geometry: row0 at true offset − native position == 0;
    // a retention bug lands here at ±60 (clip or band).
    expect(
      Math.abs(
        getItem(container, "row-0")!.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          (0 - viewport.scrollTop),
      ),
    ).toBeLessThanOrEqual(SUBPIXEL);
    expect(parseFloat(container.style.height)).toBe(ROWS * 100 + delta);
    expect(container.style.transform).toBeFalsy();
  };

  it("parked +60 GROWTH through the elastic clock −25 → 0: zero writes at every native position, offsets true (reviewer elastic probe)", async () => {
    await reviewerElasticVariant(60);
  });

  it("parked −60 SHRINK through the elastic clock −25 → 0: zero writes at every native position, offsets true (reviewer elastic probe)", async () => {
    await reviewerElasticVariant(-60);
  });

  it("end edge during a gesture: parked on WebKit with the position kept; #942 writes immediately (probe v)", async () => {
    // The frozen contract: the END edge keeps its anchored write (that is
    // the bottom-pinning item (iv) retains) — but during an ACTIVE gesture
    // ZW applies everywhere: WebKit parks and does not move the scroller
    // until rest, where the end clamp commits the backlog whole. The
    // #942 engines behave exactly as before the final contract.
    const root = renderList();
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    const toEnd = onceScroll(viewport);
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    await toEnd;
    await settle(viewport);
    const bottom = viewport.scrollHeight - viewport.clientHeight;

    openWitness();
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    // Sample from settled DOM BEFORE the gesture: on Firefox the scroll
    // event arming the scroll-end buffer-extension can land after settle()'s
    // quiet window, and a touchstart arriving first lets the new gesture own
    // the timeline (54b7e5ead semantics) — the row above the anchor then
    // never mounts and no poll window rescues it. The mount is a fixture
    // precondition; the growth under test still happens mid-gesture.
    const anchorKey = (
      findFirstVisibleItem(container, viewport)!.textContent ?? ""
    ).trim();
    await expect
      .poll(() => getItem(container, `row-${Number(anchorKey.slice(4)) - 1}`), {
        timeout: 5000,
      })
      .toBeDefined();
    touch("touchstart"); // gesture ON and held
    const anchor = findFirstVisibleItem(container, viewport)!;
    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 150);
    await delay(120);
    if (isWebkit()) {
      expect(witness.writes.length).toBe(0);
      expect(viewport.scrollTop).toBe(bottom);
      // Release: at rest the end edge keeps its clamp — the backlog
      // commits as ONE write and the reader stays pinned to the new end.
      touch("touchend");
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length, {
          timeout: 3000,
        })
        .toBe(1);
      await delay(250);
      closeWitness();
      expect(witness.writes.length).toBe(1);
      expect(viewport.scrollTop).toBe(
        viewport.scrollHeight - viewport.clientHeight,
      );
      expect(viewport.scrollTop).toBe(bottom + 150);
    } else {
      // #942: the growth at the end edge writes immediately (pre-change
      // parity) and the rest finds nothing left.
      // Poll-hardened (the firefox mount/measure-path race in Kirk's
      // no-retry battery): generous timeout on the immediate-write
      // matcher; the mount is poll-before-sampled above.
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length, {
          timeout: 5000,
        })
        .toBe(1);
      touch("touchend");
      await delay(450);
      closeWitness();
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
      expect(viewport.scrollTop).toBe(
        viewport.scrollHeight - viewport.clientHeight,
      );
    }
  });

  it("fresh wheel-ON during an armed epoch owns the timeline: no commit at the old fire time (probe p)", async () => {
    // The reviewer's red case against the pre-P code: the tail's timer is
    // armed and a NEW gesture begins ~10 ms before its fire time, with no
    // delivered scroll to cancel it (a rubber-band flick streams WHEEL
    // events without position traffic while the frames drop). Without the
    // gesture-ON preemption the old timer fires mid-gesture and commits;
    // with it the new gesture owns the timeline and the commit lands only
    // after that gesture rests.
    const root = renderList();
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    viewport.scrollTop = 3000;
    await settle(viewport);
    const first = onceScroll(viewport);
    viewport.scrollTop -= 150;
    await first;
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    touch("touchend");
    const pulse = async (delta: number) => {
      const scrolled = onceScroll(viewport);
      viewport.scrollTop -= delta;
      await scrolled;
    };
    for (let k = 0; k < 2; k++) {
      await delay(50);
      await pulse(50);
    }
    const parkedAt = viewport.scrollTop;

    openWitness();
    const anchor = findFirstVisibleItem(container, viewport)!;
    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 150);

    await delay(200); // approach the old timer's fire time (last signal +300)
    const stopper = (e: Event) => e.preventDefault();
    viewport.addEventListener("wheel", stopper);
    const wheel = () =>
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -10,
          bubbles: true,
          cancelable: true,
        }),
      );
    await wheel(); // the preemption: gesture-ON with the epoch armed
    await delay(60); // cross the old fire time
    if (isWebkit()) {
      expect(witness.seq.includes("scroll-end")).toBe(false);
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
      expect(witness.writes.length).toBe(0);
      expect(viewport.scrollTop).toBe(parkedAt); // pure signal, no motion
    }
    for (let k = 0; k < 8; k++) {
      await delay(80);
      await wheel();
    }
    viewport.removeEventListener("wheel", stopper);
    if (isWebkit()) {
      expect(witness.writes.length).toBe(0);
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length, {
          timeout: 3000,
        })
        .toBe(1);
      await delay(250);
      closeWitness();
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
      expect(witness.writes).toContain("relative");
      expect(witness.writes).not.toContain("absolute");
    } else {
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length)
        .toBe(1); // the #942 immediate write, unchanged by the contract
      await delay(450);
      closeWitness();
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(1);
    }
  });

  it("rubber-band flick at the top edge writes nothing end to end (probe p, top variant)", async () => {
    // The owner's repro shape at the top: no backlog exists (row 0 owns the
    // top and nothing measures), the whole sequence — gesture stream
    // through the epoch's close — must leave the scroller untouched.
    const root = renderList();
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    expect(viewport.scrollTop).toBe(0);
    await settle(viewport);

    openWitness();
    const stopper = (e: Event) => e.preventDefault();
    viewport.addEventListener("wheel", stopper);
    const wheel = () =>
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -10,
          bubbles: true,
          cancelable: true,
        }),
      );
    for (let k = 0; k < 12; k++) {
      await delay(80);
      await wheel();
    }
    viewport.removeEventListener("wheel", stopper);
    await delay(320); // an old epoch's fire time, had one been armed
    await settle(viewport);
    closeWitness();
    expect(witness.writes.length).toBe(0);
    expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    expect(parseFloat(container.style.height)).toBe(60 * ROW);
  });

  it("corrections that net to zero inside an epoch commit zero writes (probe h)", async () => {
    // A +150 parks during the tail; during the epoch a NEW gesture streams
    // (wheel-ON keeps the deadline sliding — item P) and the same row is
    // measured back to its original height, parking -150. The backlog
    // nets to zero; the at-rest flush must find nothing and write nothing.
    const root = renderList();
    const { viewport, container } = await getVirtualizer(root);
    await expect.poll(() => getItem(container, "row-0")).toBeDefined();
    viewport.scrollTop = 3000;
    await settle(viewport);
    const first = onceScroll(viewport);
    viewport.scrollTop -= 150;
    await first;
    const touch = (type: "touchstart" | "touchend") =>
      viewport.dispatchEvent(new Event(type, { bubbles: true }));
    touch("touchstart");
    touch("touchend");
    const pulse = async (delta: number) => {
      const scrolled = onceScroll(viewport);
      viewport.scrollTop -= delta;
      await scrolled;
    };
    for (let k = 0; k < 2; k++) {
      await delay(50);
      await pulse(50);
    }

    openWitness();
    const anchor = findFirstVisibleItem(container, viewport)!;
    const grown = anchor.previousElementSibling as HTMLElement | null;
    expect(grown).toBeTruthy();
    grown!.style.height = `${2 * ROW + 50}px`;
    await expect
      .poll(() => parseFloat(container.style.height))
      .toBe(60 * ROW + 150);
    if (!isWebkit()) {
      await expect
        .poll(() => witness.flushes.filter(([jump]) => jump !== 0).length)
        .toBe(1); // #942 immediate pricing; (h) governs the WebKit epoch
    }

    // The new gesture: pure wheel signals, deadline sliding past any old
    // fire time, while the correction reverses inside the epoch.
    const stopper = (e: Event) => e.preventDefault();
    viewport.addEventListener("wheel", stopper);
    const wheel = () =>
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -10,
          bubbles: true,
          cancelable: true,
        }),
      );
    await delay(120);
    await wheel();
    grown!.style.height = `${ROW}px`;
    await expect.poll(() => parseFloat(container.style.height)).toBe(60 * ROW);
    for (let k = 0; k < 3; k++) {
      await delay(80);
      await wheel();
    }
    viewport.removeEventListener("wheel", stopper);
    await expect
      .poll(() => witness.seq.includes("scroll-end"), { timeout: 3000 })
      .toBe(true);
    await delay(350); // any stray commit would have landed
    closeWitness();
    if (isWebkit()) {
      expect(witness.writes.length).toBe(0);
      expect(witness.flushes.filter(([jump]) => jump !== 0).length).toBe(0);
    }
    expect(parseFloat(container.style.height)).toBe(60 * ROW);
  });
});
