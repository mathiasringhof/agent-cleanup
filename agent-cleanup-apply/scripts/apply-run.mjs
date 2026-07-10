#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const KNOWLEDGE = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md", "memory.md"];

function fail(message) { throw new Error(message); }
function cliFail(message) { console.error(`error: ${message}`); process.exit(1); }
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) out._.push(value);
    else {
      const key = value.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i += 1; }
    }
  }
  return out;
}

const shaBytes = (value) => crypto.createHash("sha256").update(value).digest("hex");
const shaFile = (file) => shaBytes(fs.readFileSync(file));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const rel = (root, absolute) => path.relative(root, absolute).split(path.sep).join("/");
const operationPaths = (operation) => operation.type === "move_path" ? [operation.from, operation.to] : [operation.path];

function stateRoot(options) {
  return path.resolve(options["state-root"] || path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || "~", ".local", "state"), "openclaw-agent-cleanup"));
}

function resolveRun(options) {
  if (!options.run || !/^[a-f0-9]{12}$/.test(options.run)) fail("run must be a short run ID");
  const root = fs.realpathSync(stateRoot(options));
  const candidate = path.join(root, options.run);
  if (!fs.existsSync(candidate) || fs.lstatSync(candidate).isSymbolicLink()) fail("run not found or is a symlink");
  const run = fs.realpathSync(candidate);
  if (path.dirname(run) !== root) fail("run escapes state root");
  return run;
}

function seal(run, name) {
  const data = path.join(run, `${name}.json`);
  const sealFile = path.join(run, `${name}.sha256`);
  if (!fs.existsSync(data) || !fs.existsSync(sealFile)) fail(`${name} is not sealed`);
  const expected = fs.readFileSync(sealFile, "utf8").trim().split(/\s+/)[0];
  const actual = shaFile(data);
  if (expected !== actual) fail(`${name} seal mismatch`);
  return actual;
}

function entry(root, absolute) {
  const stat = fs.lstatSync(absolute);
  const item = {
    path: rel(root, absolute),
    type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    mode: stat.mode & 0o777,
    size: stat.size,
    sha256: stat.isFile() ? shaFile(absolute) : null,
  };
  if (stat.isSymbolicLink()) item.link_target = fs.readlinkSync(absolute);
  return item;
}

function walk(root, start, output) {
  let stat;
  try { stat = fs.lstatSync(start); } catch { return; }
  output.push(entry(root, start));
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const name of fs.readdirSync(start).sort()) walk(root, path.join(start, name), output);
}

function inventory(root) {
  const output = [];
  for (const name of KNOWLEDGE) {
    const file = path.join(root, name);
    try { fs.lstatSync(file); output.push(entry(root, file)); } catch { /* absent */ }
  }
  for (const dir of ["memory", "skills"]) walk(root, path.join(root, dir), output);
  const seen = new Set();
  const result = output.filter((item) => !seen.has(item.path) && seen.add(item.path)).sort((a, b) => a.path.localeCompare(b.path));
  for (const item of [...result].reverse()) {
    if (item.type !== "directory") continue;
    const prefix = `${item.path}/`;
    const children = result.filter((candidate) => candidate.path.startsWith(prefix)).map(({ path: childPath, type, mode, size, sha256, link_target }) => ({
      path: childPath.slice(prefix.length), type, mode, size, sha256, link_target,
    }));
    item.sha256 = shaBytes(JSON.stringify(children));
  }
  return result;
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) fail(`${label} must be a non-empty relative path`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) fail(`${label} escapes the target`);
  return normalized;
}

function resolveUnder(root, relative, label) {
  const normalized = safeRelative(relative, label);
  const absolute = path.resolve(root, ...normalized.split("/"));
  if (!absolute.startsWith(`${root}${path.sep}`)) fail(`${label} escapes the target`);
  return absolute;
}

