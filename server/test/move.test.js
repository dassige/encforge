import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceFiles } from '../src/deleteFiles.js';
import { Mover } from '../src/moveFiles.js';

const BIG = 6 << 20; // several 1 MB chunks: a copy that takes a few steps

async function setup({ rename, subtitles, onEvent } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hbui-move-')));
  const src = path.join(dir, 'src');
  const out = path.join(dir, 'out');
  await fs.mkdir(path.join(src, 'Show', 'S01'), { recursive: true });
  await fs.mkdir(out);
  await fs.writeFile(path.join(src, 'Show', 'S01', 'e1.mkv'), '12345');
  await fs.writeFile(path.join(src, 'Show', 'e2.mkv'), '123');
  await fs.writeFile(path.join(src, 'film.mp4'), '1');
  await fs.writeFile(path.join(src, 'queued.mkv'), '1');
  await fs.writeFile(path.join(out, 'converted.mkv'), '1');
  const pending = [path.join(src, 'queued.mkv')];
  const queue = {
    pendingSourcesUnder: (p) => pending.filter((f) => f === p || f.startsWith(p + path.sep)).map((f) => ({ path: f, status: 'queued' })),
  };
  const emitted = [];
  const values = { sourceRoots: [src], targetRoot: out, protectedRoots: [], videoExtensions: ['mkv', 'mp4'], excludePatterns: [] };
  const settings = { get: (k) => values[k] };
  const log = { info() {}, warn() {} };
  const events = {
    emit: (name, data) => {
      emitted.push(name);
      onEvent?.(name, data);
    },
  };
  const files = new SourceFiles({ settings, queue, events, log, subtitles });
  const mover = new Mover({ sourceFiles: files, settings, queue, events, log, rename, progressEvery: 0 });
  /** Starts the moves and waits for them: { moved: [{ from, to }], blocked, errors, state }. */
  const move = async (args) => {
    const { blocked } = await mover.start(args);
    await mover.idle();
    const state = mover.state();
    const items = state?.items ?? [];
    return {
      blocked,
      state,
      moved: items.filter((i) => i.status === 'done').map((i) => ({ from: i.path, to: i.to })),
      errors: items.filter((i) => i.status === 'failed'),
    };
  };
  return { dir, src, out, files, mover, move, pending, emitted, values, done: () => fs.rm(dir, { recursive: true }) };
}

const exists = (p) => fs.access(p).then(() => true, () => false);
const read = (p) => fs.readFile(p, 'utf8');
// As if every folder were its own disk: renames only within a folder.
const crossDevice = async (from, to) => {
  if (path.dirname(from) !== path.dirname(to)) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  return fs.rename(from, to);
};

