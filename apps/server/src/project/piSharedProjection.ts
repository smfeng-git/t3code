import {
  EventId,
  MessageId,
  ProviderDriverKind,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
const PI_DRIVER = ProviderDriverKind.make("pi");

export const NativeEntry = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  timestamp: Schema.String,
  message: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  summary: Schema.optionalKey(Schema.String),
});
export const SharedPage = Schema.Struct({
  sessionId: Schema.String,
  filePath: Schema.String,
  cwd: Schema.String,
  entries: Schema.Array(NativeEntry),
  clientMessageIds: Schema.Record(Schema.String, Schema.String),
  reset: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
});
export const SharedCatalog = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      cwd: Schema.String,
      name: Schema.optionalKey(Schema.String),
      firstMessage: Schema.optionalKey(Schema.String),
      created: Schema.String,
      modified: Schema.String,
    }),
  ),
});

export function contentBlocks(content: unknown): ReadonlyArray<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> =>
          typeof block === "object" && block !== null && !Array.isArray(block),
      )
    : [];
}

export function nativeText(entry: typeof NativeEntry.Type) {
  return contentBlocks(entry.message?.content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function sharedEntryEvents(input: {
  threadId: ThreadId;
  entry: typeof NativeEntry.Type;
  ordinal: number;
  attachments?: ReadonlyArray<ChatAttachment>;
  omitMessage?: boolean;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, entry } = input;
  const at = DateTime.makeUnsafe(entry.timestamp);
  const prefix = `pi-shared:${threadId}:${entry.id}`;
  const messageId = MessageId.make(prefix);
  const events: OrchestrationV2DomainEvent[] = [];
  let ordinal = input.ordinal;
  const base = {
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: { driver: PI_DRIVER, nativeId: entry.id, strength: "strong" as const },
    parentItemId: null,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  type ItemContent = {
    [
      K in "user_message" | "assistant_message" | "reasoning" | "command_execution" | "compaction"
    ]: Omit<Extract<OrchestrationV2TurnItem, { type: K }>, keyof typeof base | "id" | "ordinal">;
  }["user_message" | "assistant_message" | "reasoning" | "command_execution" | "compaction"];
  const addItem = (suffix: string, item: ItemContent) => {
    const payload: OrchestrationV2TurnItem = {
      ...base,
      ...item,
      id: TurnItemId.make(`${prefix}:${suffix}`),
      ordinal: ordinal++,
    };
    events.push({
      id: EventId.make(`${prefix}:${suffix}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload,
    });
  };
  const role = entry.message?.role;
  const text = nativeText(entry);
  const attachments = input.attachments ?? [];
  if (
    !input.omitMessage &&
    (role === "user" || role === "assistant") &&
    (text || attachments.length)
  ) {
    events.push({
      id: EventId.make(`${prefix}:message`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: {
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role,
        text,
        attachments,
        streaming: false,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: "provider",
        createdAt: at,
        updatedAt: at,
      },
    });
    addItem(
      "text",
      role === "user"
        ? {
            type: "user_message",
            createdBy: "user",
            creationSource: "provider",
            messageId,
            inputIntent: "turn_start",
            text,
            attachments,
          }
        : { type: "assistant_message", messageId, text, attachments, streaming: false },
    );
  }
  for (const [index, block] of contentBlocks(entry.message?.content).entries()) {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      addItem(`thinking:${index}`, { type: "reasoning", text: block.thinking, streaming: false });
    }
    if (block.type === "toolCall") {
      addItem(`tool:${index}`, {
        type: "command_execution",
        input: `${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`,
      });
    }
  }
  if (role === "toolResult") {
    addItem("result", {
      type: "command_execution",
      input: String(entry.message?.toolName ?? "Pi tool"),
      output: text,
      outputIndicatesFailure: entry.message?.isError === true,
    });
  }
  if (entry.type === "compaction") {
    addItem("compaction", { type: "compaction", driver: PI_DRIVER, summary: entry.summary ?? "" });
  }
  return events;
}
