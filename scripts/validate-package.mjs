import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pipedrive-mcp-package-"));
let archivePath;

try {
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--dry-run=false"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const [{ filename }] = JSON.parse(packed.stdout);
  archivePath = join(root, filename);

  const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", temporaryDirectory], {
    encoding: "utf8"
  });
  assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);

  const executable = join(temporaryDirectory, "package", "build", "index.js");
  await symlink(join(root, "node_modules"), join(temporaryDirectory, "package", "node_modules"), "dir");
  await access(executable, constants.R_OK);
  const source = await readFile(executable, "utf8");
  assert.equal(source.startsWith("#!/usr/bin/env node"), true, "packed executable must retain its shebang");

  const mode = (await stat(executable)).mode;
  if ((mode & 0o111) === 0) await chmod(executable, mode | 0o755);
  const launched = spawnSync(executable, [], {
    cwd: join(temporaryDirectory, "package"),
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH },
    timeout: 5_000
  });
  assert.equal(launched.status, 1, "packed executable should start and reject missing configuration");
  assert.match(launched.stderr, /PIPEDRIVE_API_TOKEN is required/);
} finally {
  if (archivePath) await rm(archivePath, { force: true });
  await rm(temporaryDirectory, { recursive: true, force: true });
}
