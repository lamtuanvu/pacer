// Regenerate only the unreachable P6e library's reference goldens.
import { p6eCases } from "../test/fixtures/p6e/cases";
import { reference } from "../test/fixtures/p6e/reference";
const cases = [];
for (const input of p6eCases())
  cases.push({ input, expected: await reference(input) });
await Bun.write(
  new URL("../test/fixtures/p6e/goldens.json", import.meta.url),
  "[\n" + cases.map((c) => "  " + JSON.stringify(c)).join(",\n") + "\n]\n",
);
console.log(`Captured ${cases.length} P6e reference cases`);
