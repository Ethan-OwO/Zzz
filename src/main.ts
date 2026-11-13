import './style.css';
import type { Nav } from './screens/app';
import { live } from './screens/app';
import { renderCalibrate } from './screens/calibrate';
import { renderHome } from './screens/home';
import { renderRecording } from './screens/recording';
import { renderRecovery } from './screens/recovery';
import { renderResult } from './screens/result';

const found = document.querySelector<HTMLElement>('#app');
if (!found) {
  throw new Error('#app not found');
}
const root: HTMLElement = found;

function clear(): void {
  root.replaceChildren();
  live.update = null;
  document.body.classList.remove('recording', 'calibrating');
}

const nav: Nav = {
  home(opts) {
    clear();
    renderHome(root, nav, opts);
  },
  calibrate(session, night) {
    clear();
    renderCalibrate(root, session, night, nav);
  },
  recording(session, night) {
    clear();
    live.update = renderRecording(root, session, night, (nightId) => nav.result(nightId)).update;
  },
  recovery(night) {
    clear();
    void renderRecovery(root, night, nav);
  },
  result(nightId) {
    clear();
    void renderResult(root, nightId, nav);
  },
};

nav.home();
