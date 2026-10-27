# Security Policy

## Maintainer and project scope

The `phone-cloud-platform` repository is maintained under the GitHub account [@tst609370-create](https://github.com/tst609370-create).

This policy covers security issues introduced by the repository's own integration code, including its Android phone-to-SOCKS5 management tools, remote access integration, and deployment configurations.

The `web-phone-remote/` directory includes code originating from the separately maintained [bilbospocketses/ws-scrcpy-web](https://github.com/bilbospocketses/ws-scrcpy-web) project. This repository does not claim to be that upstream project's official security maintainer. Refer to its original project for upstream-specific security issues.

## Private vulnerability reporting

Please do not post vulnerability details, sensitive logs, access credentials, or proof-of-concept exploit code in public issues.

If GitHub private vulnerability reporting is enabled, go to the [Security Advisories page](https://github.com/tst609370-create/phone-cloud-platform/security/advisories) and choose **Report a vulnerability**.

If that option is not yet available, open a [public issue](https://github.com/tst609370-create/phone-cloud-platform/issues/new) requesting a private security contact **without including technical vulnerability details**, so we can arrange a private reporting method.

Reports are welcome for flaws in authentication, authorization, session management, remote access controls, stored configuration, secrets handling, and handling of connected Android devices.

## Report content

Where possible, include:
- A concise summary and affected component or version.
- Preconditions and clearly scoped reproduction steps for systems you own or are authorized to test.
- Expected vs. observed security impact.
- Suggested mitigation, if available.

Please remove personal information, secrets, and third-party system identifiers before sharing any report.

## Handling and disclosure

Reports are triaged based on severity, reproducibility, and project ownership. Any fix or coordinated disclosure timing is determined case by case. No guaranteed response or fix timeline is promised.

This document provides a responsible disclosure process. It does not represent an external security certification, a security audit, or a claim of verified vulnerability research credentials.
