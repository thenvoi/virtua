import { it, expect, describe, vi } from "vitest";
import { act } from "@testing-library/react";
import { Virtualizer } from "./Virtualizer.js";
import { forwardRef } from "react";
import { type CustomItemComponentProps } from "./types.js";
import { setupResizeJsDom } from "../../spec/jsdom/dom.js";
import { render } from "../../spec/jsdom/react.js";
import { range } from "../../spec/utils.js";

const ITEM_HEIGHT = 50;
const ITEM_WIDTH = 100;
const VIEWPORT_HEIGHT = ITEM_HEIGHT * 10;

setupResizeJsDom({
  itemSize: { width: ITEM_WIDTH, height: ITEM_HEIGHT },
  viewportSize: { width: ITEM_WIDTH, height: VIEWPORT_HEIGHT },
});

it("should change components", async () => {
  const { asFragment } = await render(
    <div style={{ overflowY: "auto" }}>
      <Virtualizer as="ul" item="li">
        <div>0</div>
        <div>1</div>
        <div>2</div>
        <div>3</div>
        <div>4</div>
      </Virtualizer>
    </div>,
  );
  expect(asFragment()).toMatchSnapshot();
});

it("should pass index to items", async () => {
  const Item = forwardRef<HTMLDivElement, CustomItemComponentProps>(
    ({ index, ...rest }, ref) => {
      return <div ref={ref} data-index={index} {...rest} />;
    },
  );
  const { asFragment } = await render(
    <div style={{ overflowY: "auto" }}>
      <Virtualizer item={Item}>
        <div>0</div>
        <div>1</div>
        <div>2</div>
        <div>3</div>
        <div>4</div>
      </Virtualizer>
    </div>,
  );
  expect(asFragment()).toMatchSnapshot();
});

it("should render with render prop", async () => {
  const items = range(1000, (i) => ({
    id: i,
    label: "This is " + i,
  }));
  const { asFragment } = await render(
    <div style={{ overflowY: "auto" }}>
      <Virtualizer data={items}>
        {(item) => {
          return <div key={item.id}>{item.label}</div>;
        }}
      </Virtualizer>
    </div>,
  );
  expect(asFragment()).toMatchSnapshot();
});

it("should render with keepMounted", async () => {
  const { asFragment } = await render(
    <div style={{ overflowY: "auto" }}>
      <Virtualizer keepMounted={[0, 10, 20, 30, 40, 50, 60, 70, 80, 90]}>
        {range(100, (i) => (
          <div key={i}>{i}</div>
        ))}
      </Virtualizer>
    </div>,
  );
  expect(asFragment()).toMatchSnapshot();
});

