//! Generation-bound bootstrap receipt and helper activation.
use std::{
    future::Future,
    io,
    os::{fd::AsRawFd, unix::net::UnixStream},
    sync::Arc,
};
use tokio::{sync::Notify, task::JoinHandle, time::Instant};

pub(super) fn send(channel: &UnixStream) -> io::Result<()> {
    use nix::sys::socket::{MsgFlags, UnixAddr, sendmsg};
    // DX1: the bootstrap receipt carries no descriptors — the native control
    // listener and helper broker are served in-process by the front door. Core
    // still authenticates the `B` marker before any secrets are written.
    let sent = sendmsg::<UnixAddr>(
        channel.as_raw_fd(),
        &[io::IoSlice::new(b"B")],
        &[],
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
/// `secrets` (Core's secrets frame) is written only after that confirmation,
/// which Core sends once it has authenticated this channel.
pub(super) fn monitor<F>(
    parent: UnixStream,
    remote: UnixStream,
    secrets: Vec<u8>,
    broker: F,
    stop: Arc<Notify>,
    deadline: Instant,
) -> io::Result<JoinHandle<()>>
where
    F: Future<Output = ()> + Send + 'static,
{
    use tokio::io::AsyncWriteExt;
    parent.set_nonblocking(true)?;
    let mut channel = tokio::net::UnixStream::from_std(parent)?;
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
        if !matches!(
            tokio::time::timeout_at(deadline, channel.write_all(&secrets)).await,
            Ok(Ok(()))
        ) {
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
#[path = "tests/native_bootstrap.rs"]
mod tests;
