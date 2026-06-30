# Homebrew formula template

`agentmemory.rb.template` is a release template, not a live formula.

Before opening a Homebrew tap pull request, a release job must replace:

- `__AGENTMEMORY_VERSION__` with the released package version.
- `__AGENTMEMORY_TARBALL_URL__` with the immutable release tarball URL.
- `__AGENTMEMORY_SHA256__` with the SHA-256 of that exact tarball.

`__AGENTMEMORY_TARBALL_URL__` must be a prebuilt artifact (the published
`npm pack` tarball) that already ships `dist/cli.mjs`. `dist/` is gitignored
build output, so a GitHub git source tarball does not contain `dist/cli.mjs`
and the `bin.install_symlink libexec/"dist/cli.mjs"` step would break.

Do not publish this template with placeholder values, and do not invent a
checksum before the release archive exists.
