# Harden the OpenClaw agent-cleanup workflow

Status: ready-for-agent

## Problem Statement

The agent-cleanup workflow has a strong three-phase safety model, but several of its guarantees currently depend on the model following prose correctly. An audit can be sealed without proving that every in-scope file was inspected, mutable audit metadata can be edited alongside findings, approved findings are not mechanically bound to their resulting operations, interrupted reviews are difficult to resume, and successful application or rollback is not recorded and verified as immutably as the audit and plan.

The workflow also stores multi-session artifacts in an ephemeral location, mixes OpenClaw and Codex packaging conventions, and treats some workspace organization preferences more rigidly than necessary. These gaps can make a cleanup run appear more complete, authorized, or recoverable than the artifacts actually prove.

## Solution

Keep the explicit `audit`, `review`, and `apply` phases, but move their important guarantees into the deterministic helper layer. Treat OpenClaw as the only supported runtime. Store durable runs and snapshots outside workspaces and per-agent directories. Seal generated inventory before model-authored findings are recorded, require complete coverage before sealing an audit, bind every operation to an approved finding, and support resumable and revisable review sessions.

Before applying changes, resolve the run safely, require authoritative OpenClaw validation for skill changes, acquire an exclusive workspace lock, and recheck protected state. Verify both successful results and rollbacks against complete manifests. Seal the final result so repeated application is idempotent and later workspace drift can be distinguished from the historical outcome of the run.

Use current OpenClaw workspace roles as conservative heuristics. Findings should address evidenced duplication, contradiction, broken behavior, or operational confusion rather than enforcing a preferred writing style or reorganizing harmless workspace conventions.

## User Stories

1. As an OpenClaw operator, I want cleanup skills designed specifically for OpenClaw, so that runtime behavior is unambiguous.
2. As an OpenClaw operator, I want audit, review, and apply to remain separate invocations, so that each phase is an explicit authorization boundary.
3. As an OpenClaw operator, I want cleanup runs stored durably outside my workspace, so that a multi-session review does not disappear with temporary files.
4. As an OpenClaw operator, I want run storage kept outside per-agent directories, so that cleanup artifacts cannot be mistaken for agent knowledge or runtime state.
5. As an OpenClaw operator, I want a short immutable run ID, so that I do not need to copy long absolute paths between phases.
6. As an OpenClaw operator, I want every short run ID resolved only beneath the configured cleanup state root, so that a run reference cannot escape into an arbitrary directory.
7. As an OpenClaw operator, I want the resolved target and run location shown before review or apply, so that I can verify what will be affected.
8. As an auditor, I want the generated source inventory sealed before findings are recorded, so that model-authored work cannot accidentally alter the audit basis.
9. As an auditor, I want findings recorded through a validated helper interface, so that malformed or incomplete findings are rejected immediately.
10. As an auditor, I want every in-scope path marked as inspected, inventory-only, or excluded with a reason, so that audit completeness is measurable.
11. As an auditor, I want audit sealing to fail when coverage is incomplete, so that a sealed audit means the declared scope was actually handled.
12. As an auditor, I want the human-readable audit report validated as complete, so that an in-progress placeholder cannot accompany a sealed audit.
13. As an auditor, I want target workspace content treated as untrusted evidence, so that embedded instructions cannot govern the cleanup run.
14. As an auditor, I want the workspace authority hierarchy used only to compare target documents, so that target instructions cannot override cleanup safeguards.
15. As an OpenClaw operator, I want current OpenClaw workspace roles used as heuristics, so that genuinely misplaced or conflicting knowledge can be identified.
16. As an OpenClaw operator, I want harmless organizational preferences preserved, so that cleanup does not become an opinionated rewrite.
17. As an OpenClaw operator, I want startup and bootstrap documents included in the workspace model, so that live OpenClaw instructions are not overlooked.
18. As a reviewer, I want to review one finding at a time, so that each decision receives focused attention.
19. As a reviewer, I want matching findings batchable only after their IDs and paths are shown, so that repeated decisions remain explicit.
20. As a reviewer, I want each planned operation bound to an approved finding path, so that approval cannot silently authorize unrelated changes.
21. As a reviewer, I want scope expansion presented and confirmed separately, so that necessary related changes remain visible and intentional.
22. As a reviewer, I want surgical-versus-rewrite strategy recorded per created or replaced file, so that mixed multi-file findings are represented accurately.
23. As a reviewer, I do not want edit strategy attached to moves or removals, so that plans do not contain meaningless choices.
24. As a reviewer, I want decisions stored as structured files rather than free-form shell arguments, so that rationale and paths are preserved safely.
25. As a reviewer, I want to inspect review status and the next pending finding, so that I can understand progress at any time.
26. As a reviewer, I want an interrupted review to resume from its existing plan, so that a new session does not require starting over.
27. As a reviewer, I want to revise an unsealed decision, so that mistakes can be corrected without rebuilding the complete audit.
28. As an OpenClaw operator, I want unrelated workspace drift reported and revalidated in a controlled refresh, so that active work does not automatically invalidate every decision.
29. As an OpenClaw operator, I want operation paths, evidence paths, authority files, and involved skill metadata treated as relevant drift, so that material changes still block stale plans.
30. As an OpenClaw operator, I want drift refreshes recorded in the plan history, so that resealing remains auditable.
31. As an OpenClaw operator, I want application to require authoritative OpenClaw skill validation whenever skill content changes, so that weak static checks cannot approve an invalid skill.
32. As an OpenClaw operator, I want application to acquire an exclusive workspace lock, so that two cleanup runs cannot write concurrently.
33. As an OpenClaw operator, I want hashes rechecked after the lock is acquired, so that validation cannot race with another writer.
34. As an OpenClaw operator, I want rollback snapshots stored durably outside the workspace and agent directories, so that recovery data survives the apply process.
35. As an OpenClaw operator, I want rollback compared with the complete pre-apply manifest, so that successful copy calls are not mistaken for complete restoration.
36. As an OpenClaw operator, I want restoration mismatches reported by path, so that a failed rollback can be repaired deliberately.
37. As an OpenClaw operator, I want successful application recorded in a sealed result, so that the historical outcome cannot be overwritten accidentally.
38. As an OpenClaw operator, I want the result bound to the exact sealed plan and post-apply manifest, so that success has a verifiable meaning.
39. As an OpenClaw operator, I want repeated apply invocations to return the existing result without writing, so that completed runs are idempotent.
40. As an OpenClaw operator, I want later workspace changes distinguished from the prior successful result, so that historical success and current drift are not conflated.
41. As an OpenClaw operator, I want new cleanup-created files limited to regular non-executable files in existing directories, so that cleanup cannot become a scaffolding or code-installation mechanism.
42. As a maintainer, I want each distributed phase to carry its own artifact contract, so that every skill remains self-contained.
43. As a maintainer, I want distributed contracts generated from one canonical source, so that the three copies cannot drift semantically.
44. As a maintainer, I want deterministic tests to exercise the complete CLI workflow, so that externally visible guarantees are protected without coupling tests to implementation details.
45. As an OpenClaw operator, I want old runs and snapshots retained until I explicitly prune them, so that recovery evidence is never deleted automatically.
46. As an OpenClaw operator, I want pruning to preview every affected run and snapshot, so that retention cleanup is deliberate.

