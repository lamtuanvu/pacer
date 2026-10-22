import { Terminal } from "@xterm/xterm";
import { terminalDocument } from "../../app/src/term/document";
const nonce = document.querySelector<HTMLMetaElement>('meta[name="pacer-style-nonce"]')!.content;
const terminal = new Terminal({documentOverride: terminalDocument(document, nonce), cols: 40, rows: 8, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14});
terminal.open(document.getElementById("terminal")!);
terminal.write("\x1b[31mANSI red\x1b[0m\r\n┌──────┐\r\n│ WiWi │\r\n└──────┘", () => {document.documentElement.dataset.ready = "true";});
