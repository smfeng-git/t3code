import { CodexSettings, type ProviderInstanceId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import * as ServerSettings from "../serverSettings.ts";

const Session = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  preview: Schema.String,
  archived: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Catalog = Schema.Struct({
  data: Schema.Array(Session),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Turn = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  completedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
const Turns = Schema.Struct({
  data: Schema.Array(Turn),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CodexHistorySession = typeof Session.Type;
export type CodexHistoryTurn = typeof Turn.Type;
export class CodexHistoryError extends Schema.TaggedError<CodexHistoryError>()(
  "CodexHistoryError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
export class CodexHistorySource extends Context.Service<
  CodexHistorySource,
  {
    readonly sessions: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<CodexHistorySession>, CodexHistoryError>;
    readonly turns: (
      instanceId: ProviderInstanceId,
      threadId: string,
      afterTurn?: string,
    ) => Effect.Effect<ReadonlyArray<CodexHistoryTurn>, CodexHistoryError>;
  }
>()("t3/project/CodexHistorySource") {}

const decodeSettings = Schema.decodeEffect(CodexSettings);
const encodeKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const layer = Layer.effect(
  CodexHistorySource,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* SecretResolver.SecretResolver;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const parent = yield* Effect.scope;
    const clients = new Map<
      string,
      { key: string; scope: Scope.Closeable; client: CodexClient.CodexAppServerClient["Service"] }
    >();
    const open = Effect.fn("CodexHistorySource.open")(function* (id: ProviderInstanceId) {
      const instance = (yield* settings.getSettings).providerInstances[id];
      if (!instance || instance.driver !== "codex")
        return yield* new CodexHistoryError({ detail: "Codex instance unavailable" });
      const config = yield* decodeSettings(instance.config ?? {});
      if (config.setupMode === "managed")
        return yield* new CodexHistoryError({
          detail: "History synchronization requires an existing local Codex installation",
        });
      const environment: NodeJS.ProcessEnv = {};
      for (const variable of instance.environment ?? []) {
        const value =
          typeof variable.value === "string"
            ? variable.value
            : (yield* secrets.read([variable.value]))[0];
        if (value === undefined)
          return yield* new CodexHistoryError({ detail: "Codex environment variable unavailable" });
        environment[variable.name] = value;
      }
      const key = yield* encodeKey([config, environment]);
      const previous = clients.get(id);
      if (previous && previous.key === key) return previous.client;
      if (previous) {
        yield* Scope.close(previous.scope, Exit.void);
        clients.delete(id);
      }
      const scope = yield* Scope.fork(parent, "sequential");
      const opened = yield* withCodexAppServerClient({
        binaryPath: config.binaryPath,
        homePath: config.shadowHomePath || config.homePath,
        launchArgs: config.launchArgs,
        cwd: process.cwd(),
        environment,
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeout("20 seconds"),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      clients.set(id, { key, scope, client: opened.client });
      return opened.client;
    });
    const request = Effect.fn("CodexHistorySource.request")(
      function* (id: ProviderInstanceId, method: string, params: unknown) {
        const client = yield* open(id);
        return yield* client.raw.request(method, params).pipe(Effect.timeout("30 seconds"));
      },
      Effect.catch((cause) =>
        Effect.gen(function* () {
          // Discard terminated transports; the next scheduled pass reconnects without taking a writer lock.
          for (const entry of clients.values()) yield* Scope.close(entry.scope, Exit.void);
          clients.clear();
          return yield* new CodexHistoryError({ detail: String(cause) });
        }),
      ),
    );
    return CodexHistorySource.of({
      sessions: Effect.fn("CodexHistorySource.sessions")(
        function* (id) {
          const sessions: CodexHistorySession[] = [];
          for (const archived of [false, true]) {
            let cursor: string | null = null;
            do {
              const page: typeof Catalog.Type = yield* request(id, "thread/list", {
                cursor,
                limit: 100,
                archived,
                useStateDbOnly: true,
                sortKey: "updated_at",
                modelProviders: [],
                sourceKinds: [
                  "cli",
                  "vscode",
                  "exec",
                  "appServer",
                  "subAgent",
                  "subAgentReview",
                  "subAgentCompact",
                  "subAgentThreadSpawn",
                  "subAgentOther",
                  "unknown",
                ],
              }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
              sessions.push(...page.data.map((session) => ({ ...session, archived })));
              cursor = page.nextCursor ?? null;
            } while (cursor);
          }
          return sessions;
        },
        Effect.mapError((cause) => new CodexHistoryError({ detail: String(cause) })),
      ),
      turns: Effect.fn("CodexHistorySource.turns")(
        function* (id, threadId, afterTurn) {
          const turns: CodexHistoryTurn[] = [];
          let cursor: string | null = null;
          do {
            const page: typeof Turns.Type = yield* request(id, "thread/turns/list", {
              threadId,
              cursor,
              limit: 20,
              sortDirection: "desc",
              itemsView: "full",
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Turns)));
            turns.push(...page.data);
            if (afterTurn && page.data.some((turn) => turn.id === afterTurn)) break;
            cursor = page.nextCursor ?? null;
          } while (cursor);
          return turns.reverse();
        },
        Effect.mapError((cause) => new CodexHistoryError({ detail: String(cause) })),
      ),
    });
  }),
);
