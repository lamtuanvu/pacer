//! Generation-bound bootstrap receipt and helper activation.
use std::{
    future::Future,
    io,
    os::{fd::AsRawFd, unix::net::UnixStream},
    sync::Arc,
};
use tokio::{sync::Notify, task::JoinHandle, time::Instant};

pub(super) fn send(
    channel: &UnixStream,
    listener: &impl AsRawFd,
    remote: &UnixStream,
) -> io::Result<()> {
    use nix::sys::socket::{ControlMessage, MsgFlags, UnixAddr, sendmsg};
    let fds = [listener.as_raw_fd(), remote.as_raw_fd()];
    let sent = sendmsg::<UnixAddr>(
        channel.as_raw_fd(),
        &[io::IoSlice::new(b"B")],
        &[ControlMessage::ScmRights(&fds)],
        MsgFlags::MSG_DONTWAIT,
        None,
    )?;
    if sent != 1 {
        return Err(io::Error::other("native bootstrap transfer incomplete"));
    }
    Ok(())
}

struct Helpers(JoinHandle<()>);
impl Drop for Helpers {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Keep the sender's socket alive until Core confirms installed descriptors.
/// An unpolled broker owns its arguments and is dropped on every failed receipt.
pub(super) fn monitor<F>(
    parent: UnixStream,
    remote: UnixStream,
    broker: F,
    stop: Arc<Notify>,
    deadline: Instant,
) -> io::Result<JoinHandle<()>>
where
    F: Future<Output = ()> + Send + 'static,
{
    parent.set_nonblocking(true)?;
    let channel = tokio::net::UnixStream::from_std(parent)?;
    Ok(tokio::spawn(async move {
        let remote = remote;
        if Instant::now() >= deadline
            || !matches!(
                tokio::time::timeout_at(deadline, read(&channel)).await,
                Ok(Ok(b'A'))
            )
        {
            return;
        }
        drop(remote);
        let _helpers = Helpers(tokio::spawn(broker));
        // A and S may arrive together. Consume exactly one byte per phase;
        // ancillary data is rejected and every delivered descriptor is closed.
        if matches!(read(&channel).await, Ok(b'S')) {
            stop.notify_one();
        }
        // EOF, malformed control or cancellation drops the socket and broker.
    }))
}

async fn read(channel: &tokio::net::UnixStream) -> io::Result<u8> {
    loop {
        channel.readable().await?;
        let mut byte = [0];
        match channel.try_io(tokio::io::Interest::READABLE, || {
            super::native_helper::receive_nonblocking(channel, &mut byte)
        }) {
            Ok(1) => return Ok(byte[0]),
            Ok(_) => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
#[path = "native_bootstrap_tests.rs"]
mod tests;
