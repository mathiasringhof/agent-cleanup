# OpenClaw agent cleanup core design

Status: ready-for-agent

## Problem Statement

OpenClaw workspaces accumulate duplicated, contradictory, misplaced, superseded, stale, abandoned, and broken knowledge over time. Workspace-local skills can develop the same problems through overlapping procedures, malformed instructions, obsolete behavior, and unreferenced support files.

Cleanup requires semantic judgment, but applying that judgment should be predictable. The operator needs to inspect one meaningful problem at a time, refine the proposed correction, and then execute exactly what was reviewed. Cleanup must remain narrow enough to understand: it should not become a security scanner, workspace migration system, artifact-management platform, or transactional filesystem engine.

## Solution

Provide three independently distributable OpenClaw skills: audit, review, and apply.

Audit inspects the active workspace and creates one helper-owned `cleanup-plan.json` outside the workspace. Each finding describes one semantic problem, cites evidence from one or more paths, and proposes an exact outcome across every affected file.

Review runs in a separate invocation and presents one finding at a time. It rereads the affected workspace files, shows the before/after differences, and lets the operator refine the finding before choosing to apply, defer, or dismiss it. The same helper-owned JSON is updated until every finding has a decision.

Apply treats the reviewed plan as read-only. It first creates a change-scoped external directory containing the reviewed plan and the existing content at every path the plan will touch. After reporting the backup location, a generic runner attempts every approved operation exactly as recorded. Failures are reported but do not stop later operations or trigger automatic rollback.

## User Stories

1. As an OpenClaw operator, I want accumulated workspace cruft identified, so that the agent's knowledge and instructions remain coherent.
2. As an OpenClaw operator, I want audit, review, and apply to be separate explicit invocations, so that discovery, judgment, and execution remain distinct.
3. As an OpenClaw operator, I want each phase independently distributable, so that it can be installed and updated through normal OpenClaw skill channels.
4. As an OpenClaw operator, I want each phase self-contained, so that it does not depend on sibling skill directories at runtime.
5. As an OpenClaw operator, I want cleanup limited to the active workspace, so that a plan cannot accidentally target another agent.
6. As an OpenClaw operator, I want audit and review to leave workspace files unchanged, so that planning remains safe.
7. As an OpenClaw operator, I want one cleanup plan outside the workspace, so that cleanup does not create more workspace knowledge.
8. As an OpenClaw operator, I want the plan updated only through helpers, so that malformed direct edits are not part of the workflow.
9. As an OpenClaw operator, I want a finding to represent one semantic problem, so that related edits across several files are reviewed together.
10. As an OpenClaw operator, I want every finding to include evidence, so that I can evaluate why cleanup is proposed.
11. As an OpenClaw operator, I want every finding to propose an exact outcome, so that review begins from a concrete recommendation.
12. As an OpenClaw operator, I want ambiguous findings to explain their uncertainty, so that recommendations are not mistaken for facts.
13. As an OpenClaw operator, I want root knowledge files audited, so that the agent's primary instructions and curated knowledge stay coherent.
14. As an OpenClaw operator, I want dated memory used as read-only evidence, so that history informs cleanup without being rewritten.
15. As an OpenClaw operator, I want workspace-local skills and their support files audited, so that active procedures remain coherent.
16. As an OpenClaw operator, I want unreferenced files inside workspace-local skills reported, so that abandoned support material can be reviewed.
17. As an OpenClaw operator, I want external and managed skills excluded, so that cleanup authority remains workspace-local.
18. As an OpenClaw operator, I want the cleanup skills excluded from their own audit, so that cleanup cannot redesign itself during a run.
19. As an OpenClaw operator, I want symlinks recorded as evidence, so that linked workspace behavior is not invisible.
20. As an OpenClaw operator, I want external symlink targets left uninspected, so that audit does not silently expand beyond the workspace.
21. As an OpenClaw operator, I want symlink targets left unchanged, so that cleanup cannot mutate content indirectly.
22. As an OpenClaw operator, I want misplaced information moved to its canonical owner, so that each kind of knowledge has a clear home.
23. As an OpenClaw operator, I want a missing owner file created only when existing content needs to move there, so that cleanup does not become bootstrap.
24. As an OpenClaw operator, I want cruft classified by semantic evidence, so that age, size, verbosity, or style alone do not justify removal.
25. As an OpenClaw operator, I want malformed local skills checked with OpenClaw's validator when available, so that findings reflect the installed runtime.
26. As a reviewer, I want exactly one finding presented at a time, so that each semantic problem receives focused consideration.
27. As a reviewer, I want all files affected by a finding presented together, so that coordinated changes are not approved piecemeal.
28. As a reviewer, I want live files reread before reviewing a finding, so that before/after comparisons reflect current content.
29. As a reviewer, I want to apply, defer, or dismiss each finding, so that partial cleanup remains possible.
30. As a reviewer, I want to edit a finding when new evidence appears, so that its complete proposed outcome remains coherent.
31. As a reviewer, I want editing a decided finding to reopen it, so that changed proposals cannot retain stale approval.
32. As a reviewer, I want to add a newly discovered finding, so that review does not require restarting the complete audit.
33. As an OpenClaw operator, I want apply to accept only a fully reviewed plan, so that pending judgments cannot become filesystem changes.
34. As an OpenClaw operator, I want apply to execute exact reviewed file contents, so that it performs no fresh semantic reasoning.
35. As an OpenClaw operator, I want apply limited to complete text-file writes, path moves, and path removals, so that its authority remains understandable.
36. As an OpenClaw operator, I want a backup of every existing path apply will touch, so that I can manually recover changed content.
37. As an OpenClaw operator, I want the reviewed plan included in the backup, so that the backup explains how to reverse creations and moves.
38. As an OpenClaw operator, I want the backup location reported before modification, so that I know where recovery material lives.
39. As an OpenClaw operator, I want explicit apply invocation to authorize execution, so that no redundant approval is required after backup.
40. As an OpenClaw operator, I want later operations attempted after one operation fails, so that unrelated cleanup can still complete.
41. As an OpenClaw operator, I want each operation's outcome reported, so that partial success remains visible.
42. As an OpenClaw operator, I want changed skills validated after apply when possible, so that compatibility problems are surfaced.
43. As an OpenClaw operator, I want validation failures reported without automatic rollback, so that recovery remains my decision.
44. As a maintainer, I want deterministic helper behavior tested end to end, so that filesystem mechanics remain reliable.
45. As a maintainer, I do not want prompt quality or model judgment treated as deterministic test targets, so that tests stay stable and meaningful.

