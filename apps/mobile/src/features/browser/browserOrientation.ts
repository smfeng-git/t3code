import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export function setBrowserOrientation(mode: "auto" | "portrait" | "landscape" | "restore") {
  if (Platform.OS !== "android") return Promise.resolve();
  const controls = requireOptionalNativeModule<{
    setBrowserOrientation?: (mode: string) => Promise<void>;
  }>("T3NativeControls");
  return (
    controls?.setBrowserOrientation?.(mode) ??
    Promise.reject(new Error("Update the Android app to enable browser rotation."))
  );
}
