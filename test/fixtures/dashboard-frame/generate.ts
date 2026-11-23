// Explicit regeneration only: tests never bless their own output.
import { semantics } from "./semantics";
import { corpus, frames } from "./cases";
import { controllerGolden } from "./controller";
await Bun.write(new URL("inputs.json", import.meta.url), JSON.stringify(corpus(), null, 2) + "\n");
await Bun.write(new URL("golden.json", import.meta.url), JSON.stringify(frames(), null, 2) + "\n");
await Bun.write(new URL("semantics.json", import.meta.url), JSON.stringify(semantics(), null, 2) + "\n");
await Bun.write(new URL("controller.json", import.meta.url), JSON.stringify(controllerGolden(), null, 2) + "\n");