## Implementation Decisions

- Implement three explicitly user-invoked skills named `agent-cleanup-audit`, `agent-cleanup-review`, and `agent-cleanup-apply`.
- Each skill includes its own instructions and phase-specific Node.js helper. No installed phase imports code from a sibling skill or shared runtime library, and shipped helpers do not execute subprocesses.
- Cleanup always targets the active workspace. Audit records its real absolute path in the plan; review and apply reject the plan when invoked from another workspace.
- Store each plan in a timestamped directory beneath `OPENCLAW_STATE_DIR/agent-cleanup`, or beneath `OPENCLAW_HOME/.openclaw/agent-cleanup` when no explicit state directory is configured, outside the target workspace. Audit returns the exact plan path; review and apply require that path.
- Do not add run IDs, run lookup, artifact listing, retention policies, pruning, schema versions, SHA seals, source manifests, drift detection, locks, or result artifacts.
- `cleanup-plan.json` is the only persisted audit/review handoff. Human-readable findings and diffs are rendered in conversation rather than duplicated into Markdown reports.
- Direct plan editing is unsupported. Helpers are the normal writers of the plan and validate every input before updating it.
- The plan has only two lifecycle states: draft and reviewed. It becomes reviewed only when no finding remains pending. Adding or editing a finding returns the plan to draft.
- A finding represents one semantic workspace problem rather than one file defect. It records a stable identifier, explanation, evidence paths and excerpts, uncertainty where relevant, intended outcome, decision, and ordered proposed operations.
- Every finding includes exact proposed operations even when user judgment is required. Audit makes a conservative recommendation; review may revise, defer, or dismiss it.
- Audit helper commands initialize the plan, record the visible OpenClaw validation result, add a finding, replace a finding, and finish the audit. Initialization leaves validation pending; finish requires the skill to have recorded an outcome. The helper prevents duplicate finding identifiers and malformed paths or operations.
- Review helper commands return the next pending finding, add a finding, replace a finding, record a decision, and finish review. Replacing a decided finding resets its decision to pending.
- Review processes one finding at a time. Before presenting it, the skill rereads every affected live file and uses the live content to render before/after differences. The plan stores intended new content, not copies of old file content.
- Review decisions are `apply`, `defer`, and `dismiss`. Only operations attached to applied findings are executed; deferred and dismissed findings retain their proposed operations as non-executed context.
- Audit and review never modify target workspace content. Their only filesystem writes are plan-helper writes beneath the external plan directory.
- Audit the active workspace's root OpenClaw knowledge files, dated memory, and workspace-resident skills beneath `skills/` and `.agents/skills/` with their referenced and unreferenced support files.
- Exclude external, shared, managed, bundled, and plugin-provided skills. Exclude every installed agent-cleanup skill from its own cleanup scope.
- Treat dated memory as immutable historical evidence. It may support a finding but may never be an operation target.
- Enforce Cleanup Scope in every helper. Operations may target only the listed root knowledge files or descendants of `skills/` and `.agents/skills/`; reject other workspace paths, dated memory, and every agent-cleanup skill directory.
- Record every symlink. Inspect its target content only when the resolved target remains inside the active workspace. Identify but do not inspect external targets.
- Reject operations that directly target a symlink or traverse one. A move or removal of a containing directory may move or remove contained symlink entries, but the runner never dereferences them or modifies their targets.
- Use canonical ownership when classifying misplaced information: `SOUL.md` owns persona and behavioral boundaries; `IDENTITY.md` owns stable identity metadata; `USER.md` owns user facts and preferences; `AGENTS.md` owns workspace-wide operating instructions; `TOOLS.md` owns environment and tool notes; `HEARTBEAT.md` owns heartbeat work; `MEMORY.md` owns curated durable knowledge; dated memory owns historical observations; and skills own reusable task procedures.
- Treat placement outside the canonical owner as a finding even without duplication or contradiction. A missing canonical owner file may be created only to receive existing misplaced content.
- Classify cruft as duplicate information, scoped contradictions, misplaced information, explicit supersession, affirmative semantic staleness, completed or invalid open loops, abandoned template content, operationally redundant wording, broken internal references, malformed skills, duplicate or overlapping skills, conflicting skills, affirmatively obsolete skills, and unreferenced local-skill files.
- Compare contradictions only when subject, audience, conditions, scope, and time match. Prefer explicit corrections over inference, and use newer dated evidence only when it clearly records a changed fact or decision. Modification time alone is never evidence.
- Do not classify content as cruft from age, modification time, file size, token count, verbosity alone, or stylistic preference.
- Run the installed OpenClaw skill validator visibly through the agent's normal execution tool during audit when available, record its result through the audit helper, and use its diagnostics as evidence. If unavailable, record and report that structural validation was skipped and continue.
- Do not collect skill-usage or inactivity data. A skill is obsolete only when affirmative workspace evidence supports that conclusion.
- The cleanup operation set is `write_file`, `move_path`, and `remove_path`, executed in plan order.
- `write_file` contains the complete approved final text. Replacing a file preserves its permissions; creating a file uses ordinary non-executable text-file permissions and requires an existing parent directory.
- `move_path` moves an existing file or directory to an exact destination and never overwrites an existing destination.
- `remove_path` removes an existing file or directory without dereferencing symlinks contained beneath it.
- Reject directory creation, direct symlink mutation, permission changes, binary rewriting, arbitrary commands, and paths outside the target workspace.
- Apply's helper is a generic cleanup runner with separate `prepare` and `execute` commands. Both treat the reviewed plan as read-only.
- `prepare` validates the reviewed plan and creates a timestamped directory outside the workspace using Node filesystem APIs. The directory contains the reviewed plan and the complete pre-apply content at every existing path targeted by an applied write, move, or removal. Duplicate and nested touched paths are copied once; no manifest or hashes are added.
- If any backup copy fails, prepare removes the incomplete backup, aborts, and execute is not called.
- After prepare, the skill reports the backup directory's exact path. Execute requires that path, reads the copied cleanup plan, and rejects execution unless it is byte-for-byte identical to the plan being executed. Explicit invocation of apply is already authorization, so no additional confirmation occurs.
- `execute` attempts every applied operation in order. Failure of one operation is recorded and does not prevent later operations from being attempted. No automatic rollback or recovery verification occurs.
- Reapplying a reviewed plan has no special replay protection. Each invocation creates a fresh change backup and attempts every operation again.
- After execution, report the backup path, every successful operation, every failed operation with its error, and whether advisory Skill Validation is required. Do not persist a separate result artifact.
- When any attempted operation affects workspace-local skills, the apply skill runs the installed OpenClaw skill validator visibly through the agent's normal execution tool after execution. Report failure or unavailability without rollback or persistence. Knowledge-only changes receive no generic semantic validation after apply.

