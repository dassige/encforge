import { useCallback } from 'react';
import { api } from '../api.js';
import { bytes, fileName } from '../format.js';
import { useDialogs } from './Dialogs.jsx';
import { rich, t } from '../i18n/index.js';
import { moveReason } from '../i18n/serverText.js';

const SHOW = 10;

function Blocked({ list }) {
  if (!list.length) return null;
  return (
    <>
      <p className="small"><strong>{t('components.move.notMoved')}</strong></p>
      <ul className="ask-list small">
        {list.slice(0, SHOW).map((b) => (
          <li key={`${b.jobId ?? ''}:${b.path}`}>
            {fileName(b.path)}: <span className="muted">{moveReason(b)}</span>
          </li>
        ))}
        {list.length > SHOW && <li className="muted">{t('components.delete.more', { count: list.length - SHOW })}</li>}
      </ul>
    </>
  );
}

// What is moved: files and folders in Sources (by path), or converted files of jobs (by job id),
// whose jobs then point at the new place.
const KINDS = {
  files: { preview: api.movePreview, start: api.moveFiles, noteKey: 'components.move.note' },
  outputs: { preview: api.outputMovePreview, start: api.moveOutputs, noteKey: 'components.move.noteOutputs' },
};

/**
 * Returns move(what, dest): shows exactly what would be moved into dest, asks, then hands the
 * moves to the server, which does them in the background. what: paths, or with kind 'outputs'
 * job ids (their converted files). Resolves to true when some were started.
 */
export function useMoveFiles({ onError, onNotice, kind = 'files' }) {
  const dialogs = useDialogs();
  const how = KINDS[kind];

  return useCallback(
    async (what, dest) => {
      if (!what.length || !dest) return false;
      let preview;
      try {
        preview = await how.preview(what, dest);
      } catch (e) {
        onError?.(e);
        return false;
      }
      const { items, blocked } = preview;
      if (!items.length) {
        await dialogs.alert({ title: t('components.move.nothingTitle'), message: <Blocked list={blocked} /> });
        return false;
      }
      const ok = await dialogs.choose({
        title: t('components.move.title'),
        icon: 'question',
        cancelValue: false,
        message: (
          <>
            <p>
              {rich('components.move.summary', {
                what: <strong>{items.length === 1 ? fileName(items[0].path) : t('components.delete.items', { count: items.length })}</strong>,
                dest: <strong className="mono">{preview.dest}</strong>,
                files: t('common.files.count', { count: preview.files }),
                size: bytes(preview.bytes),
              })}
            </p>
            {items.length > 1 && (
              <ul className="ask-list small">
                {items.slice(0, SHOW).map((i) => (
                  <li key={i.path}>
                    {fileName(i.path)}{i.type === 'dir' ? '/' : ''}{' '}
                    <span className="muted">
                      {i.type === 'dir' ? `${t('common.files.count', { count: i.files })}, ` : ''}{bytes(i.bytes)}
                      {i.sidecarOf ? ` · ${t('subtitles.delete.of', { name: fileName(i.sidecarOf) })}` : ''}
                    </span>
                  </li>
                ))}
                {items.length > SHOW && <li className="muted">{t('components.delete.more', { count: items.length - SHOW })}</li>}
              </ul>
            )}
            <Blocked list={blocked} />
            <p className="muted small">{t(how.noteKey)}</p>
          </>
        ),
        buttons: [
          { label: t('common.cancel'), value: false },
          { label: items.length === 1 ? t('components.move.move') : t('components.move.moveItems', { count: items.length }), value: true, primary: true, autoFocus: true },
        ],
      });
      if (!ok) return false;
      try {
        // Subtitle files are found again by the server, and go with their video. The moves run
        // in the background: the bar at the top of Sources (MoveProgress) shows how far they are.
        const chosen = items.filter((i) => !i.sidecarOf).map((i) => i.path);
        const r = await how.start(kind === 'outputs' ? [...new Set(items.flatMap((i) => i.jobIds ?? []))] : chosen, preview.dest);
        // What was refused now (e.g. the name got taken meanwhile) is in blocked.
        const added = r.move ? Math.max(0, chosen.length - r.blocked.length) : 0;
        if (added) onNotice?.(t('components.move.started', { count: added }));
        if (r.blocked.length) {
          onError?.(new Error(t('components.move.notMovedList', { list: r.blocked.map((b) => `${fileName(b.path)} (${moveReason(b)})`).join('; ') })));
        }
        return added > 0;
      } catch (e) {
        onError?.(e);
        return false;
      }
    },
    [dialogs, onError, onNotice, how, kind],
  );
}
