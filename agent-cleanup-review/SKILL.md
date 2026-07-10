---
name: agent-cleanup-review
description: Interactively resolve one finding at a time from a sealed cleanup audit into a deterministic plan. Invoke explicitly with a short run ID.
user-invocable: true
disable-model-invocation: true
---

# Agent Cleanup Review

Turn a sealed audit into a coherent, executable plan without changing the target workspace.

## Start

1. Require the short run ID and use the same configured state root. Show the resolved run directory and target before review.
2. Read `references/artifact-contract.md`.
3. Run:

   ```bash
   node {baseDir}/scripts/review-run.mjs init --run <run-id>
   ```

4. Stop if the audit is unsealed, malformed, or its hash does not match.

## Review one item at a time

For each pending finding:

1. Recheck its evidence, ownership, scope, authority, and recommendation.
2. Reject false contradictions where subject, conditions, audience, or time differ.
3. Present exactly one review item to the user. Include the recommended decision and why.
4. Let the user choose `apply`, `defer`, or `dismiss`.
5. When applying, let the user decide per file between surgical edits and a whole-file rewrite. Explain the tradeoff and store the final complete file content as a payload.
6. Present any scope expansion separately and record explicit confirmation with `approve-expansion --run <id> --file <approval-json>`. Then record the decision in a structured decision JSON file. It includes finding ID, decision, rationale, operation-file paths, the separately approved scope expansion, and per-file strategies for creates/replacements:

   ```bash
   node {baseDir}/scripts/review-run.mjs decide --run <run-id> --file <decision-json>
   ```

Operations are limited to `create_file`, `replace_file`, `move_path`, and `remove_path`. For create or replace, the operation JSON must name a payload file already placed under `<run>/payload/`. Paths are target-relative. Never create operations for dated memory, symlinks, external skills, or any cleanup-suite directory.

Do not infer user decisions. Use `status` and `next-pending` to resume, and `revise --finding <id>` to reopen an unsealed decision. Only batch genuinely matching findings with `batch-decide --file <batch-json>` after showing every ID and path and receiving explicit batch confirmation. Partial cleanup is allowed.

If unrelated drift occurs, show the exact detected paths and obtain separate confirmation in a refresh JSON file, including coverage for new paths. Run `refresh --run <id> --file <refresh-json>`. Relevant finding, operation, authority, or involved-skill drift is rejected and requires renewed decisions; successful refresh history is recorded before resealing.

## Seal

After every item is resolved or explicitly deferred, run:

```bash
node {baseDir}/scripts/review-run.mjs seal --run <run-id>
```

The helper validates the schema, operation set, payload hashes, protected paths, and source expectations, then writes `plan.sha256` and `plan.md`.

Return the exact run directory and summarize applied, deferred, and dismissed items. Invoking `$agent-cleanup-apply` with this sealed plan is authorization to execute it; do not ask for edit approval again in the apply phase.
