import { expect, it } from "@effect/vitest";
import { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { codexItemEvents } from "./codexSharedProjection.ts";

const isEvent = Schema.is(OrchestrationV2DomainEvent);

it("preserves native item identity and projects changes without appending a second message", () => {
  const input = {
    threadId: ThreadId.make("thread"),
    turnId: "turn",
    at: 1700000000000,
    ordinal: 1,
  };
  const first = codexItemEvents({
    ...input,
    item: { id: "native", type: "agentMessage", text: "first" },
  });
  const changed = codexItemEvents({
    ...input,
    item: { id: "native", type: "agentMessage", text: "finished" },
  });
  expect(first[0]?.type === "message.updated" && first[0].payload.id).toBe(
    changed[0]?.type === "message.updated" && changed[0].payload.id,
  );
  expect(first[0]?.id).not.toBe(changed[0]?.id);
  for (const event of [...first, ...changed]) expect(isEvent(event)).toBe(true);
});

it("retains user text, reasoning and tool results", () => {
  const input = {
    threadId: ThreadId.make("thread"),
    turnId: "turn",
    at: 1700000000000,
    ordinal: 1,
  };
  const user = codexItemEvents({
    ...input,
    item: { id: "u", type: "userMessage", content: [{ type: "text", text: "hello" }] },
  });
  expect(user[0]?.type === "message.updated" && user[0].payload.text).toBe("hello");
  for (const item of [
    { id: "r", type: "reasoning", summary: ["checking"] },
    { id: "c", type: "commandExecution", command: "test", aggregatedOutput: "passed", exitCode: 0 },
  ])
    for (const event of codexItemEvents({ ...input, item })) expect(isEvent(event)).toBe(true);
});
