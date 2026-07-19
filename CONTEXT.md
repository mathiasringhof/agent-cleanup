# Agent Cleanup

Agent Cleanup identifies and removes evidenced cruft from an OpenClaw workspace through separate audit, review, and apply phases.

## Language

**Cleanup Scope**:
The active workspace's root OpenClaw knowledge files, dated memory used as read-only evidence, and workspace-resident skills under `skills/` and `.agents/skills/` with their support files. External skills and the agent-cleanup suite itself are outside this boundary. Cleanup helpers reject operations outside this boundary.
_Avoid_: Agent environment, installed skills

**Target Workspace**:
The active OpenClaw workspace in which audit was invoked. Its absolute path is recorded in the cleanup plan, and review and apply cannot use that plan from another workspace.
_Avoid_: Selected workspace, cross-workspace target

**Audited Symlink**:
A workspace symlink recorded as read-only evidence. Its target content is inspected only when it resolves inside the confirmed workspace; external targets are identified but not inspected. Apply cannot target the link directly or follow it, although moving or removing a reviewed containing directory may also move or remove the link entry.
_Avoid_: Mutable link, followed external path

**Canonical Owner**:
The OpenClaw knowledge file or workspace-local skill where a kind of information belongs. Content in another location is misplaced and may be moved even when it is not duplicated or contradictory; a missing owner file may be created only to receive existing content.
_Avoid_: Preferred file, formatting convention

**Cruft**:
Workspace knowledge or skill content with evidence of duplication, contradiction, misplacement, supersession, staleness, abandonment, operational redundancy, broken references, or obsolete or conflicting behavior. Age, size, token count, and stylistic preference are not evidence by themselves.
_Avoid_: Old content, verbose content, untidy content

**Cleanup Plan**:
The sole persisted handoff document created by the audit helper outside the target workspace, normally beneath the active OpenClaw state directory, refined through review-helper commands, and executed by apply through its exact path. Direct editing is unsupported. It contains findings, evidence, decisions, and exact cleanup operations; human-readable presentation occurs in conversation.
_Avoid_: Audit manifest, artifact set

**Finding**:
One semantic problem in the workspace, supported by evidence from one or more paths and paired with an exact proposed outcome. A finding may require coordinated operations across several files, including when its evidence requires user judgment. Editing a decided finding replaces it completely and returns it to pending review.
_Avoid_: File issue, edit

**Reviewed Plan**:
The cleanup plan after every review item has received an operator decision. Apply executes its approved operations without reinterpretation or further semantic reasoning.
_Avoid_: Cleanup advice, edit proposal

**Review Item**:
One finding and all of its proposed cleanup operations, presented together to the operator for a decision.
_Avoid_: Batch, review group

**Review Decision**:
The operator's resolution of a review item: apply its operations, defer it for later, or dismiss it as requiring no cleanup.
_Avoid_: Approval status

**Cleanup Operation**:
One deterministic filesystem change in a reviewed plan: write a complete text file, move an existing path, or remove an existing path. A write stores only the approved final content; review reads the live file to present the before/after difference. Rewrites preserve the existing Unix permission mode and new files are non-executable. Operations cannot create directories, change permission modes, directly mutate symlinks, or execute commands.
_Avoid_: Command, instruction

**Cleanup Runner**:
The generic helper bundled with apply that treats a reviewed cleanup plan as read-only. Its prepare step creates the change backup; after the skill reports that backup, its execute step reads the same plan and performs the approved operations without model interpretation or further confirmation.
_Avoid_: Generated script, shared runtime

**Phase Skill**:
One independently installable audit, review, or apply skill containing its own instructions and phase-specific helper. It has no runtime dependency on either sibling skill.
_Avoid_: Plugin suite, shared installation

**Change Backup**:
A `.tar.gz` archive containing the reviewed plan and the pre-apply content at every existing path that the plan will modify, move, or remove. It does not contain untouched workspace content and supports manual rather than automatic recovery. Apply execution requires its exact path and verifies that its embedded plan is byte-for-byte identical to the plan being executed.
_Avoid_: Workspace snapshot, full backup

**Apply Authorization**:
The operator's explicit invocation of apply for a reviewed plan. No additional confirmation is required after the change backup succeeds.
_Avoid_: Final approval prompt

**Finding-Scoped Apply**:
Execution of approved cleanup operations in plan order, stopping the remainder of a finding after its first failure while continuing with later independent findings. Apply reports failures and skipped operations and relies on the change backup for manual recovery.
_Avoid_: Operation-by-operation best effort, transaction, automatic rollback

**Skill Validation**:
An advisory OpenClaw compatibility check used during audit as evidence and after applying workspace-local skill changes. Failure or unavailability is reported without automatic rollback.
_Avoid_: Apply validation, rollback trigger
