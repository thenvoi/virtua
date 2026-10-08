import {
  type JSX,
  type ReactElement,
  forwardRef,
  useImperativeHandle,
  type ReactNode,
  useRef,
  type RefObject,
  useReducer,
  type Ref,
} from "react";
import {
  UPDATE_SCROLL_EVENT,
  ACTION_ITEMS_LENGTH_CHANGE,
  ACTION_ITEM_SIZE_ESTIMATOR_CHANGE,
  createVirtualStore,
  createListLayout,
  UPDATE_VIRTUAL_STATE,
  UPDATE_SCROLL_END_EVENT,
  UPDATE_SIZE_EVENT,
  getScrollSize,
  ACTION_START_OFFSET_CHANGE,
  createContainerDriver,
  scrollTo,
  scrollBy,
  scrollToIndex,
  type CacheSnapshot,
  type ScrollToIndexOpts,
  microtask,
  sort,
} from "../core/index.js";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect.js";
import {
  getKey,
  refKey,
  type ItemElement as CachedRowElement,
} from "./utils.js";
import { useStatic } from "./useStatic.js";
import { useLatestRef } from "./useLatestRef.js";
import { ListItem } from "./ListItem.js";
import { flushSync } from "react-dom";
import { useChildren } from "./useChildren.js";
import {
  type CustomContainerComponent,
  type CustomItemComponent,
} from "./types.js";

/**
 * Methods of {@link Virtualizer}.
 */
export interface VirtualizerHandle {
  /**
   * Get current {@link CacheSnapshot}.
   */
  readonly cache: CacheSnapshot;
  /**
   * Get current scrollTop, or scrollLeft if horizontal: true. Always positive even in RTL.
   */
  readonly scrollOffset: number;
  /**
   * Get current scrollHeight, or scrollWidth if horizontal: true.
   */
  readonly scrollSize: number;
  /**
   * Get current clientHeight, or clientWidth if horizontal: true.
   */
  readonly viewportSize: number;
  /**
   * Find nearest item index from offset.
   * @param offset offset in pixels from the start of the scroll container
   */
  findItemIndex(offset: number): number;
  /**
   * Get item offset from start.
   * @param index index of item
   */
  getItemOffset(index: number): number;
  /**
   * Get item size.
   * @param index index of item
   */
  getItemSize(index: number): number;
  /**
   * Scroll to the item specified by index.
   * @param index index of item
   * @param opts options
   */
  scrollToIndex(index: number, opts?: ScrollToIndexOpts): void;
  /**
   * Scroll to the given offset.
   * @param offset offset from start
   */
  scrollTo(offset: number): void;
  /**
   * Scroll by the given offset.
   * @param offset offset from current position
   */
  scrollBy(offset: number): void;
  /**
   * Rebuild measured item sizes from the previous identity order (fork delta 6).
   *
   * The caller supplies identity order only. Each new index points to its
   * previous index or -1. Returns false when the store cannot prove the source
   * is safe, including while automatic item-size estimation is active.
   */
  remapItems(args: {
    previousLength: number;
    order: readonly number[];
  }): boolean;
  /**
   * Return whether an item has no measured size.
   */
  isUnmeasuredItem(index: number): boolean;
}

/**
 * Props of {@link Virtualizer}.
 */
