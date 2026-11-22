# Solução de problemas

*(English: [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md))*

## "Não consegui conectar em 127.0.0.1:8081"
O servidor de **Embeddings** não está rodando. Em **Servidores**, clique em **Iniciar** (modo llamafile) ou confira a URL (modo externo; Ollama: `http://127.0.0.1:11434`).

## "Pooling type 'none' is not OAI compatible"
O modelo de embeddings não tem pooling. O app contorna isso, mas o ideal é um modelo próprio para embeddings (`embeddinggemma`) ou `--pooling mean` nos argumentos.

## "A porta XXXX já está em uso"
Outro servidor (ou um llamafile antigo) ocupa a porta. Use portas diferentes para chat, embeddings e reranker ou encerre o processo antigo (`pkill -f llamafile`).

## O servidor "fecha ao iniciar"
Quase sempre falta memória (RAM/VRAM) ou o arquivo está incompatível. O erro mostra as últimas linhas do log. Tente *Só CPU*, um modelo menor ou não carregar dois modelos grandes ao mesmo tempo.

## Linux: erro "SUID sandbox helper binary was found, but is not configured correctly"
- Pacote `.deb`/`.rpm`: já vem configurado.
- AppImage/código-fonte: `npm run start:linux` (pede sudo uma vez) ou `npm run start:dev` (sem sandbox, só para desenvolvimento). No Ubuntu 24.04+, o AppImage pode precisar de `--no-sandbox`.

## Um arquivo não foi indexado
Ao fim da indexação o app lista os arquivos que falharam **com o motivo**. Causas comuns: PDF escaneado sem OCR, `fflate` não instalado (`npm install`), arquivo com senha, formato antigo sem LibreOffice (aba **Instalação**).

## A indexação parou
Sem progresso por 5 minutos o app cancela e informa em qual arquivo parou. Verifique o servidor de embeddings.

## As respostas estão lentas
Veja "Desempenho" em [USAGE.md](USAGE.md): contexto menor, menos trechos, GPU, modelo menor.

## Troquei o modelo de embeddings e deu erro de dimensão
Use **Limpar índice** (a memória é mantida) e indexe de novo.

## macOS: "o app está danificado" / Windows: SmartScreen
Os instaladores não são assinados. Veja [RELEASING.md](RELEASING.md#assinatura-de-código).
