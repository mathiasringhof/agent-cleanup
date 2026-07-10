#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
const auditScript = path.join(repo, "agent-cleanup-audit/scripts/audit-run.mjs");
const reviewScript = path.join(repo, "agent-cleanup-review/scripts/review-run.mjs");
const applyScript = path.join(repo, "agent-cleanup-apply/scripts/apply-run.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cleanup-tests-"));
const workspace = path.join(root, "workspace");
const state = path.join(root, "state");
const bin = path.join(root, "bin");

function run(script, arguments_, expected = 0) {
  const result = spawnSync(process.execPath, [script, ...arguments_, "--state-root", state], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, expected, `${path.basename(script)} ${arguments_.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture(name, value) {
  const file = path.join(root, `${name}-${crypto.randomBytes(3).toString("hex")}.json`);
  write(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function initWorkspace() {
  write(path.join(bin, "openclaw"), "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
  fs.chmodSync(path.join(bin, "openclaw"), 0o755);
  write(path.join(workspace, "AGENTS.md"), "# Rules\n\nKeep durable facts in MEMORY.md.\n");
  write(path.join(workspace, "USER.md"), "# User\n\nPrefers tea.\n");
  write(path.join(workspace, "MEMORY.md"), "# Memory\n\nThe user prefers tea.\n");
  write(path.join(workspace, "BOOTSTRAP.md"), "# Bootstrap\n\nFirst run only.\n");
  write(path.join(workspace, "memory/2026-07-09.md"), "Historical note.\n");
  write(path.join(workspace, "skills/example/SKILL.md"), "---\nname: example\ndescription: Example workflow.\n---\n\nDo the example.\n");
  write(path.join(workspace, "skills/agent-cleanup-audit/SKILL.md"), "---\nname: agent-cleanup-audit\ndescription: Protected cleanup skill.\n---\n");
}

function initAudit() {
  const output = JSON.parse(run(auditScript, ["init", "--target", workspace]).stdout);
  assert.match(output.run_id, /^[a-f0-9]{12}$/);
  assert.equal(output.target_root, fs.realpathSync(workspace));
  return output;
}

function finishAudit(output, summary, paths) {
  const runDir = output.run_dir;
  const inventory = JSON.parse(fs.readFileSync(path.join(runDir, "inventory.json")));
  run(auditScript, ["add-finding", "--run", output.run_id, "--file", fixture("finding", {
    id: "A001", category: "duplicate", confidence: "high", paths,
    summary, evidence: "Fixture evidence", recommendation: "Apply fixture change", requires_user: true,
  })]);
  for (const item of inventory.source_manifest) run(auditScript, ["cover", "--run", output.run_id, "--file", fixture("coverage", { path: item.path, status: "inspected" })]);
  write(path.join(runDir, "audit.md"), `# Audit\n\nTarget reviewed completely.\n\n${summary}\n`);
  run(auditScript, ["seal", "--run", output.run_id]);
  run(reviewScript, ["init", "--run", output.run_id]);
  return output;
}

function newAudit(summary, paths) { return finishAudit(initAudit(), summary, paths); }

function decide(output, input, operations = []) {
  const operationFiles = operations.map((operation) => {
    const file = fixture("operation", operation);
    return path.relative(path.dirname(file), file);
  });
  const decision = fixture("decision", { ...input, operations: operationFiles });
  run(reviewScript, ["decide", "--run", output.run_id, "--file", decision]);
}

function approveReplace(output, targetPath, payloadContents) {
  const payload = `payload/${crypto.randomBytes(4).toString("hex")}`;
  write(path.join(output.run_dir, payload), payloadContents);
  decide(output, {
    finding_id: "A001", decision: "apply", rationale: "User approved fixture edit",
    strategies: { [targetPath]: "surgical" },
  }, [{ id: "C001", type: "replace_file", path: targetPath, payload }]);
  run(reviewScript, ["seal", "--run", output.run_id]);
}

try {
  initWorkspace();
  const contract = fs.readFileSync(path.join(repo, "docs/artifact-contract.md"));
  for (const skill of ["agent-cleanup-audit", "agent-cleanup-review", "agent-cleanup-apply"]) {
    assert.ok(fs.readFileSync(path.join(repo, skill, "references/artifact-contract.md")).equals(contract));
    assert.doesNotMatch(fs.readFileSync(path.join(repo, skill, "SKILL.md"), "utf8"), /Codex|\/tmp\/openclaw-agent-cleanup/);
  }

  const incomplete = initAudit();
  run(auditScript, ["seal", "--run", incomplete.run_id], 1);
  const inventoryBefore = fs.readFileSync(path.join(incomplete.run_dir, "inventory.json"), "utf8");
  const malformedFinding = fixture("finding", { id: "bad", category: "nope" });
  run(auditScript, ["add-finding", "--run", incomplete.run_id, "--file", malformedFinding], 1);
  run(auditScript, ["add-finding", "--run", incomplete.run_id, "--file", fixture("finding", {
    id: "A999", category: "duplicate", confidence: "high", paths: ["../outside"], summary: "Bad", evidence: "Bad", recommendation: "Bad", requires_user: true,
  })], 1);
  assert.equal(fs.readFileSync(path.join(incomplete.run_dir, "inventory.json"), "utf8"), inventoryBefore);

  const reviewable = newAudit("Review resume", ["USER.md"]);
  assert.equal(JSON.parse(run(reviewScript, ["status", "--run", reviewable.run_id]).stdout).pending, 1);
  assert.equal(JSON.parse(run(reviewScript, ["next-pending", "--run", reviewable.run_id]).stdout).id, "A001");
  assert.equal(JSON.parse(run(reviewScript, ["init", "--run", reviewable.run_id]).stdout).resumed, true);
  decide(reviewable, { finding_id: "A001", decision: "defer", rationale: "Wait" });
  run(reviewScript, ["revise", "--run", reviewable.run_id, "--finding", "A001"]);
  assert.equal(JSON.parse(run(reviewScript, ["status", "--run", reviewable.run_id]).stdout).pending, 1);
  write(path.join(workspace, "skills/unrelated-note.txt"), "Unrelated active work.\n");
  const refreshed = JSON.parse(run(reviewScript, ["refresh", "--run", reviewable.run_id, "--file", fixture("refresh", {
    changed_paths: ["skills/unrelated-note.txt"], coverage: [{ path: "skills/unrelated-note.txt", status: "inventory-only" }],
  })]).stdout);
  assert.deepEqual(refreshed.changed_paths, ["skills/unrelated-note.txt"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(reviewable.run_dir, "plan.json"))).refresh_history.length, 1);

  const binding = newAudit("Bound change", ["USER.md"]);
  const payload = "payload/bad";
  write(path.join(binding.run_dir, payload), "# Memory\n\nBad.\n");
  const badOp = fixture("operation", { id: "C001", type: "replace_file", path: "MEMORY.md", payload });
  const badDecision = fixture("decision", { finding_id: "A001", decision: "apply", rationale: "Bad scope", strategies: { "MEMORY.md": "rewrite" }, operations: [path.relative(root, badOp)] });
  run(reviewScript, ["decide", "--run", binding.run_id, "--file", badDecision], 1);
  run(reviewScript, ["approve-expansion", "--run", binding.run_id, "--file", fixture("expansion", { finding_id: "A001", paths: ["MEMORY.md"], rationale: "Related duplicate location" })]);
  const expandedDecision = fixture("decision", { finding_id: "A001", decision: "apply", rationale: "Approved related edit", scope_expansion: ["MEMORY.md"], strategies: { "MEMORY.md": "rewrite" }, operations: [path.basename(badOp)] });
  run(reviewScript, ["decide", "--run", binding.run_id, "--file", expandedDecision]);

  const batchAudit = initAudit();
  const batchInventory = JSON.parse(fs.readFileSync(path.join(batchAudit.run_dir, "inventory.json")));
  for (const [id, affected] of [["A001", "USER.md"], ["A002", "MEMORY.md"]]) run(auditScript, ["add-finding", "--run", batchAudit.run_id, "--file", fixture("finding", {
    id, category: "duplicate", confidence: "high", paths: [affected], summary: "Matching duplicate", evidence: "Fixture evidence", recommendation: "Review duplicate", requires_user: true,
  })]);
  for (const item of batchInventory.source_manifest) run(auditScript, ["cover", "--run", batchAudit.run_id, "--file", fixture("coverage", { path: item.path, status: "inspected" })]);
  write(path.join(batchAudit.run_dir, "audit.md"), "# Audit\n\nMatching duplicate findings reviewed completely.\n");
  run(auditScript, ["seal", "--run", batchAudit.run_id]);
  run(reviewScript, ["init", "--run", batchAudit.run_id]);
  run(reviewScript, ["batch-decide", "--run", batchAudit.run_id, "--file", fixture("batch", {
    matched: [{ finding_id: "A001", paths: ["USER.md"] }, { finding_id: "A002", paths: ["MEMORY.md"] }],
    decisions: [{ finding_id: "A001", decision: "defer", rationale: "Batch wait" }, { finding_id: "A002", decision: "defer", rationale: "Batch wait" }],
  })]);
  assert.equal(JSON.parse(run(reviewScript, ["status", "--run", batchAudit.run_id]).stdout).pending, 0);
  const batchPlanBefore = fs.readFileSync(path.join(batchAudit.run_dir, "plan.json"));
  const batchDecisionBefore = fs.readFileSync(path.join(batchAudit.run_dir, "decisions/A001.json"));
  run(reviewScript, ["batch-decide", "--run", batchAudit.run_id, "--file", fixture("batch", {
    matched: [{ finding_id: "A001", paths: ["USER.md"] }, { finding_id: "A002", paths: ["MEMORY.md"] }],
    decisions: [{ finding_id: "A001", decision: "dismiss", rationale: "Invalid redo" }, { finding_id: "A002", decision: "dismiss", rationale: "Invalid redo" }],
  })], 1);
  assert.ok(fs.readFileSync(path.join(batchAudit.run_dir, "plan.json")).equals(batchPlanBefore));
  assert.ok(fs.readFileSync(path.join(batchAudit.run_dir, "decisions/A001.json")).equals(batchDecisionBefore));

  const attribution = newAudit("Attribution check", ["USER.md"]);
  decide(attribution, { finding_id: "A001", decision: "defer", rationale: "No operation approved" });
  const attributionPlanFile = path.join(attribution.run_dir, "plan.json");
  const attributionPlan = JSON.parse(fs.readFileSync(attributionPlanFile));
  attributionPlan.operations.push({ id: "C999", type: "remove_path", path: "USER.md", expected_before: attributionPlan.source_manifest.find((item) => item.path === "USER.md").sha256 });
  fs.writeFileSync(attributionPlanFile, `${JSON.stringify(attributionPlan, null, 2)}\n`);
  run(reviewScript, ["seal", "--run", attribution.run_id], 1);

  const happy = newAudit("Deduplicate user preference", ["USER.md", "MEMORY.md"]);
  approveReplace(happy, "USER.md", "# User\n\nPrefers coffee.\n");
  run(applyScript, ["preflight", "--run", happy.run_id]);
  const applied = JSON.parse(run(applyScript, ["apply", "--run", happy.run_id]).stdout);
  assert.match(fs.readFileSync(path.join(workspace, "USER.md"), "utf8"), /coffee/);
  assert.equal(applied.status, "applied");
  assert.ok(applied.plan_sha256 && applied.post_apply_manifest.length);
  assert.ok(fs.existsSync(path.join(happy.run_dir, "result.sha256")));
  assert.equal(JSON.parse(run(applyScript, ["apply", "--run", happy.run_id]).stdout).historical, true);
  fs.appendFileSync(path.join(workspace, "AGENTS.md"), "Later drift.\n");
  assert.equal(JSON.parse(run(applyScript, ["preflight", "--run", happy.run_id]).stdout).current_workspace_matches, false);
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# Rules\n\nKeep durable facts in MEMORY.md.\n");

  const drift = newAudit("Change memory", ["MEMORY.md"]);
  approveReplace(drift, "MEMORY.md", "# Memory\n\nUpdated.\n");
  fs.appendFileSync(path.join(workspace, "MEMORY.md"), "Concurrent change.\n");
  run(applyScript, ["preflight", "--run", drift.run_id], 1);

  const skill = newAudit("Fix skill", ["skills/example/SKILL.md"]);
  const originalSkill = fs.readFileSync(path.join(workspace, "skills/example/SKILL.md"), "utf8");
  approveReplace(skill, "skills/example/SKILL.md", "---\nname: example\ndescription: Fixed.\n---\n\nFixed.\n");
  fs.writeFileSync(path.join(bin, "openclaw"), "#!/bin/sh\nexit 1\n");
  const failed = run(applyScript, ["apply", "--run", skill.run_id], 1);
  assert.match(failed.stderr, /authoritative OpenClaw skill validation/);
  assert.equal(fs.readFileSync(path.join(workspace, "skills/example/SKILL.md"), "utf8"), originalSkill);

  const retained = JSON.parse(run(auditScript, ["list"]).stdout);
  assert.ok(retained.runs.some((item) => item.run_id === happy.run_id));
  const preview = JSON.parse(run(auditScript, ["prune", "--run", incomplete.run_id]).stdout);
  assert.equal(preview.confirmed, false);
  assert.ok(fs.existsSync(incomplete.run_dir));
  run(auditScript, ["prune", "--run", incomplete.run_id, "--confirm"]);
  assert.equal(fs.existsSync(incomplete.run_dir), false);

  console.log("all tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
