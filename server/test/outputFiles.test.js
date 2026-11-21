// Moving and deleting converted files from the queue (outputFiles.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { Settings } from '../src/settings.js';
import { Queue } from '../src/queue.js';
import { SourceFiles } from '../src/deleteFiles.js';
import { Mover } from '../src/moveFiles.js';
import { OutputFiles } from '../src/outputFiles.js';

const quiet = { info() {}, warn() {}, error() {} };

async function setup() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encforge-output-')));
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'out');
  const data = path.join(dir, 'data');
  for (const x of [src, path.join(out, 'Films'), path.join(out, 'Archive'), path.join(data, 'logs')]) await fs.mkdir(x, { recursive: true });
  const db = openDb(':memory:');
  const settings = new Settings(db, { initialSourceRoot: src, initialTargetRoot: out });
  const emitted = [];
  const events = { emit: (type) => emitted.push(type) };
  const queue = new Queue({ db, settings, presets: {}, handbrake: {}, verifier: null, events, dataDir: data, log: quiet });
  // Subtitle files: "<name>.en.srt" next to the video, when present.
  const subtitles = {
    sidecarPaths: async (video) => {
      const p = video.replace(/\.\w+$/, '.en.srt');
      return fs.access(p).then(() => [p], () => []);
    },
  };
  const sourceFiles = new SourceFiles({ settings, queue, events, log: quiet, subtitles });
  const mover = new Mover({ sourceFiles, settings, queue, events, log: quiet, progressEvery: 0 });
  const replacing = new Set();
  const replacer = { isReplacing: (id) => replacing.has(id) };
  const outputs = new OutputFiles({ db, settings, queue, mover, replacer, subtitles, events, log: quiet });
  const ins = db.prepare(`INSERT INTO jobs (status, position, source_path, output_path, preset_name, preset_json, format, created_at, verify_status, replaced)
    VALUES (?, 1, ?, ?, 'P', '{}', 'av_mkv', ?, ?, ?)`);
  /** A job; its converted file is written when it is done. */
  const job = async (name, { status = 'done', verify = 'ok', replaced = null, output = path.join(out, 'Films', name), write = status === 'done' } = {}) => {
    if (write) await fs.writeFile(output, `converted ${name}`);
    return Number(ins.run(status, path.join(src, name), output, Date.now(), verify, replaced && JSON.stringify(replaced)).lastInsertRowid);
  };
  const there = (p) => fs.access(p).then(() => true, () => false);
  return { dir, src, out, db, queue, mover, outputs, job, there, replacing, emitted, done: () => fs.rm(dir, { recursive: true }) };
}

test('output files: moving takes subtitle files along and the job follows the file', async () => {
  const s = await setup();
  try {
    const id = await s.job('Film.mkv');
    await fs.writeFile(path.join(s.out, 'Films', 'Film.en.srt'), 'subs');
    const dest = path.join(s.out, 'Archive');
    const preview = await s.outputs.previewMove({ ids: [id], dest });
    assert.deepEqual(preview.items.map((i) => path.basename(i.to)), ['Film.mkv', 'Film.en.srt']);
    assert.deepEqual(preview.blocked, []);
    await s.outputs.startMove({ ids: [id], dest });
    await s.mover.idle();
    assert.ok(await s.there(path.join(dest, 'Film.mkv')));
    assert.ok(await s.there(path.join(dest, 'Film.en.srt')));
    assert.ok(!(await s.there(path.join(s.out, 'Films', 'Film.mkv'))));
    assert.equal(s.queue.get(id).outputPath, path.join(dest, 'Film.mkv'));
    assert.ok(s.emitted.includes('job'));
  } finally {
    await s.done();
  }
});

test('output files: what cannot be moved or deleted is refused, with the reason', async () => {
  const s = await setup();
  try {
    const queued = await s.job('Queued.mkv', { status: 'queued' });
    const checking = await s.job('Checking.mkv', { verify: 'running' });
    const replacedHere = await s.job('Replaced.mkv', { replaced: { path: '/x', keptConverted: false } });
    const replacing = await s.job('Replacing.mkv');
    s.replacing.add(replacing);
    const gone = await s.job('Gone.mkv', { write: false });
    const again = await s.job('Again.mkv');
    await s.job('Again.mkv', { status: 'queued', write: false }); // converting it again
    const ok = await s.job('Ok.mkv');
    const r = await s.outputs.previewDelete({ ids: [queued, checking, replacedHere, replacing, gone, again, ok, 999] });
    assert.deepEqual(r.items.map((i) => path.basename(i.path)), ['Ok.mkv']);
    assert.deepEqual(
      Object.fromEntries(r.blocked.map((b) => [b.jobId, b.code])),
      { [queued]: 'notDone', [checking]: 'checking', [replacedHere]: 'replacedOriginal', [replacing]: 'replacing', [gone]: 'gone', [again]: 'pendingOutput', 999: 'noJob' },
    );
    // A name taken in the destination: nothing is overwritten.
    await fs.writeFile(path.join(s.out, 'Archive', 'Ok.mkv'), 'other');
    const m = await s.outputs.previewMove({ ids: [ok], dest: path.join(s.out, 'Archive') });
    assert.deepEqual(m.items, []);
    assert.equal(m.blocked[0].code, 'exists');
    // Already in that folder.
    assert.equal((await s.outputs.previewMove({ ids: [ok], dest: path.join(s.out, 'Films') })).blocked[0].code, 'sameFolder');
  } finally {
    await s.done();
  }
});

test('output files: deleting removes the file, its subtitle files and the jobs', async () => {
  const s = await setup();
  try {
    const first = await s.job('Film.mkv');
    const second = await s.job('Film.mkv'); // converted again into the same file
    const other = await s.job('Other.mkv');
    await fs.writeFile(path.join(s.out, 'Films', 'Film.en.srt'), 'subs');
    const r = await s.outputs.remove({ ids: [first] });
    assert.deepEqual(r.deleted.map((p) => path.basename(p)), ['Film.mkv', 'Film.en.srt']);
    assert.deepEqual(r.removedJobs, [first, second]);
    assert.ok(!(await s.there(path.join(s.out, 'Films', 'Film.mkv'))));
    assert.throws(() => s.queue.get(first));
    assert.throws(() => s.queue.get(second));
    assert.equal(s.queue.get(other).status, 'done');
    assert.ok(await s.there(path.join(s.out, 'Films', 'Other.mkv')));
  } finally {
    await s.done();
  }
});

test('output files: a file being moved cannot be deleted, and the move is checked again first', async () => {
  const s = await setup();
  try {
    const id = await s.job('Film.mkv');
    const dest = path.join(s.out, 'Archive');
    // Its original starts being replaced after the move was added: the move is refused.
    const { items } = await s.outputs.previewMove({ ids: [id], dest });
    s.replacing.add(id);
    s.mover.enqueue({ items, blocked: [] });
    assert.equal((await s.outputs.previewDelete({ ids: [id] })).blocked[0]?.code, 'replacing');
    await s.mover.idle();
    const item = s.mover.state().items[0];
    assert.equal(item.status, 'failed');
    assert.equal(item.code, 'replacing');
    assert.ok(await s.there(path.join(s.out, 'Films', 'Film.mkv')));
    assert.equal(s.queue.get(id).outputPath, path.join(s.out, 'Films', 'Film.mkv'));
  } finally {
    await s.done();
  }
});