## Testing Decisions

- Use one end-to-end harness across the three helper CLIs as the highest stable test seam.
- Run helpers as child processes against isolated temporary active workspaces, plan directories, and backup directories.
- Test deterministic helper and filesystem behavior only. Do not add prompt snapshots, model grading, semantic cleanup benchmarks, or assertions about prose quality.
- Verify audit initialization, finding addition, whole-finding replacement, duplicate-ID rejection, operation validation, and audit completion.
- Verify review returns one pending finding at a time, records apply/defer/dismiss decisions, reopens edited findings, accepts newly discovered findings, and refuses to finalize while any finding is pending.
- Verify direct malformed helper inputs are rejected without corrupting the existing plan.
- Verify review and apply reject a plan belonging to a different active workspace.
- Verify apply refuses a draft plan.
- Verify prepare creates a readable directory containing the reviewed plan and pre-change content for every existing touched path, without including untouched workspace content or a manifest.
- Verify prepare removes an incomplete backup and fails before mutation when a filesystem copy fails.
- Verify complete text-file writes, new file creation, permission preservation, moves, and removals.
- Verify out-of-workspace paths, directory creation, direct symlink operations, permission changes, binary writes, and arbitrary commands are rejected.
- Verify operations outside Cleanup Scope, dated-memory targets, and agent-cleanup targets are rejected by audit, review, and apply, while both workspace-resident skill roots remain valid.
- Verify directory moves and removals do not dereference contained symlinks.
- Verify execution continues after an operation failure and reports successes and failures separately.
- Verify repeated apply invocations create fresh backups and attempt the plan again.
- Verify execute refuses a missing backup path or a backup containing a different cleanup plan.
- Verify default plan and backup paths honor `OPENCLAW_STATE_DIR` and `OPENCLAW_HOME`.
- Verify execute requests visible OpenClaw validation after attempted local-skill changes and skips it for knowledge-only changes.
- Verify the three skill distributions operate without sibling skill directories present.
- Verify release validation rejects subprocess APIs in shipped skill support files.

