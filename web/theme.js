// The appearance this browser chose (#485), set on <html> before the first paint so no page flashes the other theme.
// Match device (the default) sets nothing; Light or Dark sets data-theme, which style.css's theme blocks follow.
// A plain script in every page's <head>, not a module: it has to run before anything is drawn. The app's Appearance
// setting writes the same key (web/prefs.js store: "nuworq:theme").
(function () {
  try {
    var t = localStorage.getItem('nuworq:theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* no storage: Match device */ }
})();
