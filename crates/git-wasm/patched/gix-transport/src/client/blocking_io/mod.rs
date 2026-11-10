///
pub mod connect;

///
pub mod file;
///
#[cfg(feature = "http-client")]
pub mod http;

mod bufread_ext;
pub use bufread_ext::{ExtendedBufRead, HandleProgress, ReadlineBufRead};

mod request;
pub use request::RequestWriter;

///
pub mod ssh;

mod traits;
pub use traits::{SetServiceResponse, Transport, TransportV2Ext};

/// WASI patch (crates/git-wasm/NOTES.md): makes the HTTP transport for `http(s)://` urls when this crate has no HTTP
/// backend compiled in (no curl or reqwest), so `connect` (and with it gix's clone and fetch) can use one the program
/// provides. Set once, before connecting.
#[allow(clippy::type_complexity)]
pub static HTTP_CONNECT: std::sync::OnceLock<
    fn(gix_url::Url, crate::Protocol, bool) -> Box<dyn Transport + Send>,
> = std::sync::OnceLock::new();
