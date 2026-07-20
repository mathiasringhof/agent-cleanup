---
name: agent-cleanup-apply
description: Back up touched paths and execute the exact approved operations in a reviewed agent-cleanup plan. Invoke explicitly.
user-invocable: true
disable-model-invocation: true
---

# Agent Cleanup Apply

Apply a reviewed cleanup plan exactly as recorded. Require its exact path and resolve the active workspace to its real absolute path. Invocation is apply authorization; do not ask for another confirmation.

Treat the reviewed plan as read-only. Do not reinterpret findings, generate new content, edit operations, or modify the plan.

## Prepare the change backup

Run prepare first:

```bash
node {baseDir}/scripts/apply-run.mjs prepare --plan <plan-path> --workspace <absolute-workspace-path>
```

The helper defaults to an external backup root beneath `OPENCLAW_STATE_DIR`, or beneath `OPENCLAW_HOME/.openclaw` when no explicit state directory is configured. Add `--backup-root <absolute-path>` only when the operator requested another location. The helper rejects draft plans, plans belonging to another workspace, and operations outside the cleanup scope. It creates a fresh directory containing `cleanup-plan.json` and the pre-apply content of every existing path touched by an applied write, move, or removal. It does not include untouched workspace content or a manifest.

If any backup copy fails, prepare removes the incomplete backup and fails. Stop without calling execute. Otherwise report the exact returned `backup_path` before modifying the workspace. Do not ask for confirmation after reporting it.

## Execute the reviewed operations

Run:

```bash
node {baseDir}/scripts/apply-run.mjs execute --plan <plan-path> --workspace <absolute-workspace-path> --backup <backup-path>
```

Use the exact `backup_path` returned by prepare. The helper rejects execution without it and verifies that the backup's copied cleanup plan is byte-for-byte identical to the plan being executed. The generic runner then attempts each operation from every `apply` finding in plan order. A failure skips the remaining operations in that finding, while later independent findings still run; there is no automatic rollback. It atomically replaces an existing text file through a same-directory temporary file while preserving its Unix permission mode, creates ordinary non-executable text files, never overwrites move destinations, and never dereferences symlinks contained in moved or removed directories.

Report:

- The verified `backup_path` returned by execute; it must match the path previously reported after prepare.
- Every entry in `successes`.
- Every entry in `failures` with its error.
- Every entry in `skipped` with its reason.

When execute returns `skill_validation_required: true`, run advisory validation visibly through the normal execution tool from the active workspace:

```bash
openclaw skills check --json
```

Report its availability, exit code, stdout, and stderr. Failure or unavailability is reported without rollback. When `skill_validation_required` is false, report that validation was not attempted. Do not run OpenClaw through the helper and do not persist the validation result.

Do not persist a result artifact. Manual recovery from the backup is the operator's decision.
