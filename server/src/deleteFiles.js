// Deleting files and folders from the sources folders, when the user asks for it.
// Never the target folder, a sources folder itself, anything in a protected
// sources folder, or a file that is queued or converting (or being moved). preview()
// says exactly what would go, so the UI can ask for confirmation; remove() checks
// everything again before deleting. check() also says what can be moved (moveFiles.js).
import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest } from './errors.js';
import { makeFileMatcher, resolveUnderAny } from './paths.js';

const MAX_PATHS = 1000;

export class SourceFiles {
  constructor({ settings, queue, events, log, subtitles = null }) {
    // A deleted or moved video takes its sidecar subtitle files with it (subtitles/service.js).
    this.subtitles = subtitles;
    // Set by the Mover (moveFiles.js): what is being moved can't be deleted or moved again.
    this.mover = null;
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
      if (this.mover?.isMoving(abs)) {
        const name = path.basename(abs);
        blocked.push({ path: abs, code: 'moving', params: { name }, reason: `${name} is being moved, or waiting to be` });
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
