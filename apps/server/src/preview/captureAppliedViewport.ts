import type { CDPSession, Page } from "playwright-core";
import { captureViewport } from "./ServerBrowserPage.ts";

export async function captureAppliedViewport(
  page: Page,
  session: CDPSession,
  size: { width: number; height: number },
) {
  // Hidden Electron guests need no animation frame to acknowledge a layout change.
  await page.evaluate(`new Promise((resolve, reject) => {
    const matches = () => innerWidth === ${size.width} && innerHeight === ${size.height};
    if (matches()) { resolve(); return; }
    const cleanup = () => { clearTimeout(timer); removeEventListener('resize', changed); };
    const changed = () => { if (matches()) { cleanup(); resolve(); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The PC did not apply the requested layout.')); }, 5000);
    addEventListener('resize', changed);
  })`);
  const screenshot = await captureViewport(session, { format: "jpeg", quality: 85 });
  const actual = await page.evaluate<{ width: number; height: number }>(
    "({ width: innerWidth, height: innerHeight })",
  );
  if (actual.width !== size.width || actual.height !== size.height)
    throw new Error("The browser layout changed during capture. Fit the page again.");
  return { ...actual, screenshot: `data:image/jpeg;base64,${screenshot}` };
}
