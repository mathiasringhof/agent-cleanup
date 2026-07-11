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
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function defaultPlanRoot() {
  const state = process.env.XDG_STATE_HOME || path.join(process.env.HOME || os.homedir(), ".local", "state");
  return path.join(state, "openclaw", "agent-cleanup");
}

function safePath(value, label = "path") {
  if (typeof value !== "string" || !value || value.includes("\0")) fail(`${label} must be a non-empty relative path`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) fail(`${label} must stay inside the workspace`);
  return normalized;
}

function rejectSymlinkTraversal(workspace, relative) {
  const parts = safePath(relative).split("/");
  let current = workspace;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
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

function pathIsWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function rejectOrderedBinaryRewrite(workspace, relative, priorOperations) {
  let source = relative;
  for (let index = priorOperations.length - 1; index >= 0; index -= 1) {
    const operation = priorOperations[index];
    if (operation.type === "write_file" && source === operation.path) return;
    if (operation.type === "remove_path" && pathIsWithin(source, operation.path)) return;
    if (operation.type !== "move_path") continue;
    if (pathIsWithin(source, operation.to)) source = `${operation.from}${source.slice(operation.to.length)}`;
    else if (pathIsWithin(source, operation.from)) return;
  }
  rejectBinaryRewrite(workspace, source);
}

function validateOperation(operation, workspace) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) fail("operation must be an object");
  if (operation.type === "write_file") {
    safePath(operation.path);
    if (typeof operation.content !== "string" || operation.content.includes("\0")) fail("write_file requires complete text content");
    rejectSymlinkTraversal(workspace, operation.path);
    const target = path.join(workspace, operation.path);
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) fail("write_file target must be a regular file or a new file");
  } else if (operation.type === "move_path") {
    safePath(operation.from, "move source");
    safePath(operation.to, "move destination");
    rejectSymlinkTraversal(workspace, operation.from);
    rejectSymlinkTraversal(workspace, operation.to);
  } else if (operation.type === "remove_path") {
    safePath(operation.path);
    rejectSymlinkTraversal(workspace, operation.path);
  } else fail(`unsupported operation type: ${operation.type || "missing"}`);
  const keys = {
    write_file: new Set(["type", "path", "content"]),
    move_path: new Set(["type", "from", "to"]),
    remove_path: new Set(["type", "path"]),
  }[operation.type];
  for (const key of Object.keys(operation)) if (!keys.has(key)) fail(`unsupported operation field: ${key}`);
}

function validateFinding(finding, workspace) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) fail("finding must be an object");
  if (typeof finding.id !== "string" || !finding.id.trim()) fail("finding id is required");
  if (typeof finding.explanation !== "string" || !finding.explanation.trim()) fail(`finding ${finding.id} requires an explanation`);
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) fail(`finding ${finding.id} requires evidence`);
  for (const item of finding.evidence) {
    safePath(item?.path, "evidence path");
    if (typeof item.excerpt !== "string" || !item.excerpt.trim()) fail(`finding ${finding.id} has invalid evidence`);
  }
  if (finding.uncertainty !== null && (typeof finding.uncertainty !== "string" || !finding.uncertainty.trim())) fail(`finding ${finding.id} has invalid uncertainty`);
  if (typeof finding.intended_outcome !== "string" || !finding.intended_outcome.trim()) fail(`finding ${finding.id} requires an intended outcome`);
  if (finding.decision !== "pending") fail(`new or replaced finding ${finding.id} must be pending`);
  if (!Array.isArray(finding.operations)) fail(`finding ${finding.id} operations must be an array`);
  const priorOperations = [];
  for (const operation of finding.operations) {
    validateOperation(operation, workspace);
    if (operation.type === "write_file") rejectOrderedBinaryRewrite(workspace, operation.path, priorOperations);
    priorOperations.push(operation);
  }
}

function skillValidation(workspace) {
  const result = spawnSync("openclaw", ["skills", "check", "--json"], { cwd: workspace, encoding: "utf8", timeout: 30_000 });
  return {
    available: result.error?.code !== "ENOENT",
    exit_code: result.error?.code === "ENOENT" ? null : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function loadMutable(options) {
  if (!options.plan) fail("--plan is required");
  const planPath = path.resolve(options.plan);
  if (fs.lstatSync(planPath).isSymbolicLink()) fail("cleanup plan cannot be a symlink");
  const plan = readJson(planPath);
  if (plan.audit_complete) fail("audit is already finished");
  if (plan.state !== "draft" || !path.isAbsolute(plan.workspace) || !Array.isArray(plan.findings)) fail("invalid cleanup plan");
  if (planPath === plan.workspace || planPath.startsWith(`${plan.workspace}${path.sep}`)) fail("cleanup plan must stay outside the workspace");
  return { planPath, plan };
}

function init(options) {
  if (!options.workspace) fail("init requires --workspace");
  const workspace = fs.realpathSync(path.resolve(options.workspace));
  if (!fs.statSync(workspace).isDirectory()) fail("workspace must be a directory");
  const root = path.resolve(options["plan-root"] || defaultPlanRoot());
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  if (realRoot === workspace || realRoot.startsWith(`${workspace}${path.sep}`)) fail("plan root must be outside the workspace");
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const directory = path.join(realRoot, `${stamp}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const planPath = path.join(directory, "cleanup-plan.json");
  writeJson(planPath, {
    created_at: new Date().toISOString(),
    workspace,
    state: "draft",
    audit_complete: false,
    skill_validation: skillValidation(workspace),
    findings: [],
  });
  console.log(JSON.stringify({ plan_path: planPath, workspace }, null, 2));
}

function addFinding(options) {
  if (!options.file) fail("add-finding requires --file");
  const { planPath, plan } = loadMutable(options);
  const finding = readJson(path.resolve(options.file));
  validateFinding(finding, plan.workspace);
  if (plan.findings.some((item) => item.id === finding.id)) fail(`duplicate finding id: ${finding.id}`);
  plan.findings.push(finding);
  writeJson(planPath, plan);
  console.log(JSON.stringify({ finding: finding.id }, null, 2));
}

function replaceFinding(options) {
  if (!options.file) fail("replace-finding requires --file");
  const { planPath, plan } = loadMutable(options);
  const finding = readJson(path.resolve(options.file));
  validateFinding(finding, plan.workspace);
  const index = plan.findings.findIndex((item) => item.id === finding.id);
  if (index < 0) fail(`finding not found: ${finding.id}`);
  plan.findings[index] = finding;
  writeJson(planPath, plan);
  console.log(JSON.stringify({ finding: finding.id }, null, 2));
}

function finish(options) {
  const { planPath, plan } = loadMutable(options);
  plan.audit_complete = true;
  writeJson(planPath, plan);
  console.log(JSON.stringify({ plan_path: planPath, findings: plan.findings.length }, null, 2));
}

const options = parseArgs(process.argv.slice(2));
try {
  if (options._[0] === "init") init(options);
  else if (options._[0] === "add-finding") addFinding(options);
  else if (options._[0] === "replace-finding") replaceFinding(options);
  else if (options._[0] === "finish") finish(options);
  else fail("usage: audit-run.mjs <init|add-finding|replace-finding|finish> ...");
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
