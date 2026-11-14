// Home-screen footer: privacy note, link to the source on GitHub and a star request.
// All user-visible text lives in ABOUT_STRINGS so it can move into a translation table.
import { el } from './app';

export const REPO_URL = 'https://github.com/Ethan-OwO/Zzz';

export const ABOUT_STRINGS = {
  privacyTitle: '不會上傳任何東西',
  privacyBody:
    'Zzz 是一個靜態網頁：錄音、偵測和分析全部在這台裝置的瀏覽器裡完成，紀錄只存在本機，網站沒有伺服器端程式、不收集資料，也沒有任何追蹤或分析工具。',
  sourceLead: '原始碼公開在 GitHub，可以自己檢查：',
  sourceLink: 'GitHub · Ethan-OwO/Zzz',
  star: '覺得好用的話，歡迎到 GitHub 給個 ⭐ Star！',
} as const;

export function renderAbout(): HTMLElement {
  const strings = ABOUT_STRINGS;
  const footer = el('footer', 'about');
  footer.append(el('p', 'about-title', strings.privacyTitle), el('p', 'muted', strings.privacyBody));

  const link = el('a', 'about-link', strings.sourceLink);
  link.href = REPO_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const source = el('p', 'muted', strings.sourceLead);
  source.append(document.createElement('br'), link);

  footer.append(source, el('p', 'muted', strings.star));
  return footer;
}
