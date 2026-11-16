// Deleting or moving files and folders from the sources folders, when the user asks for it.
// Never the target folder, a sources folder itself, anything in a protected
// sources folder, or a file that is queued or converting. preview() and
// previewMove() say exactly what would happen, so the UI can ask for confirmation;
// remove() and move() check everything again first.
//
// A move goes into any configured folder (a sources folder or the target folder).
// Between disks or shares it is a copy (under a hidden name until complete), and the
// original is removed last, so a failed copy loses nothing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest } from './errors.js';
import { copyBytes, isInside, makeFileMatcher, resolveUnderAny } from './paths.js';
import { moveFile, partName } from './replace.js';

const MAX_PATHS = 1000;

export class SourceFiles {
  /** rename: replaceable for tests (to act as if folders were on different disks). */
  constructor({ settings, queue, events, log, subtitles = null, rename = fs.rename }) {
    // A deleted or moved video takes its sidecar subtitle files with it (subtitles/service.js).
    this.subtitles = subtitles;
    this.rename = rename;
    this.settings = settings;
    this.queue = queue;
    this.events = events;
    this.log = log;
  }

  /**
   * Splits the chosen paths into what can be deleted (or moved: verb 'move') and what
   * cannot (with the reason).
   */
  async check(paths, verb = 'delete') {
    const moving = verb === 'move';
    if (!Array.isArray(paths) || !paths.length) throw badRequest(`Choose files or folders to ${verb}`);
    if (paths.length > MAX_PATHS) throw badRequest(`At most ${MAX_PATHS} items at a time`);
    const items = [];
    const blocked = [];
    for (const p of [...new Set(paths)]) {
      let resolved;
      try {
        resolved = await resolveUnderAny(this.settings.get('sourceRoots'), p);
      } catch (err) {
        blocked.push({ path: p, reason: err.message });
        continue;
      }
      const { root, path: abs } = resolved;
      if (this.settings.get('protectedRoots').includes(root)) {
        blocked.push({
          path: abs, code: 'protected', params: { root },
          reason: moving ? `Files in ${root} are protected: they cannot be moved (Settings → Folders)` : `Files in ${root} are protected from deletion (Settings → Folders)`,
        });
        continue;
      }
      if (abs === root) {
        blocked.push({
          path: abs, code: 'sourcesFolder', params: {},
          reason: moving ? 'A sources folder itself cannot be moved' : 'A sources folder itself cannot be deleted (remove it in Settings instead)',
        });
        continue;
      }
      const st = await fs.lstat(abs);
      const pending = this.queue.pendingSourcesUnder(abs);
      if (pending.length) {
        const what = pending.length === 1 ? path.basename(pending[0].path) : `${pending.length} files inside`;
        blocked.push({
          path: abs,
          code: pending.length === 1 ? 'pendingFile' : 'pendingFiles',
          params: { name: path.basename(pending[0].path), count: pending.length },
          reason: `${what} ${pending.length === 1 ? 'is' : 'are'} queued or converting; remove ${pending.length === 1 ? 'it' : 'them'} from the queue first`,
        });
        continue;
      }
      const dir = st.isDirectory();
      const { files, bytes } = dir ? await measure(abs) : { files: 1, bytes: st.size };
      items.push({ path: abs, type: dir ? 'dir' : 'file', files, bytes });
    }
    if (this.subtitles) {
      const chosen = new Set(items.map((i) => i.path));
      const { isVideo } = makeFileMatcher(this.settings);
      for (const it of items.filter((i) => i.type === 'file' && isVideo(i.path))) {
        for (const p of await this.subtitles.sidecarPaths(it.path)) {
          if (chosen.has(p)) {
            // Chosen as well: still a subtitle file of this video (a move keeps it next to it).
            const own = items.find((i) => i.path === p && !i.sidecarOf);
            if (own && own.type === 'file') own.sidecarOf = it.path;
            continue;
          }
          const size = await fs.lstat(p).then((st) => st.size, () => null);
          if (size == null) continue;
          chosen.add(p);
          items.push({ path: p, type: 'file', files: 1, bytes: size, sidecarOf: it.path });
        }
      }
    }
    // A file inside a folder that is also chosen goes with the folder.
    const dirs = items.filter((i) => i.type === 'dir').map((i) => i.path + path.sep);
    const kept = items.filter((i) => !dirs.some((d) => i.path.startsWith(d)));
    return {
      items: kept,
      blocked,
      files: kept.reduce((s, i) => s + i.files, 0),
      bytes: kept.reduce((s, i) => s + i.bytes, 0),
    };
  }

  preview({ paths }) {
    return this.check(paths);
  }

  /** Deletes what check() allows; returns { deleted, blocked, errors }. */
  async remove({ paths }) {
    const { items, blocked } = await this.check(paths);
    const deleted = [];
    const errors = [];
    for (const it of items) {
      try {
        await fs.rm(it.path, { recursive: it.type === 'dir' });
        deleted.push(it.path);
        this.log.info(`Deleted ${it.type === 'dir' ? 'folder' : 'file'} ${it.path} (${it.files} file(s), ${it.bytes} bytes)`);
      } catch (err) {
        errors.push({ path: it.path, reason: err.message });
      }
    }
    if (deleted.length) this.events.emit('files', { deleted: deleted.length });
    return { deleted, blocked, errors };
  }

