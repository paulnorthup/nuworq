// Live updates never take a person out of the box they're writing in (#374). A redraw replaces the page's HTML,
// and with it the focused box: this keeps where they were (which box, the cursor and selection, its scroll) and
// puts them back there afterwards. Pure but for the document passed in, so it's tested without a browser.

// Kinds of input nobody writes in.
const NOT_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden'];

// A box a person writes in: a textarea, a text-like input, or anything contenteditable. Empty or not.
export function isTextBox(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NOT_TEXT.includes(String(el.type || 'text').toLowerCase()));
}

// Where the person is writing, before a redraw: the box (by data-draft, else id), cursor, selection and scroll.
// Its text too when it has no draft to come back from. null when focus isn't in a box a redraw can find again.
export function saveFocus(doc) {
  const el = doc.activeElement;
  if (!isTextBox(el)) return null;
  const draft = el.dataset?.draft;
  if (!draft && !el.id) return null;
  let sel = null;
  // Some inputs (number, email) have no selection, and reading it throws.
  try { if (el.selectionStart != null) sel = [el.selectionStart, el.selectionEnd, el.selectionDirection ?? 'none']; } catch { /* none */ }
  return {
    ...(draft ? { draft } : { id: el.id }), sel, top: el.scrollTop ?? 0, left: el.scrollLeft ?? 0,
    value: draft || el.isContentEditable ? null : el.value,
  };
}

// After a redraw: back into the same box, with the cursor, selection and scroll it had. Nothing when it's gone.
export function restoreFocus(doc, saved) {
  if (!saved) return false;
  const el = saved.draft != null ? [...doc.querySelectorAll('[data-draft]')].find((e) => e.dataset.draft === saved.draft) : doc.getElementById(saved.id);
  if (!isTextBox(el)) return false;
  if (doc.activeElement === el) return true; // not replaced: nothing moved
  if (saved.value != null && !el.value) el.value = saved.value;
  el.focus({ preventScroll: true });
  if (saved.sel) try { el.setSelectionRange(...saved.sel); } catch { /* no selection on this kind of input */ }
  el.scrollTop = saved.top;
  el.scrollLeft = saved.left;
  return true;
}
