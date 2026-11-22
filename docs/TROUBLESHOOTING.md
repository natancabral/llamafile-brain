# Troubleshooting

*(Português: [docs/pt/TROUBLESHOOTING.md](pt/TROUBLESHOOTING.md))*

The app's messages follow the interface language; the English wording is used below.

## "Could not connect to 127.0.0.1:8081"
The **Embeddings** server is not running. In **Servers**, click **Start** (llamafile mode) or check the URL (external mode; Ollama: `http://127.0.0.1:11434`).

## "Pooling type 'none' is not OAI compatible"
The embeddings model has no pooling. The app works around it, but the ideal is a model made for embeddings (`embeddinggemma`) or `--pooling mean` in the arguments.

## "Port XXXX is already in use"
Another server (or an old llamafile) holds the port. Use different ports for chat, embeddings and reranker, or end the old process (`pkill -f llamafile`).

## The server "closes while starting"
Almost always out of memory (RAM/VRAM) or an incompatible file. The error shows the last lines of the log. Try *CPU only*, a smaller model, or not loading two large models at the same time.

## Linux: "SUID sandbox helper binary was found, but is not configured correctly"
- `.deb`/`.rpm` package: already configured.
- AppImage/source: `npm run start:linux` (asks for sudo once) or `npm run start:dev` (no sandbox, development only). On Ubuntu 24.04+, the AppImage may need `--no-sandbox`.

## A file was not indexed
At the end of indexing the app lists the files that failed **with the reason**. Common causes: scanned PDF without OCR, `fflate` not installed (`npm install`), password-protected file, legacy format without LibreOffice (**Setup** tab).

## Indexing stopped
With no progress for 5 minutes the app cancels and tells you which file it stopped at. Check the embeddings server.

## Answers are slow
See "Performance" in [USAGE.md](USAGE.md): smaller context, fewer excerpts, GPU, smaller model.

## I changed the embeddings model and got a dimension error
Use **Clear index** (memory is kept) and index again.

## The interface is in the wrong language
Use the language selector at the top of the sidebar (English, Português, Español). The choice is saved in the settings.

## macOS: "the app is damaged" / Windows: SmartScreen
The installers are not signed. See [RELEASING.md](RELEASING.md#code-signing).
