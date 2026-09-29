# Contributing

Thanks for wanting to help. Bug reports, ideas and pull requests are all
welcome.

## Reporting bugs

Open an issue with the **Bug report** template. The fastest way to include
what we need is **Copy diagnostics** at the bottom of the Axiom launcher; check what it
contains before pasting.

## Development setup

Everything you need to build and run Axiom is in the
[README](README.md#development-setup): Node (see `.nvmrc`), Go, Git and a C
toolchain.

```bash
npm install
npm run dev
```

## Before opening a pull request

Run the checks that cover what you changed:

```bash
npx tsc --noEmit        # types, everywhere
npm run test:renderer   # renderer, shared, Electron and MCP unit tests
npm run test:archd      # Go daemon
npm run test:mcp        # MCP end to end (builds archd)
npm run test:e2e        # packaged Electron UI
```

- Keep a pull request to one change. Say what it changes and why.
- Canvas behaviour is specified in
  [CANVAS_BEHAVIOR_CONTRACT.md](CANVAS_BEHAVIOR_CONTRACT.md); changes that
  alter observable behaviour should update it.
- Match the surrounding code: its naming, comment density and idiom.
- Add or update tests for behaviour you change.

## License and contributor agreement

Axiom is licensed under the [GNU AGPL v3.0](LICENSE). Before your first
contribution is merged, a bot will ask you on the pull request to accept the
[Contributor License Agreement](CLA.md) by posting one comment. You keep the
copyright in your work; the agreement lets the project also offer Axiom under
other terms (for example to organizations that cannot use the AGPL), which is
how it stays open and sustainable.
