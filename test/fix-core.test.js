import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fix-core-"));
const HOME_DIR = path.join(SANDBOX, "home");
const CONFIG_HOME = path.join(SANDBOX, "config");
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(CONFIG_HOME, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.on("exit", () => {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
});

const shell = await import("../src/shell.js");
const code = await import("../src/code.js");
const permissions = await import("../src/permissions.js");
const registry = await import("../src/registry.js");

function quietly(fn) {
  const real = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = real;
  }
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(SANDBOX, prefix));
}

const START = "# >>> claude-multiprofile >>>";
const END = "# <<< claude-multiprofile <<<";

test("writeAliases refuses an rc file whose managed markers are not one well-formed pair", () => {
  const dir = tmp("rc-");
  const rc = path.join(dir, ".zshrc");
  const line = shell.buildAliasLine("zsh", "claude-a", "/c/a");
  const damaged = [
    `export A=1\n${START}\nalias claude-old='x'\nexport PATH=/important:$PATH\nsource ~/.secret-env\n`,
    `export A=1\n${END}\nexport PATH=/important:$PATH\n`,
    `${START}\n${line}\n${END}\nexport PATH=/important:$PATH\n${START}\n${line}\n${END}\n`,
    `${END}\nexport PATH=/important:$PATH\n${START}\n`,
  ];
  for (const content of damaged) {
    fs.writeFileSync(rc, content);
    assert.throws(() => shell.writeAliases("zsh", [line], rc), /damaged claude-multiprofile block/);
    assert.throws(() => shell.writeAliases("zsh", [], rc), /damaged claude-multiprofile block/);
    assert.throws(
      () => code.addAlias({ aliasName: "claude-b", configDir: "/c/b", code: { shell: "zsh", rcPath: rc } }),
      /damaged claude-multiprofile block/
    );
    assert.equal(fs.readFileSync(rc, "utf8"), content, "user lines are never pulled into a block");
    assert.deepEqual(shell.readManagedAliases("zsh", rc), []);
  }
  {
    const dir = tmp("rc-");
    const rc = path.join(dir, ".zshrc");
    fs.writeFileSync(rc, "export A=1\n");
    shell.writeAliases("zsh", [shell.buildAliasLine("zsh", "claude-a", "/c/a")], rc);
    fs.appendFileSync(rc, "export B=2\n");
    shell.writeAliases("zsh", [shell.buildAliasLine("zsh", "claude-a", "/c/a"), shell.buildAliasLine("zsh", "claude-b", "/c/b")], rc);
    const content = fs.readFileSync(rc, "utf8");
    assert.match(content, /export A=1/);
    assert.match(content, /export B=2/);
    assert.deepEqual(shell.readManagedAliases("zsh", rc).map((a) => a.name), ["claude-a", "claude-b"]);
  }
});

test("addAlias refuses to repoint another profile's alias at a different config dir", () => {
  const dir = tmp("rc-");
  const rc = path.join(dir, ".zshrc");
  const target = { shell: "zsh", rcPath: rc };
  code.addAlias({ aliasName: "claude-work", configDir: "/c/work", code: target });
  const before = fs.readFileSync(rc, "utf8");

  assert.throws(
    () => code.addAlias({ aliasName: "claude-work", configDir: "/c/other", code: target }),
    /already launches \/c\/work/
  );
  assert.throws(
    () => code.addAlias({ aliasName: "claude-work", configDir: "/c/other", code: { ...target, configDir: "/c/other" } }),
    /already launches/
  );
  assert.equal(fs.readFileSync(rc, "utf8"), before, "the other profile's alias is untouched");
  assert.ok(code.managedAliasConflict({ aliasName: "claude-work", configDir: "/c/other", code: target }));
  assert.equal(code.managedAliasConflict({ aliasName: "claude-work", configDir: "/c/work/", code: target }), null);
  {
    const p = "/tmp/a b'c\"d$e`f\\g!h";
    for (const sh of ["zsh", "bash", "fish"]) {
      assert.equal(shell.aliasConfigDir(shell.buildAliasLine(sh, "claude-t", p, `${p}/gh`)), p, sh);
  }
  assert.equal(shell.aliasConfigDir(`alias claude-w='CLAUDE_CONFIG_DIR="$HOME/.claude-w" claude'`), path.join(HOME_DIR, ".claude-w"));
  assert.equal(shell.aliasConfigDir(`alias claude-w='CLAUDE_CONFIG_DIR="/u/.claude-w/" claude'`), "/u/.claude-w");
  assert.equal(shell.aliasConfigDir(`alias claude-w='claude'`), null);
  }
  {
    const dir = tmp("rc-");
    const rc = path.join(dir, ".zshrc");
    const target = { shell: "zsh", rcPath: rc };
    const work = path.join(HOME_DIR, ".claude-work");
    shell.writeAliases("zsh", [`alias claude-work='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'`], rc);

    code.addAlias({ aliasName: "claude-work", configDir: work, code: target });
    code.addAlias({ aliasName: "claude-work", configDir: work, ghConfigDir: path.join(work, "gh"), code: target });
    assert.match(fs.readFileSync(rc, "utf8"), /GH_CONFIG_DIR=/);

    const moved = path.join(HOME_DIR, ".claude-renamed");
    const profileCode = { ...target, aliasName: "claude-work", configDir: work };
    code.addAlias({ aliasName: "claude-work", configDir: moved, code: profileCode });
    assert.equal(shell.aliasConfigDir(shell.readManagedAliases("zsh", rc)[0].line), moved);

    const renamedCode = { ...profileCode, configDir: moved };
    code.removeAlias("claude-work", renamedCode);
    code.addAlias({ aliasName: "claude-renamed", configDir: moved, code: renamedCode });
    assert.deepEqual(shell.readManagedAliases("zsh", rc).map((a) => a.name), ["claude-renamed"]);
  }
});

