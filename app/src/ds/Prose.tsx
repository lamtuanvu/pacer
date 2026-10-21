import type { ComponentChildren } from 'preact';
import { SectionHeading } from './SectionHeading';

/** Small, escaped Markdown subset for executor-authored text. No HTML or URLs execute. */
function inline(text: string): ComponentChildren {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code>
      : part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong>
        : part);
}

export function Prose({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ComponentChildren[] = [];
  for (let at = 0; at < lines.length;) {
    const line = lines[at]!;
    if (!line.trim()) { at++; continue; }
    if (/^```/.test(line)) {
      const code: string[] = [];
      at++;
      while (at < lines.length && !/^```/.test(lines[at]!)) code.push(lines[at++]!);
      if (at < lines.length) at++;
      blocks.push(<pre key={blocks.length} tabIndex={0}><code>{code.join('\n')}</code></pre>);
    } else if (/^#{1,6}\s+/.test(line)) {
      blocks.push(<SectionHeading as="h3" key={blocks.length}>{inline(line.replace(/^#{1,6}\s+/, ''))}</SectionHeading>);
      at++;
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: ComponentChildren[] = [];
      while (at < lines.length && /^\s*[-*]\s+/.test(lines[at]!)) {
        items.push(<li key={items.length}>{inline(lines[at++]!.replace(/^\s*[-*]\s+/, ''))}</li>);
      }
      blocks.push(<ul key={blocks.length}>{items}</ul>);
    } else {
      const paragraph: string[] = [line];
      at++;
      while (at < lines.length && lines[at]!.trim() && !/^(?:```|#{1,6}\s|\s*[-*]\s)/.test(lines[at]!)) paragraph.push(lines[at++]!);
      blocks.push(<p key={blocks.length}>{inline(paragraph.join('\n'))}</p>);
    }
  }
  return <div className="pc-prose">{blocks}</div>;
}
