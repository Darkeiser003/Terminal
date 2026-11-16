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
5. Update [README.md](README.md) for behavior, build, release, or test changes.
   README is the only maintained documentation: when a source file, IPC
   command, call chain, or flow changes, also update its technical map
   ([README → Mapa de archivos, llamadas y mantenimiento](README.md#mapa-de-archivos-llamadas-y-mantenimiento)).
   Run `npm run check:docs` and
   `npm run check:flows`; these catch missing paths and diagram anchors, while
   the technical descriptions still require review.
6. Open a pull request against `main`, explain the user-visible effect, and
   include test results. Keep unrelated formatting or generated files out of
   the change.

There is no requirement to use a particular commit-message convention. A
maintainer will review proposed changes when available; opening a PR does not
guarantee that it will be merged or a response by a particular date.

## Licensing

The project is distributed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`, see `LICENSE`). The copyright holder also
offers it under separate commercial licenses (see "Licencia" in `README.md`).
Do not submit third-party material unless its license permits redistribution
and attribution; preserve required notices.

### Contributor License Agreement (CLA)

Because the same code is offered under the AGPL and under commercial licenses,
every contribution needs the Contributor License Agreement below before it can
be merged. You only accept it once; commenting on your first pull request with
the sentence that the CLA bot asks for (or ticking its checkbox) counts as
signing it. Automated dependency updates (Dependabot, Renovate) that only
change version numbers do not need it.

> **WTerminal / LTerminal Individual Contributor License Agreement, v1.0**
>
> "You" are the person or legal entity submitting a "Contribution": any
> original work of authorship, including modifications or additions to existing
> work, that you intentionally submit to the project maintained by Darkeiser003
> (the "Maintainer").
>
> 1. **Copyright license.** You grant the Maintainer and recipients of software
>    distributed by the Maintainer a perpetual, worldwide, non-exclusive,
>    no-charge, royalty-free, irrevocable copyright license to reproduce,
>    prepare derivative works of, publicly display, publicly perform,
>    sublicense and distribute your Contributions and such derivative works,
>    **under the AGPL-3.0-only or under any other license terms, including
>    proprietary and commercial licenses.**
> 2. **Patent license.** You grant the same parties a perpetual, worldwide,
>    non-exclusive, no-charge, royalty-free, irrevocable patent license to make,
>    have made, use, offer to sell, sell, import and otherwise transfer your
>    Contributions, for the patent claims you can license that are necessarily
>    infringed by your Contribution alone or combined with the project.
> 3. **You keep your rights.** Apart from these licenses, you keep all right,
>    title and interest in your Contributions and may use them for any purpose.
> 4. **Your representations.** Each Contribution is your original creation, or
>    you have the right to submit it under this agreement; if your employer has
>    rights to your work, you have its permission or a waiver. You will name any
>    third-party material and its license in the pull request.
> 5. **No warranty and no obligation.** Contributions are provided "as is". The
>    Maintainer is not required to use them, and you are not required to
>    provide support for them.
>
> This agreement is governed by the laws of Spain.

The CLA is a draft maintained by the project owner and has not been reviewed
by a lawyer; it will be updated if legal review requires changes.
