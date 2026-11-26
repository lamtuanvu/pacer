//! Native task delegation, managed-work lifecycle and message turns. The front
//! doors inject the external runtime (plugins, runner spawn and supervision) so
//! the op crates keep their strict layer ordering (G2).
pub mod runtime;
pub mod turns;
