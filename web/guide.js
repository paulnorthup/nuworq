// The getting-started guide's page (/guide, src/userguide.js): a link to a step (/guide#machine, from Get
// started) opens that step, and each command's Copy copies exactly that command.
import { copyText } from './copy.js';

const open = () => {
  const step = location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (step?.tagName !== 'DETAILS') return;
  step.open = true;
  step.scrollIntoView({ block: 'start' });
};
addEventListener('hashchange', open);
open();

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-copy]');
  if (!b) return;
  const ok = await copyText(b.dataset.copy);
  b.textContent = ok ? 'Copied' : 'Select and copy';
  setTimeout(() => { b.textContent = 'Copy'; }, 1500);
});
