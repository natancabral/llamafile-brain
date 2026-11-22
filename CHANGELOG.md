# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/). *(Português: [docs/pt/CHANGELOG.md](docs/pt/CHANGELOG.md))*

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
