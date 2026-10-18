// Deterministic browser previews: ?state=starting or ?state=permission&path=/Volumes/Drive.
const query = new URLSearchParams(location.search);
const pages = {
  install: ['Install the pacer app', 'This installation is missing its pacer CLI. Install a complete copy of pacer.'],
  oldService: ['Update pacer', 'This service uses an older protocol. Install a newer version of pacer.'],
  oldApp: ['Update the pacer app', 'This service uses a newer protocol. Install a newer desktop app.'],
  protocol: ['Unable to connect', 'The local service returned an incompatible response. Install a compatible version of pacer.'],
};
function renderShell(detail) {
  const permission = detail.page === 'permission' || detail.prompt;
  const [title, message] = pages[detail.page] || ['Starting pacer…', ''];
  document.querySelector('h1').textContent = permission ? '' : title;
  const target = String(detail.path || '').split('/').filter(Boolean).pop() || 'your external drive';
  const status = document.querySelector('#message');
  status.textContent = permission
    ? `macOS needs your permission for pacer to read ${target}. Click Allow in the macOS dialog.`
    : message;
  status.hidden = !status.textContent;
  document.querySelector('#privacy').hidden = !permission;
  // Only the plain starting state spins; permission and error pages ask for something.
  document.querySelector('#spinner').hidden = permission || Boolean(pages[detail.page]);
}
window.renderShell = renderShell;
renderShell({ page: query.get('state'), prompt: query.get('prompt') === '1', path: query.get('path') });
if (query.get('compact') === '1') document.body.classList.add('compact');
