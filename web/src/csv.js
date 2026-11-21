/** CSV text: every value quoted, lines ending in CRLF (as spreadsheets expect). */
export function csvText(head, rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
}

/** Downloads CSV text as a file; the BOM makes Excel read it as UTF-8. */
export function downloadCsv(fileName, text) {
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** "2026-11-21 14:05:09" in local time, which spreadsheets read as a date; '' when not set. */
export function csvDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