function overlaps(a, b) { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function ownedPath(candidate) {
  return new Set(KNOWLEDGE).has(candidate) || candidate === "skills" || candidate.startsWith("skills/");
}
function blocked(candidate, audit) {
  return [...audit.protected_paths, ...audit.read_only_paths].some((item) => overlaps(candidate, item));
}

function hasSymlink(absolute) {
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false;
  return fs.readdirSync(absolute).some((name) => hasSymlink(path.join(absolute, name)));
}

function ancestorHasSymlink(root, absolute) {
  const relative = path.relative(root, absolute);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

function trustedOpenClaw(root) {
  const result = spawnSync("openclaw", ["skills", "check", "--json"], {
    cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") return { available: false, exit_code: null, stdout: "", stderr: "" };
  return { available: !result.error, exit_code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

function staticChecks(root) {
  const errors = [];
  const skills = path.join(root, "skills");
  const visit = (item) => {
    let stat;
    try { stat = fs.lstatSync(item); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(item)) visit(path.join(item, name));
      return;
    }
    if (path.basename(item) !== "SKILL.md") return;
    const relative = rel(root, item);
    const text = fs.readFileSync(item, "utf8");
    const block = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!block) { errors.push(`${relative}: missing YAML frontmatter`); return; }
    if (!/^name:\s*\S+/m.test(block[1])) errors.push(`${relative}: missing name`);
    if (!/^description:\s*\S+/m.test(block[1])) errors.push(`${relative}: missing description`);
  };
  try { visit(skills); } catch (error) { errors.push(`skills traversal failed: ${error.message}`); }
  return [...new Set(errors)].sort();
}

function validateContext(run) {
  if (fs.realpathSync(run) !== run) fail("run directory must not be a symlink");
  const auditHash = seal(run, "audit");
  const planHash = seal(run, "plan");
  const audit = readJson(path.join(run, "audit.json"));
  const plan = readJson(path.join(run, "plan.json"));
  if (audit.schema !== "agent-cleanup.audit/v1" || plan.schema !== "agent-cleanup.plan/v1") fail("unsupported artifact schema");
  if (plan.status !== "ready" || !plan.sealed_at) fail("plan is not ready");
  if (plan.audit_sha256 !== auditHash) fail("plan is bound to a different audit");
  if (plan.run_id !== audit.run_id || plan.target_root !== audit.target_root) fail("audit/plan target mismatch");
  if (JSON.stringify(plan.source_manifest) !== JSON.stringify(audit.source_manifest)) fail("plan source manifest differs from audit");
  if (JSON.stringify(plan.protected_paths) !== JSON.stringify(audit.protected_paths)) fail("plan protected paths differ from audit");
  if (JSON.stringify(plan.read_only_paths) !== JSON.stringify(audit.read_only_paths)) fail("plan read-only paths differ from audit");
  const target = fs.realpathSync(audit.target_root);
  if (target !== audit.target_root) fail("target root identity changed");
  if (run === target || run.startsWith(`${target}${path.sep}`)) fail("artifacts must remain outside the target workspace");
  const current = inventory(target);
  if (JSON.stringify(current) !== JSON.stringify(plan.source_manifest)) fail("audited source manifest drifted; run audit and review again");
  const manifest = new Map(current.map((item) => [item.path, item]));
  const ids = new Set();
  const usedPaths = [];
  for (const operation of plan.operations) {
    if (!operation.id || ids.has(operation.id)) fail("operation IDs must be unique");
    ids.add(operation.id);
    if (!["create_file", "replace_file", "move_path", "remove_path"].includes(operation.type)) fail(`${operation.id}: disallowed operation type`);
    const candidates = operation.type === "move_path" ? [safeRelative(operation.from, "from"), safeRelative(operation.to, "to")] : [safeRelative(operation.path, "path")];
    for (const candidate of candidates) {
      if (!ownedPath(candidate)) fail(`${operation.id}: path is outside the owned cleanup scope`);
      if (blocked(candidate, audit)) fail(`${operation.id}: protected/read-only path`);
      for (const prior of usedPaths) if (overlaps(candidate, prior)) fail(`${operation.id}: overlapping operation path`);
      usedPaths.push(candidate);
      resolveUnder(target, candidate, operation.id);
    }
    const sourcePath = operation.type === "move_path" ? operation.from : operation.path;
    const source = manifest.get(sourcePath);
    if (operation.type === "create_file") {
      if (source) fail(`${operation.id}: create target already exists`);
    } else {
      if (!source || source.sha256 !== operation.expected_before) fail(`${operation.id}: expected source hash mismatch`);
      const sourceAbsolute = resolveUnder(target, sourcePath, operation.id);
      if (hasSymlink(sourceAbsolute)) fail(`${operation.id}: source is or contains a symlink`);
      if (operation.type === "replace_file" && source.type !== "file") fail(`${operation.id}: replace target is not a regular file`);
    }
    if (operation.type === "move_path" && manifest.has(operation.to)) fail(`${operation.id}: move destination already exists`);
    const destination = operation.type === "move_path" ? operation.to : operation.path;
    const parent = path.dirname(resolveUnder(target, destination, operation.id));
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory() || ancestorHasSymlink(target, parent)) fail(`${operation.id}: destination parent is absent or has a symlink ancestor`);
    if (["create_file", "replace_file"].includes(operation.type)) {
      const payload = resolveUnder(run, operation.payload, `${operation.id}.payload`);
      const payloadRoot = path.join(run, "payload");
      const payloadStat = fs.lstatSync(payload);
      const realPayload = fs.realpathSync(payload);
      const realPayloadRoot = fs.realpathSync(payloadRoot);
      if (!payload.startsWith(`${payloadRoot}${path.sep}`) || payloadStat.isSymbolicLink() || !payloadStat.isFile() || !realPayload.startsWith(`${realPayloadRoot}${path.sep}`)) fail(`${operation.id}: invalid payload`);
      if (shaFile(payload) !== operation.payload_sha256) fail(`${operation.id}: payload hash mismatch`);
    }
  }
  return { audit, plan, target, auditHash, planHash, current };
}

function resultSeal(run) {
  const file = path.join(run, "result.json");
  const sealFile = path.join(run, "result.sha256");
  if (!fs.existsSync(file) && !fs.existsSync(sealFile)) return null;
  if (!fs.existsSync(file) || !fs.existsSync(sealFile)) fail("result seal is incomplete");
  const expected = fs.readFileSync(sealFile, "utf8").trim().split(/\s+/)[0];
  if (expected !== shaFile(file)) fail("result seal mismatch");
  return readJson(file);
}

function acquireLock(root, target) {
  const locks = path.join(root, "locks");
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const directory = path.join(locks, shaBytes(target).slice(0, 24));
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if (error.code === "EEXIST") fail("workspace is locked by another cleanup run");
    throw error;
  }
  fs.writeFileSync(path.join(directory, "owner.json"), `${JSON.stringify({ pid: process.pid, target, acquired_at: new Date().toISOString() }, null, 2)}\n`);
  return () => fs.rmSync(directory, { recursive: true, force: true });
}

function snapshot(context, backupRoot) {
  const requestedRoot = path.resolve(backupRoot);
  fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(requestedRoot);
  if (root === context.target || root.startsWith(`${context.target}${path.sep}`)) fail("backup root must resolve outside the target workspace");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(root, `${context.plan.run_id}-${stamp}`);
  const data = path.join(directory, "data");
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const roots = [...new Set(context.current.map((item) => item.path.split("/")[0]))];
  for (const relative of roots) fs.cpSync(path.join(context.target, relative), path.join(data, relative), { recursive: true, dereference: false, preserveTimestamps: true });
  const metadata = { schema: "agent-cleanup.snapshot/v1", created_at: new Date().toISOString(), target_root: context.target, pre_apply_manifest: context.current, roots };
  writeJson(path.join(directory, "snapshot.json"), metadata);
  fs.writeFileSync(path.join(directory, "snapshot.sha256"), `${shaFile(path.join(directory, "snapshot.json"))}  snapshot.json\n`, { mode: 0o600 });
  return { directory, metadata };
}

function atomicWrite(destination, data, mode) {
  const temporary = `${destination}.agent-cleanup-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, data, { mode });
  fs.renameSync(temporary, destination);
}

function execute(context) {
  for (const operation of context.plan.operations) {
    if (operation.type === "create_file") {
      const destination = resolveUnder(context.target, operation.path, operation.id);
      atomicWrite(destination, fs.readFileSync(resolveUnder(path.resolve(context.audit.artifact_root), operation.payload, "payload")), 0o600);
    } else if (operation.type === "replace_file") {
      const destination = resolveUnder(context.target, operation.path, operation.id);
      const mode = fs.statSync(destination).mode & 0o777;
      atomicWrite(destination, fs.readFileSync(resolveUnder(path.resolve(context.audit.artifact_root), operation.payload, "payload")), mode);
    } else if (operation.type === "move_path") {
      fs.renameSync(resolveUnder(context.target, operation.from, operation.id), resolveUnder(context.target, operation.to, operation.id));
    } else if (operation.type === "remove_path") {
      fs.rmSync(resolveUnder(context.target, operation.path, operation.id), { recursive: true, force: false });
    }
  }
}

function verifyResults(context) {
  for (const operation of context.plan.operations) {
    if (operation.type === "create_file" || operation.type === "replace_file") {
      const destination = resolveUnder(context.target, operation.path, operation.id);
      if (!fs.statSync(destination).isFile() || shaFile(destination) !== operation.payload_sha256) fail(`${operation.id}: resulting content mismatch`);
    } else if (operation.type === "move_path") {
      const from = resolveUnder(context.target, operation.from, operation.id);
      const to = resolveUnder(context.target, operation.to, operation.id);
      if (fs.existsSync(from) || !fs.existsSync(to)) fail(`${operation.id}: move result mismatch`);
    } else if (fs.existsSync(resolveUnder(context.target, operation.path, operation.id))) fail(`${operation.id}: remove result mismatch`);
  }
}

function restore(target, snapshotData) {
  const currentRoots = [...new Set(inventory(target).map((item) => item.path.split("/")[0]))];
  for (const relative of new Set([...currentRoots, ...snapshotData.metadata.roots])) fs.rmSync(path.join(target, relative), { recursive: true, force: true });
  for (const relative of snapshotData.metadata.roots) fs.cpSync(path.join(snapshotData.directory, "data", relative), path.join(target, relative), { recursive: true, dereference: false, preserveTimestamps: true });
  const restored = inventory(target);
  if (JSON.stringify(restored) !== JSON.stringify(snapshotData.metadata.pre_apply_manifest)) {
    const expected = new Map(snapshotData.metadata.pre_apply_manifest.map((item) => [item.path, JSON.stringify(item)]));
    const actual = new Map(restored.map((item) => [item.path, JSON.stringify(item)]));
    const changed = [...new Set([...expected.keys(), ...actual.keys()])].filter((item) => expected.get(item) !== actual.get(item));
    fail(`restoration manifest mismatch: ${changed.join(", ")}`);
  }
}

function resultFiles(run, result) {
  writeJson(path.join(run, "result.json"), result);
  fs.writeFileSync(path.join(run, "result.md"), `# Agent cleanup result\n\n- Status: ${result.status}\n- Target: \`${result.target_root}\`\n- Snapshot: \`${result.snapshot || "none"}\`\n- Operations: ${result.operations.length}\n${result.failure ? `- Failure: ${result.failure}\n` : ""}`, { mode: 0o600 });
  fs.writeFileSync(path.join(run, "result.sha256"), `${shaFile(path.join(run, "result.json"))}  result.json\n`, { mode: 0o600, flag: "wx" });
}

function preflight(options) {
  if (!options.run) cliFail("preflight requires --run");
  try {
    const run = resolveRun(options);
    const historical = resultSeal(run);
    if (historical) {
      const matches = historical.post_apply_manifest && JSON.stringify(inventory(historical.target_root)) === JSON.stringify(historical.post_apply_manifest);
      console.log(JSON.stringify({ ok: true, historical: true, current_workspace_matches: matches, result: historical }, null, 2));
      return;
    }
    const context = validateContext(run);
    console.log(JSON.stringify({ ok: true, run_id: context.plan.run_id, run_dir: run, target_root: context.target, operations: context.plan.operations.length }, null, 2));
  } catch (error) { cliFail(error.message); }
}

function apply(options) {
  if (!options.run) cliFail("apply requires --run");
  let run;
  let context;
  let snapshotData;
  let beforeStatic = [];
  let beforeOpenClaw = null;
  let releaseLock = null;
  try {
    run = resolveRun(options);
    const historical = resultSeal(run);
    if (historical) {
      const matches = historical.post_apply_manifest && JSON.stringify(inventory(historical.target_root)) === JSON.stringify(historical.post_apply_manifest);
      console.log(JSON.stringify({ ...historical, historical: true, current_workspace_matches: matches }, null, 2));
      return;
    }
    const root = fs.realpathSync(stateRoot(options));
    releaseLock = acquireLock(root, readJson(path.join(run, "audit.json")).target_root);
    context = validateContext(run);
    beforeStatic = staticChecks(context.target);
    beforeOpenClaw = trustedOpenClaw(context.target);
    const changesSkills = context.plan.operations.some((operation) => operationPaths(operation).some((candidate) => candidate === "skills" || candidate.startsWith("skills/")));
    if (changesSkills && (!beforeOpenClaw.available || beforeOpenClaw.exit_code !== 0)) fail("authoritative OpenClaw skill validation is required before skill changes");
    snapshotData = snapshot(context, options["backup-root"] || path.join(root, "backups"));
    execute(context);
    verifyResults(context);
    const afterStatic = staticChecks(context.target);
    const newStatic = afterStatic.filter((error) => !beforeStatic.includes(error));
    if (newStatic.length) fail(`static validation introduced errors: ${newStatic.join("; ")}`);
    const afterOpenClaw = trustedOpenClaw(context.target);
    if (changesSkills && (!afterOpenClaw.available || afterOpenClaw.exit_code !== 0)) fail("authoritative OpenClaw skill validation failed after skill changes");
    const result = {
      schema: "agent-cleanup.result/v1", status: "applied", completed_at: new Date().toISOString(),
      target_root: context.target, snapshot: snapshotData.directory,
      operations: context.plan.operations.map((operation) => operation.id),
      plan_sha256: context.planHash,
      post_apply_manifest: inventory(context.target),
      validation: { static_before: beforeStatic, static_after: afterStatic, openclaw_before: beforeOpenClaw, openclaw_after: afterOpenClaw },
      failure: null,
    };
    resultFiles(run, result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    let restoreError = null;
    if (context && snapshotData) {
      try { restore(context.target, snapshotData); } catch (restoreFailure) { restoreError = restoreFailure.message; }
    }
    const result = {
      schema: "agent-cleanup.result/v1", status: restoreError ? "restore_failed" : snapshotData ? "restored" : "aborted", completed_at: new Date().toISOString(),
      target_root: context?.target ?? null, snapshot: snapshotData?.directory ?? null,
      operations: context?.plan.operations.map((operation) => operation.id) ?? [],
      validation: { static_before: beforeStatic, openclaw_before: beforeOpenClaw },
      failure: restoreError ? `${error.message}; restore failed: ${restoreError}` : error.message,
    };
    if (run && !fs.existsSync(path.join(run, "result.sha256"))) resultFiles(run, result);
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (releaseLock) releaseLock();
  }
}

const options = args(process.argv.slice(2));
const command = options._[0];
if (command === "preflight") preflight(options);
else if (command === "apply") apply(options);
else cliFail("usage: apply-run.mjs <preflight|apply> ...");
