//! A small mDNS responder and browser for one service type, `_pacer._udp.local.`, over IPv4 on one
//! interface (SEC-11). It answers only multicast queries from on-link sources, always by
//! multicast, and accepts responses only from on-link sources. IPv6 is not supported.
//!
//! There is no probing or conflict resolution (RFC 6762 §8.1, §9) for `<id>.local.` and
//! `<id>._pacer._udp.local.`: the ids are 130-bit random, so an accidental clash is negligible, and
//! an on-link host squatting a name can only fake presence, which the threat model already allows.
mod engine;
mod service;
mod socket;
pub mod wire;

pub use engine::{Engine, Handled, Interface};
pub use service::{Advert, HOST_TTL, Resolved, SERVICE, SERVICE_TTL, browse_query};
pub use socket::MulticastSocket;

use std::{
    fmt, io,
    net::{Ipv4Addr, SocketAddrV4},
    sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError},
    thread::JoinHandle,
    time::{Duration, Instant},
};

pub const MDNS_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
pub const MDNS_PORT: u16 = 5353;
/// How long the responder thread waits for a packet before it checks for commands.
const TICK: Duration = Duration::from_millis(200);
const EVENTS_MAX: usize = 256;

/// Whether `src` is on the link of `addr`/`mask`: inside the subnet or IPv4 link-local
/// (169.254.0.0/16), and not a multicast, limited broadcast or unspecified address.
pub fn on_link(src: Ipv4Addr, addr: Ipv4Addr, mask: Ipv4Addr) -> bool {
    let usable = !(src.is_unspecified() || src.is_broadcast() || src.is_multicast());
    let subnet = u32::from(src) & u32::from(mask) == u32::from(addr) & u32::from(mask);
    usable && (subnet || src.is_link_local())
}

/// A netmask of contiguous one bits, neither empty nor full.
pub fn valid_netmask(mask: Ipv4Addr) -> bool {
    let bits = u32::from(mask);
    bits != 0 && bits != u32::MAX && bits.leading_ones() + bits.trailing_zeros() == 32
}

/// Sends and receives mDNS packets on one link. Sends always go to 224.0.0.251:5353.
pub trait Transport: Send + 'static {
    fn send(&self, packet: &[u8]) -> io::Result<()>;
    /// Waits up to `timeout`; `None` when nothing arrived.
    fn recv(&self, buf: &mut [u8], timeout: Duration) -> io::Result<Option<(usize, SocketAddrV4)>>;
}

#[derive(Debug)]
pub enum Error {
    /// The address or netmask cannot describe an IPv4 link.
    BadInterface,
    /// The instance is not one DNS label or a TXT entry does not fit.
    BadAdvert,
    Io(io::Error),
    Stopped,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::BadInterface => write!(f, "interface address or netmask unusable for mDNS"),
            Error::BadAdvert => write!(f, "advert does not fit an mDNS record"),
            Error::Io(e) => write!(f, "mDNS socket: {e}"),
            Error::Stopped => write!(f, "mDNS responder stopped"),
        }
    }
}

impl std::error::Error for Error {}

enum Command {
    Advert(Option<Advert>),
    Browse(bool),
    Shutdown,
}

/// The responder thread. Dropping it says goodbye and joins the thread, like `shutdown`.
pub struct Responder {
    commands: Sender<Command>,
    events: Receiver<Resolved>,
    thread: Option<JoinHandle<()>>,
}

impl Responder {
    /// Opens the multicast socket on the interface with this address and netmask.
    pub fn start(
        iface_name: &str,
        iface_addr: Ipv4Addr,
        netmask: Ipv4Addr,
    ) -> Result<Responder, Error> {
        let usable = !(iface_addr.is_unspecified()
            || iface_addr.is_loopback()
            || iface_addr.is_multicast()
            || iface_addr.is_broadcast());
        if !usable || !valid_netmask(netmask) {
            return Err(Error::BadInterface);
        }
        let transport = MulticastSocket::open(iface_addr).map_err(Error::Io)?;
        let iface = Interface {
            name: iface_name.to_string(),
            addr: iface_addr,
            mask: netmask,
        };
        Ok(Responder::with_transport(iface, transport))
    }

    /// Runs the responder over any transport, such as an in-memory link in tests.
    pub fn with_transport(iface: Interface, transport: impl Transport) -> Responder {
        let (commands, command_rx) = mpsc::channel();
        let (event_tx, events) = mpsc::sync_channel(EVENTS_MAX);
        let engine = Engine::new(iface);
        let thread = std::thread::Builder::new()
            .name("pacer-mdns".into())
            .spawn(move || run(engine, transport, command_rx, event_tx))
            .ok();
        Responder {
            commands,
            events,
            thread,
        }
    }

    /// Publishes, replaces or withdraws the advert.
    pub fn set_advert(&self, advert: Option<Advert>) -> Result<(), Error> {
        if advert.as_ref().is_some_and(|a| !a.is_valid()) {
            return Err(Error::BadAdvert);
        }
        self.send(Command::Advert(advert))
    }

    /// Starts or stops browsing for other instances.
    pub fn set_browse(&self, on: bool) -> Result<(), Error> {
        self.send(Command::Browse(on))
    }

    /// Instances resolved on the link. The newest are dropped when nobody reads them.
    pub fn browse_events(&self) -> &Receiver<Resolved> {
        &self.events
    }

    /// Sends the goodbye for any advert and joins the thread.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn send(&self, command: Command) -> Result<(), Error> {
        if self.thread.is_none() {
            return Err(Error::Stopped);
        }
        self.commands.send(command).map_err(|_| Error::Stopped)
    }

    fn stop(&mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = self.commands.send(Command::Shutdown);
            let _ = thread.join();
        }
    }
}

impl Drop for Responder {
    fn drop(&mut self) {
        self.stop();
    }
}

fn send_all(transport: &impl Transport, packets: Vec<Vec<u8>>) {
    for packet in packets {
        let _ = transport.send(&packet);
    }
}

fn run(
    mut engine: Engine,
    transport: impl Transport,
    commands: Receiver<Command>,
    events: SyncSender<Resolved>,
) {
    let mut buf = vec![0u8; wire::MAX_PACKET + 1];
    loop {
        let now = Instant::now();
        loop {
            match commands.try_recv() {
                Ok(Command::Advert(advert)) => send_all(&transport, engine.set_advert(now, advert)),
                Ok(Command::Browse(on)) => engine.set_browse(now, on),
                Ok(Command::Shutdown) | Err(TryRecvError::Disconnected) => {
                    send_all(&transport, engine.goodbye().into_iter().collect());
                    return;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        send_all(&transport, engine.poll(now));
        let wait = engine
            .next_deadline()
            .map_or(TICK, |d| d.saturating_duration_since(now))
            .clamp(Duration::from_millis(1), TICK);
        match transport.recv(&mut buf, wait) {
            // A datagram that filled the buffer was larger than MAX_PACKET and is dropped.
            Ok(Some((n, src))) if n <= wire::MAX_PACKET => {
                let handled = engine.handle(Instant::now(), &buf[..n], src);
                send_all(&transport, handled.reply.into_iter().collect());
                for resolved in handled.resolved {
                    let _ = events.try_send(resolved);
                }
            }
            Ok(_) => {}
            Err(_) => std::thread::sleep(wait),
        }
    }
}
