#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const KNOWLEDGE = [
  "AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md", "USER.md",
  "HEARTBEAT.md", "BOOTSTRAP.md", "MEMORY.md", "memory.md",
];
const CLEANUP_NAMES = new Set([
  "agent-cleanup-audit", "agent-cleanup-review", "agent-cleanup-apply",
]);
const CATEGORIES = new Set([
  "duplicate", "contradiction", "misplaced", "superseded", "stale",
  "boilerplate", "abandoned", "redundant", "broken-reference",
  "skill-overlap", "skill-obsolete", "skill-malformed", "skill-conflict",
]);
const COVERAGE = new Set(["inspected", "inventory-only", "excluded"]);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

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

function shaFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function stateRoot(options) {
  return path.resolve(options["state-root"] || options["output-root"] || path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || "~", ".local", "state"), "openclaw-agent-cleanup"));
}

function isAgentDirectory(candidate) {
  return candidate.split(path.sep).some((part, index, parts) => part === ".openclaw" && parts[index + 1] === "agents");
}

function resolveRun(options) {
  if (!options.run) fail("--run is required");
  const root = stateRoot(options);
  const reference = options.run;
  if (path.isAbsolute(reference) || reference.includes("/") || reference.includes("\\")) fail("run must be a short run ID");
  if (!/^[a-f0-9]{12}$/.test(reference)) fail("invalid run ID");
  if (!fs.existsSync(root)) fail("state root does not exist");
  const realRoot = fs.realpathSync(root);
  const candidate = path.join(realRoot, reference);
  if (!fs.existsSync(candidate) || fs.lstatSync(candidate).isSymbolicLink()) fail("run not found or is a symlink");
  const run = fs.realpathSync(candidate);
  if (path.dirname(run) !== realRoot) fail("run escapes state root");
  return run;
}

function writeSeal(run, name) {
  const file = path.join(run, `${name}.json`);
  fs.writeFileSync(path.join(run, `${name}.sha256`), `${shaFile(file)}  ${name}.json\n`, { mode: 0o600, flag: "wx" });
}

function rel(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
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
  if (!fs.existsSync(start) && !fs.lstatSync(path.dirname(start)).isDirectory()) return;
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
    if (fs.existsSync(file) || (() => { try { fs.lstatSync(file); return true; } catch { return false; } })()) {
      output.push(entry(root, file));
    }
  }
  for (const dir of ["memory", "skills"]) {
    const full = path.join(root, dir);
    try { fs.lstatSync(full); walk(root, full, output); } catch { /* absent is valid */ }
  }
  const seen = new Set();
  const result = output
    .filter((item) => !seen.has(item.path) && seen.add(item.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const item of [...result].reverse()) {
    if (item.type !== "directory") continue;
    const prefix = `${item.path}/`;
    const children = result
      .filter((candidate) => candidate.path.startsWith(prefix))
      .map(({ path: childPath, type, mode, size, sha256, link_target }) => ({
        path: childPath.slice(prefix.length), type, mode, size, sha256, link_target,
      }));
    item.sha256 = crypto.createHash("sha256").update(JSON.stringify(children)).digest("hex");
  }
  return result;
}

function frontmatterName(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const block = text.match(/^---\s*\n([\s\S]*?)\n---/);
    const match = block?.[1].match(/^name:\s*["']?([^\s"']+)["']?\s*$/m);
    return match?.[1] ?? null;
  } catch { return null; }
}

function protectedPaths(root, manifest) {
  const output = new Set();
  for (const item of manifest) {
    if (!item.path.endsWith("/SKILL.md") && item.path !== "skills/SKILL.md") continue;
    const name = frontmatterName(path.join(root, item.path));
    if (CLEANUP_NAMES.has(name)) output.add(path.posix.dirname(item.path));
  }
  return [...output].sort();
}

function datedMemoryPaths(manifest) {
  return manifest
    .filter((item) => /^memory\/\d{4}-\d{2}-\d{2}(?:-[^/]+)?\.md$/.test(item.path))
    .map((item) => item.path);
}

