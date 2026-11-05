import {
  ChatAttachmentId,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { PiWebClient } from "@t3tools/provider-pi/server/piWebClient";
import { PiSettings } from "@t3tools/provider-pi/settings";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import {
  contentBlocks,
  nativeText,
  SharedCatalog,
  SharedPage,
  sharedEntryEvents,
} from "./piSharedProjection.ts";

const CursorState = Schema.Record(
  Schema.String,
  Schema.Struct({
    cursor: Schema.NullOr(Schema.String),
    modified: Schema.String,
    title: Schema.optionalKey(Schema.String),
    migrated: Schema.optionalKey(Schema.Boolean),
    legacyRun: Schema.optionalKey(Schema.NullOr(Schema.String)),
    legacyEntryIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const PI_DRIVER = ProviderDriverKind.make("pi");
const decodePage = Schema.decodeUnknownEffect(SharedPage);
const decodeCatalog = Schema.decodeUnknownEffect(SharedCatalog);
const decodeSettings = Schema.decodeOption(PiSettings);
const encodeCursors = Schema.encodeSync(Schema.fromJsonString(CursorState));
const decodeCursors = Schema.decodeUnknownEffect(Schema.fromJsonString(CursorState));
class PiSharedSyncError extends Schema.TaggedError<PiSharedSyncError>()("PiSharedSyncError", {
  detail: Schema.String,
}) {}

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
  const fetch = yield* FetchHttpClient.Fetch;
  const secrets = yield* SecretResolver.SecretResolver;
  const cursorFile = path.join(config.stateDir, "pi-shared-cursors.json");
  let cursors: typeof CursorState.Type = {};
  let loaded = false;

  const syncSession = Effect.fn("PiSharedSessions.syncSession")(function* (
    client: PiWebClient,
    instanceId: ProviderInstanceId,
    session: (typeof SharedCatalog.Type.sessions)[number],
    active: boolean,
  ) {
    const key = `${instanceId}:${session.id}`;
    const checkpoint = cursors[key];
    const title = (session.name || session.firstMessage || "Pi session").slice(0, 200);
    if (checkpoint?.modified === session.modified && checkpoint.title === title && !active) return;
    const owners = yield* sql<{ thread_id: string }>`SELECT thread_id
      FROM orchestration_v2_projection_provider_threads
      WHERE driver = 'pi' AND provider_instance_id = ${instanceId}
      AND json_extract(payload_json, '$.nativeThreadRef.nativeId') IN (${session.path}, ${session.id}) LIMIT 1`;
    const threadId = ThreadId.make(owners[0]?.thread_id ?? `import:${instanceId}:${session.id}`);
    const existing = yield* Effect.option(projections.getThread(threadId));
    if (Option.isSome(existing) && existing.value.deletedAt !== null) return;
    if (Option.isSome(existing) && checkpoint?.title !== title && existing.value.title !== title) {
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: DateTime.nowUnsafe(),
            payload: { ...existing.value, title },
          },
        ],
      });
    }
    if (Option.isNone(existing)) {
      const found = yield* projects.getByWorkspaceRoot(session.cwd, {
        allowMissingWorkspaceRoot: true,
      });
      const project = Option.isSome(found)
        ? found.value
        : yield* projects.create({
            commandId: CommandId.make(`pi-shared:project:${session.cwd}`),
            projectId: ProjectId.make(`pi-shared:${session.cwd}`),
            title: path.basename(session.cwd) || session.cwd,
            workspaceRoot: session.cwd,
            allowMissingWorkspaceRoot: true,
          });
      const createdAt = DateTime.makeUnsafe(session.created);
      const updatedAt = DateTime.makeUnsafe(session.modified);
      const providerThreadId = ids.derive.providerThread({
        driver: PI_DRIVER,
        providerInstanceId: instanceId,
        nativeThreadId: session.path,
      });
      const thread: OrchestrationV2AppThread = {
        createdBy: "system",
        creationSource: "server",
        id: threadId,
        projectId: project.id,
        title,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: DEFAULT_MODEL_BY_PROVIDER[PI_DRIVER] ?? "default" },
        runtimeMode: "full-access",
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
        archivedAt: null,
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
        driver: PI_DRIVER,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: PI_DRIVER, nativeId: session.path, strength: "strong" },
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
            id: EventId.make(`pi-shared:create:${threadId}`),
            type: "thread.created",
            threadId,
            occurredAt: createdAt,
            payload: thread,
          },
          {
            id: EventId.make(`pi-shared:provider:${threadId}`),
            type: "provider-thread.updated",
            threadId,
            occurredAt: createdAt,
            payload: providerThread,
          },
        ],
      });
      if (committed.length === 0) return;
    }
    const legacy =
      !checkpoint?.migrated && Option.isSome(existing)
        ? yield* projections.getThreadRecords(threadId, [
            "messages",
            "turnItems",
            "providerTurns",
            "attempts",
          ])
        : { messages: [], turnItems: [], providerTurns: [], attempts: [] };
    const nativeRuns = new Map(
      legacy.providerTurns.flatMap((turn) => {
        const runId = legacy.attempts.find((attempt) => attempt.id === turn.runAttemptId)?.runId;
        return turn.nativeTurnRef?.strength === "strong" && runId
          ? [[turn.nativeTurnRef.nativeId, runId] as const]
          : [];
      }),
    );
    let legacyRun = checkpoint?.legacyRun ?? null;
    const legacyEntryIds = new Set(checkpoint?.legacyEntryIds ?? []);
    let cursor = checkpoint?.cursor ?? null;
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
      const raw = yield* Effect.tryPromise((signal) =>
        client.entries(session.id, cursor ?? undefined, signal),
      );
      const page = yield* decodePage(raw);
      if (page.sessionId !== session.id || page.filePath !== session.path)
        return yield* new PiSharedSyncError({ detail: "Pi session identity changed" });
      let ordinal = yield* projections.getNextTurnItemOrdinal(threadId);
      const pageEvents: OrchestrationV2DomainEvent[] = [];
      for (const entry of page.entries) {
        if (entry.message?.role === "user") legacyRun = nativeRuns.get(entry.id) ?? null;
        const linked = page.clientMessageIds[entry.id];
        const local = linked
          ? yield* projections.getMessagesById(threadId, [MessageId.make(linked)])
          : new Map();
        const ownedMessageIds = new Set(
          legacy.turnItems.flatMap((item) =>
            item.runId === legacyRun && "messageId" in item ? [item.messageId] : [],
          ),
        );
        const matches = legacy.messages.filter(
          (message) =>
            message.role === entry.message?.role &&
            message.text.trim() === nativeText(entry).trim() &&
            ((legacyRun !== null &&
              (message.runId === legacyRun || ownedMessageIds.has(message.id))) ||
              DateTime.toEpochMillis(message.createdAt) ===
                DateTime.toEpochMillis(DateTime.makeUnsafe(entry.timestamp))),
        );
        if (matches.length === 1) legacyEntryIds.add(entry.id);
        const omitMessage = local.size > 0 || legacyEntryIds.has(entry.id);
        const attachments: ChatAttachment[] = [];
        if (!omitMessage)
          for (const [index, block] of contentBlocks(entry.message?.content).entries()) {
            if (
              block.type !== "image" ||
              typeof block.data !== "string" ||
              typeof block.mimeType !== "string"
            )
              continue;
            const id = createDeterministicAttachmentId(threadId, `${entry.id}:${index}`);
            if (!id) continue;
            const bytes = Buffer.from(block.data, "base64");
            const attachment: ChatAttachment = {
              type: "image",
              id: ChatAttachmentId.make(id),
              name: `pi-${entry.id}-${index}`,
              mimeType: block.mimeType,
              sizeBytes: bytes.length,
            };
            const relative = attachmentRelativePath(attachment);
            if (relative) {
              yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
              yield* fs.writeFile(path.join(config.attachmentsDir, relative), bytes);
              attachments.push(attachment);
            }
          }
        const events = sharedEntryEvents({ threadId, entry, ordinal, attachments, omitMessage });
        pageEvents.push(...events);
        ordinal += events.filter((event) => event.type === "turn-item.updated").length;
      }
      const existingIds = yield* sql<{ id: string }>`
        SELECT message_id AS id FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId} AND ${sql.in(
          "message_id",
          pageEvents
            .filter((event) => event.type === "message.updated")
            .map((event) => event.payload.id),
        )}
        UNION ALL
        SELECT turn_item_id AS id FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND ${sql.in(
          "turn_item_id",
          pageEvents
            .filter((event) => event.type === "turn-item.updated")
            .map((event) => event.payload.id),
        )}`;
      const committedIds = new Set(existingIds.map((row) => row.id));
      const freshEvents = pageEvents.filter(
        (event) =>
          (event.type === "message.updated" || event.type === "turn-item.updated") &&
          !committedIds.has(event.payload.id),
      );
      yield* sql.withTransaction(
        Effect.forEach(
          freshEvents,
          (event) =>
            event.type === "turn-item.updated"
              ? positions
                  .allocate({
                    threadId,
                    turnItemId: event.payload.id,
                    runId: null,
                    runOrdinal: Math.floor(event.payload.ordinal / 1_000_000),
                  })
                  .pipe(Effect.asVoid)
              : Effect.void,
          { discard: true },
        ),
      );
      if (freshEvents.length) yield* sink.write({ events: freshEvents });
      cursor = page.nextCursor;
      // Commit the cursor only after all page events; stable native IDs make replay idempotent.
      Object.assign(cursors, {
        [key]: {
          cursor,
          modified: page.hasMore ? "" : session.modified,
          title,
          migrated: !page.hasMore,
          legacyRun,
          legacyEntryIds: [...legacyEntryIds],
        },
      });
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(`${cursorFile}.tmp`, encodeCursors(cursors));
      yield* fs.rename(`${cursorFile}.tmp`, cursorFile);
      if (!page.hasMore) break;
    }
    const at = DateTime.makeUnsafe(session.created);
    if (
      yield* projections.getTurnItem({
        threadId,
        itemId: TurnItemId.make(`pi-shared:permissions:${threadId}`),
      })
    )
      return;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`pi-shared:permissions:${threadId}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload: {
            id: TurnItemId.make(`pi-shared:permissions:${threadId}`),
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
              "Shared with Pi Web. Tool permissions are controlled by Pi Web. Messages from either client continue the same Pi session.",
          },
        },
      ],
    });
  });

  const syncOnce = Effect.fn("PiSharedSessions.syncOnce")(function* () {
    if (!loaded) {
      if (yield* fs.exists(cursorFile))
        cursors = yield* fs.readFileString(cursorFile).pipe(Effect.flatMap(decodeCursors));
      loaded = true;
    }
    const current = yield* settings.getSettings;
    for (const [key, instance] of Object.entries(current.providerInstances)) {
      if (instance.driver !== "pi" || instance.enabled === false) continue;
      const decoded = decodeSettings(instance.config ?? {});
      if (Option.isNone(decoded) || !decoded.value.sharedBackendUrl) continue;
      yield* Effect.gen(function* () {
        const secret = instance.environment?.find(
          (variable) => variable.name === "PI_WEB_PASSWORD",
        )?.value;
        const password =
          typeof secret === "string"
            ? secret
            : secret
              ? (yield* secrets.read([secret]))[0]
              : undefined;
        if (secret && password === undefined)
          return yield* new PiSharedSyncError({ detail: "Pi Web password is unavailable" });
        const client = yield* Effect.try(
          () => new PiWebClient(decoded.value.sharedBackendUrl!, fetch, password),
        );
        const catalog = yield* Effect.tryPromise((signal) => client.listSessions(signal)).pipe(
          Effect.flatMap(decodeCatalog),
        );
        const running = yield* Effect.tryPromise((signal) => client.running(signal));
        const active = new Set(
          Array.isArray(running.runningSessionIds) ? running.runningSessionIds : [],
        );
        for (const session of catalog.sessions)
          yield* syncSession(
            client,
            ProviderInstanceId.make(key),
            session,
            active.has(session.id),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Pi shared session sync failed", { sessionId: session.id, cause }),
            ),
          );
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Pi shared backend sync failed", { instanceId: key, cause }),
        ),
      );
    }
  });
  return { syncOnce };
});

export class PiSharedSessions extends Context.Service<
  PiSharedSessions,
  Effect.Success<typeof make>
>()("t3/project/PiSharedSessions") {}
export const layer = Layer.effect(PiSharedSessions, make);
export const worker = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* PiSharedSessions;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("pi-shared-sessions", sync.syncOnce());
  }),
);
