import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SRC = path.resolve("src");

function fakeApp(dir, version, bundleId = "com.anthropic.claudefordesktop") {
  fs.mkdirSync(path.join(dir, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
  );
  fs.writeFileSync(path.join(dir, "Contents", "MacOS", "Claude"), version);
  return dir;
}

function runModule(home, code) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    timeout: 60_000,
  }).trim();
}

test("compileApp: refuses a launcher path that is the source Claude.app, even when it opens the copy", (t) => {
  if (process.platform !== "darwin") {
    t.skip("osacompile is macOS only");
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixd-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = fakeApp(path.join(home, "Applications", "Claude.app"), "1.2.3");
  const clone = fakeApp(path.join(home, "apps", "Claude work.app"), "1.2.3");

  for (const appPath of [source, path.join(home, "Applications", "claude.APP")]) {
    const out = runModule(home, `
      const { compileApp } = await import(${JSON.stringify(path.join(SRC, "desktop.js"))});
      try {
        compileApp({ name: "work", dataDir: ${JSON.stringify(path.join(home, "data"))}, appPath: ${JSON.stringify(appPath)},
          claudeAppPath: ${JSON.stringify(clone)}, dedicatedBundle: true, sourceAppPath: ${JSON.stringify(source)} });
        console.log("compiled");
      } catch (e) {
        console.log("refused: " + e.message);
      }
    `);
    assert.match(out, /^refused: .*Claude\.app this profile's copy is built from/);
  }
  assert.equal(fs.readFileSync(path.join(source, "Contents", "MacOS", "Claude"), "utf8"), "1.2.3", "the main Claude.app is untouched");
});

test("compileApp: refuses to replace an existing app that is not one of its launchers", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("osacompile is macOS only");
    return;
  }
  const d = await import("../src/desktop.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const foreign = fakeApp(path.join(root, "Slack.app"), "4.0", "com.tinyspeck.slackmacgap");
  assert.throws(
    () => d.compileApp({ name: "work", dataDir: "/data", appPath: foreign, claudeAppPath: "/Applications/Claude.app" }),
    /not a claude-multiprofile launcher/
  );
  assert.equal(fs.readFileSync(path.join(foreign, "Contents", "MacOS", "Claude"), "utf8"), "4.0");

  const scripted = path.join(root, "Scripted.app");
  fakeApp(scripted, "1.0", "com.example.mine");
  fs.mkdirSync(path.join(scripted, "Contents", "Resources", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(scripted, "Contents", "Resources", "Scripts", "main.scpt"), "mine");
  assert.throws(
    () => d.compileApp({ name: "work", dataDir: "/data", appPath: scripted, claudeAppPath: "/Applications/Claude.app" }),
    /not a claude-multiprofile launcher/
  );
  assert.equal(fs.readFileSync(path.join(scripted, "Contents", "Resources", "Scripts", "main.scpt"), "utf8"), "mine");

  const src = path.join(root, "a.applescript");
  fs.writeFileSync(src, 'display dialog "x"\n');
  const applet = path.join(root, "Old Launcher.app");
  execFileSync("/usr/bin/osacompile", ["-o", applet, src], { stdio: "pipe" });
  assert.notEqual(d.getBundleId(applet), "com.claude-multiprofile.work");
  d.compileApp({ name: "work", dataDir: "/data/x", appPath: applet, claudeAppPath: "/Applications/Claude.app" });
  assert.equal(d.getBundleId(applet), "com.claude-multiprofile.work", "a pre-v0.1.9 launcher is still rebuilt");
});

test("ensureColoredClone: a rebuild that fails keeps the old copy and leaves nothing behind", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }
  if (process.getuid && process.getuid() === 0) {
    t.skip("root reads unreadable files");
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixd-"));
  const source = path.join(home, "Source.app");
  const locked = path.join(source, "Contents", "Resources", "locked");
  t.after(() => {
    try {
      fs.chmodSync(locked, 0o644);
    } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  });
  fakeApp(source, "1.0.0");

  const run = (force) => runModule(home, `
    const a = await import(${JSON.stringify(path.join(SRC, "appclone.js"))});
    const clone = a.clonePathFor("work");
    try {
      a.ensureColoredClone({ name: "work", claudeAppPath: ${JSON.stringify(source)}, color: null, force: ${force} });
      console.log("built");
    } catch (e) {
      console.log("failed");
    }
  `);

  assert.equal(run(false), "built");
  const clone = path.join(home, "Library", "Application Support", "claude-multiprofile", "apps", "Claude WORK.app");
  assert.equal(fs.readFileSync(path.join(clone, "Contents", "MacOS", "Claude"), "utf8"), "1.0.0");

  fakeApp(source, "2.0.0");
  fs.mkdirSync(path.dirname(locked), { recursive: true });
  fs.writeFileSync(locked, "x");
  fs.chmodSync(locked, 0o000);
  assert.equal(run(true), "failed");
  assert.equal(fs.readFileSync(path.join(clone, "Contents", "MacOS", "Claude"), "utf8"), "1.0.0", "the old copy is still there");
  assert.equal(fs.existsSync(`${clone}.refreshing`), false);
  assert.equal(fs.existsSync(`${clone}.previous`), false);

  fs.chmodSync(locked, 0o644);
  assert.equal(run(true), "built");
  assert.equal(fs.readFileSync(path.join(clone, "Contents", "MacOS", "Claude"), "utf8"), "2.0.0");
  assert.equal(fs.existsSync(path.join(clone, "Source.app")), false, "the copy is not nested inside the old one");
  assert.equal(fs.existsSync(`${clone}.previous`), false);
});

test("launch helper: a failed APFS clone does not leave a partial copy under the real one", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("osascript is macOS only");
    return;
  }
  const { HELPER_JS } = await import("../src/launchhelper.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const failingCp = path.join(root, "cp-c");
  fs.writeFileSync(
    failingCp,
    '#!/bin/sh\nmkdir -p "$2/Contents"\ncp "$1/Contents/Info.plist" "$2/Contents/Info.plist"\necho x > "$2/Contents/partial"\nexit 1\n',
    { mode: 0o755 }
  );
  assert.ok(HELPER_JS.includes("'/bin/cp -Rc '"));
  const script = HELPER_JS
    .replace(/var LOG = .*\n/, `var LOG = ${JSON.stringify(path.join(root, "launch.log"))};\n`)
    .replace(/var LSREGISTER = .*\n/, "var LSREGISTER = '/usr/bin/true';\n")
    .replace("'/bin/cp -Rc '", `'${failingCp} '`);
  const helper = path.join(root, "launch.js");
  fs.writeFileSync(helper, script);

  const source = fakeApp(path.join(root, "Source.app"), "2.0.0");
  const clone = fakeApp(path.join(root, "Claude t.app"), "1.0.0");
  const out = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", helper, clone, source, "", path.join(root, "data"), "Claude T"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  assert.equal(out, "opened");
  assert.equal(fs.readFileSync(path.join(clone, "Contents", "MacOS", "Claude"), "utf8"), "2.0.0");
  assert.equal(fs.existsSync(path.join(clone, "Contents", "partial")), false, "nothing from the failed clone survives");
  assert.equal(fs.existsSync(path.join(clone, "Source.app")), false, "the fallback copy is not nested");
  assert.equal(fs.existsSync(`${clone}.refreshing`), false);
  assert.equal(fs.existsSync(`${clone}.previous`), false);
});

