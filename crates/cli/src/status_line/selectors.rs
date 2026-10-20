use serde_json::Value;
pub fn counts(s: &Value) -> &Value {
    &s["counts"]
}
pub fn planner_meter(s: &Value) -> &Value {
    &s["planner"]
}
