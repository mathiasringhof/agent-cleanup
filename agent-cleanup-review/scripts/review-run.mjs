#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const KNOWLEDGE = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md", "memory.md"];

function fail(message) { throw new Error(message); }

function args(argv) {
  const out = { _: [], operation: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) out._.push(value);
    else {
      const key = value.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        if (key === "operation") out.operation.push(next); else out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

const shaBytes = (value) => crypto.createHash("sha256").update(value).digest("hex");
const shaFile = (file) => shaBytes(fs.readFileSync(file));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

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

const rel = (root, absolute) => path.relative(root, absolute).split(path.sep).join("/");
function manifestEntry(root, absolute) {
  const stat = fs.lstatSync(absolute);
  const item = { path: rel(root, absolute), type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", mode: stat.mode & 0o777, size: stat.size, sha256: stat.isFile() ? shaFile(absolute) : null };
  if (stat.isSymbolicLink()) item.link_target = fs.readlinkSync(absolute);
  return item;
}
function walk(root, start, output) {
  let stat;
  try { stat = fs.lstatSync(start); } catch { return; }
  output.push(manifestEntry(root, start));
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const name of fs.readdirSync(start).sort()) walk(root, path.join(start, name), output);
}
function inventory(root) {
  const output = [];
  for (const name of KNOWLEDGE) { const file = path.join(root, name); try { fs.lstatSync(file); output.push(manifestEntry(root, file)); } catch { /* absent */ } }
  for (const dir of ["memory", "skills"]) walk(root, path.join(root, dir), output);
  const seen = new Set();
  const result = output.filter((item) => !seen.has(item.path) && seen.add(item.path)).sort((a, b) => a.path.localeCompare(b.path));
  for (const item of [...result].reverse()) {
    if (item.type !== "directory") continue;
    const prefix = `${item.path}/`;
    const children = result.filter((candidate) => candidate.path.startsWith(prefix)).map(({ path: childPath, type, mode, size, sha256, link_target }) => ({ path: childPath.slice(prefix.length), type, mode, size, sha256, link_target }));
    item.sha256 = shaBytes(JSON.stringify(children));
  }
  return result;
}

function frontmatterName(file) {
  try {
    const block = fs.readFileSync(file, "utf8").match(/^---\s*\n([\s\S]*?)\n---/);
    return block?.[1].match(/^name:\s*["']?([^\s"']+)["']?\s*$/m)?.[1] ?? null;
  } catch { return null; }
}
function derivedProtection(root, manifest) {
  const cleanup = new Set(["agent-cleanup-audit", "agent-cleanup-review", "agent-cleanup-apply"]);
  const protectedPaths = manifest.filter((item) => item.path.endsWith("/SKILL.md") && cleanup.has(frontmatterName(path.join(root, item.path)))).map((item) => path.posix.dirname(item.path)).sort();
  const dated = manifest.filter((item) => /^memory\/\d{4}-\d{2}-\d{2}(?:-[^/]+)?\.md$/.test(item.path)).map((item) => item.path);
  const symlinks = manifest.filter((item) => item.type === "symlink").map((item) => item.path);
  return { protectedPaths, readOnlyPaths: [...new Set([...dated, ...symlinks, ...protectedPaths])].sort() };
}
function trustedOpenClaw(root, command) {
  const result = spawnSync("openclaw", command, { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") return { available: false, command, exit_code: null, stdout: "", stderr: "" };
  return { available: !result.error, command, exit_code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

function sealedHash(run, name) {
  const hashFile = path.join(run, `${name}.sha256`);
  const dataFile = path.join(run, `${name}.json`);
  if (!fs.existsSync(hashFile) || !fs.existsSync(dataFile)) fail(`${name} is not sealed`);
  const expected = fs.readFileSync(hashFile, "utf8").trim().split(/\s+/)[0];
  const actual = shaFile(dataFile);
  if (expected !== actual) fail(`${name} seal mismatch`);
  return actual;
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) fail(`${label} must be a non-empty relative path`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) fail(`${label} escapes its root`);
  return normalized;
}

function overlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function ownedPath(candidate) {
  const roots = new Set(["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md", "memory.md"]);
  return roots.has(candidate) || candidate === "skills" || candidate.startsWith("skills/");
}

function pathBlocked(candidate, audit) {
  const blocked = [...audit.protected_paths, ...audit.read_only_paths];
  return blocked.some((item) => overlaps(candidate, item));
}

function manifestMap(audit) {
  return new Map(audit.source_manifest.map((item) => [item.path, item]));
}

function normalizeOperation(raw, run, audit) {
  const allowed = new Set(["create_file", "replace_file", "move_path", "remove_path"]);
  if (!raw.id || !allowed.has(raw.type)) fail("operation requires a unique id and allowed type");
  const map = manifestMap(audit);
  const operation = { id: raw.id, type: raw.type };
  if (raw.type === "move_path") {
    operation.from = safeRelative(raw.from, `${raw.id}.from`);
    operation.to = safeRelative(raw.to, `${raw.id}.to`);
    if (!ownedPath(operation.from) || !ownedPath(operation.to)) fail(`${raw.id} is outside the owned cleanup scope`);
    if (pathBlocked(operation.from, audit) || pathBlocked(operation.to, audit)) fail(`${raw.id} touches a protected/read-only path`);
    const source = map.get(operation.from);
    if (!source || !source.sha256) fail(`${raw.id}.from is absent from the audit manifest`);
    if (map.has(operation.to)) fail(`${raw.id}.to already existed during audit`);
    operation.expected_before = raw.expected_before || source.sha256;
  } else {
    operation.path = safeRelative(raw.path, `${raw.id}.path`);
    if (!ownedPath(operation.path)) fail(`${raw.id} is outside the owned cleanup scope`);
    if (pathBlocked(operation.path, audit)) fail(`${raw.id} touches a protected/read-only path`);
    const source = map.get(operation.path);
    if (raw.type === "create_file") {
      if (source) fail(`${raw.id}.path already existed during audit`);
    } else {
      if (!source || !source.sha256) fail(`${raw.id}.path is absent from the audit manifest`);
      operation.expected_before = raw.expected_before || source.sha256;
    }
  }
  if (raw.type === "create_file" || raw.type === "replace_file") {
    operation.payload = safeRelative(raw.payload, `${raw.id}.payload`);
    if (!operation.payload.startsWith("payload/")) fail(`${raw.id}.payload must be under payload/`);
    const payload = path.resolve(run, operation.payload);
    const payloadRoot = path.resolve(run, "payload");
    const stat = fs.lstatSync(payload);
    const realPayloadRoot = fs.realpathSync(payloadRoot);
    const realPayload = fs.realpathSync(payload);
    if (!payload.startsWith(`${payloadRoot}${path.sep}`) || stat.isSymbolicLink() || !stat.isFile() || !realPayload.startsWith(`${realPayloadRoot}${path.sep}`)) fail(`${raw.id}.payload is not a contained regular payload file`);
    operation.payload_sha256 = shaFile(payload);
  }
  return operation;
}

function operationPaths(operation) {
  return operation.type === "move_path" ? [operation.from, operation.to] : [operation.path];
}

function validateOperations(operations) {
  const ids = new Set();
  const paths = [];
  for (const operation of operations) {
    if (ids.has(operation.id)) fail(`duplicate operation ID ${operation.id}`);
    ids.add(operation.id);
    const candidates = operation.type === "move_path" ? [operation.from, operation.to] : [operation.path];
    for (const candidate of candidates) {
      for (const prior of paths) if (overlaps(candidate, prior)) fail(`overlapping operation paths: ${candidate} and ${prior}`);
      paths.push(candidate);
    }
  }
}

function init(options) {
  if (!options.run) fail("init requires --run");
  const run = resolveRun(options);
  const auditHash = sealedHash(run, "audit");
  const audit = readJson(path.join(run, "audit.json"));
  if (audit.schema !== "agent-cleanup.audit/v1" || !audit.sealed_at) fail("invalid audit");
  const planFile = path.join(run, "plan.json");
  if (fs.existsSync(planFile)) {
    const existing = readJson(planFile);
    if (existing.status !== "reviewing" || existing.audit_sha256 !== auditHash) fail("existing plan cannot be resumed");
    console.log(JSON.stringify({ resumed: true, run_id: audit.run_id, run_dir: run, target_root: audit.target_root }, null, 2));
    return;
  }
  const plan = {
    schema: "agent-cleanup.plan/v1",
    run_id: audit.run_id,
    created_at: new Date().toISOString(),
    sealed_at: null,
    status: "reviewing",
    target_root: audit.target_root,
    audit_sha256: auditHash,
    source_manifest: audit.source_manifest,
    protected_paths: audit.protected_paths,
    read_only_paths: audit.read_only_paths,
    review_items: audit.findings.map((finding) => ({
      finding_id: finding.id,
      decision: "pending",
      strategy: null,
      rationale: null,
      operation_ids: [],
      decided_at: null,
    })),
    operations: [],
  };
  writeJson(planFile, plan);
  fs.writeFileSync(path.join(run, "plan.md"), "# Agent cleanup plan\n\nReview in progress.\n", { mode: 0o600 });
  console.log(JSON.stringify({ resumed: false, run_id: audit.run_id, run_dir: run, target_root: audit.target_root }, null, 2));
}

function decide(options) {
  if (!options.file) fail("decide requires a structured --file");
  const input = readJson(path.resolve(options.file));
  if (!input.finding_id || !input.decision || !input.rationale) fail("decision file requires finding_id, decision, and rationale");
  if (!["apply", "defer", "dismiss"].includes(input.decision)) fail("invalid decision");
  const run = resolveRun(options);
  sealedHash(run, "audit");
  const audit = readJson(path.join(run, "audit.json"));
  const planFile = path.join(run, "plan.json");
  const plan = readJson(planFile);
  if (plan.status !== "reviewing") fail("plan is not open for review");
  const item = plan.review_items.find((candidate) => candidate.finding_id === input.finding_id);
  if (!item || item.decision !== "pending") fail("finding is absent or already decided");
  const finding = audit.findings.find((candidate) => candidate.id === input.finding_id);
  const operationFiles = input.operations || [];
  const newOperations = operationFiles.map((file) => normalizeOperation(readJson(path.resolve(path.dirname(options.file), file)), run, audit));
  if (input.decision === "apply" && newOperations.length === 0) fail("apply requires at least one operation");
  if (input.decision !== "apply" && newOperations.length) fail("defer/dismiss cannot include operations");
  const expansions = (input.scope_expansion || []).map((value) => safeRelative(value, "scope expansion"));
  if (expansions.length) {
    const approvalFile = path.join(run, "decisions", "expansions", `${input.finding_id}.json`);
    if (!fs.existsSync(approvalFile)) fail("scope expansion requires separate approval");
    const approval = readJson(approvalFile);
    if (JSON.stringify(approval.paths) !== JSON.stringify(expansions)) fail("scope expansion differs from separate approval");
  }
  const authorized = [...finding.paths, ...expansions];
  for (const operation of newOperations) for (const candidate of operationPaths(operation)) {
    if (!authorized.some((allowed) => overlaps(candidate, allowed))) fail(`${operation.id} is not bound to finding ${finding.id}`);
  }
  const strategies = input.strategies || {};
  for (const operation of newOperations) {
    const affected = operationPaths(operation);
    if (["create_file", "replace_file"].includes(operation.type)) {
      for (const candidate of affected) if (!["surgical", "rewrite"].includes(strategies[candidate])) fail(`strategy required for ${candidate}`);
    } else for (const candidate of affected) if (candidate in strategies) fail(`strategy is not allowed for ${operation.type}`);
  }
  validateOperations([...plan.operations, ...newOperations]);
  plan.operations.push(...newOperations);
  Object.assign(item, {
    decision: input.decision,
    strategies,
    scope_expansion: expansions,
    rationale: input.rationale,
    operation_ids: newOperations.map((operation) => operation.id),
    decided_at: new Date().toISOString(),
  });
  writeJson(planFile, plan);
  const decisionDir = path.join(run, "decisions");
  fs.mkdirSync(decisionDir, { recursive: true, mode: 0o700 });
  writeJson(path.join(decisionDir, `${input.finding_id}.json`), input);
  console.log(input.finding_id);
}

function approveExpansion(options) {
  if (!options.file) fail("approve-expansion requires --file");
  const approval = readJson(path.resolve(options.file));
  if (!approval.finding_id || !approval.rationale || !Array.isArray(approval.paths) || approval.paths.length === 0) fail("expansion approval requires finding_id, rationale, and paths");
  const run = resolveRun(options);
  const plan = readJson(path.join(run, "plan.json"));
  if (plan.status !== "reviewing") fail("plan is not open for expansion approval");
  const item = plan.review_items.find((candidate) => candidate.finding_id === approval.finding_id);
  if (!item || item.decision !== "pending") fail("expansion finding is absent or already decided");
  approval.paths = approval.paths.map((candidate) => safeRelative(candidate, "scope expansion"));
  const directory = path.join(run, "decisions", "expansions");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJson(path.join(directory, `${approval.finding_id}.json`), approval);
  console.log(JSON.stringify({ finding_id: approval.finding_id, paths: approval.paths }, null, 2));
}

function batchDecide(options) {
  if (!options.file) fail("batch-decide requires --file");
  const batchFile = path.resolve(options.file);
  const batch = readJson(batchFile);
  if (!Array.isArray(batch.matched) || batch.matched.length < 2 || !Array.isArray(batch.decisions) || batch.decisions.length !== batch.matched.length) fail("batch decision requires at least two matched findings and one decision per finding");
  const run = resolveRun(options);
  const audit = readJson(path.join(run, "audit.json"));
  const openPlan = readJson(path.join(run, "plan.json"));
  if (openPlan.status !== "reviewing") fail("plan is not open for batch review");
  const ids = new Set();
  let fingerprint = null;
  for (const match of batch.matched) {
    if (!match.finding_id || ids.has(match.finding_id)) fail("batch finding IDs must be unique");
    ids.add(match.finding_id);
    const finding = audit.findings.find((item) => item.id === match.finding_id);
    if (!finding || JSON.stringify(match.paths) !== JSON.stringify(finding.paths)) fail(`batch must show exact paths for ${match.finding_id}`);
    const current = JSON.stringify([finding.category, finding.summary, finding.recommendation]);
    if (fingerprint && fingerprint !== current) fail("batch findings are not matching");
    fingerprint = current;
  }
  if (batch.decisions.some((item) => !ids.has(item.finding_id)) || new Set(batch.decisions.map((item) => item.finding_id)).size !== ids.size) fail("batch decisions must cover exactly the matched findings");
  for (const id of ids) {
    const item = openPlan.review_items.find((candidate) => candidate.finding_id === id);
    if (!item || item.decision !== "pending" || fs.existsSync(path.join(run, "decisions", `${id}.json`))) fail(`batch finding is not pending: ${id}`);
  }
  const temporary = path.join(run, "decisions", `.batch-${crypto.randomBytes(5).toString("hex")}`);
  const originalPlan = fs.readFileSync(path.join(run, "plan.json"));
  const decisionFiles = batch.decisions.map((item) => path.join(run, "decisions", `${item.finding_id}.json`));
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const input of batch.decisions) {
      const normalized = { ...input, operations: (input.operations || []).map((item) => path.resolve(path.dirname(batchFile), item)) };
      const file = path.join(temporary, `${input.finding_id}.json`);
      writeJson(file, normalized);
      decide({ ...options, file });
    }
  } catch (error) {
    fs.writeFileSync(path.join(run, "plan.json"), originalPlan);
    for (const file of decisionFiles) fs.rmSync(file, { force: true });
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  const batches = path.join(run, "decisions", "batches");
  fs.mkdirSync(batches, { recursive: true, mode: 0o700 });
  writeJson(path.join(batches, `${new Date().toISOString().replaceAll(":", "-")}.json`), batch);
}

function status(options, nextOnly = false) {
  const run = resolveRun(options);
  const plan = readJson(path.join(run, "plan.json"));
  const audit = readJson(path.join(run, "audit.json"));
  const pending = plan.review_items.filter((item) => item.decision === "pending");
  const next = pending.length ? audit.findings.find((item) => item.id === pending[0].finding_id) : null;
  console.log(JSON.stringify(nextOnly ? next : { run_id: plan.run_id, run_dir: run, target_root: plan.target_root, status: plan.status, pending: pending.length, next }, null, 2));
}

function revise(options) {
  if (!options.finding) fail("revise requires --finding");
  const run = resolveRun(options);
  const planFile = path.join(run, "plan.json");
  const plan = readJson(planFile);
  if (plan.status !== "reviewing") fail("sealed decisions cannot be revised");
  const item = plan.review_items.find((candidate) => candidate.finding_id === options.finding);
  if (!item || item.decision === "pending") fail("finding has no decision to revise");
  const ids = new Set(item.operation_ids);
  plan.operations = plan.operations.filter((operation) => !ids.has(operation.id));
  Object.assign(item, { decision: "pending", strategies: {}, scope_expansion: [], rationale: null, operation_ids: [], decided_at: null });
  writeJson(planFile, plan);
  fs.rmSync(path.join(run, "decisions", `${options.finding}.json`), { force: true });
  console.log(options.finding);
}

function refresh(options) {
  if (!options.file) fail("refresh requires a separately confirmed --file");
  const confirmation = readJson(path.resolve(options.file));
  const run = resolveRun(options);
  const oldAuditHash = sealedHash(run, "audit");
  const auditFile = path.join(run, "audit.json");
  const planFile = path.join(run, "plan.json");
  const inventoryFile = path.join(run, "inventory.json");
  const audit = readJson(auditFile);
  const plan = readJson(planFile);
  if (plan.status === "ready") sealedHash(run, "plan");
  else if (plan.status !== "reviewing") fail("plan cannot be refreshed");
  const oldInventorySeal = fs.readFileSync(path.join(run, "inventory.sha256"), "utf8").trim().split(/\s+/)[0];
  if (shaFile(inventoryFile) !== oldInventorySeal || audit.inventory_sha256 !== oldInventorySeal || plan.audit_sha256 !== oldAuditHash) fail("refresh input seals do not match");
  const current = inventory(audit.target_root);
  const protection = derivedProtection(audit.target_root, current);
  const oldMap = new Map(audit.source_manifest.map((item) => [item.path, item]));
  const newMap = new Map(current.map((item) => [item.path, item]));
  const changed = [...new Set([...oldMap.keys(), ...newMap.keys()])]
    .filter((candidate) => oldMap.get(candidate)?.type !== "directory" || newMap.get(candidate)?.type !== "directory")
    .filter((candidate) => JSON.stringify(oldMap.get(candidate)) !== JSON.stringify(newMap.get(candidate))).sort();
  const confirmed = [...new Set(confirmation.changed_paths || [])].map((item) => safeRelative(item, "confirmed changed path")).sort();
  if (JSON.stringify(changed) !== JSON.stringify(confirmed)) fail(`refresh confirmation differs from detected drift: ${changed.join(", ")}`);
  const relevant = new Set(KNOWLEDGE.filter((item) => item !== "memory.md"));
  for (const finding of audit.findings) for (const candidate of finding.paths) relevant.add(candidate);
  for (const operation of plan.operations) for (const candidate of operationPaths(operation)) {
    relevant.add(candidate);
    const match = candidate.match(/^(skills\/[^/]+)/);
    if (match) relevant.add(match[1]);
  }
  const material = changed.filter((candidate) => [...relevant].some((item) => overlaps(candidate, item)));
  const newlyProtected = protection.protectedPaths.filter((item) => !audit.protected_paths.includes(item));
  if (newlyProtected.length) material.push(...newlyProtected);
  if (material.length) fail(`relevant drift requires renewed decisions: ${material.join(", ")}`);
  const coverage = new Map(audit.coverage.map((item) => [item.path, item]));
  for (const candidate of [...coverage.keys()]) if (!newMap.has(candidate)) coverage.delete(candidate);
  for (const record of confirmation.coverage || []) {
    if (!newMap.has(record.path) || !["inspected", "inventory-only", "excluded"].includes(record.status)) fail(`invalid refreshed coverage: ${record.path}`);
    if (record.status === "excluded" && (!record.reason || !record.reason.trim())) fail(`excluded refreshed coverage requires a reason: ${record.path}`);
    coverage.set(record.path, { path: record.path, status: record.status, reason: record.reason || null });
  }
  const uncovered = current.map((item) => item.path).filter((candidate) => !coverage.has(candidate));
  if (uncovered.length) fail(`refresh coverage is incomplete: ${uncovered.join(", ")}`);
  const inventoryArtifact = readJson(inventoryFile);
  inventoryArtifact.source_manifest = current;
  inventoryArtifact.protected_paths = protection.protectedPaths;
  inventoryArtifact.read_only_paths = protection.readOnlyPaths;
  inventoryArtifact.openclaw = {
    version: trustedOpenClaw(audit.target_root, ["--version"]),
    skill_check: trustedOpenClaw(audit.target_root, ["skills", "check", "--json"]),
    skill_list: trustedOpenClaw(audit.target_root, ["skills", "list", "--json"]),
    curator_status: trustedOpenClaw(audit.target_root, ["skills", "curator", "status", "--json"]),
  };
  inventoryArtifact.refreshed_at = new Date().toISOString();
  writeJson(inventoryFile, inventoryArtifact);
  fs.writeFileSync(path.join(run, "inventory.sha256"), `${shaFile(inventoryFile)}  inventory.json\n`, { mode: 0o600 });
  audit.inventory_sha256 = shaFile(inventoryFile);
  audit.source_manifest = current;
  audit.protected_paths = protection.protectedPaths;
  audit.read_only_paths = protection.readOnlyPaths;
  audit.openclaw = inventoryArtifact.openclaw;
  audit.coverage = [...coverage.values()].sort((a, b) => a.path.localeCompare(b.path));
  audit.sealed_at = new Date().toISOString();
  writeJson(auditFile, audit);
  fs.writeFileSync(path.join(run, "audit.sha256"), `${shaFile(auditFile)}  audit.json\n`, { mode: 0o600 });
  plan.audit_sha256 = shaFile(auditFile);
  plan.source_manifest = current;
  plan.protected_paths = protection.protectedPaths;
  plan.read_only_paths = protection.readOnlyPaths;
  plan.status = "reviewing";
  plan.sealed_at = null;
  plan.refresh_history ||= [];
  plan.refresh_history.push({ refreshed_at: new Date().toISOString(), previous_audit_sha256: oldAuditHash, changed_paths: changed });
  writeJson(planFile, plan);
  fs.rmSync(path.join(run, "plan.sha256"), { force: true });
  console.log(JSON.stringify({ run_id: plan.run_id, run_dir: run, target_root: plan.target_root, changed_paths: changed }, null, 2));
}

function seal(options) {
  if (!options.run) fail("seal requires --run");
  const run = resolveRun(options);
  const auditHash = sealedHash(run, "audit");
  const planFile = path.join(run, "plan.json");
  const plan = readJson(planFile);
  const audit = readJson(path.join(run, "audit.json"));
  if (plan.schema !== "agent-cleanup.plan/v1" || plan.audit_sha256 !== auditHash) fail("plan is not bound to the sealed audit");
  if (JSON.stringify(plan.source_manifest) !== JSON.stringify(audit.source_manifest)) fail("plan source manifest differs from audit");
  if (JSON.stringify(plan.protected_paths) !== JSON.stringify(audit.protected_paths)) fail("plan protected paths differ from audit");
  if (JSON.stringify(plan.read_only_paths) !== JSON.stringify(audit.read_only_paths)) fail("plan read-only paths differ from audit");
  if (plan.review_items.some((item) => item.decision === "pending")) fail("every review item must be decided or deferred");
  validateOperations(plan.operations);
  const operationIds = new Set(plan.operations.map((operation) => operation.id));
  const attributions = new Map([...operationIds].map((id) => [id, 0]));
  for (const item of plan.review_items) {
    if (item.decision !== "apply" && item.operation_ids.length) fail(`non-apply finding ${item.finding_id} has operations`);
    for (const id of item.operation_ids) {
      if (!operationIds.has(id)) fail(`unknown operation ${id}`);
      attributions.set(id, attributions.get(id) + 1);
    }
  }
  for (const [id, count] of attributions) if (count !== 1) fail(`operation ${id} must be attributed to exactly one approved finding`);
  plan.status = "ready";
  plan.sealed_at = new Date().toISOString();
  writeJson(planFile, plan);
  fs.writeFileSync(path.join(run, "plan.sha256"), `${shaFile(planFile)}  plan.json\n`, { mode: 0o600 });
  const counts = Object.fromEntries(["apply", "defer", "dismiss"].map((decision) => [decision, plan.review_items.filter((item) => item.decision === decision).length]));
  fs.writeFileSync(path.join(run, "plan.md"), `# Agent cleanup plan\n\nTarget: \`${plan.target_root}\`\n\n- Apply: ${counts.apply}\n- Defer: ${counts.defer}\n- Dismiss: ${counts.dismiss}\n- Operations: ${plan.operations.length}\n`, { mode: 0o600 });
  console.log(run);
}

try {
  const options = args(process.argv.slice(2));
  const command = options._[0];
  if (command === "init") init(options);
  else if (command === "decide") decide(options);
  else if (command === "approve-expansion") approveExpansion(options);
  else if (command === "batch-decide") batchDecide(options);
  else if (command === "status") status(options);
  else if (command === "next-pending") status(options, true);
  else if (command === "revise") revise(options);
  else if (command === "refresh") refresh(options);
  else if (command === "seal") seal(options);
  else fail("usage: review-run.mjs <init|status|next-pending|approve-expansion|decide|batch-decide|revise|refresh|seal> ...");
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
