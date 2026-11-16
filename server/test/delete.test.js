import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SourceFiles } from '../src/deleteFiles.js';

async function setup({ rename, subtitles } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hbui-del-')));
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
  const files = new SourceFiles({
    settings: { get: (k) => values[k] },
    queue,
    events: { emit: (t) => emitted.push(t) },
    log: { info() {} },
    rename,
    subtitles,
  });
  return { dir, src, out, files, pending, emitted, values, done: () => fs.rm(dir, { recursive: true }) };
}

const exists = (p) => fs.access(p).then(() => true, () => false);

test('delete: preview counts folders recursively and folds files inside chosen folders', async () => {
  const t = await setup();
  const r = await t.files.preview({ paths: [path.join(t.src, 'Show'), path.join(t.src, 'Show', 'e2.mkv'), path.join(t.src, 'film.mp4')] });
  assert.deepEqual(r.items.map((i) => [path.basename(i.path), i.type, i.files, i.bytes]), [['Show', 'dir', 2, 8], ['film.mp4', 'file', 1, 1]]);
  assert.equal(r.files, 3);
  assert.equal(r.bytes, 9);
  assert.deepEqual(r.blocked, []);
  // Nothing was deleted by the preview.
  assert.ok(await exists(path.join(t.src, 'Show', 'S01', 'e1.mkv')));
  await t.done();
});

test('delete: removes files and folders, and refuses roots, the target and queued files', async () => {
  const t = await setup();
  const r = await t.files.remove({
    paths: [path.join(t.src, 'Show'), path.join(t.src, 'film.mp4'), path.join(t.src, 'queued.mkv'), t.src, path.join(t.out, 'converted.mkv')],
  });
  assert.deepEqual(r.deleted.map((p) => path.basename(p)), ['Show', 'film.mp4']);
  assert.equal(r.blocked.length, 3);
  assert.match(r.blocked.find((b) => b.path.endsWith('queued.mkv')).reason, /queued or converting/);
  assert.match(r.blocked.find((b) => b.path === t.src).reason, /sources folder itself/);
  assert.match(r.blocked.find((b) => b.path.endsWith('converted.mkv')).reason, /outside/);
  assert.equal(await exists(path.join(t.src, 'Show')), false);
  assert.equal(await exists(path.join(t.src, 'film.mp4')), false);
  assert.ok(await exists(path.join(t.src, 'queued.mkv')));
  assert.ok(await exists(path.join(t.out, 'converted.mkv')));
  assert.ok(t.emitted.includes('files'));
  await t.done();
});

test('delete: a folder with a queued file inside is refused as a whole', async () => {
  const t = await setup();
  t.pending.push(path.join(t.src, 'Show', 'S01', 'e1.mkv'));
  const r = await t.files.remove({ paths: [path.join(t.src, 'Show')] });
  assert.deepEqual(r.deleted, []);
  assert.match(r.blocked[0].reason, /e1\.mkv is queued/);
  assert.ok(await exists(path.join(t.src, 'Show', 'e2.mkv')));
  await t.done();
});

test('delete: nothing in a protected sources folder can be deleted', async () => {
  const t = await setup();
  t.values.protectedRoots = [t.src];
  const r = await t.files.remove({ paths: [path.join(t.src, 'film.mp4'), path.join(t.src, 'Show')] });
  assert.deepEqual(r.deleted, []);
  assert.equal(r.blocked.length, 2);
  assert.match(r.blocked[0].reason, /protected/);
  assert.ok(await exists(path.join(t.src, 'film.mp4')));
  await t.done();
});

// ---------------------------------------------------------------- moving

const read = (p) => fs.readFile(p, 'utf8');
// As if every folder were its own disk: renames only within a folder.
const crossDevice = async (from, to) => {
  if (path.dirname(from) !== path.dirname(to)) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  return fs.rename(from, to);
};

