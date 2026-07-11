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

The helper defaults to an external backup directory beneath the operator's normal OpenClaw state location. Add `--backup-root <absolute-path>` only when the operator requested another location. The helper rejects draft plans and plans belonging to another workspace. It creates a fresh `.tar.gz` containing `cleanup-plan.json` and the pre-apply content of every existing path touched by an applied write, move, or removal. It does not include untouched workspace content.

If prepare fails or `tar` is unavailable, stop without calling execute. Otherwise report the exact returned `backup_path` before modifying the workspace. Do not ask for confirmation after reporting it.

## Execute the reviewed operations

Run:

```bash
node {baseDir}/scripts/apply-run.mjs execute --plan <plan-path> --workspace <absolute-workspace-path>
```

The generic runner attempts each operation from every `apply` finding in plan order. One failure does not stop later operations, and there is no automatic rollback. It preserves permissions when replacing a text file, creates ordinary non-executable text files, never overwrites move destinations, and never dereferences symlinks contained in moved or removed directories.

Report:

- The previously reported backup path.
- Every entry in `successes`.
- Every entry in `failures` with its error.
- The returned advisory `skill_validation` result. Skill Validation runs only when an attempted operation affects workspace-local skills. Failure or unavailability is reported without rollback.

Do not persist a result artifact. Manual recovery from the backup is the operator's decision.
