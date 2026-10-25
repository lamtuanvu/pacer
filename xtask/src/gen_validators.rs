use quote::ToTokens;

/// Keep public newtypes distinct while sharing identical validation work. In particular,
/// aliases would change derived Debug names and make unrelated wire fields assignable.
pub(super) fn share_string_validators(file: &mut syn::File) -> Result<(), String> {
    use std::collections::{BTreeMap, BTreeSet};
    let strings: BTreeSet<String> = file
        .items
        .iter()
        .filter_map(|item| {
            let syn::Item::Struct(item) = item else {
                return None;
            };
            let syn::Fields::Unnamed(fields) = &item.fields else {
                return None;
            };
            if fields.unnamed.len() != 1 {
                return None;
            }
            let field = fields.unnamed.first()?;
            (matches!(field.vis, syn::Visibility::Inherited)
                && field.ty.to_token_stream().to_string().replace(' ', "")
                    == "::std::string::String")
                .then(|| item.ident.to_string())
        })
        .collect();
    let mut groups: BTreeMap<String, Vec<(usize, usize)>> = BTreeMap::new();
    for (index, item) in file.items.iter().enumerate() {
        let syn::Item::Impl(item) = item else {
            continue;
        };
        let Some((_, path, _)) = &item.trait_ else {
            continue;
        };
        if !path.segments.last().is_some_and(|s| s.ident == "FromStr")
            || !strings.contains(&item.self_ty.to_token_stream().to_string())
        {
            continue;
        }
        for (method_index, method) in item.items.iter().enumerate() {
            let syn::ImplItem::Fn(method) = method else {
                continue;
            };
            let expected: syn::Signature = syn::parse_quote!(
                fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError>
            );
            if method.sig.to_token_stream().to_string() == expected.to_token_stream().to_string() {
                groups
                    .entry(method.block.to_token_stream().to_string())
                    .or_default()
                    .push((index, method_index));
            }
        }
    }
    for (number, (_body_key, methods)) in
        groups.into_iter().filter(|(_, m)| m.len() > 1).enumerate()
    {
        let helper = quote::format_ident!("validate_string_{number}");
        let (index, method_index) = methods[0];
        let syn::Item::Impl(item) = &file.items[index] else {
            unreachable!()
        };
        let syn::ImplItem::Fn(method) = &item.items[method_index] else {
            unreachable!()
        };
        let mut body = method.block.clone();
        let mut constructor = Constructor::default();
        syn::visit_mut::VisitMut::visit_block_mut(&mut constructor, &mut body);
        if constructor.unsupported || constructor.count != 1 {
            continue;
        }
        let shared: syn::Item = syn::parse_quote! {
            fn #helper<T>(value: &str, construct: impl FnOnce(::std::string::String) -> T)
                -> ::std::result::Result<T, self::error::ConversionError> #body
        };
        for (index, method_index) in methods {
            let syn::Item::Impl(item) = &mut file.items[index] else {
                unreachable!()
            };
            let syn::ImplItem::Fn(method) = &mut item.items[method_index] else {
                unreachable!()
            };
            method.block = syn::parse_quote!({ #helper(value, Self) });
        }
        file.items.push(shared);
    }
    share_deserializers(file, &strings);
    Ok(())
}

// Accept exactly the constructor shape typify emits. Other Self uses/macros are
// left untouched rather than being interpreted outside their original type context.
#[derive(Default)]
struct Constructor {
    count: usize,
    unsupported: bool,
}
impl syn::visit_mut::VisitMut for Constructor {
    fn visit_expr_call_mut(&mut self, call: &mut syn::ExprCall) {
        if let syn::Expr::Path(path) = &mut *call.func
            && path.path.is_ident("Self")
        {
            let expected: syn::Expr = syn::parse_quote!(value.to_string());
            if call.args.len() == 1
                && call.args[0].to_token_stream().to_string()
                    == expected.to_token_stream().to_string()
            {
                path.path = syn::parse_quote!(construct);
                self.count += 1;
            }
        }
        syn::visit_mut::visit_expr_call_mut(self, call);
    }
    fn visit_path_mut(&mut self, path: &mut syn::Path) {
        if path.segments.first().is_some_and(|s| s.ident == "Self") {
            self.unsupported = true;
        }
        syn::visit_mut::visit_path_mut(self, path);
    }
    fn visit_macro_mut(&mut self, _mac: &mut syn::Macro) {
        self.unsupported = true;
    }
}

fn share_deserializers(file: &mut syn::File, strings: &std::collections::BTreeSet<String>) {
    let expected: syn::ImplItemFn = syn::parse_quote! {
        fn deserialize<D>(deserializer: D,) -> ::std::result::Result<Self, D::Error>
        where D: ::serde::Deserializer<'de>, {
            ::std::string::String::deserialize(deserializer)?.parse()
                .map_err(|e: self::error::ConversionError| {
                    <D::Error as ::serde::de::Error>::custom(e.to_string(),)
                })
        }
    };
    let expected_tokens = expected.to_token_stream().to_string();
    let mut count = 0;
    for item in &mut file.items {
        let syn::Item::Impl(item) = item else {
            continue;
        };
        if !strings.contains(&item.self_ty.to_token_stream().to_string()) {
            continue;
        }
        if !item
            .trait_
            .as_ref()
            .is_some_and(|(_, p, _)| p.segments.last().is_some_and(|s| s.ident == "Deserialize"))
        {
            continue;
        }
        for method in &mut item.items {
            let syn::ImplItem::Fn(method) = method else {
                continue;
            };
            if method.to_token_stream().to_string() == expected_tokens {
                method.block = syn::parse_quote!({ deserialize_validated_string(deserializer) });
                count += 1;
            }
        }
    }
    if count > 0 {
        file.items.push(syn::parse_quote! {
            fn deserialize_validated_string<'de, D, T>(deserializer: D) -> ::std::result::Result<T, D::Error>
            where D: ::serde::Deserializer<'de>, T: ::std::str::FromStr<Err = self::error::ConversionError> {
                <::std::string::String as ::serde::Deserialize<'de>>::deserialize(deserializer)?.parse()
                    .map_err(|e: self::error::ConversionError| {
                        <D::Error as ::serde::de::Error>::custom(e.to_string(),)
                    })
            }
        });
    }
}

#[cfg(test)]
#[path = "gen_validators_tests.rs"]
mod tests;
