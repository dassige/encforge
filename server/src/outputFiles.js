// Moving or deleting the converted files of jobs, from the queue.
//
// A job's converted file (its outputPath) can go when the job is converted, isn't being checked,
// its original isn't being replaced, nothing in the queue is about to write the same file, and the
// file is in the target folder or an unprotected sources folder. Once its original was replaced
// (and the converted file not kept), the converted file *is* the video in the sources folder:
// that is left to Sources. Its subtitle files next to it go along, as with Sources.
//
// Moves go to the background list of moveFiles.js (same progress bar, Cancel, copy between
// disks); when one is done, the jobs' output paths follow it. Deleting removes the file and its
// subtitle files, then the jobs (the conversion stays in the statistics).
import fs from 'node:fs/promises';
import path from 'node:path';
import { badRequest } from './errors.js';
import { resolveUnderAny } from './paths.js';

const MAX_JOBS = 1000;
const PENDING = ['queued', 'running', 'paused'];

const sizeOf = (p) => fs.lstat(p).then((st) => (st.isFile() ? st.size : null), () => null);

export class OutputFiles {
  constructor({ db, settings, queue, mover, replacer = null, subtitles = null, events, log }) {
    Object.assign(this, { db, settings, queue, mover, replacer, subtitles, events, log });
    mover.outputs = this;
  }

  /** Why job's converted file can't be moved or deleted now ({ code, params, reason }), or null. */
  async problem(job) {
    const name = path.basename(job.outputPath);
    const no = (code, reason, params = {}) => ({ code, params: { name, ...params }, reason });
    if (job.status !== 'done') return no('notDone', `${name} is not converted (yet)`);
    if (job.verifyStatus === 'running') return no('checking', `${name} is being checked; wait for the check`);
    if (job.replaced && !job.replaced.keptConverted) {
      return no('replacedOriginal', `${name} replaced its original: it is now in the sources folder (use Sources)`);
    }
    if (this.replacer?.isReplacing(job.id)) return no('replacing', `The original of ${name} is being replaced`);
    if ((await sizeOf(job.outputPath)) == null) return no('gone', `${name} no longer exists`);
    let resolved;
    try {
      resolved = await resolveUnderAny([this.settings.get('targetRoot'), ...this.settings.get('sourceRoots')], job.outputPath);
    } catch {
      return no('outside', `${name} is no longer in the target folder or a sources folder`);
    }
    if (this.settings.get('protectedRoots').includes(resolved.root)) {
      return no('protected', `Files in ${resolved.root} are protected (Settings → Folders)`, { root: resolved.root });
    }
    if (this.mover.isMoving(job.outputPath)) return no('moving', `${name} is being moved, or waiting to be`);
    const again = this.db
      .prepare(`SELECT 1 FROM jobs WHERE output_path = ? AND status IN (${PENDING.map(() => '?').join(',')}) LIMIT 1`)
      .get(job.outputPath, ...PENDING);
    if (again) return no('pendingOutput', `${name} is queued to be converted again; remove that job from the queue first`);
    return null;
  }

