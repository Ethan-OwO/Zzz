import './style.css';

/** 在 root 內建立標題與「開始」按鈕。 */
function renderHome(root: HTMLElement): void {
  const title = document.createElement('h1');
  title.textContent = 'Zzz';

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'start-button';
  startButton.textContent = '開始';

  const results = document.createElement('section');
  results.className = 'results';

  root.append(title, startButton, results);
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) {
  throw new Error('#app not found');
}
renderHome(root);
