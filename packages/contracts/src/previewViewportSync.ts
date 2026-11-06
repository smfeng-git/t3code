import * as Schema from "effect/Schema";
import { PreviewViewportSetting } from "./preview.ts";

export const PreviewViewportSync = Schema.Struct({
  type: Schema.Literal("viewport"),
  requestId: Schema.String.check(Schema.isMaxLength(100)),
  setting: PreviewViewportSetting,
});
export type PreviewViewportSync = typeof PreviewViewportSync.Type;

export const PreviewViewportSyncResult = Schema.Struct({
  type: Schema.Literal("viewportApplied"),
  requestId: Schema.String,
  image: Schema.NullOr(
    Schema.Struct({
      width: Schema.Number,
      height: Schema.Number,
      screenshot: Schema.String,
    }),
  ),
  error: Schema.NullOr(Schema.String),
});
export type PreviewViewportSyncResult = typeof PreviewViewportSyncResult.Type;
