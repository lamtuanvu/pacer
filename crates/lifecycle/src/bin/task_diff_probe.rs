//! Cross-runtime driver for `task_diff`; opens only the given PACER_HOME + repo path.
use pacer_lifecycle::{CommandGit, DiffOptions, task_diff, task_diff_to_json};
use pacer_store::TaskStore;
use std::{env, path::PathBuf};

fn main() {
    let mut args = env::args().skip(1);
    let home = PathBuf::from(args.next().expect("pacer_home"));
    let task_id = args.next().expect("task_id");
    let path = args.next();
    let mut store = TaskStore::open(&home).expect("open store");
    let task = store.read(&task_id).expect("read").expect("task");
    let options = DiffOptions {
        path: path.as_deref(),
        summary_only: env::var("SUMMARY_ONLY").is_ok(),
        snapshot: false,
    };
    let diff = task_diff(&home, &task, options, &CommandGit).expect("task_diff");
    println!("{}", serde_json::to_string(&task_diff_to_json(&diff)).expect("json"));
}
