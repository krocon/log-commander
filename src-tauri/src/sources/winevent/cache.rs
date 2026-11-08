//! The provider metadata cache (prompt 018): `EvtFormatMessage` needs the metadata of the event's
//! provider, and opening it (`EvtOpenPublisherMetadata`, it loads the message files) is the
//! expensive part. Per provider it is opened once and kept; a provider without metadata is
//! remembered too (and asked again after a while, it may be installed meanwhile). The number of
//! entries is bounded, the least recently used one goes. Plain Rust, the value type is whatever the
//! platform keeps (a handle that closes on drop on Windows).

use std::time::{Duration, Instant};

/// Providers kept at a time (a busy System channel has a few hundred).
pub const MAX_PROVIDERS: usize = 512;
/// A provider without metadata is asked again after this long.
pub const RETRY_MISSING: Duration = Duration::from_secs(300);

struct Entry<V> {
    name: String,
    value: Option<V>,
    since: Instant,
    used: u64,
}

pub struct MetadataCache<V> {
    entries: Vec<Entry<V>>,
    max: usize,
    retry: Duration,
    tick: u64,
    /// Openings so far (tests, status).
    pub opened: u64,
}

impl<V> MetadataCache<V> {
    pub fn new(max: usize, retry: Duration) -> Self {
        Self {
            entries: Vec::new(),
            max: max.max(1),
            retry,
            tick: 0,
            opened: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The metadata of `name` (case-insensitive like Windows), opened with `open` if not known or
    /// if a missing one is due again. `None`: the provider has none.
    pub fn get(
        &mut self,
        name: &str,
        now: Instant,
        open: impl FnOnce() -> Option<V>,
    ) -> Option<&V> {
        self.tick += 1;
        let tick = self.tick;
        let found = self
            .entries
            .iter()
            .position(|e| e.name.eq_ignore_ascii_case(name));
        let index = match found {
            Some(i)
                if self.entries[i].value.is_some() || now < self.entries[i].since + self.retry =>
            {
                i
            }
            Some(i) => {
                self.opened += 1;
                let e = &mut self.entries[i];
                e.value = open();
                e.since = now;
                i
            }
            None => {
                if self.entries.len() >= self.max {
                    let oldest = self
                        .entries
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, e)| e.used)
                        .map(|(i, _)| i)
                        .unwrap_or(0);
                    self.entries.swap_remove(oldest);
                }
                self.opened += 1;
                self.entries.push(Entry {
                    name: name.to_string(),
                    value: open(),
                    since: now,
                    used: tick,
                });
                self.entries.len() - 1
            }
        };
        let e = &mut self.entries[index];
        e.used = tick;
        e.value.as_ref()
    }

    /// Everything goes (a new session: the old handles belong to the old one).
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_each_provider_once_and_bounds_the_entries() {
        let mut cache = MetadataCache::new(2, RETRY_MISSING);
        let now = Instant::now();
        assert_eq!(cache.get("A", now, || Some(1)), Some(&1));
        assert_eq!(cache.get("a", now, || Some(99)), Some(&1));
        assert_eq!(cache.get("B", now, || Some(2)), Some(&2));
        assert_eq!(cache.opened, 2);
        // A is used again, so B is the least recently used one and goes for C.
        cache.get("A", now, || unreachable!());
        cache.get("C", now, || Some(3));
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("A", now, || Some(9)), Some(&1));
        assert_eq!(cache.get("B", now, || Some(4)), Some(&4));
        assert_eq!(cache.opened, 4);
    }

    #[test]
    fn a_missing_provider_is_asked_again_later() {
        let mut cache: MetadataCache<u32> = MetadataCache::new(8, Duration::from_secs(60));
        let now = Instant::now();
        assert_eq!(cache.get("Gone", now, || None), None);
        assert_eq!(
            cache.get("Gone", now + Duration::from_secs(59), || Some(1)),
            None
        );
        assert_eq!(cache.opened, 1);
        assert_eq!(
            cache.get("Gone", now + Duration::from_secs(61), || Some(1)),
            Some(&1)
        );
        assert_eq!(cache.opened, 2);
        cache.clear();
        assert!(cache.is_empty());
    }
}
