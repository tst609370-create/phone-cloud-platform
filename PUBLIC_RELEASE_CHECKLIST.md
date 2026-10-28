# Public-release readiness / 公开前检查

Status: **NOT APPROVED FOR PUBLIC VISIBILITY**
Updated: 2026-10-28 (Asia/Dubai).

## Purpose and provenance

This repository groups Android device connectivity and remote-management integrations. Its `web-phone-remote/` directory incorporates code from [bilbospocketses/ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web), which has its own GPL-3.0 license and security policy. The account holder maintains this repository's integration; this does not assert upstream ownership or certification.

## Work completed

- Added a repository-level `SECURITY.md` describing coordinated vulnerability disclosure.
- Clarified attribution of upstream code in the root `README.md`.
- Replaced some tracked machine-specific configuration with example values, including the Cloudflare Tunnel YAML, selected macOS launch-agent paths, and Windows Deskflow path.
- Expanded top-level `.gitignore` to reduce accidental inclusion of secrets and operational databases.

## Blocking items before making this repository public

- [ ] Inspect and sanitize all **current** deployment-specific files, including `web-phone-remote/macos/config.json` and `web-phone-remote/macos/cn.anyuekf.phonecloud.tunnel.plist`. Automated edits to these files were not completed. Do not assume they are safe.
- [ ] Search the **entire Git history** for committed access tokens, passwords, private keys, tunnels, deployment details, customer data, and device identifiers. Editing the latest version DOES NOT remove data from old commits.
- [ ] If secrets are found, revoke or rotate them before making any copy public. Consider a fresh, sanitized public repository containing only approved files (with appropriate license notices) instead of changing the visibility of this historic backup.
- [ ] Confirm any scripts that use the example files are supplied with operator-specific configuration outside Git. Example placeholders are intentionally not deployable as-is.
- [ ] Confirm open-source licensing for **original, top-level code**. The GPL-3.0 license under `web-phone-remote/` covers that component; it should not be incorrectly attributed to the entire repository by assumption.
- [ ] Verify that any security controls, API authentication, and remote exposure settings are adequate before connecting the software to an Internet-facing endpoint.
- [ ] After publishing, enable GitHub **Private vulnerability reporting** and confirm the actual repository security-contact workflow.
- [ ] Document independent security fixes or defensive testing with reproducible evidence, if any, before using this project in a third-party maintainer review.

## Anthropic verification

A public repository and `SECURITY.md` can help explain a maintainer's work, but do **not** establish qualification for Anthropic's Cyber Verification Program. Present only genuine maintenance history and security findings. No vulnerability discoveries, external dependents, or CVP acceptance are claimed by this document.

This is a source-level review of selected files only; it is NOT a completed security audit, a live-deployment test, or a guarantee that all Git history is free of sensitive information.