  /**
   * Splits the jobs' converted files into what can be moved or deleted (items, as SourceFiles.check
   * gives them, plus jobIds: every converted job with that output) and what not (blocked, with jobId).
   */
  async check(ids, verb = 'delete') {
    if (!Array.isArray(ids) || !ids.length) throw badRequest(`Choose the jobs whose converted files to ${verb}`);
    if (ids.length > MAX_JOBS) throw badRequest(`At most ${MAX_JOBS} jobs at a time`);
    const items = [];
    const blocked = [];
    const byPath = new Map();
    for (const id of [...new Set(ids.map(Number))]) {
      let job;
      try {
        job = this.queue.get(id);
      } catch {
        blocked.push({ path: '', jobId: id, code: 'noJob', params: { id }, reason: `Job ${id} not found` });
        continue;
      }
      if (byPath.has(job.outputPath)) continue;
      const problem = await this.problem(job);
      if (problem) {
        blocked.push({ path: job.outputPath, jobId: job.id, ...problem });
        continue;
      }
      // Converted again into the same file: those jobs all show this file.
      const jobIds = this.db.prepare(`SELECT id FROM jobs WHERE output_path = ? AND status = 'done' ORDER BY id`).all(job.outputPath).map((r) => r.id);
      const item = { path: job.outputPath, type: 'file', files: 1, bytes: await sizeOf(job.outputPath), jobIds };
      byPath.set(job.outputPath, item);
      items.push(item);
    }
    if (this.subtitles) {
      const chosen = new Set(items.map((i) => i.path));
      for (const it of [...items]) {
        for (const p of await this.subtitles.sidecarPaths(it.path)) {
          if (chosen.has(p)) continue;
          const size = await sizeOf(p);
          if (size == null) continue;
          chosen.add(p);
          items.push({ path: p, type: 'file', files: 1, bytes: size, sidecarOf: it.path });
        }
      }
    }
    return { items, blocked, files: items.length, bytes: items.reduce((s, i) => s + i.bytes, 0) };
  }

  // ---------------------------------------------------------------- delete

  previewDelete({ ids }) {
    return this.check(ids, 'delete');
  }

  /**
   * Deletes what check() allows (a video's subtitle files only once the video is gone), then
   * removes those jobs. Returns { deleted: [paths], removedJobs: [ids], blocked, errors }.
   */
  async remove({ ids }) {
    const { items, blocked } = await this.check(ids, 'delete');
    const deleted = [];
    const removedJobs = [];
    const errors = [];
    const failed = new Set();
    for (const it of items) {
      if (it.sidecarOf && failed.has(it.sidecarOf)) continue;
      try {
        await fs.rm(it.path);
        deleted.push(it.path);
        if (it.jobIds) removedJobs.push(...it.jobIds);
        this.log.info(`Deleted converted file ${it.path} (${it.bytes} bytes)${it.jobIds ? `, job(s) ${it.jobIds.join(', ')}` : ''}`);
      } catch (err) {
        failed.add(it.path);
        errors.push({ path: it.path, reason: err.message });
      }
    }
    if (removedJobs.length) await this.queue.remove(removedJobs);
    if (deleted.length) this.events.emit('files', { deleted: deleted.length });
    return { deleted, removedJobs, blocked, errors };
  }

  // ---------------------------------------------------------------- move

  async previewMove({ ids, dest }) {
    const dir = await this.mover.destination(dest);
    return this.mover.plan(await this.check(ids, 'move'), dir);
  }

  /** Adds what can be moved to the background list of moves. Returns { blocked, move }. */
  async startMove({ ids, dest }) {
    return this.mover.enqueue(await this.previewMove({ ids, dest }));
  }

  /** Just before the mover moves a converted file: why not now ({ code, params, reason }), or null. */
  async recheck(item) {
    const name = path.basename(item.path);
    for (const id of item.jobIds) {
      if (this.replacer?.isReplacing(id)) return { code: 'replacing', params: { name }, reason: `The original of ${name} is being replaced` };
    }
    const again = this.db
      .prepare(`SELECT 1 FROM jobs WHERE output_path = ? AND status IN (${PENDING.map(() => '?').join(',')}) LIMIT 1`)
      .get(item.path, ...PENDING);
    if (again) return { code: 'pendingOutput', params: { name }, reason: `${name} is queued to be converted again; remove that job from the queue first` };
    return null;
  }

  /** A converted file was moved: its jobs now point at the new place. */
  moved(item) {
    const update = this.db.prepare(`UPDATE jobs SET output_path = ? WHERE id = ? AND output_path = ?`);
    for (const id of item.jobIds) {
      if (update.run(item.to, id, item.path).changes) this.queue.emitJob(id);
    }
  }
}