export interface VirtualizerProps<T = unknown> {
  /**
   * Elements rendered by this component.
   *
   * You can also pass a function and set {@link VirtualizerProps.data} to create elements lazily.
   */
  children: ReactNode | ((data: T, index: number) => ReactElement);
  /**
   * The data items rendered by this component. If you set a function to {@link VirtualizerProps.children}, you have to set this prop.
   */
  data?: ArrayLike<T>;
  /**
   * Extra item space in pixels to render before/after the viewport. The minimum value is 0. Lower value will give better performance but you can increase to avoid showing blank items in fast scrolling.
   * @defaultValue 200
   */
  bufferSize?: number;
  /**
   * Item size hint for unmeasured items in pixels. It will help to reduce scroll jump when items are measured if used properly.
   *
   * - If not set, initial item sizes will be automatically estimated from measured sizes. This is recommended for most cases.
   * - If set to a number, you can opt out estimation and use the value as initial item size.
   * - If set to a function, it is called with a raw mounted index (not a caller
   *   identity/key) to price each still-unmeasured row individually. Must be
   *   cheap/O(1) — it can run many times synchronously (offset walks, binary
   *   search over a large unmeasured range). A non-finite or non-positive
   *   result falls back to this store's own configured/default size, not any
   *   caller-specific floor — callers needing a floor/ceiling must clamp
   *   inside their own function. Fork delta 5, not upstream virtua.
   */
  itemSize?: number | ((index: number) => number);
  /**
   * Set true only when items are added to or removed from the start of the list, such as when older items are loaded in reverse infinite scrolling. In that case, the scroll position is maintained from the end of the list instead of the start.
   *
   * **Do not set true in any other case, as it can cause unexpected behavior.**
   */
  shift?: boolean;
  /**
   * If true, rendered as a horizontally scrollable list. Otherwise rendered as a vertically scrollable list.
   */
  horizontal?: boolean;
  /**
   * List of indexes that should be always mounted, even when off screen.
   */
  keepMounted?: readonly number[];
  /**
   * You can restore cache by passing a {@link CacheSnapshot} on mount. This is useful when you want to restore scroll position after navigation. The snapshot can be obtained from {@link VirtualizerHandle.cache}.
   *
   * **The length of items should be the same as when you take the snapshot, otherwise restoration may not work as expected.**
   */
  cache?: CacheSnapshot;
  /**
   * The offset to the scrollable parent before virtualizer in pixels. If you put an element before virtualizer, you have to set its height to this prop.
   */
  startMargin?: number;
  /**
   * A prop for SSR. If set, the specified amount of items will be mounted in the initial rendering regardless of the container size until hydrated. The minimum value is 0.
   */
  ssrCount?: number;
  /**
   * Component or element type for container element.
   * @defaultValue "div"
   */
  as?: keyof JSX.IntrinsicElements | CustomContainerComponent;
  /**
   * Component or element type for item element. This component will get {@link CustomItemComponentProps} as props.
   * @defaultValue "div"
   */
  item?: keyof JSX.IntrinsicElements | CustomItemComponent;
  /**
   * Reference to the scrollable element. The default will get the direct parent element of virtualizer.
   */
  scrollRef?: RefObject<HTMLElement | null>;
  /**
   * Callback invoked whenever scroll offset changes.
   * @param offset Current scrollTop, or scrollLeft if horizontal: true.
   */
  onScroll?: (offset: number) => void;
  /**
   * Callback invoked when scrolling stops.
   */
  onScrollEnd?: () => void;
  /**
   * Callback invoked when the size of the viewport or the items changes.
   */
  onResize?: () => void;
}

/**
 * Customizable list virtualizer for advanced usage. See {@link VirtualizerProps} and {@link VirtualizerHandle}.
 */
export const Virtualizer = /*#__PURE__*/ forwardRef<
  VirtualizerHandle,
  VirtualizerProps
