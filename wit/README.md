# `orivo-plugin.wit` — provenance

`orivo-plugin.wit` in this directory is a **byte-for-byte copy** of the frozen
v1 contract shipped by Orivo:

- source: `orivo/wit/orivo-plugin.wit`
- commit: `db03c6c`
- verify at any time:

```sh
cmp /Users/spectre/repos/orivo/wit/orivo-plugin.wit wit/orivo-plugin.wit
```

It must stay identical. Two independent reasons:

1. **`wit-bindgen` generates the guest bindings from this file.** The world,
   the interfaces and the types are what the component is compiled against; a
   drifted copy produces a component the host's linker rejects before it runs a
   single instruction.
2. **Orivo freezes this contract against a baseline.**
   `sdk/orivo-plugin-sdk/tests/wit_compatibility.rs` compares
   `orivo/wit/orivo-plugin.wit` to `tests/wit-v1-baseline.json` and fails on a
   breaking change. This repository consumes that contract; it does not get to
   amend it. A change to the contract is an Orivo-side, reviewed decision
   (see `orivo/wit/README.md`), not a plugin's.

To pick up a newer contract: re-copy the file from a newer Orivo commit and
re-run `./build.sh`, then the SDK's `validate`/`check`/`simulate`. Anything the
new contract changes about limits, budgets or launch modes is documented in
Orivo first — re-read `docs/01-contexte-orivo.md` and
`docs/03-regles-de-construction.md` against the new commit before trusting this
repository's numbers.
