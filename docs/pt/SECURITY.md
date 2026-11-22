# Segurança

*(English: [SECURITY.md](../../SECURITY.md))*

## Versões com suporte
Apenas a versão mais recente recebe correções.

## Modelo de segurança (resumo)

- **Local por padrão:** o app só fala com os servidores que você configura (por padrão `127.0.0.1`). Não há telemetria.
- **Pastas permitidas:** só lê as pastas que você adiciona. Links simbólicos não são seguidos; `open:path` só abre arquivos dentro delas.
- **Segredos:** `.env`, chaves (`.pem`, `.key`, `id_rsa`…), `credentials*` e `secrets.*` nunca são indexados.
- **Renderer isolado:** `contextIsolation`, `sandbox`, CSP restritiva e lista fixa de chamadas IPC. O Markdown é montado via DOM (sem `innerHTML`); links só `http(s)` e `mailto`.
- **Instalação de dependências:** só roda depois de uma janela de confirmação com o comando exato.
- **Memória:** só é gravada por comandos explícitos do usuário, nunca pelo modelo.

## O que está fora de escopo
Conteúdo gerado por modelos (erros, alucinações) e vulnerabilidades dos próprios modelos/servidores (llamafile, Ollama) — relate esses nos projetos deles.
