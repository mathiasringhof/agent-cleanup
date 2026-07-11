# Use a helper-owned cleanup plan

Agent cleanup uses one helper-owned JSON plan across audit, review, and apply. Audit proposes exact outcomes, review resolves findings one at a time, and apply creates a change-scoped `.tar.gz` before executing the reviewed operations on a best-effort basis. This design favors a small, inspectable workflow and manual recovery over manifests, seals, drift detection, transactional execution, and automatic rollback.
