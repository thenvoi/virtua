import { UNCACHED } from "./cache.js";
import { isIOSWebKit, isWebKit } from "./environment.js";
import type { ItemSizeEstimator, Layout } from "./layouts/types.js";
import type { ItemResize, ItemsRange } from "./types.js";
import { abs, max, min, NULL } from "./utils.js";

const MAX_INT_32 = 0x7fffffff;

const SCROLL_IDLE = 0;
const SCROLL_DOWN = 1;
const SCROLL_UP = 2;
type ScrollDirection =
  typeof SCROLL_IDLE | typeof SCROLL_DOWN | typeof SCROLL_UP;

const SCROLL_BY_NATIVE = 0;
const SCROLL_BY_MANUAL_SCROLL = 1;
const SCROLL_BY_SHIFT = 2;
type ScrollMode =
  | typeof SCROLL_BY_NATIVE
  | typeof SCROLL_BY_MANUAL_SCROLL
  | typeof SCROLL_BY_SHIFT;

/** @internal */
export const ACTION_SCROLL = 1;
/** @internal */
export const ACTION_SCROLL_END = 2;
/** @internal */
export const ACTION_ITEM_RESIZE = 3;
/** @internal */
export const ACTION_VIEWPORT_RESIZE = 4;
/** @internal */
export const ACTION_ITEMS_LENGTH_CHANGE = 5;
/** @internal */
export const ACTION_RELAYOUT = 6;
/** @internal */
export const ACTION_START_OFFSET_CHANGE = 7;
/** @internal */
export const ACTION_MANUAL_SCROLL = 8;
/** @internal */
export const ACTION_BEFORE_MANUAL_SMOOTH_SCROLL = 9;
/** @internal */
export const ACTION_ITEM_SIZE_ESTIMATOR_CHANGE = 10;
/**
 * Fork delta 1 seam: wheel/touch activity reported by the scroll observer.
 * Desktop WebKit reverts position writes DURING a user gesture; #942's
 * relative writes remain correct for programmatic scrolls, so the deferral
 * is keyed on the gesture, not on scroll direction.
 * @internal
 */
export const ACTION_USER_GESTURE = 11;

type Actions =
  | [type: typeof ACTION_SCROLL, offset: number]
  | [type: typeof ACTION_SCROLL_END, dummy?: void]
  | [type: typeof ACTION_ITEM_RESIZE, resizes: readonly ItemResize[]]
  | [type: typeof ACTION_VIEWPORT_RESIZE, size: number]
  | [
      type: typeof ACTION_ITEMS_LENGTH_CHANGE,
      length: number,
      isShift?: boolean | undefined,
    ]
  | [type: typeof ACTION_RELAYOUT, jump: number]
  | [type: typeof ACTION_START_OFFSET_CHANGE, offset: number]
  | [type: typeof ACTION_MANUAL_SCROLL, dummy?: void]
  | [type: typeof ACTION_BEFORE_MANUAL_SMOOTH_SCROLL, offset: number]
  | [
      type: typeof ACTION_ITEM_SIZE_ESTIMATOR_CHANGE,
      estimator: ItemSizeEstimator | null,
    ]
  | [type: typeof ACTION_USER_GESTURE, active: boolean];

/** @internal */
export const UPDATE_VIRTUAL_STATE = 0b0001;
/** @internal */
export const UPDATE_SIZE_EVENT = 0b0010;
/** @internal */
export const UPDATE_SCROLL_EVENT = 0b0100;
/** @internal */
export const UPDATE_SCROLL_END_EVENT = 0b1000;

/**
 * @internal
 */
export const getScrollSize = (store: VirtualStore): number => {
  return max(store.$getTotalSize(), store.$getViewportSize());
};

/**
 * @internal
 */
