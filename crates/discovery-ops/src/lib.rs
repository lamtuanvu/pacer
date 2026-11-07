//! Native LAN discovery operation handlers (`discovery.set`, `discovery.respond`,
//! `discovery.list`, `discovery.network.*`) and the current-network probe that
//! `pacer-server` assembles into its registry.
pub mod discovery_ops;
pub mod network;
pub mod network_ops;
