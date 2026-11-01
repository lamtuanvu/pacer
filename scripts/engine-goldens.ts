import { writeFileSync } from "node:fs";
import { engineGoldens } from "../test/engine-golden";
writeFileSync("test/fixtures/engine/goldens.json", JSON.stringify(engineGoldens(), null, 2) + "\n");
