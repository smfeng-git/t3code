import { fitPreviewTransform, pinchPreviewTransform } from "./previewTransform";
import {
  type PreviewElementSelection,
  type PreviewViewportSetting,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MAX_AREA,
} from "@t3tools/contracts";
import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamModifiers,
  type PreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamInput,
  type PreviewStreamPointer,
  type PreviewStreamViewport,
} from "@t3tools/client-runtime/preview/server-browser-stream";

import type { PreviewStreamConfiguration, PreviewStreamMessage } from "./preview-stream-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

interface PresentationVideo extends HTMLVideoElement {
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture") => void;
  webkitPresentationMode?: string;
}

type WheelInput = Extract<PreviewStreamInput, { type: "wheel" }>;
type MouseInput = Extract<PreviewStreamInput, { type: "mouse" }>;
const mouseButton = (button: number): MouseInput["button"] =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";

const RESIZE_DEBOUNCE_MS = 150;
const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;
const WHEEL_LINE_PX = 16;
const MAX_PIXEL_RATIO = 2;
// Reuse nearby probe answers: slow replies arrive too late after touch-end to raise the iOS keyboard.
const PROBE_REUSE_PX = 24;
const PROBE_REUSE_MS = 10_000;
// A sentinel makes backspace fire input; Gboard keydown supplies only keyCode 229.
const SENTINEL = "\u200b";
const AGENT_CURSOR_ACTIVE_MS = 700;
const AGENT_CURSOR_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>';

interface Viewer {
  readonly fitToScreen: () => void;
  readonly resetZoom: () => void;
  readonly retryLayout: () => void;
  readonly highlightElement: (index: number, confirm: boolean) => void;
  readonly selectElement: (url: string | null) => void;
  readonly stop: () => void;
  readonly command: (input: PreviewStreamInput) => void;
  readonly togglePictureInPicture: () => void;
}

let activeViewer: Viewer | null = null;

export function stop() {
  activeViewer?.stop();
  activeViewer = null;
}

export function command(input: PreviewStreamInput) {
  activeViewer?.command(input);
}

export function resetZoom() {
  activeViewer?.resetZoom();
}
export function retryLayout() {
  activeViewer?.retryLayout();
}
export function fitToScreen() {
  activeViewer?.fitToScreen();
}
export function selectElement(url: string | null) {
  activeViewer?.selectElement(url);
}

export function highlightElement(index: number, confirm = false) {
  activeViewer?.highlightElement(index, confirm);
}

export function pictureInPicture() {
  activeViewer?.togglePictureInPicture();
}

