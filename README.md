# Agent Cleanup

Agent Cleanup is a set of three OpenClaw skills for finding and removing evidenced cruft from a workspace:

1. `agent-cleanup-audit` inspects workspace knowledge and local skills, then creates a cleanup plan.
2. `agent-cleanup-review` walks through each finding for an apply, defer, or dismiss decision.
3. `agent-cleanup-apply` creates a change backup and executes the approved operations.

Install the three skill directories in your OpenClaw skills location, then invoke them in order. Audit and review do not modify the target workspace; apply requires an explicitly reviewed plan and creates a change backup before making changes.

Licensed under the [Apache License 2.0](LICENSE).
