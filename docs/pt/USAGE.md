# Guia de uso

*(English: [docs/USAGE.md](../USAGE.md))*

Do zero até conversar com os seus documentos.

## 1. Escolha os modelos

Você precisa de **dois** modelos (veja [MODELS.md](MODELS.md)):

| Para | Exemplo | Observação |
|---|---|---|
| **Conversar** (Chat) | um `.llamafile` como `Qwen3.5-2B-Q8_0.llamafile` | baixe em [mozilla-ai/llamafile_0.10](https://huggingface.co/mozilla-ai/llamafile_0.10) |
| **Embeddings** (entender seus textos) | `embeddinggemma` pelo Ollama | modelo pequeno feito para isso |

Atalho com Ollama (opcional): instale o [Ollama](https://ollama.com) e rode `ollama pull embeddinggemma`.

## 2. Configure os servidores (aba **Servidores**)

**Chat:** Modo *Iniciar llamafile* → escolha o arquivo (`…`) → Processamento: *Automático* (ou *Só CPU*) → **Iniciar**. Espere o selo ficar **rodando** (o primeiro carregamento demora).

**Embeddings:**
- Com Ollama: Modo *Servidor externo*, URL `http://127.0.0.1:11434`, modelo `embeddinggemma`.
- Só com llamafile: Modo *Iniciar llamafile*, escolha o arquivo, porta `8081`. O app já usa `--embedding --pooling mean`.

> Use portas diferentes para cada servidor (chat 8080, embeddings 8081, reranker 8082).

## 3. Escolha o que ler (aba **Conhecimento**)

1. **Pastas de documentos** → *Adicionar pasta*. O app **só** lê o que estiver aqui.
2. **Pasta brain (suas notas)** → uma pasta com notas `.md` suas (decisões, padrões, glossário). Elas têm prioridade nas respostas, e a memória é exportada para lá (`memory.md`).
3. **Banco SQLite** → onde fica o índice (`brain.sqlite`). Padrão: a pasta de dados do app. Escolha outra se quiser (por exemplo, um disco maior).
4. **Ignorar** → um item por linha (`prontuario`, `*.zip`, `rascunhos`).
5. Clique em **Indexar**. Com *reindexar automaticamente* ligado, arquivos novos ou alterados entram sozinhos.

Quando terminar, o app mostra quantos arquivos foram lidos e **quais falharam e por quê**.

## 4. Converse

Pergunte normalmente. Exemplos:

- "Resuma o contrato de locação."
- "Onde falamos sobre prazo de entrega?"
- "Liste os arquivos da pasta." / "Resuma a pasta."

As respostas citam as fontes (`[1] arquivo.md:10-24`). Clique na fonte para abrir o arquivo.

## 5. Memória

| Você diz | O app faz |
|---|---|
| `lembre que meu time usa pnpm` | guarda a informação |
| `o que você lembra?` | lista as memórias |
| `esqueça #3` ou `esqueça pnpm` | apaga |

Há também um **perfil fixo** (aba **Memória**) que vai em todas as conversas: nome, função, como prefere as respostas.

## 6. "Treinar" com seus documentos

O app **não treina nem altera** o modelo. Ele usa **RAG**: indexa os documentos e entrega ao modelo apenas os trechos relevantes a cada pergunta. Vantagens: sem custo de treino, atualiza na hora (basta salvar o arquivo) e dá para citar a fonte.

Para melhorar os resultados:

1. **Escreva notas na pasta brain** com decisões e explicações em linguagem direta.
2. **Use bons nomes de arquivo e títulos** (a busca usa o título da seção).
3. **Meça com a aba Avaliação:** escreva perguntas reais no formato `pergunta => parte do nome do arquivo esperado` e veja a taxa de acerto. Ajuste (peso vetor × palavras, top-k, modelo de embeddings) e meça de novo.
4. Se os trechos certos aparecem mas a ordem é ruim, teste o **Reranker**.
5. Trocou o modelo de embeddings? **Limpe o índice e indexe de novo.**

## 7. Desempenho

- Aba **Busca**: reduza *Limite de contexto*, *Trechos por pergunta* e *Turnos de histórico* para respostas mais rápidas.
- Aba **Servidores**: *Usar GPU* se tiver placa compatível; um modelo menor também acelera.
- *Limite de tokens da pergunta* evita enviar textos enormes por engano.

## 8. OCR e formatos antigos (aba **Instalação**)

Para ler imagens e PDFs escaneados, instale Tesseract e Poppler; para `.doc/.xls/.ppt/.rtf`, o LibreOffice. A aba **Instalação** faz isso com um clique (pede confirmação). Depois ative o OCR e escolha os idiomas (`por+eng`).

## 9. Idioma da interface

Use o seletor no topo da barra lateral para alternar entre **English**, **Português** e **Español**. A escolha fica salva. O modelo responde no idioma da sua pergunta, seja qual for o idioma da interface.
