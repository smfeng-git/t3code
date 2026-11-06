import * as Dialog from "../../components/ui/Dialog";
import type { ReactElement } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { parseBrowserViewport, rememberBrowserViewport } from "./browserViewport";
import type { MenuAction } from "@react-native-menu/menu";
import {
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  type EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";

const APPEARANCES = [
  { id: "system", title: "System" },
  { id: "light", title: "Light" },
  { id: "dark", title: "Dark" },
] as const;

const VIEWPORTS = [
  { id: "fill", title: "Auto-fit layout", setting: FILL_PREVIEW_VIEWPORT },
  ...PREVIEW_VIEWPORT_PRESETS.map((preset) => ({
    id: `preset:${preset.id}`,
    title: `${preset.label} (${preset.detail})`,
    setting: {
      _tag: "preset",
      presetId: preset.id,
      width: preset.width,
      height: preset.height,
    } satisfies PreviewViewportSetting,
  })),
  ...(
    [
      [1280, 720],
      [1280, 800],
      [1366, 768],
      [1440, 900],
      [1536, 864],
      [1920, 1080],
      [1920, 1200],
      [2560, 1440],
      [3840, 2160],
    ] as const
  ).map(([width, height]) => ({
    id: `desktop:${width}x${height}`,
    title: `Desktop (${width} × ${height})`,
    setting: { _tag: "freeform", width, height } satisfies PreviewViewportSetting,
  })),
];

export function BrowserTabMenu({
  environmentId,
  tab,
  streaming,
  onPaste,
  onViewportChange,
  viewportSetting,
  viewportEnabled = true,
  mode = "all",
  children,
}: {
  readonly mode?: "all" | "viewport" | "page";
  readonly children?: ReactElement;
  readonly environmentId: EnvironmentId;
  readonly tab: PreviewSessionSnapshot;
  readonly streaming: boolean;
  readonly onPaste?: () => void;
  readonly onViewportChange?: (setting: PreviewViewportSetting, remember: boolean) => void;
  readonly viewportSetting?: PreviewViewportSetting;
  readonly viewportEnabled?: boolean;
}) {
  const viewport = viewportSetting ?? tab.viewport;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const recent = AsyncResult.isSuccess(preferences)
    ? (preferences.value.browserRecentViewports ?? [])
    : [];
  const adjust = useAtomCommand(previewEnvironment.adjust, "browser tab change");
  const resize = useAtomCommand(previewEnvironment.resize, "browser viewport change");
  const close = useAtomCommand(previewEnvironment.close, "browser tab close");
  const canClose = useAtomValue(previewEnvironment.close.permissionAtom(environmentId));
  const target = { threadId: tab.threadId as PreviewAdjustInput["threadId"], tabId: tab.tabId };
  const colorScheme = tab.colorScheme ?? "system";
  const zoomFactor = tab.zoomFactor ?? DEFAULT_PREVIEW_ZOOM_FACTOR;
  const zoomIndex = PREVIEW_ZOOM_LEVELS.indexOf(zoomFactor);
  const zoomTo = (step: -1 | 1) =>
    PREVIEW_ZOOM_LEVELS[
      Math.min(Math.max((zoomIndex < 0 ? 7 : zoomIndex) + step, 0), PREVIEW_ZOOM_LEVELS.length - 1)
    ]!;
  const viewportOptions = [
    ...recent.map((size, index) => ({
      id: `recent:${index}`,
      title: `Recent (${size.width} × ${size.height})`,
      setting: { _tag: "freeform", ...size } satisfies PreviewViewportSetting,
    })),
    ...VIEWPORTS,
  ];
  const applyViewport = (setting: PreviewViewportSetting, remember = false) => {
    if (!viewportEnabled) return;
    if (onViewportChange) onViewportChange(setting, remember);
    else
      void resize({ environmentId, input: { ...target, viewport: setting } }).then((result) => {
        if (result._tag === "Failure") Dialog.alert("Could not change the viewport");
        else if (remember && setting._tag === "freeform")
          updatePreferences({
            transform: (current) => ({
              browserRecentViewports: rememberBrowserViewport(
                current.browserRecentViewports ?? [],
                {
                  width: setting.width,
                  height: setting.height,
                },
              ),
            }),
          });
      });
  };
  const customViewport = (initialValue: string) =>
    Dialog.prompt({
      title: "Custom viewport",
      message:
        "Width × height in CSS pixels (240–3840 each, up to 3840 × 2160 total). This changes the shared PC page layout.",
      initialValue,
      placeholder: "1440 × 900",
      confirmText: "Apply",
      onConfirm: (value) => {
        const size = parseBrowserViewport(value);
        if (!size) {
          Dialog.alert("Invalid size", "Enter width × height within the limits.", [
            { text: "Try again", onPress: () => customViewport(value) },
            { text: "Cancel", style: "cancel" },
          ]);
          return;
        }
        applyViewport({ _tag: "freeform", ...size }, true);
      },
    });

  const closeAction: MenuAction = {
    id: "close",
    title: "Close tab",
    image: "xmark",
    attributes: { destructive: true, disabled: !canClose },
  };
  const actions: MenuAction[] = [
    ...(onPaste ? [{ id: "paste", title: "Paste", image: "doc.on.clipboard" }] : []),
    { id: "hard-reload", title: "Hard reload", image: "arrow.clockwise.circle" },
    {
      id: "appearance",
      title: "Appearance",
      image: "circle.lefthalf.filled",
      subactions: APPEARANCES.map((option) => ({
        id: `appearance:${option.id}`,
        title: option.title,
        state: option.id === colorScheme ? "on" : "off",
      })),
    },
    {
      id: "zoom",
      title: `Page zoom (${Math.round(zoomFactor * 100)}%)`,
      image: "plus.magnifyingglass",
      subactions: [
        { id: "zoom:in", title: "Zoom in", image: "plus.magnifyingglass" },
        { id: "zoom:out", title: "Zoom out", image: "minus.magnifyingglass" },
        { id: "zoom:reset", title: "Actual size", image: "1.magnifyingglass" },
      ],
    },
    {
      id: "viewport",
      attributes: { disabled: !viewportEnabled },
      title:
        viewport && viewport._tag !== "fill"
          ? `Fixed layout (${viewport.width} × ${viewport.height})`
          : "Auto-fit layout",
      image: "rectangle.and.arrow.up.right.and.arrow.down.left",
      subactions: [
        { id: "viewport-custom", title: "Custom size…" },
        {
          id: "viewport-swap",
          title: "Swap width and height",
          attributes: { disabled: !viewport || viewport._tag === "fill" },
        },
        ...viewportOptions.map((option): MenuAction => ({
          id: `viewport:${option.id}`,
          title: option.title,
          state: (
            option.setting._tag === "fill"
              ? !viewport || viewport._tag === "fill"
              : viewport &&
                viewport._tag !== "fill" &&
                viewport.width === option.setting.width &&
                viewport.height === option.setting.height
          )
            ? "on"
            : "off",
        })),
      ],
    },
    {
      id: "site-data",
      title: "Site data",
      image: "trash",
      subactions: [
        { id: "clear:cookies", title: "Clear cookies", attributes: { destructive: true } },
        { id: "clear:cache", title: "Clear cache", attributes: { destructive: true } },
      ],
    },
    closeAction,
  ];

  const run = async (change: Omit<PreviewAdjustInput, "threadId" | "tabId">) => {
    const result = await adjust({ environmentId, input: { ...target, ...change } });
    if (result._tag === "Failure") Dialog.alert("Could not change this browser tab");
  };

  const onAction = (id: string) => {
    if (id === "close") {
      void close({ environmentId, input: target }).then((result) => {
        if (result._tag === "Failure") Dialog.alert("Could not close this browser tab");
      });
      return;
    }
    if (id === "viewport-custom") {
      const size = viewport && viewport._tag !== "fill" ? viewport : recent[0];
      customViewport(size ? `${size.width} × ${size.height}` : "1440 × 900");
      return;
    }
    if (id === "viewport-swap") {
      if (viewport && viewport._tag !== "fill")
        applyViewport({ _tag: "freeform", width: viewport.height, height: viewport.width }, true);
      return;
    }
    if (id === "paste") return onPaste?.();
    if (id === "hard-reload") return void run({ hardReload: true });
    if (id === "zoom:in") return void run({ zoomFactor: zoomTo(1) });
    if (id === "zoom:out") return void run({ zoomFactor: zoomTo(-1) });
    if (id === "zoom:reset") return void run({ zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR });
    if (id === "clear:cookies") return void run({ clear: "cookies" });
    if (id === "clear:cache") return void run({ clear: "cache" });
    if (id.startsWith("appearance:")) {
      const option = APPEARANCES.find((candidate) => `appearance:${candidate.id}` === id);
      if (option) void run({ colorScheme: option.id });
      return;
    }
    if (id.startsWith("viewport:")) {
      const option = viewportOptions.find((candidate) => `viewport:${candidate.id}` === id);
      if (!option) return;
      applyViewport(option.setting, id.startsWith("viewport:recent:"));
    }
  };

  return (
    <Menu
      // Remount when streaming changes, so an open menu never keeps offering
      // the other state's actions.
      key={streaming ? "streaming" : "idle"}
      accessible
      accessibilityLabel={mode === "viewport" ? "Page size" : "Browser tab options"}
      accessibilityRole="button"
      actions={
        mode === "viewport"
          ? viewportEnabled
            ? actions.find((action) => action.id === "viewport")!.subactions!
            : []
          : streaming
            ? actions.filter((action) => mode !== "page" || action.id !== "viewport")
            : [closeAction]
      }
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      {children ?? <ControlPill icon="ellipsis" accessibilityLabel="Browser tab options" />}
    </Menu>
  );
}
