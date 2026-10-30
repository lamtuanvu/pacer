//! The multicast UDP socket on one interface.
//!
//! On Linux the socket is bound to the group address, 224.0.0.251:5353, so it receives only
//! datagrams sent to the group. On macOS (and other non-Linux unix) it is bound to 0.0.0.0:5353:
//! a socket bound to the group fails every `sendto` there with `EADDRNOTAVAIL`. Measured on macOS
//! with such a wildcard socket held open, unicast mDNS queries to the host's address were all
//! answered by mDNSResponder and none reached the socket, so the system responder keeps unicast
//! traffic either way. The destination address of a datagram is not checked: reading it would
//! need `IP_RECVDSTADDR` and control messages, which socket2 does not offer safely, and the
//! workspace forbids `unsafe`. For the same reason the IP TTL (RFC 6762 §11) is not checked; the
//! source must be on the link (see `on_link`), and routers never forward 224.0.0.0/24.
use crate::{MDNS_GROUP, MDNS_PORT, Transport};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket},
    time::Duration,
};

pub struct MulticastSocket(UdpSocket);

/// The group address on Linux, which delivers only group traffic to such a socket. Elsewhere any
/// address: macOS cannot send from a group-bound socket and Windows refuses the bind.
fn bind_addr() -> SocketAddrV4 {
    if cfg!(target_os = "linux") {
        SocketAddrV4::new(MDNS_GROUP, MDNS_PORT)
    } else {
        SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MDNS_PORT)
    }
}

/// A UDP socket bound to port 5353, shared with the other responders on the machine.
fn bound() -> io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.bind(&bind_addr().into())?;
    Ok(socket)
}

impl MulticastSocket {
    /// Binds port 5353 (see the module doc), joins 224.0.0.251 on `addr` and sends from `addr`
    /// with multicast TTL 255 and no loopback.
    pub fn open(addr: Ipv4Addr) -> io::Result<MulticastSocket> {
        let socket = bound()?;
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_binds_the_group_so_unicast_never_reaches_the_socket() {
        assert_eq!(bind_addr(), SocketAddrV4::new(MDNS_GROUP, MDNS_PORT));
        let socket = bound().unwrap();
        let local = socket.local_addr().unwrap().as_socket_ipv4().unwrap();
        assert_eq!(local, SocketAddrV4::new(MDNS_GROUP, MDNS_PORT));
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn macos_binds_the_wildcard_because_a_group_bound_socket_cannot_send() {
        assert_eq!(
            bind_addr(),
            SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MDNS_PORT)
        );
        let socket = bound().unwrap();
        let local = socket.local_addr().unwrap().as_socket_ipv4().unwrap();
        assert_eq!(local, SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MDNS_PORT));
    }
}
