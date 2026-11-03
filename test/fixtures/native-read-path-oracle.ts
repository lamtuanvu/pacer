import { CoreError } from "../../src/core/errors";
import { absolutePath } from "../../src/plugins/capability-paths";

const paths: unknown[] = JSON.parse(await Bun.stdin.text());
const results = paths.map((path) => {
  try {
    return { path: absolutePath(path) };
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    return { error: error.code };
  }
});
process.stdout.write(JSON.stringify(results));
