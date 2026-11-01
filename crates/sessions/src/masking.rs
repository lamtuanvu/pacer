//! Byte-exact streaming masker matching `src/session/masking.ts`.
pub struct SecretMasker {
    secrets: Vec<Vec<u8>>,
    max_len: usize,
    tail: Vec<u8>,
}

impl SecretMasker {
    pub fn new(values: &[String]) -> Self {
        let mut unique: Vec<&String> = Vec::new();
        for value in values {
            if value.chars().count() >= 8 && !unique.contains(&value) {
                unique.push(value);
            }
        }
        let mut secrets: Vec<Vec<u8>> = unique.into_iter().map(|s| s.as_bytes().to_vec()).collect();
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        let max_len = secrets.first().map_or(0, Vec::len);
        Self {
            secrets,
            max_len,
            tail: Vec::new(),
        }
    }

    pub fn push(&mut self, data: &[u8]) -> Vec<u8> {
        if self.secrets.is_empty() {
            return data.to_vec();
        }
        self.tail.extend_from_slice(data);
        self.consume(false)
    }

    pub fn flush(&mut self) -> Vec<u8> {
        self.consume(true)
    }

    fn consume(&mut self, final_chunk: bool) -> Vec<u8> {
        let end = if final_chunk {
            self.tail.len()
        } else {
            self.tail
                .len()
                .saturating_sub(self.max_len.saturating_sub(1))
        };
        let mut out = Vec::new();
        let mut pos = 0;
        while pos < end {
            let mut found: Option<(usize, usize)> = None;
            for secret in &self.secrets {
                if let Some(index) = self.tail[pos..]
                    .windows(secret.len())
                    .position(|w| w == secret)
                {
                    let at = pos + index;
                    if found.is_none_or(|(first, _)| at < first) {
                        found = Some((at, secret.len()));
                    }
                }
            }
            match found {
                Some((at, len)) if at < end => {
                    out.extend_from_slice(&self.tail[pos..at]);
                    out.extend_from_slice(b"****");
                    pos = at + len;
                }
                _ => {
                    out.extend_from_slice(&self.tail[pos..end]);
                    pos = end;
                }
            }
        }
        self.tail.drain(..pos);
        out
    }
}
