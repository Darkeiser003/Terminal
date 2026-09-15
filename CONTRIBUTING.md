# Contributing to LTerminal

Thanks for considering a contribution. LTerminal is maintained by one person,
so please open an issue before starting a large change; this avoids investing
time in work that may not fit the project.

## Report a bug or suggest a change

Use the repository's GitHub issue forms for bugs and feature requests. Include
the app version, operating system, exact steps, and expected versus observed
behavior. Do not post credentials, personal data, or exploitable vulnerability
details. Security reports belong in the private process described in
[SECURITY.md](SECURITY.md).

## Prepare a change

1. Fork the repository and create a focused branch.
2. Install the supported Node.js version (22.12 or newer) and Rust toolchain.
3. Run `npm ci` from the repository root.
4. Run `npm run check:local` for the repository's static checks and focused
   regression tests. Run the relevant platform build and E2E tests when your
   change affects runtime behavior; note any environment limitation in the PR.
5. Open a pull request against `main`, explain the user-visible effect, and
   include test results. Keep unrelated formatting or generated files out of
   the change.

There is no requirement to use a particular commit-message convention. A
maintainer will review proposed changes when available; opening a PR does not
guarantee that it will be merged or a response by a particular date.

## Licensing

Contributions to the project are offered under the repository's MIT License.
Do not submit third-party material unless its license permits redistribution
and attribution; preserve required notices.
