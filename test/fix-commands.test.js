import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixcmd-")));
const HOME_DIR = path.join(ROOT, "home");
const CFG_DIR = path.join(ROOT, "cfg");
fs.mkdirSync(HOME_DIR, { recursive: true });
process.env.HOME = HOME_DIR;
process.env.XDG_CONFIG_HOME = CFG_DIR;
process.env.SHELL = "/bin/zsh";

const CLI = path.resolve("bin/claude-multiprofile.js");

function quietly(fn) {
  const real = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  const restore = () => {
    [console.log, console.error] = real;
  };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.finally(restore);
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

function sandbox(label) {
  const root = fs.mkdtempSync(path.join(ROOT, `${label}-`));
  const home = path.join(root, "home");
  const cfg = path.join(root, "cfg");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(cfg, "claude-multiprofile"), { recursive: true });
  const registryFile = path.join(cfg, "claude-multiprofile", "profiles.json");
  return {
    home,
    cfg,
    registryFile,
    writeRegistry: (profiles) =>
      fs.writeFileSync(registryFile, JSON.stringify({ version: 1, profiles }, null, 2)),
    readRegistry: () => JSON.parse(fs.readFileSync(registryFile, "utf8")),
  };
}

function codeProfile(name, home, extra = {}) {
  return {
    name,
    type: "code",
    desktop: null,
    code: {
      configDir: path.join(home, `.claude-${name}`),
      aliasName: `claude-${name}`,
      shell: "zsh",
      rcPath: path.join(home, ".zshrc"),
      ghConfigDir: null,
      ...extra,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function runCli(box, args, answers = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: box.home, XDG_CONFIG_HOME: box.cfg, SHELL: "/bin/zsh", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let consumed = 0;
    let next = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const feed = () => {
      while (next < answers.length) {
        const [prompt, answer] = answers[next];
        const at = out.indexOf(prompt, consumed);
        if (at === -1) return;
        consumed = at + prompt.length;
        next++;
        child.stdin.write(answer + "\n");
      }
      child.stdin.end();
    };
    const onData = (d) => {
      out += d.toString();
      feed();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    if (answers.length === 0) child.stdin.end();
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test("resolveUserPath: relative input is refused, ~ and trailing slashes normalise", async () => {
  const { resolveUserPath, samePath, pathsOverlap } = await import("../src/util.js");
  assert.equal(resolveUserPath("claude-acme"), null);
  assert.equal(resolveUserPath("./x"), null);
  assert.equal(resolveUserPath("  ~/.claude/  "), path.join(HOME_DIR, ".claude"));
  assert.equal(resolveUserPath("/a/b/../c/"), "/a/c");
  assert.equal(samePath(path.join(HOME_DIR, ".claude/"), path.join(HOME_DIR, ".claude")), true);
  if (process.platform === "darwin") {
    assert.equal(samePath("/Users/X/.Claude", "/users/x/.claude"), true);
  }
  assert.equal(pathsOverlap("/a/b", "/a/b/c"), true);
  assert.equal(pathsOverlap("/a/b/c", "/a/b"), true);
  assert.equal(pathsOverlap("/a/b", "/a/bc"), false);
});

test("pathOwner: equal, inside and containing another profile's folders all count", async () => {
  const { pathOwner } = await import("../src/commands/add.js");
  const a = codeProfile("a", "/h");
  a.desktop = { dataDir: "/h/Data/Claude-A", appPath: "/h/Applications/Claude A.app" };
  const profiles = [a];
  assert.equal(pathOwner("/h/.claude-a", profiles).name, "a");
  assert.equal(pathOwner("/h/.claude-a/sub", profiles).name, "a");
  assert.equal(pathOwner("/h", profiles).name, "a");
  assert.equal(pathOwner("/h/Data/Claude-A", profiles).label, "Desktop data folder");
  assert.equal(pathOwner("/h/Applications/Claude A.app", profiles).label, "launcher");
  assert.equal(pathOwner("/h/.claude-ab", profiles), null);
  assert.equal(pathOwner("/h/.claude-a", profiles, "a"), null);
});

test("launcherPathProblem: refuses an existing app, the source Claude.app and another profile's launcher", async () => {
  const { launcherPathProblem } = await import("../src/commands/add.js");
  const apps = path.join(HOME_DIR, "Applications");
  const victim = path.join(apps, "Victim.app");
  fs.mkdirSync(path.join(victim, "Contents"), { recursive: true });
  const source = path.join(ROOT, "Source", "Claude.app");
  const other = codeProfile("o", HOME_DIR);
  other.desktop = { dataDir: path.join(ROOT, "o-data"), appPath: path.join(apps, "Claude O.app") };

  assert.match(launcherPathProblem(victim, { sourceAppPath: source, profiles: [] }), /already exists/);
  assert.match(launcherPathProblem(source, { sourceAppPath: source, profiles: [] }), /Claude\.app the profile runs/);
  assert.match(launcherPathProblem(other.desktop.appPath, { profiles: [other] }), /profile "o"/);
  assert.equal(launcherPathProblem(path.join(apps, "Claude New.app"), { sourceAppPath: source, profiles: [other] }), null);
  assert.equal(launcherPathProblem(victim, { profiles: [], currentAppPath: victim }), null);
});

test("aliasOwner: an alias another profile uses is taken", async () => {
  const { aliasOwner } = await import("../src/commands/add.js");
  const profiles = [codeProfile("work", "/h"), codeProfile("acme", "/h", { aliasName: "acme" })];
  assert.equal(aliasOwner("claude-work", profiles), "work");
  assert.equal(aliasOwner("claude-work", profiles, "work"), null);
  assert.equal(aliasOwner("acme", profiles), "acme");
  assert.equal(aliasOwner("claude-new", profiles), null);
});

test("applyNewProfile: a failed Code half is still registered so remove can clean it up", async () => {
  const { applyNewProfile } = await import("../src/commands/add.js");
  const { findProfile } = await import("../src/registry.js");
  const rc = path.join(HOME_DIR, ".zshrc");
  fs.mkdirSync(rc, { recursive: true });
  try {
    const configDir = path.join(HOME_DIR, ".claude-half");
    await quietly(async () => {
      assert.throws(() =>
        applyNewProfile({
          name: "half",
          desktopConfig: null,
          codeConfig: { name: "half", configDir, aliasName: "claude-half", seedFromDefault: false, isolateGh: false },
        })
      );
    });
    const saved = findProfile("half");
    assert.ok(saved, "the profile is in the registry");
    assert.equal(saved.code.configDir, configDir);
    assert.equal(saved.code.aliasName, "claude-half");
    assert.equal(saved.type, "code");
    assert.ok(fs.existsSync(configDir));
  } finally {
    fs.rmSync(rc, { recursive: true, force: true });
  }
});

test("applyNewProfile: a Desktop+Code profile with its own gh login exports GH_CONFIG_DIR from the launcher", { skip: process.platform !== "darwin" }, async () => {
  const { applyNewProfile } = await import("../src/commands/add.js");
  const { launcherGhConfigDir, launcherCodeConfigDir } = await import("../src/desktop.js");
  const source = path.join(ROOT, "FakeApps", "Claude.app");
  fs.mkdirSync(path.join(source, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(source, "Contents", "Info.plist"), "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>");
  const configDir = path.join(HOME_DIR, ".claude-ghp");
  const appPath = path.join(HOME_DIR, "Applications", "Claude GHP.app");
  await quietly(() =>
    applyNewProfile({
      name: "ghp",
      desktopConfig: {
        name: "ghp",
        dataDir: path.join(HOME_DIR, "Library", "Application Support", "Claude-GHP"),
        appPath,
        claudeAppPath: source,
        applyIcon: false,
        color: null,
        seedConnectors: false,
      },
      codeConfig: { name: "ghp", configDir, aliasName: "claude-ghp", seedFromDefault: false, isolateGh: true },
    })
  );
  assert.equal(launcherCodeConfigDir(appPath), configDir);
  assert.equal(launcherGhConfigDir(appPath), path.join(configDir, "gh"));
});

test("mutating commands refuse a corrupt registry before changing anything", async () => {
  const box = sandbox("corrupt");
  fs.writeFileSync(box.registryFile, "{ not json");
  fs.writeFileSync(path.join(box.home, ".zshrc"), "# mine\n");
  for (const args of [["add"], ["remove", "x"], ["rename", "a", "b"], ["self-update", "x", "on"]]) {
    const r = await runCli(box, args);
    assert.notEqual(r.code, 0, `${args.join(" ")} exits non-zero`);
    assert.match(r.out, /not valid JSON/, `${args.join(" ")} names the corrupt registry`);
    assert.doesNotMatch(r.out, /What do you want to set up/);
  }
  assert.equal(fs.readFileSync(box.registryFile, "utf8"), "{ not json");
  assert.equal(fs.readFileSync(path.join(box.home, ".zshrc"), "utf8"), "# mine\n");
});

test("remove: never deletes a folder another profile still uses", async () => {
  const box = sandbox("remove-shared");
  const shared = path.join(box.home, ".claude-shared");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, "keep.txt"), "a's data");
  fs.writeFileSync(path.join(box.home, ".zshrc"), "");
  box.writeRegistry([
    codeProfile("a", box.home, { configDir: shared }),
    codeProfile("b", box.home, { configDir: path.join(shared, "nested") }),
  ]);
  fs.mkdirSync(path.join(shared, "nested"));
  const r = await runCli(box, ["remove", "b"], [
    ["Remove profile", "y"],
    ["Also delete the Code config folder", "y"],
  ]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Kept/);
  assert.ok(fs.existsSync(path.join(shared, "keep.txt")));
  assert.ok(fs.existsSync(path.join(shared, "nested")));
  assert.deepEqual(box.readRegistry().profiles.map((p) => p.name), ["a"]);
});

test("rename: refuses before moving anything when a target folder already exists", async () => {
  const box = sandbox("rename-taken");
  const oldDir = path.join(box.home, ".claude-a");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(path.join(box.home, ".claude-b", "leftover"), { recursive: true });
  fs.writeFileSync(path.join(box.home, ".zshrc"), "");
  box.writeRegistry([codeProfile("a", box.home)]);
  const r = await runCli(box, ["rename", "a", "b"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /already exists/);
  assert.match(r.out, /Nothing was changed/);
  assert.ok(fs.existsSync(oldDir));
  assert.equal(box.readRegistry().profiles[0].name, "a");
});

test("rename: refuses an alias another profile already uses", async () => {
  const box = sandbox("rename-alias");
  fs.mkdirSync(path.join(box.home, ".claude-a"), { recursive: true });
  fs.writeFileSync(path.join(box.home, ".zshrc"), "");
  box.writeRegistry([
    codeProfile("a", box.home),
    codeProfile("c", box.home, { aliasName: "claude-b" }),
  ]);
  const r = await runCli(box, ["rename", "a", "b"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /already the alias of profile "c"/);
  assert.ok(fs.existsSync(path.join(box.home, ".claude-a")));
  assert.equal(box.readRegistry().profiles[0].name, "a");
});

test("rename: a failure partway puts the moved folder back", async () => {
  const box = sandbox("rename-rollback");
  const oldDir = path.join(box.home, ".claude-a");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "CLAUDE.md"), "mine");
  box.writeRegistry([codeProfile("a", box.home, { rcPath: path.join(box.home, "missing", ".zshrc") })]);
  const r = await runCli(box, ["rename", "a", "b"], [["Rename", "y"]]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /put back/);
  assert.equal(fs.readFileSync(path.join(oldDir, "CLAUDE.md"), "utf8"), "mine");
  assert.ok(!fs.existsSync(path.join(box.home, ".claude-b")));
  assert.equal(box.readRegistry().profiles[0].name, "a");
});

test("rename: plugin manifests and settings hooks follow the moved config folder", async () => {
  const box = sandbox("rename-rebase");
  const oldDir = path.join(box.home, ".claude-a");
  const newDir = path.join(box.home, ".claude-b");
  fs.mkdirSync(path.join(oldDir, "plugins", "cache", "p"), { recursive: true });
  fs.mkdirSync(path.join(oldDir, "plugins", "marketplaces", "m"), { recursive: true });
  fs.mkdirSync(path.join(oldDir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(oldDir, "hooks", "h.sh"), "");
  fs.writeFileSync(
    path.join(oldDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { p: [{ installPath: `${oldDir}/plugins/cache/p` }] } })
  );
  fs.writeFileSync(
    path.join(oldDir, "plugins", "known_marketplaces.json"),
    JSON.stringify({ m: { installLocation: `${oldDir}/plugins/marketplaces/m` } })
  );
  fs.writeFileSync(
    path.join(oldDir, "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `bash ${oldDir}/hooks/h.sh` }] }] } })
  );
  fs.writeFileSync(path.join(box.home, ".zshrc"), "");
  box.writeRegistry([codeProfile("a", box.home)]);
  const r = await runCli(box, ["rename", "a", "b"], [["Rename", "y"]]);
  assert.equal(r.code, 0, r.out);
  const installed = fs.readFileSync(path.join(newDir, "plugins", "installed_plugins.json"), "utf8");
  const known = fs.readFileSync(path.join(newDir, "plugins", "known_marketplaces.json"), "utf8");
  const settings = fs.readFileSync(path.join(newDir, "settings.json"), "utf8");
  assert.match(installed, new RegExp(`${newDir}/plugins/cache/p`));
  assert.match(known, new RegExp(`${newDir}/plugins/marketplaces/m`));
  assert.match(settings, new RegExp(`${newDir}/hooks/h\\.sh`));
  for (const text of [installed, known, settings]) assert.ok(!text.includes(`${oldDir}/`));
});

test("remove: keeps an app at the launcher path that this tool did not build", { skip: process.platform !== "darwin" }, async () => {
  const box = sandbox("remove-foreign");
  const app = path.join(box.home, "Applications", "Someone Else.app");
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "data.txt"), "theirs");
  box.writeRegistry([
    {
      name: "d",
      type: "desktop",
      desktop: { dataDir: path.join(box.home, "Claude-D"), appPath: app, claudeAppPath: "/Applications/Claude.app", color: null },
      code: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  const r = await runCli(box, ["remove", "d"], [
    ["Remove profile", "y"],
    ["Also delete the Desktop data folder", "n"],
  ]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not a launcher made by this tool/);
  assert.equal(fs.readFileSync(path.join(app, "Contents", "data.txt"), "utf8"), "theirs");
});
