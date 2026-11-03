// The nuworq mark (#322): a geometric lowercase q in ink on the citron tile. The one source for every logo
// the hub draws: the app rail (app.js), the server's flow pages, and the static pages and their favicons,
// which the server fills in as it serves them (<!--logo--> and <!--favicon--> in web/*.html). The README's
// header (docs/logo-light.svg, docs/logo-dark.svg) draws the same mark; test/colors.test.js holds it to this one.
const Q = '<circle cx="15" cy="14.5" r="5.5"/><path d="M20.5 9.5V23.5q0 2 2 2h1"/>';
export const mark =(brand, ink, width) => `<rect width="32" height="32" rx="8" fill="${brand}"/><g fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round">${Q}</g>`;

// The q is --brand-ink, dark in both themes (#484): --ink turns light in dark, and would vanish on the citron.
export const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true">${mark('var(--brand)', 'var(--brand-ink)', 3.2)}</svg>`;
// A favicon can't read CSS variables, so it carries --brand and --brand-ink as hexes (test/colors.test.js keeps
// them in step with style.css), and a heavier stroke so the ring stays open at 16px.
export const BRAND = '#d4e034', INK = '#14161a';
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${mark(BRAND, INK, 3.6)}</svg>`)}`;

// A page from web/ with its logo and favicon filled in.
export const withLogo = (html) => html.replaceAll('<!--logo-->', LOGO).replaceAll('<!--favicon-->', FAVICON);
