import type { PreviewElementSelection } from "@t3tools/contracts";
import { pickFromPoint, visibleElementRect } from "@t3tools/shared/previewElement";
import type { CDPSession, Page } from "playwright-core";
import { captureViewport } from "./ServerBrowserPage.ts";

export async function captureElementSelection(
  page: Page,
  session: CDPSession,
  input: { x: number; y: number; pageUrl: string },
): Promise<PreviewElementSelection> {
  if (input.pageUrl.length > 2048)
    throw new Error("This page address is too long to attach as context.");
  const expression = `(() => {
    const element = (${pickFromPoint.toString()})(${input.x}, ${input.y}, document);
    if (!element) return null;
    return {
      element: {
        pageUrl: location.href, pageTitle: document.title.slice(0, 2048) || null,
        tagName: element.tagName.toLowerCase(),
        selector: element.id && element.id.length < 250 ? '#' + CSS.escape(element.id) : null,
        htmlPreview: element.outerHTML.slice(0, 500), componentName: null, source: null, styles: ''
      },
      rect: (${visibleElementRect.toString()})(element, document, getComputedStyle),
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: scrollX, y: scrollY }
    };
  })()`;
  const read = () =>
    page.evaluate<
      | (Omit<PreviewElementSelection, "screenshot"> & {
          scroll: { x: number; y: number };
        })
      | null
    >(expression);
  if (page.url() !== input.pageUrl) throw new Error("The page changed. Select the element again.");
  const before = await read();
  if (!before || before.rect.width <= 0 || before.rect.height <= 0)
    throw new Error("No selectable element at this position.");
  const screenshot = await captureViewport(session, { format: "jpeg", quality: 85 });
  const after = await read();
  if (page.url() !== input.pageUrl || JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("The page changed. Select the element again.");
  return {
    element: before.element,
    rect: before.rect,
    viewport: before.viewport,
    screenshot: `data:image/jpeg;base64,${screenshot}`,
  };
}