  // ---------------------------------------------------------------- moving

  /** The destination folder: a folder under a sources folder or the target folder. */
  async destination(dest) {
    if (typeof dest !== 'string' || !dest) throw badRequest('Choose the folder to move to');
    const roots = [...this.settings.get('sourceRoots'), this.settings.get('targetRoot')];
    const { path: dir } = await resolveUnderAny(roots, dest);
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw badRequest(`Not a folder: ${dest}`);
    return dir;
  }

  /**
   * What moving the chosen paths into dest would do: check() plus, for each item, where it
   * goes (`to`). A video's subtitle files keep their place next to it (in Subs/... too).
   * Also refused: an item already in that folder, a folder into itself, and a name already
   * taken in the destination (nothing is ever overwritten).
   */
  async previewMove({ paths, dest }) {
    const dir = await this.destination(dest);
    const checked = await this.check(paths, 'move');
    const blocked = [...checked.blocked];
    const items = [];
    const refused = new Set();
    const taken = new Set();
    // Videos before subtitle files: a subtitle file only goes with its video.
    const ordered = [...checked.items.filter((i) => !i.sidecarOf), ...checked.items.filter((i) => i.sidecarOf)];
    for (const it of ordered) {
      const to = it.sidecarOf
        ? path.join(dir, path.relative(path.dirname(it.sidecarOf), it.path))
        : path.join(dir, path.basename(it.path));
      const name = path.basename(it.path);
      let problem = null;
      if (it.sidecarOf && refused.has(it.sidecarOf)) continue; // subtitle files only go with their video
      if (!it.sidecarOf && path.dirname(it.path) === dir) {
        problem = { code: 'sameFolder', params: { name }, reason: `${name} is already in that folder` };
      } else if (it.type === 'dir' && isInside(it.path, dir)) {
        problem = { code: 'intoItself', params: { name }, reason: `The folder ${name} cannot be moved into itself` };
      } else if (taken.has(to) || (await exists(to)) || (await exists(partName(to)))) {
        const n = path.basename(to);
        problem = { code: 'exists', params: { name: n }, reason: `${n} already exists in the destination folder` };
      }
      if (problem) {
        blocked.push({ path: it.path, ...problem });
        refused.add(it.path);
      } else {
        taken.add(to);
        items.push({ ...it, to });
      }
    }
    return {
      dest: dir,
      items,
      blocked,
      files: items.reduce((s, i) => s + i.files, 0),
      bytes: items.reduce((s, i) => s + i.bytes, 0),
    };
  }

  /** Moves what previewMove() allows; returns { moved: [{ from, to }], blocked, errors }. */
  async move({ paths, dest }) {
    const { items, blocked } = await this.previewMove({ paths, dest });
    const moved = [];
    const errors = [];
    for (const it of items) {
      try {
        await fs.mkdir(path.dirname(it.to), { recursive: true });
        const { copied } = it.type === 'dir'
          ? await moveTree(it.path, it.to, { rename: this.rename })
          : await moveFile(it.path, it.to, { rename: this.rename });
        moved.push({ from: it.path, to: it.to });
        this.log.info(`Moved ${it.type === 'dir' ? 'folder' : 'file'} ${it.path} to ${it.to}${copied ? ' (copied, then removed)' : ''} (${it.files} file(s), ${it.bytes} bytes)`);
      } catch (err) {
        errors.push({ path: it.path, reason: err.message });
      }
    }
    if (moved.length) this.events.emit('files', { moved: moved.length });
    return { moved, blocked, errors };
  }
}

const exists = (p) => fs.lstat(p).then(() => true, () => false);

/**
 * Moves a folder, also between disks or shares: rename, or a copy of everything in it (into a
 * hidden folder, renamed when complete), and then the original is removed. A failed copy is
 * cleaned up and leaves the original as it was. Returns { copied }.
 */
export async function moveTree(from, to, { rename = fs.rename } = {}) {
  try {
    await rename(from, to);
    return { copied: false };
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  const part = partName(to);
  try {
    await copyTree(from, part);
    await fs.rename(part, to);
  } catch (err) {
    await fs.rm(part, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  try {
    await fs.rm(from, { recursive: true });
  } catch (err) {
    throw new Error(`Copied to ${to}, but the original could not be removed: ${err.message}`);
  }
  return { copied: true };
}

/** Copies a folder's contents (symlinks as symlinks) as plain bytes: see copyBytes. */
async function copyTree(from, to) {
  await fs.mkdir(to);
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b);
    else if (e.isSymbolicLink()) await fs.symlink(await fs.readlink(a), b);
    else await copyBytes(a, b);
  }
}

/** Files and bytes inside a folder (symlinks counted, not followed). */
async function measure(dir) {
  let files = 0;
  let bytes = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await measure(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files++;
      bytes += await fs.lstat(full).then((s) => s.size, () => 0);
    }
  }
  return { files, bytes };
}
