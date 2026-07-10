# Cleanup artifact contract v2

Runs live under the configured cleanup state root, never inside the target workspace or an OpenClaw per-agent directory. The default root is `$XDG_STATE_HOME/openclaw-agent-cleanup`, falling back to `$HOME/.local/state/openclaw-agent-cleanup`. A run is addressed by its immutable 12-character lowercase hexadecimal ID; helpers resolve that ID directly beneath the state root and reject paths and symlinks.

## Inventory and audit

`inventory.json` (`agent-cleanup.inventory/v1`) contains generated target identity, source manifest, protected/read-only paths, and trusted OpenClaw diagnostics. `inventory.sha256` seals it before findings are accepted.

`audit.json` (`agent-cleanup.audit/v1`) binds the inventory hash and contains validated findings and coverage. Findings have a stable ID, allowed category, confidence, affected paths, evidence, recommendation, and `requires_user`. Every inventory path has one coverage record: `inspected`, `inventory-only`, or `excluded`; exclusions require a reason. `audit.sha256` is written only after coverage is complete and `audit.md` is finalized.

## Plan

`plan.json` (`agent-cleanup.plan/v1`) binds the audit hash. Review is resumable while its status is `reviewing`; structured decisions can be revised until sealing. Matching findings may be batched only with an explicit artifact listing every ID and exact path. Each finding is `apply`, `defer`, or `dismiss`. Apply decisions bind every operation path to the finding paths or an explicit scope expansion. `create_file` and `replace_file` require a per-file `surgical` or `rewrite` strategy; moves and removals prohibit strategies.

Targeted refresh requires a separately confirmed exact drift-path list and coverage for new inventory paths. Relevant finding, operation, authority, or involved-skill drift is rejected. Accepted unrelated drift updates the inventory/audit binding, reopens the plan for sealing, and appends immutable refresh history.

Allowed operations are `create_file`, `replace_file`, `move_path`, and `remove_path`. Paths are target-relative and cannot overlap, escape, traverse symlinks, or touch protected/read-only content. Payloads are sealed regular files under `payload/`. Creates require an existing real parent directory and produce non-executable regular files. `plan.sha256` seals a ready plan.

## Snapshot and result

Snapshots live under the state root's durable `backups/` namespace unless explicitly overridden. `snapshot.json` (`agent-cleanup.snapshot/v1`) contains the complete pre-apply manifest and copied roots; `snapshot.sha256` seals it. Restoration is verified against the complete manifest and reports mismatched paths.

`result.json` (`agent-cleanup.result/v1`) records status, exact plan hash, executed operations, validation evidence, snapshot, and the complete post-apply manifest. `result.sha256` seals it. Reapplying a successful run performs no writes and reports whether current state still matches the historical result.

Retained runs and snapshots are never removed automatically. Listing is read-only. Pruning previews the exact deletion set and requires explicit confirmation.
