# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/). *(Português: [docs/pt/CHANGELOG.md](docs/pt/CHANGELOG.md))*

## [0.2.0] — 2026-11-23

### Added
- **Computer tab** in Settings: computer name, user, model, system, uptime, processor, RAM (with usage bar), graphics card, disks and network (IPs and MAC). The chat assistant also knows the machine: ask "what is my GPU?", "how much RAM do I have?" or "what is my MAC address?" (also in Portuguese and Spanish) and it answers from real data. Pure Node — no Python or Go — for Linux, macOS and Windows (PowerShell on Windows, with `wmic` as plan B). A short machine summary (no MAC or IPs) goes into the hidden prompt.
- **Pause / Resume indexing** from the progress bar, to free CPU and RAM when you need them.
- **Indexing log**: Settings → Logs shows which files were indexed and what was captured from each (chunks, characters and the captured text), plus recent activity (new / updated / removed). Stored in the knowledge database.
- **Problems log** (`errors.sqlite`): files that were skipped or unreadable (too large, no text, read errors) are listed with path, size and reason, in Settings → Logs and through a discreet link on the home screen. A file that is too large **no longer stops the indexing**.
- **Huge files**: `.sql` files above 1 MB and SQLite databases (`.sqlite`, `.sqlite3`, `.db`, `.db3`) up to 4 GB are read as a stream and stored keyword-only (FTS5, no embeddings): constant memory and minutes instead of hours. SQLite files are read table by table, schema first.
- **Block vector search**: above 20,000 vectors the search scans SQLite block by block, so RAM stays constant however big the base is.
- **Answers that do not invent**: hidden honesty rules in every prompt, low temperature (max 0.1) for answers based on your files, irrelevant excerpts are never sent to the model, and a **strict mode** that answers "I did not find this in your files" — without calling the model — when you ask about your files and the search finds no support. New settings: strict mode and minimum relevance.
- **Source-confidence badge** (percentage) under answers that used your files, computed from the search evidence and from whether the answer cited sources; it is saved in the chat history.
- **Retry button**: a question that failed turns yellow and gets a round refresh icon on the right.
- **Context size input** (default 4096) in Servers, with an explanation of the limits and RAM advice; the value is always sent to the model as `-c`.
- **Busy port dialog**: stop the process using the port (shows its name and PID), use a random free port, or cancel.
- **"Open server settings" button** when indexing fails because the embeddings server is not running or did not start.

### Changed
- Default ports are now **8871** (chat), **8872** (embeddings) and **8873** (reranker); saved settings with the old defaults (8080–8082) are migrated automatically.
- **Setup** is now the first tab of Settings.
- Closing the window now quits the app on Linux, Windows and macOS, stopping the servers it started and any indexing in progress.
- Free RAM is now the real available memory on macOS and Linux (cache is not counted as used).

### Fixed
- Embeddings `HTTP 500: input is too large to process` on dense text (CSV, numbers): the embeddings server now starts with a larger batch (`-b 2048 -ub 2048`).
- Top-bar icon missing in the packaged app.
- `ReferenceError: state is not defined` when indexing started the embeddings server automatically.
- Internal FTS5 tables of SQLite files are no longer indexed as noise, and keyword-only excerpts are no longer discarded by the strict mode.

## [0.1.0] — 2026-11-22

First public release.

### Added
- Desktop app (Electron) with a Markdown chat and a "Thinking…" indicator.
- **Interface in English (default), Português and Español**, with a language selector; messages, dialogs and memory-command replies follow the selected language.
- **Chat**, **Embeddings** and **Reranker** (optional) servers: start a llamafile (with GPU automatic / on / CPU only) or use an external OpenAI-compatible server (Ollama etc.).
- **Hybrid RAG** in a single SQLite file: keyword search (FTS5/bm25) + vectors, fused with RRF.
- User-chosen folders: documents, a *brain* folder (notes with priority) and the SQLite location.
- Incremental indexing, automatic reindexing when files are saved, an ignore list and a 5-minute no-progress watchdog.
- Reading of text/code, PDF, DOCX, XLSX, PPTX, ODT/ODS/ODP, SQL, JSON and CSV; legacy formats (.doc/.xls/.ppt/.rtf) through LibreOffice; images and scanned PDFs through OCR (Tesseract).
- **Explicit memory** (`remember that…`, `forget…`, `what do you remember`; also in Portuguese and Spanish), a fixed profile and export to `memory.md`.
- **Evaluation** tab (hit rate and MRR) to measure search quality.
- **Setup** tab: installs OCR, poppler and LibreOffice (Linux, macOS and Windows) asking for confirmation.
- Question token limit, with a counter.
- Installers: Ubuntu/Debian (.deb), Fedora/openSUSE (.rpm), AppImage, .tar.gz, Windows 64/32-bit (installer and portable), macOS Intel and Apple Silicon (.dmg/.zip).
