#!/usr/bin/env node

import fs from "node:fs";
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
    safePath(operation.from, "move source"); safePath(operation.to, "move destination");
    rejectSymlinkTraversal(workspace, operation.from); rejectSymlinkTraversal(workspace, operation.to);
  } else if (operation.type === "remove_path") {
    safePath(operation.path); rejectSymlinkTraversal(workspace, operation.path);
  } else fail(`unsupported operation type: ${operation.type || "missing"}`);
  const keys = { write_file: new Set(["type", "path", "content"]), move_path: new Set(["type", "from", "to"]), remove_path: new Set(["type", "path"]) }[operation.type];
  for (const key of Object.keys(operation)) if (!keys.has(key)) fail(`unsupported operation field: ${key}`);
}

function normalizeFinding(finding, workspace) {
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
  if (!Array.isArray(finding.operations)) fail(`finding ${finding.id} operations must be an array`);
  const priorOperations = [];
  for (const operation of finding.operations) {
    validateOperation(operation, workspace);
    if (operation.type === "write_file") rejectOrderedBinaryRewrite(workspace, operation.path, priorOperations);
    priorOperations.push(operation);
  }
  return { ...finding, decision: "pending" };
}

function loadAndValidateReviewPlan(options, requireDraft = true) {
  if (!options.plan || !options.workspace) fail("--plan and --workspace are required");
  const planPath = path.resolve(options.plan);
  if (fs.lstatSync(planPath).isSymbolicLink()) fail("cleanup plan cannot be a symlink");
  const plan = readJson(planPath);
  const workspace = fs.realpathSync(path.resolve(options.workspace));
  if (workspace !== plan.workspace) fail("cleanup plan belongs to a different workspace");
  if (planPath === workspace || planPath.startsWith(`${workspace}${path.sep}`)) fail("cleanup plan must stay outside the workspace");
  if (!plan.audit_complete || !Array.isArray(plan.findings) || !["draft", "reviewed"].includes(plan.state)) fail("invalid cleanup plan");
  if (requireDraft && plan.state === "reviewed") fail("review is already finished; add or replace a finding to reopen it");
  return { planPath, plan, workspace };
}

function next(options) {
  const { plan } = loadAndValidateReviewPlan(options, false);
  const finding = plan.findings.find((item) => item.decision === "pending") || null;
  console.log(JSON.stringify(finding || { finding: null }, null, 2));
}

function decide(options) {
  const { planPath, plan } = loadAndValidateReviewPlan(options);
  if (!options.finding || !["apply", "defer", "dismiss"].includes(options.decision)) fail("decide requires --finding and --decision apply, defer, or dismiss");
  const item = plan.findings.find((finding) => finding.id === options.finding);
  if (!item) fail(`finding not found: ${options.finding}`);
  if (item.decision !== "pending") fail(`finding is already decided: ${options.finding}`);
  item.decision = options.decision;
  writeJson(planPath, plan);
  console.log(JSON.stringify({ finding: item.id, decision: item.decision }, null, 2));
}

function addFinding(options) {
  if (!options.file) fail("add-finding requires --file");
  const { planPath, plan, workspace } = loadAndValidateReviewPlan(options, false);
  const finding = normalizeFinding(readJson(path.resolve(options.file)), workspace);
  if (plan.findings.some((item) => item.id === finding.id)) fail(`duplicate finding id: ${finding.id}`);
  plan.findings.push(finding);
  plan.state = "draft";
  delete plan.reviewed_at;
  writeJson(planPath, plan);
  console.log(JSON.stringify({ finding: finding.id }, null, 2));
}

function replaceFinding(options) {
  if (!options.file) fail("replace-finding requires --file");
  const { planPath, plan, workspace } = loadAndValidateReviewPlan(options, false);
  const finding = normalizeFinding(readJson(path.resolve(options.file)), workspace);
  const index = plan.findings.findIndex((item) => item.id === finding.id);
  if (index < 0) fail(`finding not found: ${finding.id}`);
  plan.findings[index] = finding;
  plan.state = "draft";
  delete plan.reviewed_at;
  writeJson(planPath, plan);
  console.log(JSON.stringify({ finding: finding.id, decision: "pending" }, null, 2));
}

function finish(options) {
  const { planPath, plan } = loadAndValidateReviewPlan(options);
  const pending = plan.findings.filter((finding) => finding.decision === "pending").map((finding) => finding.id);
  if (pending.length) fail(`pending findings remain: ${pending.join(", ")}`);
  plan.state = "reviewed";
  plan.reviewed_at = new Date().toISOString();
  writeJson(planPath, plan);
  console.log(JSON.stringify({ plan_path: planPath, state: plan.state }, null, 2));
}

const options = parseArgs(process.argv.slice(2));
try {
  if (options._[0] === "next") next(options);
  else if (options._[0] === "decide") decide(options);
  else if (options._[0] === "add-finding") addFinding(options);
  else if (options._[0] === "replace-finding") replaceFinding(options);
  else if (options._[0] === "finish") finish(options);
  else fail("usage: review-run.mjs <next|decide|add-finding|replace-finding|finish> ...");
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
