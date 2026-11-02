import { render } from "preact";
import { Thread } from "../../app/src/screens/session/Thread";
import { TaskContext } from "../../app/src/screens/task-shared";
import { initialState } from "../../app/src/data/store";
import { ApiError } from "../../app/src/data/api";

let attempts = 0;
const api = { async call(op: string) {
  if (op === "msg.log") return { messages: [] };
  if (op === "msg.send") {
    if (++attempts % 2) throw new ApiError("invalid_input", "Try again", undefined, 400);
    return { delivery: "held" };
  }
  return {};
} };
render(<TaskContext.Provider value={{ api: api as never, state: { ...initialState(), connected: true } }}><Thread id="t-focus" closed={false}/></TaskContext.Provider>, document.getElementById("app")!);
