import { expect, it, vi } from "vite-plus/test";
import type {
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  start,
  stop,
  selectElement,
  fitToScreen,
  command,
  highlightElement,
  resetZoom,
  retryLayout,
} from "./preview-stream.browser";

const mocks = vi.hoisted(() => ({
  events: null as PreviewStreamEvents | null,
  send: vi.fn((_input: PreviewStreamInput) => true),
}));
vi.mock("@t3tools/client-runtime/preview/server-browser-stream", () => ({
  createPreviewFramePainter: (_canvas: unknown, painted: () => void) => ({
    paint: vi.fn(painted),
    stop: vi.fn(),
  }),
  createPreviewStreamClient: (_target: unknown, events: PreviewStreamEvents) => {
    mocks.events = events;
    return { send: mocks.send, stop: vi.fn() };
  },
  previewStreamModifiers: () => 0,
}));

it("pinches locally, maps subsequent taps, and selects without activating the page", () => {
  mocks.events = null;
  mocks.send.mockClear();
  vi.useFakeTimers();
  let resized = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
        resized = callback;
      }
      observe() {
        this.callback();
      }
      disconnect() {}
    },
  );
  const strokeRect = vi.fn();
  let loadImage: (() => void) | null = null;
  let deferImage = false;
  using _context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    scale: vi.fn(),
    strokeRect,
  } as unknown as CanvasRenderingContext2D);
  using _dataUrl = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue("data:image/jpeg;base64,marked");
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 800;
      naturalHeight = 1600;
      onload: (() => void) | null = null;
      set src(_value: string) {
        if (deferImage) loadImage = () => this.onload?.();
        else this.onload?.();
      }
    },
  );
  const originalCapture = HTMLCanvasElement.prototype.setPointerCapture;
  HTMLCanvasElement.prototype.setPointerCapture = () => {};
  window.ReactNativeWebView = { postMessage: vi.fn() };
  using _container = vi
    .spyOn(HTMLDivElement.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 400, 800));
  using _canvas = vi
    .spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLCanvasElement) {
      const values = this.parentElement?.style.transform.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
      const [x = 0, y = 0, scale = 1] = values ?? [];
      return new DOMRect(x, y, 400 * scale, 800 * scale);
    });
  try {
    start({
      access: {
        httpBase: "https://example.com/api/preview-stream",
        wsBase: "wss://example.com/api/preview-stream",
        query: {},
        credentials: true,
      },
      threadId: "thread",
      tabId: "tab",
      interactive: true,
      background: "#fff",
    });
    vi.runOnlyPendingTimers();
    const events = mocks.events as PreviewStreamEvents | null;
    if (!events) throw new Error("Viewer did not connect");
    events.onViewport({ width: 800, height: 1600 });
    events.onControl?.({
      viewportSync: true,
      canOperate: true,
      controller: "you",
      generation: 1,
      dialog: null,
    });
    expect(mocks.send).toHaveBeenCalledWith({
      type: "viewport",
      requestId: expect.any(String),
      setting: { _tag: "freeform", width: 400, height: 800 },
    });
    mocks.send.mockClear();
    fitToScreen();
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith({
      type: "viewport",
      requestId: expect.any(String),
      setting: { _tag: "freeform", width: 400, height: 800 },
    });
    const canvas = document.querySelector("canvas")!;
    canvas.width = 400;
    canvas.height = 800;
    const touch = (type: string, id: number, x: number, y: number) => {
      const event = new MouseEvent(type, {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperties(event, {
        pointerId: { value: id },
        pointerType: { value: "touch" },
        isPrimary: { value: id === 1 },
      });
      canvas.dispatchEvent(event);
    };
    mocks.send.mockClear();
    events.onViewportApplied?.({
      type: "viewportApplied",
      requestId: "layout-1",
      image: { width: 400, height: 800, screenshot: "data:image/jpeg;base64,YWI=" },
      error: null,
    });
    touch("pointerdown", 1, 300, 400);
    touch("pointerup", 1, 300, 400);
    expect(mocks.send).not.toHaveBeenCalled();
    events.onViewportApplied?.({
      type: "viewportApplied",
      requestId: "layout-2",
      image: { width: 800, height: 1600, screenshot: "data:image/jpeg;base64,YWI=" },
      error: null,
    });
    touch("pointerdown", 1, 100, 200);
    touch("pointerdown", 2, 200, 200);
    touch("pointermove", 2, 300, 200);
    touch("pointerup", 2, 300, 200);
    touch("pointerup", 1, 100, 200);
    expect(canvas.parentElement?.style.transform).toBe("translate(-100px, -200px) scale(2)");
    expect(mocks.send.mock.calls.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "mouse" })]),
    );
    expect(mocks.send.mock.calls.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "wheel" })]),
    );
    touch("pointerdown", 1, 300, 400);
    touch("pointerup", 1, 300, 400);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mouse", action: "down", x: 400, y: 600 }),
    );
    mocks.send.mockClear();
    selectElement("https://example.com/");
    touch("pointerdown", 2, 200, 200);
    touch("pointerdown", 1, 300, 400);
    touch("pointerup", 1, 300, 400);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "pickElement", x: 400, y: 600 }),
    );
    const posted = vi.mocked(window.ReactNativeWebView.postMessage);
    const element = {
      pageUrl: "https://example.com/",
      pageTitle: null,
      tagName: "span",
      selector: "#label",
      htmlPreview: "<span>Save</span>",
      componentName: null,
      source: null,
      styles: "",
    };
    const parent = { ...element, tagName: "button", selector: "#save" };
    const request = mocks.send.mock.calls[0]?.[0];
    if (!request || request.type !== "pickElement") throw new Error("Expected element pick");
    events.onElementPicked?.({
      type: "elementPicked",
      requestId: request.requestId,
      error: null,
      selection: {
        element,
        rect: { x: 10, y: 20, width: 30, height: 40 },
        viewport: { width: 800, height: 1600 },
        screenshot: canvas.toDataURL("image/jpeg"),
        ancestors: [
          { element: parent, rect: { x: 5, y: 10, width: 80, height: 90 } },
          { element: parent, rect: { x: 5, y: 600, width: 80, height: 80 } },
        ],
      },
    });
    expect(posted.mock.calls.some(([value]) => JSON.parse(value).type === "elementPicked")).toBe(
      true,
    );
    expect(posted.mock.calls.some(([value]) => JSON.parse(value).type === "elementConfirmed")).toBe(
      false,
    );
    mocks.send.mockClear();
    highlightElement(1);
    expect(strokeRect).toHaveBeenLastCalledWith(5, 10, 80, 90);
    expect(mocks.send).not.toHaveBeenCalled();
    touch("pointerdown", 1, 300, 400);
    touch("pointerup", 1, 300, 400);
    expect(mocks.send).not.toHaveBeenCalled();
    highlightElement(2);
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual({
      type: "selectionPosition",
      side: "top",
    });
    posted.mockClear();
    touch("pointerdown", 1, 100, 400);
    touch("pointerdown", 2, 200, 400);
    touch("pointermove", 1, 100, 200);
    touch("pointermove", 2, 200, 200);
    touch("pointerup", 2, 200, 200);
    touch("pointerup", 1, 100, 200);
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual({
      type: "selectionPosition",
      side: "bottom",
    });
    highlightElement(1, true);
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(
      expect.objectContaining({
        type: "elementConfirmed",
        selection: expect.objectContaining({
          element: parent,
          rect: { x: 5, y: 10, width: 80, height: 90 },
        }),
      }),
    );
    selectElement(null);
    posted.mockClear();
    highlightElement(1, true);
    expect(posted).not.toHaveBeenCalled();
    posted.mockClear();
    events.onElementPicked?.({
      type: "elementPicked",
      requestId: "1",
      selection: null,
      error: "Late result",
    });
    expect(posted).not.toHaveBeenCalled();
    events.onControl?.({
      viewportSync: true,
      canOperate: true,
      controller: "agent",
      generation: 2,
      dialog: null,
    });
    mocks.send.mockClear();
    touch("pointerdown", 1, 100, 200);
    touch("pointerdown", 2, 200, 200);
    touch("pointermove", 2, 300, 200);
    touch("pointerup", 2, 300, 200);
    touch("pointerup", 1, 100, 200);
    expect(canvas.parentElement?.style.transform).toContain("scale(4)");
    expect(mocks.send).not.toHaveBeenCalled();
    fitToScreen();
    expect(mocks.send).not.toHaveBeenCalled();
    events.onControl?.({
      viewportSync: true,
      canOperate: true,
      controller: "you",
      generation: 3,
      dialog: null,
    });
    mocks.send.mockClear();
    _container.mockReturnValue(new DOMRect(0, 0, 800, 400));
    resized();
    vi.runOnlyPendingTimers();
    expect(mocks.events).toBe(events);
    expect(mocks.send).toHaveBeenCalledWith({
      type: "viewport",
      requestId: expect.any(String),
      setting: { _tag: "freeform", width: 800, height: 400 },
    });
    mocks.send.mockClear();
    _container.mockReturnValue(new DOMRect(0, 0, 800, 200));
    resized();
    vi.runOnlyPendingTimers();
    expect(mocks.send).toHaveBeenCalledWith({
      type: "viewport",
      requestId: expect.any(String),
      setting: { _tag: "freeform", width: 960, height: 240 },
    });
    command({ type: "viewport", setting: { _tag: "freeform", width: 1280, height: 800 } });
    const fixed = mocks.send.mock.calls.at(-1)?.[0];
    if (!fixed || fixed.type !== "viewport" || !fixed.requestId)
      throw new Error("Expected fixed viewport");
    posted.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(
      expect.objectContaining({ type: "layout", state: "error" }),
    );
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).not.toContainEqual(
      expect.objectContaining({ type: "status", status: "error" }),
    );
    events.onViewportApplied?.({
      type: "viewportApplied",
      requestId: fixed.requestId,
      image: null,
      error: "Layout failed",
    });
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(
      expect.objectContaining({ type: "layout", state: "error" }),
    );
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).not.toContainEqual(
      expect.objectContaining({ type: "status", status: "error" }),
    );
    mocks.send.mockClear();
    resetZoom();
    touch("pointerdown", 1, 100, 100);
    touch("pointerup", 1, 100, 100);
    expect(mocks.send).not.toHaveBeenCalled();
    retryLayout();
    const retried = mocks.send.mock.calls.at(-1)?.[0];
    if (!retried || retried.type !== "viewport" || !retried.requestId)
      throw new Error("Expected retry");
    expect(retried.setting).toEqual({ _tag: "freeform", width: 1280, height: 800 });
    mocks.send.mockClear();
    events.onViewportApplied?.({
      type: "viewportApplied",
      requestId: fixed.requestId,
      image: { width: 1280, height: 800, screenshot: "data:image/jpeg;base64,YWI=" },
      error: null,
    });
    touch("pointerdown", 1, 100, 100);
    touch("pointerup", 1, 100, 100);
    expect(mocks.send).not.toHaveBeenCalled();
    events.onViewportApplied?.({
      type: "viewportApplied",
      requestId: retried.requestId,
      image: { width: 1280, height: 800, screenshot: "data:image/jpeg;base64,YWI=" },
      error: null,
    });
    touch("pointerdown", 1, 100, 100);
    touch("pointerup", 1, 100, 100);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mouse", action: "down" }),
    );
    mocks.send.mockClear();
    _container.mockReturnValue(new DOMRect(0, 0, 400, 800));
    resized();
    vi.runOnlyPendingTimers();
    expect(mocks.send.mock.calls.flat()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "viewport" })]),
    );
    mocks.send.mockClear();
    resetZoom();
    expect(mocks.send).not.toHaveBeenCalled();
    deferImage = true;
    selectElement("https://example.com/");
    touch("pointerdown", 1, 200, 400);
    touch("pointerup", 1, 200, 400);
    const delayedPick = mocks.send.mock.calls.at(-1)?.[0];
    if (!delayedPick || delayedPick.type !== "pickElement")
      throw new Error("Expected delayed pick");
    events.onElementPicked?.({
      type: "elementPicked",
      requestId: delayedPick.requestId,
      error: null,
      selection: {
        element,
        rect: { x: 1, y: 1, width: 10, height: 10 },
        viewport: { width: 1280, height: 800 },
        screenshot: canvas.toDataURL("image/jpeg"),
      },
    });
    selectElement(null);
    posted.mockClear();
    if (loadImage) (loadImage as () => void)();
    highlightElement(0, true);
    expect(posted).not.toHaveBeenCalled();
    events.onConnectedChange?.(false);
    mocks.send.mockClear();
    events.onControl?.({
      canOperate: true,
      viewportSync: true,
      controller: "you",
      generation: 4,
      dialog: null,
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "viewport",
        setting: { _tag: "freeform", width: 1280, height: 800 },
      }),
    );
    posted.mockClear();
    events.onControl?.({ canOperate: true, controller: "agent", generation: 4, dialog: null });
    mocks.send.mockClear();
    events.onControl?.({ canOperate: true, controller: "you", generation: 5, dialog: null });
    fitToScreen();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).not.toContainEqual(
      expect.objectContaining({ type: "status", status: "error" }),
    );
    expect(posted.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(
      expect.objectContaining({ type: "layout", state: "unsupported" }),
    );
  } finally {
    stop();
    document.body.replaceChildren();
    HTMLCanvasElement.prototype.setPointerCapture = originalCapture;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
