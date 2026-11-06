import { expect, it, vi } from "vite-plus/test";
import type { PreviewStreamEvents } from "@t3tools/client-runtime/preview/server-browser-stream";
import { start, stop, selectElement } from "./preview-stream.browser";

const mocks = vi.hoisted(() => ({
  events: null as PreviewStreamEvents | null,
  send: vi.fn(() => true),
}));
vi.mock("@t3tools/client-runtime/preview/server-browser-stream", () => ({
  createPreviewFramePainter: () => ({ paint: vi.fn(), stop: vi.fn() }),
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        this.callback();
      }
      disconnect() {}
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
    events.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null });
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
    touch("pointerdown", 1, 300, 400);
    touch("pointerup", 1, 300, 400);
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "pickElement", x: 400, y: 600 }),
    );
    selectElement(null);
    const posted = vi.mocked(window.ReactNativeWebView.postMessage);
    posted.mockClear();
    events.onElementPicked?.({
      type: "elementPicked",
      requestId: "1",
      selection: null,
      error: "Late result",
    });
    expect(posted).not.toHaveBeenCalled();
    events.onControl?.({ canOperate: true, controller: "agent", generation: 2, dialog: null });
    mocks.send.mockClear();
    touch("pointerdown", 1, 100, 200);
    touch("pointerdown", 2, 200, 200);
    touch("pointermove", 2, 300, 200);
    touch("pointerup", 2, 300, 200);
    touch("pointerup", 1, 100, 200);
    expect(canvas.parentElement?.style.transform).toContain("scale(4)");
    expect(mocks.send).not.toHaveBeenCalled();
  } finally {
    stop();
    document.body.replaceChildren();
    HTMLCanvasElement.prototype.setPointerCapture = originalCapture;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
