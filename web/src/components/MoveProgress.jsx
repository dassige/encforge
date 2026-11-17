import { CircleStop, FolderInput, X } from 'lucide-react';
import { api } from '../api.js';
import { bytes, fileName } from '../format.js';
import { useDialogs } from './Dialogs.jsx';
import { t } from '../i18n/index.js';
import { moveReason } from '../i18n/serverText.js';

const SHOW = 10;

/**
 * At the top of Sources: the files and folders being moved in the background ("Moving 2 of 5",
 * the item, the bytes copied, Cancel), then the summary with the failures until dismissed.
 * move: the list from GET /api/files/move and the `move` events (server/src/moveFiles.js).
 */
export function MoveProgress({ move, onError }) {
  const dialogs = useDialogs();
  if (!move?.items.length) return null;
  const count = (s) => move.items.filter((i) => i.status === s).length;
  const total = move.items.length;
  const failed = move.items.filter((i) => i.status === 'failed');
  const call = (fn) => fn().catch((e) => onError?.(e));

  if (move.running) {
    const finished = total - count('waiting') - count('moving');
    const item = move.current && move.items.find((i) => i.path === move.current.path);
    const fraction = move.bytes ? move.doneBytes / move.bytes : finished / total;
    async function cancel() {
      const ok = await dialogs.confirm({
        title: t('components.move.progress.cancelTitle'),
        message: t('components.move.progress.cancelMessage'),
        confirmLabel: t('components.move.progress.cancel'),
        cancelLabel: t('components.move.progress.keepMoving'),
        danger: true,
      });
      if (ok) call(() => api.cancelMove());
    }
    return (
      <div className="replace-progress move-progress" role="status">
        <div className="replace-progress-head">
          <FolderInput size={14} />
          <strong>{t('components.move.progress.title', { done: Math.min(finished + 1, total), total })}</strong>
          <span className="muted small replace-progress-file" title={item ? `${item.path} → ${item.to}` : undefined}>
            {item ? item.name : ''}
          </span>
          <span className="spacer" />
          <button
            className="btn ghost small"
            disabled={move.cancelling}
            onClick={cancel}
            title={t('components.move.progress.cancelHint')}
          >
            <CircleStop size={14} /> {move.cancelling ? t('components.move.progress.cancelling') : t('common.cancel')}
          </button>
        </div>
        <div className="progress"><div className="bar" style={{ width: `${Math.min(1, fraction) * 100}%` }} /></div>
        <p className="muted small">
          {t('components.move.progress.bytes', { done: bytes(move.doneBytes), total: bytes(move.bytes) })}
          {failed.length > 0 && <span className="text-bad"> · {t('components.move.progress.failedSoFar', { count: failed.length })}</span>}
        </p>
      </div>
    );
  }

  return (
    <div className={`replace-progress move-progress ${failed.length ? 'bad' : 'ok'}`} role="status">
      <div className="replace-progress-head">
        <FolderInput size={14} />
        <strong>
          {[
            t('components.move.progress.doneCount', { count: count('done') }),
            failed.length ? t('components.move.progress.failedCount', { count: failed.length }) : null,
            count('cancelled') ? t('components.move.progress.cancelledCount', { count: count('cancelled') }) : null,
          ].filter(Boolean).join(' · ')}
        </strong>
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={() => call(() => api.clearMove())}
          title={t('components.move.progress.dismiss')}
          aria-label={t('components.move.progress.dismiss')}
        >
          <X size={15} />
        </button>
      </div>
      {failed.length > 0 && (
        <ul className="replace-failures small">
          {failed.slice(0, SHOW).map((i) => (
            <li key={i.path}>
              <strong>{fileName(i.path)}</strong>: {moveReason({ code: i.code, params: i.params, reason: i.error })}
            </li>
          ))}
          {failed.length > SHOW && <li className="muted">{t('components.delete.more', { count: failed.length - SHOW })}</li>}
        </ul>
      )}
    </div>
  );
}
