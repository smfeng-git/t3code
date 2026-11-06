import { describe, expect, it } from "vite-plus/test";
import { parseBrowserViewport, rememberBrowserViewport } from "./browserViewport";
describe("custom browser viewport", () => {
  it("accepts dimensions within the remote viewport limits", () => {
    expect(parseBrowserViewport(" 1440 × 900 ")).toEqual({ width: 1440, height: 900 });
    expect(parseBrowserViewport("240X3840")).toEqual({ width: 240, height: 3840 });
    expect(parseBrowserViewport("3840x2160")).toEqual({ width: 3840, height: 2160 });
    for (const value of [
      "239x900",
      "3841x900",
      "3840x3840",
      "1.5x900",
      "1440",
      "1440x900junk",
      "-800x600",
    ]) {
      expect(parseBrowserViewport(value)).toBeNull();
    }
  });
  it("moves reused sizes to the front, preserves orientation and bounds history", () => {
    const recent = [600, 700, 800, 900, 1000].map((width) => ({ width, height: 600 }));
    expect(rememberBrowserViewport(recent, { width: 800, height: 600 })).toEqual([
      recent[2],
      recent[0],
      recent[1],
      recent[3],
      recent[4],
    ]);
    expect(rememberBrowserViewport(recent, { width: 600, height: 800 })).toEqual([
      { width: 600, height: 800 },
      ...recent.slice(0, 4),
    ]);
  });
});
