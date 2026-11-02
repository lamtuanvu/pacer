//! Internal JavaScript-shaped YAML values. JSON cannot represent the numbers
//! accepted by Bun.YAML.parse; keep IEEE-754 values until the wire boundary.
use std::ops::{Index, IndexMut};
pub(crate) type Map<K, V> = indexmap::IndexMap<K, V>;

#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) enum Value {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Map<String, Value>),
}
impl Value {
    pub fn as_object(&self) -> Option<&Map<String, Value>> {
        if let Self::Object(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_object_mut(&mut self) -> Option<&mut Map<String, Value>> {
        if let Self::Object(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        if let Self::Array(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_array_mut(&mut self) -> Option<&mut Vec<Value>> {
        if let Self::Array(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Self::String(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if let Self::Number(v) = self {
            Some(*v)
        } else {
            None
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn is_number(&self) -> bool {
        matches!(self, Self::Number(_))
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?.get(key)
    }
    /// JSON.stringify maps every non-finite number to null, including nested ones.
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::Value as J;
        match self {
            Self::Null => J::Null,
            Self::Bool(v) => J::Bool(*v),
            Self::Number(v)
                if v.is_finite()
                    && v.fract() == 0.
                    && *v >= i64::MIN as f64
                    && *v < i64::MAX as f64 =>
            {
                J::from(*v as i64)
            }
            Self::Number(v) => J::from(*v),
            Self::String(v) => J::String(v.clone()),
            Self::Array(v) => J::Array(v.iter().map(Self::to_json).collect()),
            Self::Object(v) => J::Object(v.iter().map(|(k, v)| (k.clone(), v.to_json())).collect()),
        }
    }
    pub fn normalize(&mut self) {
        match self {
            Self::Array(values) => values.iter_mut().for_each(Self::normalize),
            Self::Object(map) => {
                let mut source = std::mem::take(map);
                source.values_mut().for_each(Self::normalize);
                let mut indices = source
                    .keys()
                    .filter_map(|key| {
                        key.parse::<u32>()
                            .ok()
                            .filter(|n| *n != u32::MAX && n.to_string() == *key)
                            .map(|n| (n, key.clone()))
                    })
                    .collect::<Vec<_>>();
                indices.sort_by_key(|(n, _)| *n);
                for (_, key) in indices {
                    if let Some(value) = source.shift_remove(&key) {
                        map.insert(key, value);
                    }
                }
                map.extend(source);
            }
            _ => {}
        }
    }
    pub fn number(&self) -> Option<f64> {
        self.as_f64()
    }
    pub fn integer(&self) -> Option<f64> {
        self.number().filter(|n| n.is_finite() && n.fract() == 0.)
    }
    pub fn safe_integer(&self) -> Option<f64> {
        self.integer().filter(|n| n.abs() <= 9_007_199_254_740_991.)
    }
    pub fn string(&self) -> String {
        match self {
            Self::String(s) => s.clone(),
            Self::Null => "null".into(),
            Self::Bool(v) => v.to_string(),
            Self::Number(v) => ryu_js::Buffer::new().format(*v).into(),
            Self::Object(_) => "[object Object]".into(),
            Self::Array(v) => v
                .iter()
                .map(|v| {
                    if v.is_null() {
                        String::new()
                    } else {
                        v.string()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
        }
    }
}
impl From<&serde_json::Value> for Value {
    fn from(v: &serde_json::Value) -> Self {
        use serde_json::Value as J;
        match v {
            J::Null => Self::Null,
            J::Bool(v) => Self::Bool(*v),
            J::Number(v) => Self::Number(v.as_f64().unwrap_or(f64::NAN)),
            J::String(v) => Self::String(v.clone()),
            J::Array(v) => Self::Array(v.iter().map(Self::from).collect()),
            J::Object(v) => {
                Self::Object(v.iter().map(|(k, v)| (k.clone(), Self::from(v))).collect())
            }
        }
    }
}
impl From<&Value> for Value {
    fn from(v: &Value) -> Self {
        v.clone()
    }
}
impl From<String> for Value {
    fn from(v: String) -> Self {
        Self::String(v)
    }
}
impl From<&String> for Value {
    fn from(v: &String) -> Self {
        Self::String(v.clone())
    }
}
impl From<&str> for Value {
    fn from(v: &str) -> Self {
        Self::String(v.into())
    }
}
impl From<bool> for Value {
    fn from(v: bool) -> Self {
        Self::Bool(v)
    }
}
impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(v: Option<T>) -> Self {
        v.map(Into::into).unwrap_or(Self::Null)
    }
}
impl<T: Into<Value>> From<Vec<T>> for Value {
    fn from(v: Vec<T>) -> Self {
        Self::Array(v.into_iter().map(Into::into).collect())
    }
}
impl From<&Vec<Value>> for Value {
    fn from(v: &Vec<Value>) -> Self {
        Self::Array(v.clone())
    }
}
impl From<Map<String, Value>> for Value {
    fn from(v: Map<String, Value>) -> Self {
        Self::Object(v)
    }
}
impl From<&Map<String, Value>> for Value {
    fn from(v: &Map<String, Value>) -> Self {
        Self::Object(v.clone())
    }
}
macro_rules! numbers { ($($t:ty),*) => {$(impl From<$t> for Value {fn from(v:$t)->Self {Self::Number(v as f64)}})*}; }
numbers!(f64, f32, i32, i64, u32, u64, usize);
impl PartialEq<str> for Value {
    fn eq(&self, v: &str) -> bool {
        self.as_str() == Some(v)
    }
}
impl PartialEq<&str> for Value {
    fn eq(&self, v: &&str) -> bool {
        self == *v
    }
}
impl PartialEq<String> for Value {
    fn eq(&self, v: &String) -> bool {
        self == v.as_str()
    }
}
impl PartialEq<bool> for &Value {
    fn eq(&self, v: &bool) -> bool {
        matches!(self, Value::Bool(b) if b==v)
    }
}
impl PartialEq<i32> for &Value {
    fn eq(&self, v: &i32) -> bool {
        self.as_f64() == Some(*v as f64)
    }
}
impl PartialEq<bool> for Value {
    fn eq(&self, v: &bool) -> bool {
        matches!(self, Self::Bool(b) if b==v)
    }
}
impl Index<&str> for Value {
    type Output = Value;
    fn index(&self, k: &str) -> &Value {
        self.get(k).unwrap_or(&Value::Null)
    }
}
impl IndexMut<&str> for Value {
    fn index_mut(&mut self, k: &str) -> &mut Value {
        if !self.is_object() {
            *self = Self::Object(Map::new());
        }
        match self {
            Self::Object(m) => m.entry(k.into()).or_default(),
            _ => unreachable!(),
        }
    }
}
impl std::fmt::Display for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.to_json().fmt(f)
    }
}

// The validation literals use string keys. Expressions convert directly rather
// than passing through serde_json::json!, which would erase non-finite numbers.
pub(crate) fn convert<T: Clone + Into<Value>>(v: &T) -> Value {
    v.clone().into()
}
macro_rules! value {
    (null) => { $crate::yaml_value::Value::Null };
    (@object $m:ident;) => {};
    (@object $m:ident; $k:literal : null $(, $($rest:tt)*)?) => { $m.insert($k.into(), $crate::yaml_value::Value::Null); $($crate::yaml_value::value!(@object $m; $($rest)*);)? };
    (@object $m:ident; $k:literal : {$($v:tt)*} $(, $($rest:tt)*)?) => { $m.insert($k.into(), $crate::yaml_value::value!({$($v)*})); $($crate::yaml_value::value!(@object $m; $($rest)*);)? };
    (@object $m:ident; $k:literal : [$($v:tt)*] $(, $($rest:tt)*)?) => { $m.insert($k.into(), $crate::yaml_value::value!([$($v)*])); $($crate::yaml_value::value!(@object $m; $($rest)*);)? };
    (@object $m:ident; $k:literal : $v:expr $(, $($rest:tt)*)?) => { $m.insert($k.into(), $crate::yaml_value::value!($v)); $($crate::yaml_value::value!(@object $m; $($rest)*);)? };
    (@array $a:ident;) => {};
    (@array $a:ident; {$($v:tt)*} $(, $($rest:tt)*)?) => { $a.push($crate::yaml_value::value!({$($v)*})); $($crate::yaml_value::value!(@array $a; $($rest)*);)? };
    (@array $a:ident; $v:expr $(, $($rest:tt)*)?) => { $a.push($crate::yaml_value::value!($v)); $($crate::yaml_value::value!(@array $a; $($rest)*);)? };
    ({}) => { $crate::yaml_value::Value::Object($crate::yaml_value::Map::new()) };
    ({$($v:tt)+}) => {{ let mut m=$crate::yaml_value::Map::new(); $crate::yaml_value::value!(@object m; $($v)+); $crate::yaml_value::Value::Object(m) }};
    ([]) => { $crate::yaml_value::Value::Array(Vec::new()) };
    ([$($v:tt)+]) => {{ let mut a=Vec::new(); $crate::yaml_value::value!(@array a; $($v)+); $crate::yaml_value::Value::Array(a) }};
    ($v:expr) => { $crate::yaml_value::convert(&$v) };
}
pub(crate) use value;
