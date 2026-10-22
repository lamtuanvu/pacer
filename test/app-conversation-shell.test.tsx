import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { AttachmentDelivery } from "../app/src/screens/session/Attachments";
import { ConversationHeader } from "../app/src/screens/session/Conversation";

test("later attachment reference requires an explicit copy step and user submission", () => {
 const html=renderToString(<AttachmentDelivery name="image.png" text='Use "image.png" at "/tmp/private/image".' onCopy={()=>{}}/>);
 expect(html).toContain("Copy reference");
 expect(html).toContain("Paste into the agent’s input, then submit when ready.");
 expect(html).not.toContain("Send message");
});
test("conversation shell exposes native session identity and end action without delegated review",()=>{
 const html=renderToString(<ConversationHeader title="Build a page" repo="project" branch="pacer/task" executor="Codex · work" active busy={false} onEnd={()=>{}}/>);
 expect(html).toContain("project");expect(html).toContain("Codex · work");expect(html).toContain("End session");
 expect(html).not.toContain("Take over");expect(html).not.toContain("Review");
});
