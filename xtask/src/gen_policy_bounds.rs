//! Preserve integer wire bounds which typify's primitive integer selection omits.
use quote::ToTokens;
use std::collections::BTreeMap;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Bounds {
    min: i128,
    max: i128,
}

pub(super) fn apply(file: &mut syn::File, schema: &serde_json::Value) -> Result<(), String> {
    let mut bounds = BTreeMap::new();
    collect(schema, &mut bounds)?;
    let mut helpers = BTreeMap::new();
    for item in &mut file.items {
        match item {
            syn::Item::Struct(item) => annotate(&mut item.fields, &bounds, &mut helpers)?,
            syn::Item::Enum(item) => {
                for variant in &mut item.variants {
                    annotate(&mut variant.fields, &bounds, &mut helpers)?;
                }
            }
            _ => {}
        }
    }
    for ((min, max), helper) in helpers {
        let helper = quote::format_ident!("{helper}");
        file.items.push(syn::parse_quote! {
            fn #helper<'de, D, T>(deserializer: D) -> ::std::result::Result<T, D::Error>
            where D: ::serde::Deserializer<'de>, T: ::serde::Deserialize<'de> {
                let value = <::serde_json::Value as ::serde::Deserialize<'de>>::deserialize(deserializer)?;
                let integer = value.as_i64().map(i128::from).or_else(|| value.as_u64().map(i128::from))
                    .ok_or_else(|| <D::Error as ::serde::de::Error>::custom("expected bounded integer"))?;
                if integer < #min || integer > #max {
                    return Err(<D::Error as ::serde::de::Error>::custom("integer outside schema bounds"));
                }
                <T as ::serde::Deserialize<'de>>::deserialize(value)
                    .map_err(<D::Error as ::serde::de::Error>::custom)
            }
        });
    }
    Ok(())
}

fn integer(value: Option<&serde_json::Value>) -> Result<i128, String> {
    let n = value
        .and_then(serde_json::Value::as_f64)
        .ok_or("missing integer schema bound")?;
    if !n.is_finite() || n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
        return Err("unsupported integer schema bound".into());
    }
    Ok(n as i128)
}

fn collect(value: &serde_json::Value, bounds: &mut BTreeMap<String, Bounds>) -> Result<(), String> {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(properties) = object
                .get("properties")
                .and_then(serde_json::Value::as_object)
            {
                for (name, field) in properties {
                    if field.get("type").and_then(serde_json::Value::as_str) != Some("integer") {
                        continue;
                    }
                    let next = Bounds {
                        min: integer(field.get("minimum"))?,
                        max: integer(field.get("maximum"))?,
                    };
                    if next.min > next.max {
                        return Err("invalid integer schema interval".into());
                    }
                    if bounds.get(name).is_some_and(|old| old != &next) {
                        return Err(format!(
                            "policy integer {name} needs contextual bound mapping"
                        ));
                    }
                    bounds.insert(name.clone(), next);
                }
            }
            for nested in object.values() {
                collect(nested, bounds)?;
            }
        }
        serde_json::Value::Array(values) => {
            for nested in values {
                collect(nested, bounds)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn annotate(
    fields: &mut syn::Fields,
    bounds: &BTreeMap<String, Bounds>,
    helpers: &mut BTreeMap<(i128, i128), String>,
) -> Result<(), String> {
    for field in fields {
        let Some(name) = &field.ident else { continue };
        let mut name = name.to_string();
        for attr in field.attrs.iter().filter(|a| a.path().is_ident("serde")) {
            let entries = attr
                .parse_args_with(
                    syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
                )
                .map_err(|e| e.to_string())?;
            for entry in entries {
                if let syn::Meta::NameValue(meta) = entry
                    && meta.path.is_ident("rename")
                    && let syn::Expr::Lit(lit) = meta.value
                    && let syn::Lit::Str(lit) = lit.lit
                {
                    name = lit.value();
                }
            }
        }
        let Some(bound) = bounds.get(&name) else {
            continue;
        };
        let ty = field.ty.to_token_stream().to_string().replace(' ', "");
        if !matches!(
            ty.as_str(),
            "i64"
                | "u64"
                | "::std::num::NonZeroU64"
                | "::std::option::Option<::std::num::NonZeroU64>"
                | "::std::option::Option<i64>"
                | "::std::option::Option<u64>"
        ) {
            return Err(format!("unsupported policy integer field {name}: {ty}"));
        }
        let next = format!("deserialize_integer_{}", helpers.len());
        let helper = helpers.entry((bound.min, bound.max)).or_insert(next);
        field
            .attrs
            .push(syn::parse_quote!(#[serde(deserialize_with = #helper)]));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ambiguous_or_incomplete_numeric_mappings_fail_generation() {
        let mut fields = BTreeMap::new();
        assert!(
            collect(
                &serde_json::json!({"properties":{"count":{"type":"integer","minimum":0}}}),
                &mut fields
            )
            .is_err()
        );
        let schema = serde_json::json!({"oneOf":[{"properties":{"count":{"type":"integer","minimum":0,"maximum":10}}},{"properties":{"count":{"type":"integer","minimum":0,"maximum":11}}}]});
        assert!(collect(&schema, &mut BTreeMap::new()).is_err());
    }
}
