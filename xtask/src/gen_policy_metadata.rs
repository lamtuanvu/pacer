//! Keep reserved authority-key presence exclusive despite serde untagged first-match.
use quote::quote;

pub(super) fn apply(file: &mut syn::File, schema: &serde_json::Value) -> Result<(), String> {
    let defs = schema.get("$defs").ok_or("missing policy definitions")?;
    let envelope = &defs["pluginMetadata"]["oneOf"];
    let arms = envelope
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or("metadata requires exactly two schema arms")?;
    for (index, required, forbidden) in [
        (0, "capabilityCall", "readOwner"),
        (1, "readOwner", "capabilityCall"),
    ] {
        check_arm(&arms[index], required, forbidden)?;
    }
    check_arm(&defs["readOwnerMetadata"], "readOwner", "capabilityCall")?;
    replace(file, "PluginMetadata", false)?;
    replace(file, "ReadOwnerMetadata", true)
}

fn check_arm(schema: &serde_json::Value, required: &str, forbidden: &str) -> Result<(), String> {
    if schema["required"] != serde_json::json!([required])
        || schema["properties"][forbidden] != serde_json::json!({"not":{}})
    {
        return Err(
            "metadata schema must require one reserved key and prohibit the opposite".into(),
        );
    }
    Ok(())
}

fn replace(file: &mut syn::File, name: &str, read_only: bool) -> Result<(), String> {
    let index = file
        .items
        .iter()
        .position(|item| match item {
            syn::Item::Enum(item) => item.ident == name,
            syn::Item::Struct(item) => item.ident == name,
            _ => false,
        })
        .ok_or_else(|| format!("missing generated metadata type {name}"))?;
    let public = quote::format_ident!("{name}");
    let wire = quote::format_ident!("{name}Wire");
    let mut shadow = file.items[index].clone();
    let conversion = match &mut shadow {
        syn::Item::Enum(item) => {
            item.ident = wire.clone();
            item.vis = syn::Visibility::Inherited;
            item.attrs.retain(|a| !a.path().is_ident("doc"));
            let mut arms = Vec::new();
            for variant in &item.variants {
                let syn::Fields::Named(fields) = &variant.fields else {
                    return Err("unsupported metadata enum shape".into());
                };
                let names: Vec<_> = fields
                    .named
                    .iter()
                    .map(|f| f.ident.as_ref().ok_or("unnamed metadata field"))
                    .collect::<Result<_, _>>()?;
                let variant = &variant.ident;
                arms.push(quote!(#wire::#variant {#(#names),*} => #public::#variant {#(#names),*}));
            }
            quote!(match parsed {#(#arms),*})
        }
        syn::Item::Struct(item) => {
            item.ident = wire.clone();
            item.vis = syn::Visibility::Inherited;
            item.attrs.retain(|a| !a.path().is_ident("doc"));
            let syn::Fields::Named(fields) = &item.fields else {
                return Err("unsupported metadata struct shape".into());
            };
            let names: Vec<_> = fields
                .named
                .iter()
                .map(|f| f.ident.as_ref().ok_or("unnamed metadata field"))
                .collect::<Result<_, _>>()?;
            quote!({let #wire {#(#names),*}=parsed;#public {#(#names),*}})
        }
        _ => return Err("unsupported metadata type".into()),
    };
    let attrs = match &mut file.items[index] {
        syn::Item::Enum(item) => &mut item.attrs,
        syn::Item::Struct(item) => &mut item.attrs,
        _ => return Err("unsupported metadata type".into()),
    };
    for attr in attrs.iter_mut().filter(|a| a.path().is_ident("derive")) {
        let paths = attr
            .parse_args_with(
                syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
            )
            .map_err(|e| e.to_string())?;
        let paths: Vec<_> = paths
            .into_iter()
            .filter(|p| !p.segments.last().is_some_and(|s| s.ident == "Deserialize"))
            .collect();
        *attr = syn::parse_quote!(#[derive(#(#paths),*)]);
    }
    let invalid = if read_only {
        quote!(has_call || !has_read)
    } else {
        quote!(has_call == has_read)
    };
    let implementation = syn::parse_quote! {
        impl<'de> ::serde::Deserialize<'de> for #public {
            fn deserialize<D>(deserializer:D)->::std::result::Result<Self,D::Error>
            where D: ::serde::Deserializer<'de> {
                let value=<::serde_json::Value as ::serde::Deserialize<'de>>::deserialize(deserializer)?;
                let object=value.as_object().ok_or_else(||<D::Error as ::serde::de::Error>::custom("expected authority metadata object"))?;
                let has_call=object.contains_key("capabilityCall");
                let has_read=object.contains_key("readOwner");
                if #invalid {return Err(<D::Error as ::serde::de::Error>::custom("expected exactly one reserved authority key"));}
                let parsed=<#wire as ::serde::Deserialize<'de>>::deserialize(value).map_err(<D::Error as ::serde::de::Error>::custom)?;
                Ok(#conversion)
            }
        }
    };
    file.items.push(shadow);
    file.items.push(implementation);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opposite_key_schema_must_be_prohibited_not_just_optional() {
        let valid = serde_json::json!({"required":["capabilityCall"],"properties":{"readOwner":{"not":{}}}});
        assert!(check_arm(&valid, "capabilityCall", "readOwner").is_ok());
        let optional = serde_json::json!({"required":["capabilityCall"],"properties":{"readOwner":{"type":"string"}}});
        assert!(check_arm(&optional, "capabilityCall", "readOwner").is_err());
    }
}
