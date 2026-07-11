#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const skills = ["agent-cleanup-audit", "agent-cleanup-review", "agent-cleanup-apply"];
let failed = false;

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
}

if (failed) process.exitCode = 1;
else console.log("release distributions are self-contained");
