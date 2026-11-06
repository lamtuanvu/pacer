//! Cross-runtime driver for `task_diff`; opens only the given PACER_HOME + repo path.
use pacer_lifecycle::{CommandGit, DiffOptions, task_diff, task_diff_to_json};
use pacer_store::TaskStore;
use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let home = PathBuf::from(args.next().ok_or("pacer_home required")?);
    let task_id = args.next().ok_or("task_id required")?;
    let path = args.next();
    let mut store = TaskStore::open(&home)?;
    let task = store.read(&task_id)?.ok_or("task not found")?;
    let options = DiffOptions {
        path: path.as_deref(),
        summary_only: env::var("SUMMARY_ONLY").is_ok(),
        snapshot: false,
    };
    let diff = task_diff(&home, &task, options, &CommandGit)?;
    println!("{}", serde_json::to_string(&task_diff_to_json(&diff))?);
    Ok(())
}