describe("vertical", async () => {
  it("should render 0 children", async () => {
    const { asFragment } = await render(
      <div style={{ overflowY: "auto" }}>
        <Virtualizer>{[]}</Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render 5 children", async () => {
    const { asFragment } = await render(
      <div style={{ overflowY: "auto" }}>
        <Virtualizer>
          <div>0</div>
          <div>1</div>
          <div>2</div>
          <div>3</div>
          <div>4</div>
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render 100 children", async () => {
    const { asFragment } = await render(
      <div style={{ overflowY: "auto" }}>
        <Virtualizer>
          {range(100, (i) => (
            <div key={i}>{i}</div>
          ))}
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render non elements", async () => {
    const { asFragment } = await render(
      <div style={{ overflowY: "auto" }}>
        <Virtualizer>
          string
          {true}
          {false}
          {null}
          {undefined}
          {123}
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render fragments", async () => {
    const { asFragment } = await render(
      <div style={{ overflowY: "auto" }}>
        <Virtualizer>
          <>
            <div>fragment</div>
            <div>fragment</div>
            <div>fragment</div>
          </>
          <>
            <div>fragment</div>
          </>
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render component", async () => {
    const Comp = ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    );
    const { asFragment } = await render(
      <div style={{ overflowY: "auto" }}>
        <Virtualizer>
          <Comp>component</Comp>
          <Comp>component</Comp>
          <Comp>component</Comp>
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });
});

describe("horizontal", async () => {
  it("should render 0 children", async () => {
    const { asFragment } = await render(
      <div style={{ overflowX: "auto" }}>
        <Virtualizer horizontal>{[]}</Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render 5 children", async () => {
    const { asFragment } = await render(
      <div style={{ overflowX: "auto" }}>
        <Virtualizer horizontal>
          <div>0</div>
          <div>1</div>
          <div>2</div>
          <div>3</div>
          <div>4</div>
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render 100 children", async () => {
    const { asFragment } = await render(
      <div style={{ overflowX: "auto" }}>
        <Virtualizer horizontal>
          {range(100, (i) => (
            <div key={i}>{i}</div>
          ))}
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render non elements", async () => {
    const { asFragment } = await render(
      <div style={{ overflowX: "auto" }}>
        <Virtualizer horizontal>
          string
          {true}
          {false}
          {null}
          {undefined}
          {123}
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render fragments", async () => {
    const { asFragment } = await render(
      <div style={{ overflowX: "auto" }}>
        <Virtualizer horizontal>
          <>
            <div>fragment</div>
            <div>fragment</div>
            <div>fragment</div>
          </>
          <>
            <div>fragment</div>
          </>
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });

  it("should render component", async () => {
    const Comp = ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    );
    const { asFragment } = await render(
      <div style={{ overflowX: "auto" }}>
        <Virtualizer horizontal>
          <Comp>component</Comp>
          <Comp>component</Comp>
          <Comp>component</Comp>
        </Virtualizer>
      </div>,
    );
    expect(asFragment()).toMatchSnapshot();
  });
});

// Ported from Band's vendored react/Virtualizer.test.tsx (delta 4).
// jsdom's global ResizeObserver stub never fires without setupResizeJsDom, so the
// real viewport-measurement path never completes and $getRange would otherwise
// always return an empty range. Passing `ssrCount` gives the store a non-empty
// initial `_prevRange` that it never recomputes without a real measured viewport
// (see core/store.ts $getRange / _isViewportMeasured), which is exactly the
// stable, unmeasured-viewport condition this suite needs to observe repeated
// renders of the same mounted rows without a real browser layout engine.
describe("Virtualizer element cache (FORK-CHANGES.md delta 4)", () => {
  it("reuses a mounted row's element across a same-render-function re-render, and recomputes it when the render function identity changes", async () => {
    const data = ["a", "b", "c"];
    const rendererA = vi.fn((item: string, index: number) => (
      <div data-testid={`row-${index}`}>{item}</div>
    ));
    const rendererB = vi.fn((item: string, index: number) => (
      <div data-testid={`row-${index}`}>{item}</div>
    ));

    function Harness({ renderer }: { renderer: typeof rendererA }) {
      return (
        <Virtualizer data={data} ssrCount={data.length}>
          {renderer}
        </Virtualizer>
      );
    }

    const { rerender } = await render(<Harness renderer={rendererA} />);
    expect(rendererA).toHaveBeenCalledTimes(3);

    // A re-render with the identical render-function/data identity models the
    // "Virtualizer-only" case (a native scroll/resize re-render, or here a
    // forced parent re-render with stable props): nothing this row's rendered
    // output depends on changed, so a cache hit must skip invoking the render
    // function again for any mounted index.
    rendererA.mockClear();
    act(() => {
      rerender(<Harness renderer={rendererA} />);
    });
    expect(rendererA).toHaveBeenCalledTimes(0);

    // Swapping the render-function identity models any consumer input changing
    // (highlight, question, artifact, callback — an unmemoized row closure
    // produces a fresh function reference here). Every mounted row must be
    // recomputed fresh.
    act(() => {
      rerender(<Harness renderer={rendererB} />);
    });
    expect(rendererB).toHaveBeenCalledTimes(3);
  });
});