test("clonePathFor: the copy is named like the launcher, so the Dock shows the profile's name", async () => {
  const { clonePathFor, cloneNameFor } = await import("../src/appclone.js");
  const { defaultAppPathFor } = await import("../src/desktop.js");
  for (const [name, shown] of [["personal", "Claude Personal.app"], ["work", "Claude WORK.app"], ["client-acme", "Claude Client Acme.app"]]) {
    assert.equal(cloneNameFor(name), shown);
    assert.equal(path.basename(clonePathFor(name)), shown);
    assert.equal(path.basename(defaultAppPathFor(name)), shown);
  }
});

function migrationSandbox(t, entries) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixd-mig-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const apps = path.join(home, "Library", "Application Support", "claude-multiprofile", "apps");
  for (const e of entries) fakeApp(path.join(apps, e), "1.0.0");
  const run = (code) => JSON.parse(runModule(home, `
    const a = await import(${JSON.stringify(path.join(SRC, "appclone.js"))});
    const d = await import(${JSON.stringify(path.join(SRC, "desktop.js"))});
    console.log(JSON.stringify(await (async () => { ${code} })()));
  `));
  return { home, apps, run };
}

test("migrateClone: a copy whose name differs only in case is renamed", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }
  const s = migrationSandbox(t, ["Claude personal.app", "Claude personal.app.previous"]);
  const before = s.run(`return { current: a.currentClonePath("personal"), plan: a.cloneMigration("personal") };`);
  assert.equal(path.basename(before.current), "Claude personal.app", "the copy on disk is found under its real name");
  assert.equal(before.plan.moves.length, 2);

  const r = s.run(`return a.migrateClone("personal", "");`);
  assert.equal(r.status, "renamed");
  assert.deepEqual(fs.readdirSync(s.apps).sort(), ["Claude Personal.app", "Claude Personal.app.previous"]);
  const after = s.run(`return { current: a.currentClonePath("personal"), plan: a.cloneMigration("personal"), again: a.migrateClone("personal", "").status };`);
  assert.equal(path.basename(after.current), "Claude Personal.app");
  assert.deepEqual(after.plan.moves, []);
  assert.equal(after.again, "none");
});