export const relayout = <A, B>(
  store: VirtualStore,
  layout: {
    $relayout(a: A, b?: B): boolean;
    $getItemOffset(index: number): number;
  },
  a: A,
  b?: B,
): void => {
  const anchorIndex = store._getAnchorIndex();
  const anchorOffset = layout.$getItemOffset(anchorIndex);
  if (layout.$relayout(a, b)) {
    store.$update(
      ACTION_RELAYOUT,
      layout.$getItemOffset(anchorIndex) - anchorOffset,
    );
  }
};

type Subscriber = (sync?: boolean) => void;

/** @internal */
export type StateVersion =
  number & {}; /* hack for typescript to pretend as not falsy */

/**
 * @internal
 */
export type VirtualStore = {
  $dispose(): void;
  $getStateVersion(): StateVersion;
  $getRange(bufferSize?: number): ItemsRange;
  _getAnchorIndex(): number;
  $getItemOffset(index: number): number;
  $getScrollOffset(): number;
  $isScrolling(): boolean;
  $getViewportSize(): number;
  $getStartSpacerSize(): number;
  $getTotalSize(): number;
  /**
   * Rebuild the measured-size cache from the previous identity order (fork
   * delta 6). Returns false when the store cannot prove the source is safe,
   * including while automatic item-size estimation is active or the layout
   * cannot remap its sizes.
   */
  $remapItems(args: {
    previousLength: number;
    order: readonly number[];
  }): boolean;
  _flushJump(): [number, boolean];
  $subscribe(target: number, cb: Subscriber): () => void;
  $update(...action: Actions): void;
};

type RetainedLengthChange = {
  fromLength: number;
  toLength: number;
  sizes: readonly number[];
};

/**
 * @internal
 */
