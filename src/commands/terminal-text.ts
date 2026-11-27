import { safeText } from "../dashboard/frame";

/** Agent-written text printed to the person's terminal: no control sequences, line breaks and tabs kept. */
export const terminalText = (text: string): string =>
  text.split(/([\n\t])/).map((part, i) => i % 2 ? part : safeText(part)).join("");

/** The same for text that must stay on its line. */
export const terminalLine = (text: string): string => safeText(text.replace(/[\r\n\t]+/g, " "));

/** JSON already escapes C0; this escapes the DEL and C1 characters it leaves as they are. */
export const terminalJson = (value: unknown, indent?: number): string =>
  JSON.stringify(value, null, indent).replace(/[\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
