import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = path.join(REPO, "bin", "claude-multiprofile.js");

const SNAP_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixdoc-cfg-"));
process.env.XDG_CONFIG_HOME = SNAP_SANDBOX;
process.on("exit", () => fs.rmSync(SNAP_SANDBOX, { recursive: true, force: true }));

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixdoc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cfg = path.join(root, "config");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(cfg, "claude-multiprofile"), { recursive: true });
  const registry = path.join(cfg, "claude-multiprofile", "profiles.json");
  const statePath = path.join(cfg, "claude-multiprofile", "state.json");
  const writeRegistry = (profiles) => fs.writeFileSync(registry, JSON.stringify({ version: 1, profiles }));
  const run = (args, bin = CLI) => {
    const r = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, NO_COLOR: "1", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeout: 120_000,
    });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  };
  return { root, home, cfg, registry, statePath, writeRegistry, run };
}

function codeProfile(home, name) {
  const configDir = path.join(home, `.claude-${name}`);
  fs.mkdirSync(configDir, { recursive: true });
  return { name, type: "code", desktop: null, code: { configDir, aliasName: `claude-${name}`, shell: "zsh", rcPath: path.join(home, ".zshrc") } };
}

function fakeApp(dir, version) {
  fs.mkdirSync(path.join(dir, "Contents"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
  );
  return dir;
}

test("doctor reads its own version when installed under a path with a space", (t) => {
  const s = sandbox(t);
  const pkg = path.join(s.root, "Application Support", "pkg");
  fs.mkdirSync(pkg, { recursive: true });
  for (const d of ["src", "bin"]) fs.cpSync(path.join(REPO, d), path.join(pkg, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(pkg, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(pkg, "node_modules"));
  s.writeRegistry([codeProfile(s.home, "a")]);
  const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

  const r = s.run(["doctor", "--fix"], path.join(pkg, "bin", "claude-multiprofile.js"));
  assert.doesNotMatch(r.out, /Installed: unknown/);
  assert.match(r.out, new RegExp(`Installed: ${version.replace(/\./g, "\\.")}`));
  assert.equal(JSON.parse(fs.readFileSync(s.statePath, "utf8")).fixesAppliedFor, version);
});

test("doctor --undo leaves what Claude or the user added to the update-block folder", async (t) => {
  const { takeSnapshot, finishSnapshot, undoLatest } = await import("../src/snapshot.js");
  const { blockUpdates, localConfigRootFor } = await import("../src/updates.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixdoc-undo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "Claude-W");
  const cfgRoot = localConfigRootFor(dataDir);

  const snap = takeSnapshot({ files: [], dirs: [cfgRoot] });
  assert.equal(blockUpdates(dataDir), "created");
  finishSnapshot(snap);

  const userEntry = path.join(cfgRoot, "configLibrary", "user-entry.json");
  const other = path.join(cfgRoot, "other-claude-state");
  fs.writeFileSync(userEntry, JSON.stringify({ inferenceProvider: "bedrock" }));
  fs.writeFileSync(other, "keep");

  const r = undoLatest();
  assert.equal(fs.readFileSync(userEntry, "utf8"), JSON.stringify({ inferenceProvider: "bedrock" }));
  assert.equal(fs.readFileSync(other, "utf8"), "keep");
  assert.deepEqual(r.skipped.map((x) => x.path), [cfgRoot]);

  const ownOnly = path.join(root, "Claude-V");
  const ownRoot = localConfigRootFor(ownOnly);
  const snap2 = takeSnapshot({ files: [], dirs: [ownRoot] });
  blockUpdates(ownOnly);
  finishSnapshot(snap2);
  assert.deepEqual(undoLatest().removed, [ownRoot]);
  assert.equal(fs.existsSync(ownRoot), false);
});

test("doctor --undo keeps the fix-pass record, so nothing nags to re-apply the undone fix", async (t) => {
  const { fixTargets } = await import("../src/snapshot.js");
  assert.ok(!fixTargets({ profiles: [] }).files.some((f) => f.endsWith(`${path.sep}state.json`)));

  const s = sandbox(t);
  s.writeRegistry([codeProfile(s.home, "a"), codeProfile(s.home, "b")]);
  const fixed = s.run(["doctor", "--fix"]);
  assert.match(fixed.out, /doctor --undo/);
  const recorded = JSON.parse(fs.readFileSync(s.statePath, "utf8")).fixesAppliedFor;
  assert.ok(recorded);

  s.run(["doctor", "--undo"]);
  assert.equal(JSON.parse(fs.readFileSync(s.statePath, "utf8")).fixesAppliedFor, recorded);
  assert.doesNotMatch(s.run(["list"]).out, /have not been applied/);
});

test("doctor --fix does not claim to repair a block it left alone", (t) => {
  if (process.platform !== "darwin") {
    t.skip("per-profile copies are macOS only");
    return;
  }
  const s = sandbox(t);
  const appSupport = path.join(s.home, "Library", "Application Support");
  const source = fakeApp(path.join(s.root, "Source.app"), "2.0.0");
  fakeApp(path.join(appSupport, "claude-multiprofile", "apps", "Claude w.app"), "2.0.0");
  const dataDir = path.join(appSupport, "Claude-W");
  fs.mkdirSync(path.join(`${dataDir}-3p`, "configLibrary"), { recursive: true });
  fs.writeFileSync(path.join(`${dataDir}-3p`, "configLibrary", "_meta.json"), "{ not json");
  s.writeRegistry([{ name: "w", type: "desktop", code: null, desktop: { dataDir, claudeAppPath: source, color: null } }]);

  const r = s.run(["doctor", "--fix"]);
  assert.doesNotMatch(r.out, /Repaired: updates now managed/);
  assert.match(r.out, /Not repaired/);
});

test("updates: extra keys or files in the tool's block make it foreign, and are never deleted", async (t) => {
  const { blockUpdates, unblockUpdates, updateBlockState, localConfigRootFor } = await import("../src/updates.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixdoc-block-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const extended = path.join(root, "Claude-A");
  blockUpdates(extended);
  const lib = path.join(localConfigRootFor(extended), "configLibrary");
  const { appliedId } = JSON.parse(fs.readFileSync(path.join(lib, "_meta.json"), "utf8"));
  const entry = path.join(lib, `${appliedId}.json`);
  fs.writeFileSync(entry, JSON.stringify({ inferenceProvider: "bedrock" }));
  assert.equal(updateBlockState(extended).state, "foreign");
  assert.equal(blockUpdates(extended), "foreign");
  assert.equal(unblockUpdates(extended), false);
  assert.equal(fs.readFileSync(entry, "utf8"), JSON.stringify({ inferenceProvider: "bedrock" }));

  const extra = path.join(root, "Claude-B");
  blockUpdates(extra);
  const extraFile = path.join(localConfigRootFor(extra), "configLibrary", "other.json");
  fs.writeFileSync(extraFile, "{}");
  assert.equal(updateBlockState(extra).state, "foreign");
  assert.equal(unblockUpdates(extra), false);
  assert.equal(fs.readFileSync(extraFile, "utf8"), "{}");

  const plain = path.join(root, "Claude-C");
  blockUpdates(plain);
  assert.equal(updateBlockState(plain).state, "blocked");
  assert.equal(unblockUpdates(plain), true);
  assert.equal(fs.existsSync(localConfigRootFor(plain)), false);
});

test("subcommand --help prints help instead of running, and unknown flags are refused", (t) => {
  const s = sandbox(t);
  for (const args of [["upgrade", "--help"], ["upgrade", "-h"], ["doctor", "--help"], ["remove", "-h"]]) {
    const r = s.run(args);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.out, /USAGE/, args.join(" "));
    assert.doesNotMatch(r.out, /Upgrade claude-multiprofile|claude-multiprofile doctor/, args.join(" "));
  }
  for (const args of [["upgrade", "--no-fixes"], ["doctor", "--fixx"]]) {
    const r = s.run(args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.out, /Unknown option/, args.join(" "));
  }
});

test("corrupt registry: doctor --fix records no fix pass and status does not send you to add", (t) => {
  const s = sandbox(t);
  fs.writeFileSync(s.registry, '{"profiles":[{"name":"w",}]}');
  s.run(["doctor", "--fix"]);
  assert.equal(fs.existsSync(s.statePath), false);
  const st = s.run(["status"]);
  assert.match(st.out, /not valid JSON/);
  assert.doesNotMatch(st.out, /claude-multiprofile add/);
});

test("localConfigRootFor: a trailing slash does not put the block inside the data folder", async () => {
  const { localConfigRootFor } = await import("../src/updates.js");
  assert.equal(localConfigRootFor("/x/Claude-W/"), "/x/Claude-W-3p");
  assert.equal(localConfigRootFor("/x/Claude-W-3p/"), "/x/Claude-W-3p");
});

test("doctor: two profiles on one folder conflict even when the paths are spelled differently", (t) => {
  const s = sandbox(t);
  const a = codeProfile(s.home, "a");
  const b = { ...codeProfile(s.home, "b"), code: { ...a.code, configDir: `${a.code.configDir}/`, aliasName: "claude-b" } };
  s.writeRegistry([a, b]);
  assert.match(s.run(["doctor"]).out, /Conflict: also used by profile "a"/);

  if (process.platform !== "darwin") return;
  const c = { ...codeProfile(s.home, "c"), code: { ...a.code, configDir: a.code.configDir.replace(".claude-a", ".claude-A"), aliasName: "claude-c" } };
  s.writeRegistry([a, c]);
  assert.match(s.run(["doctor"]).out, /Conflict: also used by profile "a"/);
});

test("doctor --fix rebuilds a registered Desktop profile's missing launcher", (t) => {
  if (process.platform !== "darwin") {
    t.skip("launchers are macOS only");
    return;
  }
  const s = sandbox(t);
  const appSupport = path.join(s.home, "Library", "Application Support");
  const source = fakeApp(path.join(s.root, "Source.app"), "2.0.0");
  fakeApp(path.join(appSupport, "claude-multiprofile", "apps", "Claude w.app"), "2.0.0");
  const dataDir = path.join(appSupport, "Claude-W");
  fs.mkdirSync(dataDir, { recursive: true });
  const appPath = path.join(s.home, "Applications", "Claude W.app");
  t.after(() => {
    try {
      execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", appPath], { stdio: "ignore" });
    } catch {}
  });
  s.writeRegistry([{ name: "w", type: "desktop", code: null, desktop: { dataDir, appPath, claudeAppPath: source, color: null } }]);

  const r = s.run(["doctor", "--fix"]);
  assert.match(r.out, /Repaired: launcher rebuilt/);
  assert.ok(fs.existsSync(path.join(appPath, "Contents", "Resources", "Scripts", "main.scpt")));
  assert.match(s.run(["doctor"]).out, /✓ Launcher: /);
});

function captured(fn) {
  const lines = [];
  const real = { log: console.log, error: console.error };
  console.log = console.error = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = real.log;
    console.error = real.error;
  }
  return lines.join("\n");
}

test("doctor: a copy pinned to the Dock is a problem, and says what it leads to", async () => {
  const { reportPinnedCopy } = await import("../src/commands/doctor.js");
  const t = { problems: 0, warnings: 0 };
  const out = captured(() => reportPinnedCopy(t, { name: "w", desktop: { appPath: "/Users/x/Applications/Claude W.app" } }));
  assert.deepEqual(t, { problems: 1, warnings: 0 });
  assert.match(out, /pinned to the Dock instead of its launcher/);
  assert.match(out, /default account/);
  assert.match(out, /updates itself/);
  assert.match(out, /colour/);
  assert.match(out, /Remove that tile and pin .*Claude W\.app/);
});

test("doctor: a lost colour says how it comes back, and that the copy's own Dock tile will not", async () => {
  const { reportLostColour } = await import("../src/commands/doctor.js");
  const p = { name: "w", desktop: { color: "teal", appPath: "/Users/x/Applications/Claude W.app" } };
  const t = { problems: 0, warnings: 0 };
  const plain = captured(() => reportLostColour(t, p, "/nonexistent/Claude W.app", { fix: false, pinned: false }));
  assert.match(plain, /teal colour is gone/);
  assert.match(plain, /comes back the next time you open .*Claude W\.app.*doctor --fix/);
  assert.doesNotMatch(plain, /does not bring it back/);
  const pinned = captured(() => reportLostColour(t, p, "/nonexistent/Claude W.app", { fix: false, pinned: true }));
  assert.match(pinned, /does not bring it back/);
  assert.deepEqual(t, { problems: 0, warnings: 2 });
});

test("doctor: a copy that is behind still has its lost colour reported", (t) => {
  if (process.platform !== "darwin") {
    t.skip("per-profile copies are macOS only");
    return;
  }
  const s = sandbox(t);
  const appSupport = path.join(s.home, "Library", "Application Support");
  const source = fakeApp(path.join(s.root, "Source.app"), "2.0.0");
  fakeApp(path.join(appSupport, "claude-multiprofile", "apps", "Claude W.app"), "1.0.0");
  const dataDir = path.join(appSupport, "Claude-W");
  fs.mkdirSync(dataDir, { recursive: true });
  s.writeRegistry([{ name: "w", type: "desktop", code: null, desktop: { dataDir, appPath: path.join(s.home, "Applications", "Claude W.app"), claudeAppPath: source, color: "teal" } }]);

  const out = s.run(["doctor"]).out;
  const section = out.slice(out.indexOf("Per-profile Claude copies"), out.indexOf("Profile updates"));
  assert.match(section, /w: its teal colour is gone/);
  assert.match(section, /copy is Claude 1\.0\.0, but 2\.0\.0 is installed/);
});