export const createVirtualStore = (
  {
    $getRange: getRange,
    $findIndex: findIndex,
    $getItemOffset: getItemOffset,
    $getItemSize: getItemSize,
    $setItemSizes: setItemSizes,
    $getTotalSize: getTotalSize,
    $getLength: getLength,
    $setLength: setLength,
    $isEstimating: isEstimating,
    $setEstimator: setEstimator,
    $remapSource: getSizes,
    $replaceSizes: replaceSizes,
  }: Layout,
  ssrCount: number = 0,
): VirtualStore => {
  let isSSR = !!ssrCount;
  let stateVersion: StateVersion = 1;
  let viewportSize = 0;
  let startSpacerSize = 0;
  let scrollOffset = 0;
  let jump = 0;
  let pendingJump = 0;
  let _flushedJump = 0;
  let _scrollDirection: ScrollDirection = SCROLL_IDLE;
  // Fork delta 1 seam: set while a user scroll gesture (wheel/touch) is
  // active; the desktop-WebKit deferral keys on this, not on direction —
  // programmatic scrolls must keep #942's immediate relative writes.
  let _userGestureActive = false;
  let _scrollMode: ScrollMode = SCROLL_BY_NATIVE;
  let _frozenRange: ItemsRange | null = NULL;
  let _prevRange: ItemsRange = [0, isSSR ? max(ssrCount - 1, 0) : -1];
  let _isViewportMeasured = false;
  let retainedLengthChange: RetainedLengthChange | null = null;

  const subscribers = new Set<[number, Subscriber]>();
  const getRelativeScrollOffset = () => scrollOffset - startSpacerSize;
  const getVisibleOffset = () => getRelativeScrollOffset() + pendingJump + jump;

  const shouldKeep = (index: number, start: number): boolean => {
    const itemOffset = getItemOffset(index);
    const itemSize = getItemSize(index);
    return _scrollDirection !== SCROLL_DOWN && _scrollMode === SCROLL_BY_NATIVE
      ? // https://github.com/inokawa/virtua/issues/385
        // https://github.com/inokawa/virtua/discussions/865
        // https://github.com/inokawa/virtua/issues/893
        // Use "<=" instead of "<" here so the item whose bottom rests exactly on the viewport top (the row directly above an item anchored to the top) is compensated too.
        itemOffset + itemSize <= start
      : // https://github.com/inokawa/virtua/pull/868
        itemOffset < start && itemOffset + itemSize < start + viewportSize;
  };

  const applyJump = (j: number) => {
    if (j) {
      const deferredByGesture =
        // In iOS WebKit browsers, updating scroll position will stop scrolling
        // so it have to be deferred during scrolling.
        (isIOSWebKit() && _scrollDirection !== SCROLL_IDLE) ||
        // Desktop WebKit (WKWebView) reverts a scroll position written during
        // a USER gesture; on 0.53.3 the deferral keys on the observer's
        // wheel/touch seam rather than direction, so programmatic scrolls
        // keep #942's relative writes (FORK-CHANGES.md delta 1).
        (isWebKit() && _userGestureActive);
      if (
        deferredByGesture ||
        // Before imperative smooth scrolling, we measure all items which may be visible during scrolling.
        // However, especially in Firefox, there are rare cases where items resize while scrolling, which can stop smooth scrolling.
        (_frozenRange && _scrollMode === SCROLL_BY_MANUAL_SCROLL)
      ) {
        pendingJump += j;
        // A parked correction is height the list does not yet know it has.
        // Left unbounded it reaches thousands of pixels, and the scroll then
        // bottoms out short of the real top while offsets map to rows that
        // are not on screen. Cap the GESTURE backlog at one viewport and
        // apply the excess immediately; the frozen-range park belongs to
        // #942's contract and stays until scroll end (FORK-CHANGES.md delta 2).
        if (
          deferredByGesture &&
          viewportSize &&
          abs(pendingJump) > viewportSize
        ) {
          jump += pendingJump;
          pendingJump = 0;
        }
      } else {
        jump += j;
      }
    }
  };

  const getAnchorIndex = (): number => {
    const length = getLength();
    if (_scrollMode === SCROLL_BY_SHIFT) {
      // Keep distance from end during shifting
      return length;
    }
    if (_frozenRange && _scrollMode === SCROLL_BY_MANUAL_SCROLL) {
      // https://github.com/inokawa/virtua/issues/380
      // https://github.com/inokawa/virtua/issues/590
      // https://github.com/inokawa/virtua/issues/758
      // The range may exceed the length decreased after it was frozen
      return min(_frozenRange[0], length);
    }
    // Otherwise we should maintain visible position

    // The anchor is the first item not to keep
    const start = getVisibleOffset();
    let anchorIndex = findIndex(start);
    // Before the item at the start of the viewport, only the empty items at the start may not be kept
    while (anchorIndex > 0 && !shouldKeep(anchorIndex - 1, start)) {
      anchorIndex--;
    }
    // From the item at the start of the viewport, the items starting above the viewport may be kept, which can be several in masonry as they are in different lanes
    while (anchorIndex < length && shouldKeep(anchorIndex, start)) {
      anchorIndex++;
    }
    return anchorIndex;
  };

  // Fork delta 6: rebuild the size cache from the caller's previous identity
  // order. Each new index points at its previous index or -1.
  const remapItems = ({
    previousLength,
    order,
  }: {
    previousLength: number;
    order: readonly number[];
  }): boolean => {
    if (
      !replaceSizes ||
      !getSizes ||
      isEstimating() ||
      order.length !== getLength()
    ) {
      return false;
    }

    const source =
      previousLength === getLength()
        ? getSizes()
        : retainedLengthChange &&
            retainedLengthChange.fromLength === previousLength &&
            retainedLengthChange.toLength === getLength() &&
            retainedLengthChange.sizes.length === previousLength
          ? retainedLengthChange.sizes
          : undefined;
    if (!source) return false;

    const sizes = new Array<number>(getLength());
    for (let index = 0; index < order.length; index++) {
      const sourceIndex = order[index]!;
      if (
        !Number.isInteger(sourceIndex) ||
        sourceIndex < -1 ||
        sourceIndex >= source.length
      ) {
        return false;
      }
      const size = sourceIndex === -1 ? UNCACHED : source[sourceIndex]!;
      if (size !== UNCACHED && !Number.isFinite(size)) return false;
      sizes[index] = size;
    }

    replaceSizes(sizes);
    if (previousLength !== getLength()) {
      retainedLengthChange = null;
    }
    // A genuine reorder/filter — at a stable length, or landing mid-way
    // through a length change it does not itself belong to — changes which
    // row a given index refers to. Any still-parked scroll-position
    // correction computed against the OLD mapping — most commonly an
    // item-size estimator swap deferred through an in-progress gesture, see
    // ACTION_ITEM_SIZE_ESTIMATOR_CHANGE — is now stale and must not be
    // released later at ACTION_SCROLL_END; discard it here. A length
    // difference ALONE does not prove the correction belongs to this remap:
    // source-authority recovery/reload changes count too, and a non-shift
    // growth (ACTION_ITEMS_LENGTH_CHANGE's isShift false) never calls
    // applyJump at all, so any jump/pendingJump present when ITS remap runs
    // is necessarily a leftover from something else entirely. Two cases stay
    // safe to preserve: completing an in-flight ACTION_ITEMS_LENGTH_CHANGE
    // SHIFT/growth transaction — detected by _scrollMode still being
    // SCROLL_BY_SHIFT, which only that transaction sets and only a remap or
    // scroll-end ever clears — and a same-length identity permutation
    // (order[i] === i for every i) that moves no row at all, so replaceSizes
    // just wrote back the identical values.
    const isCompletingShiftGrowth =
      previousLength !== getLength() && _scrollMode === SCROLL_BY_SHIFT;
    const isIdentityReorder =
      !isCompletingShiftGrowth &&
      previousLength === getLength() &&
      order.every((sourceIndex, index) => sourceIndex === index);
    if (!isCompletingShiftGrowth && !isIdentityReorder) {
      jump = 0;
      pendingJump = 0;
    }
    _flushedJump = 0;
    _frozenRange = NULL;
    _scrollMode = SCROLL_BY_NATIVE;
    stateVersion = (stateVersion & MAX_INT_32) + 1;
    subscribers.forEach(([target, cb]) => {
      if (target & UPDATE_VIRTUAL_STATE) cb(false);
    });
    return true;
  };

  return {
    $dispose: () => {
      subscribers.clear();
    },
    $getStateVersion: () => stateVersion,
    $getRange: (bufferSize = 200) => {
      if (!_isViewportMeasured || isSSR) {
        // Return range for SSR, or return [0, -1] to render nothing, until the scroll offset and viewport size are determined.
        // https://github.com/inokawa/virtua/issues/415
        // https://github.com/inokawa/virtua/pull/818
        return _prevRange;
      }
      let startIndex: number;
      let endIndex: number;
      if (_flushedJump) {
        // Return previous range for consistent render until next scroll event comes in.
        // And it must be clamped. https://github.com/inokawa/virtua/issues/597
        [startIndex, endIndex] = _prevRange;
      } else {
        let startOffset = max(0, getVisibleOffset());
        let endOffset = startOffset + viewportSize;

        // For faster initial render pass, returns without buffer if measurement seems to be in progress.
        if (!isEstimating()) {
          bufferSize = max(0, bufferSize);

          if (_scrollDirection !== SCROLL_DOWN) {
            startOffset -= bufferSize;
          }
          if (_scrollDirection !== SCROLL_UP) {
            endOffset += bufferSize;
          }
        }

        [startIndex, endIndex] = _prevRange = getRange(
          max(0, startOffset),
          max(0, endOffset),
        );
        if (_frozenRange) {
          startIndex = min(startIndex, _frozenRange[0]);
          endIndex = max(endIndex, _frozenRange[1]);
        }
      }

      return [max(startIndex, 0), min(endIndex, getLength() - 1)];
    },
    _getAnchorIndex: getAnchorIndex,
    $getItemOffset: (index) => {
      return getItemOffset(index) - pendingJump;
    },
    $getScrollOffset: () => scrollOffset,
    $isScrolling: () => _scrollDirection !== SCROLL_IDLE,
    $getViewportSize: () => viewportSize,
    $getStartSpacerSize: () => startSpacerSize,
    $getTotalSize: getTotalSize,
    $remapItems: remapItems,
    _flushJump: () => {
      _flushedJump = jump;
      jump = 0;
      return [_flushedJump, _scrollMode === SCROLL_BY_SHIFT];
    },
    $subscribe: (target, cb) => {
      const sub: [number, Subscriber] = [target, cb];
      subscribers.add(sub);
      return () => {
        subscribers.delete(sub);
      };
    },
    $update: (type, payload, payload2?): void => {
      let shouldFlushPendingJump: boolean | undefined;
      let shouldSync: boolean | undefined;
      let mutated = 0;

      switch (type) {
        case ACTION_SCROLL: {
          if (payload === scrollOffset && _scrollMode === SCROLL_BY_NATIVE) {
            // Ignore scroll events from different direction
            break;
          }

          const flushedJump = _flushedJump;
          _flushedJump = 0;

          const delta = payload - scrollOffset;
          const distance = abs(delta);

          // Scroll event after jump compensation is not reliable because it may result in the opposite direction.
          // The delta of artificial scroll may not be equal with the jump because it may be batched with other scrolls.
          // And at least in latest Chrome/Firefox/Safari in 2023, setting value to scrollTop/scrollLeft can lose subpixel because its integer (sometimes float probably depending on dpr).
          const isJustJumped = flushedJump && distance < abs(flushedJump) + 1;

          // Scroll events are dispatched enough so it's ok to skip some of them.
          if (
            !isJustJumped &&
            // Ignore until manual scrolling
            _scrollMode === SCROLL_BY_NATIVE
          ) {
            _scrollDirection = delta < 0 ? SCROLL_UP : SCROLL_DOWN;
          }

          // TODO This will cause glitch in reverse infinite scrolling. Disable this until better solution is found.
          // if (
          //   pendingJump &&
          //   ((_scrollDirection === SCROLL_UP &&
          //     payload - max(pendingJump, 0) <= 0) ||
          //     (_scrollDirection === SCROLL_DOWN &&
          //       payload - min(pendingJump, 0) >= getScrollOffsetMax()))
          // ) {
          //   // Flush if almost reached to start or end
          //   shouldFlushPendingJump = true;
          // }

          if (isSSR) {
            isSSR = false;
          }

          scrollOffset = payload;
          mutated = UPDATE_SCROLL_EVENT;

          // Skip if offset is not changed
          // Scroll offset may exceed min or max especially in Safari's elastic scrolling.
          const relativeOffset = getRelativeScrollOffset();
          if (
            relativeOffset >= -viewportSize &&
            relativeOffset <= getTotalSize()
          ) {
            mutated += UPDATE_VIRTUAL_STATE;

            // Update synchronously if scrolled a lot
            shouldSync = distance > viewportSize;
          }
          break;
        }
        case ACTION_SCROLL_END: {
          mutated = UPDATE_SCROLL_END_EVENT;
          if (_scrollDirection !== SCROLL_IDLE) {
            shouldFlushPendingJump = true;
            mutated += UPDATE_VIRTUAL_STATE;
          }
          _scrollDirection = SCROLL_IDLE;
          _scrollMode = SCROLL_BY_NATIVE;
          _frozenRange = NULL;
          _userGestureActive = false;
          break;
        }
        case ACTION_ITEM_RESIZE: {
          // Skip if all items are cached and not updated
          if (payload.length) {
            const anchorIndex = getAnchorIndex();
            const anchorOffset = getItemOffset(anchorIndex);
            setItemSizes(payload, viewportSize);
            // Calculate jump by resize to minimize janks in appearance
            applyJump(getItemOffset(anchorIndex) - anchorOffset);

            mutated = UPDATE_VIRTUAL_STATE + UPDATE_SIZE_EVENT;

            // Synchronous update is necessary in current design to minimize visible glitch in concurrent rendering.
            // However this seems to be the main cause of the errors from ResizeObserver.
            // https://github.com/inokawa/virtua/issues/470
            //
            // And in React, synchronous update with flushSync after asynchronous update will overtake the asynchronous one.
            // If items resize happens just after scroll, race condition can occur depending on implementation.
            shouldSync = true;
          }
          break;
        }
        case ACTION_VIEWPORT_RESIZE: {
          if (viewportSize !== payload) {
            if (!viewportSize) {
              _isViewportMeasured = shouldSync = true;
            }
            viewportSize = payload;
            mutated = UPDATE_VIRTUAL_STATE + UPDATE_SIZE_EVENT;
          }
          break;
        }
        case ACTION_ITEMS_LENGTH_CHANGE: {
          // Skip if the length is not changed, as the layouts discard the sizes even then
          if (payload !== getLength()) {
            // Fork delta 6: retain the exact pre-change window for the remap
            // completing this transaction. A no-op render dispatch must not
            // supersede that window.
            retainedLengthChange = {
              fromLength: getLength(),
              toLength: payload,
              sizes: getSizes ? getSizes().slice() : [],
            };
            if (payload2) {
              const totalSize = getTotalSize();
              setLength(payload, true);
              applyJump(getTotalSize() - totalSize);
              _scrollMode = SCROLL_BY_SHIFT;
            } else {
              setLength(payload);
            }
            // https://github.com/inokawa/virtua/issues/552
            // https://github.com/inokawa/virtua/issues/557
            mutated = UPDATE_VIRTUAL_STATE;
          }
          break;
        }
        case ACTION_RELAYOUT: {
          // It never requests a synchronous update, so it's safe to dispatch during render.
          applyJump(payload);
          mutated = UPDATE_VIRTUAL_STATE;
          break;
        }
        case ACTION_USER_GESTURE: {
          _userGestureActive = payload;
          break;
        }
        case ACTION_START_OFFSET_CHANGE: {
          startSpacerSize = payload;
          break;
        }
        case ACTION_MANUAL_SCROLL: {
          _scrollMode = SCROLL_BY_MANUAL_SCROLL;
          break;
        }
        case ACTION_ITEM_SIZE_ESTIMATOR_CHANGE: {
          // Fork delta 5: an estimator swap is a geometry mutation. Use the
          // same anchor as measurement and relayout, including shift and
          // frozen-range modes, then pass its delta through the existing hold.
          if (setEstimator) {
            const anchorIndex = getAnchorIndex();
            const anchorOffset = getItemOffset(anchorIndex);
            if (setEstimator(payload)) {
              applyJump(getItemOffset(anchorIndex) - anchorOffset);
              mutated = UPDATE_VIRTUAL_STATE;
            }
          }
          break;
        }
        case ACTION_BEFORE_MANUAL_SMOOTH_SCROLL: {
          _frozenRange = getRange(payload, payload + viewportSize);
          mutated = UPDATE_VIRTUAL_STATE;
          break;
        }
      }

      if (mutated) {
        stateVersion = (stateVersion & MAX_INT_32) + 1;

        if (shouldFlushPendingJump && pendingJump) {
          jump += pendingJump;
          pendingJump = 0;
        }

        subscribers.forEach(([target, cb]) => {
          // Early return to skip React's computation
          if (!(mutated & target)) {
            return;
          }
          // https://github.com/facebook/react/issues/25191
          // https://github.com/facebook/react/blob/a5fc797db14c6e05d4d5c4dbb22a0dd70d41f5d5/packages/react-reconciler/src/ReactFiberWorkLoop.js#L1443-L1447
          cb(shouldSync);
        });
      }
    },
  };
};
