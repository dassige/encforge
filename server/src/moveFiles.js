// Moving files and folders from the sources folders into another folder (any sources folder or
// the target folder), when the user asks for it.
//
// What can be moved follows the delete rules (deleteFiles.js: never a sources folder itself,
// anything in a protected sources folder, or files that are queued or converting); also refused
// are an item already in the destination, a folder into itself, and a name already taken there:
// nothing is overwritten. A video's subtitle files go with it and keep their place next to it.
//
// The moves run in the background, one item at a time, also with no browser open: a list like
// the one of replace.js, sent as `move` events with how far the copy is. More moves can be added
// while it runs. Between disks or shares a move is a copy (under a hidden name until complete)
// and the original is removed last, so a failed or cancelled copy loses nothing. Cancelling
// stops the copy in progress (the original stays), skips the rest, and keeps what was moved.
import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict } from './errors.js';
import { copyBytes, isInside, resolveUnderAny } from './paths.js';
import { moveFile, partName } from './replace.js';

/** How often progress goes out to the browsers (ms). */
const PROGRESS_EVERY = 500;
const ACTIVE = new Set(['waiting', 'moving']);

const exists = (p) => fs.lstat(p).then(() => true, () => false);

/** An error with a code (and params) the app translates; message is the English text. */
function refusal(code, params, message) {
  return Object.assign(new Error(message), { moveCode: code, params });
}

export class Mover {
  /** rename: replaceable for tests (to act as if folders were on different disks). */
  constructor({ sourceFiles, settings, queue, events, log, rename = fs.rename, progressEvery = PROGRESS_EVERY }) {
    Object.assign(this, { sourceFiles, settings, queue, events, log, rename, progressEvery });
    // Deleting or moving again what is waiting or being moved is refused (deleteFiles.js).
    sourceFiles.mover = this;
    // Set by OutputFiles (outputFiles.js): checks and updates the jobs of converted files moved.
    this.outputs = null;
    this.batch = null;
    this.working = null;
    this.abort = null;
    this.lastProgress = 0;
  }

  // ---------------------------------------------------------------- checks

  /** The destination folder: a folder under a sources folder or the target folder. */
  async destination(dest) {
    if (typeof dest !== 'string' || !dest) throw badRequest('Choose the folder to move to');
    const roots = [...this.settings.get('sourceRoots'), this.settings.get('targetRoot')];
    const { path: dir } = await resolveUnderAny(roots, dest);
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw badRequest(`Not a folder: ${dest}`);
    return dir;
  }

  active() {
    return (this.batch?.items ?? []).filter((i) => ACTIVE.has(i.status));
  }

  /** True when p is waiting or being moved, is inside such a folder, or holds such an item. */
  isMoving(p) {
    return this.active().some((i) => isInside(i.path, p) || isInside(p, i.path));
  }

  /**
   * What moving the chosen paths into dest would do: for each item, where it goes (`to`),
   * and what is refused, with the reason. Changes nothing.
   */
  async previewMove({ paths, dest }) {
    const dir = await this.destination(dest);
    return this.plan(await this.sourceFiles.check(paths, 'move'), dir);
  }

