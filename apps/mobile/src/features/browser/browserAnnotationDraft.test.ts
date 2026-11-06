import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestrationMessageContext, type PreviewElementSelection } from "@t3tools/contracts";
import { browserAnnotationDraft } from "./browserAnnotationDraft";

const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

it("links the frozen screenshot to the annotation using valid composer context", () => {
  const selection: PreviewElementSelection = {
    element: {
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      tagName: "button",
      selector: "#save",
      htmlPreview: "<button>Save</button>",
      componentName: null,
      source: null,
      styles: "",
    },
    rect: { x: 10, y: 20, width: 100, height: 40 },
    viewport: { width: 800, height: 600 },
    screenshot: "data:image/jpeg;base64,YWJj",
  };
  const draft = browserAnnotationDraft(selection, "Make this larger", "test");
  const context = decodeContext(draft.context);
  expect(context.records).toHaveLength(2);
  expect(context.records[0]).toMatchObject({
    screenshotContextId: context.records[1]?.contextId,
    pageUrl: selection.element.pageUrl,
    comment: "Make this larger",
    elements: [selection.element],
  });
  expect(context.records[1]).toMatchObject({ attachmentId: draft.attachments[0]?.id });
  expect(draft.attachments[0]?.dataUrl).toBe(selection.screenshot);
});
