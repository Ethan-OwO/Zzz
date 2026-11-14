// UI language: Traditional Chinese or English.
//
// Choice order: `?lang=zh|en` in the URL, then the browser's language list, then English.
// Nothing is written to localStorage (user decision 2026-11-14). The manual toggle writes
// `?lang=` into the address with history.replaceState instead, so a reload or a bookmark
// keeps the choice while the site itself stores nothing.
//
// Screens read strings through ui() at render time; switching language re-renders the screen.
import { EN_US } from '../export/strings-en.ts';
import { ZH_TW, type ExportStrings } from '../export/strings.ts';
import { EN } from './en.ts';
import { ZH } from './zh.ts';

export type Lang = 'zh' | 'en';
export type UiStrings = typeof ZH;

const TABLES: Record<Lang, UiStrings> = { zh: ZH, en: EN };
const EXPORT_TABLES: Record<Lang, ExportStrings> = { zh: ZH_TW, en: EN_US };

/** Pure, so it can be unit tested: URL parameter first, then the first zh* or en* entry of the browser's list. */
export function detectLang(search: string, languages: readonly string[]): Lang {
  const q = new URLSearchParams(search).get('lang');
  if (q === 'zh' || q === 'en') return q;
  for (const l of languages) {
    const p = l.toLowerCase();
    if (p === 'zh' || p.startsWith('zh-')) return 'zh';
    if (p === 'en' || p.startsWith('en-')) return 'en';
  }
  return 'en';
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

let current: Lang = typeof location === 'undefined' ? 'zh' : detectLang(location.search, browserLanguages());

export function lang(): Lang {
  return current;
}

export function ui(): UiStrings {
  return TABLES[current];
}

/** Strings for report.md / prompt.md in the current language (for the export step). */
export function exportStrings(): ExportStrings {
  return EXPORT_TABLES[current];
}

/** Sets <html lang> (screen readers and hyphenation use it); call once at start and after every switch. */
export function applyDocumentLang(): void {
  document.documentElement.lang = ui().htmlLang;
}

/** Manual switch: remembered only in this page's URL (`?lang=`), not in storage. */
export function setLang(next: Lang): void {
  current = next;
  const url = new URL(location.href);
  url.searchParams.set('lang', next);
  history.replaceState(history.state, '', url);
  applyDocumentLang();
}
