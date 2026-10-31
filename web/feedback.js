// Feedback about nuworq itself (#295), from the rail (on a phone, from Menu): someone who just got stuck says what
// happened in a sentence or two. One box, and before they send, exactly what comes along with it: the page's
// address, the app version and the browser, nothing else. Sending thanks them in place of the form.

// "Safari 18 on iPhone", "Chrome 131 on macOS": the browser and the system, never the full user agent.
export function browserOf(ua = '') {
  const name = /Edg\/(\d+)/.test(ua) ? `Edge ${RegExp.$1}` : /Firefox\/(\d+)/.test(ua) ? `Firefox ${RegExp.$1}`
    : /Chrome\/(\d+)/.test(ua) ? `Chrome ${RegExp.$1}` : /Version\/(\d+)[.\d]* .*Safari/.test(ua) ? `Safari ${RegExp.$1}` : 'a browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${name} on ${os}` : name;
}

// What is attached, as it will be sent: { page, version, browser }.
export const attached = ({ href = '', version = '', ua = '' } = {}) => ({ page: href, version, browser: browserOf(ua) });

export function feedbackForm(ctx, esc) {
  return `<h2>Feedback</h2>
    <p class="lead">Something got in your way, or didn't make sense? Tell the people who build nuworq.</p>
    <label class="fb-label" for="fb-text">What happened, or what didn't make sense?</label>
    <textarea id="fb-text" rows="5" maxlength="4000" placeholder="e.g. I pressed Accept and nothing told me it worked"></textarea>
    <div class="fb-sent-with"><span class="label">Sent with it</span><ul>
      <li>This page: <code>${esc(ctx.page)}</code></li>
      <li>nuworq ${esc(ctx.version || 'version unknown')}</li>
      <li>${esc(ctx.browser)}</li>
    </ul><p class="faint">Nothing else from your workspace.</p></div>
    <div class="foot"><button class="btn ghost" data-action="close-modal">Cancel</button><button class="btn primary" data-action="feedback-send">Send</button></div>
    <div id="fb-mine-slot"></div>`;
}

// What they sent and what happened to each (#297), under the form: a three-step bar (received, being worked on,
// fixed) to read at a glance, their words, and the state in words. Declined shows the owners' note instead.
// Nothing of the feedback project: no item, agent or discussion.
export const FB_STATES = {
  received: { step: 1, label: 'Received', blurb: 'Waiting for nuworq’s owners to read it' },
  working: { step: 2, label: 'Being worked on', blurb: 'Accepted: it’s being improved' },
  fixed: { step: 3, label: 'Fixed', blurb: 'The fix has shipped' },
  declined: { step: 0, label: 'Declined', blurb: 'Not planned' },
};

export function feedbackMine(list, esc, ago = () => '') {
  if (!list?.length) return '';
  const row = (f) => {
    const s = FB_STATES[f.state] ?? FB_STATES.received;
    const bar = [1, 2, 3].map((n) => `<span class="${n <= s.step ? 'on' : ''}"></span>`).join('');
    return `<li class="fb-piece fb-${esc(f.state)}">
      <div class="fb-steps" role="img" aria-label="${esc(s.label)}">${bar}</div>
      <div class="fb-words">${esc(f.text)}</div>
      <div class="fb-state"><b>${esc(s.label)}</b> · ${f.state === 'declined' && f.note ? `“${esc(f.note)}”` : esc(s.blurb)}<span class="age"> · sent ${esc(ago(f.sent_at))}</span></div>
    </li>`;
  };
  return `<div class="fb-mine" id="fb-mine"><span class="label" data-new="feedback-mine">What you sent</span><ul>${list.map(row).join('')}</ul></div>`;
}

export const feedbackThanks = () => `<h2>Thanks</h2>
  <p class="lead">It's on its way to the people who build nuworq. They read every piece.</p>
  <div class="foot"><button class="btn primary" data-action="close-modal">Done</button></div>
  <div id="fb-mine-slot"></div>`;
