// Offline screen: retry button + automatic reload when the connection returns (CSP forbids inline scripts).
document.getElementById('retry').addEventListener('click', () => location.reload());
window.addEventListener('online', () => location.reload());
