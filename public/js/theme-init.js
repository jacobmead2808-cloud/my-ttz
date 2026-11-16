// Applies the saved theme before CSS paints to avoid a flash. ("system" follows the OS.)
(function () {
  var t = 'light';
  try { t = localStorage.getItem('theme') || 'light'; } catch (e) { /* storage unavailable */ }
  if (t === 'system') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
