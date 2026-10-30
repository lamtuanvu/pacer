//! Collection bounds for the new policy observation area only.
use quote::ToTokens;
use std::collections::{BTreeMap, BTreeSet};
type Bounds = (usize, usize);

pub(super) fn apply(file: &mut syn::File, schema: &serde_json::Value) -> Result<(), String> {
    let mut bounds = BTreeMap::new();
    collect(schema, &mut bounds)?;
    let mut helpers = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for item in &mut file.items {
        match item {
            syn::Item::Struct(item) => {
                annotate(&mut item.fields, &bounds, &mut helpers, &mut seen)?
            }
            syn::Item::Enum(item) => {
                for variant in &mut item.variants {
                    annotate(&mut variant.fields, &bounds, &mut helpers, &mut seen)?;
                }
            }
            _ => {}
        }
    }
    if bounds.keys().any(|name| !seen.contains(name)) {
        return Err("bounded policy collection has no matching generated field".into());
    }
    for ((min, max), name) in helpers {
        let name = quote::format_ident!("{name}");
        file.items.push(syn::parse_quote!{
            fn #name<'de,D,T>(deserializer:D)->::std::result::Result<T,D::Error>
            where D: ::serde::Deserializer<'de>, T: ::serde::Deserialize<'de> {
                let value=<::serde_json::Value as ::serde::Deserialize<'de>>::deserialize(deserializer)?;
                let length=value.as_array().ok_or_else(||<D::Error as ::serde::de::Error>::custom("expected bounded array"))?.len();
                if !(#min..=#max).contains(&length) {return Err(<D::Error as ::serde::de::Error>::custom("array length outside schema bounds"));}
                <T as ::serde::Deserialize<'de>>::deserialize(value).map_err(<D::Error as ::serde::de::Error>::custom)
            }
        });
    }
    Ok(())
}
fn item_bound(value: Option<&serde_json::Value>, default: usize) -> Result<usize, String> {
    value
        .map(|v| {
            v.as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| "invalid collection schema bound".into())
        })
        .unwrap_or(Ok(default))
}
fn collect(value: &serde_json::Value, bounds: &mut BTreeMap<String, Bounds>) -> Result<(), String> {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(properties) = object
                .get("properties")
                .and_then(serde_json::Value::as_object)
            {
                for (name, field) in properties {
                    if field.get("type").and_then(serde_json::Value::as_str) != Some("array")
                        || (field.get("minItems").is_none() && field.get("maxItems").is_none())
                    {
                        continue;
                    }
                    let next = (
                        item_bound(field.get("minItems"), 0)?,
                        item_bound(field.get("maxItems"), usize::MAX)?,
                    );
                    if next.0 > next.1 {
                        return Err("invalid collection interval".into());
                    }
                    if bounds.get(name).is_some_and(|old| old != &next) {
                        return Err(format!("policy collection {name} needs contextual bounds"));
                    }
                    bounds.insert(name.clone(), next);
                }
            }
            for child in object.values() {
                collect(child, bounds)?;
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                collect(child, bounds)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn annotate(
    fields: &mut syn::Fields,
    bounds: &BTreeMap<String, Bounds>,
    helpers: &mut BTreeMap<Bounds, String>,
    seen: &mut BTreeSet<String>,
) -> Result<(), String> {
    for field in fields {
        let Some(name) = &field.ident else {
            continue;
        };
        let Some(bound) = bounds.get(&name.to_string()) else {
            continue;
        };
        if !field
            .ty
            .to_token_stream()
            .to_string()
            .replace(' ', "")
            .starts_with("::std::vec::Vec<")
        {
            return Err(format!("unsupported bounded collection {name}"));
        }
        seen.insert(name.to_string());
        let next = format!("deserialize_collection_{}", helpers.len());
        let helper = helpers.entry(*bound).or_insert(next);
        field
            .attrs
            .push(syn::parse_quote!(#[serde(deserialize_with=#helper)]));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_collections_are_selected_without_inventing_unbounded_route_limits() {
        let schema = serde_json::json!({"properties":{"types":{"type":"array","minItems":1,"maxItems":32},"candidates":{"type":"array"}}});
        let mut bounds = BTreeMap::new();
        assert!(collect(&schema, &mut bounds).is_ok());
        assert_eq!(bounds.get("types"), Some(&(1, 32)));
        assert!(!bounds.contains_key("candidates"));
    }
    #[test]
    fn contradictory_or_fractional_collection_bounds_fail_generation() {
        let conflict = serde_json::json!({"oneOf":[{"properties":{"types":{"type":"array","maxItems":32}}},{"properties":{"types":{"type":"array","maxItems":33}}}]});
        assert!(collect(&conflict, &mut BTreeMap::new()).is_err());
        let fraction = serde_json::json!({"properties":{"types":{"type":"array","maxItems":1.5}}});
        assert!(collect(&fraction, &mut BTreeMap::new()).is_err());
    }
}
