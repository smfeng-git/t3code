import type { ElementContextDetails, PreviewElementSelection } from "@t3tools/contracts";
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
    if (element.tagName === 'IFRAME' || element.tagName === 'FRAME')
      throw new Error('This element is inside an embedded frame. Select it from the PC browser.');
    const candidate = (element) => ({
      element: {
        pageUrl: location.href, pageTitle: document.title.slice(0, 2048) || null,
        tagName: element.tagName.toLowerCase(),
        selector: element.id && element.id.length < 250 ? '#' + CSS.escape(element.id) : null,
        htmlPreview: element.outerHTML.slice(0, 500), componentName: null, source: null, styles: ''
      },
      rect: (${visibleElementRect.toString()})(element, document, getComputedStyle)
    });
    const ancestors = [];
    for (let parent = element.parentElement; parent && parent !== document.body && parent !== document.documentElement && ancestors.length < 6; parent = parent.parentElement) {
      ancestors.push(candidate(parent));
    }
    return {
      ...candidate(element), ancestors,
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
  const details = await page.evaluate<Array<ElementContextDetails | null>>(
    `typeof window.__t3PreviewCaptureElement === 'function'
      ? Promise.all(Array.from({ length: ${1 + (before.ancestors?.length ?? 0)} }, (_, depth) =>
          depth === 0 || window.__t3PreviewCaptureElement.length >= 3
            ? window.__t3PreviewCaptureElement(${input.x}, ${input.y}, depth) : null)) : []`,
  );
  const screenshot = await captureViewport(session, { format: "jpeg", quality: 85 });
  const after = await read();
  if (page.url() !== input.pageUrl || JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("The page changed. Select the element again.");
  return {
    element: details[0] ?? before.element,
    ancestors: before.ancestors?.map((candidate, index) => ({
      ...candidate,
      element: details[index + 1] ?? candidate.element,
    })),
    rect: before.rect,
    viewport: before.viewport,
    screenshot: `data:image/jpeg;base64,${screenshot}`,
  };
}
