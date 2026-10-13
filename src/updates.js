// Stopping a profile's copy of Claude from updating itself (issue #9).
//
// Each Desktop profile launches its own copy of Claude.app. That copy is a
// real Claude, so Claude's updater runs inside it, replaces the whole app, and
// relaunches it WITHOUT the launcher's --user-data-dir. The relaunched window
// is on the shared default account while looking like the profile, and the
// update also throws away the profile's colour.
//
// Claude supports a policy for this, `disableAutoUpdates` ("Block
// auto-updates"). Its machine-wide form, a managed plist in
// /Library/Managed Preferences, would also stop /Applications/Claude.app
// updating, and that app is the one every profile copy is rebuilt from. The
// local form is per profile, because Claude derives its folder from the data
// directory: a profile launched with --user-data-dir=<dir> reads
// <dir>-3p/configLibrary/. Verified on Claude 2.7032.0 with a fresh profile:
// the updater logged "Auto-updates disabled by enterprise policy" and never
// started, and the app stayed on claude.ai rather than switching to
// third-party inference mode.
//
// That folder is also where Claude keeps a user's own third-party inference
// setup (Bedrock, Vertex, a gateway). So the tool only ever writes it when it
// does not exist, marks what it wrote, and never edits a configuration it did
// not create.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileExists } from "./util.js";

const MARKER = ".claude-multiprofile";

// Mirrors Claude's own rule: a data dir already ending in -3p is used as is.
export function localConfigRootFor(dataDir) {
  const dir = path.resolve(dataDir);
  return dir.endsWith("-3p") ? dir : `${dir}-3p`;
}

function libraryDir(dataDir) {
  return path.join(localConfigRootFor(dataDir), "configLibrary");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function markerEntryId(root) {
  const marker = readJson(path.join(root, MARKER));
  const id = isPlainObject(marker) ? marker.entryId : null;
  return typeof id === "string" && /^[A-Za-z0-9-]+$/.test(id) ? id : null;
}

function isOwnEntry(entry) {
  return isPlainObject(entry) && Object.keys(entry).every((k) => k === "disableAutoUpdates");
}

function isOwnMeta(meta, id) {
  return (
    isPlainObject(meta) &&
    meta.appliedId === id &&
    Object.keys(meta).every((k) => k === "appliedId" || k === "entries") &&
    Array.isArray(meta.entries) &&
    meta.entries.every((e) => isPlainObject(e) && e.id === id)
  );
}

function stateAt(root) {
  const lib = path.join(root, "configLibrary");
  const meta = readJson(path.join(lib, "_meta.json"));
  if (!meta) return { state: "absent", blocked: false };

  const entryFile = meta.appliedId ? path.join(lib, `${meta.appliedId}.json`) : null;
  const entry = entryFile ? readJson(entryFile) : null;
  const blocked = Boolean(entry && entry.disableAutoUpdates === true);

  const id = markerEntryId(root);
  let names = [];
  try {
    names = fs.readdirSync(lib);
  } catch {
    names = [];
  }
  const ours =
    Boolean(id) &&
    isOwnMeta(meta, id) &&
    names.every((n) => n === "_meta.json" || n === `${id}.json`) &&
    (!fileExists(entryFile) || isOwnEntry(entry));
  if (ours) return { state: blocked ? "blocked" : "absent", blocked };
  return { state: "foreign", blocked };
}

function removeIfEmpty(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function removeOwnFiles(root) {
  const lib = path.join(root, "configLibrary");
  const removed = [];
  const id = markerEntryId(root);
  if (id) {
    const entryFile = path.join(lib, `${id}.json`);
    if (fileExists(entryFile) && isOwnEntry(readJson(entryFile))) {
      fs.rmSync(entryFile, { force: true });
      removed.push(entryFile);
    }
    const metaFile = path.join(lib, "_meta.json");
    if (!fileExists(entryFile) && fileExists(metaFile) && isOwnMeta(readJson(metaFile), id)) {
      fs.rmSync(metaFile, { force: true });
      removed.push(metaFile);
    }
  }
  const markerFile = path.join(root, MARKER);
  if (fileExists(markerFile)) {
    fs.rmSync(markerFile, { force: true });
    removed.push(markerFile);
  }
  if (removeIfEmpty(lib)) removed.push(lib);
  if (removeIfEmpty(root)) removed.push(root);
  return removed;
}

// Where a profile stands:
//   "blocked"  the tool's own block is in place
//   "absent"   no local configuration at all; the copy updates itself
//   "foreign"  a local configuration the tool did not write, which may be the
//              user's third-party inference setup. Never touched. `blocked`
//              says whether it happens to block updates anyway.
export function updateBlockState(dataDir) {
  return stateAt(localConfigRootFor(dataDir));
}

// Returns "created", "already", or "foreign" (left alone).
export function blockUpdates(dataDir) {
  const current = updateBlockState(dataDir);
  if (current.state === "blocked") return "already";
  if (current.state === "foreign") return "foreign";

  const root = localConfigRootFor(dataDir);
  const lib = libraryDir(dataDir);
  if (fileExists(path.join(root, MARKER))) removeOwnFiles(root);
  if (fileExists(lib)) return "foreign";

  fs.mkdirSync(lib, { recursive: true });
  const id = crypto.randomUUID();
  // The same shape Claude writes for itself: one applied entry named
  // "Default". Only the key differs, so this matches what was verified.
  fs.writeFileSync(
    path.join(lib, `${id}.json`),
    JSON.stringify({ disableAutoUpdates: true }, null, 2) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(lib, "_meta.json"),
    JSON.stringify({ appliedId: id, entries: [{ id, name: "Default" }] }) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, MARKER),
    JSON.stringify({ entryId: id, writtenBy: "claude-multiprofile", why: "blocks this profile's copy of Claude from updating itself; see issue #9" }, null, 2) + "\n",
    "utf8"
  );
  return "created";
}

export function removeUpdateBlockAt(root) {
  if (!fileExists(path.join(root, MARKER))) return null;
  if (stateAt(root).state === "foreign") return null;
  return removeOwnFiles(root);
}

// Removes only what the tool wrote. Returns true if anything was removed.
export function unblockUpdates(dataDir) {
  return removeUpdateBlockAt(localConfigRootFor(dataDir)) !== null;
}

// For rename: carry our block along when the data dir moves. Claude derives
// the folder from the data dir, so a block left at the old name would stop
// applying. A foreign configuration is the user's to move.
export function moveUpdateBlock(oldDataDir, newDataDir) {
  const from = localConfigRootFor(oldDataDir);
  const to = localConfigRootFor(newDataDir);
  if (!fileExists(path.join(from, MARKER)) || fileExists(to)) return false;
  fs.renameSync(from, to);
  return true;
}

// Whether a profile SHOULD be blocked. Absent means yes: blocking is the
// default, and `self-update on` records the choice to let Claude update the
// copy itself.
export function wantsUpdateBlock(profile) {
  return Boolean(profile && profile.desktop) && profile.desktop.selfUpdate !== true;
}