function trustedOpenClaw(root, command) {
  const result = spawnSync("openclaw", command, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") return { available: false, command, exit_code: null, stdout: "", stderr: "" };
  return {
    available: !result.error,
    command,
    exit_code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function validateAudit(audit) {
  if (audit.schema !== "agent-cleanup.audit/v1") fail("unsupported audit schema");
  if (!path.isAbsolute(audit.target_root)) fail("target_root must be absolute");
  if (!Array.isArray(audit.source_manifest)) fail("source_manifest must be an array");
  if (!Array.isArray(audit.findings)) fail("findings must be an array");
  const ids = new Set();
  const inventoryPaths = new Set(audit.source_manifest.map((item) => item.path));
  for (const finding of audit.findings) {
    if (!finding.id || ids.has(finding.id)) fail("finding IDs must be non-empty and unique");
    ids.add(finding.id);
    if (!CATEGORIES.has(finding.category)) fail(`invalid category for ${finding.id}`);
    if (![finding.summary, finding.evidence, finding.recommendation].every((value) => typeof value === "string" && value.trim())) fail(`incomplete finding ${finding.id}`);
    if (!["low", "medium", "high"].includes(finding.confidence)) fail(`invalid confidence for ${finding.id}`);
    if (!Array.isArray(finding.paths) || finding.paths.length === 0) fail(`paths must be a non-empty array for ${finding.id}`);
    const findingPaths = new Set();
    for (const value of finding.paths) {
      if (typeof value !== "string" || !value || value.includes("\0")) fail(`malformed path for ${finding.id}`);
      const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
      if (normalized !== value || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) fail(`malformed path for ${finding.id}: ${value}`);
      if (!inventoryPaths.has(value)) fail(`finding path is outside inventory for ${finding.id}: ${value}`);
      if (findingPaths.has(value)) fail(`duplicate finding path for ${finding.id}: ${value}`);
      findingPaths.add(value);
    }
    if (typeof finding.requires_user !== "boolean") fail(`requires_user must be boolean for ${finding.id}`);
  }
}

function init(options) {
  if (!options.target) fail("init requires --target");
  const input = path.resolve(options.target);
  if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) fail("target must be an existing directory");
  const target = fs.realpathSync(input);
  const requestedOutputRoot = stateRoot(options);
  fs.mkdirSync(requestedOutputRoot, { recursive: true, mode: 0o700 });
  const outputRoot = fs.realpathSync(requestedOutputRoot);
  if (outputRoot === target || outputRoot.startsWith(`${target}${path.sep}`)) fail("artifact root must be outside the target workspace");
  if (isAgentDirectory(outputRoot)) fail("state root must be outside OpenClaw per-agent directories");
  const runId = crypto.randomBytes(6).toString("hex");
  const run = path.join(outputRoot, runId);
  fs.mkdirSync(path.join(run, "payload"), { recursive: true, mode: 0o700 });

  const manifest = inventory(target);
  const symlinks = manifest.filter((item) => item.type === "symlink").map((item) => item.path);
  const protectedList = protectedPaths(target, manifest);
  const readOnly = [...new Set([...datedMemoryPaths(manifest), ...symlinks, ...protectedList])].sort();
  const version = trustedOpenClaw(target, ["--version"]);
  const skillCheck = trustedOpenClaw(target, ["skills", "check", "--json"]);
  const skillList = trustedOpenClaw(target, ["skills", "list", "--json"]);
  const curator = trustedOpenClaw(target, ["skills", "curator", "status", "--json"]);

  const inventoryArtifact = {
    schema: "agent-cleanup.inventory/v1", run_id: runId, created_at: new Date().toISOString(),
    target_input: input, target_root: target, artifact_root: run, source_manifest: manifest,
    protected_paths: protectedList, read_only_paths: readOnly,
    openclaw: { version, skill_check: skillCheck, skill_list: skillList, curator_status: curator },
  };
  writeJson(path.join(run, "inventory.json"), inventoryArtifact);
  writeSeal(run, "inventory");
  const audit = {
    schema: "agent-cleanup.audit/v1",
    run_id: runId,
    created_at: new Date().toISOString(),
    sealed_at: null,
    target_input: input,
    target_root: target,
    artifact_root: run,
    inventory_sha256: shaFile(path.join(run, "inventory.json")),
    source_manifest: manifest, protected_paths: protectedList, read_only_paths: readOnly,
    openclaw: inventoryArtifact.openclaw,
    findings: [],
    coverage: [],
  };
  writeJson(path.join(run, "audit.json"), audit);
  fs.writeFileSync(path.join(run, "audit.md"), `# Agent cleanup audit\n\nTarget: \`${target}\`\n\nAudit in progress.\n`, { mode: 0o600 });
  console.log(JSON.stringify({ run_id: runId, run_dir: run, target_root: target }, null, 2));
}

function mutableAudit(options) {
  const run = resolveRun(options);
  if (fs.existsSync(path.join(run, "audit.sha256"))) fail("audit is already sealed");
  const inventoryHash = shaFile(path.join(run, "inventory.json"));
  const expected = fs.readFileSync(path.join(run, "inventory.sha256"), "utf8").trim().split(/\s+/)[0];
  if (inventoryHash !== expected) fail("inventory seal mismatch");
  const audit = readJson(path.join(run, "audit.json"));
  if (audit.inventory_sha256 !== inventoryHash) fail("audit inventory binding mismatch");
  return { run, audit };
}

function addFinding(options) {
  if (!options.file) fail("add-finding requires --file");
  const { run, audit } = mutableAudit(options);
  const finding = readJson(path.resolve(options.file));
  const copy = { ...audit, findings: [...audit.findings, finding] };
  validateAudit(copy);
  writeJson(path.join(run, "audit.json"), copy);
  console.log(finding.id);
}

function cover(options) {
  if (!options.file) fail("cover requires --file");
  const { run, audit } = mutableAudit(options);
  const record = readJson(path.resolve(options.file));
  const paths = new Set(audit.source_manifest.map((item) => item.path));
  if (!paths.has(record.path)) fail("coverage path is outside the inventory");
  if (!COVERAGE.has(record.status)) fail("invalid coverage status");
  if (record.status === "excluded" && (!record.reason || !record.reason.trim())) fail("excluded coverage requires a reason");
  if (audit.coverage.some((item) => item.path === record.path)) fail("coverage path already recorded");
  audit.coverage.push({ path: record.path, status: record.status, reason: record.reason || null });
  audit.coverage.sort((a, b) => a.path.localeCompare(b.path));
  writeJson(path.join(run, "audit.json"), audit);
  console.log(record.path);
}

function seal(options) {
  if (!options.run) fail("seal requires --run");
  const run = resolveRun(options);
  const file = path.join(run, "audit.json");
  if (!fs.existsSync(file)) fail("audit.json not found");
  const audit = JSON.parse(fs.readFileSync(file, "utf8"));
  validateAudit(audit);
  if (path.resolve(audit.artifact_root) !== run) fail("artifact_root does not match run directory");
  const scope = audit.source_manifest.map((item) => item.path);
  const covered = new Set(audit.coverage?.map((item) => item.path));
  const missing = scope.filter((item) => !covered.has(item));
  if (missing.length) fail(`audit coverage is incomplete: ${missing.join(", ")}`);
  const report = fs.readFileSync(path.join(run, "audit.md"), "utf8");
  if (/audit in progress/i.test(report) || report.trim().length < 30) fail("audit report is not finalized");
  audit.sealed_at = new Date().toISOString();
  writeJson(file, audit);
  writeSeal(run, "audit");
  console.log(JSON.stringify({ run_id: audit.run_id, run_dir: run, target_root: audit.target_root }, null, 2));
}

function listRetained(options) {
  const root = stateRoot(options);
  if (!fs.existsSync(root)) { console.log(JSON.stringify({ runs: [], snapshots: [] }, null, 2)); return; }
  const realRoot = fs.realpathSync(root);
  const runs = fs.readdirSync(realRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^[a-f0-9]{12}$/.test(item.name))
    .map((item) => ({ run_id: item.name, path: path.join(realRoot, item.name) }));
  const backupRoot = path.join(realRoot, "backups");
  const snapshots = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory()).map((item) => ({ name: item.name, path: path.join(backupRoot, item.name) })) : [];
  console.log(JSON.stringify({ runs, snapshots }, null, 2));
}

function prune(options) {
  const root = fs.realpathSync(stateRoot(options));
  if (!options.run || !/^[a-f0-9]{12}$/.test(options.run)) fail("prune requires a short --run ID");
  const run = path.join(root, options.run);
  if (!fs.existsSync(run) || fs.lstatSync(run).isSymbolicLink()) fail("run not found");
  const backups = path.join(root, "backups");
  const deletions = [run];
  if (fs.existsSync(backups)) for (const name of fs.readdirSync(backups)) if (name.startsWith(`${options.run}-`)) deletions.push(path.join(backups, name));
  if (!options.confirm) { console.log(JSON.stringify({ confirmed: false, deletions }, null, 2)); return; }
  for (const item of deletions) fs.rmSync(item, { recursive: true, force: false });
  console.log(JSON.stringify({ confirmed: true, deletions }, null, 2));
}

const options = args(process.argv.slice(2));
const command = options._[0];
if (command === "init") init(options);
else if (command === "add-finding") addFinding(options);
else if (command === "cover") cover(options);
else if (command === "seal") seal(options);
else if (command === "list") listRetained(options);
else if (command === "prune") prune(options);
else fail("usage: audit-run.mjs <init|add-finding|cover|seal|list|prune> ...");
