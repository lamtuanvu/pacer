//! `targetTier`, `tierBuckets` and `selectModel` (`src/dispatch/tier-select.ts`).
use serde_json::{Value, json};

use crate::candidates::{tier_at_least, tier_rank};
use crate::js::Object;

/// Anything with a model `tier`: inventory records and candidates.
pub trait Tiered {
    fn tier(&self) -> Option<&str>;
}

impl Tiered for Object {
    fn tier(&self) -> Option<&str> {
        self.get("tier").and_then(Value::as_str)
    }
}

impl<T: Tiered + ?Sized> Tiered for &T {
    fn tier(&self) -> Option<&str> {
        (**self).tier()
    }
}

/// `targetTier(difficulty, targets, minTier)`; `None` is TypeScript's `undefined`
/// target of a difficulty `targets` does not name.
pub fn target_tier<'a>(
    difficulty: &str,
    targets: &'a Value,
    min_tier: Option<&'a str>,
) -> Option<&'a str> {
    let target = targets.get(difficulty).and_then(Value::as_str);
    match (
        min_tier,
        min_tier.and_then(tier_rank),
        target.and_then(tier_rank),
    ) {
        (Some(min), Some(a), Some(b)) if a > b => Some(min),
        _ => target,
    }
}

/// `tierBuckets(items, target)`: the target tier and those above it, then
/// `unknown`, each in the caller's order.
pub fn tier_buckets<'a, T: Tiered>(items: &'a [T], target: Option<&str>) -> Vec<Vec<&'a T>> {
    let floor = target.and_then(tier_rank);
    ["small", "medium", "frontier"]
        .into_iter()
        .filter(|tier| floor.is_some_and(|floor| tier_rank(tier) >= Some(floor)))
        .chain(["unknown"])
        .map(|tier| items.iter().filter(|i| i.tier() == Some(tier)).collect())
        .collect()
}

/// `TierReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TierReason {
    TargetMatch,
    UpwardFallback,
    UnknownTierFallback,
    ExplicitOverride,
    ExecutorFixedBelowTarget,
    NoEligible,
}

impl TierReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TargetMatch => "target-match",
            Self::UpwardFallback => "upward-fallback",
            Self::UnknownTierFallback => "unknown-tier-fallback",
            Self::ExplicitOverride => "explicit-override",
            Self::ExecutorFixedBelowTarget => "executor-fixed-below-target",
            Self::NoEligible => "no-eligible",
        }
    }
}

/// The options of `selectModel`.
#[derive(Clone, Copy)]
pub struct SelectOptions<'a> {
    pub difficulty: &'a str,
    pub targets: &'a Value,
    pub min_tier: Option<&'a str>,
    pub pin: Option<&'a str>,
    pub fixed_executor: bool,
    /// Full model ID configured as the runner's default.
    pub default_model: Option<&'a str>,
    pub is_usable: Option<&'a dyn Fn(&Object) -> bool>,
}

/// `TierChoice`.
#[derive(Debug, Clone, PartialEq)]
pub struct TierChoice<'a> {
    pub record: Option<&'a Object>,
    pub target_tier: Option<&'a str>,
    pub selected_tier: Option<&'a str>,
    pub reason: TierReason,
}

impl TierChoice<'_> {
    /// The TypeScript object, without `targetTier` when it is `undefined`.
    pub fn to_json(&self) -> Value {
        let mut out = Object::new();
        out.insert(
            "record".into(),
            self.record
                .map_or(Value::Null, |r| Value::Object(r.clone())),
        );
        if let Some(target) = self.target_tier {
            out.insert("targetTier".into(), json!(target));
        }
        let selected = self.selected_tier.map_or(Value::Null, |tier| json!(tier));
        out.insert("selectedTier".into(), selected);
        out.insert("reason".into(), json!(self.reason.as_str()));
        Value::Object(out)
    }
}

fn exact_id(record: &Object) -> Option<&str> {
    let binding = record.get("binding")?;
    (binding.get("kind")? == "exact")
        .then(|| binding.get("id")?.as_str())
        .flatten()
}

/// `selectModel(records, options)`.
pub fn select_model<'a>(records: &'a [Object], o: &SelectOptions<'a>) -> TierChoice<'a> {
    let target = target_tier(o.difficulty, o.targets, o.min_tier);
    let choice = |record: Option<&'a Object>, reason: TierReason| TierChoice {
        record,
        target_tier: target,
        selected_tier: record.and_then(|r| r.tier()),
        reason: if record.is_some() {
            reason
        } else {
            TierReason::NoEligible
        },
    };
    let min = o.min_tier.map(|m| json!(m));
    let eligible: Vec<&'a Object> = records
        .iter()
        .filter(|r| min.is_none() || tier_at_least(r.get("tier"), min.as_ref()))
        .filter(|r| o.is_usable.is_none_or(|usable| usable(r)))
        .collect();
    if let Some(pin) = o.pin {
        let pinned = eligible.iter().copied().find(|r| exact_id(r) == Some(pin));
        return choice(pinned, TierReason::ExplicitOverride);
    }
    for bucket in tier_buckets(&eligible, target) {
        if let Some(&&record) = bucket.first()
            && record.tier() != Some("unknown")
        {
            let reason = if record.tier() == target {
                TierReason::TargetMatch
            } else {
                TierReason::UpwardFallback
            };
            return choice(Some(record), reason);
        }
    }
    if o.fixed_executor {
        let record = eligible
            .iter()
            .copied()
            .find(|r| o.default_model.is_some() && exact_id(r) == o.default_model)
            .or_else(|| {
                eligible
                    .iter()
                    .copied()
                    .find(|r| r["binding"]["kind"] == "executor-default")
            });
        return choice(record, TierReason::ExecutorFixedBelowTarget);
    }
    let unknown = eligible
        .iter()
        .copied()
        .find(|r| r.tier() == Some("unknown"));
    let reason = if unknown.is_some() {
        TierReason::UnknownTierFallback
    } else {
        TierReason::TargetMatch
    };
    choice(unknown, reason)
}
