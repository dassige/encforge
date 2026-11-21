import { csvDateTime, csvText } from '../csv.js';
import { duration, elapsed, ratio } from '../format.js';
import { has, t } from '../i18n/index.js';

/** A translated label (components.status.done → "Converted"), or the raw value when there is none. */
const label = (prefix, value) => (value && has(`${prefix}.${value}`) ? t(`${prefix}.${value}`) : value ?? '');

// One column per entry: its heading and its value for a job.
const COLUMNS = [
  { headKey: 'queue.csv.status', value: (j) => label('components.status', j.status) },
  { headKey: 'queue.csv.check', value: (j) => label('components.verify', j.verifyStatus) },
  { headKey: 'queue.csv.source', value: (j) => j.sourcePath },
  { headKey: 'queue.csv.output', value: (j) => j.outputPath },
  { headKey: 'queue.csv.preset', value: (j) => j.presetName },
  { headKey: 'queue.csv.length', value: (j) => (j.sourceInfo?.duration ? duration(j.sourceInfo.duration) : '') },
  { headKey: 'queue.csv.resolution', value: (j) => (j.sourceInfo?.width ? `${j.sourceInfo.width}×${j.sourceInfo.height}` : '') },
  { headKey: 'queue.csv.videoCodec', value: (j) => j.sourceInfo?.videoCodec },
  { headKey: 'queue.csv.sourceBytes', value: (j) => j.sourceSize },
  { headKey: 'queue.csv.outputBytes', value: (j) => (j.status === 'done' ? j.outputSize : '') },
  { headKey: 'queue.csv.savedPercent', value: (j) => (j.status === 'done' ? ratio(j) : '') },
  { headKey: 'queue.csv.added', value: (j) => csvDateTime(j.createdAt) },
  { headKey: 'queue.csv.started', value: (j) => csvDateTime(j.startedAt) },
  { headKey: 'queue.csv.finished', value: (j) => csvDateTime(j.finishedAt) },
  { headKey: 'queue.csv.took', value: (j) => (j.finishedAt && j.startedAt ? duration(elapsed(j)) : '') },
  { headKey: 'queue.csv.avgFps', value: (j) => (j.avgFps ? j.avgFps.toFixed(1) : '') },
  { headKey: 'queue.csv.replaced', value: (j) => (j.replaced ? csvDateTime(j.replaced.at) : '') },
  { headKey: 'queue.csv.error', value: (j) => j.error },
  { headKey: 'queue.csv.tag', value: (j) => j.tag },
];

/** The jobs as CSV text, one row per job, in the order given. */
export function queueCsv(jobs) {
  return csvText(COLUMNS.map((c) => t(c.headKey)), jobs.map((j) => COLUMNS.map((c) => c.value(j))));
}
