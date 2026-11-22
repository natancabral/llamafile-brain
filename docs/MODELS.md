# Models

The app talks to any **OpenAI-compatible** server (`/v1/chat/completions`, `/v1/embeddings`). It works with llamafile and with Ollama. *(Português: [docs/pt/MODELS.md](pt/MODELS.md))*

> The hints below come from each model's size and type. Test on your own computer and use the **Evaluation** tab to compare.

## Chat (generating the answers)

| Model | Approx. size | When to use |
|---|---|---|
| Qwen3.5 0.8B | ~1.6 GB | weak computer; simple answers |
| **Qwen3.5 2B** | ~3.2 GB | good starting point on CPU |
| Qwen3.5 4B / gemma-4-E2B | 4–5 GB | more quality, still light |
| gemma-4-E4B / Qwen3.5 9B | ~7 GB | ideal with a GPU or plenty of RAM |

Ready-made `.llamafile` files: [huggingface.co/mozilla-ai/llamafile_0.10](https://huggingface.co/mozilla-ai/llamafile_0.10) (download from the **llamafile** column).

Models that "think" before answering (some of the Qwen3.x family) can take longer; prefer *instruct* variants if answers feel slow.

## Embeddings (understanding the texts)

Use a model **made for embeddings** — search is better and indexing faster than with a chat model.

| Model | Approx. size | Note |
|---|---|---|
| **embeddinggemma** | ~300 MB | recommended; `ollama pull embeddinggemma` |
| bge-m3 | ~600 MB | multilingual, good in Portuguese and Spanish |
| nomic-embed-text | ~270 MB | simple and light |
| mxbai-embed-large | ~670 MB | good in English |

Using a chat model for embeddings works with `--pooling mean` (the app adds it for you), but it is slower and less accurate.

**Changed the model?** The vector dimension changes: use **Clear index** and index again.

## Reranker (optional)

A second model reads question + excerpt and reorders the candidates. Start a *reranking* model (e.g. the `bge-reranker` family) with `--embedding --pooling rank --reranking` and turn it on in **Search**. Without the server, the app keeps the normal order and warns you. The exact endpoint format varies between servers; the app tries `/v1/rerank`, `/rerank` and `/reranking`.

## Windows: 4 GB limit

On Windows an `.exe` file cannot exceed 4 GB. For larger models, use Ollama (*External server* mode) or the llamafile executable with `-m path/model.gguf` in **Extra arguments**.

## Memory (RAM)

Each server loads its own model. Chat + embeddings together need RAM for both. If it runs out, the server closes while starting and the app shows the last lines of the log.
