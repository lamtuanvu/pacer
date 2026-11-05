//! Private authoritative document: exact UTF-16 strings and keys, members in
//! insertion order, and value-owned projection boundaries. Every traversal
//! here keeps its own heap stack, so input depth never reaches the Rust stack.
use serde_json::{Map, Number, Value};
use std::cell::Cell;

pub(crate) type Units = Vec<u16>;

/// Invariant: an object never holds two members with equal key units.
pub(crate) struct Node {
    pub(crate) kind: Kind,
    /// Root of a subtree withheld from the preview. It never affects content,
    /// rendering, exact lookups or comparison.
    pub(crate) opaque: bool,
}

pub(crate) enum Kind {
    Null,
    Bool(bool),
    /// Exactly the serde Number the scalar parser yields.
    Number(Number),
    /// A finite-grammar number whose binary64 value is infinite. Renders null.
    Overflow {
        negative: bool,
    },
    String(Units),
    Array(Vec<Node>),
    Object(Vec<(Units, Node)>),
}

impl Node {
    pub(crate) fn new(kind: Kind) -> Self {
        Self {
            kind,
            opaque: false,
        }
    }

    fn take_children(&mut self, out: &mut Vec<Node>) {
        match &mut self.kind {
            Kind::Array(items) => out.append(items),
            Kind::Object(members) => out.extend(members.drain(..).map(|(_, node)| node)),
            _ => {}
        }
    }

    /// Build all-visible nodes from a borrowed Value.
    pub(crate) fn from_value(value: &Value) -> Self {
        rebuild(
            value,
            |value: &Value| match value {
                Value::Null => Visit::Leaf(Node::new(Kind::Null)),
                Value::Bool(b) => Visit::Leaf(Node::new(Kind::Bool(*b))),
                Value::Number(n) => Visit::Leaf(Node::new(Kind::Number(n.clone()))),
                Value::String(s) => {
                    Visit::Leaf(Node::new(Kind::String(s.encode_utf16().collect())))
                }
                Value::Array(items) => Visit::Array(Box::new(items.iter()), false),
                Value::Object(map) => Visit::Object(
                    Box::new(map.iter().map(|(k, v)| (k.encode_utf16().collect(), v))),
                    false,
                ),
            },
            node_array,
            node_object,
        )
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        let mut stack = Vec::new();
        self.take_children(&mut stack);
        while let Some(mut node) = stack.pop() {
            node.take_children(&mut stack);
        }
    }
}

impl Clone for Node {
    fn clone(&self) -> Self {
        rebuild(
            self,
            |node: &Node| {
                let leaf = |kind| {
                    Visit::Leaf(Node {
                        kind,
                        opaque: node.opaque,
                    })
                };
                match &node.kind {
                    Kind::Null => leaf(Kind::Null),
                    Kind::Bool(b) => leaf(Kind::Bool(*b)),
                    Kind::Number(n) => leaf(Kind::Number(n.clone())),
                    Kind::Overflow { negative } => leaf(Kind::Overflow {
                        negative: *negative,
                    }),
                    Kind::String(units) => leaf(Kind::String(units.clone())),
                    Kind::Array(items) => Visit::Array(Box::new(items.iter()), node.opaque),
                    Kind::Object(members) => Visit::Object(
                        Box::new(members.iter().map(|(k, n)| (k.clone(), n))),
                        node.opaque,
                    ),
                }
            },
            node_array,
            node_object,
        )
    }
}

fn node_array(items: Vec<Node>, opaque: bool) -> Node {
    Node {
        kind: Kind::Array(items),
        opaque,
    }
}

fn node_object(members: Vec<(Units, Node)>, opaque: bool) -> Node {
    Node {
        kind: Kind::Object(members),
        opaque,
    }
}

/// The cached preview of a document and what it withholds.
pub(crate) struct Projection {
    pub(crate) value: Value,
    /// The effective projection loses content (§4.4 `preview_omits`).
    pub(crate) omits: bool,
    /// A projected string value holds a lone surrogate.
    pub(crate) lossy: bool,
}

