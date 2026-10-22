//! One nonrenewing budget for a read-only authenticated context exchange.
use super::OtaError;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

pub(super) fn retry<T>(
    deadline: Instant,
    now: impl Fn() -> Instant,
    pause: impl Fn(Duration),
    mut attempt: impl FnMut(Instant) -> Result<T, OtaError>,
) -> Result<T, OtaError> {
    loop {
        if now() >= deadline {
            return Err(OtaError::Timeout);
        }
        let result = attempt(deadline);
        let observed = now();
        if observed >= deadline {
            return Err(OtaError::Timeout);
        }
        match result {
            Err(OtaError::Io | OtaError::Unavailable) => {
                pause((deadline - observed).min(super::super::OBSERVATION_INTERVAL));
            }
            other => return other,
        }
    }
}

pub(super) fn remaining(deadline: Instant) -> Result<Duration, OtaError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or(OtaError::Timeout)
}
pub(super) fn read_exact(
    stream: &mut UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), OtaError> {
    while !bytes.is_empty() {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| OtaError::Io)?;
        let count = stream.read(bytes).map_err(|_| OtaError::Io)?;
        if count == 0 {
            return Err(OtaError::Io);
        }
        bytes = &mut bytes[count..];
    }
    remaining(deadline)?;
    Ok(())
}
pub(super) fn write_all(
    stream: &mut UnixStream,
    mut bytes: &[u8],
    deadline: Instant,
) -> Result<(), OtaError> {
    while !bytes.is_empty() {
        stream
            .set_write_timeout(Some(remaining(deadline)?))
            .map_err(|_| OtaError::Io)?;
        let count = stream.write(bytes).map_err(|_| OtaError::Io)?;
        if count == 0 {
            return Err(OtaError::Io);
        }
        bytes = &bytes[count..];
    }
    remaining(deadline)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn response_io_retries_complete_read_only_exchange() {
        let start = Instant::now();
        let clock = Cell::new(start);
        let calls = Cell::new(0);
        let result = retry(
            start + Duration::from_secs(10),
            || clock.get(),
            |d| clock.set(clock.get() + d),
            |_| {
                calls.set(calls.get() + 1);
                let (mut client, mut server) = UnixStream::pair().unwrap();
                write_all(&mut client, b"context", start + Duration::from_secs(10))?;
                let mut request = [0; 7];
                read_exact(&mut server, &mut request, start + Duration::from_secs(10))?;
                assert_eq!(&request, b"context");
                if calls.get() == 1 {
                    drop(server);
                    let mut reply = [0; 2];
                    read_exact(&mut client, &mut reply, start + Duration::from_secs(10))?;
                } else {
                    write_all(&mut server, b"ok", start + Duration::from_secs(10))?;
                    let mut reply = [0; 2];
                    read_exact(&mut client, &mut reply, start + Duration::from_secs(10))?;
                    assert_eq!(&reply, b"ok");
                }
                Ok(())
            },
        );
        assert_eq!(result, Ok(()));
        assert_eq!(calls.get(), 2);
    }
    #[test]
    fn identity_and_invalid_are_not_retried() {
        for error in [OtaError::Identity, OtaError::Invalid] {
            let calls = Cell::new(0);
            let result: Result<(), _> = retry(
                Instant::now() + Duration::from_secs(1),
                Instant::now,
                |_| panic!("no pause"),
                |_| {
                    calls.set(calls.get() + 1);
                    Err(error.clone())
                },
            );
            assert_eq!(result, Err(error));
            assert_eq!(calls.get(), 1);
        }
    }
    #[test]
    fn all_attempts_and_pauses_share_one_clock_budget() {
        let start = Instant::now();
        let deadline = start + Duration::from_millis(250);
        let clock = Cell::new(start);
        let calls = Cell::new(0);
        let result: Result<(), _> = retry(
            deadline,
            || clock.get(),
            |d| {
                assert!(clock.get() + d <= deadline);
                clock.set(clock.get() + d)
            },
            |observed| {
                assert_eq!(observed, deadline);
                calls.set(calls.get() + 1);
                clock.set((clock.get() + Duration::from_millis(90)).min(deadline));
                Err(OtaError::Unavailable)
            },
        );
        assert_eq!(result, Err(OtaError::Timeout));
        assert!(calls.get() >= 1);
        assert!(clock.get() <= deadline);
    }
    #[test]
    fn late_success_is_refused_and_expired_budget_never_attempts() {
        let start = Instant::now();
        let clock = Cell::new(start);
        let result = retry(
            start + Duration::from_millis(1),
            || clock.get(),
            |_| panic!(),
            |_| {
                clock.set(start + Duration::from_millis(2));
                Ok(())
            },
        );
        assert_eq!(result, Err(OtaError::Timeout));
        let result: Result<(), _> =
            retry(start, || start, |_| panic!(), |_| panic!("expired attempt"));
        assert_eq!(result, Err(OtaError::Timeout));
    }
    #[test]
    fn expired_io_budget_refuses_without_blocking() {
        let (mut stream, _peer) = UnixStream::pair().unwrap();
        let deadline = Instant::now();
        assert_eq!(
            read_exact(&mut stream, &mut [0], deadline),
            Err(OtaError::Timeout)
        );
        assert_eq!(
            write_all(&mut stream, b"x", deadline),
            Err(OtaError::Timeout)
        );
    }
}
