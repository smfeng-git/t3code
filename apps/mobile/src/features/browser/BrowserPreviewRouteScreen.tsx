import { useWindowDimensions } from "react-native";
import type { PreviewElementSelection, PreviewViewportSetting } from "@t3tools/contracts";
import { useAtomSet } from "@effect/atom-react";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { rememberBrowserViewport } from "./browserViewport";
import type { PreviewLayoutState } from "./preview-stream-document";
import type { PreviewStreamControl } from "@t3tools/client-runtime/preview/server-browser-stream";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { setBrowserOrientation } from "./browserOrientation";
import { BrowserAnnotationSheet } from "./BrowserAnnotationSheet";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { normalizePreviewUrl, previewPdfAssetUrl } from "@t3tools/shared/preview";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ControlPill } from "../../components/ui/ControlPill";
import { useAppForeground } from "../../lib/appState";
import { useHardwareBack } from "../../lib/backHandler";
import { AppBar } from "../../components/ui/AppBar";

import { useThreadServerBrowserTabs } from "../../state/preview";
import { usePreparedConnection } from "../../state/session";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { BrowserTabMenu } from "./BrowserTabMenu";
import { browserTabTitle, browserTabUrl, latestBrowserTab } from "./browserTabs";
import {
  PreviewStreamWebView,
  type PreviewPictureInPictureState,
  type PreviewStreamRef,
} from "./PreviewStreamWebView";

const BrowserPreviewStack = createNativeStackNavigator<{ BrowserPreview: undefined }>();

const NO_PICTURE_IN_PICTURE: PreviewPictureInPictureState = { supported: false, active: false };

type BrowserPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly tabId?: string;
}>;

export function BrowserPreviewRouteScreen({ route }: BrowserPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <BrowserPreviewStack.Navigator
        screenOptions={{
          headerShown: Platform.OS === "ios",
          headerBackVisible: false,
          headerShadowVisible: false,
          headerTransparent: false,
          headerTitleStyle: { fontSize: 17, fontWeight: "600" },
        }}
      >
        <BrowserPreviewStack.Screen name="BrowserPreview">
          {() => (
            <BrowserPreviewScreen
              environmentId={EnvironmentId.make(route.params.environmentId)}
              threadId={ThreadId.make(route.params.threadId)}
              initialTabId={route.params.tabId ?? null}
              onClose={onClose}
            />
          )}
        </BrowserPreviewStack.Screen>
      </BrowserPreviewStack.Navigator>
    </View>
  );
}

