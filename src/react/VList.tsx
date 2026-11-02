import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type Ref,
  forwardRef,
  useRef,
} from "react";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect.js";
import { type ViewportComponentAttributes } from "./types.js";
import {
  Virtualizer,
  type VirtualizerHandle,
  type VirtualizerProps,
} from "./Virtualizer.js";

/** Line step for arrow keys, in pixels. */
const KEY_LINE_STEP = 40;
/** Share of the viewport height that a page key or Space scrolls. */
const KEY_PAGE_FRACTION = 0.8;

/**
 * Scroll target for a keyboard event on a vertical viewport, or `null` when the
 * key does not scroll. The viewport scrolls itself: native keyboard scrolling
 * follows the focused element, and virtualization can unmount the row a reader
 * focused, so the viewport itself takes focus and handles the keys.
 */
const keyScrollTop = (
  viewport: HTMLElement,
  key: string,
  shiftKey: boolean,
): number | null => {
  const page = Math.max(
    KEY_LINE_STEP,
    viewport.clientHeight * KEY_PAGE_FRACTION,
  );
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return viewport.scrollHeight;
    case "ArrowUp":
      return viewport.scrollTop - KEY_LINE_STEP;
    case "ArrowDown":
      return viewport.scrollTop + KEY_LINE_STEP;
    case "PageUp":
      return viewport.scrollTop - page;
    case "PageDown":
      return viewport.scrollTop + page;
    case " ":
      return viewport.scrollTop + (shiftKey ? -page : page);
    default:
      return null;
  }
};

/**
 * Methods of {@link VList}.
 */
export interface VListHandle extends VirtualizerHandle {}

/**
 * Props of {@link VList}.
 */
export interface VListProps<T = unknown>
  extends
    Pick<
      VirtualizerProps<T>,
      | "children"
      | "data"
      | "bufferSize"
      | "itemSize"
      | "shift"
      | "horizontal"
      | "cache"
      | "ssrCount"
      | "item"
      | "onScroll"
      | "onScrollEnd"
      | "onResize"
      | "keepMounted"
    >,
    ViewportComponentAttributes {}

/**
 * Virtualized list component. See {@link VListProps} and {@link VListHandle}.
 */
export const VList = /*#__PURE__*/ forwardRef<VListHandle, VListProps>(
  (
    {
      children,
      data,
      bufferSize,
      itemSize,
      shift,
      horizontal,
      keepMounted,
      cache,
      ssrCount,
      item,
      onScroll,
      onScrollEnd,
      onResize,
      style,
      onKeyDown,
      tabIndex = 0,
      autoFocus = false,
      ...attrs
    },
    ref,
  ): ReactElement => {
    const viewportRef = useRef<HTMLDivElement>(null);
    useIsomorphicLayoutEffect(() => {
      if (autoFocus) viewportRef.current?.focus();
    }, [autoFocus]);

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (
        horizontal ||
        event.defaultPrevented ||
        event.target !== event.currentTarget
      ) {
        return;
      }
      const top = keyScrollTop(event.currentTarget, event.key, event.shiftKey);
      if (top === null) return;
      event.preventDefault();
      event.currentTarget.scrollTo({ top, behavior: "auto" });
    };

    return (
      <div
        ref={viewportRef}
        {...attrs}
        tabIndex={tabIndex}
        onKeyDown={handleKeyDown}
        style={{
          display: "block",
          [horizontal ? "overflowX" : "overflowY"]: "auto",
          contain: "strict",
          width: "100%",
          height: "100%",
          ...style,
        }}
      >
        <Virtualizer
          ref={ref}
          data={data}
          bufferSize={bufferSize}
          itemSize={itemSize}
          shift={shift}
          horizontal={horizontal}
          keepMounted={keepMounted}
          cache={cache}
          ssrCount={ssrCount}
          item={item}
          onScroll={onScroll}
          onScrollEnd={onScrollEnd}
          onResize={onResize}
        >
          {children}
        </Virtualizer>
      </div>
    );
  },
) as <T>(props: VListProps<T> & { ref?: Ref<VListHandle> }) => ReactElement;
