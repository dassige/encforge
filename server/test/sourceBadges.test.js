// Job badges of the Sources panel (Queue.latestJobForPaths / statusForDirs), including "check failed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { Settings } from '../src/settings.js';
import { Queue } from '../src/queue.js';

const quiet = { info() {}, warn() {}, error() {} };

function setup() {
  const db = openDb(':memory:');
  const root = path.resolve('/src');
  const settings = new Settings(db, { initialSourceRoot: root, initialTargetRoot: path.resolve('/out') });
  const queue = new Queue({ db, settings, presets: {}, handbrake: {}, verifier: null, events: { emit() {} }, dataDir: path.resolve('/data'), log: quiet });
  const ins = db.prepare(`INSERT INTO jobs (status, position, source_path, output_path, preset_name, preset_json, format, created_at, verify_status)
    VALUES (?, 1, ?, '/out/x.mkv', 'P', '{}', 'av_mkv', ?, ?)`);
  const job = (status, file, verify = null) => ins.run(status, path.join(root, file), Date.now(), verify);
  return { queue, root, job, at: (...p) => path.join(root, ...p) };
}

test('sources: a converted file whose check failed is flagged', () => {
  const { queue, job, at } = setup();
  job('done', 'a.mkv', 'error');
  job('done', 'b.mkv', 'ok');
  job('done', 'c.mkv', 'error');
  job('queued', 'c.mkv'); // converting again: the queued job stands for it
  const r = queue.latestJobForPaths([at('a.mkv'), at('b.mkv'), at('c.mkv'), at('none.mkv')]);
  assert.deepEqual(r[at('a.mkv')], { status: 'done', verifyStatus: 'error' });
  assert.deepEqual(r[at('b.mkv')], { status: 'done', verifyStatus: 'ok' });
  assert.equal(r[at('c.mkv')].status, 'queued');
  assert.equal(r[at('none.mkv')], undefined);
  // The plain status map is unchanged (used when adding files and by the quality check).
  assert.deepEqual(queue.statusForPaths([at('a.mkv'), at('c.mkv')]), { [at('a.mkv')]: 'done', [at('c.mkv')]: 'queued' });
});

test('sources: folders count files whose newest conversion failed its check', () => {
  const { queue, job, at } = setup();
  job('done', 'Show/e1.mkv', 'error');
  job('done', 'Show/e2.mkv', 'error');
  job('done', 'Show/e2.mkv', 'ok'); // converted again and passed: no longer counted
  job('done', 'Show/S1/e3.mkv', 'error'); // in a subfolder: counted
  job('done', 'Show/e4.mkv', 'warning');
  job('failed', 'Show/e5.mkv');
  job('done', 'Other/x.mkv', 'ok');
  const r = queue.statusForDirs([at('Show'), at('Other'), at('Empty')]);
  assert.deepEqual(r[at('Show')], { done: 4, failed: 1, checkFailed: 2 });
  assert.deepEqual(r[at('Other')], { done: 1 });
  assert.equal(r[at('Empty')], undefined);
});
