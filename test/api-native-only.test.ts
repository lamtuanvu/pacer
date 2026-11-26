import { expect, test } from "bun:test";
import { nativeOnly } from "../src/api/native-only";

test("nativeOnly refuses a forwarded call with unavailable and the front-door hint", async () => {
  await expect(nativeOnly("x.y")()).rejects.toMatchObject({
    code: "unavailable",
    message: "x.y is answered by the pacer front door",
    hint: "Unset PACER_FORWARD_OPS for this operation.",
  });
});
