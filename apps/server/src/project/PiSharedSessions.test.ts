import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ServerConfig } from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as PiSharedSessions from "./PiSharedSessions.ts";
import { sharedEntryEvents } from "./piSharedProjection.ts";

const timestamp = "2026-11-04T10:00:00.000Z";
const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);
const stores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  TurnItemPositionStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  IdAllocator.layer,
);
const native = (id: string, text: string, role = "user") => ({
  id,
  type: "message",
  timestamp,
  message: { role, content: [{ type: "text", text }] },
});

it("projects native IDs consistently and preserves reasoning and tool results", () => {
  const entry = native("native-1", "answer", "assistant");
  const first = sharedEntryEvents({ threadId: ThreadId.make("t"), entry, ordinal: 1 });
  const replay = sharedEntryEvents({ threadId: ThreadId.make("t"), entry, ordinal: 99 });
  expect(replay.map((event) => event.id)).toEqual(first.map((event) => event.id));
  for (const event of first) expect(isDomainEvent(event)).toBe(true);
  expect(
    sharedEntryEvents({ threadId: ThreadId.make("t"), entry, ordinal: 1, omitMessage: true }),
  ).toHaveLength(0);
  const work = sharedEntryEvents({
    threadId: ThreadId.make("t"),
    ordinal: 3,
    entry: {
      ...entry,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking" },
          { type: "toolCall", name: "read", arguments: { path: "file.ts" } },
        ],
      },
    },
  });
  expect(
    work.filter((event) => event.type === "turn-item.updated").map((event) => event.payload.type),
  ).toEqual(["reasoning", "command_execution"]);
  for (const event of work) expect(isDomainEvent(event)).toBe(true);
});

it.effect(
  "discovers every directory, follows new messages, and survives cursor replay without duplicates",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-shared-test-" });
      const configContext = yield* Layer.build(ServerConfig.layerTest(root, root));
      const config = Context.get(configContext, ServerConfig);
      const sessions = ["one", "two"].map((id) => ({
        id,
        path: `/${id}.jsonl`,
        cwd: `/${id}`,
        name: id,
        created: timestamp,
        modified: timestamp,
      }));
      const records = new Map(
        sessions.map((session) => [session.id, [native(`${session.id}-u`, `hello ${session.id}`)]]),
      );
      const fetch: typeof globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/sessions") return Response.json({ sessions });
        if (url.pathname === "/api/agent/running") return Response.json({ runningSessionIds: [] });
        const id = url.pathname.split("/")[3]!;
        const session = sessions.find((session) => session.id === id)!;
        const all = records.get(id)!;
        const after = url.searchParams.get("after");
        const offset = after ? all.findIndex((entry) => entry.id === after) + 1 : 0;
        return Response.json({
          sessionId: id,
          filePath: session.path,
          cwd: session.cwd,
          entries: all.slice(offset),
          clientMessageIds: {},
          reset: false,
          nextCursor: all.at(-1)?.id ?? null,
          hasMore: false,
        });
      };
      const projectRoots: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(ServerConfig, config),
        Layer.succeed(FetchHttpClient.Fetch, fetch),
        Layer.mock(SecretResolver.SecretResolver)({ read: () => Effect.succeed([]) }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              pi: { driver: "pi", enabled: true, config: { sharedBackendUrl: "http://pi.test" } },
            },
          }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getByWorkspaceRoot: () => Effect.succeedNone,
          create: (input) =>
            Effect.sync(() => {
              projectRoots.push(input.workspaceRoot);
              return {
                id: input.projectId,
                title: input.title,
                workspaceRoot: input.workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              };
            }),
        }),
      );
      const makeSync = () =>
        Layer.build(Layer.fresh(PiSharedSessions.layer).pipe(Layer.provide(dependencies)));
      const sync = Context.get(yield* makeSync(), PiSharedSessions.PiSharedSessions);
      yield* sync.syncOnce();
      expect(projectRoots).toEqual(["/one", "/two"]);
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const firstId = ThreadId.make("import:pi:one");
      expect((yield* projection.getThreadRecords(firstId, ["messages"])).messages).toHaveLength(1);
      records.get("one")!.push(native("one-a", "new answer", "assistant"));
      sessions[0]!.modified = "2026-11-04T10:01:00.000Z";
      yield* sync.syncOnce();
      expect((yield* projection.getThreadRecords(firstId, ["messages"])).messages).toHaveLength(2);
      const restarted = Context.get(yield* makeSync(), PiSharedSessions.PiSharedSessions);
      yield* restarted.syncOnce();
      expect((yield* projection.getThreadRecords(firstId, ["messages"])).messages).toHaveLength(2);
      yield* fs.remove(`${config.stateDir}/pi-shared-cursors.json`);
      const eventStore = yield* EventStore.EventStoreV2;
      const beforeReplay = yield* eventStore.latestSequence();
      const replay = Context.get(yield* makeSync(), PiSharedSessions.PiSharedSessions);
      yield* replay.syncOnce();
      expect(yield* eventStore.latestSequence()).toBe(beforeReplay);
      expect((yield* projection.getThreadRecords(firstId, ["messages"])).messages).toHaveLength(2);
      expect((yield* projection.getThread(firstId)).projectId).toBe(
        ProjectId.make("pi-shared:/one"),
      );
      sessions.push({
        id: "three",
        path: "/three.jsonl",
        cwd: "/three",
        name: "three",
        created: timestamp,
        modified: timestamp,
      });
      records.set("three", [native("three-u", "new directory after startup")]);
      yield* replay.syncOnce();
      expect(projectRoots).toEqual(["/one", "/two", "/three"]);
      expect(
        (yield* projection.getThreadRecords(ThreadId.make("import:pi:three"), ["messages"]))
          .messages,
      ).toHaveLength(1);
    }).pipe(Effect.provide(Layer.provideMerge(persistence, NodeServices.layer)), Effect.scoped),
);
