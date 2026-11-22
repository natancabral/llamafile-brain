# Contributing

Thanks for wanting to help! Every contribution is welcome: fixes, new file formats, translations, documentation, tests. *(Português: [docs/pt/CONTRIBUTING.md](docs/pt/CONTRIBUTING.md))*

## Setup

Requirements: **Node 20+** (22 recommended) and Git.

```bash
git clone https://github.com/natancabraldev/llamafile-brain.git
cd llamafile-brain
npm install         # or: yarn install (the scripts below also run with `yarn <name>`)
npm start            # Linux: if it complains about the "SUID sandbox", use npm run start:linux or npm run start:dev
npm test             # unit and integration tests (simulated servers)
npm run e2e          # opens the real Electron (headless Linux: xvfb-run -a npx electron test/e2e/electron-e2e.js --no-sandbox)
npm run setup        # installs OCR/LibreOffice (optional, for the tests that use those tools)
```

## Structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: `src/core/` is the logic (no Electron, testable in plain Node), `src/main.js` wires everything to Electron, `src/renderer/` is the UI and `src/shared/i18n.js` holds the translations.

## Project rules

1. **Privacy first.** Nothing from the user leaves the machine without an explicit, visible action. Do not add telemetry.
2. **No native modules.** SQLite is the `node:sqlite` built into Electron. New dependencies need a good reason.
3. **Renderer security.** No `innerHTML` with model or file content; new IPC calls go in the `src/preload.js` list and validate their arguments in `main.js`.
4. **Test what you change.** New logic in `src/core/` needs a test in `test/`. UI changes: adjust `test/ui.test.js` and the e2e.
5. **Translatable UI text.** No hard-coded user-facing strings: add a key to `src/shared/i18n.js` with all three languages (English, Português, Español) and use `data-i18n="key"` in HTML or `t('key')` in code. English is the source language; `npm test` fails if a key is missing a language or a used key does not exist. Code and comments are in English.

## Adding a translation or a new language

- Fixing a wording: edit the entry in `src/shared/i18n.js`.
- A new language: add it to `LANGS`, `PROMPT_LANG` and `ORDER`, append a column to every catalog entry, add the `<option>` to the selector in `index.html`, and extend the memory-command and folder-intent patterns in `src/core/memory.js` and `src/core/summarize.js`.

## Adding a file format

1. In `src/core/indexer.js`, add the extension to the right set and an extraction function in `extractText`.
2. Return **plain text**; for spreadsheets/slides, follow the existing pattern (`## Sheet: …`, `## Slide n`).
3. Add a test in `test/formats.test.js` with a real file.
4. Document it in the README.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) messages: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- One PR = one topic. Fill in the PR template and update `CHANGELOG.md`.
- CI runs `npm test` on Linux and macOS and the e2e test on Linux.

## Reporting bugs

Use the issue template and include your operating system, the models used and the last lines of the app's **Logs** tab (without personal data).

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
