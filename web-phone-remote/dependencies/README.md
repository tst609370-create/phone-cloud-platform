# `dependencies/` — Linux dev fallback only

On **Windows**, the dev server reads and writes dependencies at
`%PROGRAMDATA%\WsScrcpyWeb\dependencies\`, matching what the launcher's
[`paths.rs`](../launcher/src/paths.rs) computes for an MSI install
(see `Config.ts::resolveDependenciesPath` and
[the dev/install layout parity design](../docs/superpowers/specs/2026-05-14-dev-install-layout-parity-design.md)).
The `.gitkeep`-pinned subdirs in this folder are vestigial on Windows;
they're kept for Linux dev only.

On **Linux** dev, this folder is still the resolver's fallback target —
`paths.rs:62` collapses `data_root` onto `install_root` on non-Windows
hosts pending a Phase-1-equivalent design (tracked in
`todo_ws_scrcpy_web.md` §19).

Do not commit binary contents of subdirs here; they're populated at
runtime by `DependencyManager.autoInstallMissing()` (downloads adb,
Node, scrcpy-server on first launch into `<dataRoot>/dependencies/` on
Windows, or `<repo>/dependencies/` on Linux).
