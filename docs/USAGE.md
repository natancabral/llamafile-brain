# Usage guide

From zero to chatting with your documents. *(Português: [docs/pt/USAGE.md](pt/USAGE.md))*

## 1. Choose the models

You need **two** models (see [MODELS.md](MODELS.md)):

| For | Example | Note |
|---|---|---|
| **Chatting** (Chat) | a `.llamafile` such as `Qwen3.5-2B-Q8_0.llamafile` | download it from [mozilla-ai/llamafile_0.10](https://huggingface.co/mozilla-ai/llamafile_0.10) (the **llamafile** column) |
| **Embeddings** (understanding your texts) | `embeddinggemma` through Ollama | a small model made for this |

Optional shortcut with Ollama: install [Ollama](https://ollama.com) and run `ollama pull embeddinggemma`.

## 2. Set up the servers (**Servers** tab)

**Chat:** Mode *Start llamafile* → pick the file (`…`) → Processing: *Automatic* (or *CPU only*) → **Start**. Wait for the badge to read **running** (the first load takes a while).

**Embeddings:**
- With Ollama: Mode *External server*, URL `http://127.0.0.1:11434`, model `embeddinggemma`.
- With llamafile only: Mode *Start llamafile*, pick the file, port `8872`. The app already uses `--embedding --pooling mean`.

> Use a different port for each server (chat 8871, embeddings 8872, reranker 8873).

## 3. Choose what to read (**Knowledge** tab)

1. **Document folders** → *Add folder*. The app reads **only** what is in here.
2. **Brain folder (your notes)** → a folder with your own `.md` notes (decisions, conventions, glossary). They get priority in answers, and the memory is exported there (`memory.md`).
3. **SQLite database** → where the index lives (`brain.sqlite`). Default: the app's data folder. Pick another if you like (for example a bigger disk).
4. **Ignore** → one item per line (`private`, `*.zip`, `drafts`).
5. Click **Index now**. With *reindex automatically* on, new or changed files are picked up on their own.

When it finishes, the app shows how many files were read and **which ones failed and why**.

## 4. Chat

Ask normally. Examples:

- "Summarize the lease contract."
- "Where did we talk about the delivery deadline?"
- "List the files in the folder." / "Summarize the folder."

Answers cite their sources (`[1] file.md:10-24`). Click a source to open the file.

## 5. Memory

| You say | The app does |
|---|---|
| `remember that my team uses pnpm` | stores it |
| `what do you remember?` | lists the memories |
| `forget #3` or `forget pnpm` | deletes it |

The commands also work in Portuguese (`lembre que…`, `esqueça…`) and Spanish (`recuerda que…`, `olvida…`).

There is also a **fixed profile** (**Memory** tab) that goes into every conversation: name, role, how you like answers.

## 6. Training on your documents

The app **does not train or change** the model. It uses **RAG**: it indexes your documents and hands the model only the relevant excerpts for each question. Advantages: no training cost, instant updates (just save the file) and the source can be cited.

To improve results:

1. **Write notes in the brain folder** with decisions and explanations in plain language.
2. **Use good file names and headings** (search uses the section title).
3. **Measure with the Evaluation tab:** write real questions as `question => part of the expected file name` and look at the hit rate. Adjust (vector × keyword weight, top-k, embeddings model) and measure again.
4. If the right excerpts show up but the order is poor, try the **Reranker**.
5. Changed the embeddings model? **Clear the index and index again.**

## 7. Performance

- **Search** tab: lower *Context limit*, *Excerpts per question* and *History turns* for faster answers.
- **Servers** tab: *Use GPU* if you have a compatible card; a smaller model also speeds things up.
- *Question token limit* prevents sending huge texts by accident.

## 8. OCR and legacy formats (**Setup** tab)

To read images and scanned PDFs, install Tesseract and Poppler; for `.doc/.xls/.ppt/.rtf`, LibreOffice. The **Setup** tab does it with one click (asking for confirmation). Then enable OCR and choose the languages (`eng+por`).

## 9. Interface language

Use the selector at the top of the sidebar to switch between **English**, **Português** and **Español**. The choice is saved. The model answers in the language of your question, whatever the interface language.
