// Billing in Workspace settings (#231, #228). An owner, on a phone, either deciding to pay so a second agent
// can work or fixing a card: one column, the plan in one plain line, one button per plan to buy while Free,
// Stripe's billing page once paid, and nothing else. Stripe Checkout takes the payment; only its webhook changes
// the plan, so the way back says when to expect it rather than claiming it, and offers no second Upgrade meanwhile.

// b: GET /api/billing. done: just back from Checkout (?checkout=done). last: false when a section follows it (Delete
// workspace, #799), which ends the dialog: its buttons stay, without Done.
export function billingSection(b, { esc, done = false, last = true }) {
  if (!b.owner) {
    return `<h4>Billing</h4><p class="lead">Only the workspace's owner manages its plan: ask ${esc(b.owners?.join(' or ') || 'an owner')}.</p>
      <div class="foot"><button class="btn primary" data-action="close-modal">Done</button></div>`;
  }
  const free = b.plan === 'free';
  const state = b.state ?? (free ? 'Free: one agent works at a time' : 'Any number of agents work side by side');
  const back = done && free
    ? `<p class="lead billing-done" role="status"><b>Thanks: Stripe has your payment.</b> Your plan changes to Pro within a minute, once Stripe confirms it. This updates by itself; you can close it.</p>`
    : '';
  const buy = free && !done && b.plans?.length
    ? `<p class="lead faint">A second agent waits until the first finishes or hands off. Pro runs any number side by side.</p>
      <div class="actions billing-buy">${b.plans.map((p) => `<button class="btn primary" data-action="upgrade" data-plan="${esc(p.plan)}">Upgrade to ${esc(p.label)}</button>`).join('')}</div>
      <p class="hint">Opens Stripe Checkout, where you see the price before you pay. By subscribing you agree to nuworq's <a href="${esc(b.terms)}" target="_blank" rel="noopener">Terms</a> and <a href="${esc(b.privacy)}" target="_blank" rel="noopener">Privacy Policy</a>.</p>`
    : '';
  return `<h4>Billing</h4>
    <p class="lead"${b.failing ? ' style="color:var(--warn)"' : ''}>${b.failing ? '⚠ ' : ''}<b>${esc(state)}</b></p>
    ${back}${buy}
    ${b.manage ? `<p class="lead faint">Stripe's billing page: change the card, see and download invoices, or cancel. Cancelling keeps the paid plan until the period ends; then the workspace goes back to Free.</p>` : ''}
    ${last ? `<div class="foot">${b.manage ? `<button class="btn${b.failing ? ' primary' : ''}" data-action="billing-portal">Manage billing</button>` : ''}<button class="btn${b.failing || buy ? '' : ' primary'}" data-action="close-modal">Done</button></div>`
    : b.manage ? `<div class="actions"><button class="btn${b.failing ? ' primary' : ''}" data-action="billing-portal">Manage billing</button></div>` : ''}`;
}