test("deny rules never block a profile from its own config or data dir", () => {
  const root = tmp("deny-");
  const shared = path.join(root, ".claude-a");
  const other = path.join(root, ".claude-c");
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const reg = {
    profiles: [
      { name: "a", code: { configDir: shared } },
      { name: "b", code: { configDir: `${shared}/` } },
      { name: "c", code: { configDir: other } },
    ],
  };
  quietly(() => permissions.resyncDenyRules(reg));
  const deny = JSON.parse(fs.readFileSync(path.join(shared, "settings.json"), "utf8")).permissions.deny;
  assert.deepEqual(deny, [`Read(/${other}/**)`]);
  assert.ok(permissions.auditDenyRules(reg).every((f) => f.missing.length === 0));
});

test("pathsIntoOtherProfile counts a quoted hook path as rebasable, as rebaseJsonFile treats it", () => {
  const root = tmp("rebase-");
  const from = path.join(root, ".claude");
  const to = path.join(root, ".claude-work");
  fs.mkdirSync(path.join(to, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(to, "hooks", "a.sh"), "");
  const file = path.join(to, "settings.json");
  const command = `bash "${from}/hooks/a.sh" && echo "${from}/hooks/missing.sh"`;
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }));
  assert.deepEqual(
    code.pathsIntoOtherProfile(file, from, to, { keys: code.SETTINGS_REBASE_KEYS }),
    { rebasable: 1, stuck: 1 }
  );
});

test("a failed seed copy never nests the folder inside itself and reports a clear error", { skip: process.getuid && process.getuid() === 0 }, () => {
  const root = tmp("seed-");
  const src = path.join(root, "src");
  const dst = path.join(root, "dst");
  fs.mkdirSync(path.join(src, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(src, "skills", "a.md"), "a");
  const locked = path.join(src, "skills", "x", "secret");
  fs.writeFileSync(locked, "s");
  fs.chmodSync(locked, 0o000);
  try {
    assert.throws(
      () => code.seedConfigDir(src, dst, { userConfigFile: path.join(root, "none.json") }),
      /Could not copy .*skills into the new profile/
    );
    assert.equal(fs.existsSync(path.join(dst, "skills", "skills")), false);
  } finally {
    fs.chmodSync(locked, 0o644);
  }
});

test("ensureConfigDir removes a half-seeded folder it created", { skip: process.getuid && process.getuid() === 0 }, () => {
  const def = path.join(HOME_DIR, ".claude");
  fs.mkdirSync(path.join(def, "skills", "x"), { recursive: true });
  const locked = path.join(def, "skills", "x", "secret");
  fs.writeFileSync(locked, "s");
  fs.chmodSync(locked, 0o000);
  const target = path.join(HOME_DIR, ".claude-half");
  try {
    assert.throws(
      () => code.ensureConfigDir(target, { seedFromDefault: true }),
      /Could not copy your Claude Code setup into .*so it was not created/
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.chmodSync(locked, 0o644);
    fs.rmSync(def, { recursive: true, force: true });
  }
});

test("rcPathForShell(bash): .bashrc on Linux, and on macOS the login file bash actually reads", () => {
  const files = [".bash_profile", ".bash_login", ".profile"].map((f) => path.join(HOME_DIR, f));
  const reset = () => files.forEach((f) => fs.rmSync(f, { force: true }));
  try {
    reset();
    assert.equal(shell.rcPathForShell("bash", { platform: "linux" }), path.join(HOME_DIR, ".bashrc"));
    assert.equal(shell.rcPathForShell("bash", { platform: "darwin" }), files[0]);
    fs.writeFileSync(files[2], "");
    assert.equal(shell.rcPathForShell("bash", { platform: "darwin" }), files[2]);
    fs.writeFileSync(files[1], "");
    assert.equal(shell.rcPathForShell("bash", { platform: "darwin" }), files[1]);
    fs.writeFileSync(files[0], "");
    assert.equal(shell.rcPathForShell("bash", { platform: "darwin" }), files[0]);
    assert.equal(shell.rcPathForShell("bash", { platform: "linux" }), path.join(HOME_DIR, ".bashrc"));
    assert.deepEqual(
      shell.aliasTargetFor({ shell: "bash", aliasName: "claude-x", rcPath: "/u/recorded" }),
      { shell: "bash", rcPath: "/u/recorded" }
    );
  } finally {
    reset();
  }
});

test("assertRegistryWritable throws on a corrupt registry and passes otherwise", () => {
  const file = registry.registryLocation();
  assert.equal(registry.assertRegistryWritable(), "missing");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  try {
    assert.throws(() => registry.assertRegistryWritable(), /not valid JSON/);
    assert.throws(() => registry.addToRegistry({ name: "x" }), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  } finally {
    fs.rmSync(file, { force: true });
  }
});
