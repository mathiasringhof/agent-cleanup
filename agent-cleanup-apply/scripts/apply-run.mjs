#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) result._.push(value);
    else {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) result[key] = true;
      else { result[key] = next; index += 1; }
    }
  }
  return result;
}

function fail(message) { throw new Error(message); }

function expandTilde(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function openClawStateDirectory() {
  const systemHome = process.env.HOME || os.homedir();
  const openClawHome = path.resolve(expandTilde(process.env.OPENCLAW_HOME || systemHome, systemHome));
  if (process.env.OPENCLAW_STATE_DIR) return path.resolve(expandTilde(process.env.OPENCLAW_STATE_DIR, systemHome));
  return path.join(openClawHome, ".openclaw");
}

function safePath(value, label = "path") {
  if (typeof value !== "string" || !value || value.includes("\0")) fail(`${label} must be a non-empty relative path`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) fail(`${label} must stay inside the workspace`);
  return normalized;
}

const rootKnowledgeFiles = new Set([
  "SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "TOOLS.md",
  "HEARTBEAT.md", "MEMORY.md", "BOOTSTRAP.md",
]);
const cleanupSkillNames = new Set(["audit", "review", "apply"].map((phase) => `agent-cleanup-${phase}`));

function cleanupScopePath(value, label = "path") {
  const relative = safePath(value, label);
  if (rootKnowledgeFiles.has(relative)) return relative;
  const skillRoot = relative.startsWith("skills/")
    ? "skills/"
    : relative.startsWith(".agents/skills/") ? ".agents/skills/" : null;
  if (!skillRoot) fail(`${label} is outside the cleanup scope: ${relative}`);
  const skillRelative = relative.slice(skillRoot.length);
  if (!skillRelative) fail(`${label} must target a skill-root descendant: ${relative}`);
  const skillParts = skillRelative.split("/");
  if (skillParts.some((part) => cleanupSkillNames.has(part))) fail(`${label} targets the agent-cleanup suite: ${relative}`);
  return relative;
}

function rejectSymlinkTraversal(workspace, relative) {
  const parts = safePath(relative).split("/");
  let current = workspace;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`operation path traverses or targets a symlink: ${relative}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      break;
    }
  }
}

function rejectBinaryRewrite(workspace, relative) {
  const target = path.join(workspace, relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return;
  const contents = fs.readFileSync(target);
  if (contents.includes(0)) fail(`write_file cannot rewrite a binary file: ${relative}`);
  try { new TextDecoder("utf-8", { fatal: true }).decode(contents); }
  catch { fail(`write_file cannot rewrite a binary file: ${relative}`); }
}

function validateOperation(operation, workspace) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) fail("operation must be an object");
  let allowed;
  if (operation.type === "write_file") {
    cleanupScopePath(operation.path);
    if (typeof operation.content !== "string" || operation.content.includes("\0")) fail("write_file requires complete text content");
    rejectSymlinkTraversal(workspace, operation.path);
    allowed = new Set(["type", "path", "content"]);
  } else if (operation.type === "move_path") {
    cleanupScopePath(operation.from, "move source"); cleanupScopePath(operation.to, "move destination");
    rejectSymlinkTraversal(workspace, operation.from); rejectSymlinkTraversal(workspace, operation.to);
    allowed = new Set(["type", "from", "to"]);
  } else if (operation.type === "remove_path") {
    cleanupScopePath(operation.path); rejectSymlinkTraversal(workspace, operation.path);
    allowed = new Set(["type", "path"]);
  } else fail(`unsupported operation type: ${operation.type || "missing"}`);
  for (const key of Object.keys(operation)) if (!allowed.has(key)) fail(`unsupported operation field: ${key}`);
}

function loadPlan(options) {
  if (!options.plan || !options.workspace) fail("--plan and --workspace are required");
  const planPath = path.resolve(options.plan);
  if (fs.lstatSync(planPath).isSymbolicLink()) fail("cleanup plan cannot be a symlink");
  const planContents = fs.readFileSync(planPath);
  const plan = JSON.parse(planContents);
  const workspace = fs.realpathSync(path.resolve(options.workspace));
  if (plan.workspace !== workspace) fail("cleanup plan belongs to a different workspace");
  if (planPath === workspace || planPath.startsWith(`${workspace}${path.sep}`)) fail("cleanup plan must stay outside the workspace");
  if (plan.state !== "reviewed" || !plan.audit_complete || !Array.isArray(plan.findings)) fail("apply requires a reviewed cleanup plan");
  const operations = [];
  for (const finding of plan.findings) {
    if (!finding || typeof finding.id !== "string" || !["apply", "defer", "dismiss"].includes(finding.decision) || !Array.isArray(finding.operations)) fail("cleanup plan contains an invalid finding");
    for (let index = 0; index < finding.operations.length; index += 1) {
      validateOperation(finding.operations[index], workspace);
      if (finding.decision === "apply") operations.push({ findingId: finding.id, index, operation: finding.operations[index] });
    }
  }
  return { planPath, plan, planContents, workspace, operations };
}

function operationPaths(operation) {
  if (operation.type === "move_path") return [operation.from, operation.to];
  return [operation.path];
}

function existingBackupRoots(workspace, operations) {
  const candidates = [];
  for (const { operation } of operations) {
    for (const relative of operationPaths(operation)) {
      const absolute = path.join(workspace, relative);
      try { fs.lstatSync(absolute); candidates.push(relative); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  const unique = [...new Set(candidates)].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  return unique.filter((candidate, index) => !unique.slice(0, index).some((parent) => candidate.startsWith(`${parent}/`)));
}

function prepare(options) {
  const context = loadPlan(options);
  const requestedRoot = path.resolve(options["backup-root"] || path.join(openClawStateDirectory(), "agent-cleanup", "backups"));
  fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const backupRoot = fs.realpathSync(requestedRoot);
  if (backupRoot === context.workspace || backupRoot.startsWith(`${context.workspace}${path.sep}`)) fail("backup root must be outside the workspace");
  const staging = fs.mkdtempSync(path.join(backupRoot, ".prepare-"));
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const archivePath = path.join(backupRoot, `agent-cleanup-${stamp}-${crypto.randomBytes(4).toString("hex")}.tar.gz`);
  try {
    fs.copyFileSync(context.planPath, path.join(staging, "cleanup-plan.json"));
    fs.mkdirSync(path.join(staging, "workspace"), { mode: 0o700 });
    const roots = existingBackupRoots(context.workspace, context.operations);
    for (const relative of roots) {
      const destination = path.join(staging, "workspace", relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.join(context.workspace, relative), destination, { recursive: true, dereference: false, preserveTimestamps: true });
    }
    const tar = spawnSync("tar", ["-czf", archivePath, "-C", staging, "cleanup-plan.json", "workspace"], { encoding: "utf8" });
    if (tar.error) fail(`backup creation failed: ${tar.error.message}`);
    if (tar.status !== 0) fail(`backup creation failed: ${(tar.stderr || tar.stdout).trim() || `tar exited ${tar.status}`}`);
    console.log(JSON.stringify({ backup_path: archivePath, paths: roots }, null, 2));
  } catch (error) {
    try { fs.rmSync(archivePath, { force: true }); } catch { /* preserve original error */ }
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function operationLabel(item) {
  return `${item.findingId}:${item.index + 1}:${item.operation.type}`;
}

function verifyPreparedBackup(context, options) {
  if (!options.backup) fail("execute requires the backup path returned by prepare");
  const backupPath = path.resolve(options.backup);
  if (fs.lstatSync(backupPath).isSymbolicLink()) fail("change backup cannot be a symlink");
  const realBackupPath = fs.realpathSync(backupPath);
  if (!fs.statSync(realBackupPath).isFile()) fail("change backup must be a regular file");
  if (realBackupPath === context.workspace || realBackupPath.startsWith(`${context.workspace}${path.sep}`)) fail("change backup must stay outside the workspace");
  const planContents = context.planContents;
  const extracted = spawnSync("tar", ["-xOzf", realBackupPath, "cleanup-plan.json"], {
    maxBuffer: Math.max(10 * 1024 * 1024, planContents.length * 2),
  });
  if (extracted.error) fail(`change backup verification failed: ${extracted.error.message}`);
  if (extracted.status !== 0) fail(`change backup verification failed: ${extracted.stderr.toString().trim() || `tar exited ${extracted.status}`}`);
  if (!planContents.equals(extracted.stdout)) fail("change backup contains a different cleanup plan");
  return realBackupPath;
}

function replaceFileAtomically(target, content, permissionMode) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.agent-cleanup-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fchmodSync(descriptor, permissionMode & 0o7777);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve original error */ }
    }
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

function executeOperation(workspace, operation) {
  validateOperation(operation, workspace);
  if (operation.type === "write_file") {
    const target = path.join(workspace, operation.path);
    rejectBinaryRewrite(workspace, operation.path);
    const parent = path.dirname(target);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) fail(`parent directory does not exist: ${operation.path}`);
    if (fs.existsSync(target)) {
      const targetStat = fs.statSync(target);
      if (!targetStat.isFile()) fail(`write target is not a regular file: ${operation.path}`);
      replaceFileAtomically(target, operation.content, targetStat.mode);
    } else fs.writeFileSync(target, operation.content, { mode: 0o644, flag: "wx" });
  } else if (operation.type === "move_path") {
    const source = path.join(workspace, operation.from);
    const destination = path.join(workspace, operation.to);
    if (!fs.existsSync(source)) fail(`move source does not exist: ${operation.from}`);
    if (fs.existsSync(destination)) fail(`move destination already exists: ${operation.to}`);
    if (!fs.existsSync(path.dirname(destination)) || !fs.statSync(path.dirname(destination)).isDirectory()) fail(`move destination parent does not exist: ${operation.to}`);
    fs.renameSync(source, destination);
  } else {
    const target = path.join(workspace, operation.path);
    if (!fs.existsSync(target)) fail(`remove target does not exist: ${operation.path}`);
    fs.rmSync(target, { recursive: true, force: false });
  }
}

function skillValidation(workspace, operations) {
  const changesSkills = operations.some(({ operation }) => operationPaths(operation).some((relative) => (
    relative.startsWith("skills/") || relative.startsWith(".agents/skills/")
  )));
  if (!changesSkills) return { attempted: false, available: null, exit_code: null, stdout: "", stderr: "" };
  const result = spawnSync("openclaw", ["skills", "check", "--json"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
  return {
    attempted: true,
    available: result.error?.code !== "ENOENT",
    exit_code: result.error?.code === "ENOENT" ? null : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function execute(options) {
  const context = loadPlan(options);
  const backupPath = verifyPreparedBackup(context, options);
  const successes = [];
  const failures = [];
  const skipped = [];
  const attempted = [];
  const failedFindingIds = new Set();
  for (const item of context.operations) {
    const label = operationLabel(item);
    if (failedFindingIds.has(item.findingId)) {
      skipped.push({ operation: label, reason: `earlier operation failed in finding ${item.findingId}` });
      continue;
    }
    attempted.push(item);
    try {
      executeOperation(context.workspace, item.operation);
      successes.push({ operation: label });
    } catch (error) {
      failures.push({ operation: label, error: error.message });
      failedFindingIds.add(item.findingId);
    }
  }
  const result = { backup_path: backupPath, successes, failures, skipped, skill_validation: skillValidation(context.workspace, attempted) };
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
}

const options = parseArgs(process.argv.slice(2));
try {
  if (options._[0] === "prepare") prepare(options);
  else if (options._[0] === "execute") execute(options);
  else fail("usage: apply-run.mjs <prepare|execute> ...");
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
