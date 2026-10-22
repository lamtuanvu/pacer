import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

// Compile the actual production completion tail, not a rewritten decision model.
// No launchctl, Security framework, keychain, process or native fixture is used.
test("bootout completion observes fresh state after exact exit and ledger retirement", () => {
  const source = readFileSync(join(import.meta.dir, "../desktop/src-tauri/src/ota/platform.rs"), "utf8");
  const marker = '            self.fixture_ledger(trust, &registration, "retired", None)?;\n        }\n';
  const ending = '\n    }\n}\n\n/// Observe only.';
  const parts = source.split(marker);
  expect(parts.length).toBe(2);
  const ends = parts[1]!.split(ending);
  expect(ends.length).toBe(2);
  const tail = ends[0]!;
  expect(tail.match(/\bmatch change\s*\{/g)?.length).toBe(1);
  const root = tmpDir(), rust = join(root, "bootout.rs"), binary = join(root, "bootout-tests");
  writeFileSync(rust, `
#![allow(dead_code, unused_variables)]
use std::cell::Cell;
#[derive(Clone, Copy, PartialEq)] enum JobChange { Bootstrap, Bootout, Disable, Enable }
#[derive(Clone, Debug, PartialEq)] enum OtaError { Identity, Unavailable }
#[derive(Clone)] struct Job { disabled: Option<bool> }
struct Observer { fresh: Result<Option<Job>, OtaError>, calls: Cell<usize> }
impl Observer {
  fn observe(&self, _: &()) -> Result<Option<Job>, OtaError> {
    self.calls.set(self.calls.get() + 1);
    self.fresh.clone()
  }
  fn completion(&self, change: JobChange, after: Option<Job>) -> Result<(), OtaError> {
    let trust = &();
${tail}
  }
}
fn observer(fresh: Result<Option<Job>, OtaError>) -> Observer { Observer { fresh, calls: Cell::new(0) } }
#[test] fn stale_loaded_fresh_absent_completes() {
  let o = observer(Ok(None));
  assert_eq!(o.completion(JobChange::Bootout, Some(Job { disabled: None })), Ok(()));
  assert_eq!(o.calls.get(), 1);
}
#[test] fn stale_absent_fresh_loaded_refuses() {
  let o = observer(Ok(Some(Job { disabled: None })));
  assert_eq!(o.completion(JobChange::Bootout, None), Err(OtaError::Identity));
  assert_eq!(o.calls.get(), 1);
}
#[test] fn fresh_observer_error_is_preserved() {
  for error in [OtaError::Identity, OtaError::Unavailable] {
    let o = observer(Err(error.clone()));
    assert_eq!(o.completion(JobChange::Bootout, None), Err(error));
    assert_eq!(o.calls.get(), 1);
  }
}
#[test] fn bootstrap_uses_original_snapshot_without_query() {
  let o = observer(Err(OtaError::Identity));
  assert_eq!(o.completion(JobChange::Bootstrap, Some(Job { disabled: None })), Ok(()));
  assert_eq!(o.completion(JobChange::Bootstrap, None), Err(OtaError::Identity));
  assert_eq!(o.calls.get(), 0);
}
#[test] fn disable_uses_original_snapshot_without_query() {
  let o = observer(Err(OtaError::Identity));
  assert_eq!(o.completion(JobChange::Disable, Some(Job { disabled: Some(true) })), Ok(()));
  assert_eq!(o.completion(JobChange::Disable, Some(Job { disabled: Some(false) })), Err(OtaError::Unavailable));
  assert_eq!(o.calls.get(), 0);
}
#[test] fn enable_uses_original_snapshot_without_query() {
  let o = observer(Err(OtaError::Identity));
  assert_eq!(o.completion(JobChange::Enable, Some(Job { disabled: Some(false) })), Ok(()));
  assert_eq!(o.completion(JobChange::Enable, Some(Job { disabled: Some(true) })), Err(OtaError::Unavailable));
  assert_eq!(o.calls.get(), 0);
}
`);
  const compile = Bun.spawnSync(["rustc", "--edition=2021", "--test", rust, "-o", binary], { stdout: "pipe", stderr: "pipe" });
  expect({ code: compile.exitCode, stderr: compile.stderr.toString() }).toEqual({ code: 0, stderr: "" });
  const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe" });
  expect({ code: run.exitCode, stderr: run.stderr.toString() }).toEqual({ code: 0, stderr: "" });
  expect(run.stdout.toString()).toContain("test result: ok. 6 passed; 0 failed;");
});
