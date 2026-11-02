//! Link-time hooks `bun_resolver` declares for `bun_install` (auto-install). The browser has no
//! package manager here: `bun install` runs in the playground, so the resolver never auto-installs.

use core::ptr::NonNull;

use bun_install_types::resolver_hooks::{AutoInstaller, DependencyVersion, PackageNameHash};
use bun_resolver::Error;

#[unsafe(no_mangle)]
fn __bun_resolver_init_package_manager(
    _log: NonNull<bun_ast::Log>,
    _install: Option<NonNull<bun_options_types::schema::api::BunInstall>>,
    _env: NonNull<bun_dotenv::Loader>,
    _prefer_offline: bool,
    _importer_dir: &[u8],
) -> Result<NonNull<dyn AutoInstaller>, Error> {
    Err(Error::ModuleNotFound)
}

#[unsafe(no_mangle)]
fn __bun_resolver_parse_dependency(
    _name: bun_semver::String,
    _name_hash: PackageNameHash,
    _version: &[u8],
    _sliced: &bun_semver::SlicedString,
    _log: Option<&mut bun_ast::Log>,
) -> Option<DependencyVersion> {
    None
}
