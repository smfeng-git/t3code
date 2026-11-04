import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CodexSettings,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as CodexHistorySource from "./CodexHistorySource.ts";
import {
  codexHistoryFingerprint,
  codexItemEvents,
  codexItemText,
} from "./codexSharedProjection.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const Checkpoints = Schema.Record(
  Schema.String,
  Schema.Struct({
    turn: Schema.optionalKey(Schema.String),
    modified: Schema.Number,
    legacy: Schema.optionalKey(Schema.Array(Schema.String)),
    pending: Schema.optionalKey(Schema.Boolean),
    signature: Schema.optionalKey(Schema.String),
  }),
);
const encodeCheckpoints = Schema.encodeEffect(Schema.fromJsonString(Checkpoints));
const decodeSettings = Schema.decodeEffect(CodexSettings);
const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const source = yield* CodexHistorySource.CodexHistorySource;
  const cursorFile = path.join(config.stateDir, "codex-shared-cursors.json");
  let checkpoints: typeof Checkpoints.Type = {};
  let loaded = false;
  const syncSession = Effect.fn("CodexSharedSessions.syncSession")(function* (
    instanceId: ProviderInstanceId,
    session: CodexHistorySource.CodexHistorySession,
  ) {
    const current = yield* settings.getSettings;
    const key = `${instanceId}:${session.id}`;
    const checkpoint = checkpoints[key];
    const owners = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE driver = 'codex' AND provider_instance_id = ${instanceId} AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${session.id} LIMIT 1`;
    const threadId = ThreadId.make(owners[0]?.thread_id ?? `import:${instanceId}:${session.id}`);
    const existing = yield* Effect.option(projections.getThread(threadId));
    if (Option.isSome(existing) && existing.value.deletedAt !== null) return;
    const turns = yield* source.turns(instanceId, session.id, checkpoint?.turn);
    const signature = codexHistoryFingerprint(turns);
    if (checkpoint?.signature === signature) return;
    if (Option.isNone(existing)) {
      const found = yield* projects.getByWorkspaceRoot(session.cwd, {
        allowMissingWorkspaceRoot: true,
      });
      const project = Option.isSome(found)
        ? found.value
        : yield* projects.create({
            commandId: CommandId.make(`codex-shared:project:${session.cwd}`),
            projectId: ProjectId.make(`codex-shared:${session.cwd}`),
            title: path.basename(session.cwd) || session.cwd,
            workspaceRoot: session.cwd,
            allowMissingWorkspaceRoot: true,
          });
      const createdAt = DateTime.makeUnsafe(session.createdAt * 1000);
      const updatedAt = DateTime.makeUnsafe(session.updatedAt * 1000);
      const providerThreadId = ids.derive.providerThread({
        driver: CODEX_DRIVER,
        providerInstanceId: instanceId,
        nativeThreadId: session.id,
      });
      const thread: OrchestrationV2AppThread = {
        createdBy: "system",
        creationSource: "server",
        id: threadId,
        projectId: project.id,
        title: (session.name || session.preview || "Codex session").slice(0, 200),
        providerInstanceId: instanceId,
        modelSelection: {
          instanceId,
          model: session.model ?? DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER] ?? "default",
        },
        runtimeMode:
          settings.managedPolicy?.limits?.maxRuntimeMode ??
          resolveProjectSettings(current, project.id, project).settings.defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        linkedPullRequest: null,
        branchPullRequest: null,
        activeProviderThreadId: providerThreadId,
        historyOrigin: "v1_import",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt,
        updatedAt,
        archivedAt: session.archived ? updatedAt : null,
        settledOverride: "settled",
        settledAt: updatedAt,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: CODEX_DRIVER,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: CODEX_DRIVER, nativeId: session.id, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt,
        updatedAt,
      };
      const committed = yield* sink.write({
        unlessNativeThreadOwned: providerThread,
        events: [
          {
            id: EventId.make(`codex-shared:create:${threadId}`),
            type: "thread.created",
            threadId,
            occurredAt: createdAt,
            payload: thread,
          },
          {
            id: EventId.make(`codex-shared:provider:${threadId}`),
            type: "provider-thread.updated",
            threadId,
            occurredAt: createdAt,
            payload: providerThread,
          },
        ],
      });
      if (committed.length === 0) return;
    }
    const records = yield* projections.getThreadRecords(threadId, [
      "messages",
      "turnItems",
      "providerTurns",
      "runs",
    ]);
    const noticeId = TurnItemId.make(`codex-shared:control:${threadId}`);
    if (!records.turnItems.some((item) => item.id === noticeId)) {
      const at = DateTime.makeUnsafe(session.createdAt * 1000);
      yield* sink.write({
        events: [
          {
            id: EventId.make(noticeId),
            type: "turn-item.updated",
            threadId,
            occurredAt: at,
            payload: {
              id: noticeId,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: null,
              startedAt: at,
              completedAt: at,
              updatedAt: at,
              type: "system_notice",
              message:
                "Following saved Codex messages. To continue here, first release this conversation in the other Codex client. T3 does not interrupt or take over an active conversation.",
            },
          },
        ],
      });
    }
    if (records.runs.some((run) => run.status === "running")) return;
    const ownedTurns = new Set(
      records.providerTurns.flatMap((turn) =>
        turn.nativeTurnRef?.strength === "strong" ? [turn.nativeTurnRef.nativeId] : [],
      ),
    );
    const ownedItems = new Set(
      records.turnItems.flatMap((item) =>
        item.nativeItemRef?.strength === "strong" && !item.id.startsWith("codex-shared:")
          ? [item.nativeItemRef.nativeId]
          : [],
      ),
    );
    const legacy = records.messages.filter(
      (message) => !message.id.startsWith("codex-shared:") && message.runId === null,
    );
    const matched = new Set<string>();
    const legacyItems = new Set(checkpoint?.legacy ?? []);
    let ordinal = yield* projections.getNextTurnItemOrdinal(threadId);
    let latest = checkpoint?.turn;
    for (const turn of turns) {
      if (turn.status === "inProgress") continue;
      const at = (turn.startedAt ?? session.createdAt) * 1000;
      const turnEvents: OrchestrationV2DomainEvent[] = [];
      if (!ownedTurns.has(turn.id))
        for (const item of turn.items) {
          if (ownedItems.has(String(item.id)) || legacyItems.has(`${turn.id}:${String(item.id)}`))
            continue;
          const role =
            item.type === "userMessage"
              ? "user"
              : item.type === "agentMessage"
                ? "assistant"
                : null;
          const text = codexItemText(item);
          const old = !checkpoint
            ? legacy.find(
                (message) =>
                  !matched.has(message.id) &&
                  message.role === role &&
                  message.text.trim() === text.trim() &&
                  DateTime.toEpochMillis(message.createdAt) >= at - 2000 &&
                  DateTime.toEpochMillis(message.createdAt) <=
                    (turn.completedAt ?? turn.startedAt ?? session.updatedAt) * 1000 + 2000,
              )
            : undefined;
          if (old) {
            matched.add(old.id);
            legacyItems.add(`${turn.id}:${String(item.id)}`);
            continue;
          }
          const events = codexItemEvents({ threadId, turnId: turn.id, item, at, ordinal });
          if (!events.length) continue;
          const fresh: OrchestrationV2DomainEvent[] = [];
          for (const event of events) {
            if (event.type !== "message.updated" && event.type !== "turn-item.updated") continue;
            const stored =
              event.type === "message.updated"
                ? records.messages.find((message) => message.id === event.payload.id)
                : records.turnItems.find((existingItem) => existingItem.id === event.payload.id);
            const payload =
              event.type === "turn-item.updated" && stored && "ordinal" in stored
                ? { ...event.payload, ordinal: stored.ordinal }
                : event.payload;
            if (
              stored &&
              Object.entries(payload).every(
                ([field, value]) =>
                  codexHistoryFingerprint(value) ===
                  codexHistoryFingerprint(Reflect.get(stored, field)),
              )
            )
              continue;
            const id = stored ? yield* ids.allocate.event({ threadId }) : event.id;
            if (event.type === "turn-item.updated") {
              const ordinalValue = stored && "ordinal" in stored ? stored.ordinal : ordinal++;
              if (!stored)
                yield* positions.allocate({
                  threadId,
                  turnItemId: event.payload.id,
                  runId: null,
                  runOrdinal: Math.floor(ordinalValue / 1000000),
                });
              fresh.push({ ...event, id, payload: { ...event.payload, ordinal: ordinalValue } });
            } else fresh.push({ ...event, id });
          }
          turnEvents.push(...fresh);
        }
      if (turnEvents.length) yield* sink.write({ events: turnEvents });
      latest = turn.id;
    }
    checkpoints = {
      ...checkpoints,
      [key]: {
        ...(latest ? { turn: latest } : {}),
        modified: session.updatedAt,
        legacy: [...legacyItems],
        pending: turns.some((turn) => turn.status === "inProgress"),
        signature,
      },
    };
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(`${cursorFile}.tmp`, yield* encodeCheckpoints(checkpoints));
    yield* fs.rename(`${cursorFile}.tmp`, cursorFile);
  });
  const syncOnce = Effect.fn("CodexSharedSessions.syncOnce")(function* () {
    if (!loaded) {
      if (yield* fs.exists(cursorFile))
        checkpoints = yield* fs
          .readFileString(cursorFile)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Checkpoints))));
      loaded = true;
    }
    const current = yield* settings.getSettings;
    for (const [id, instance] of Object.entries(current.providerInstances)) {
      if (
        instance.driver !== "codex" ||
        instance.enabled === false ||
        (yield* decodeSettings(instance.config ?? {})).syncSessions !== true
      )
        continue;
      const instanceId = ProviderInstanceId.make(id);
      yield* Effect.gen(function* () {
        const sessions = yield* source.sessions(instanceId);
        for (const [index, session] of sessions.entries()) {
          const checkpoint = checkpoints[`${id}:${session.id}`];
          if (index >= 20 && checkpoint?.modified === session.updatedAt && !checkpoint.pending)
            continue;
          yield* syncSession(instanceId, session).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Codex history sync failed", { sessionId: session.id, cause }),
            ),
          );
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Codex history catalog failed", { instanceId, cause }),
        ),
      );
    }
  });
  return { syncOnce };
});
export class CodexSharedSessions extends Context.Service<
  CodexSharedSessions,
  Effect.Success<typeof make>
>()("t3/project/CodexSharedSessions") {}
export const layer = Layer.effect(CodexSharedSessions, make);
export const worker = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* CodexSharedSessions;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("codex-shared-sessions", sync.syncOnce());
  }),
);
