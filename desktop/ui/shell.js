// Deterministic browser previews: ?state=starting or ?state=permission&path=/Volumes/Drive.
const query = new URLSearchParams(location.search);
const pages = {
  stuck: ['pacer could not finish signing in', 'The desktop app could not connect and sign in to the local pacer service. Retrying automatically in the background.'],
  install: ['pacer needs its command-line tool', "The pacer app runs its background service through the pacer command-line tool, which isn't installed. Install it and this window continues on its own."],
  foreign: ['Another pacer is running', 'The background service belongs to the pacer folder {path}, and this app uses a different one. Stop the other service, or open the app with the same pacer folder.'],
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
    : message.replace('{path}', detail.path || 'another folder') + (detail.page === 'stuck' ? ` Last error: ${detail.error || 'Waiting for sign-in to complete'}. Logs: ~/Library/Logs/pacer/desktop.log (Linux: ~/.local/state/pacer/desktop.log).` : '');
  status.hidden = !status.textContent;
  document.querySelector('#privacy').hidden = !permission;
  document.querySelector('#install-help').hidden = permission || detail.page !== 'install';
  // Only the plain starting state spins; permission and error pages ask for something.
  document.querySelector('#spinner').hidden = permission || Boolean(pages[detail.page]);
}
window.renderShell = renderShell;
renderShell({ page: query.get('state'), prompt: query.get('prompt') === '1', path: query.get('path') });
if (query.get('compact') === '1') document.body.classList.add('compact');
