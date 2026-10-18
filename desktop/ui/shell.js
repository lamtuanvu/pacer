// Also usable without Tauri: ?state=busy&prompt=1&for=14 (see desktop/README.md).
const query = new URLSearchParams(location.search);
const pages = {
  install: ['Install pacer first', 'Install the pacer CLI, then return to this window.', 'curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh'],
  not_installed: ["pacer isn't installed", 'Install the local service to open pacer.', 'pacer service install'],
  stopped: ['pacer stopped', 'Start your local service to open pacer.', ''],
  busy: ['pacer is busy', 'Waiting for the local service to answer.', ''],
  starting: ['Starting pacer…', 'Your local service is starting. This window will open automatically.', ''],
  ready: ['pacer is ready', 'Signing in and opening pacer…', ''],
  unavailable: ['Unable to check pacer', 'The local service or sign-in could not be checked. Checking again automatically.', ''],
  startFailed: ["pacer couldn't start", 'The service-manager action failed. Check pacer service logs for details.', 'pacer service logs'],
  oldService: ['Update pacer', 'This service uses an older protocol. Update pacer, then try again.', ''],
  oldApp: ['Update the pacer app', 'This service uses a newer protocol. Install a newer desktop app.', ''],
  protocol: ['Unable to connect', 'The local service returned an invalid response or protocol version.', ''],
};
let timer;
function renderShell(detail) {
  clearInterval(timer);
  const state = detail.page;
  const [title, message, command] = pages[state] || ['Connecting to pacer…', 'Looking for your local service.', ''];
  document.querySelector('h1').textContent = title;
  document.querySelector('#message').textContent = state === 'busy'
    ? (detail.prompt
      ? 'macOS is asking whether pacer can read files on an external drive. Click Allow in the macOS dialog.'
      : (detail.macos
        ? 'This usually means macOS is waiting for you to allow pacer to read files on an external drive. Check for a macOS dialog.'
        : 'The local service is listening but has not answered yet. Waiting for it to recover.'))
    : message;
  const input = document.querySelector('#command');
  input.value = command;
  document.querySelector('#command-section').hidden = !command;
  document.querySelector('#start').hidden = state !== 'stopped';
  document.querySelector('#install').hidden = state !== 'not_installed';
  document.querySelector('#restart').hidden = !(state === 'busy' && detail.restart);
  document.querySelector('#retry').hidden = !['install', 'oldService', 'oldApp', 'protocol', 'startFailed', 'unavailable'].includes(state);
  document.querySelector('#docs').hidden = state !== 'install';
  const error = document.querySelector('#error');
  error.hidden = !detail.action_error;
  error.textContent = detail.action_error || '';
  const elapsed = document.querySelector('#elapsed');
  elapsed.hidden = state !== 'busy';
  if (state === 'busy') {
    const since = Date.now() - Math.max(0, Number(detail.seconds) || 0) * 1000;
    const tick = () => { elapsed.textContent = `for ${Math.floor((Date.now() - since) / 1000)} s`; };
    tick();
    timer = setInterval(tick, 1000);
  }
}
window.renderShell = renderShell;
renderShell({ page: query.get('state'), prompt: query.get('prompt') === '1',
  seconds: query.get('for'), restart: query.get('restart') === '1' || (Number(query.get('for')) >= 30 && query.get('prompt') !== '1'),
  macos: query.get('platform') !== 'linux' });
if (query.get('compact') === '1') document.body.classList.add('compact');
document.querySelector('#command').addEventListener('click', event => event.target.select());