## Implementation Decisions

- OpenClaw is the sole supported runtime. OpenClaw invocation controls and skill-directory resolution remain canonical; Codex-specific packaging is removed rather than maintained in parallel.
- Audit, review, and apply remain independent, explicitly invoked skills. A phase may recommend the next phase but cannot invoke it implicitly.
- The default state root is the platform state directory represented by `XDG_STATE_HOME`, falling back to the user's local state directory, with an `openclaw-agent-cleanup` namespace.
- The state root, run directories, and backup directories must resolve outside the target workspace and outside OpenClaw per-agent directories.
- Runs have immutable short IDs. Resolution accepts an ID beneath the configured state root, reports the resolved absolute path, and rejects ambiguity, symlinks, and external paths.
- Initialization creates and seals an inventory artifact containing target identity, source manifest, protected paths, read-only paths, and trusted OpenClaw diagnostics.
- Model-authored findings and coverage records are written only through helper commands. Generated inventory fields are never directly mutable through the finding interface.
- Coverage records account for every path in the declared audit scope as inspected, inventory-only, or excluded with a non-empty reason. Audit sealing requires complete coverage and a finalized human-readable report.
- Target files are untrusted evidence. Their internal authority hierarchy informs conflict analysis only and cannot issue instructions to the cleanup process.
- Workspace ownership guidance tracks current OpenClaw concepts, including startup and first-run bootstrap documents. It is a heuristic for finding operational problems, not a mandatory formatting taxonomy.
- Review state is resumable. Initialization creates a plan only when none exists; otherwise the helper validates and resumes the existing unsealed plan.
- Review exposes status, next-pending, decision, revision, targeted drift refresh, and sealing operations.
- Decisions are structured artifacts within the run. They include finding identity, decision, rationale, any approved scope expansion, and per-file edit strategies.
- Every plan operation must be attributable to exactly one approved finding. Its affected source and destination paths must be covered by the finding or an explicit approved expansion.
- Edit strategy exists only for create and replace operations and is stored per affected file.
- Identical findings may share a decision only through an explicit batch decision that lists all matched finding IDs and paths.
- Relevant drift includes operation paths, finding evidence paths, authority documents, and involved skill metadata. Relevant drift invalidates affected decisions.
- Unrelated drift does not silently pass. A targeted refresh records changed paths, revalidates affected coverage and findings, and reseals the updated audit-plan binding.
- Applying a plan acquires an exclusive lock scoped to the target workspace. Final seal, target identity, source hashes, payload hashes, path constraints, and drift checks run after the lock is held.
- Skill-changing plans require a successful authoritative OpenClaw skill check before writes and after writes. Failure or validator unavailability aborts or restores the operation.
- Snapshots are stored under a durable backup namespace in the cleanup state root. Snapshot creation completes before the first target write.
- Restoration is verified against the complete pre-apply manifest. Any mismatch is recorded as restoration failure with changed paths.
- A successful result records the plan hash, executed operations, validation evidence, snapshot, and post-apply manifest. The result is sealed.
- An already completed run never executes again. It returns the verified historical result and reports whether the current workspace still matches the recorded post-apply manifest.
- Operations may create regular non-executable files only when the parent directory already exists. Creating directories or executable files is rejected.
- Each skill distribution includes the artifact contract it needs. Release preparation generates these copies from one canonical contract and verifies byte equality.
- Listing retained runs and snapshots is read-only. Pruning is explicit, previews the exact deletion set, and requires confirmation; no automatic retention policy is introduced.