  /**
   * Where each checked item ({ items, blocked } as from SourceFiles.check) would go in the folder
   * dir, refusing what can't go there. Items with jobIds are converted files (outputFiles.js).
   */
  async plan(checked, dir) {
    const blocked = [...checked.blocked];
    const items = [];
    const refused = new Set();
    // Names that moves still waiting will take.
    const taken = new Set(this.active().map((i) => i.to));
    // Videos before subtitle files: a subtitle file only goes with its video.
    const ordered = [...checked.items.filter((i) => !i.sidecarOf), ...checked.items.filter((i) => i.sidecarOf)];
    for (const it of ordered) {
      if (it.sidecarOf && refused.has(it.sidecarOf)) continue;
      const to = it.sidecarOf
        ? path.join(dir, path.relative(path.dirname(it.sidecarOf), it.path))
        : path.join(dir, path.basename(it.path));
      const name = path.basename(it.path);
      let problem = null;
      if (!it.sidecarOf && path.dirname(it.path) === dir) {
        problem = { code: 'sameFolder', params: { name }, reason: `${name} is already in that folder` };
      } else if (it.type === 'dir' && isInside(it.path, dir)) {
        problem = { code: 'intoItself', params: { name }, reason: `The folder ${name} cannot be moved into itself` };
      } else if (taken.has(to) || (await exists(to))) {
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

  // ---------------------------------------------------------------- in the background

  /**
   * The list: { running, cancelling, startedAt, finishedAt, bytes, doneBytes,
   * items: [{ path, to, name, type, files, bytes, sidecarOf, status, error, code, params }],
   * current: { path, done } | null }. status: waiting | moving | done | failed | cancelled.
   * bytes: of every item; doneBytes: of the items finished (moved or not) plus the copy in
   * progress. null when there is none (never started, or cleared).
   */
  state() {
    const b = this.batch;
    if (!b) return null;
    const items = b.items.map((i) => ({ ...i }));
    const bytes = items.reduce((s, i) => s + i.bytes, 0);
    const doneBytes = items.filter((i) => !ACTIVE.has(i.status)).reduce((s, i) => s + i.bytes, 0) + (b.current?.done ?? 0);
    return { running: b.running, cancelling: b.cancelling, startedAt: b.startedAt, finishedAt: b.finishedAt, bytes, doneBytes, items, current: b.current && { ...b.current } };
  }

  emit() {
    this.lastProgress = Date.now();
    this.events.emit('move', this.state());
  }

  /**
   * Checks the chosen paths (like previewMove) and adds what can be moved to the list, which
   * the server works through in the background. Returns { blocked, move: the list }.
   */
  async start({ paths, dest }) {
    if (this.batch?.cancelling) throw conflict('Moving is being cancelled; try again in a moment');
    return this.enqueue(await this.previewMove({ paths, dest }));
  }

  /** Adds planned items (from plan()) to the list and starts on it. Returns { blocked, move: the list }. */
  enqueue({ items, blocked }) {
    if (this.batch?.cancelling) throw conflict('Moving is being cancelled; try again in a moment');
    if (items.length) {
      if (!this.batch?.running) {
        this.batch = { running: true, cancelling: false, startedAt: Date.now(), finishedAt: null, items: [], current: null };
      }
      for (const it of items) {
        this.batch.items.push({
          path: it.path, to: it.to, name: path.basename(it.path), type: it.type, files: it.files, bytes: it.bytes,
          sidecarOf: it.sidecarOf ?? null, status: 'waiting', error: null, code: null, params: null,
          // A converted file: the jobs whose output it is (their output path follows the move).
          ...(it.jobIds ? { jobIds: it.jobIds } : {}),
        });
      }
      this.emit();
      this.working ??= this.work();
    }
    return { blocked, move: this.state() };
  }

  /** Stops the copy in progress (the original stays where it was) and skips the rest. */
  cancel() {
    if (!this.batch?.running) throw conflict('Nothing is being moved');
    this.batch.cancelling = true;
    this.abort?.abort();
    this.emit();
    return this.state();
  }

  /** Forgets a finished list (its summary in the app). */
  clear() {
    if (this.batch?.running) throw conflict('Files are being moved; cancel first');
    this.batch = null;
    this.emit();
  }

  /** Resolves when the list is worked through (for tests). */
  idle() {
    return this.working ?? Promise.resolve();
  }

  async work() {
    const b = this.batch;
    try {
      const next = () => b.items.find((i) => i.status === 'waiting');
      for (let item = next(); item && !b.cancelling; item = next()) {
        const video = item.sidecarOf && b.items.find((i) => i.path === item.sidecarOf && !i.sidecarOf);
        if (video && video.status !== 'done') {
          Object.assign(item, { status: 'failed', code: 'videoNotMoved', params: { name: video.name }, error: `${video.name} was not moved` });
          continue;
        }
        item.status = 'moving';
        b.current = { path: item.path, done: 0 };
        this.emit();
        const controller = new AbortController();
        this.abort = controller;
        try {
          const { copied } = await this.moveOne(item, {
            signal: controller.signal,
            onProgress: (done) => {
              b.current = { path: item.path, done: Math.min(done, item.bytes) };
              if (Date.now() - this.lastProgress >= this.progressEvery) this.emit();
            },
          });
          item.status = 'done';
          if (item.jobIds) this.outputs?.moved(item);
          this.log.info(`Moved ${item.type === 'dir' ? 'folder' : 'file'} ${item.path} to ${item.to}${copied ? ' (copied, then removed)' : ''} (${item.files} file(s), ${item.bytes} bytes)`);
          this.events.emit('files', { moved: 1 });
        } catch (err) {
          if (controller.signal.aborted) {
            item.status = 'cancelled';
          } else {
            Object.assign(item, { status: 'failed', error: err.message, code: err.moveCode ?? null, params: err.params ?? null });
            this.log.warn(`Moving ${item.path} to ${item.to} failed: ${err.message}`);
          }
        } finally {
          this.abort = null;
        }
        b.current = null;
        this.emit();
      }
    } finally {
      for (const i of b.items) if (i.status === 'waiting') i.status = 'cancelled';
      b.running = false;
      b.cancelling = false;
      b.current = null;
      b.finishedAt = Date.now();
      this.working = null;
      this.emit();
    }
  }

  /** Moves one item, checking again what may have changed since it was added. */
  async moveOne(item, { signal, onProgress }) {
    const name = item.name;
    if (!(await exists(item.path))) throw refusal('gone', { name }, `${name} no longer exists`);
    if (item.jobIds) {
      // A converted file: e.g. its original may have started being replaced meanwhile.
      const problem = this.outputs ? await this.outputs.recheck(item) : null;
      if (problem) throw refusal(problem.code, problem.params, problem.reason);
    } else if (!item.sidecarOf && this.queue.pendingSourcesUnder(item.path).length) {
      throw refusal('pendingFile', { name }, `${name} is queued or converting; remove it from the queue first`);
    }
    if (await exists(item.to)) {
      const n = path.basename(item.to);
      throw refusal('exists', { name: n }, `${n} already exists in the destination folder`);
    }
    await fs.mkdir(path.dirname(item.to), { recursive: true });
    return item.type === 'dir'
      ? moveTree(item.path, item.to, { rename: this.rename, signal, onProgress })
      : moveFile(item.path, item.to, { rename: this.rename, signal, onProgress });
  }
}

/**
 * Moves a folder, also between disks or shares: rename, or a copy of everything in it (into a
 * hidden folder, renamed when complete), and then the original is removed. A failed or
 * cancelled copy is cleaned up and leaves the original as it was. onProgress(bytes copied so
 * far); signal: stops the copy. Returns { copied }.
 */
export async function moveTree(from, to, { rename = fs.rename, signal = null, onProgress = null } = {}) {
  try {
    await rename(from, to);
    return { copied: false };
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  const part = partName(to);
  // A copy left by a restart in the middle of a move.
  await fs.rm(part, { recursive: true, force: true });
  try {
    await copyTree(from, part, { signal, onProgress, copied: 0 });
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
async function copyTree(from, to, progress) {
  const { signal, onProgress } = progress;
  await fs.mkdir(to);
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    signal?.throwIfAborted();
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) {
      await copyTree(a, b, progress);
    } else if (e.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(a), b);
    } else {
      const before = progress.copied;
      await copyBytes(a, b, onProgress && ((done) => onProgress(before + done)), signal);
      progress.copied = before + (await fs.lstat(b)).size;
      onProgress?.(progress.copied);
    }
  }
}
