import {
  getCurrentDocument,
  getCurrentWindow,
  isIOSWebKit,
  isWebKit,
} from "./environment.js";
import {
  ACTION_SCROLL,
  type VirtualStore,
  ACTION_SCROLL_END,
  ACTION_START_OFFSET_CHANGE,
  ACTION_USER_GESTURE,
  ACTION_MANUAL_SCROLL,
  ACTION_BEFORE_MANUAL_SMOOTH_SCROLL,
  ACTION_BURST_SETTLED,
  UPDATE_SIZE_EVENT,
  UPDATE_VIRTUAL_STATE,
} from "./store.js";
import { cancelTimeout, microtask, timeout } from "./utils.js";

/**
 * The scroll-end debounce: milliseconds of scroll-event silence after which
 * the position counts as stable. Fork delta 1 (jam.3 revision) also uses it
 * as the momentum-tail stability window — "settled" and "scroll ended" are
 * deliberately the same event, so a parked backlog has exactly one release
 * path (FORK-CHANGES.md delta 1).
 * @internal
 */
export const SCROLL_END_DEBOUNCE = 150;

/**
 * @internal
 * Fork delta 1 (jam.3 final, event-driven): the position-silence window the
 * observer waits before a settle-held release may flush on WebKit. A
 * momentum tail whose DELIVERED events gap past the plain debounce used to
 * fire scroll-end mid-tail: the hold released and stragglers wrote per-row
 * (the owner report's ~50px residual), and a flush landing while the user
 * began his next gesture ate the native rubber-band (face three). The held
 * release now waits SETTLE_STABILITY of signal silence — SCROLL OR WHEEL,
 * each sliding the deadline, no fixed total budget; a correction merging
 * inside the window rides its single at-rest re-sync (epoch semantics).
 * The flush lands ~window after the LAST signal. Gapless sessions pay only
 * the extra silence on their single merged commit; SCROLL_END_DEBOUNCE
 * itself and its other consumers are untouched.
 */
export const SETTLE_STABILITY = 300;

/**
 * @internal
 */
export const createResizeObserver = (cb: ResizeObserverCallback) => {
  let ro: ResizeObserver | undefined;

  return {
    _observe(e: HTMLElement) {
      // Initialize ResizeObserver lazily for SSR
      // https://www.w3.org/TR/resize-observer/#intro
      (
        ro ||
        // https://bugs.chromium.org/p/chromium/issues/detail?id=1491739
        (ro = new (getCurrentWindow(getCurrentDocument(e)).ResizeObserver)(cb))
      ).observe(e);
    },
    _unobserve(e: HTMLElement) {
      ro!.unobserve(e);
    },
    _dispose() {
      ro && ro.disconnect();
    },
  };
};

/**
 * @internal
 */
