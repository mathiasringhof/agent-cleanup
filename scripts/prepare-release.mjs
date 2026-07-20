#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const skills = ["agent-cleanup-audit", "agent-cleanup-review", "agent-cleanup-apply"];
const forbiddenSubprocessPatterns = [
  { label: "child_process dependency", pattern: /["'](?:node:)?child_process["']/ },
  { label: "subprocess execution", pattern: /\b(?:exec|execFile|fork|spawn)(?:Sync)?\s*\(/ },
];
let failed = false;

function shippedFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...shippedFiles(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}

for (const skill of skills) {
  const directory = path.join(repo, skill);
  const required = [path.join(directory, "SKILL.md"), path.join(directory, "scripts", `${skill.replace("agent-cleanup-", "")}-run.mjs`)];
  for (const file of required) {
    if (!fs.existsSync(file)) {
      console.error(`missing distribution file: ${path.relative(repo, file)}`);
      failed = true;
    }
  }
  for (const file of required.filter((candidate) => candidate.endsWith(".mjs"))) {
    if (!fs.existsSync(file)) continue;
    const contents = fs.readFileSync(file, "utf8");
    for (const sibling of skills.filter((candidate) => candidate !== skill)) {
      if (contents.includes(sibling)) {
        console.error(`runtime sibling dependency in ${path.relative(repo, file)}: ${sibling}`);
        failed = true;
      }
    }
  }
  for (const file of shippedFiles(directory)) {
    const contents = fs.readFileSync(file, "utf8");
    for (const forbidden of forbiddenSubprocessPatterns) {
      if (forbidden.pattern.test(contents)) {
        console.error(`forbidden ${forbidden.label} in ${path.relative(repo, file)}`);
        failed = true;
      }
    }
  }
}

if (failed) process.exitCode = 1;
else console.log("release distributions are self-contained and subprocess-free");