test('move: preview says where each item goes and changes nothing', async () => {
  const t = await setup();
  const r = await t.files.previewMove({ paths: [path.join(t.src, 'Show'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.equal(r.dest, t.out);
  assert.deepEqual(r.items.map((i) => [path.basename(i.path), i.to]), [['Show', path.join(t.out, 'Show')], ['film.mp4', path.join(t.out, 'film.mp4')]]);
  assert.equal(r.files, 3);
  assert.deepEqual(r.blocked, []);
  assert.ok(await exists(path.join(t.src, 'film.mp4')));
  await t.done();
});

test('move: moves files and folders into the target folder or a sources sub-folder', async () => {
  const t = await setup();
  const r = await t.files.move({ paths: [path.join(t.src, 'Show'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.deepEqual(r.moved.map((m) => path.basename(m.to)), ['Show', 'film.mp4']);
  assert.equal(await read(path.join(t.out, 'Show', 'S01', 'e1.mkv')), '12345');
  assert.equal(await exists(path.join(t.src, 'Show')), false);
  assert.ok(t.emitted.includes('files'));
  await fs.mkdir(path.join(t.src, 'Films'));
  const sub = await t.files.move({ paths: [path.join(t.src, 'queued.mkv')], dest: path.join(t.src, 'Films') });
  assert.equal(sub.blocked[0].code, 'pendingFile', 'a queued file stays');
  await fs.writeFile(path.join(t.src, 'other.mkv'), 'o');
  const ok = await t.files.move({ paths: [path.join(t.src, 'other.mkv')], dest: path.join(t.src, 'Films') });
  assert.equal(ok.moved[0].to, path.join(t.src, 'Films', 'other.mkv'));
  // Only files in the sources folders can be moved, not converted files.
  const back = await t.files.move({ paths: [path.join(t.out, 'film.mp4')], dest: path.join(t.src, 'Films') });
  assert.equal(back.moved.length, 0);
  assert.match(back.blocked[0].reason, /outside/);
  await t.done();
});

test('move: refuses the same folder, a folder into itself, a taken name and protected folders', async () => {
  const t = await setup();
  const into = await t.files.move({ paths: [path.join(t.src, 'Show')], dest: path.join(t.src, 'Show', 'S01') });
  assert.equal(into.blocked[0].code, 'intoItself');
  const same = await t.files.previewMove({ paths: [path.join(t.src, 'film.mp4')], dest: t.src });
  assert.equal(same.blocked[0].code, 'sameFolder');

  await fs.writeFile(path.join(t.out, 'film.mp4'), 'other');
  const taken = await t.files.move({ paths: [path.join(t.src, 'film.mp4')], dest: t.out });
  assert.equal(taken.blocked[0].code, 'exists');
  assert.equal(await read(path.join(t.out, 'film.mp4')), 'other', 'nothing is overwritten');
  assert.ok(await exists(path.join(t.src, 'film.mp4')));

  t.values.protectedRoots = [t.src];
  const prot = await t.files.move({ paths: [path.join(t.src, 'film.mp4')], dest: path.join(t.src, 'Show') });
  assert.equal(prot.blocked[0].code, 'protected');
  assert.match(prot.blocked[0].reason, /cannot be moved/);
  await assert.rejects(t.files.move({ paths: [path.join(t.src, 'film.mp4')], dest: path.join(t.dir, 'elsewhere') }), /outside/);
  await assert.rejects(t.files.move({ paths: [path.join(t.src, 'film.mp4')] }), /Choose the folder/);
  await t.done();
});

test('move: a video takes its subtitle files along, keeping the Subs folder', async () => {
  const sidecarPaths = async (video) => [path.join(path.dirname(video), 'film.en.srt'), path.join(path.dirname(video), 'Subs', 'film', '2_English.srt')];
  const t = await setup({ subtitles: { sidecarPaths } });
  await fs.writeFile(path.join(t.src, 'film.en.srt'), 'en');
  await fs.mkdir(path.join(t.src, 'Subs', 'film'), { recursive: true });
  await fs.writeFile(path.join(t.src, 'Subs', 'film', '2_English.srt'), 'en 2');
  const preview = await t.files.previewMove({ paths: [path.join(t.src, 'film.mp4')], dest: t.out });
  assert.deepEqual(preview.items.map((i) => i.sidecarOf ?? null), [null, path.join(t.src, 'film.mp4'), path.join(t.src, 'film.mp4')]);
  // Choosing a subtitle file as well (before its video) still keeps it next to the video.
  const r = await t.files.move({ paths: [path.join(t.src, 'Subs', 'film', '2_English.srt'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.equal(r.moved.length, 3);
  assert.equal(await read(path.join(t.out, 'film.en.srt')), 'en');
  assert.equal(await read(path.join(t.out, 'Subs', 'film', '2_English.srt')), 'en 2');
  assert.equal(await exists(path.join(t.src, 'film.en.srt')), false);
  await t.done();
});

test('move: a refused video keeps its subtitle files', async () => {
  const sidecarPaths = async (video) => [path.join(path.dirname(video), 'film.en.srt')];
  const t = await setup({ subtitles: { sidecarPaths } });
  await fs.writeFile(path.join(t.src, 'film.en.srt'), 'en');
  await fs.writeFile(path.join(t.out, 'film.mp4'), 'other');
  const r = await t.files.move({ paths: [path.join(t.src, 'film.mp4')], dest: t.out });
  assert.deepEqual(r.moved, []);
  assert.ok(await exists(path.join(t.src, 'film.en.srt')));
  await t.done();
});

test('move: works between disks (copies, then removes the original)', async () => {
  const t = await setup({ rename: crossDevice });
  const r = await t.files.move({ paths: [path.join(t.src, 'Show'), path.join(t.src, 'film.mp4')], dest: t.out });
  assert.deepEqual(r.errors, []);
  assert.equal(r.moved.length, 2);
  assert.equal(await read(path.join(t.out, 'Show', 'S01', 'e1.mkv')), '12345');
  assert.equal(await read(path.join(t.out, 'Show', 'e2.mkv')), '123');
  assert.equal(await read(path.join(t.out, 'film.mp4')), '1');
  assert.equal(await exists(path.join(t.src, 'Show')), false);
  assert.equal(await exists(path.join(t.src, 'film.mp4')), false);
  assert.deepEqual((await fs.readdir(t.out)).sort(), ['Show', 'converted.mkv', 'film.mp4'], 'no hidden copy left behind');
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
    const r = await t.files.move({ paths: [path.join(t.src, 'Show')], dest: t.out });
    assert.equal(r.moved.length, 0);
    assert.equal(r.errors.length, 1);
    assert.deepEqual((await fs.readdir(t.out)).sort(), ['converted.mkv']);
    assert.ok(await exists(path.join(t.src, 'Show', 'e2.mkv')));
  } finally {
    await fs.chmod(unreadable, 0o644);
    await t.done();
  }
});
