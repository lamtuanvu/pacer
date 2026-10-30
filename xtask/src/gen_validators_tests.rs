#![allow(clippy::unwrap_used)]
use super::*;

fn fixture() -> syn::File {
    syn::parse_quote! {
        pub struct A(::std::string::String);
        pub struct B(::std::string::String);
        pub struct Different(::std::string::String);
        pub struct Unknown(::std::string::String);
        impl ::std::str::FromStr for A {
            fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
                if value.len() > 64 { return Err("Self  literal  must remain".into()); }
                Ok(Self(value.to_string()))
            }
        }
        impl ::std::str::FromStr for B {
            fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
                if value.len() > 64 { return Err("Self  literal  must remain".into()); }
                Ok(Self(value.to_string()))
            }
        }
        impl ::std::str::FromStr for Different {
            fn from_str(value: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
                if value.len() > 128 { return Err("Self  literal  must remain".into()); }
                Ok(Self(value.to_string()))
            }
        }
        impl ::std::str::FromStr for Unknown {
            fn from_str(other: &str) -> ::std::result::Result<Self, self::error::ConversionError> {
                Ok(Self(other.to_string()))
            }
        }
    }
}

#[test]
fn sharing_preserves_literal_bytes_distinct_bounds_and_unknown_signatures() {
    let mut file = fixture();
    share_string_validators(&mut file).unwrap();
    let code = prettyplease::unparse(&file);
    assert_eq!(code.matches("fn validate_string_").count(), 1);
    assert_eq!(code.matches("validate_string_0(value, Self)").count(), 2);
    assert_eq!(code.matches("Self  literal  must remain").count(), 2);
    assert!(code.contains("value.len() > 128"));
    assert!(code.contains("Ok(Self(other.to_string()))"));
    assert!(code.contains("Ok(construct(value.to_string()))"));
}

#[test]
fn different_error_literals_are_not_shared() {
    let mut file = fixture();
    let text = file.to_token_stream().to_string();
    // Alter only B's literal; every other validator remains distinct by bounds/signature.
    let index = text.find("impl :: std :: str :: FromStr for B").unwrap();
    let changed = format!(
        "{}{}",
        &text[..index],
        text[index..].replacen("Self  literal  must remain", "Self literal must remain", 1)
    );
    file = syn::parse_str(&changed).unwrap();
    share_string_validators(&mut file).unwrap();
    assert!(!prettyplease::unparse(&file).contains("fn validate_string_"));
}

#[test]
fn associated_self_or_unrecognized_constructor_is_not_moved() {
    for expression in [
        "Self::checked(value)",
        "Self(value.to_owned())",
        "Self::LIMIT",
    ] {
        let text = fixture()
            .to_token_stream()
            .to_string()
            .replace("Self (value . to_string ())", expression);
        let mut file = syn::parse_str(&text).unwrap();
        share_string_validators(&mut file).unwrap();
        assert!(!prettyplease::unparse(&file).contains("fn validate_string_"));
    }
}