test('move: preview says where each item goes and changes nothing', async () => {
  const t = await setup();
  const r = await t.mover.previewMove({ paths: [path.join(t.src, 'Show'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.equal(r.dest, t.out);
  assert.deepEqual(r.items.map((i) => [path.basename(i.path), i.to]), [['Show', path.join(t.out, 'Show')], ['film.mp4', path.join(t.out, 'film.mp4')]]);
  assert.equal(r.files, 3);
  assert.deepEqual(r.blocked, []);
  assert.ok(await exists(path.join(t.src, 'film.mp4')));
  assert.equal(t.mover.state(), null);
  await t.done();
});

test('move: moves files and folders in the background into the target folder or a sources sub-folder', async () => {
  const t = await setup();
  const r = await t.move({ paths: [path.join(t.src, 'Show'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.deepEqual(r.moved.map((m) => path.basename(m.to)), ['Show', 'film.mp4']);
  assert.equal(r.state.running, false);
  assert.equal(r.state.doneBytes, r.state.bytes);
  assert.equal(await read(path.join(t.out, 'Show', 'S01', 'e1.mkv')), '12345');
  assert.equal(await exists(path.join(t.src, 'Show')), false);
  assert.ok(t.emitted.includes('files'));
  assert.ok(t.emitted.includes('move'));

  await fs.mkdir(path.join(t.src, 'Films'));
  await fs.writeFile(path.join(t.src, 'other.mkv'), 'o');
  const ok = await t.move({ paths: [path.join(t.src, 'other.mkv'), path.join(t.src, 'queued.mkv')], dest: path.join(t.src, 'Films') });
  assert.equal(ok.moved[0].to, path.join(t.src, 'Films', 'other.mkv'));
  assert.equal(ok.blocked[0].code, 'pendingFile', 'a queued file stays');
  // Only files in the sources folders can be moved, not converted files.
  const back = await t.move({ paths: [path.join(t.out, 'film.mp4')], dest: path.join(t.src, 'Films') });
  assert.match(back.blocked[0].reason, /outside/);
  t.mover.clear();
  assert.equal(t.mover.state(), null);
  await t.done();
});

test('move: refuses the same folder, a folder into itself, a taken name and protected folders', async () => {
  const t = await setup();
  const into = await t.mover.previewMove({ paths: [path.join(t.src, 'Show')], dest: path.join(t.src, 'Show', 'S01') });
  assert.equal(into.blocked[0].code, 'intoItself');
  const same = await t.mover.previewMove({ paths: [path.join(t.src, 'film.mp4')], dest: t.src });
  assert.equal(same.blocked[0].code, 'sameFolder');

  await fs.writeFile(path.join(t.out, 'film.mp4'), 'other');
  const taken = await t.move({ paths: [path.join(t.src, 'film.mp4')], dest: t.out });
  assert.equal(taken.blocked[0].code, 'exists');
  assert.equal(taken.state, null, 'nothing to move: no list');
  assert.equal(await read(path.join(t.out, 'film.mp4')), 'other', 'nothing is overwritten');

  t.values.protectedRoots = [t.src];
  const prot = await t.mover.previewMove({ paths: [path.join(t.src, 'film.mp4')], dest: path.join(t.src, 'Show') });
  assert.equal(prot.blocked[0].code, 'protected');
  assert.match(prot.blocked[0].reason, /cannot be moved/);
  await assert.rejects(t.mover.start({ paths: [path.join(t.src, 'film.mp4')], dest: path.join(t.dir, 'elsewhere') }), /outside/);
  await assert.rejects(t.mover.start({ paths: [path.join(t.src, 'film.mp4')] }), /Choose the folder/);
  await t.done();
});

test('move: a video takes its subtitle files along, keeping the Subs folder', async () => {
  const sidecarPaths = async (video) => [path.join(path.dirname(video), 'film.en.srt'), path.join(path.dirname(video), 'Subs', 'film', '2_English.srt')];
  const t = await setup({ subtitles: { sidecarPaths } });
  await fs.writeFile(path.join(t.src, 'film.en.srt'), 'en');
  await fs.mkdir(path.join(t.src, 'Subs', 'film'), { recursive: true });
  await fs.writeFile(path.join(t.src, 'Subs', 'film', '2_English.srt'), 'en 2');
  const preview = await t.mover.previewMove({ paths: [path.join(t.src, 'film.mp4')], dest: t.out });
  assert.deepEqual(preview.items.map((i) => i.sidecarOf ?? null), [null, path.join(t.src, 'film.mp4'), path.join(t.src, 'film.mp4')]);
  // Choosing a subtitle file as well (before its video) still keeps it next to the video.
  const r = await t.move({ paths: [path.join(t.src, 'Subs', 'film', '2_English.srt'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.equal(r.moved.length, 3);
  assert.equal(await read(path.join(t.out, 'film.en.srt')), 'en');
  assert.equal(await read(path.join(t.out, 'Subs', 'film', '2_English.srt')), 'en 2');
  assert.equal(await exists(path.join(t.src, 'film.en.srt')), false);
  await t.done();
});

test('move: a subtitle file stays when its video could not be moved', async () => {
  const sidecarPaths = async (video) => (video.endsWith('film.mp4') ? [path.join(path.dirname(video), 'film.en.srt')] : []);
  const t = await setup({ subtitles: { sidecarPaths } });
  await fs.writeFile(path.join(t.src, 'film.en.srt'), 'en');
  const { move } = await t.mover.start({ paths: [path.join(t.src, 'Show'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.equal(move.items.length, 3);
  // Queued after it was added: checked again just before it is moved.
  t.pending.push(path.join(t.src, 'film.mp4'));
  await t.mover.idle();
  const items = Object.fromEntries(t.mover.state().items.map((i) => [i.name, i]));
  assert.equal(items.Show.status, 'done');
  assert.equal(items['film.mp4'].code, 'pendingFile');
  assert.equal(items['film.en.srt'].code, 'videoNotMoved');
  assert.ok(await exists(path.join(t.src, 'film.en.srt')));
  await t.done();
});

test('move: what is waiting to be moved cannot be deleted or moved again; more moves join the list', async () => {
  const t = await setup({ rename: crossDevice });
  await fs.writeFile(path.join(t.src, 'big.mkv'), Buffer.alloc(BIG));
  await t.mover.start({ paths: [path.join(t.src, 'big.mkv'), path.join(t.src, 'film.mp4')], dest: t.out });
  const del = await t.files.preview({ paths: [path.join(t.src, 'film.mp4')] });
  assert.equal(del.blocked[0].code, 'moving');
  const again = await t.mover.start({ paths: [path.join(t.src, 'film.mp4')], dest: path.join(t.src, 'Show') });
  assert.equal(again.blocked[0].code, 'moving');
  const more = await t.mover.start({ paths: [path.join(t.src, 'Show')], dest: t.out });
  assert.equal(more.move.items.length, 3);
  await t.mover.idle();
  assert.deepEqual(t.mover.state().items.map((i) => i.status), ['done', 'done', 'done']);
  assert.deepEqual((await fs.readdir(t.out)).sort(), ['Show', 'big.mkv', 'converted.mkv', 'film.mp4']);
  await t.done();
});

test('move: works between disks (copies with progress, then removes the original)', async () => {
  const progress = [];
  const t = await setup({ rename: crossDevice, onEvent: (name, s) => name === 'move' && s?.current && progress.push(s.current.done) });
  await fs.writeFile(path.join(t.src, 'Show', 'big.mkv'), Buffer.alloc(BIG));
  const r = await t.move({ paths: [path.join(t.src, 'Show'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.deepEqual(r.errors, []);
  assert.equal(r.moved.length, 2);
  assert.ok(progress.some((d) => d > 0 && d < BIG), 'progress during the copy');
  assert.equal(await read(path.join(t.out, 'Show', 'S01', 'e1.mkv')), '12345');
  assert.equal((await fs.stat(path.join(t.out, 'Show', 'big.mkv'))).size, BIG);
  assert.equal(await read(path.join(t.out, 'film.mp4')), '1');
  assert.equal(await exists(path.join(t.src, 'Show')), false);
  assert.equal(await exists(path.join(t.src, 'film.mp4')), false);
  assert.deepEqual((await fs.readdir(t.out)).sort(), ['Show', 'converted.mkv', 'film.mp4'], 'no hidden copy left behind');
  await t.done();
});

test('move: cancel stops the copy in progress, keeps the original, and skips the rest', async () => {
  let t;
  let cancelled = false;
  t = await setup({
    rename: crossDevice,
    onEvent: (name, s) => {
      if (name === 'move' && !cancelled && s?.current?.path.endsWith('big.mkv') && s.current.done > 0) {
        cancelled = true;
        t.mover.cancel();
      }
    },
  });
  await fs.writeFile(path.join(t.src, 'film.mp4'), 'f');
  await fs.writeFile(path.join(t.src, 'big.mkv'), Buffer.alloc(BIG));
  await t.mover.start({ paths: [path.join(t.src, 'film.mp4'), path.join(t.src, 'big.mkv'), path.join(t.src, 'Show')], dest: t.out });
  await t.mover.idle();
  const s = t.mover.state();
  assert.ok(cancelled);
  assert.equal(s.running, false);
  assert.deepEqual(s.items.map((i) => [i.name, i.status]), [['film.mp4', 'done'], ['big.mkv', 'cancelled'], ['Show', 'cancelled']]);
  assert.equal((await fs.stat(path.join(t.src, 'big.mkv'))).size, BIG, 'the original stays');
  assert.ok(await exists(path.join(t.src, 'Show')));
  assert.deepEqual((await fs.readdir(t.out)).sort(), ['converted.mkv', 'film.mp4'], 'no partial copy left behind');
  assert.throws(() => t.mover.cancel(), /Nothing is being moved/);
  await t.done();
});

test('move: a folder copy that fails between disks leaves the original and no partial copy', async () => {
  const t = await setup({ rename: crossDevice });
  // A file the copy cannot read makes it fail half-way.
  const unreadable = path.join(t.src, 'Show', 'S01', 'e1.mkv');
  await fs.chmod(unreadable, 0o000);
  const readable = await fs.open(unreadable).then((f) => f.close().then(() => true), () => false);
  try {
    if (readable) return; // Windows, or root: permissions don't stop reading
    const r = await t.move({ paths: [path.join(t.src, 'Show')], dest: t.out });
    assert.equal(r.moved.length, 0);
    assert.equal(r.errors.length, 1);
    assert.deepEqual((await fs.readdir(t.out)).sort(), ['converted.mkv']);
    assert.ok(await exists(path.join(t.src, 'Show', 'e2.mkv')));
  } finally {
    await fs.chmod(unreadable, 0o644);
    await t.done();
  }
});
