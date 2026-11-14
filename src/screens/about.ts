// Home-screen footer: privacy note, link to the source on GitHub and a star request.
// Text lives in the i18n tables (ui().about).
import { el } from './app';
import { ui } from '../i18n/index';

export const REPO_URL = 'https://github.com/Ethan-OwO/Zzz';

export function renderAbout(): HTMLElement {
  const strings = ui().about;
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
