import './style.css';
import { renderEnvCheckTable, runEnvChecks } from './env-check';

/** 在 root 內建立標題與「開始」按鈕。按鈕點擊時呼叫 runEnvChecks() 並把結果交給 renderEnvCheckTable()。 */
function renderHome(root: HTMLElement): void {
  const title = document.createElement('h1');
  title.textContent = 'Zzz';

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'start-button';
  startButton.textContent = '開始';

  const results = document.createElement('section');
  results.className = 'results';

  startButton.addEventListener('click', () => {
    renderEnvCheckTable(runEnvChecks(), results);
  });

  root.append(title, startButton, results);
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('#app not found');
}
renderHome(root);
