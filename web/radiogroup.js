// A radio group's own keys (#485): the arrow keys move the choice, as in any radio group (Tab reaches the chosen
// one, by its tabindex). These belong to the control, not to the app's shortcuts (web/shortcuts.js), so the
// shortcuts list doesn't name them. pick(radio, step) gets the radio with focus and +1 or -1.
const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
export function radioKeys(root, selector, pick) {
  root.addEventListener('keydown', (e) => {
    const radio = e.target.closest?.(selector);
    const step = radio && STEP[e.key];
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    pick(radio, step);
  }, true);
}