>(
  (
    {
      children,
      data,
      bufferSize,
      itemSize,
      shift,
      horizontal: horizontalProp,
      keepMounted,
      cache,
      startMargin = 0,
      ssrCount,
      as: Element = "div",
      item: ItemElement = "div",
      scrollRef,
      onScroll: onScrollProp,
      onScrollEnd: onScrollEndProp,
      onResize: onResizeProp,
    },
    ref,
  ): ReactElement => {
    // Opted out on purpose. React Compiler has nothing to gain here for now: scrolling is bound by DOM mount/unmount and layout rather than scripting, the items are already memoized by React.memo, and the visible range and positions read from the store below change on every store update.
    // Making those reads memoizable needs an immutable snapshot per update, which costs allocation with useReducer or synchronous updates with useSyncExternalStore.
    "use no memo";

    Element = Element as "div";

    const [renderElement, count] = useChildren(children, data);

    const containerRef = useRef<HTMLDivElement>(null);

    const isSSR = useRef(!!ssrCount);

    const onScroll = useLatestRef(onScrollProp);
    const onScrollEnd = useLatestRef(onScrollEndProp);
    const onResize = useLatestRef(onResizeProp);

    const [store, layout, driver, isHorizontal] = useStatic(() => {
      const _isHorizontal = !!horizontalProp;
      const _layout = createListLayout(count, itemSize, cache);
      const _store = createVirtualStore(_layout, ssrCount);
      return [
        _store,
        _layout,
        createContainerDriver(_store, _isHorizontal),
        _isHorizontal,
      ];
    });

    // Fork delta 5: keep the installed per-index estimator in sync with the
    // prop. Ordering matters when both the estimator and the count change
    // together (e.g. a full content reload or a prepend). A shift (prepend)
    // moves every surviving old index to a new position — the incoming
    // estimator's closure is already built against the POST-shift data array,
    // so swapping before the shift would recompute/pin estimates against the
    // wrong identities (new callback, old cache index space). A shrink must
    // price removed rows with whichever estimator priced them originally.
    // Both cases dispatch the length change first, then swap. Only a plain
    // (non-shift) growth swaps first, so new indices see the incoming
    // estimator. This also fixes `_scrollMode` timing for the shift-vs-anchor
    // compensation branch in the store, which only becomes SCROLL_BY_SHIFT
    // inside the length-change handler.
    const itemSizeEstimator = typeof itemSize === "function" ? itemSize : null;
    const oldItemsLength = store.$getItemsLength();
    if (shift || count < oldItemsLength) {
      if (count !== oldItemsLength) {
        store.$update(ACTION_ITEMS_LENGTH_CHANGE, [count, shift]);
      }
      store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, itemSizeEstimator);
    } else {
      store.$update(ACTION_ITEM_SIZE_ESTIMATOR_CHANGE, itemSizeEstimator);
      if (count !== oldItemsLength) {
        store.$update(ACTION_ITEMS_LENGTH_CHANGE, [count, shift]);
      }
    }
    if (startMargin !== store.$getStartSpacerSize()) {
      store.$update(ACTION_START_OFFSET_CHANGE, startMargin);
    }

    const [stateVersion, rerender] = useReducer(
      store.$getStateVersion,
      undefined,
      store.$getStateVersion,
    );

    const isScrolling = store.$isScrolling();
    const totalSize = store.$getTotalSize();

    // Identity cache: retain each renderElement(index) result across Virtualizer-only
    // re-renders (native scroll, resize, etc.) so an unchanged mounted row keeps
    // the same `_children` identity and ListItem's memo can bail. Invalidated
    // wholesale whenever `renderElement` itself is a new reference — useChildren
    // guarantees that whenever the caller's `children` (render function) or
    // `data` identity changes, i.e. every input this row depends on. Bounded to
    // the indices actually rendered this pass (below) so scrolling cannot grow
    // it unbounded. See FORK-CHANGES.md delta 4.
    const elementCache = useRef<{
      fn: typeof renderElement | null;
      cache: Map<number, CachedRowElement>;
    }>({ fn: null, cache: new Map() });
    if (elementCache[refKey].fn !== renderElement) {
      elementCache[refKey] = { fn: renderElement, cache: new Map() };
    }
    const renderedIndices = new Set<number>();

    const items: ReactElement[] = [];

    const renderItem = (index: number) => {
      renderedIndices.add(index);
      const cache = elementCache[refKey].cache;
      let e = cache.get(index);
      if (e === undefined) {
        e = renderElement(index);
        cache.set(index, e);
      }

      return (
        <ListItem
          key={getKey(e, index)}
          _resizer={driver.$observeItem}
          _index={index}
          _offset={store.$getItemOffset(index)}
          _hide={store.$isUnmeasuredItem(index)}
          _as={ItemElement as "div"}
          _children={e}
          _isHorizontal={isHorizontal}
          _isSSR={isSSR[refKey]}
        />
      );
    };

    useIsomorphicLayoutEffect(() => {
      isSSR[refKey] = false;

      // store must be subscribed first because others may dispatch update on init depending on implementation
      store.$subscribe(UPDATE_VIRTUAL_STATE, (sync) => {
        if (sync) {
          flushSync(rerender);
        } else {
          rerender();
        }
      });
      store.$subscribe(UPDATE_SCROLL_EVENT, () => {
        onScroll[refKey] && onScroll[refKey](store.$getScrollOffset());
      });
      store.$subscribe(UPDATE_SCROLL_END_EVENT, () => {
        onScrollEnd[refKey] && onScrollEnd[refKey]();
      });
      store.$subscribe(UPDATE_SIZE_EVENT, () => {
        onResize[refKey] && onResize[refKey]();
      });
      const container = containerRef[refKey]!;
      if (scrollRef) {
        // parent's ref doesn't exist when useLayoutEffect is called
        microtask(() => {
          // https://github.com/inokawa/virtua/pull/733
          if (scrollRef[refKey]) {
            driver.$observe(container, scrollRef[refKey]);
          }
        });
      } else {
        driver.$observe(container);
      }

      return () => {
        store.$dispose();
        driver.$dispose();
      };
    }, []);

    useIsomorphicLayoutEffect(() => {
      driver.$effect();
    }, [stateVersion]);

    useImperativeHandle(ref, () => {
      return {
        get cache() {
          return layout.$snapshot();
        },
        get scrollOffset() {
          return store.$getScrollOffset();
        },
        get scrollSize() {
          return getScrollSize(store);
        },
        get viewportSize() {
          return store.$getViewportSize();
        },
        findItemIndex: (offset) =>
          layout.$findIndex(offset - store.$getStartSpacerSize()),
        getItemOffset: store.$getItemOffset,
        getItemSize: store.$getItemSize,
        scrollToIndex: (index, opts) =>
          scrollToIndex(driver, store, index, opts),
        scrollTo: (offset) => scrollTo(driver, offset),
        scrollBy: (offset) => scrollBy(driver, store, offset),
        remapItems: store.$remapItems,
        isUnmeasuredItem: store.$isUnmeasuredItem,
      };
    }, []);

    if (keepMounted) {
      const mounted = new Set(keepMounted);
      for (let [i, j] = store.$getRange(bufferSize); i <= j; i++) {
        mounted.add(i);
      }
      sort([...mounted]).forEach((index) => {
        if (index < count) {
          items.push(renderItem(index));
        }
      });
    } else {
      for (let [i, j] = store.$getRange(bufferSize); i <= j; i++) {
        items.push(renderItem(i));
      }
    }

    for (const cachedIndex of elementCache[refKey].cache.keys()) {
      if (!renderedIndices.has(cachedIndex)) {
        elementCache[refKey].cache.delete(cachedIndex);
      }
    }

    return (
      <Element
        ref={containerRef}
        style={{
          contain: "size style", // https://github.com/inokawa/virtua/pull/775 https://github.com/inokawa/virtua/issues/800
          overflowAnchor: "none", // opt out browser's scroll anchoring because it will conflict with scroll anchoring of virtualizer
          flex: "none", // flex style can break layout
          position: "relative",
          width: isHorizontal ? totalSize : "100%",
          height: isHorizontal ? "100%" : totalSize,
          pointerEvents: isScrolling ? "none" : undefined,
        }}
      >
        {items}
      </Element>
    );
  },
) as <T>(
  props: VirtualizerProps<T> & { ref?: Ref<VirtualizerHandle> },
) => ReactElement;
