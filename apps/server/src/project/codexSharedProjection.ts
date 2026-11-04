// @effect-diagnostics nodeBuiltinImport:off -- synchronous content hashing keeps the projection pure.
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  MessageId,
  ProviderDriverKind,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const codexHistoryFingerprint = (value: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");

export function codexItemText(item: Record<string, unknown>): string {
  if (item.type === "agentMessage") return typeof item.text === "string" ? item.text : "";
  if (item.type === "userMessage" && Array.isArray(item.content))
    return item.content
      .flatMap((block: unknown) => {
        if (!block || typeof block !== "object") return [];
        if ("text" in block && typeof block.text === "string") return [block.text];
        if ("type" in block && (block.type === "image" || block.type === "localImage"))
          return ["[Image in Codex]"];
        return [];
      })
      .join("\n");
  return "";
}

export function codexItemEvents(input: {
  threadId: ThreadId;
  turnId: string;
  item: Record<string, unknown>;
  at: number;
  ordinal: number;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { item, threadId } = input;
  if (typeof item.id !== "string") return [];
  const prefix = `codex-shared:${threadId}:${input.turnId}:${item.id}`;
  const revision = codexHistoryFingerprint(item);
  const at = DateTime.makeUnsafe(input.at);
  const driver = ProviderDriverKind.make("codex");
  const messageId = MessageId.make(prefix);
  const events: OrchestrationV2DomainEvent[] = [];
  const base = {
    id: TurnItemId.make(prefix),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: { driver, nativeId: item.id, strength: "strong" as const },
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  let payload: OrchestrationV2TurnItem | undefined;
  if (item.type === "userMessage" || item.type === "agentMessage") {
    const text = codexItemText(item);
    if (!text) return [];
    const role = item.type === "userMessage" ? "user" : "assistant";
    events.push({
      id: EventId.make(`${prefix}:message:${revision}`),
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
        attachments: [],
        streaming: false,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: "provider",
        createdAt: at,
        updatedAt: at,
      },
    });
    payload =
      role === "user"
        ? {
            ...base,
            type: "user_message",
            messageId,
            text,
            attachments: [],
            createdBy: "user",
            creationSource: "provider",
            inputIntent: "turn_start",
          }
        : {
            ...base,
            type: "assistant_message",
            messageId,
            text,
            attachments: [],
            streaming: false,
          };
  } else if (item.type === "reasoning") {
    const text = [item.summary, item.content]
      .flatMap((parts) =>
        Array.isArray(parts) ? parts.filter((x): x is string => typeof x === "string") : [],
      )
      .join("\n");
    if (text) payload = { ...base, type: "reasoning", text, streaming: false };
  } else if (item.type === "contextCompaction") {
    payload = { ...base, type: "compaction", driver, summary: "Codex context compacted" };
  } else if (
    ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(
      String(item.type),
    )
  ) {
    payload = {
      ...base,
      type: "command_execution",
      input:
        typeof item.command === "string"
          ? item.command
          : `${String(item.type)} ${JSON.stringify(item.arguments ?? item.changes ?? item.query ?? item.tool ?? {})}`,
      output:
        typeof item.aggregatedOutput === "string"
          ? item.aggregatedOutput
          : JSON.stringify(item.result ?? item.output ?? item.contentItems ?? ""),
      outputIndicatesFailure:
        item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0),
    };
  }
  if (payload)
    events.push({
      id: EventId.make(`${prefix}:item:${revision}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload,
    });
  return events;
}
