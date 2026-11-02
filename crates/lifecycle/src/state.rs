use crate::{AdmissionError, work_node};
use pacer_store::{StoreError, TaskStore};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};

impl From<StoreError> for AdmissionError {
    fn from(value: StoreError) -> Self {
        match value {
            StoreError::Conflict => Self::conflict("task changed"),
            other => Self(other.to_string()),
        }
    }
}
impl From<rusqlite::Error> for AdmissionError {
    fn from(value: rusqlite::Error) -> Self {
        Self(value.to_string())
    }
}
impl From<std::io::Error> for AdmissionError {
    fn from(value: std::io::Error) -> Self {
        Self(value.to_string())
    }
}
impl From<serde_json::Error> for AdmissionError {
    fn from(value: serde_json::Error) -> Self {
        Self(value.to_string())
    }
}

/// Domain adapter over the shared task store; reads never reserve or launch.
pub struct AdmissionState {
    pub tasks: TaskStore,
}
impl AdmissionState {
    pub fn open(home: impl AsRef<Path>) -> Result<Self, AdmissionError> {
        let mut tasks = TaskStore::open(home.as_ref())?;
        tasks
            .connection()?
            .execute_batch(include_str!("work.sql"))?;
        Ok(Self { tasks })
    }
    pub fn read(&mut self, id: &str) -> Result<Option<Value>, AdmissionError> {
        Ok(self.tasks.read(id)?)
    }
    pub fn work(&mut self, id: &str) -> Result<Option<Value>, AdmissionError> {
        get_work(self.tasks.connection()?, id)
    }
    pub fn create(
        &mut self,
        task: &Value,
        options: Option<&Value>,
        parent: Option<&str>,
        now: f64,
    ) -> Result<(), AdmissionError> {
        self.tasks.insert_with(task, now, |db| {
            if let Some(options) = options {
                register(db, task, options, parent, now).map_err(|e| StoreError::Admission(e.0))?;
            }
            Ok(())
        })?;
        Ok(())
    }
    pub fn register(
        &mut self,
        id: &str,
        options: &Value,
        parent: Option<&str>,
        now: f64,
    ) -> Result<Value, AdmissionError> {
        let db = self.tasks.connection()?;
        let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
        if let Some(existing) = get_work(&tx, id)? {
            return Ok(existing);
        }
        let task = read_task(&tx, id)?.ok_or_else(|| AdmissionError("Unknown work task".into()))?;
        let node = register(&tx, &task, options, parent, now)?;
        tx.commit()?;
        Ok(node)
    }
    pub fn pending_dependencies(&mut self, id: &str) -> Result<Vec<String>, AdmissionError> {
        dependencies(self.tasks.connection()?, id)
    }
}
pub(crate) fn read_task(db: &Connection, id: &str) -> Result<Option<Value>, AdmissionError> {
    let text: Option<String> = db
        .query_row("SELECT record FROM tasks WHERE id=?", [id], |r| r.get(0))
        .optional()?;
    Ok(text.map(|text| serde_json::from_str(&text)).transpose()?)
}
pub(crate) fn get_work(db: &Connection, id: &str) -> Result<Option<Value>, AdmissionError> {
    let row = db
        .query_row(
            "SELECT parent_id,root_id,depth,options,dependencies FROM work_nodes WHERE task_id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    row.map(|(parent,root,depth,options,deps)|{
        let mut options:Value=serde_json::from_str(&options)?;
        if options.get("delegationEnforcement").is_none_or(Value::is_null) {options["delegationEnforcement"]=json!("cooperative");}
        let deps:Value=serde_json::from_str(&deps)?;
        Ok(json!({"taskId":id,"parentId":parent,"rootId":root,"depth":depth,"options":options,"dependencies":deps}))
    }).transpose()
}
pub(crate) fn register(
    db: &Connection,
    task: &Value,
    options: &Value,
    parent: Option<&str>,
    now: f64,
) -> Result<Value, AdmissionError> {
    let id = task["id"]
        .as_str()
        .ok_or_else(|| AdmissionError("Unknown work task".into()))?;
    if let Some(existing) = get_work(db, id)? {
        return Ok(existing);
    }
    let mut ancestors = Vec::new();
    let mut cursor = parent.map(str::to_owned);
    let mut seen = HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            return Err(AdmissionError("Invalid work lineage".into()));
        }
        let node =
            get_work(db, &id)?.ok_or_else(|| AdmissionError("Parent has no work policy".into()))?;
        let task =
            read_task(db, &id)?.ok_or_else(|| AdmissionError("Parent cannot delegate".into()))?;
        let count:i64=db.query_row("WITH RECURSIVE subtree(id) AS (SELECT task_id FROM work_nodes WHERE task_id=? UNION ALL SELECT child.task_id FROM work_nodes child JOIN subtree ON child.parent_id=subtree.id) SELECT count(*)-1 FROM subtree",[&id],|r|r.get(0))?;
        cursor = node["parentId"].as_str().map(str::to_owned);
        ancestors.push((node, task, count as usize));
    }
    let root_count = if let Some((root, _, _)) = ancestors.last() {
        db.query_row(
            "SELECT count(*)-1 FROM work_nodes WHERE root_id=?",
            [root["taskId"].as_str()],
            |r| r.get::<_, i64>(0),
        )? as usize
    } else {
        0
    };
    let node = work_node(id, task, options, &ancestors, root_count)?;
    let options = bounded_json(&node["options"])?;
    db.execute("INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,?)",params![id,parent,node["rootId"].as_str(),node["depth"].as_i64(),options,"[]"])?;
    if task["state"] == "queued" {
        db.execute("INSERT INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(?,'queue',?,0,1)",params![id,now])?;
    }
    db.execute(
        "INSERT INTO work_events(root_id,task_id,at,kind,data) VALUES(?,?,?,'work.created',?)",
        params![
            node["rootId"].as_str(),
            id,
            now,
            bounded_json(&json!({"parentId":parent,"depth":node["depth"]}))?
        ],
    )?;
    Ok(node)
}
pub(crate) fn bounded_json(value: &Value) -> Result<String, AdmissionError> {
    let text = serde_json::to_string(value)?;
    if text.len() > 256 * 1024 {
        return Err(AdmissionError("Work record exceeds 256 KiB".into()));
    }
    Ok(text)
}
pub(crate) fn dependencies(db: &Connection, id: &str) -> Result<Vec<String>, AdmissionError> {
    let Some(work) = get_work(db, id)? else {
        return Ok(vec![]);
    };
    let mut pending = Vec::new();
    for dependency in work["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let waived:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM work_dependency_waivers WHERE task_id=? AND dependency_id=?)",params![id,dependency],|r|r.get(0))?;
        if !waived
            && read_task(db, dependency)?
                .as_ref()
                .and_then(|t| t.pointer("/review/accepted"))
                != Some(&Value::Bool(true))
        {
            pending.push(dependency.to_owned());
        }
    }
    Ok(pending)
}

impl From<pacer_foundation::lock::LockError> for AdmissionError {
    fn from(value: pacer_foundation::lock::LockError) -> Self {
        Self(value.to_string())
    }
}
