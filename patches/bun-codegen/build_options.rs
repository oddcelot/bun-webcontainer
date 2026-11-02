#[allow(dead_code, unreachable_pub, unused)]
pub const SHA: &str = "0000000000000000000000000000000000000000";
#[allow(dead_code, unreachable_pub, unused)]
pub const REPORTED_NODEJS_VERSION: &str = "24.3.0";
#[allow(dead_code, unreachable_pub, unused)]
pub const RELEASE_SAFE: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const IS_CANARY: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const CANARY_REVISION: &str = "0";
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_FUZZILLI: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const FALLBACK_HTML_VERSION: &str = "0000000000000000";
#[allow(dead_code, unreachable_pub, unused)]
pub const VERSION: crate::Version = crate::Version { major: 1, minor: 4, patch: 0 };
#[allow(dead_code, unreachable_pub, unused)]
pub const BASE_PATH: &[u8] = "/tmp/bun".as_bytes();
#[allow(dead_code, unreachable_pub, unused)]
pub const CODEGEN_PATH: &[u8] = "/tmp/bun/build/debug/codegen".as_bytes();
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_LOGS: bool = cfg!(bun_debug);
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_ASAN: bool = cfg!(bun_asan);
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_TINYCC: bool = !cfg!(any(target_os = "android", target_os = "freebsd"));
