import { Sheet } from "../../components/ui/Sheet";
import { useState } from "react";
import { ScrollView, TextInput, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { type PreviewElementSelection } from "@t3tools/contracts";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { insertComposerDraftContext } from "../../state/use-composer-drafts";
import { uuidv4 } from "../../lib/uuid";
import { browserAnnotationDraft } from "./browserAnnotationDraft";

export function BrowserAnnotationSheet({
  selection,
  draftKey,
  onClose,
  onReselect,
  onAdded,
}: {
  readonly selection: PreviewElementSelection;
  readonly draftKey: string;
  readonly onClose: () => void;
  readonly onReselect: () => void;
  readonly onAdded: () => void;
}) {
  const [comment, setComment] = useState("");
  const [previewWidth, setPreviewWidth] = useState(0);
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const scale = Math.min(
    previewWidth / selection.viewport.width,
    (landscape ? height * 0.25 : 300) / selection.viewport.height,
  );
  return (
    <Sheet title="Annotate element" onClose={onClose} expanded={landscape}>
      <ScrollView
        className="flex-1 bg-sheet"
        contentContainerStyle={{ padding: 20, paddingTop: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className={landscape ? "flex-row gap-4" : undefined}>
          <View className={landscape ? "flex-1" : undefined}>
            <AppText className="mb-3 text-sm text-foreground-muted">
              {selection.element.selector ?? selection.element.tagName}
            </AppText>
            <View
              onLayout={(event) => setPreviewWidth(event.nativeEvent.layout.width)}
              className="items-center"
            >
              <View
                style={{
                  width: selection.viewport.width * scale,
                  height: selection.viewport.height * scale,
                }}
              >
                <Image
                  source={{ uri: selection.screenshot }}
                  contentFit="contain"
                  style={{
                    width: "100%",
                    height: "100%",
                  }}
                />
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: selection.rect.x * scale,
                    top: selection.rect.y * scale,
                    width: selection.rect.width * scale,
                    height: selection.rect.height * scale,
                    borderWidth: 2,
                    borderColor: "#2563eb",
                    backgroundColor: "rgba(37,99,235,0.12)",
                  }}
                />
              </View>
            </View>
          </View>
          <View className={landscape ? "flex-1" : undefined}>
            <Button
              label="Select another element"
              size="compact"
              tone="text"
              onPress={onReselect}
            />
            <TextInput
              accessibilityLabel="Annotation comment"
              placeholder="Describe what you want to change"
              value={comment}
              onChangeText={setComment}
              multiline
              maxLength={8000}
              className="my-4 min-h-24 rounded-lg border border-input-border bg-input p-3 text-foreground"
            />
            <View className="flex-row justify-end gap-3">
              <Button label="Cancel" tone="secondary" onPress={onClose} />
              <Button
                label="Add to chat"
                disabled={!comment.trim()}
                onPress={() => {
                  const content = browserAnnotationDraft(selection, comment.trim(), uuidv4());
                  if (!insertComposerDraftContext(draftKey, content)) {
                    Dialog.alert(
                      "Could not add annotation",
                      "The chat draft has reached its attachment or context limit.",
                    );
                    return;
                  }
                  onAdded();
                }}
              />
            </View>
          </View>
        </View>
      </ScrollView>
    </Sheet>
  );
}
