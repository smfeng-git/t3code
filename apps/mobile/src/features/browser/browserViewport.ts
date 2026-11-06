import { PreviewViewportSize } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const isViewportSize = Schema.is(PreviewViewportSize);

export function parseBrowserViewport(value: string): PreviewViewportSize | null {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(value);
  if (!match) return null;
  const size = { width: Number(match[1]), height: Number(match[2]) };
  return isViewportSize(size) ? size : null;
}
export function rememberBrowserViewport(
  recent: ReadonlyArray<PreviewViewportSize>,
  size: PreviewViewportSize,
) {
  return [
    size,
    ...recent.filter((entry) => entry.width !== size.width || entry.height !== size.height),
  ].slice(0, 5);
}
