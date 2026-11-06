export interface PreviewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const fitPreviewTransform: PreviewTransform = { scale: 1, x: 0, y: 0 };

export function pinchPreviewTransform(
  previous: PreviewTransform,
  from: { x: number; y: number; distance: number },
  to: { x: number; y: number; distance: number },
  size: { width: number; height: number },
): PreviewTransform {
  const scale = Math.min(
    5,
    Math.max(1, previous.scale * (to.distance / Math.max(1, from.distance))),
  );
  const ratio = scale / previous.scale;
  return {
    scale,
    x: Math.min(0, Math.max(size.width * (1 - scale), to.x - (from.x - previous.x) * ratio)),
    y: Math.min(0, Math.max(size.height * (1 - scale), to.y - (from.y - previous.y) * ratio)),
  };
}
