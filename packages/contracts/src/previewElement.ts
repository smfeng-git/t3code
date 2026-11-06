import * as Schema from "effect/Schema";
import { ElementContextDetails } from "./composerContext.ts";

const PreviewElementCandidate = Schema.Struct({
  element: ElementContextDetails,
  rect: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
});

export const PreviewElementSelection = Schema.Struct({
  ...PreviewElementCandidate.fields,
  ancestors: Schema.optional(Schema.Array(PreviewElementCandidate).check(Schema.isMaxLength(6))),
  viewport: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
  screenshot: Schema.String,
});
export type PreviewElementSelection = typeof PreviewElementSelection.Type;

export const PreviewElementPick = Schema.Struct({
  type: Schema.Literal("pickElement"),
  requestId: Schema.String.check(Schema.isMaxLength(100)),
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
  pageUrl: Schema.String.check(Schema.isMaxLength(8_192)),
});
export type PreviewElementPick = typeof PreviewElementPick.Type;

export const PreviewElementPickResult = Schema.Struct({
  type: Schema.Literal("elementPicked"),
  requestId: Schema.String,
  selection: Schema.NullOr(PreviewElementSelection),
  error: Schema.NullOr(Schema.String),
});
export type PreviewElementPickResult = typeof PreviewElementPickResult.Type;
