//! `isOffered` and `closestModels`. JavaScript compares strings by UTF-16 code
//! unit, so the shared prefix and the edit distance count code units too.
use crate::AvailableModels;

/// `None` means the runner's models are unknown, not that the model is absent.
pub fn is_offered(list: &AvailableModels, model: &str) -> Option<bool> {
    list.models
        .as_ref()
        .map(|models| models.iter().any(|m| m.id == model))
}

fn shared_prefix_len(a: &[u16], b: &[u16]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

fn levenshtein(a: &[u16], b: &[u16]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut next = Vec::with_capacity(b.len() + 1);
        next.push(i + 1);
        for (j, y) in b.iter().enumerate() {
            let substitute = prev[j] + usize::from(x != y);
            next.push((prev[j + 1] + 1).min(next[j] + 1).min(substitute));
        }
        prev = next;
    }
    prev[b.len()]
}

/// The `n` offered ids nearest to `model`: longest shared prefix first, then
/// smallest edit distance, keeping listing order on ties (a stable sort).
pub fn closest_models(list: &AvailableModels, model: &str, n: usize) -> Vec<String> {
    let Some(models) = &list.models else {
        return Vec::new();
    };
    let target: Vec<u16> = model.encode_utf16().collect();
    let mut ranked: Vec<(usize, usize, &str)> = models
        .iter()
        .filter(|m| m.id != model)
        .map(|m| {
            let id: Vec<u16> = m.id.encode_utf16().collect();
            (
                shared_prefix_len(&id, &target),
                levenshtein(&id, &target),
                m.id.as_str(),
            )
        })
        .collect();
    ranked.sort_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
    ranked
        .into_iter()
        .take(n)
        .map(|(_, _, id)| id.to_owned())
        .collect()
}
