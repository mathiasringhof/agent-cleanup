#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const source = path.join(repo, "docs/artifact-contract.md");
const contents = fs.readFileSync(source);
for (const skill of ["agent-cleanup-audit", "agent-cleanup-review", "agent-cleanup-apply"]) {
  const destination = path.join(repo, skill, "references/artifact-contract.md");
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(contents)) {
      console.error(`artifact contract differs: ${path.relative(repo, destination)}`);
      process.exitCode = 1;
    }
  } else {
    fs.copyFileSync(source, destination);
  }
}
