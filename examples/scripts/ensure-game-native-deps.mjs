import { accessSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

const REQUIRED_NATIVE_FILES = [
  {
    label: "@kmamal/sdl",
    package: "@kmamal/sdl",
    path: join(root, "node_modules", "@kmamal", "sdl", "dist", "sdl.node"),
  },
  {
    label: "@kmamal/gl",
    package: "@kmamal/gl",
    path: join(root, "node_modules", "@kmamal", "gl", "dist", "webgl.node"),
  },
];

function exists(path) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`command failed: ${command} ${args.join(" ")}`);
  }
}

function main() {
  const missing = REQUIRED_NATIVE_FILES.filter((x) => !exists(x.path));
  if (missing.length === 0) return;

  console.log(
    `[game-native] missing native modules: ${missing.map((m) => m.label).join(", ")}; rebuilding...`,
  );

  const shimDir = join(root, ".cursor-native-shims");
  const shimPath = join(shimDir, "python");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shimPath, "#!/usr/bin/env bash\nexec python3 \"$@\"\n", "utf8");
  chmodSync(shimPath, 0o755);

  const env = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    PYTHON: "python3",
    npm_config_python: "python3",
  };

  try {
    for (const item of missing) {
      run("npm", ["rebuild", item.package], env);
    }
  } finally {
    rmSync(shimPath, { force: true });
    rmSync(shimDir, { recursive: true, force: true });
  }

  const stillMissing = REQUIRED_NATIVE_FILES.filter((x) => !exists(x.path));
  if (stillMissing.length > 0) {
    throw new Error(
      `native rebuild finished but files are still missing: ${stillMissing
        .map((m) => m.path)
        .join(", ")}`,
    );
  }
  console.log("[game-native] native modules are ready");
}

main();
