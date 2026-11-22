# Contribuindo

*(English: [CONTRIBUTING.md](../../CONTRIBUTING.md))*

Obrigado por querer ajudar! Qualquer contribuição é bem-vinda: correções, formatos de arquivo novos, tradução, documentação, testes.

## Ambiente

Requisitos: **Node 20+** (22 recomendado) e Git.

```bash
git clone https://github.com/natancabraldev/llamafile-brain.git
cd llamafile-brain
npm install
npm start            # Linux: se reclamar do "SUID sandbox", use npm run start:linux ou npm run start:dev
npm test             # testes unitários e de integração (servidores simulados)
npm run e2e          # abre o Electron de verdade (Linux headless: xvfb-run -a npx electron test/e2e/electron-e2e.js --no-sandbox)
npm run setup        # instala OCR/LibreOffice (opcional, para os testes que usam essas ferramentas)
```

## Estrutura

Veja [docs/ARCHITECTURE.md](ARCHITECTURE.md). Em resumo: `src/core/` é a lógica (sem Electron, testável em Node puro), `src/main.js` liga tudo ao Electron e `src/renderer/` é a interface.

## Regras do projeto

1. **Privacidade primeiro.** Nada do usuário sai da máquina sem ação explícita e visível. Não adicione telemetria.
2. **Sem módulos nativos.** O SQLite é o `node:sqlite` embutido no Electron. Dependências novas precisam de bom motivo.
3. **Segurança do renderer.** Sem `innerHTML` com conteúdo do modelo ou de arquivos; novas chamadas IPC entram na lista do `src/preload.js` e validam os argumentos no `main.js`.
4. **Teste o que mudar.** Lógica nova em `src/core/` precisa de teste em `test/`. Mudança de interface: ajuste `test/ui.test.js` e o e2e.
5. **Textos da interface em português** (pt-BR). Código e comentários podem ser em inglês ou português.

## Como adicionar um formato de arquivo

1. Em `src/core/indexer.js`, adicione a extensão ao conjunto certo e uma função de extração em `extractText`.
2. Retorne **texto puro**; para planilhas/slides, siga o padrão existente (`## Planilha: …`, `## Slide n`).
3. Acrescente um teste em `test/formats.test.js` com um arquivo de verdade.
4. Documente no README.

## Commits e Pull Requests

- Mensagens no estilo [Conventional Commits](https://www.conventionalcommits.org/pt-br/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Um PR = um assunto. Preencha o modelo de PR e atualize o `CHANGELOG.md`.
- O CI roda `npm test` no Linux e no macOS e o teste e2e no Linux.

## Relatando erros

Use o modelo de issue e inclua sistema operacional, modelos usados e as últimas linhas da aba **Logs** (sem dados pessoais).

## Código de conduta

Veja [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