test("migrateClone: a hyphenated profile's copy moves to the launcher's name, leftovers too", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }
  const s = migrationSandbox(t, ["Claude client-acme.app", "Claude client-acme.app.refreshing"]);
  const before = s.run(`return d.launchTargetFor("client-acme", { claudeAppPath: "/Applications/Claude.app" });`);
  assert.equal(path.basename(before.claudeAppPath), "Claude client-acme.app", "an unmigrated copy is still the launch target");
  assert.equal(before.dedicatedBundle, true);

  assert.equal(s.run(`return a.migrateClone("client-acme", "").status;`), "renamed");
  assert.deepEqual(fs.readdirSync(s.apps).sort(), ["Claude Client Acme.app", "Claude Client Acme.app.refreshing"]);
  const after = s.run(`return d.launchTargetFor("client-acme", { claudeAppPath: "/Applications/Claude.app" });`);
  assert.equal(path.basename(after.claudeAppPath), "Claude Client Acme.app");
});

test("migrateClone: a running copy is left where it is, and still counts as running under either name", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }
  const s = migrationSandbox(t, ["Claude personal.app", "Claude client-acme.app"]);
  const ps = [
    `  101 ${path.join(s.apps, "Claude personal.app")}/Contents/MacOS/Claude --user-data-dir=/x/Claude-Personal`,
    `  102 ${path.join(s.apps, "Claude client-acme.app")}/Contents/MacOS/Claude`,
  ].join("\n");
  const r = s.run(`
    const ps = ${JSON.stringify(ps)};
    return {
      personal: a.migrateClone("personal", ps).status,
      acme: a.migrateClone("client-acme", ps).status,
      runningByNewName: a.cloneIsRunning(a.clonePathFor("personal"), ps),
      personalRunning: a.copyOfProfileRunning("personal", ps),
      acmeRunning: a.copyOfProfileRunning("client-acme", ps),
      otherRunning: a.copyOfProfileRunning("work", ps),
    };
  `);
  assert.equal(r.personal, "running");
  assert.equal(r.acme, "running");
  assert.equal(r.runningByNewName, true, "a case-only rename never hides a running copy");
  assert.equal(r.personalRunning, true);
  assert.equal(r.acmeRunning, true, "the old hyphenated name is still checked");
  assert.equal(r.otherRunning, false);
  assert.deepEqual(fs.readdirSync(s.apps).sort(), ["Claude client-acme.app", "Claude personal.app"]);
});

