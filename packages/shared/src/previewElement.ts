import type { PreviewAnnotationRect } from "@t3tools/contracts";

export function pickFromPoint<
  T extends {
    closest: (selector: string) => unknown;
    hasAttribute: (name: string) => boolean;
  },
>(
  clientX: number,
  clientY: number,
  document: {
    elementsFromPoint: (x: number, y: number) => T[];
    documentElement: unknown;
    body: unknown;
  },
): T | null {
  for (const candidate of document.elementsFromPoint(clientX, clientY)) {
    if (
      candidate.closest("[data-t3code-annotation-ui]") ||
      candidate.hasAttribute("data-t3code-annotation-input")
    )
      continue;
    if (candidate === document.documentElement || candidate === document.body) continue;
    return candidate;
  }
  return null;
}

interface ElementGeometry {
  getBoundingClientRect: () => { left: number; top: number; right: number; bottom: number };
  parentElement: ElementGeometry | null;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
}

export function visibleElementRect(
  element: ElementGeometry,
  document: {
    documentElement: { clientWidth: number; clientHeight: number };
    body: unknown;
  },
  getComputedStyle: (element: ElementGeometry) => {
    position: string;
    overflowX: string;
    overflowY: string;
  },
): PreviewAnnotationRect {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(document.documentElement.clientWidth, rect.right);
  let bottom = Math.min(document.documentElement.clientHeight, rect.bottom);
  if (getComputedStyle(element).position !== "fixed") {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === document.body || ancestor === document.documentElement) break;
      const style = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      const clipLeft = bounds.left + ancestor.clientLeft;
      const clipTop = bounds.top + ancestor.clientTop;
      if (style.overflowX !== "visible") {
        left = Math.max(left, clipLeft);
        right = Math.min(right, clipLeft + ancestor.clientWidth);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, clipTop);
        bottom = Math.min(bottom, clipTop + ancestor.clientHeight);
      }
    }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