## Out of Scope

- Cross-workspace cleanup or live control of another agent workspace.
- Auditing or editing external, shared, managed, bundled, plugin-provided, or otherwise non-workspace-local skills.
- Editing or archiving dated memory.
- Direct edits to symlinks or their targets.
- Self-audit or self-modification of the agent-cleanup skills.
- General cleanup of project source, downloads, generated artifacts, runtime state, or arbitrary workspace files.
- Secret detection, credential scanning, privacy classification, security review, or remediation.
- Executing scripts discovered during audit.
- Deep semantic inspection of binaries, vendored dependencies, or generated output.
- Skill-usage tracking, inactivity warnings, or analytics integration.
- Prompt-size optimization, token-budget enforcement, or cleanup based on age, size, or style.
- Automatic merging, retirement, or contradiction resolution without review.
- Batch review of multiple findings.
- Patches, fuzzy replacements, or apply-time semantic rewriting.
- Schema versioning, cryptographic seals, source manifests, drift detection, targeted refresh, locking, or artifact resealing.
- Full-workspace backups, automatic rollback, transactional execution, restoration verification, or persisted execution results.
- Run registries, run discovery, artifact retention management, or pruning.
- Directory creation, permission management, direct symlink operations, binary rewriting, or arbitrary shell commands through a cleanup plan.
- Model-graded tests or behavioral benchmarks for semantic audit quality.

## Further Notes

- The helpers make plan mutation, backup creation, and filesystem execution deterministic. Semantic audit quality remains a model-and-user responsibility.
- The reviewed plan expresses desired outcomes. It intentionally stores complete new text content without old-file copies, hashes, or drift metadata.
- Review obtains the before side of each comparison from the live workspace. Apply captures recovery content later in the change backup.
- Manual recovery is an explicit design choice. The backup provides the original touched content and reviewed plan; the operator decides whether and how to restore it.
- Simplicity is a core safety property: the workflow limits authority and keeps handoffs inspectable instead of attempting to provide transactional guarantees.

## Comments

- 2026-07-20: GitHub issue 1 exposed Skill Workshop's blanket quarantine of shipped Node subprocess APIs. Validation moved to visible agent execution, and the Change Backup became a direct external directory with no manifest or hashes; see ADR 0002.
