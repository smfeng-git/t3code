import { expect, it } from "vite-plus/test";
import { fitPreviewTransform, pinchPreviewTransform } from "./previewTransform";

it("keeps the page point under the pinch midpoint and bounds panning", () => {
  const size = { width: 400, height: 800 };
  const from = { x: 100, y: 200, distance: 100 };
  const zoomed = pinchPreviewTransform(fitPreviewTransform, from, { ...from, distance: 200 }, size);
  expect(zoomed).toEqual({ scale: 2, x: -100, y: -200 });
  expect((from.x - zoomed.x) / zoomed.scale).toBe(from.x);
  expect(pinchPreviewTransform(zoomed, from, { x: 900, y: 900, distance: 200 }, size)).toEqual({
    scale: 4,
    x: 0,
    y: 0,
  });
  expect(pinchPreviewTransform(zoomed, from, { ...from, distance: 1 }, size)).toEqual(
    fitPreviewTransform,
  );
});
