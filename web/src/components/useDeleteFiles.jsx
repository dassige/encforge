import { useCallback } from 'react';
import { api } from '../api.js';
import { bytes, fileName } from '../format.js';
import { useDialogs } from './Dialogs.jsx';
import { rich, t } from '../i18n/index.js';
import { deleteReason } from '../i18n/serverText.js';

const SHOW = 10;

function Blocked({ list }) {
  if (!list.length) return null;
  return (
    <>
      <p className="small"><strong>{t('components.delete.notDeleted')}</strong></p>
      <ul className="ask-list small">
        {list.slice(0, SHOW).map((b) => (
          <li key={`${b.jobId ?? ''}:${b.path}`}>
            {fileName(b.path)}: <span className="muted">{deleteReason(b)}</span>
          </li>
        ))}
        {list.length > SHOW && <li className="muted">{t('components.delete.more', { count: list.length - SHOW })}</li>}
      </ul>
    </>
  );
}

// What is deleted: files and folders in Sources (by path), or converted files of jobs (by job id),
// whose jobs then leave the queue.
const KINDS = {
  files: { preview: api.deletePreview, remove: (paths) => api.deleteFiles(paths), noteKey: null, warningKey: 'components.delete.warning' },
  outputs: { preview: api.outputDeletePreview, remove: (ids) => api.deleteOutputs(ids), noteKey: 'components.delete.jobsRemoved', warningKey: 'components.delete.warningOutputs' },
};

/**
 * Returns remove(what): shows exactly what would be deleted, asks, then deletes. what: paths, or
 * with kind 'outputs' job ids (their converted files). Resolves to true when something was deleted.
 */
export function useDeleteFiles({ onError, onNotice, kind = 'files' }) {
  const dialogs = useDialogs();
  const how = KINDS[kind];

  return useCallback(
    async (what) => {
      if (!what.length) return false;
      let preview;
      try {
        preview = await how.preview(what);
      } catch (e) {
        onError?.(e);
        return false;
      }
      const { items, blocked } = preview;
      if (!items.length) {
        await dialogs.alert({ title: t('components.delete.nothingTitle'), danger: true, message: <Blocked list={blocked} /> });
        return false;
      }
      const folders = items.filter((i) => i.type === 'dir');
      const ok = await dialogs.choose({
        title: t('components.delete.title'),
        icon: 'warn',
        cancelValue: false,
        message: (
          <>
            <p>
              {rich(
                folders.length === 0 ? 'components.delete.summary'
                  : folders.length === 1 ? 'components.delete.summaryFolder' : 'components.delete.summaryFolders',
                {
                  what: <strong>{items.length === 1 ? fileName(items[0].path) : t('components.delete.items', { count: items.length })}</strong>,
                  files: t('common.files.count', { count: preview.files }),
                  size: bytes(preview.bytes),
                  folders: t('common.folders.count', { count: folders.length }),
                },
              )}
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
            {how.noteKey && <p className="small">{t(how.noteKey, { count: new Set(items.flatMap((i) => i.jobIds ?? [])).size })}</p>}
            <p className="text-bad small">
              {t(how.warningKey)}
            </p>
          </>
        ),
        buttons: [
          { label: t('common.cancel'), value: false, autoFocus: true },
          { label: items.length === 1 ? t('common.delete') : t('components.delete.deleteItems', { count: items.length }), value: true, danger: true },
        ],
      });
      if (!ok) return false;
      try {
        // Converted files: the jobs, checked again by the server (subtitle files go with them).
        const r = await how.remove(kind === 'outputs' ? [...new Set(items.flatMap((i) => i.jobIds ?? []))] : items.map((i) => i.path));
        if (r.deleted.length) onNotice?.(t('components.delete.deleted', { count: r.deleted.length }));
        const problems = [...r.blocked, ...r.errors];
        if (problems.length) onError?.(new Error(t('components.delete.notDeletedList', { list: problems.map((b) => `${fileName(b.path)} (${deleteReason(b)})`).join('; ') })));
        return r.deleted.length > 0;
      } catch (e) {
        onError?.(e);
        return false;
      }
    },
    [dialogs, onError, onNotice, how, kind],
  );
}