test("doctor --fix renames an old copy and points the launcher at the new name", (t) => {
  if (process.platform !== "darwin") {
    t.skip("compiles real launchers with osacompile");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fixd-doc-"));
  const home = path.join(root, "home");
  const cfg = path.join(root, "config");
  const appSupport = path.join(home, "Library", "Application Support");
  const apps = path.join(appSupport, "claude-multiprofile", "apps");
  const source = fakeApp(path.join(root, "Source.app"), "2.0.0");
  const oldClone = fakeApp(path.join(apps, "Claude client-acme.app"), "2.0.0");
  const newClone = path.join(apps, "Claude Client Acme.app");
  const dataDir = path.join(appSupport, "Claude-Client Acme");
  fs.mkdirSync(dataDir, { recursive: true });
  const appPath = path.join(home, "Applications", "Claude Client Acme.app");
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  t.after(() => {
    for (const p of [appPath, newClone]) {
      try {
        execFileSync(lsregister, ["-u", p], { stdio: "ignore" });
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, NO_COLOR: "1" };
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { compileApp } from ${JSON.stringify(path.join(SRC, "desktop.js"))};
    compileApp(${JSON.stringify({ name: "client-acme", dataDir, appPath, claudeAppPath: oldClone, dedicatedBundle: true, sourceAppPath: source })});
  `], { env });
  fs.mkdirSync(path.join(cfg, "claude-multiprofile"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "claude-multiprofile", "profiles.json"), JSON.stringify({
    version: 1,
    profiles: [{ name: "client-acme", type: "desktop", code: null, desktop: { dataDir, appPath, claudeAppPath: source, color: null } }],
  }));
  const doctor = (...args) => execFileSync(process.execPath, [path.resolve("bin/claude-multiprofile.js"), "doctor", ...args], { encoding: "utf8", env, timeout: 120_000 });
  const target = () => runModule(home, `
    const d = await import(${JSON.stringify(path.join(SRC, "desktop.js"))});
    console.log(d.launcherOpenTarget(${JSON.stringify(appPath)}));
  `);

  assert.match(doctor(), /client-acme: its copy of Claude still has its old name/);
  assert.equal(target(), oldClone);

  const fixed = doctor("--fix");
  assert.match(fixed, /Repaired: renamed to/);
  assert.deepEqual(fs.readdirSync(apps), ["Claude Client Acme.app"]);
  assert.equal(target(), newClone);
  assert.doesNotMatch(doctor(), /old name|its launcher opens/);
});

test("launch helper: a coloured copy that lost its colour is re-tinted whatever its version", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("osascript is macOS only");
    return;
  }
  const { HELPER_JS } = await import("../src/launchhelper.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-retint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, "launch.js");
  fs.writeFileSync(helper, HELPER_JS);
  const source = fakeApp(path.join(root, "Source.app"), "2.0.0");
  const decide = (clone, hue) =>
    execFileSync("/usr/bin/osascript", ["-l", "JavaScript", helper, clone, source, hue, path.join(root, "data"), "Claude T", "-a", clone], {
      encoding: "utf8",
      env: { ...process.env, CMP_LAUNCH_DRY_RUN: "1" },
    }).trim();

  assert.equal(decide(fakeApp(path.join(root, "Current.app"), "2.0.0"), "160"), "not running: current; would-retint");
  assert.equal(decide(fakeApp(path.join(root, "Ahead.app"), "2.1.0"), "160"), "not running: current; would-retint");
  assert.equal(decide(path.join(root, "Current.app"), ""), "not running: current", "no colour configured, nothing to put back");
  assert.equal(decide(fakeApp(path.join(root, "Behind.app"), "1.0.0"), "160"), "not running: would-refresh 1.0.0 -> 2.0.0", "a refresh tints on its own");
});
