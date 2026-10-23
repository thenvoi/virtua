import { it, expect, describe, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { VList } from "./VList.js";
import { setupResizeJsDom } from "../../spec/jsdom/dom.js";
import { render } from "../../spec/jsdom/react.js";

const ITEM_HEIGHT = 50;
const ITEM_WIDTH = 100;
const VIEWPORT_HEIGHT = ITEM_HEIGHT * 10;

setupResizeJsDom({
  itemSize: { width: ITEM_WIDTH, height: ITEM_HEIGHT },
  viewportSize: { width: ITEM_WIDTH, height: VIEWPORT_HEIGHT },
});

describe("vertical", async () => {
  it("should pass attributes to element", async () => {
    const { asFragment } = await render(
      <VList
        id="id"
        className="class"
        tabIndex={0}
        role="list"
        aria-label="test"
        style={{ background: "red", width: 100, height: 800 }}
      >
        <div>0</div>
      </VList>,
    );
    expect(asFragment()).toMatchSnapshot();
  });
});

describe("horizontal", async () => {
  it("should pass attributes to element", async () => {
    const { asFragment } = await render(
      <VList
        horizontal
        id="id"
        className="class"
        tabIndex={0}
        role="list"
        aria-label="test"
        style={{ background: "red", width: 100, height: 800 }}
      >
        <div>0</div>
      </VList>,
    );
    expect(asFragment()).toMatchSnapshot();
  });
});

describe("keyboard", async () => {
  const stubViewport = (viewport: HTMLElement) => {
    const scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
      const top = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
      Object.defineProperty(viewport, "scrollTop", {
        configurable: true,
        value: top,
      });
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 4_100,
    });
    viewport.scrollTo = scrollTo as unknown as typeof viewport.scrollTo;
    return scrollTo;
  };

  it("focuses the viewport on mount and scrolls it with line, page, and edge keys", async () => {
    await render(
      <VList aria-label="list" autoFocus>
        {Array.from({ length: 40 }, (_, index) => (
          <div key={index}>{index}</div>
        ))}
      </VList>,
    );
    const viewport = screen.getByLabelText("list");
    const scrollTo = stubViewport(viewport);

    expect(viewport.getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(viewport);

    fireEvent.keyDown(viewport, { key: "PageDown" });
    fireEvent.keyDown(viewport, { key: "PageDown" });
    fireEvent.keyDown(viewport, { key: "PageUp" });
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    fireEvent.keyDown(viewport, { key: "ArrowUp" });
    fireEvent.keyDown(viewport, { key: " " });
    fireEvent.keyDown(viewport, { key: " ", shiftKey: true });
    fireEvent.keyDown(viewport, { key: "Home" });
    fireEvent.keyDown(viewport, { key: "End" });
    fireEvent.keyDown(viewport, { key: "a" });

    expect(scrollTo.mock.calls).toEqual([
      [{ top: 500, behavior: "auto" }],
      [{ top: 900, behavior: "auto" }],
      [{ top: 500, behavior: "auto" }],
      [{ top: 540, behavior: "auto" }],
      [{ top: 500, behavior: "auto" }],
      [{ top: 900, behavior: "auto" }],
      [{ top: 500, behavior: "auto" }],
      [{ top: 0, behavior: "auto" }],
      [{ top: 4_100, behavior: "auto" }],
    ]);
  });

  it("leaves keys alone when a row, the caller, or a horizontal list owns them", async () => {
    const onKeyDown = vi.fn(
      (event: { key: string; preventDefault(): void }) => {
        if (event.key === "PageUp") event.preventDefault();
      },
    );
    await render(
      <>
        <VList aria-label="vertical" onKeyDown={onKeyDown}>
          <button type="button">row</button>
        </VList>
        <VList aria-label="horizontal" horizontal>
          <div>0</div>
        </VList>
      </>,
    );
    const vertical = screen.getByLabelText("vertical");
    const horizontal = screen.getByLabelText("horizontal");
    const verticalScroll = stubViewport(vertical);
    const horizontalScroll = stubViewport(horizontal);

    expect(document.activeElement).not.toBe(vertical);
    fireEvent.keyDown(screen.getByRole("button", { name: "row" }), {
      key: "PageDown",
    });
    fireEvent.keyDown(vertical, { key: "PageUp" });
    fireEvent.keyDown(horizontal, { key: "PageDown" });

    expect(onKeyDown).toHaveBeenCalledTimes(2);
    expect(verticalScroll).not.toHaveBeenCalled();
    expect(horizontalScroll).not.toHaveBeenCalled();
  });
});
