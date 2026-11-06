import { ComposerContextId, type PreviewElementSelection } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";

export function browserAnnotationDraft(
  selection: PreviewElementSelection,
  comment: string,
  id: string,
) {
  const annotationId = ComposerContextId.make(`annotation_${id}`);
  const imageId = ComposerContextId.make(`image_${id}`);
  const label = `Browser: ${selection.element.tagName}`;
  const image: DraftComposerImageAttachment = {
    id,
    type: "image",
    name: "browser-annotation.jpg",
    mimeType: "image/jpeg",
    sizeBytes: Math.floor(((selection.screenshot.split(",")[1]?.length ?? 0) * 3) / 4),
    dataUrl: selection.screenshot,
    previewUri: selection.screenshot,
  };
  return {
    text: formatComposerContextReference({
      kind: "preview-annotation",
      contextId: annotationId,
      label,
    }),
    context: {
      version: 1 as const,
      records: [
        {
          version: 1 as const,
          kind: "preview-annotation" as const,
          contextId: annotationId,
          label,
          annotationId,
          pageUrl: selection.element.pageUrl,
          pageTitle: selection.element.pageTitle,
          comment,
          targetSummary: selection.element.selector ?? selection.element.tagName,
          styleChanges: [],
          elements: [selection.element],
          screenshotContextId: imageId,
        },
        {
          version: 1 as const,
          kind: "image" as const,
          contextId: imageId,
          label: image.name,
          attachmentId: id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
        },
      ],
    },
    attachments: [image],
  };
}
