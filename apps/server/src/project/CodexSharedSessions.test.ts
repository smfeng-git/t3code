import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as CodexSharedSessions from "./CodexSharedSessions.ts";
import * as CodexHistorySource from "./CodexHistorySource.ts";

const timestamp = "2026-11-04T10:00:00.000Z";
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
it.effect(
  "discovers every directory, follows new messages, and survives cursor replay without duplicates",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-shared-test-" });
      const configContext = yield* Layer.build(ServerConfig.layerTest(root, root));
      const config = Context.get(configContext, ServerConfig);
      const sessions = ["one", "two"].map((id) => ({
        id,
        cwd: `/${id}`,
        name: id,
        preview: id,
        createdAt: 1700000000,
        updatedAt: 1700000000,
      }));
      const records = new Map(
        sessions.map((session) => [
          session.id,
          [
            {
              id: `${session.id}-turn`,
              status: "completed",
              startedAt: 1700000000,
              items: [
                {
                  id: `${session.id}-u`,
                  type: "userMessage",
                  content: [{ type: "text", text: `hello ${session.id}` }],
                },
              ],
            },
          ],
        ]),
      );
      const projectRoots: string[] = [];
      const dependencies = Layer.mergeAll(
        Layer.succeed(ServerConfig, config),
        Layer.mock(CodexHistorySource.CodexHistorySource)({
          sessions: () => Effect.succeed(sessions),
          turns: (_instance, id) => Effect.succeed(records.get(id) ?? []),
        }),
        Layer.mock(SecretResolver.SecretResolver)({ read: () => Effect.succeed([]) }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              codex: { driver: "codex", enabled: true, config: { syncSessions: true } },
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
        Layer.build(Layer.fresh(CodexSharedSessions.layer).pipe(Layer.provide(dependencies)));
      const sync = Context.get(yield* makeSync(), CodexSharedSessions.CodexSharedSessions);
      yield* sync.syncOnce();
      expect(projectRoots).toEqual(["/one", "/two"]);
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const firstId = ThreadId.make("import:codex:one");
      expect((yield* projection.getThreadRecords(firstId, ["messages"])).messages).toHaveLength(1);
      records.get("one")!.push({
        id: "second-turn",
        status: "completed",
        startedAt: 1700000060,
        items: [
          { id: "one-a", type: "userMessage", content: [{ type: "text", text: "new answer" }] },
        ],
      });
      sessions[0]!.updatedAt = 1700000060;
      yield* sync.syncOnce();
      expect((yield* projection.getThreadRecords(firstId, ["messages"])).messages).toHaveLength(2);
      const restarted = Context.get(yield* makeSync(), CodexSharedSessions.CodexSharedSessions);
      yield* restarted.syncOnce();
      expect((yield* projection.getThreadRecords(firstId, ["messages"])).messages).toHaveLength(2);
      yield* fs.remove(`${config.stateDir}/codex-shared-cursors.json`);
      const eventStore = yield* EventStore.EventStoreV2;
      const beforeReplay = yield* eventStore.latestSequence();
      const replay = Context.get(yield* makeSync(), CodexSharedSessions.CodexSharedSessions);
      yield* replay.syncOnce();
      expect(yield* eventStore.latestSequence()).toBe(beforeReplay);
      expect((yield* projection.getThreadRecords(firstId, ["messages"])).messages).toHaveLength(2);
      expect((yield* projection.getThread(firstId)).projectId).toBe(
        ProjectId.make("codex-shared:/one"),
      );
      sessions.push({
        id: "three",
        cwd: "/three",
        name: "three",
        preview: "three",
        createdAt: 1700000000,
        updatedAt: 1700000000,
      });
      records.set("three", [
        {
          id: "third-turn",
          status: "completed",
          startedAt: 1700000000,
          items: [
            {
              id: "three-u",
              type: "userMessage",
              content: [{ type: "text", text: "new directory" }],
            },
          ],
        },
      ]);
      yield* replay.syncOnce();
      expect(projectRoots).toEqual(["/one", "/two", "/three"]);
      expect(
        (yield* projection.getThreadRecords(ThreadId.make("import:codex:three"), ["messages"]))
          .messages,
      ).toHaveLength(1);
      const pending = {
        id: "pending-turn",
        status: "inProgress",
        startedAt: 1700000100,
        items: [
          {
            id: "pending-item",
            type: "userMessage",
            content: [{ type: "text", text: "late completion" }],
          },
        ],
      };
      records.get("three")!.push(pending);
      yield* replay.syncOnce();
      expect(
        (yield* projection.getThreadRecords(ThreadId.make("import:codex:three"), ["messages"]))
          .messages,
      ).toHaveLength(1);
      pending.status = "completed";
      yield* replay.syncOnce();
      expect(
        (yield* projection.getThreadRecords(ThreadId.make("import:codex:three"), ["messages"]))
          .messages,
      ).toHaveLength(2);
      for (const text of ["corrected", "late completion", "corrected"]) {
        pending.items[0]!.content[0]!.text = text;
        yield* replay.syncOnce();
        const messages = (yield* projection.getThreadRecords(ThreadId.make("import:codex:three"), [
          "messages",
        ])).messages;
        expect(messages).toHaveLength(2);
        expect(messages.some((message) => message.text === text)).toBe(true);
      }
    }).pipe(Effect.provide(Layer.provideMerge(persistence, NodeServices.layer)), Effect.scoped),
);
