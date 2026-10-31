import type { Brief } from '../../../../src/tasks/types';

/** A transcript excerpt, never the submitted instructions or a raw JSON event. */
export function previewReader(brief: Brief) {
  const instructions = new Set(Object.values(brief).filter((v): v is string => typeof v === 'string').flatMap(v => v.split(/\r?\n/)).map(v => v.trim()).filter(Boolean));
  let prompt = false;
  let lines: string[] = [], pending = '', dropping = false;
  function consume(line: string) {
    line = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    line = line.trim();
    if (line.startsWith('{')) {
      try {
        const event = JSON.parse(line);
        // Codex and Claude emit structured assistant text; user/system/tool payloads stay hidden.
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') line = event.item.text;
        else if (event.type === 'assistant') line = event.message?.content?.filter((c: {type:string}) => c.type === 'text').map((c: {text:string}) => c.text).join('\n') ?? '';
        else return;
      } catch { return; }
      lines.push(...previewLines(line, brief).split('\n').filter(Boolean));
      lines = lines.slice(-2);
      return;
    }
    if (/^(?:user|system)$/.test(line) || /PACER_ROLE=executor|^# Task |^Executor contract \(from pacer\)/.test(line)) { prompt = true; return; }
    if (/^(?:assistant|codex|thinking|exec)$/.test(line)) { prompt = false; return; }
    if (prompt) {
      if (line.startsWith('- Finish with a short report:')) prompt = false;
      return;
    }
    if (!line || instructions.has(line) || /^(?:## |---$|Interactive pacer session:|Executor contract|Work planner contract)/.test(line)) return;
    line = line.replace(/\bUnknown\b/gi, '').trim()
      .replace(/\/(?:Users|home)\/[^/\s]+/g, '~')
      .replace(/\/(?:private\/)?(?:var\/folders|tmp|var\/tmp)\/[^\s"'`<>]+/g, path => path.split('/').filter(Boolean).at(-1) ?? 'file');
    if (line) lines = [...lines,line].slice(-2);
  }
  return {
    push(text: string, final = false) {
      const parts = (pending + text).split(/\r?\n|\r/);
      pending = parts.pop() ?? '';
      for (const line of parts) { if (!dropping) consume(line); dropping = false; }
      // Oversized or incomplete structured events are omitted rather than exposed.
      if (pending.length > 1024*1024) { pending = ''; dropping = true; }
      if (final) { if (!dropping) consume(pending); pending = ''; }
      return lines.join('\n');
    }
  };
}

export function previewLines(text: string, brief: Brief): string {
  return previewReader(brief).push(text,true);
}
