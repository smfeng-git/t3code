import { Sheet } from "../../components/ui/Sheet";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
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
  onAdded,
}: {
  readonly selection: PreviewElementSelection;
  readonly draftKey: string;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const [comment, setComment] = useState("");
  return (
    <Sheet title="Annotate element" onClose={onClose}>
      <ScrollView
        className="flex-1 bg-sheet"
        contentContainerStyle={{ padding: 20, paddingTop: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        <AppText className="mb-3 text-sm text-foreground-muted">
          {selection.element.selector ?? selection.element.tagName}
        </AppText>
        <Image
          source={{ uri: selection.screenshot }}
          contentFit="contain"
          style={{
            width: "100%",
            aspectRatio: selection.viewport.width / selection.viewport.height,
            maxHeight: 360,
          }}
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
      </ScrollView>
    </Sheet>
  );
}
