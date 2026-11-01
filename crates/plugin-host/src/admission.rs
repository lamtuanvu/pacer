use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use thiserror::Error;
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    time::{Instant, timeout_at},
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AdmissionError {
    #[error("plugin registry call capacity exhausted")]
    Capacity,
    #[error("plugin call expired before admission")]
    Timeout,
    #[error("owning plugin call ended")]
    Cancelled,
}

/// FIFO admission matches the TypeScript registry's eight active and 32 queued calls.
/// Each waiter keeps its original absolute deadline; a dropped waiter frees its slot.
pub struct CallAdmission {
    slots: Arc<Semaphore>,
    limit: usize,
    queued: AtomicUsize,
    queue_limit: usize,
}

impl Default for CallAdmission {
    fn default() -> Self {
        Self::new(8, 32)
    }
}

impl CallAdmission {
    pub fn new(limit: usize, queue_limit: usize) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(limit)),
            limit,
            queued: AtomicUsize::new(0),
            queue_limit,
        }
    }

    pub fn active_count(&self) -> usize {
        self.limit.saturating_sub(self.slots.available_permits())
    }
    pub fn queued_count(&self) -> usize {
        self.queued.load(Ordering::Acquire)
    }

    pub async fn acquire(
        &self,
        deadline: Instant,
        owner: Option<&watch::Receiver<bool>>,
    ) -> Result<OwnedSemaphorePermit, AdmissionError> {
        if Instant::now() >= deadline {
            return Err(AdmissionError::Timeout);
        }
        if owner.is_some_and(|signal| *signal.borrow()) {
            return Err(AdmissionError::Cancelled);
        }
        if let Ok(permit) = self.slots.clone().try_acquire_owned() {
            return Ok(permit);
        }
        let reserved = self
            .queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < self.queue_limit).then_some(count + 1)
            });
        if reserved.is_err() {
            return Err(AdmissionError::Capacity);
        }
        struct Reservation<'a>(&'a AtomicUsize);
        impl Drop for Reservation<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let _reservation = Reservation(&self.queued);
        if let Some(owner) = owner {
            let mut owner = owner.clone();
            tokio::select! {
                result = timeout_at(deadline, self.slots.clone().acquire_owned()) => result.map_err(|_| AdmissionError::Timeout)?.map_err(|_| AdmissionError::Cancelled),
                _ = owner.changed() => Err(AdmissionError::Cancelled),
            }
        } else {
            timeout_at(deadline, self.slots.clone().acquire_owned())
                .await
                .map_err(|_| AdmissionError::Timeout)?
                .map_err(|_| AdmissionError::Cancelled)
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[tokio::test]
    async fn bounded_queue_deadline_and_owner_cancellation() {
        let pool = CallAdmission::new(1, 1);
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        let active = pool.acquire(deadline, None).await.unwrap();
        let (sender, receiver) = watch::channel(false);
        let queued = pool.acquire(deadline, Some(&receiver));
        tokio::pin!(queued);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut queued)
                .await
                .is_err()
        );
        assert_eq!(pool.queued_count(), 1);
        assert!(matches!(
            pool.acquire(deadline, None).await,
            Err(AdmissionError::Capacity)
        ));
        sender.send(true).unwrap();
        assert!(matches!(queued.await, Err(AdmissionError::Cancelled)));
        assert_eq!(pool.queued_count(), 0);
        drop(active);
        assert!(pool.acquire(deadline, None).await.is_ok());
        assert!(matches!(
            pool.acquire(Instant::now(), None).await,
            Err(AdmissionError::Timeout)
        ));
    }
}
