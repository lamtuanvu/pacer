//! The multicast UDP socket on one interface.
//!
//! The IP TTL of received packets is not checked (RFC 6762 §11 suggests TTL 255): reading it needs
//! `IP_RECVTTL` and control-message parsing, which socket2 does not offer safely, and the workspace
//! forbids `unsafe`. The on-link source check in the engine is the filter instead.
use crate::{MDNS_GROUP, MDNS_PORT, Transport};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket},
    time::Duration,
};

pub struct MulticastSocket(UdpSocket);

impl MulticastSocket {
    /// Binds 0.0.0.0:5353 (shared with other responders), joins 224.0.0.251 on `addr` and sends
    /// from `addr` with multicast TTL 255 and no loopback.
    pub fn open(addr: Ipv4Addr) -> io::Result<MulticastSocket> {
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        socket.set_reuse_address(true)?;
        #[cfg(unix)]
        socket.set_reuse_port(true)?;
        socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MDNS_PORT).into())?;
        socket.join_multicast_v4(&MDNS_GROUP, &addr)?;
        // Linux otherwise delivers groups joined by any socket on any interface.
        #[cfg(target_os = "linux")]
        socket.set_multicast_all_v4(false)?;
        socket.set_multicast_if_v4(&addr)?;
        socket.set_multicast_ttl_v4(255)?;
        socket.set_multicast_loop_v4(false)?;
        Ok(MulticastSocket(socket.into()))
    }
}

impl Transport for MulticastSocket {
    fn send(&self, packet: &[u8]) -> io::Result<()> {
        self.0
            .send_to(packet, SocketAddrV4::new(MDNS_GROUP, MDNS_PORT))
            .map(|_| ())
    }

    fn recv(&self, buf: &mut [u8], timeout: Duration) -> io::Result<Option<(usize, SocketAddrV4)>> {
        self.0
            .set_read_timeout(Some(timeout.max(Duration::from_millis(1))))?;
        match self.0.recv_from(buf) {
            Ok((n, SocketAddr::V4(src))) => Ok(Some((n, src))),
            Ok((_, SocketAddr::V6(_))) => Ok(None),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }
}