export function start(configuration: PreviewStreamConfiguration) {
  stop();
  const post = (message: PreviewStreamMessage) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  const { interactive } = configuration;
  document.body.style.background = configuration.background;
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Browser page");
  const agentCursor = document.createElement("div");
  agentCursor.className = "agent-cursor";
  agentCursor.setAttribute("aria-hidden", "true");
  agentCursor.innerHTML = AGENT_CURSOR_SVG;
  const surface = document.createElement("div");
  surface.style.cssText = "position:absolute;inset:0;transform-origin:0 0";
  const selectionCanvas = document.createElement("canvas");
  selectionCanvas.style.pointerEvents = "none";
  selectionCanvas.style.display = "none";
  surface.append(canvas, selectionCanvas, agentCursor);
  container.append(surface);
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Browser page input");
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocorrect", "off");
  input.disabled = true;
  document.body.replaceChildren(container, ...(interactive ? [input] : []));

  let transform = fitPreviewTransform;
  let pendingSelection: PreviewElementSelection | null = null;
  let selectionImage: HTMLImageElement | null = null;
  let highlightedIndex = 0;
  let selectionSide: "top" | "bottom" | null = null;
  const reportSelectionPosition = () => {
    if (!pendingSelection || !size) return;
    const candidate =
      highlightedIndex === 0
        ? pendingSelection
        : pendingSelection.ancestors?.[highlightedIndex - 1];
    if (!candidate) return;
    const fit = Math.min(
      size.width / pendingSelection.viewport.width,
      size.height / pendingSelection.viewport.height,
    );
    const center =
      transform.y +
      transform.scale *
        ((size.height - pendingSelection.viewport.height * fit) / 2 +
          (candidate.rect.y + candidate.rect.height / 2) * fit);
    const side = center > size.height / 2 ? "top" : "bottom";
    if (side !== selectionSide) {
      selectionSide = side;
      post({ type: "selectionPosition", side });
    }
  };
  const clearSelection = () => {
    pendingSelection = null;
    selectionImage = null;
    selectionCanvas.style.display = "none";
    selectionSide = null;
  };
  const highlightElement = (index: number, confirm: boolean) => {
    if (!pendingSelection || !selectionImage || !Number.isInteger(index)) return;
    const candidate = index === 0 ? pendingSelection : pendingSelection.ancestors?.[index - 1];
    if (!candidate) return;
    highlightedIndex = index;
    reportSelectionPosition();
    const context = selectionCanvas.getContext("2d");
    if (!context) return;
    selectionCanvas.width = selectionImage.naturalWidth;
    selectionCanvas.height = selectionImage.naturalHeight;
    context.drawImage(selectionImage, 0, 0);
    context.scale(
      selectionCanvas.width / pendingSelection.viewport.width,
      selectionCanvas.height / pendingSelection.viewport.height,
    );
    context.strokeStyle = "#2563eb";
    context.lineWidth = 3;
    const { x, y, width, height } = candidate.rect;
    context.strokeRect(x, y, width, height);
    selectionCanvas.style.display = "block";
    if (confirm)
      post({
        type: "elementConfirmed",
        selection: {
          element: candidate.element,
          rect: candidate.rect,
          viewport: pendingSelection.viewport,
          screenshot: selectionCanvas.toDataURL("image/jpeg", 0.9),
        },
      });
  };
  let pickUrl: string | null = null;
  let pickRequest: string | null = null;
  let pickTimer: ReturnType<typeof setTimeout> | null = null;
  let requestSequence = 0;
  let pickGeneration = 0;
  const fingers = new Map<number, { x: number; y: number }>();
  let pinching = false;
  let lastPinch: { x: number; y: number; distance: number } | null = null;
  const applyTransform = () => {
    surface.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
    reportSelectionPosition();
  };
  const resetZoom = () => {
    transform = fitPreviewTransform;
    applyTransform();
  };
  const cancelPick = () => {
    pickGeneration++;
    pickRequest = null;
    if (pickTimer !== null) clearTimeout(pickTimer);
    pickTimer = null;
  };
  const pinchPoints = () => {
    const [a, b] = [...fingers.values()];
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(b.x - a.x, b.y - a.y) };
  };
  const fingerPosition = (event: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  let stopped = false;
  let streaming = false;
  let viewport: PreviewStreamViewport | null = null;
  let size: { width: number; height: number } | null = null;
  let cap: { width: number; height: number } | null = null;
  let client: PreviewStreamClient | null = null;
  let control: PreviewStreamControl | null = null;
  let layoutSetting: PreviewViewportSetting = configuration.viewport ?? { _tag: "fill" };
  let fittingViewport = layoutSetting._tag === "fill";
  let layoutRequest: string | null = null;
  let layoutTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let wheelFrame: number | null = null;
  let pendingWheel: WheelInput | null = null;
  let mouseFrame: number | null = null;
  let pendingMouse: MouseInput | null = null;
  let mouseButtons = 0;
  const mouseClicks = { left: 1, middle: 1, right: 1, none: 1 };
  let probe: {
    readonly x: number;
    readonly y: number;
    readonly clientX: number;
    readonly clientY: number;
    editable: boolean | null;
    end: "touching" | "acted" | "late" | "panned";
  } | null = null;
  let probeCache: {
    readonly clientX: number;
    readonly clientY: number;
    readonly editable: boolean;
    readonly time: number;
  } | null = null;
  let keySent = false;
  let touch: {
    start: PointerEvent;
    last: PointerEvent;
    panning: boolean;
  } | null = null;
  let lastTap: {
    time: number;
    x: number;
    y: number;
    count: number;
    button: MouseInput["button"];
  } | null = null;

  const reportStatus = (status: "connecting" | "streaming") => {
    streaming = status === "streaming";
    post({ type: "status", status });
  };
  const painted = () => {
    if (!streaming && !stopped) reportStatus("streaming");
    sendPictureInPictureFrame();
  };
  let painter = createPreviewFramePainter(canvas, painted);
  const send = (message: PreviewStreamInput) => {
    if (
      (layoutRequest !== null || pendingSelection !== null) &&
      ["mouse", "wheel", "key", "text", "probe", "pickElement"].includes(message.type)
    )
      return false;
    return client?.send(message) ?? false;
  };
  const applyViewport = (setting: Extract<PreviewStreamInput, { type: "viewport" }>["setting"]) => {
    if (control?.controller !== "you") return;
    if (!control.viewportSync) {
      post({
        type: "layout",
        state: "unsupported",
        setting: layoutSetting,
        detail:
          "This host supports viewing and local zoom. Update it to adapt the layout and select elements.",
      });
      return;
    }
    clearInput();
    clearSelection();
    pickUrl = null;
    post({ type: "selectionCleared", detail: "Layout changed. Select an element again." });
    input.disabled = !interactive;
    const requestId = `layout-${++requestSequence}`;
    layoutRequest = requestId;
    post({ type: "layout", state: "pending", setting: layoutSetting });
    painter.stop();
    if (layoutTimer !== null) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      if (layoutRequest !== requestId) return;
      painter.stop();
      painter = createPreviewFramePainter(canvas, painted);
      post({
        type: "layout",
        state: "error",
        setting: layoutSetting,
        detail: "The PC did not confirm the page size in time.",
      });
    }, 10_000);
    send({ type: "viewport", setting, requestId });
  };
  let autoLandscape: boolean | null = null;
  const resizeViewport = (force = false) => {
    if (
      fittingViewport &&
      (!pickUrl || force) &&
      control?.controller === "you" &&
      size &&
      document.activeElement !== input
    ) {
      const orientation = window.screen.orientation?.type;
      const landscape = orientation
        ? orientation.startsWith("landscape")
        : size.width > size.height;
      if (!force && autoLandscape === landscape) return;
      autoLandscape = landscape;
      const scale = Math.min(
        Math.max(1, PREVIEW_VIEWPORT_MIN_DIMENSION / Math.min(size.width, size.height)),
        PREVIEW_VIEWPORT_MAX_DIMENSION / Math.max(size.width, size.height),
        Math.sqrt(PREVIEW_VIEWPORT_MAX_AREA / (size.width * size.height)),
      );
      applyViewport({
        _tag: "freeform",
        width: Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, Math.floor(size.width * scale)),
        height: Math.max(PREVIEW_VIEWPORT_MIN_DIMENSION, Math.floor(size.height * scale)),
      });
    }
  };
  const clearInput = () => {
    if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
    if (mouseFrame !== null) cancelAnimationFrame(mouseFrame);
    wheelFrame = mouseFrame = null;
    pendingWheel = pendingMouse = null;
    mouseButtons = 0;
    Object.assign(mouseClicks, { left: 1, middle: 1, right: 1, none: 1 });
    cancelPick();
    probe = probeCache = touch = lastTap = null;
    keySent = false;
    input.value = SENTINEL;
    input.disabled = true;
    input.blur();
  };

  const connect = () => {
    if (client) reportStatus("connecting");
    client?.stop();
    control = null;
    clearInput();
    if (!cap || stopped) return;
    const next = createPreviewStreamClient(
      {
        access: configuration.access,
        threadId: configuration.threadId,
        tabId: configuration.tabId,
        maxWidth: cap.width,
        maxHeight: cap.height,
        interactive,
      },
      {
        onFrame: (jpeg) => {
          if (layoutRequest === null) painter.paint(jpeg);
        },
        onViewportApplied: (result) => {
          if (result.requestId !== layoutRequest || stopped || control?.controller !== "you")
            return;
          const image = result.image;
          if (!image) {
            painter.stop();
            painter = createPreviewFramePainter(canvas, painted);
            if (layoutTimer !== null) clearTimeout(layoutTimer);
            layoutTimer = null;
            post({
              type: "layout",
              state: "error",
              setting: layoutSetting,
              detail: result.error ?? "Could not apply browser layout.",
            });
            return;
          }
          painter.stop();
          painter = createPreviewFramePainter(canvas, () => {
            if (layoutRequest === result.requestId) {
              if (layoutTimer !== null) clearTimeout(layoutTimer);
              layoutTimer = null;
              viewport = { width: image.width, height: image.height };
              layoutRequest = null;
              post({ type: "viewport", ...viewport });
              post({
                type: "layout",
                state: result.error ? "recovered" : "ready",
                setting: layoutSetting,
                ...(result.error ? { detail: result.error } : {}),
              });
            }
            painted();
          });
          const bytes = Uint8Array.from(atob(image.screenshot.split(",")[1]!), (character) =>
            character.charCodeAt(0),
          );
          painter.paint(bytes.buffer);
        },
        onElementPicked: (result) => {
          if (result.requestId !== pickRequest) return;
          cancelPick();
          post({ type: "selecting", active: false });
          if (!result.selection) {
            post(result);
            return;
          }
          const selection = result.selection;
          const generation = pickGeneration;
          const image = new Image();
          image.onload = () => {
            if (stopped || !pickUrl || generation !== pickGeneration) return;
            pendingSelection = selection;
            selectionImage = image;
            highlightElement(0, false);
            post(result);
          };
          image.onerror = () => {
            if (!stopped && pickUrl && generation === pickGeneration)
              post({ ...result, selection: null, error: "Could not load selection screenshot." });
          };
          image.src = selection.screenshot;
        },
        onPointer: showAgentCursor,
        onClipboard: (text) => post({ type: "clipboard", text }),
        onDownload: (download) => post({ type: "download", ...download }),
        onFileChooser: (chooser) => post({ type: "fileChooser", chooser }),
        onViewport: (page) => {
          if (layoutRequest !== null) return;
          if (viewport?.width === page.width && viewport.height === page.height) return;
          viewport = page;
          cancelPick();
          clearSelection();
          pickUrl = null;
          post({
            type: "selectionCleared",
            detail: "Page dimensions changed. Select an element again.",
          });
          post({ type: "viewport", width: page.width, height: page.height });
        },
        onProbe: (result) => {
          if (control?.controller !== "you") return;
          const current = probe;
          if (!current || current.x !== result.x || current.y !== result.y) return;
          probeCache = {
            clientX: current.clientX,
            clientY: current.clientY,
            editable: result.editable,
            time: performance.now(),
          };
          if (current.end === "touching") {
            current.editable = result.editable;
            return;
          }
          probe = null;
          if (current.end === "panned") return;
          if (current.end === "acted" && current.editable === result.editable) return;
          // Late answers can raise Android's keyboard; iOS needs another tap.
          if (result.editable) input.focus({ preventScroll: true });
          else input.blur();
        },
        onControl: (nextControl) => {
          const previous = control;
          control = nextControl;
          post({ type: "control", ...nextControl });
          if (nextControl.controller === "you") agentCursor.style.opacity = "0";
          if (nextControl.controller !== "you") {
            clearInput();
            clearSelection();
            layoutRequest = null;
            if (layoutTimer !== null) clearTimeout(layoutTimer);
            painter.stop();
            painter = createPreviewFramePainter(canvas, painted);
          } else {
            input.disabled = !interactive;
            if (interactive && size && previous?.controller !== "you") {
              if (fittingViewport) resizeViewport(true);
              else applyViewport(layoutSetting);
            }
          }
        },
        onConnectedChange: (connected) => {
          if (!connected) {
            control = null;
            clearInput();
            clearSelection();
            layoutRequest = null;
            if (layoutTimer !== null) clearTimeout(layoutTimer);
            painter.stop();
            painter = createPreviewFramePainter(canvas, painted);
            if (streaming) reportStatus("connecting");
            return;
          }
        },
        onUnauthorized: () => post({ type: "unauthorized" }),
        onGone: () => post({ type: "gone" }),
        onHostSetup: (setup) => post({ type: "hostSetup", ...setup }),
      },
    );
    client = next;
  };

  const measure = () => {
    resizeTimer = null;
    const rect = container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
    if (size?.width === next.width && size.height === next.height) {
      resizeViewport();
      return;
    }
    if (size && size.width !== next.width && document.activeElement === input) input.blur();
    size = next;
    resetZoom();
    resizeViewport();
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const side = Math.max(next.width, next.height, window.screen.width, window.screen.height);
    // Reserve both orientations without disconnecting the viewer that owns control.
    const width = Math.round(side * ratio);
    const height = width;
    if (cap && cap.width >= width && cap.height >= height) return;
    cap = { width: Math.max(width, cap?.width ?? 0), height: Math.max(height, cap?.height ?? 0) };
    connect();
  };
  const scheduleMeasure = () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measure, size === null ? 0 : RESIZE_DEBOUNCE_MS);
  };
  const observer = new ResizeObserver(scheduleMeasure);
  const orientation = window.screen.orientation;
  orientation?.addEventListener?.("change", scheduleMeasure);
  observer.observe(container);

  // iOS keeps its layout viewport under the keyboard; resize to the visual viewport.
  const visualViewport = window.visualViewport;
  const followVisualViewport = () => {
    if (!visualViewport) return;
    container.style.top = `${visualViewport.offsetTop}px`;
    container.style.height = `${visualViewport.height}px`;
  };
  if (interactive) {
    visualViewport?.addEventListener("resize", followVisualViewport);
    visualViewport?.addEventListener("scroll", followVisualViewport);
  }

  let agentCursorTimer: ReturnType<typeof setTimeout> | null = null;
  const showAgentCursor = (pointer: PreviewStreamPointer) => {
    if (!viewport || canvas.width === 0 || canvas.height === 0 || control?.controller === "you")
      return;
    const box = { width: canvas.clientWidth, height: canvas.clientHeight };
    const fit = Math.min(box.width / canvas.width, box.height / canvas.height);
    const width = canvas.width * fit;
    const height = canvas.height * fit;
    const left = (box.width - width) / 2 + (pointer.x * width) / viewport.width;
    const top = (box.height - height) / 2 + (pointer.y * height) / viewport.height;
    agentCursor.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    agentCursor.style.opacity = "1";
    if (pointer.phase === "click") {
      agentCursor.querySelector(".ping")?.remove();
      const ping = document.createElement("span");
      ping.className = "ping";
      agentCursor.prepend(ping);
    }
    if (agentCursorTimer !== null) clearTimeout(agentCursorTimer);
    agentCursorTimer = setTimeout(() => {
      agentCursor.style.opacity = control?.controller === "agent" ? "0.35" : "0";
    }, AGENT_CURSOR_ACTIVE_MS);
  };

  const pagePoint = (clientX: number, clientY: number, clamp: boolean) => {
    if (
      layoutRequest !== null ||
      !viewport ||
      canvas.width === 0 ||
      canvas.height === 0 ||
      control?.controller !== "you"
    )
      return null;
    const rect = canvas.getBoundingClientRect();
    const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const width = canvas.width * fit;
    const height = canvas.height * fit;
    if (!(width > 0 && height > 0)) return null;
    const scale = viewport.width / width;
    const x = (clientX - rect.left - (rect.width - width) / 2) * scale;
    const y = (clientY - rect.top - (rect.height - height) / 2) * (viewport.height / height);
    const inside = x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
    if (!inside && !clamp) return null;
    return {
      x: Math.min(Math.max(x, 0), viewport.width),
      y: Math.min(Math.max(y, 0), viewport.height),
      scale,
    };
  };

  const flushWheel = () => {
    if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
    wheelFrame = null;
    const wheel = pendingWheel;
    pendingWheel = null;
    if (wheel) send(wheel);
  };
  const queueWheel = (point: { x: number; y: number }, deltaX: number, deltaY: number) => {
    pendingWheel = {
      type: "wheel",
      x: point.x,
      y: point.y,
      deltaX: (pendingWheel?.deltaX ?? 0) + deltaX,
      deltaY: (pendingWheel?.deltaY ?? 0) + deltaY,
      modifiers: 0,
    };
    wheelFrame ??= requestAnimationFrame(flushWheel);
  };

  const flushMouse = () => {
    if (mouseFrame !== null) cancelAnimationFrame(mouseFrame);
    mouseFrame = null;
    if (pendingMouse) send(pendingMouse);
    pendingMouse = null;
  };
  const countClick = (event: PointerEvent, button: MouseInput["button"]) => {
    const last = lastTap;
    const count =
      last &&
      last.button === button &&
      event.timeStamp - last.time < MULTI_CLICK_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < MULTI_CLICK_SLOP_PX
        ? last.count + 1
        : 1;
    lastTap = { time: event.timeStamp, x: event.clientX, y: event.clientY, count, button };
    return count;
  };
  const mouseInput = (
    event: PointerEvent,
    point: { x: number; y: number },
    action: MouseInput["action"],
    button: MouseInput["button"],
    buttons = event.buttons,
    clickCount = mouseClicks[button],
  ): MouseInput => ({
    type: "mouse",
    action,
    x: point.x,
    y: point.y,
    button,
    buttons,
    clickCount,
    modifiers: previewStreamModifiers(event),
  });
  const requestElement = (point: { x: number; y: number }) => {
    if (pickUrl && !pendingSelection && control?.controller === "you" && control.viewportSync) {
      clearSelection();
      cancelPick();
      const requestId = String(++requestSequence);
      pickRequest = requestId;
      if (!send({ type: "pickElement", requestId, x: point.x, y: point.y, pageUrl: pickUrl })) {
        cancelPick();
        return;
      }
      pickTimer = setTimeout(() => {
        cancelPick();
        post({ type: "selecting", active: false });
        post({
          type: "elementPicked",
          requestId,
          selection: null,
          error: "Selection timed out. Tap to try again.",
        });
      }, 10_000);
      post({ type: "selecting", active: true });
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      if (event.isPrimary) {
        // A new primary touch starts a sequence even if the previous WebView gesture lost its end.
        fingers.clear();
        pinching = false;
        lastPinch = null;
      }
      fingers.set(event.pointerId, fingerPosition(event));
      canvas.setPointerCapture(event.pointerId);
      if (fingers.size >= 2) {
        event.preventDefault();
        pinching = true;
        lastPinch = pinchPoints();
        touch = null;
        probe = null;
        if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
        wheelFrame = null;
        pendingWheel = null;
        input.blur();
        return;
      }
    }
    if (control?.controller !== "you") return;
    if (!event.isPrimary) return;
    event.preventDefault();
    if (event.pointerType !== "touch") {
      if (pickUrl) {
        event.preventDefault();
        return;
      }
      const point = pagePoint(event.clientX, event.clientY, false);
      if (!point) return;
      canvas.setPointerCapture(event.pointerId);
      input.focus({ preventScroll: true });
      flushMouse();
      flushWheel();
      mouseButtons = event.buttons & 7;
      const button = mouseButton(event.button);
      mouseClicks[button] = countClick(event, button);
      send(mouseInput(event, point, "down", button));
      return;
    }
    touch = { start: event, last: event, panning: false };
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) {
      probe = null;
      return;
    }
    if (pickUrl) return;
    const cached = probeCache;
    const reuse =
      cached !== null &&
      performance.now() - cached.time < PROBE_REUSE_MS &&
      Math.hypot(event.clientX - cached.clientX, event.clientY - cached.clientY) <= PROBE_REUSE_PX;
    probe = {
      x: point.x,
      y: point.y,
      clientX: event.clientX,
      clientY: event.clientY,
      editable: reuse ? cached.editable : null,
      end: "touching",
    };
    send({ type: "probe", x: point.x, y: point.y });
  };
  const onPointerMove = (event: PointerEvent) => {
    if (fingers.has(event.pointerId)) fingers.set(event.pointerId, fingerPosition(event));
    if (pinching) {
      event.preventDefault();
      const next = pinchPoints();
      if (next && lastPinch && size) {
        transform = pinchPreviewTransform(transform, lastPinch, next, size);
        applyTransform();
      }
      lastPinch = next;
      return;
    }
    if (control?.controller !== "you") return;
    if (event.pointerType !== "touch") {
      if (pickUrl) return;
      const point = pagePoint(event.clientX, event.clientY, mouseButtons !== 0);
      if (!point) return;
      // Chorded presses and releases arrive as pointermove while another button is held.
      const changed = mouseButtons ^ (event.buttons & 7);
      if (mouseButtons !== 0 && changed !== 0) {
        flushMouse();
        flushWheel();
        for (const bit of [1, 2, 4]) {
          if (!(changed & bit)) continue;
          const button = bit === 1 ? "left" : bit === 2 ? "right" : "middle";
          const down = (event.buttons & bit) !== 0;
          mouseButtons ^= bit;
          if (down) mouseClicks[button] = countClick(event, button);
          send(mouseInput(event, point, down ? "down" : "up", button, mouseButtons));
        }
      }
      const button =
        mouseButtons & 1
          ? "left"
          : mouseButtons & 2
            ? "right"
            : mouseButtons & 4
              ? "middle"
              : "none";
      pendingMouse = mouseInput(event, point, "move", button, event.buttons, 0);
      mouseFrame ??= requestAnimationFrame(flushMouse);
      return;
    }
    if (!touch || touch.start.pointerId !== event.pointerId) return;
    if (
      !touch.panning &&
      Math.hypot(event.clientX - touch.start.clientX, event.clientY - touch.start.clientY) <
        TAP_SLOP_PX
    ) {
      return;
    }
    touch.panning = true;
    const point = pagePoint(event.clientX, event.clientY, true);
    if (point && !pickUrl) {
      queueWheel(
        point,
        (touch.last.clientX - event.clientX) * point.scale,
        (touch.last.clientY - event.clientY) * point.scale,
      );
    }
    touch.last = event;
  };
  const releaseMouse = (event: PointerEvent, cancelled: boolean) => {
    let buttons = mouseButtons;
    if (buttons === 0) return;
    mouseButtons = cancelled ? 0 : event.buttons & 7;
    flushMouse();
    flushWheel();
    const point = pagePoint(event.clientX, event.clientY, true);
    if (!point) return;
    for (const bit of [1, 2, 4]) {
      if (!(buttons & bit) || (mouseButtons & bit) !== 0) continue;
      buttons &= ~bit;
      const button = bit === 1 ? "left" : bit === 2 ? "right" : "middle";
      send(mouseInput(event, point, "up", button, buttons));
    }
  };
  const onPointerEnd = (event: PointerEvent) => {
    fingers.delete(event.pointerId);
    if (pinching) {
      if (fingers.size === 0) {
        pinching = false;
        lastPinch = null;
      }
      touch = null;
      probe = null;
      return;
    }
    const cancelled = event.type === "pointercancel";
    if (event.pointerType !== "touch") {
      if (pickUrl) {
        const point = pagePoint(event.clientX, event.clientY, false);
        if (!cancelled && event.button === 0 && point) requestElement(point);
        return;
      }
      releaseMouse(event, cancelled);
      return;
    }
    const ended = touch;
    if (!ended || ended.start.pointerId !== event.pointerId) return;
    touch = null;
    const answered = probe;
    if (cancelled || ended.panning) {
      if (answered) answered.end = "panned";
      return;
    }
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    if (pickUrl) {
      requestElement(point);
      return;
    }
    // Focusing inside the tap's user activation is what lets iOS raise the keyboard.
    if (answered?.editable === true) input.focus({ preventScroll: true });
    else if (answered?.editable === false) input.blur();
    if (answered) answered.end = answered.editable === null ? "late" : "acted";
    flushWheel();
    const clickCount = countClick(event, "left");
    const at = { x: point.x, y: point.y, modifiers: 0 };
    send({ type: "mouse", action: "move", ...at, button: "none", buttons: 0, clickCount: 0 });
    send({ type: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount });
    send({ type: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount });
  };
  const onWheel = (event: WheelEvent) => {
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? (viewport?.height ?? 0)
          : 1;
    queueWheel(point, event.deltaX * unit, event.deltaY * unit);
  };
  const preventDefault = (event: Event) => event.preventDefault();

  const onKey = (action: "down" | "up", event: KeyboardEvent) => {
    if (control?.controller !== "you") return;
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Unidentified"
    ) {
      return;
    }
    const shortcut = event.ctrlKey || event.metaKey;
    if (shortcut && event.key.toLowerCase() === "v") return;
    if (event.shiftKey && event.key === "Insert") return;
    // Enter carries "\r" like Puppeteer's key table, so forms submit and textareas break lines.
    const text = shortcut
      ? undefined
      : [...event.key].length === 1
        ? event.key
        : event.key === "Enter"
          ? "\r"
          : undefined;
    send({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ...(action === "down" && text !== undefined ? { text } : {}),
      modifiers: previewStreamModifiers(event),
    });
    // Some Android keyboards edit the textarea even when keydown is prevented.
    keySent =
      action === "down" &&
      !shortcut &&
      (text !== undefined || event.key === "Backspace" || event.key === "Delete");
    if (!shortcut) event.preventDefault();
  };
  const resetInput = () => {
    input.value = SENTINEL;
    input.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  const pressKey = (key: "Backspace" | "Delete", keyCode: number) => {
    for (const action of ["down", "up"] as const) {
      send({ type: "key", action, key, code: key, keyCode, modifiers: 0 });
    }
  };
  const onInput = (event: Event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    const inputType = event instanceof InputEvent ? event.inputType : "";
    if (keySent) keySent = false;
    else if (inputType === "deleteContentBackward") pressKey("Backspace", 8);
    else if (inputType === "deleteContentForward") pressKey("Delete", 46);
    else {
      const value = input.value;
      const text = value.startsWith(SENTINEL) ? value.slice(SENTINEL.length) : value;
      if (text) send({ type: "text", text });
    }
    resetInput();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    const text = event.data.startsWith(SENTINEL) ? event.data.slice(SENTINEL.length) : event.data;
    if (text) send({ type: "text", text });
    resetInput();
  };

  if (interactive) {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerEnd);
    canvas.addEventListener("pointercancel", onPointerEnd);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", preventDefault);
    canvas.addEventListener("contextmenu", preventDefault);
    input.addEventListener("keydown", (event) => onKey("down", event));
    input.addEventListener("keyup", (event) => onKey("up", event));
    input.addEventListener("input", onInput);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("focus", resetInput);
    // Copying the input would put its sentinel on this device's clipboard.
    input.addEventListener("copy", preventDefault);
    input.addEventListener("cut", preventDefault);
    resetInput();
  }

  // WebKit reports no support on a video that has not loaded yet; check the prototype.
  const videoPrototype: PresentationVideo = HTMLVideoElement.prototype;
  const pictureInPictureSupported =
    interactive &&
    typeof canvas.captureStream === "function" &&
    typeof CanvasCaptureMediaStreamTrack === "function" &&
    ((document.pictureInPictureEnabled === true &&
      typeof videoPrototype.requestPictureInPicture === "function") ||
      typeof videoPrototype.webkitSetPresentationMode === "function");
  // WebKit revokes activation after return; start picture in picture before awaiting. Prepare paused video before the tap.
  let video: PresentationVideo | null = null;
  let track: CanvasCaptureMediaStreamTrack | null = null;
  const pictureInPictureActive = () =>
    video !== null &&
    (document.pictureInPictureElement === video ||
      video.webkitPresentationMode === "picture-in-picture");
  const reportPictureInPicture = (detail?: string) =>
    post({
      type: "pictureInPicture",
      supported: pictureInPictureSupported,
      active: pictureInPictureActive(),
      ...(detail ? { detail } : {}),
    });
  // Called after each paint. A frame drawn before the player attached is lost, so retry.
  const sendPictureInPictureFrame = () => {
    if (video && (video.readyState === HTMLMediaElement.HAVE_NOTHING || pictureInPictureActive())) {
      track?.requestFrame();
    }
  };
  if (pictureInPictureSupported) {
    const stream = canvas.captureStream(0);
    const [captured] = stream.getVideoTracks();
    const element: PresentationVideo = document.createElement("video");
    element.muted = true;
    element.playsInline = true;
    // Under the canvas at full size: WebKit pauses muted video it considers off screen.
    element.srcObject = stream;
    for (const name of [
      "enterpictureinpicture",
      "leavepictureinpicture",
      "webkitpresentationmodechanged",
    ]) {
      element.addEventListener(name, () => {
        if (!pictureInPictureActive()) element.pause();
        reportPictureInPicture();
      });
    }
    surface.prepend(element);
    canvas.style.background = configuration.background;
    video = element;
    track = captured instanceof CanvasCaptureMediaStreamTrack ? captured : null;
  }
  const togglePictureInPicture = () => {
    const element = video;
    if (!element) return;
    if (pictureInPictureActive()) {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
      else element.webkitSetPresentationMode?.("inline");
      return;
    }
    if (element.readyState === HTMLMediaElement.HAVE_NOTHING) {
      reportPictureInPicture("The page has not shown yet. Try again in a moment.");
      return;
    }
    // The page may have changed since the video's last frame. WebKit captures only on a draw.
    track?.requestFrame();
    canvas.getContext("2d")?.drawImage(canvas, 0, 0);
    const fail = (error: unknown) => {
      element.pause();
      reportPictureInPicture(
        error instanceof Error ? error.message : "Picture in picture is unavailable.",
      );
    };
    if (document.pictureInPictureEnabled) {
      const entering = element.requestPictureInPicture();
      void Promise.all([entering, element.play()]).catch(fail);
    } else {
      element.webkitSetPresentationMode?.("picture-in-picture");
      void element.play().catch(fail);
    }
  };

  activeViewer = {
    fitToScreen: () => {
      resetZoom();
      if (control?.controller !== "you") return;
      fittingViewport = true;
      layoutSetting = { _tag: "fill" };
      resizeViewport(true);
    },
    resetZoom,
    retryLayout: () => (fittingViewport ? resizeViewport(true) : applyViewport(layoutSetting)),
    highlightElement,
    selectElement: (url) => {
      clearSelection();
      cancelPick();
      post({ type: "selecting", active: false });
      pickUrl = url;
      probe = null;
      touch = null;
      input.blur();
      if (url === null) resizeViewport();
    },
    stop: () => {
      stopped = true;
      cancelPick();
      fingers.clear();
      observer.disconnect();
      orientation?.removeEventListener?.("change", scheduleMeasure);
      visualViewport?.removeEventListener("resize", followVisualViewport);
      visualViewport?.removeEventListener("scroll", followVisualViewport);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (layoutTimer !== null) clearTimeout(layoutTimer);
      if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
      if (mouseFrame !== null) cancelAnimationFrame(mouseFrame);
      if (agentCursorTimer !== null) clearTimeout(agentCursorTimer);
      painter.stop();
      client?.stop();
      client = null;
      track?.stop();
      if (video) video.srcObject = null;
    },
    command: (message) => {
      if (message.type === "viewport") {
        fittingViewport = false;
        layoutSetting = message.setting;
        applyViewport(message.setting);
        return;
      }
      if (["navigate", "history", "reload"].includes(message.type)) {
        cancelPick();
        clearSelection();
        pickUrl = null;
        post({ type: "selectionCleared", detail: "Page navigation cancelled the selection." });
      }
      send(message);
    },
    togglePictureInPicture,
  };
  window.addEventListener("pagehide", stop, { once: true });
  reportStatus("connecting");
  if (interactive) reportPictureInPicture();
}
