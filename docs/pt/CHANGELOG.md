# Changelog

*(English: [CHANGELOG.md](../../CHANGELOG.md))*

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [0.2.0] — 2026-11-23

### Adicionado
- **Aba Computador** nas Settings: nome do computador, usuário, modelo, sistema, tempo ligado, processador, RAM (com barra de uso), placa de vídeo, discos e rede (IPs e MAC). O assistente do chat também conhece a máquina: pergunte "qual minha placa de vídeo?", "quanta RAM eu tenho?" ou "qual meu endereço MAC?" (também em inglês e espanhol) e ele responde com dados reais. Feito só em Node — sem Python nem Go — para Linux, macOS e Windows (PowerShell no Windows, com `wmic` como plano B). Um resumo curto da máquina (sem MAC nem IPs) vai no prompt oculto.
- **Pausar / Retomar a indexação** pela barra de progresso, para liberar CPU e RAM quando precisar.
- **Log de indexação**: Settings → Logs mostra quais arquivos foram indexados e o que foi capturado de cada um (trechos, caracteres e o texto capturado), mais a atividade recente (novo / atualizado / removido). Salvo no banco de conhecimento.
- **Log de problemas** (`errors.sqlite`): arquivos ignorados ou ilegíveis (grandes demais, sem texto, erro de leitura) aparecem com caminho, tamanho e motivo, em Settings → Logs e por um link discreto na tela inicial. Um arquivo grande demais **não interrompe mais a indexação**.
- **Arquivos enormes**: arquivos `.sql` acima de 1 MB e bancos SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`) de até 4 GB são lidos em streaming e guardados só por palavras-chave (FTS5, sem embeddings): memória constante e minutos em vez de horas. Arquivos SQLite são lidos tabela por tabela, começando pelo esquema.
- **Busca vetorial em blocos**: acima de 20.000 vetores a busca varre o SQLite bloco a bloco, e a RAM fica constante não importa o tamanho da base.
- **Respostas que não inventam**: regras de honestidade ocultas em todo prompt, temperatura baixa (máx. 0,1) nas respostas baseadas nos seus arquivos, trechos irrelevantes nunca vão ao modelo e um **modo estrito** que responde "não encontrei isso nos seus arquivos" — sem chamar o modelo — quando você pergunta sobre os arquivos e a busca não acha apoio. Novas configurações: modo estrito e relevância mínima.
- **Selo de confiança nas fontes** (porcentagem) sob as respostas que usaram seus arquivos, calculado pela evidência da busca e por a resposta ter citado fontes; fica salvo no histórico do chat.
- **Botão Reenviar**: a pergunta que falhou fica amarela e ganha um ícone redondo de refresh à direita.
- **Campo de tamanho do contexto** (padrão 4096) em Servidores, com explicação dos limites e sugestão pela RAM; o valor sempre vai ao modelo como `-c`.
- **Aviso de porta ocupada**: encerrar o processo que usa a porta (mostra nome e PID), usar uma porta livre aleatória ou cancelar.
- **Botão "Abrir configurações dos servidores"** quando a indexação falha porque o servidor de embeddings não está rodando ou não iniciou.

### Alterado
- As portas padrão agora são **8871** (chat), **8872** (embeddings) e **8873** (reranker); configurações salvas com os padrões antigos (8080–8082) são migradas automaticamente.
- **Instalação** agora é a primeira aba das Settings.
- Fechar a janela agora encerra o app no Linux, Windows e macOS, parando os servidores que ele iniciou e qualquer indexação em andamento.
- A RAM livre agora é a memória realmente disponível no macOS e no Linux (cache não conta como usado).

### Corrigido
- Erro de embeddings `HTTP 500: input is too large to process` em texto denso (CSV, números): o servidor de embeddings agora inicia com lote maior (`-b 2048 -ub 2048`).
- Ícone da barra superior ausente no app empacotado.
- `ReferenceError: state is not defined` quando a indexação iniciava o servidor de embeddings automaticamente.
- Tabelas internas do FTS5 de arquivos SQLite não são mais indexadas como ruído, e trechos só de palavra-chave não são mais descartados pelo modo estrito.

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
