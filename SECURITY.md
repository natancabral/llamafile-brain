# Security

*(Português: [docs/pt/SECURITY.md](docs/pt/SECURITY.md))*

## Supported versions
Only the latest version receives fixes.

## Security model (summary)

- **Local by default:** the app only talks to the servers you configure (`127.0.0.1` by default). There is no telemetry.
- **Allowed folders:** it only reads the folders you add. Symbolic links are not followed; `open:path` only opens files inside them.
- **Secrets:** `.env`, keys (`.pem`, `.key`, `id_rsa`…), `credentials*` and `secrets.*` are never indexed.
- **Isolated renderer:** `contextIsolation`, `sandbox`, a restrictive CSP and a fixed list of IPC calls. Markdown is built through the DOM (no `innerHTML`); links are only `http(s)` and `mailto`.
- **Dependency installation:** only runs after a confirmation dialog showing the exact command.
- **Memory:** only written by explicit user commands, never by the model.

## Out of scope
Model-generated content (mistakes, hallucinations) and vulnerabilities in the models/servers themselves (llamafile, Ollama) — report those to their own projects.
