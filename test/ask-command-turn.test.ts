import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { assistantDatabase, finishTurn } from "../src/assistant/store";
import { askCommand } from "../src/commands/ask";

/** `assistant.turn` is front-door-only now; a successful `pacer ask` must not call it. */
const TURN = "turn-cli-direct-read";

test("pacer ask reads a settled turn from the store, not the nativeOnly op", async () => {
  const ctx = fakeCtx();
  const db = assistantDatabase(ctx);
  db.run("INSERT INTO assistant_conversations(id,title,created_at,updated_at) VALUES('c-cli','q',1,1)");
  db.query(
    "INSERT INTO assistant_turns(id,conversation_id,seq,at,question,state,account,scope) VALUES(?,'c-cli',1,1,'q','running',NULL,'{\"kind\":\"dispatch\",\"days\":7}')",
  ).run(TURN);
  finishTurn(ctx, TURN, { state: "done", answer: "ok" });

  const result = await askCommand(["q"], ctx, {
    callOp: async (_ctx, op) => {
      if (op === "assistant.ask") return { turnId: TURN };
      throw new Error(`${op} is answered by the pacer front door`);
    },
  });
  expect(result).toMatchObject({ code: 0, out: "ok" });
});
