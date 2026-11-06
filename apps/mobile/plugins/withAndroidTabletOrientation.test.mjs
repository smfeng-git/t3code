import { expect, it } from "vite-plus/test";
import withAndroidTabletOrientation from "./withAndroidTabletOrientation.cjs";

it("updates an existing generated phone lock without duplicating activity callbacks", async () => {
  const config = withAndroidTabletOrientation({ name: "test", slug: "test" });
  const mod = config.mods.android.mainActivity;
  const contents = `import android.os.Bundle
class MainActivity : ReactActivity() {
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyTabletOrientation()
  }
  private fun applyTabletOrientation() {
    requestedOrientation = if (resources.configuration.smallestScreenWidthDp >= 600) {
      ActivityInfo.SCREEN_ORIENTATION_FULL_USER
    } else {
      ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }
  }
}`;
  const updated = await mod({
    ...config,
    modResults: { contents, language: "kt" },
    modRequest: { platform: "android", modName: "mainActivity", projectRoot: process.cwd() },
  });
  const once = updated.modResults.contents;
  expect(once).toContain('intent.getStringExtra("t3BrowserOrientation")');
  expect(once.match(/override fun onConfigurationChanged/g)).toHaveLength(1);
  expect((await mod(updated)).modResults.contents).toBe(once);
});
