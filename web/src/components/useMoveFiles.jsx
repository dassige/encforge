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
          <li key={b.path}>
            {fileName(b.path)}: <span className="muted">{moveReason(b)}</span>
          </li>
        ))}
        {list.length > SHOW && <li className="muted">{t('components.delete.more', { count: list.length - SHOW })}</li>}
      </ul>
    </>
  );
}

/**
 * Returns move(paths, dest): shows exactly what would be moved into dest, asks, then moves.
 * Resolves to true when something was moved.
 */
export function useMoveFiles({ onError, onNotice }) {
  const dialogs = useDialogs();

  return useCallback(
    async (paths, dest) => {
      if (!paths.length || !dest) return false;
      let preview;
      try {
        preview = await api.movePreview(paths, dest);
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
            <p className="muted small">{t('components.move.note')}</p>
          </>
        ),
        buttons: [
          { label: t('common.cancel'), value: false },
          { label: items.length === 1 ? t('components.move.move') : t('components.move.moveItems', { count: items.length }), value: true, primary: true, autoFocus: true },
        ],
      });
      if (!ok) return false;
      onNotice?.(t('components.move.moving', { count: items.length }));
      try {
        // Subtitle files are found again by the server, and go with their video.
        const r = await api.moveFiles(items.filter((i) => !i.sidecarOf).map((i) => i.path), preview.dest);
        if (r.moved.length) onNotice?.(t('components.move.moved', { count: r.moved.length }));
        const problems = [...r.blocked.map((b) => `${fileName(b.path)} (${moveReason(b)})`), ...r.errors.map((e) => `${fileName(e.path)} (${e.reason})`)];
        if (problems.length) onError?.(new Error(t('components.move.notMovedList', { list: problems.join('; ') })));
        return r.moved.length > 0;
      } catch (e) {
        onError?.(e);
        return false;
      }
    },
    [dialogs, onError, onNotice],
  );
}
