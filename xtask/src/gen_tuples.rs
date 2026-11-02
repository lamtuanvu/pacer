//! Translate draft-2020 tuple vocabulary for schemars 0.8 / typify's draft-7 reader.
pub fn normalize(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            // A union of singleton literal tuples is one bounded homogeneous
            // array. Typify otherwise flattens anyOf tuples into an object.
            let literals = object
                .get("anyOf")
                .and_then(|v| v.as_array())
                .and_then(|arms| {
                    if arms.is_empty() {
                        return None;
                    }
                    arms.iter()
                        .map(|arm| {
                            let prefix = arm.get("prefixItems")?.as_array()?;
                            if prefix.len() != 1
                                || arm.get("minItems")?.as_u64() != Some(1)
                                || arm.get("maxItems")?.as_u64() != Some(1)
                            {
                                return None;
                            }
                            Some(prefix[0].get("const")?.clone())
                        })
                        .collect::<Option<Vec<_>>>()
                });
            if let Some(literals) = literals {
                object.remove("anyOf");
                object.insert("type".into(), serde_json::json!("array"));
                object.insert("items".into(), serde_json::json!({"enum":literals}));
                object.insert("minItems".into(), serde_json::json!(1));
                object.insert("maxItems".into(), serde_json::json!(1));
            }
            if let Some(mut prefix) = object.remove("prefixItems") {
                if let Some(items) = prefix.as_array_mut() {
                    for item in items.iter_mut() {
                        if let Some(o) = item.as_object_mut()
                            && let Some(value) = o.remove("const")
                        {
                            o.insert("enum".into(), serde_json::json!([value]));
                        }
                    }
                }
                if let Some(tail) = object.remove("items") {
                    object.insert("additionalItems".into(), tail);
                }
                object.insert("items".into(), prefix);
            }
            for child in object.values_mut() {
                normalize(child);
            }
        }
        serde_json::Value::Array(array) => {
            for child in array {
                normalize(child);
            }
        }
        _ => {}
    }
}
#[cfg(test)]
mod tests {
    use super::normalize;
    use serde_json::json;
    #[test]
    fn fixed_tuple_preserves_prefix_and_refuses_extra_items() {
        let mut value = json!({"anyOf":[{"type":"array","prefixItems":[{"const":"direct"}],"items":false,"minItems":1,"maxItems":1}]});
        normalize(&mut value);
        assert_eq!(
            value,
            json!({"type":"array","items":{"enum":["direct"]},"minItems":1,"maxItems":1})
        );
    }
}
