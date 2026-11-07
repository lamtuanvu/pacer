/**
 * Client replies to terminal queries the session host answers itself (ADR 0023, decision 5): DA1, DA2 and OSC 10/11
 * colours always; cursor position reports only while `cursor` is set, because modified F3 keys share their shape.
 * Mirrored by `strip_query_replies` in crates/sessions/src/control.rs.
 */
const ALWAYS = /\x1b\[[?>][\d;]*c|\x1b\]1[01];[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const WITH_CURSOR = /\x1b\[[?>][\d;]*c|\x1b\]1[01];[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\??\d+;\d+(?:;\d+)?R/g;
export function stripQueryReplies(bytes: Buffer, cursor: boolean): Buffer {
  if (!bytes.includes(0x1b)) return bytes;
  // latin1 maps every byte to one code unit, so non-reply bytes survive unchanged.
  const text = bytes.toString("latin1"), kept = text.replace(cursor ? WITH_CURSOR : ALWAYS, "");
  return kept.length === text.length ? bytes : Buffer.from(kept, "latin1");
}
/** A cursor position report the host's own terminal produced. */
export const isCursorReport = (reply: string) => /^\x1b\[\d+;\d+R$/.test(reply);
