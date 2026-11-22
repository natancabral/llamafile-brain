# Modelos

*(English: [docs/MODELS.md](../MODELS.md))*

O app conversa com qualquer servidor **compatível com a API da OpenAI** (`/v1/chat/completions`, `/v1/embeddings`). Funciona com llamafile e com Ollama.

> As indicações abaixo vêm de tamanho e tipo de cada modelo. Teste no seu computador e use a aba **Avaliação** para comparar.

## Chat (gerar as respostas)

| Modelo | Tamanho aprox. | Quando usar |
|---|---|---|
| Qwen3.5 0.8B | ~1,6 GB | computador fraco; respostas simples |
| **Qwen3.5 2B** | ~3,2 GB | bom ponto de partida em CPU |
| Qwen3.5 4B / gemma-4-E2B | 4–5 GB | mais qualidade, ainda leve |
| gemma-4-E4B / Qwen3.5 9B | ~7 GB | ideal com GPU ou bastante RAM |

Arquivos `.llamafile` prontos: [huggingface.co/mozilla-ai/llamafile_0.10](https://huggingface.co/mozilla-ai/llamafile_0.10).

Modelos "que pensam" antes de responder (alguns da família Qwen3.x) podem demorar mais; prefira variantes *instruct* se a resposta estiver lenta.

## Embeddings (entender os textos)

Use um modelo **feito para embeddings** — a busca fica melhor e a indexação mais rápida do que com um modelo de chat.

| Modelo | Tamanho aprox. | Observação |
|---|---|---|
| **embeddinggemma** | ~300 MB | recomendado; `ollama pull embeddinggemma` |
| bge-m3 | ~600 MB | multilíngue, bom em português |
| nomic-embed-text | ~270 MB | simples e leve |
| mxbai-embed-large | ~670 MB | bom em inglês |

Usar um modelo de chat como embedding funciona com `--pooling mean` (o app já acrescenta), mas é mais lento e menos preciso.

**Trocou de modelo?** A dimensão dos vetores muda: use **Limpar índice** e indexe de novo.

## Reranker (opcional)

Um segundo modelo lê pergunta + trecho e reordena os candidatos. Suba um modelo de *reranking* (ex.: família `bge-reranker`) com `--embedding --pooling rank --reranking` e ligue em **Busca**. Sem o servidor, o app usa a ordem normal e avisa. O formato exato do endpoint varia entre servidores; o app tenta `/v1/rerank`, `/rerank` e `/reranking`.

## Windows: limite de 4 GB

No Windows, um arquivo `.exe` não pode passar de 4 GB. Para modelos maiores, use o Ollama (modo *Servidor externo*) ou o executável do llamafile com `-m caminho/modelo.gguf` em **Argumentos extras**.

## Memória (RAM)

Cada servidor carrega o seu modelo. Chat + embeddings juntos precisam de RAM para os dois. Se faltar, o servidor fecha ao iniciar e o app mostra as últimas linhas do log.
