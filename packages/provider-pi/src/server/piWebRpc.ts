import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { PiWebClient } from "./piWebClient.ts";
import { PiRpcError, type PiRpcConnection, type PiRpcRecord } from "./rpc.ts";

function sessionIdFromPath(path: string) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i.exec(
    path,
  );
  if (!match) throw new Error("Pi Web requires a native session id or session file path");
  return match[1]!;
}

export const makePiWebRpcConnection = Effect.fn("PiWebRpc.connect")(function* (options: {
  readonly url: string;
  readonly cwd: string;
  readonly password?: string;
  readonly initialNativeThreadId?: string;
}) {
  const fetch = yield* FetchHttpClient.Fetch;
  const client = new PiWebClient(options.url, fetch, options.password);
  const scope = yield* Effect.scope;
  const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
  const exited = yield* Deferred.make<number>();
  let sessionId = options.initialNativeThreadId
    ? sessionIdFromPath(options.initialNativeThreadId)
    : undefined;
  let subscription: Fiber.Fiber<void, PiRpcError> | undefined;
  let closed = false;
  const invoke = Effect.fn("PiWebRpc.invoke")(function* (record: PiRpcRecord) {
    return yield* Effect.tryPromise({
      try: async (signal) => {
        if (closed) throw new Error("Pi Web connection is closed");
        if (record.type === "switch_session") {
          sessionId = sessionIdFromPath(String(record.sessionPath));
          return { cancelled: false };
        }
        if (record.type === "new_session") sessionId = undefined;
        if (!sessionId) {
          const created = await client.createSession(options.cwd, signal);
          if (typeof created.sessionId !== "string")
            throw new Error("Pi Web returned no session id");
          sessionId = created.sessionId;
        }
        if (record.type === "new_session") return { cancelled: false };
        return client.command(sessionId, record, signal);
      },
      catch: (cause) => new PiRpcError({ operation: String(record.type), cause }),
    });
  });
  const attach = Effect.fn("PiWebRpc.attach")(function* () {
    if (!sessionId || closed) return;
    if (subscription) yield* Fiber.interrupt(subscription);
    const attachedId = sessionId;
    const listen = Effect.tryPromise({
      try: async (signal) => {
        for await (const event of client.events(attachedId, signal)) {
          if (event.type === "connected") {
            Queue.offerUnsafe(events, {
              type: event.isStreaming ? "agent_start" : "agent_settled",
            });
          } else if (
            event.type === "agent_start" ||
            event.type === "agent_settled" ||
            event.type === "extension_ui_request" ||
            event.type === "extension_error" ||
            (event.type === "message_end" &&
              typeof event.message === "object" &&
              event.message !== null &&
              "stopReason" in event.message &&
              event.message.stopReason === "error")
          ) {
            Queue.offerUnsafe(events, event);
          }
        }
      },
      catch: (cause) => new PiRpcError({ operation: "subscribe", cause }),
    });
    subscription = yield* listen.pipe(
      Effect.retry(Schedule.spaced("1 second")),
      Effect.forkIn(scope),
    );
  });
  const terminate = Effect.gen(function* () {
    closed = true;
    if (subscription) yield* Fiber.interrupt(subscription);
    yield* Deferred.succeed(exited, 0);
  });
  yield* Effect.addFinalizer(() => terminate);
  return {
    events,
    exited: Deferred.await(exited),
    terminate,
    attach,
    request: invoke,
    send: Effect.fn("PiWebRpc.send")(function* (record: PiRpcRecord) {
      const data = yield* invoke(record);
      yield* Queue.offer(events, { type: "response", command: record.type, success: true, data });
    }),
  } satisfies PiRpcConnection & { readonly attach: () => Effect.Effect<void> };
});