function BrowserPreviewScreen({
  environmentId,
  threadId,
  initialTabId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly initialTabId: string | null;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const prepared = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedTabId, setSelectedTabId] = useState(initialTabId);
  const [pictureInPicture, setPictureInPicture] = useState(NO_PICTURE_IN_PICTURE);
  const [streaming, setStreaming] = useState(false);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const canControl = control?.controller === "you";
  const streamRef = useRef<PreviewStreamRef>(null);
  const [layouts, setLayouts] = useState<Record<string, PreviewViewportSetting>>({});
  const [layoutState, setLayoutState] = useState<PreviewLayoutState | null>(null);
  const [selectionSide, setSelectionSide] = useState<"top" | "bottom">("bottom");
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const pendingRecent = useRef<{ tabId: string; width: number; height: number } | null>(null);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const dimensions = useWindowDimensions();
  const compactToolbar = Platform.OS === "android" && dimensions.width > dimensions.height;
  const navigation = useNavigation();
  const [landscape, setLandscape] = useState(compactToolbar);
  const [fullscreen, setFullscreen] = useState(compactToolbar);
  const [controlsOpen, setControlsOpen] = useState(false);
  if (landscape !== compactToolbar) {
    setLandscape(compactToolbar);
    setFullscreen(compactToolbar);
    setControlsOpen(false);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes Android system bars with the focused native browser screen
  useEffect(() => {
    if (Platform.OS !== "android") return;
    navigation.setOptions({
      statusBarHidden: focused && fullscreen,
      navigationBarHidden: focused && fullscreen,
    });
  }, [navigation, focused, fullscreen]);
  const [pickScope, setPickScope] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<{
    selection: PreviewElementSelection;
    index: number;
    scope: string;
  } | null>(null);
  const [selection, setSelection] = useState<PreviewElementSelection | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns native orientation only while the browser route is focused
  useEffect(() => {
    if (!focused || Platform.OS !== "android") return;
    void setBrowserOrientation("auto").catch(() => {});
    return () => {
      void setBrowserOrientation("restore").catch(() => {});
    };
  }, [focused]);
  const { tabs, loaded } = useThreadServerBrowserTabs({ environmentId, threadId, enabled: true });
  const tab = tabs.find((entry) => entry.tabId === selectedTabId) ?? latestBrowserTab(tabs);
  const pdfUri =
    tab?.navStatus._tag === "Success" ? previewPdfAssetUrl(tab.navStatus.url, httpBaseUrl) : null;
  const tabId = tab?.tabId ?? null;
  if (tabId !== null && tabId !== selectedTabId) {
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(tabId);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the focused route through the navigator once the thread has no browser tabs left
  useEffect(() => {
    if (focused && loaded && tabs.length === 0) onClose();
  }, [focused, loaded, tabs.length, onClose]);
  const onPictureInPicture = (state: PreviewPictureInPictureState, detail?: string) => {
    setPictureInPicture({ supported: state.supported, active: state.active });
    if (detail) Dialog.alert("Picture in picture is unavailable", detail);
  };
  const selectTab = (next: string) => {
    streamRef.current?.selectElement(null);
    setPicking(false);
    setPictureInPicture(NO_PICTURE_IN_PICTURE);
    setSelectedTabId(next);
  };
  const live = (focused && foreground) || pictureInPicture.active;
  const pageUrl = tab ? browserTabUrl(tab) : "";
  const selectionScope = `${tabId}:${pageUrl}:${canControl}:${live}:${streaming}`;
  const picking = pickScope === selectionScope;
  const setPicking = (active: boolean) => setPickScope(active ? selectionScope : null);
  if (pickScope !== null && pickScope !== selectionScope) setPickScope(null);
  if (candidate && (!picking || candidate.scope !== selectionScope)) setCandidate(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes selection mode with the WebView and cancels stale requests
  useEffect(() => {
    streamRef.current?.selectElement(picking ? pageUrl : null);
  }, [picking, pageUrl, streamRef]);

  useHardwareBack((fullscreen || picking || controlsOpen) && selection === null, () => {
    if (controlsOpen) setControlsOpen(false);
    else if (picking) {
      setPicking(false);
      setCandidate(null);
    } else setFullscreen(false);
    return true;
  });
  const highlighted = candidate
    ? candidate.index === 0
      ? candidate.selection
      : candidate.selection.ancestors?.[candidate.index - 1]
    : null;
  const withControlsClosed = (action: () => void) => {
    action();
    setControlsOpen(false);
  };
  const viewportSetting = (tabId && layouts[tabId]) || { _tag: "fill" as const };
  const viewportEnabled = streaming && canControl && !!control?.viewportSync;
  const changeViewport = (setting: PreviewViewportSetting, remember = false) => {
    if (!tabId || !viewportEnabled) return;
    pendingRecent.current =
      remember && setting._tag === "freeform"
        ? { tabId, width: setting.width, height: setting.height }
        : null;
    setLayouts((current) => ({ ...current, [tabId]: setting }));
    if (setting._tag === "fill") streamRef.current?.fitToScreen();
    else streamRef.current?.command({ type: "viewport", setting });
    setControlsOpen(false);
  };

  return (
    <View
      className="flex-1 bg-sheet"
      style={{
        paddingBottom: insets.bottom,
        paddingTop: compactToolbar || fullscreen ? insets.top : 0,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {!compactToolbar && !fullscreen ? (
        <AppBar
          title={tab ? browserTabTitle(tab) : "Browser"}
          onBack={onClose}
          options={{ headerBackVisible: false }}
          actions={
            // Android WebView cannot play video in picture in picture.
            Platform.OS === "ios" &&
            pictureInPicture.supported &&
            (pictureInPicture.active || pdfUri === null)
              ? [
                  {
                    accessibilityLabel: pictureInPicture.active
                      ? "Exit picture in picture"
                      : "Picture in picture",
                    icon: {
                      ios: pictureInPicture.active ? "pip.exit" : "pip.enter",
                      android: "visibility",
                    },
                    selected: pictureInPicture.active,
                    onPress: () => streamRef.current?.togglePictureInPicture(),
                  },
                ]
              : []
          }
          menus={
            tabs.length > 1
              ? [
                  {
                    title: "Tabs",
                    icon: "square.on.square",
                    items: tabs.map((entry) => ({
                      id: entry.tabId,
                      title: browserTabTitle(entry),
                      subtitle: browserTabUrl(entry),
                      selected: entry.tabId === tabId,
                      onPress: () => selectTab(entry.tabId),
                    })),
                  },
                ]
              : []
          }
        />
      ) : null}
      {Platform.OS === "ios" ? (
        <SheetHeader
          title={tab ? browserTabTitle(tab) : "Browser"}
          onClose={onClose}
          accessibilityLabel="Close browser"
        />
      ) : null}
      {selection ? (
        <BrowserAnnotationSheet
          selection={selection}
          draftKey={`${environmentId}:${threadId}`}
          onClose={() => setSelection(null)}
          onReselect={() => {
            setSelection(null);
            setPicking(true);
          }}
          onAdded={() => {
            setSelection(null);
            onClose();
          }}
        />
      ) : null}
      {tab ? (
        <>
          <View
            style={
              fullscreen
                ? {
                    position: "absolute",
                    top: insets.top,
                    left: insets.left,
                    right: insets.right,
                    zIndex: 1,
                    display: controlsOpen ? "flex" : "none",
                  }
                : undefined
            }
            className="bg-sheet"
          >
            <BrowserAddressBar
              key={`address:${tab.tabId}`}
              environmentId={environmentId}
              tab={tab}
              streaming={streaming}
              ready={
                streaming &&
                canControl &&
                !candidate &&
                layoutState?.state !== "pending" &&
                layoutState?.state !== "error"
              }
              onCommand={(input) => withControlsClosed(() => streamRef.current?.command(input))}
              onPaste={() => withControlsClosed(() => streamRef.current?.paste())}
              viewportSetting={viewportSetting}
              viewportEnabled={viewportEnabled}
              onViewportChange={changeViewport}
              onClose={compactToolbar ? onClose : undefined}
            />
            <View className="flex-row flex-wrap gap-2 px-2 pb-2">
              {Platform.OS === "android" ? (
                <Button
                  size="compact"
                  label="Rotate"
                  onPress={() => {
                    setControlsOpen(false);
                    void setBrowserOrientation(
                      dimensions.width > dimensions.height ? "portrait" : "landscape",
                    ).catch((error: unknown) => Dialog.alert("Could not rotate", String(error)));
                  }}
                />
              ) : null}
              <Button
                size="compact"
                label="Auto-fit layout"
                disabled={!viewportEnabled}
                onPress={() => changeViewport({ _tag: "fill" })}
              />
              <Button
                size="compact"
                label="Reset view"
                onPress={() => withControlsClosed(() => streamRef.current?.resetZoom())}
              />
              <Button
                size="compact"
                label={picking ? "Cancel selection" : "Annotate"}
                disabled={
                  !viewportEnabled ||
                  layoutState?.state === "pending" ||
                  layoutState?.state === "error" ||
                  pdfUri !== null
                }
                onPress={() => {
                  streamRef.current?.selectElement(picking ? null : pageUrl);
                  setPicking(!picking);
                  setSelectionNotice(null);
                  setControlsOpen(false);
                }}
              />
              {Platform.OS === "android" ? (
                <Button
                  size="compact"
                  label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                  onPress={() => {
                    setFullscreen(!fullscreen);
                    setControlsOpen(false);
                  }}
                />
              ) : null}
              {fullscreen ? (
                <Button
                  size="compact"
                  label="Hide controls"
                  onPress={() => setControlsOpen(false)}
                />
              ) : null}
              {control?.canOperate ? (
                <View className="ml-auto">
                  <Button
                    size="compact"
                    label={canControl ? "Release control" : "Take control"}
                    disabled={control.controller === "another-viewer"}
                    onPress={() =>
                      withControlsClosed(() =>
                        streamRef.current?.command({
                          type: canControl ? "releaseControl" : "takeControl",
                        }),
                      )
                    }
                  />
                </View>
              ) : null}
            </View>
          </View>
          {live ? (
            <PreviewStreamWebView
              key={`stream:${tab.tabId}`}
              environmentId={environmentId}
              threadId={threadId}
              tabId={tab.tabId}
              pdfUri={pdfUri}
              ref={streamRef}
              initialViewport={viewportSetting}
              onLayoutState={(next) => {
                setLayoutState(next);
                setLayouts((current) => ({ ...current, [tab.tabId]: next.setting }));
                const recent = pendingRecent.current;
                if (
                  next.state === "ready" &&
                  recent?.tabId === tab.tabId &&
                  next.setting._tag === "freeform" &&
                  next.setting.width === recent.width &&
                  next.setting.height === recent.height
                ) {
                  pendingRecent.current = null;
                  updatePreferences({
                    transform: (current) => ({
                      browserRecentViewports: rememberBrowserViewport(
                        current.browserRecentViewports ?? [],
                        { width: recent.width, height: recent.height },
                      ),
                    }),
                  });
                }
              }}
              onSelectionPosition={setSelectionSide}
              onSelectionCleared={(detail) => {
                if (candidate || picking) setSelectionNotice(detail);
                setCandidate(null);
                setPicking(false);
              }}
              interactive
              hideControlBar
              background={themeVariables["--color-sheet-solid"]}
              onPictureInPicture={onPictureInPicture}
              onElementPicked={(result) => {
                if (result.error) {
                  Dialog.alert("Could not select element", result.error);
                  return;
                }
                if (result.selection) {
                  setSelectionNotice(null);
                  setCandidate({ selection: result.selection, index: 0, scope: selectionScope });
                }
              }}
              onViewport={() => {
                setCandidate(null);
              }}
              onElementConfirmed={(confirmed) => {
                if (!candidate || !picking || candidate.scope !== selectionScope) return;
                streamRef.current?.selectElement(null);
                setPicking(false);
                setCandidate(null);
                setSelection(confirmed);
              }}
              onStreamingChange={setStreaming}
              onControl={(next) => {
                setControl(next);
                if (!next) setLayoutState(null);
              }}
            />
          ) : (
            <View className="flex-1" />
          )}
          {candidate ? (
            <View
              className="absolute left-0 right-0 gap-2 bg-sheet px-3 py-2"
              style={selectionSide === "top" ? { top: insets.top } : { bottom: insets.bottom }}
            >
              <AppText numberOfLines={1} className="text-sm text-foreground">
                Frozen snapshot · {candidate.index === 0 ? "Element" : `Parent ${candidate.index}`}:{" "}
                {highlighted?.element.componentName ??
                  highlighted?.element.selector ??
                  highlighted?.element.tagName}
              </AppText>
              <AppText className="text-xs text-foreground-muted">
                The PC page is still running. Pinch to inspect this snapshot.
              </AppText>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label="Parent"
                  disabled={candidate.index >= (candidate.selection.ancestors?.length ?? 0)}
                  onPress={() => {
                    streamRef.current?.highlightElement(candidate.index + 1);
                    setCandidate({ ...candidate, index: candidate.index + 1 });
                  }}
                />
                <Button
                  label="Previous level"
                  disabled={candidate.index === 0}
                  onPress={() => {
                    streamRef.current?.highlightElement(candidate.index - 1);
                    setCandidate({ ...candidate, index: candidate.index - 1 });
                  }}
                />
                <Button
                  label="Reselect"
                  onPress={() => {
                    setCandidate(null);
                    streamRef.current?.selectElement(pageUrl);
                  }}
                />
                <Button
                  label="Cancel"
                  onPress={() => {
                    setCandidate(null);
                    setPicking(false);
                  }}
                />
                <Button
                  label="Confirm element"
                  tone="primary"
                  onPress={() => streamRef.current?.highlightElement(candidate.index, true)}
                />
              </View>
            </View>
          ) : null}
          {selectionNotice && !candidate ? (
            <View className="absolute bottom-0 left-0 right-0 bg-sheet px-3 py-2">
              <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground">
                {selectionNotice}
              </AppText>
              <Button label="Dismiss" tone="text" onPress={() => setSelectionNotice(null)} />
            </View>
          ) : null}
          {fullscreen && !controlsOpen && !candidate ? (
            <View style={{ position: "absolute", top: insets.top + 8, right: insets.right + 8 }}>
              <ControlPill
                icon="ellipsis"
                accessibilityLabel="Show browser controls"
                onPress={() => setControlsOpen(true)}
              />
            </View>
          ) : null}
        </>
      ) : (
        <View className="flex-1 items-center justify-center">
          {focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
    </View>
  );
}

function BrowserAddressBar({
  environmentId,
  tab,
  ready,
  streaming,
  onCommand,
  onPaste,
  viewportSetting,
  viewportEnabled,
  onViewportChange,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly tab: PreviewSessionSnapshot;
  readonly ready: boolean;
  readonly streaming: boolean;
  readonly onCommand: PreviewStreamRef["command"];
  readonly onPaste: () => void;
  readonly viewportSetting: PreviewViewportSetting;
  readonly viewportEnabled: boolean;
  readonly onViewportChange: (setting: PreviewViewportSetting, remember: boolean) => void;
  readonly onClose?: () => void;
}) {
  const url = browserTabUrl(tab);
  const [draft, setDraft] = useState<string | null>(null);
  const submit = () => {
    const value = draft ?? url;
    setDraft(null);
    try {
      onCommand({ type: "navigate", url: normalizePreviewUrl(value) });
    } catch {
      Dialog.alert("Could not open this address", "Enter an http or https URL.");
    }
  };
  return (
    <View className="flex-row items-center gap-1 px-2 pb-2">
      {onClose ? (
        <ControlPill icon="xmark" accessibilityLabel="Close browser" onPress={onClose} />
      ) : null}
      <ControlPill
        icon="chevron.left"
        accessibilityLabel="Back"
        disabled={!ready || !tab.canGoBack}
        onPress={() => onCommand({ type: "history", delta: -1 })}
      />
      <ControlPill
        icon="chevron.right"
        accessibilityLabel="Forward"
        disabled={!ready || !tab.canGoForward}
        onPress={() => onCommand({ type: "history", delta: 1 })}
      />
      <TextInput
        accessibilityLabel="Address"
        editable={ready}
        value={draft ?? url}
        onChangeText={setDraft}
        onBlur={() => setDraft(null)}
        onSubmitEditing={submit}
        placeholder="Enter a URL"
        placeholderTextColorClassName="accent-placeholder"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        selectTextOnFocus
        lineBreakModeIOS="tail"
        className="h-10 min-w-0 flex-1 rounded-full border border-input-border bg-input px-4 font-sans text-sm text-foreground"
      />
      <ControlPill
        icon="arrow.clockwise"
        accessibilityLabel="Reload page"
        disabled={!ready}
        onPress={() => onCommand({ type: "reload" })}
      />
      <BrowserTabMenu
        environmentId={environmentId}
        tab={tab}
        streaming={streaming}
        onPaste={ready ? onPaste : undefined}
        viewportSetting={viewportSetting}
        viewportEnabled={viewportEnabled}
        onViewportChange={onViewportChange}
      />
    </View>
  );
}
