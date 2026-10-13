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
  const clone = path.join(home, "Library", "Application Support", "claude-multiprofile", "apps", "Claude work.app");
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
