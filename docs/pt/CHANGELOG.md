# Changelog

*(English: [CHANGELOG.md](../../CHANGELOG.md))*

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [0.1.0] — 2026-11-22

Primeira versão pública.

### Adicionado
- App desktop (Electron) com chat em Markdown e indicador "Pensando…".
- Servidores de **Chat**, **Embeddings** e **Reranker** (opcional): iniciar um llamafile (com opção GPU automático / usar / só CPU) ou usar um servidor externo compatível com OpenAI (Ollama etc.).
- **RAG híbrido** em um único arquivo SQLite: busca por palavras (FTS5/bm25) + vetores, fundidos por RRF.
- Pastas à escolha do usuário: documentos, pasta *brain* (notas com prioridade) e local do SQLite.
- Indexação incremental, reindexação automática ao salvar arquivos, lista de ignorados e vigia de 5 minutos sem progresso.
- Leitura de texto/código, PDF, DOCX, XLSX, PPTX, ODT/ODS/ODP, SQL, JSON e CSV; formatos antigos (.doc/.xls/.ppt/.rtf) via LibreOffice; imagens e PDFs escaneados via OCR (Tesseract).
- **Memória explícita** (`lembre que…`, `esqueça…`, `o que você lembra`), perfil fixo e exportação para `memory.md`.
- Aba **Avaliação** (taxa de acerto e MRR) para medir a qualidade da busca.
- Aba **Instalação**: instala OCR, poppler e LibreOffice (Linux, macOS e Windows) pedindo confirmação.
- Limite de tokens da pergunta, com contador.
- Instaladores: Ubuntu/Debian (.deb), Fedora/openSUSE (.rpm), AppImage, .tar.gz, Windows 64/32 bits (instalador e portátil), macOS Intel e Apple Silicon (.dmg/.zip).