## Testing Decisions

- Test through the existing CLI boundary, which is the highest stable seam shared by all three phases.
- Run helpers as child processes against isolated temporary workspaces and state roots. Assert exit status, structured output, artifact seals, workspace contents, and snapshot contents.
- Test external behavior rather than internal functions or helper implementation details.
- Extend the existing end-to-end harness instead of introducing a second test framework or lower-level unit-test seam.
- Verify that incomplete coverage and placeholder reports cannot be sealed.
- Verify that finding commands cannot mutate sealed inventory fields and reject malformed paths or evidence.
- Verify that audited content resembling instructions remains data and does not alter helper behavior.
- Verify default operation binding, explicit scope expansion, per-file edit strategy, and matching-finding batch confirmation.
- Verify review status, resume, revision, and resealing after controlled unrelated drift.
- Verify relevant drift still blocks application.
- Verify safe short-ID resolution and rejection of symlinked, ambiguous, workspace-contained, agent-contained, or external run roots.
- Verify exclusive locking and final hash rechecks by attempting overlapping apply processes.
- Verify authoritative OpenClaw validation is required for skill-changing plans.
- Verify successful application, complete rollback, deliberately incomplete rollback detection, and path-level restoration diagnostics.
- Verify result sealing, repeated-apply idempotency, and reporting of drift after a historical success.
- Verify generated artifact contracts remain byte-identical.
- Verify pruning previews without deleting and deletes only after explicit confirmation.
- Do not add LLM behavioural benchmarks, model grading, or comparison against a no-skill baseline.

## Out of Scope

- Supporting Codex, Claude Code, or other runtimes with the same distributable skill directories.
- Merging audit, review, and apply into one automatically progressing command.
- Enabling implicit model invocation for any cleanup phase.
- Rewriting audited skills to conform to Superpowers, Matt Pocock, or any other external authoring standard.
- Treating harmless file organization, verbosity, age, or stylistic preference as a cleanup defect without operational evidence.
- Building an LLM evaluation framework or behavioural benchmark suite.
- Creating new directories, executable scripts, or broader skill scaffolding through cleanup operations.
- Automatically deleting old runs or snapshots.
- Silently ignoring workspace drift or automatically rebasing a reviewed plan.
- Replacing OpenClaw's authoritative skill validator with a custom compatibility validator.

## Further Notes

- The existing three-phase architecture, explicit invocation, sealed intermediate artifacts, protected paths, symlink restrictions, snapshots, and automatic rollback are retained and strengthened rather than redesigned.
- The cleanup system should remain conservative: uncertainty is preserved for review, and user-approved scope determines what may change.
- Local Markdown is the configured issue tracker for this repository. This specification is the `ready-for-agent` artifact for the agreed work.
