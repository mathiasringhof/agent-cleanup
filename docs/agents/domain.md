# Domain Docs

How engineering skills consume this repository's domain documentation.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- If `CONTEXT-MAP.md` exists, read the context documents it identifies as relevant.
- Read ADRs under `docs/adr/` that affect the area being changed.

If these files do not exist, proceed silently. Domain documentation is created only when useful terminology or decisions emerge.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary

Use terms defined in `CONTEXT.md` when naming domain concepts. Avoid synonyms that the glossary explicitly rejects. If a necessary concept is absent, reconsider the terminology or record the gap for later domain modeling.

## ADR conflicts

Surface conflicts with an existing ADR explicitly instead of silently overriding the recorded decision.
