---
name: agent-cleanup-apply
description: Apply a sealed cleanup plan with drift checks, durable snapshot, validation, locking, and verified rollback. Invoke explicitly with a reviewed run ID.
user-invocable: true
disable-model-invocation: true
---

# Agent Cleanup Apply

Apply an already reviewed plan. Explicit invocation with its exact run directory is authorization; do not ask for edit approval again.

## Preflight

1. Require the short run ID and same state root. Show the resolved run directory and target.
2. Read `references/artifact-contract.md`.
3. Run:

   ```bash
   node {baseDir}/scripts/apply-run.mjs preflight --run <run-id>
   ```

4. Stop without touching the workspace if the audit or plan seal is invalid, the operation schema is invalid, a path is outside the target, a protected or symlink path is involved, or any audited source has drifted. Require a fresh audit and review; never rebase the plan here.

## Apply

Run:

```bash
node {baseDir}/scripts/apply-run.mjs apply --run <run-id>
```

The helper must:

- Acquire an exclusive target-workspace lock, then recheck seals and source hashes
- Create and seal a complete durable snapshot before any target write
- Execute only the sealed create, replace, move, and remove operations
- Verify resulting paths and payload hashes
- Require authoritative `openclaw skills check --json` before and after every skill change
- Restore and verify the complete pre-apply manifest if any operation or validation fails
- Seal `result.json`; repeated apply returns the historical result without writes and reports later drift separately

Never run arbitrary commands from the plan or from another skill. Never modify dated memory, a symlink, an external skill, or any cleanup-suite file.

Report success or restored failure, validation status, result path, and snapshot path. Keep successful snapshots for the operating system or user to remove; do not delete them automatically.