/// Opaque nodes become null without descent; Overflow becomes null; members
/// whose key is not scalar text are omitted; lone-surrogate strings are lossy.
pub(crate) fn project(root: &Node) -> Projection {
    let omits = Cell::new(false);
    let lossy = Cell::new(false);
    let value = rebuild(
        root,
        |node: &Node| {
            if node.opaque {
                if !matches!(node.kind, Kind::Null | Kind::Overflow { .. }) {
                    omits.set(true);
                }
                return Visit::Leaf(Value::Null);
            }
            match &node.kind {
                Kind::Null | Kind::Overflow { .. } => Visit::Leaf(Value::Null),
                Kind::Bool(b) => Visit::Leaf(Value::Bool(*b)),
                Kind::Number(n) => Visit::Leaf(Value::Number(n.clone())),
                Kind::String(units) => Visit::Leaf(Value::String(
                    String::from_utf16(units).unwrap_or_else(|_| {
                        lossy.set(true);
                        String::from_utf16_lossy(units)
                    }),
                )),
                Kind::Array(items) => Visit::Array(Box::new(items.iter()), ()),
                Kind::Object(members) => Visit::Object(
                    Box::new(members.iter().filter_map(|(key, node)| {
                        let key = String::from_utf16(key).ok();
                        if key.is_none() {
                            omits.set(true);
                        }
                        key.map(|key| (key, node))
                    })),
                    (),
                ),
            }
        },
        |items, ()| Value::Array(items),
        |members, ()| Value::Object(members.into_iter().collect()),
    );
    Projection {
        value,
        omits: omits.get(),
        lossy: lossy.get(),
    }
}

/// Clone a Value without recursing on its depth.
pub(crate) fn clone_value(value: &Value) -> Value {
    rebuild(
        value,
        |value: &Value| match value {
            Value::Array(items) => Visit::Array(Box::new(items.iter()), ()),
            Value::Object(map) => {
                Visit::Object(Box::new(map.iter().map(|(k, v)| (k.clone(), v))), ())
            }
            scalar => Visit::Leaf(scalar.clone()),
        },
        |items, ()| Value::Array(items),
        |members, ()| Value::Object(members.into_iter().collect::<Map<_, _>>()),
    )
}

/// Drop a Value without recursing on its depth (serde's own drop recurses).
pub(crate) fn dispose(value: Value) {
    let mut stack = vec![value];
    while let Some(mut value) = stack.pop() {
        match &mut value {
            Value::Array(items) => stack.append(items),
            Value::Object(map) => stack.extend(std::mem::take(map).into_iter().map(|(_, v)| v)),
            _ => {}
        }
    }
}

/// How `rebuild` treats one source node: a finished leaf, or a container whose
/// children are visited in order and then finished with its tag.
pub(crate) enum Visit<'a, S, K, T, X> {
    Leaf(T),
    Array(Box<dyn Iterator<Item = &'a S> + 'a>, X),
    Object(Box<dyn Iterator<Item = (K, &'a S)> + 'a>, X),
}

enum Frame<'a, S, K, T, X> {
    Array {
        items: Box<dyn Iterator<Item = &'a S> + 'a>,
        out: Vec<T>,
        tag: X,
    },
    Object {
        members: Box<dyn Iterator<Item = (K, &'a S)> + 'a>,
        out: Vec<(K, T)>,
        key: Option<K>,
        tag: X,
    },
}

impl<'a, S, K, T, X> Frame<'a, S, K, T, X> {
    fn next_child(&mut self) -> Option<&'a S> {
        match self {
            Self::Array { items, .. } => items.next(),
            Self::Object { members, key, .. } => members.next().map(|(k, child)| {
                *key = Some(k);
                child
            }),
        }
    }

    fn attach(&mut self, value: T) {
        match self {
            Self::Array { out, .. } => out.push(value),
            Self::Object { out, key, .. } => {
                if let Some(key) = key.take() {
                    out.push((key, value));
                }
            }
        }
    }
}

/// Post-order rebuild of a tree with an explicit heap stack of open containers.
pub(crate) fn rebuild<'a, S, K, T, X>(
    root: &'a S,
    mut visit: impl FnMut(&'a S) -> Visit<'a, S, K, T, X>,
    mut array: impl FnMut(Vec<T>, X) -> T,
    mut object: impl FnMut(Vec<(K, T)>, X) -> T,
) -> T {
    let open = |visit: Visit<'a, S, K, T, X>| match visit {
        Visit::Leaf(value) => Ok(value),
        Visit::Array(items, tag) => Err(Frame::Array {
            items,
            out: Vec::new(),
            tag,
        }),
        Visit::Object(members, tag) => Err(Frame::Object {
            members,
            out: Vec::new(),
            key: None,
            tag,
        }),
    };
    let mut top = match open(visit(root)) {
        Ok(leaf) => return leaf,
        Err(frame) => frame,
    };
    let mut parents = Vec::new();
    loop {
        if let Some(child) = top.next_child() {
            match open(visit(child)) {
                Ok(leaf) => top.attach(leaf),
                Err(frame) => parents.push(std::mem::replace(&mut top, frame)),
            }
            continue;
        }
        let built = match top {
            Frame::Array { out, tag, .. } => array(out, tag),
            Frame::Object { out, tag, .. } => object(out, tag),
        };
        match parents.pop() {
            Some(parent) => {
                top = parent;
                top.attach(built);
            }
            None => return built,
        }
    }
}
