#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const scripts = {
  audit: path.join(repo, "agent-cleanup-audit/scripts/audit-run.mjs"),
  review: path.join(repo, "agent-cleanup-review/scripts/review-run.mjs"),
  apply: path.join(repo, "agent-cleanup-apply/scripts/apply-run.mjs"),
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cleanup-core-"));
const workspace = path.join(root, "workspace");
const otherWorkspace = path.join(root, "other-workspace");
const plans = path.join(root, "plans");
const backups = path.join(root, "backups");
const bin = path.join(root, "bin");

function write(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode === undefined ? undefined : { mode });
}

function jsonFile(label, value) {
  const file = path.join(root, `${label}-${crypto.randomBytes(4).toString("hex")}.json`);
  write(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function run(script, args, { expected = 0, env = {} } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env },
  });
  assert.equal(
    result.status,
    expected,
    `${path.basename(script)} ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

function parse(result) {
  return JSON.parse(result.stdout);
}

function finding(id, operations, overrides = {}) {
  return {
    id,
    explanation: `Problem ${id}`,
    evidence: [{ path: "USER.md", excerpt: "Prefers tea." }],
    uncertainty: null,
    intended_outcome: `Resolve ${id}`,
    decision: "pending",
    operations,
    ...overrides,
  };
}

function initPlan(label = "plan") {
  return parse(run(scripts.audit, [
    "init", "--workspace", workspace, "--plan-root", path.join(plans, label),
  ])).plan_path;
}

function add(plan, value) {
  run(scripts.audit, ["add-finding", "--plan", plan, "--file", jsonFile("finding", value)]);
}

function finishAudit(plan) {
  run(scripts.audit, ["finish", "--plan", plan]);
}

function decide(plan, id, decision) {
  run(scripts.review, [
    "decide", "--plan", plan, "--workspace", workspace,
    "--finding", id, "--decision", decision,
  ]);
}

function finishReview(plan) {
  run(scripts.review, ["finish", "--plan", plan, "--workspace", workspace]);
}

function preparePlan(plan, options = {}) {
  const args = ["prepare", "--plan", plan, "--workspace", workspace];
  if (options.backupRoot !== null) args.push("--backup-root", options.backupRoot || backups);
  return parse(run(scripts.apply, args, { env: options.env }));
}

function executePlan(plan, { expected = 0, env = {} } = {}) {
  const prepared = preparePlan(plan);
  return parse(run(scripts.apply, [
    "execute", "--plan", plan, "--workspace", workspace, "--backup", prepared.backup_path,
  ], { expected, env }));
}

function createReviewedPlan(label, findings) {
  const plan = initPlan(label);
  for (const item of findings) add(plan, item);
  finishAudit(plan);
  for (const item of findings) decide(plan, item.id, item.decision === "pending" ? "apply" : item.decision);
  finishReview(plan);
  return plan;
}

function resetWorkspace() {
  fs.rmSync(workspace, { recursive: true, force: true });
  write(path.join(workspace, "USER.md"), "# User\n\nPrefers tea.\n", 0o640);
  write(path.join(workspace, "MEMORY.md"), "# Memory\n\nDurable note.\n");
  write(path.join(workspace, "skills/example/SKILL.md"), "---\nname: example\ndescription: Example.\n---\n");
  write(path.join(workspace, "skills/example/old.txt"), "move me\n");
  write(path.join(workspace, "skills/example/remove.txt"), "remove me\n");
  write(path.join(workspace, "skills/example/untouched.txt"), "keep me\n");
  fs.mkdirSync(otherWorkspace, { recursive: true });
}

try {
  resetWorkspace();
  write(path.join(bin, "openclaw"), "#!/bin/sh\nprintf 'validated\\n'\n", 0o755);

  // Defaults follow OpenClaw's state-directory resolution.
  const configuredState = path.join(root, "configured-state");
  const legacyXdgState = path.join(root, "legacy-xdg-state");
  const statePlan = parse(run(scripts.audit, ["init", "--workspace", workspace], {
    env: { OPENCLAW_STATE_DIR: configuredState, XDG_STATE_HOME: legacyXdgState },
  })).plan_path;
  assert.ok(statePlan.startsWith(`${path.join(fs.realpathSync(configuredState), "agent-cleanup")}${path.sep}`));

  const configuredHome = path.join(root, "configured-home");
  const homePlan = parse(run(scripts.audit, ["init", "--workspace", workspace], {
    env: { OPENCLAW_STATE_DIR: "", OPENCLAW_HOME: configuredHome, XDG_STATE_HOME: "", HOME: path.join(root, "system-home") },
  })).plan_path;
  assert.ok(homePlan.startsWith(`${path.join(fs.realpathSync(configuredHome), ".openclaw", "agent-cleanup")}${path.sep}`));

  // Audit owns plan creation and validates every mutation.
  const auditPlan = initPlan("audit");
  let plan = JSON.parse(fs.readFileSync(auditPlan, "utf8"));
  assert.equal(plan.workspace, fs.realpathSync(workspace));
  assert.equal(plan.state, "draft");
  assert.deepEqual(plan.findings, []);
  add(auditPlan, finding("F001", [{ type: "write_file", path: "USER.md", content: "# User\n\nPrefers coffee.\n" }]));
  run(scripts.audit, ["add-finding", "--plan", auditPlan, "--file", jsonFile("duplicate", finding("F001", []))], { expected: 1 });
  const beforeMalformed = fs.readFileSync(auditPlan, "utf8");
  run(scripts.audit, ["add-finding", "--plan", auditPlan, "--file", jsonFile("malformed", finding("BAD", [{ type: "command", command: "rm -rf /" }]))], { expected: 1 });
  assert.equal(fs.readFileSync(auditPlan, "utf8"), beforeMalformed);
  run(scripts.audit, ["replace-finding", "--plan", auditPlan, "--file", jsonFile("replacement", finding("F001", [{ type: "remove_path", path: "skills/example/remove.txt" }]))]);
  finishAudit(auditPlan);

  // Review exposes one pending item, reopens edited decisions, and owns finalization.
  assert.equal(parse(run(scripts.review, ["next", "--plan", auditPlan, "--workspace", workspace])).id, "F001");
  run(scripts.review, ["next", "--plan", auditPlan, "--workspace", otherWorkspace], { expected: 1 });
  decide(auditPlan, "F001", "defer");
  assert.equal(parse(run(scripts.review, ["next", "--plan", auditPlan, "--workspace", workspace])).finding, null);
  run(scripts.review, ["replace-finding", "--plan", auditPlan, "--workspace", workspace, "--file", jsonFile("review-replacement", finding("F001", [{ type: "remove_path", path: "skills/example/remove.txt" }], { decision: "dismiss" }))]);
  plan = JSON.parse(fs.readFileSync(auditPlan, "utf8"));
  assert.equal(plan.findings[0].decision, "pending");
  run(scripts.review, ["finish", "--plan", auditPlan, "--workspace", workspace], { expected: 1 });
  run(scripts.review, ["add-finding", "--plan", auditPlan, "--workspace", workspace, "--file", jsonFile("new-finding", finding("F002", []))]);
  decide(auditPlan, "F001", "apply");
  decide(auditPlan, "F002", "dismiss");
  finishReview(auditPlan);
  assert.equal(JSON.parse(fs.readFileSync(auditPlan, "utf8")).state, "reviewed");
  run(scripts.review, ["replace-finding", "--plan", auditPlan, "--workspace", workspace, "--file", jsonFile("post-review-edit", finding("F001", [{ type: "remove_path", path: "skills/example/remove.txt" }]))]);
  plan = JSON.parse(fs.readFileSync(auditPlan, "utf8"));
  assert.equal(plan.state, "draft");
  assert.equal(plan.findings[0].decision, "pending");
  decide(auditPlan, "F001", "dismiss");
  finishReview(auditPlan);

  // Apply refuses drafts and prepares a change-scoped archive before mutation.
  const draft = initPlan("draft");
  run(scripts.apply, ["prepare", "--plan", draft, "--workspace", workspace, "--backup-root", backups], { expected: 1 });
  resetWorkspace();
  const applyPlan = createReviewedPlan("apply", [finding("F100", [
    { type: "write_file", path: "USER.md", content: "# User\n\nPrefers coffee.\n" },
    { type: "write_file", path: "skills/example/created.txt", content: "created\n" },
    { type: "move_path", from: "skills/example/old.txt", to: "skills/example/moved.txt" },
    { type: "remove_path", path: "skills/example/remove.txt" },
  ])]);
  run(scripts.apply, ["prepare", "--plan", applyPlan, "--workspace", otherWorkspace, "--backup-root", backups], { expected: 1 });
  const prepared = parse(run(scripts.apply, ["prepare", "--plan", applyPlan, "--workspace", workspace, "--backup-root", backups]));
  assert.ok(fs.existsSync(prepared.backup_path));
  const archive = spawnSync("tar", ["-tzf", prepared.backup_path], { encoding: "utf8" });
  assert.equal(archive.status, 0);
  assert.match(archive.stdout, /cleanup-plan\.json/);
  assert.match(archive.stdout, /workspace\/USER\.md/);
  assert.match(archive.stdout, /workspace\/skills\/example\/old\.txt/);
  assert.match(archive.stdout, /workspace\/skills\/example\/remove\.txt/);
  assert.doesNotMatch(archive.stdout, /untouched\.txt/);
  assert.equal(fs.readFileSync(path.join(workspace, "USER.md"), "utf8"), "# User\n\nPrefers tea.\n");

  run(scripts.apply, ["execute", "--plan", applyPlan, "--workspace", workspace], { expected: 1 });
  assert.equal(fs.readFileSync(path.join(workspace, "USER.md"), "utf8"), "# User\n\nPrefers tea.\n");
  const unrelatedPlan = createReviewedPlan("unrelated-backup", [finding("F101", [])]);
  const defaultBackup = preparePlan(unrelatedPlan, {
    backupRoot: null,
    env: { OPENCLAW_STATE_DIR: configuredState, XDG_STATE_HOME: legacyXdgState },
  });
  assert.ok(defaultBackup.backup_path.startsWith(`${path.join(fs.realpathSync(configuredState), "agent-cleanup", "backups")}${path.sep}`));
  const homeDefaultBackup = preparePlan(unrelatedPlan, {
    backupRoot: null,
    env: { OPENCLAW_STATE_DIR: "", OPENCLAW_HOME: configuredHome, XDG_STATE_HOME: "", HOME: path.join(root, "system-home") },
  });
  assert.ok(homeDefaultBackup.backup_path.startsWith(`${path.join(fs.realpathSync(configuredHome), ".openclaw", "agent-cleanup", "backups")}${path.sep}`));
  const unrelatedBackup = preparePlan(unrelatedPlan);
  run(scripts.apply, [
    "execute", "--plan", applyPlan, "--workspace", workspace, "--backup", unrelatedBackup.backup_path,
  ], { expected: 1 });
  assert.equal(fs.readFileSync(path.join(workspace, "USER.md"), "utf8"), "# User\n\nPrefers tea.\n");
  const executed = parse(run(scripts.apply, [
    "execute", "--plan", applyPlan, "--workspace", workspace, "--backup", prepared.backup_path,
  ]));
  assert.equal(executed.failures.length, 0);
  assert.equal(executed.successes.length, 4);
  assert.equal(executed.backup_path, fs.realpathSync(prepared.backup_path));
  assert.equal(fs.readFileSync(path.join(workspace, "USER.md"), "utf8"), "# User\n\nPrefers coffee.\n");
  assert.equal(fs.statSync(path.join(workspace, "USER.md")).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(workspace, "skills/example/created.txt")).mode & 0o111, 0);
  assert.equal(fs.readFileSync(path.join(workspace, "skills/example/moved.txt"), "utf8"), "move me\n");
  assert.equal(fs.existsSync(path.join(workspace, "skills/example/remove.txt")), false);
  assert.equal(executed.skill_validation.attempted, true);
  const preparedAgain = parse(run(scripts.apply, ["prepare", "--plan", applyPlan, "--workspace", workspace, "--backup-root", backups]));
  assert.notEqual(preparedAgain.backup_path, prepared.backup_path);
  const repeated = parse(run(scripts.apply, [
    "execute", "--plan", applyPlan, "--workspace", workspace, "--backup", preparedAgain.backup_path,
  ], { expected: 1 }));
  assert.equal(repeated.successes.length + repeated.failures.length, 4);

  // Invalid targets are rejected, and operation failures do not stop later work.
  resetWorkspace();
  const bestEffort = createReviewedPlan("best-effort", [finding("F200", [
    { type: "move_path", from: "skills/example/missing.txt", to: "skills/example/never.txt" },
    { type: "write_file", path: "skills/example/created.txt", content: "still ran\n" },
  ])]);
  const result = executePlan(bestEffort, { expected: 1 });
  assert.equal(result.failures.length, 1);
  assert.equal(result.successes.length, 1);
  assert.equal(fs.readFileSync(path.join(workspace, "skills/example/created.txt"), "utf8"), "still ran\n");

  // Ordered operations may establish a parent used by a later operation.
  resetWorkspace();
  write(path.join(workspace, "skills/example/staged/existing.txt"), "existing\n");
  const ordered = createReviewedPlan("ordered", [finding("F250", [
    { type: "move_path", from: "skills/example/staged", to: "skills/example/new-dir" },
    { type: "write_file", path: "skills/example/new-dir/created.txt", content: "created later\n" },
  ])]);
  const orderedResult = executePlan(ordered);
  assert.equal(orderedResult.failures.length, 0);
  assert.equal(fs.readFileSync(path.join(workspace, "skills/example/new-dir/created.txt"), "utf8"), "created later\n");

  const invalid = initPlan("invalid");
  for (const operation of [
    { type: "create_directory", path: "new-dir" },
    { type: "write_file", path: "../escape.txt", content: "escape\n" },
    { type: "write_file", path: "USER.md", content_base64: "AAE=" },
    { type: "chmod", path: "USER.md", mode: "777" },
  ]) {
    run(scripts.audit, ["add-finding", "--plan", invalid, "--file", jsonFile("invalid-operation", finding(crypto.randomUUID(), [operation]))], { expected: 1 });
  }
  fs.symlinkSync("SKILL.md", path.join(workspace, "skills/example/skill-link"));
  run(scripts.audit, ["add-finding", "--plan", invalid, "--file", jsonFile("symlink-operation", finding("SYMLINK", [{ type: "remove_path", path: "skills/example/skill-link" }]))], { expected: 1 });
  for (const [id, operation] of [
    ["OUT-OF-SCOPE", { type: "write_file", path: "notes.txt", content: "not workspace knowledge\n" }],
    ["DATED-MEMORY", { type: "remove_path", path: "memory/2026-07-19.md" }],
    ["SELF-CLEANUP", { type: "remove_path", path: "skills/agent-cleanup-audit" }],
    ["MOVE-OUT-OF-SCOPE", { type: "move_path", from: "USER.md", to: "notes.txt" }],
    ["WORKSPACE-SKILL-ROOT", { type: "remove_path", path: "skills/" }],
    ["PROJECT-AGENT-SKILL-ROOT", { type: "remove_path", path: ".agents/skills/" }],
  ]) {
    run(scripts.audit, ["add-finding", "--plan", invalid, "--file", jsonFile("invalid-scope", finding(id, [operation]))], { expected: 1 });
  }
  add(invalid, finding("PROJECT-AGENT-SKILL", [{
    type: "write_file", path: ".agents/skills/example/SKILL.md", content: "---\nname: example\ndescription: Example.\n---\n",
  }]));
  fs.writeFileSync(path.join(workspace, "skills/example/binary.dat"), Buffer.from([0, 1, 2, 255]));
  run(scripts.audit, ["add-finding", "--plan", invalid, "--file", jsonFile("binary-operation", finding("BINARY", [{ type: "write_file", path: "skills/example/binary.dat", content: "text\n" }]))], { expected: 1 });
  finishAudit(invalid);
  run(scripts.review, [
    "add-finding", "--plan", invalid, "--workspace", workspace, "--file",
    jsonFile("review-invalid-scope", finding("REVIEW-OUT-OF-SCOPE", [{ type: "remove_path", path: "notes.txt" }])),
  ], { expected: 1 });
  for (const [id, target] of [["REVIEW-WORKSPACE-SKILL-ROOT", "skills/"], ["REVIEW-PROJECT-AGENT-SKILL-ROOT", ".agents/skills/"]]) {
    run(scripts.review, [
      "add-finding", "--plan", invalid, "--workspace", workspace, "--file",
      jsonFile("review-invalid-root", finding(id, [{ type: "remove_path", path: target }])),
    ], { expected: 1 });
  }

  const applyInvalidScope = createReviewedPlan("apply-invalid-scope", [finding("F260", [{
    type: "write_file", path: "USER.md", content: "# User\n\nStill safe.\n",
  }])]);
  const editedApplyPlan = JSON.parse(fs.readFileSync(applyInvalidScope, "utf8"));
  for (const target of ["notes.txt", "skills/", ".agents/skills/"]) {
    editedApplyPlan.findings[0].operations[0].path = target;
    fs.writeFileSync(applyInvalidScope, `${JSON.stringify(editedApplyPlan, null, 2)}\n`);
    run(scripts.apply, ["prepare", "--plan", applyInvalidScope, "--workspace", workspace, "--backup-root", backups], { expected: 1 });
  }

  const replaceBinary = createReviewedPlan("replace-binary", [finding("F275", [
    { type: "remove_path", path: "skills/example/binary.dat" },
    { type: "write_file", path: "skills/example/binary.dat", content: "now text\n" },
  ])]);
  const replaceBinaryResult = executePlan(replaceBinary);
  assert.equal(replaceBinaryResult.failures.length, 0);
  assert.equal(fs.readFileSync(path.join(workspace, "skills/example/binary.dat"), "utf8"), "now text\n");
  resetWorkspace();
  fs.writeFileSync(path.join(workspace, "skills/example/binary.dat"), Buffer.from([0, 1, 2, 255]));
  write(path.join(workspace, "skills/example/text.txt"), "text source\n");
  const moveOverBinary = createReviewedPlan("move-over-binary", [finding("F276", [
    { type: "remove_path", path: "skills/example/binary.dat" },
    { type: "move_path", from: "skills/example/text.txt", to: "skills/example/binary.dat" },
    { type: "write_file", path: "skills/example/binary.dat", content: "updated text\n" },
  ])]);
  executePlan(moveOverBinary);
  assert.equal(fs.readFileSync(path.join(workspace, "skills/example/binary.dat"), "utf8"), "updated text\n");
  fs.mkdirSync(path.join(workspace, "skills/example/binary-dir"));
  fs.writeFileSync(path.join(workspace, "skills/example/binary-dir/file.dat"), Buffer.from([0, 1, 2, 255]));
  write(path.join(workspace, "skills/example/text-dir/file.dat"), "directory text\n");
  const moveDirectoryOverBinary = createReviewedPlan("move-directory-over-binary", [finding("F277", [
    { type: "remove_path", path: "skills/example/binary-dir" },
    { type: "move_path", from: "skills/example/text-dir", to: "skills/example/binary-dir" },
    { type: "write_file", path: "skills/example/binary-dir/file.dat", content: "updated directory text\n" },
  ])]);
  executePlan(moveDirectoryOverBinary);
  assert.equal(fs.readFileSync(path.join(workspace, "skills/example/binary-dir/file.dat"), "utf8"), "updated directory text\n");

  // Directory moves and removals do not dereference contained links.
  resetWorkspace();
  const external = path.join(root, "external.txt");
  write(external, "outside\n");
  write(path.join(workspace, "skills/example/tree/file.txt"), "inside\n");
  fs.symlinkSync(external, path.join(workspace, "skills/example/tree/external-link"));
  const moveDirectory = createReviewedPlan("move-directory", [finding("F300", [{ type: "move_path", from: "skills/example/tree", to: "skills/example/moved-tree" }])]);
  executePlan(moveDirectory);
  assert.equal(fs.readFileSync(external, "utf8"), "outside\n");
  const removeDirectory = createReviewedPlan("remove-directory", [finding("F301", [{ type: "remove_path", path: "skills/example/moved-tree" }])]);
  executePlan(removeDirectory);
  assert.equal(fs.readFileSync(external, "utf8"), "outside\n");

  // Each operation rechecks live symlink topology after earlier operations.
  resetWorkspace();
  write(external, "outside\n");
  write(path.join(workspace, "skills/example/source-dir/file.txt"), "inside\n");
  fs.symlinkSync(external, path.join(workspace, "skills/example/source-dir/link"));
  write(path.join(workspace, "skills/example/dest/old.txt"), "old\n");
  const liveSymlink = createReviewedPlan("live-symlink", [finding("F350", [
    { type: "remove_path", path: "skills/example/dest" },
    { type: "move_path", from: "skills/example/source-dir", to: "skills/example/dest" },
    { type: "write_file", path: "skills/example/dest/link", content: "must not escape\n" },
  ])]);
  const liveResult = executePlan(liveSymlink, { expected: 1 });
  assert.equal(liveResult.successes.length, 2);
  assert.match(liveResult.failures[0].error, /symlink/);
  assert.equal(fs.readFileSync(external, "utf8"), "outside\n");

  // Skill Validation is advisory on failure and unavailability.
  resetWorkspace();
  const skillPlan = createReviewedPlan("skill", [finding("F400", [{
    type: "write_file", path: "skills/example/SKILL.md", content: "---\nname: example\ndescription: Fixed.\n---\n",
  }])]);
  write(path.join(bin, "openclaw"), "#!/bin/sh\nprintf 'validator failed\\n' >&2\nexit 7\n", 0o755);
  const skillResult = executePlan(skillPlan);
  assert.equal(skillResult.skill_validation.available, true);
  assert.equal(skillResult.skill_validation.exit_code, 7);
  assert.equal(skillResult.failures.length, 0);
  resetWorkspace();
  write(path.join(workspace, ".agents/skills/example/existing.txt"), "project-agent skill\n");
  const projectAgentSkillPlan = createReviewedPlan("project-agent-skill", [finding("F401", [{
    type: "write_file", path: ".agents/skills/example/SKILL.md", content: "---\nname: example\ndescription: Project agent skill.\n---\n",
  }])]);
  const projectAgentSkillResult = executePlan(projectAgentSkillPlan);
  assert.equal(projectAgentSkillResult.skill_validation.attempted, true);
  assert.equal(projectAgentSkillResult.skill_validation.exit_code, 7);
  resetWorkspace();
  const unavailablePlan = createReviewedPlan("skill-unavailable", [finding("F402", [{
    type: "write_file", path: "skills/example/SKILL.md", content: "---\nname: example\ndescription: Still fixed.\n---\n",
  }])]);
  fs.rmSync(path.join(bin, "openclaw"));
  const unavailableResult = executePlan(unavailablePlan);
  assert.equal(unavailableResult.skill_validation.available, false);
  assert.equal(unavailableResult.failures.length, 0);

  // Each distribution works with no sibling directories present.
  for (const [phase, source] of Object.entries(scripts)) {
    const isolated = path.join(root, `isolated-${phase}.mjs`);
    fs.copyFileSync(source, isolated);
    const result = spawnSync(process.execPath, [isolated], { encoding: "utf8" });
    assert.notEqual(result.status, null);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  }

  // Tar failure aborts prepare without touching the workspace.
  resetWorkspace();
  const tarPlan = createReviewedPlan("tar-failure", [finding("F500", [{ type: "remove_path", path: "skills/example/remove.txt" }])]);
  run(scripts.apply, ["prepare", "--plan", tarPlan, "--workspace", workspace, "--backup-root", backups], { expected: 1, env: { PATH: bin } });
  assert.equal(fs.existsSync(path.join(workspace, "skills/example/remove.txt")), true);
  write(path.join(bin, "tar"), "#!/bin/sh\nprintf 'archive failed\\n' >&2\nexit 9\n", 0o755);
  run(scripts.apply, ["prepare", "--plan", tarPlan, "--workspace", workspace, "--backup-root", backups], { expected: 1, env: { PATH: bin } });
  assert.equal(fs.existsSync(path.join(workspace, "skills/example/remove.txt")), true);

  console.log("all tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