export const createScrollObserver = (
  store: VirtualStore,
  viewport: HTMLElement | Window,
  scroller: HTMLElement,
  isHorizontal: boolean,
  isRtl: boolean,
  onMomentumJump?: (() => void) | null,
  getStartOffset?: () => number,
) => {
  let lastScrollTime = 0;
  let wheeling = false;
  let touching = false;
  let justTouchEnded = false;
  let stillMomentumScrolling = false;
  let cancelScroll: (() => void) | undefined;
  // Fork delta 1 (jam.3 final, event-driven): the last signal — a delivered
  // scroll delta or a wheel pulse while the hold is active. The held
  // release waits for SETTLE_STABILITY of signal silence; every signal
  // slides the deadline, so a 1 s+ tail stays held and settles ~window
  // after its LAST event — no fixed total budget.
  let settleSignal = 0;
  // Set while a user gesture has been reported since the last scroll-end.
  // The hold arm keys on movement alone (a raw programmatic scrollTop step
  // releases into it too, pre-fix same-tick and therefore invisible); the
  // extension belongs to USER tails only — programmatic scrolls keep #942's
  // plain-debounce release timing exactly.
  let gestureSeen = false;

  let scrollEndTimer: ReturnType<typeof timeout> | undefined;
  // Fork delta 7: this observer owns the burst-window timing so the store
  // stays synchronous. The FIRST arm after a transaction spans TWO
  // stability windows: the wave's first ResizeObserver delivery can lag the
  // remap by a frame or more under load, and a window that elapsed before
  // any correction had parked would end the transaction before its first
  // batch. Once the wave is running, each update re-arms ONE window, so the
  // commit lands one stability window — the scroll-end debounce constant —
  // after the LAST correction (FORK-CHANGES.md delta 7).
  let burstEndTimer: ReturnType<typeof timeout> | undefined;
  let burstWaveStarted = false;

  const armBurstWindow = () => {
    cancelTimeout(burstEndTimer);
    burstEndTimer = timeout(
      () => {
        burstWaveStarted = false;
        store.$update(ACTION_BURST_SETTLED);
      },
      burstWaveStarted ? SCROLL_END_DEBOUNCE : SCROLL_END_DEBOUNCE * 2,
    );
    burstWaveStarted = true;
  };
  // Arm once on the remap's async notify, then on each wave update until it
  // goes quiet. While no burst is pending the callback does nothing, so an
  // ordinary scroll never schedules a spurious commit.
  const unsubscribeBurst = store.$subscribe(UPDATE_VIRTUAL_STATE, () => {
    if (store.$isBurstPending()) armBurstWindow();
  });

  const now = Date.now;
  const scrollOffsetKey = isHorizontal ? "scrollLeft" : "scrollTop";
  const scrollToKey = isHorizontal ? "left" : "top";

  /**
   * scrollTop/scrollLeft can be negative value under certain styles.
   * - direction: rtl https://github.com/othree/jquery.rtl-scroll-type
   * - writing-mode   https://people.igalia.com/fwang/scrollable-elements-in-non-default-writing-modes/
   * - flex-direction: column-reverse/row-reverse
   *
   * top/left bottom/right
   * 0        100          spec compliant bottom/right overflow, or possibly top/left overflow in Chrome earlier than v85
   * -100     0            spec compliant top/left overflow
   * https://drafts.csswg.org/cssom-view/#scroll-an-element
   */
  const normalizeScrollOffset = (offset: number): number => {
    return isRtl ? -offset : offset;
  };

  const getScrollOffset = () =>
    normalizeScrollOffset(scroller[scrollOffsetKey]);

  // The given offset will be clamped by browser
  // https://drafts.csswg.org/cssom-view/#dom-element-scrolltop
  const scrollTo = (offset: number, smooth?: boolean) => {
    scroller.scrollTo({
      [scrollToKey]: normalizeScrollOffset(offset),
      behavior: smooth ? "smooth" : "instant",
    });
  };

  // Debounce scroll end detection
  const onScrollEnd = () => {
    if (wheeling || touching) {
      wheeling = false;

      // Wait while wheeling or touching
      scheduleScrollEnd();
      return;
    }

    justTouchEnded = false;
    store.$update(ACTION_USER_GESTURE, false);
    // Fork delta 1 (jam.3 final, event-driven): released into a still-moving
    // position — the settle hold owns the release. The flush waits for
    // SETTLE_STABILITY of signal silence (scroll OR wheel — the stream is
    // the hand-on-glass condition: a rubber-band flick keeps sliding the
    // deadline instead of eating the spring-back under a scheduled write).
    // No fixed budget — the deadline rides the last signal; a correction
    // merging inside the window rides its single at-rest re-sync (accepted
    // epoch semantics — compensating mid-window would race the tail).
    // Non-WebKit engines, programmatic sessions (gestureSeen) and marked
    // imperative operations (the accessor's mode term) never enter this
    // branch; their release stays the plain debounce, per #942.
    if (isWebKit() && gestureSeen && store.$isSettleHeld()) {
      const silent = now() - settleSignal;
      if (silent < SETTLE_STABILITY) {
        scrollEndTimer = timeout(onScrollEnd, SETTLE_STABILITY - silent);
        return;
      }
    }
    store.$update(ACTION_SCROLL_END);
    gestureSeen = false;
  };
  const scheduleScrollEnd = () => {
    cancelTimeout(scrollEndTimer);
    scrollEndTimer = timeout(onScrollEnd, SCROLL_END_DEBOUNCE);
  };

  const onScroll = () => {
    lastScrollTime = now();
    // A delivered delta slides the stability deadline — the window is
    // measured from the LAST signal, corrections merging inside it ride
    // the single at-rest re-sync.
    settleSignal = now();

    if (justTouchEnded) {
      stillMomentumScrolling = true;
    }

    if (getStartOffset) {
      store.$update(ACTION_START_OFFSET_CHANGE, getStartOffset());
    }
    store.$update(ACTION_SCROLL, getScrollOffset());

    scheduleScrollEnd();
  };
  // Infer scroll state also from wheel events
  // Sometimes scroll events do not fire when frame dropped even if the visual have been already scrolled
  const onWheel = ((e: WheelEvent) => {
    // Fork delta 1 seam: report user-gesture activity to the store before
    // any inference filtering. A wheel on this viewport during scrolling is
    // exactly the moment WKWebView reverts written positions; ctrlKey is
    // the pinch-zoom gesture, which does not scroll. Delta 1's jam.3
    // revision also treats a wheel pulse within the stability window after
    // the last delivered scroll position as user activity on WebKit: on a
    // 120Hz display with dropped frames the tail can outrun a debounce gap,
    // momentarily ending the scroll while deceleration continues — and
    // programmatic scrolls never dispatch wheel events, so #942's
    // immediate writes are untouched. The hold cannot stick: it is bounded
    // by the scroll-end timer that last scroll event armed.
    if (
      !e.ctrlKey &&
      (store.$isScrolling() ||
        (isWebKit() && now() - lastScrollTime < SCROLL_END_DEBOUNCE))
    ) {
      store.$update(ACTION_USER_GESTURE, true);
      gestureSeen = true;
      // (P) same preemption at the wheel report; the fold-in below covers
      // the still-scrolling case, this covers a live timer with direction
      // already idle.
      settleSignal = now();
      if (scrollEndTimer !== undefined) scheduleScrollEnd();
    }
    // Fork delta 1 (jam.3 final): the wheel stream folds into the stability
    // re-arm for the WHOLE user session — during a gesture the re-report
    // above hands the park to the gesture flag (clearing the hold term), so
    // keying the fold on the hold alone would miss exactly the gappy streams
    // it exists for. gestureSeen (not isScrolling's raw direction) keeps
    // programmatic sessions out; a pulse IS the signal that the session
    // continues, sliding the deadline of the eventual held release.
    if (isWebKit() && !e.ctrlKey && gestureSeen && store.$isScrolling()) {
      settleSignal = now();
      scheduleScrollEnd();
    }
    if (
      wheeling ||
      // Scroll start should be detected with scroll event
      !store.$isScrolling() ||
      // Probably a pinch-to-zoom gesture
      e.ctrlKey
    ) {
      return;
    }

    const timeDelta = now() - lastScrollTime;
    if (
      // Check if wheel event occurs some time after scrolling
      150 > timeDelta &&
      50 < timeDelta &&
      // Get delta before checking deltaMode for firefox behavior
      // https://github.com/w3c/uievents/issues/181#issuecomment-392648065
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1392460#c34
      (isHorizontal ? e.deltaX : e.deltaY)
    ) {
      wheeling = true;
    }
  }) as (e: Event) => void; // FIXME type error. why only here?

  const onTouchStart = () => {
    touching = true;
    store.$update(ACTION_USER_GESTURE, true);
    gestureSeen = true;
    // jam.3 final contract (P): a gesture re-engaging while a scroll-end
    // epoch is pending takes the timeline over — the old timer must not
    // fire a commit mid-gesture; this gesture's deliveries restart epochs
    // and its release re-arms the hold.
    settleSignal = now();
    if (scrollEndTimer !== undefined) scheduleScrollEnd();
    justTouchEnded = stillMomentumScrolling = false;
  };
  const onTouchEnd = () => {
    touching = false;
    // Post-lift momentum on iOS is covered by the direction branch of the
    // deferral; desktop engines get their momentum from wheel events, which
    // keep re-reporting the gesture. Clear here so a lifted touch cannot
    // leave the seam stuck active.
    store.$update(ACTION_USER_GESTURE, false);
    if (isIOSWebKit()) {
      justTouchEnded = true;
    }
  };

  viewport.addEventListener("scroll", onScroll);
  viewport.addEventListener("wheel", onWheel, { passive: true });
  viewport.addEventListener("touchstart", onTouchStart, { passive: true });
  viewport.addEventListener("touchend", onTouchEnd, { passive: true });

  return {
    _sync: onScroll,
    _dispose: () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("touchstart", onTouchStart);
      viewport.removeEventListener("touchend", onTouchEnd);
      cancelTimeout(scrollEndTimer);
      unsubscribeBurst();
      cancelTimeout(burstEndTimer);
    },
    _fixScrollJump: () => {
      const [jump, shift] = store._flushJump();
      if (!jump) return;

      if (stillMomentumScrolling && onMomentumJump) {
        onMomentumJump();
      }
      stillMomentumScrolling = false;

      const from = store.$getScrollOffset();
      const to = from + jump;
      const end =
        store.$getStartSpacerSize() +
        store.$getTotalSize() -
        store.$getViewportSize();
      if (to <= 0 || to >= end || from >= end) {
        // Use absolute position at the edges not to exceed scrollable bounds
        // https://github.com/inokawa/virtua/discussions/475
        // https://github.com/inokawa/virtua/issues/983
        scrollTo(to);
      } else {
        // Use relative position not to overwrite concurrent scrolling
        // https://github.com/inokawa/virtua/issues/898
        scroller.scrollBy({
          [scrollToKey]: normalizeScrollOffset(jump),
          behavior: "instant",
        });
      }

      if (shift) {
        // https://github.com/inokawa/virtua/issues/357
        cancelScroll && cancelScroll();

        if (store.$getViewportSize() > store.$getTotalSize()) {
          // In this case applying jump may not cause scroll.
          // Current logic expects scroll event occurs after applying jump so we dispatch it manually.
          store.$update(ACTION_SCROLL, getScrollOffset());
        }
      }
    },
    _scroll: (getTargetOffset: () => number, smooth?: boolean) => {
      if (cancelScroll) {
        // Cancel waiting scrollTo
        cancelScroll();
      }

      let stopped: boolean | undefined;
      let timerId: ReturnType<typeof timeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      // Stopping is kept as a state, not delivered as an event, so it can never be missed by a race with measurement
      // https://github.com/inokawa/virtua/issues/715
      const stop = (cancelScroll = () => {
        stopped = true;
        cancelTimeout(timerId);
        unsubscribe && unsubscribe();
      });

      // The scroll destination is not fixed until the items on the way are measured and the timing is not predictable
      const onMeasured = () => {
        if (stopped) {
          return;
        }

        // Resize event may not happen when the window/tab is not visible, or during browser back in Safari.
        // We have to wait for the initial measurement to avoid failing imperative scroll on mount.
        // https://github.com/inokawa/virtua/issues/450
        if (store.$getViewportSize()) {
          // Stop when items around scroll destination completely measured
          cancelTimeout(timerId);
          timerId = timeout(stop, 150);
        }

        if (smooth) {
          // Smooth scrolling can be started only once, so wait for all the items on the way to be measured.
          for (let [i, end] = store.$getRange(0); i <= end; i++) {
            if (store.$isUnmeasuredItem(i)) {
              return;
            }
          }
          stop();
        }

        store.$update(ACTION_MANUAL_SCROLL);
        scrollTo(getTargetOffset(), smooth);
      };

      const start = () => {
        if (stopped) {
          return;
        }
        // Batch the measurements in the same task to scroll only once
        let queued: boolean | undefined;
        unsubscribe = store.$subscribe(UPDATE_SIZE_EVENT, () => {
          if (queued) {
            return;
          }
          queued = true;
          microtask(() => {
            queued = false;
            onMeasured();
          });
        });
        onMeasured();
      };

      if (smooth) {
        store.$update(ACTION_BEFORE_MANUAL_SMOOTH_SCROLL, getTargetOffset());
      }
      start();
    },
  };
};

/**
 * @internal
 */
export type ScrollObserver = ReturnType<typeof createScrollObserver>;
