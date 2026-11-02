use pacer_plugin_host::WireReply;
use pacer_store::TaskStore;
use std::{fs, path::Path};

const EXACT: &str = r#"{"nested":["\ud800",{"low":"\udc01","replacement":"�","pair":"😀"}]}"#;
pub fn seed(home: &Path, id: &str) {
    let mut store = TaskStore::open(home).unwrap();
    let task = store.read(id).unwrap().unwrap();
    store
        .edit(id, task["rev"].as_i64().unwrap(), 2.0, |t| {
            t.put("/exactExtra", WireReply::parse(EXACT).unwrap())
        })
        .unwrap();
}
pub fn assert_preserved(home: &Path, id: &str) {
    let task = TaskStore::open(home)
        .unwrap()
        .read_wire(id)
        .unwrap()
        .unwrap();
    assert_eq!(
        task.subtree("/exactExtra").unwrap().to_json().unwrap(),
        WireReply::parse(EXACT).unwrap().to_json().unwrap()
    );
    assert_eq!(
        fs::read_to_string(home.join(format!("tasks/{id}.json"))).unwrap(),
        task.to_json().unwrap(),
        "JSON file and SQLite-backed exact read must agree"
    );
}
