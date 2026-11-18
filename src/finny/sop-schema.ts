import { Type } from "typebox";

const text = () => Type.String({ minLength: 1, pattern: "\\S" });

const input = Type.Object(
  {
    id: text(),
    label: text(),
    from: Type.Union([Type.Literal("human"), Type.Literal("system")]),
    type: Type.Union([
      Type.Literal("date"),
      Type.Literal("text"),
      Type.Literal("currency"),
      Type.Literal("entity"),
      Type.Literal("boolean"),
    ]),
    required: Type.Boolean(),
    material: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const FINNY_SOP_SCHEMA = Type.Object(
  {
    schema: Type.Literal("finny.sop.v1"),
    id: text(),
    version: Type.Integer({ minimum: 1 }),
    scopeId: text(),
    title: text(),
    intent: Type.Object(
      {
        domain: Type.Union([Type.Literal("ap"), Type.Literal("ar"), Type.Literal("gl"), Type.Literal("close")]),
        description: text(),
        searchTerms: Type.Array(text()),
      },
      { additionalProperties: false },
    ),
    objective: text(),
    inputs: Type.Array(input),
    sources: Type.Array(
      Type.Object(
        {
          id: text(),
          system: text(),
          object: text(),
          fields: Type.Array(text()),
          filter: text(),
          asOfInput: Type.Optional(text()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    steps: Type.Array(
      Type.Object(
        { id: text(), action: text(), reads: Type.Array(text()), writes: text() },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    controls: Type.Array(
      Type.Object(
        {
          id: text(),
          assertion: text(),
          tolerance: Type.Optional(text()),
          evidenceRefs: Type.Array(text()),
          judgment: Type.Optional(Type.Object({ question: text(), onlyWhen: text() }, { additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    outputs: Type.Array(
      Type.Object(
        {
          id: text(),
          kind: Type.Union([Type.Literal("xlsx"), Type.Literal("summary"), Type.Literal("app")]),
          contract: Type.Record(Type.String(), Type.Unknown()),
          rerun: Type.Optional(Type.Object({ inputIds: Type.Array(text()) }, { additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
    approval: Type.Object({ required: Type.Boolean(), destination: text() }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const FINNY_SOP_VALUES_SCHEMA = Type.Record(
  Type.String({ minLength: 1 }),
  Type.Union([text(), Type.Boolean()]),
);
