import './style.css';
import type { RunningSession } from './monitor/session';
import type { SessionRecord } from './monitor/types';
import { renderHome } from './screens/home';
import { renderRecording } from './screens/recording';
import { renderResult } from './screens/result';

const found = document.querySelector<HTMLElement>('#app');
if (!found) {
  throw new Error('#app not found');
}
const root: HTMLElement = found;

function clear(): void {
  root.replaceChildren();
  document.body.classList.remove('recording');
}

function showHome(): void {
  clear();
  renderHome(root, { onStarted: showRecording });
}

function showRecording(session: RunningSession) {
  clear();
  return renderRecording(root, session, showResult).update;
}

function showResult(session: SessionRecord): void {
  clear();
  void renderResult(root, session, showHome);
}

showHome();
