import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import tokens from '../app/src/ds/tokens.json';
import { StatusDot } from '../app/src/ds/StatusDot';
import { IconButton } from '../app/src/ds/Button';
import { HostChip } from '../app/src/ds/HostChip';
import { MetaRow } from '../app/src/ds/MetaRow';
import { AgentStack } from '../app/src/ds/AgentStack';
import { Identicon } from '../app/src/ds/Identicon';
import { Icon } from '../app/src/ds/icons';

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}

test('tokens_include_chart_and_aurora', () => {
  const light = ['#4f7a94', '#b97d5a', '#7588c7', '#7f8f6f', '#918977', '#a5b4fc', '#f0abfc', '#99f6e4'];
  const names = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'aurora-1', 'aurora-2', 'aurora-3'];
  names.forEach((name, index) => {
    const token = tokens.color.tokens.find(token => token.name === name)!;
    expect(token.value.light).toBe(light[index]!);
    expect(token.value.dark).toMatch(/^#[\da-f]{6}$/i);
    expect(token.usage.length).toBeGreaterThan(0);
    const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + .05) / (lo! + .05); };
    if (name.startsWith('chart')) for (const [value, surfaces] of [[token.value.dark, ['#09090b', '#27272a']], [token.value.light, ['#ffffff', '#f4f4f5']]] as const) {
      for (const surface of surfaces) expect(ratio(value, surface)).toBeGreaterThanOrEqual(3);
    }
    else expect(token.usage).toContain('decorative only, never status');
  });
});

test('status_dot_has_text_label', () => {
  const html = renderToString(<StatusDot tone="good" live label="Running" />);
  expect(html).toContain('pc-status-dot--good');
  expect(html).toContain('pc-status-dot__dot--live');
  expect(html).toContain('class="pc-status-dot__label">Running</span>');
  expect(renderToString(<StatusDot tone="neutral" label="Idle" />)).not.toContain('pc-status-dot__dot--live');
});

test('status_dot_label_visible_unless_paired', () => {
  expect(renderToString(<StatusDot tone="warn" label="Needs you" />)).not.toContain('pc-status-dot__label--paired');
  expect(renderToString(<StatusDot tone="warn" label="Needs you" />)).toContain('title="Needs you"');
  expect(renderToString(<StatusDot tone="warn" label="Needs you" paired="glyph" />)).toContain('class="pc-status-dot__label pc-status-dot__label--paired">Needs you</span>');
  const pill = renderToString(<StatusDot tone="warn" label="Needs you" paired="pill" />);
  expect(pill).toContain('<span aria-hidden="true" class="pc-status-dot pc-status-dot--warn">');
  expect(pill).not.toContain('Needs you');
});

test('icon_button_renders_icon_and_keeps_label', () => {
  const html = renderToString(<IconButton icon="retry" aria-label="Retry task" />);
  expect(html).toContain('aria-label="Retry task"');
  expect(html).toContain('<svg');
  expect(html).toContain('type="button"');
  expect(renderToString(<IconButton aria-label="Existing">×</IconButton>)).toContain('>×</button>');
});

test('icon_button_danger_variant', () => {
  const html = renderToString(<IconButton icon="end-session" variant="danger" aria-label="End session" />);
  expect(html).toContain('pc-btn--danger');
  expect(html).toContain('pc-icon-button');
});

test('host_chip_remote_shows_icon_and_title', () => {
  const name = 'build-host-with-a-very-long-name';
  const html = renderToString(<HostChip name={name} kind="remote" />);
  expect(html).toContain(`title="${name}"`);
  expect(html).toContain(renderToString(<Icon name="servers" />));
  expect(renderToString(<HostChip name="Local" kind="local" />)).not.toContain('<svg');
});

test('meta_row_omits_empty_items', () => {
  const html = renderToString(<MetaRow label="Task facts" items={[
    { icon: 'pr', text: '' }, { icon: 'files', text: '   ' },
    { icon: 'time', text: 'Ran 5m', tone: 'info', emphasis: true, title: 'Ran five minutes' },
  ]} />);
  expect(html).toContain('role="group" aria-label="Task facts"');
  expect(html.match(/<svg/g)).toHaveLength(1);
  expect(html).toContain('pc-meta-row__item--info pc-meta-row__item--emphasis');
  expect(html).toContain('title="Ran five minutes"');
});

test('meta_row_renders_nothing_when_empty', () => {
  expect(renderToString(<MetaRow label="Facts" items={[]} />)).toBe('');
  expect(renderToString(<MetaRow label="Facts" items={[{ icon: 'time', text: '' }]} />)).toBe('');
});

test('agent_stack_dedupes_and_names_group', () => {
  const html = renderToString(<AgentStack agents={['codex', 'claude-code', 'codex', 'claude']} size={16} />);
  expect(html).toContain('role="img" aria-label="Codex, Claude Code"');
  expect(html.match(/class="pc-agent-mark /g)).toHaveLength(2);
  expect(html.match(/role="img"/g)).toHaveLength(1);
  expect(renderToString(<AgentStack agents={[]} />)).toBe('');
});

test('identicon_is_deterministic', () => {
  expect(renderToString(<Identicon seed="project-alpha" />)).toBe(renderToString(<Identicon seed="project-alpha" />));
  expect(renderToString(<Identicon seed="" size={32} />)).toContain('pc-identicon--32');
});

test('identicon_is_mirrored', () => {
  for (const seed of ['project-alpha', 'project-beta', '', 'Ω']) {
    const html = renderToString(<Identicon seed={seed} />);
    const cells = [...html.matchAll(/<rect[^>]*x="(\d)" y="(\d)"/g)].map(match => `${match[1]},${match[2]}`);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      const [x, y] = cell.split(',').map(Number);
      expect(cells).toContain(`${4 - x!},${y}`);
    }
  }
});

test('identicon_differs_for_different_seeds', () => {
  expect(renderToString(<Identicon seed="project-alpha" />)).not.toBe(renderToString(<Identicon seed="project-beta" />));
});

test('settings_icon_is_gear', () => {
  const html = renderToString(<Icon name="settings" />);
  expect(html).toContain('M19.4 15a1.7');
  expect(html).toContain('<circle cx="12" cy="12" r="3"');
  expect(html).not.toContain('M9 3h6l1 3');
});

test('identicon_never_empty_and_colour_independent_of_cells', () => {
  for (const seed of ['', 'a', 'release-checklist', 'Fast and cheap', 'Ω', 'x'.repeat(40)]) {
    expect(renderToString(<Identicon seed={seed} />)).toContain('<rect');
  }
});
