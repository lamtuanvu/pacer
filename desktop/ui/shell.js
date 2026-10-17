const state = new URLSearchParams(location.search).get('state');
const pages = {
  install: ['Install pacer first', 'Install the pacer CLI, then return to this window.', 'curl -fsSL https://raw.githubusercontent.com/lamtuanvu/pacer/main/install.sh | sh'],
  stopped: ["pacer isn't running", 'Start the local service to open pacer.', 'pacer service install'],
  starting: ['Starting pacer…', 'Installing and starting your local service.', 'pacer service install'],
  startFailed: ["pacer couldn't start", 'Run this command in Terminal to see the error, then try again.', 'pacer service install'],
  oldService: ['Update pacer', 'This service uses an older protocol. Update pacer, then try again.', ''],
  oldApp: ['Update the pacer app', 'This service uses a newer protocol. Install a newer desktop app.', ''],
  protocol: ['Unable to connect', 'The local service returned an invalid protocol version.', ''],
};
if (pages[state]) {
  const [title, message, command] = pages[state];
  document.querySelector('h1').textContent = title;
  document.querySelector('#message').textContent = message;
  document.querySelector('#command').textContent = command;
}
document.querySelector('#start').hidden = !['stopped', 'startFailed'].includes(state);
document.querySelector('#docs').hidden = state !== 'install';
