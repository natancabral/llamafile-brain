# Gerando releases

*(English: [docs/RELEASING.md](../RELEASING.md))*

O projeto usa o [electron-builder](https://www.electron.build/). A configuração está no campo `build` do `package.json`.

## O que é gerado

| Sistema | Arquivos | Arquiteturas |
|---|---|---|
| **Ubuntu / Debian** | `.deb` | x64 |
| **Fedora / openSUSE** | `.rpm` | x64 |
| Linux (qualquer) | `.AppImage`, `.tar.gz` | x64 |
| **Windows** | instalador `.exe` (NSIS) e `.exe` portátil | **64 bits (x64) e 32 bits (ia32)** |
| **macOS** | `.dmg` e `.zip` | Intel (x64) e Apple Silicon (arm64) |

O Electron não oferece mais Linux de 32 bits.

## Opção 1 — Tudo de uma vez pelo GitHub (recomendado)

1. Atualize a versão em `package.json` e o `CHANGELOG.md`.
2. Faça o commit e crie a tag:
   ```bash
   git tag v0.2.0
   git push origin main --tags
   ```
3. O workflow **Release** (`.github/workflows/release.yml`) compila em Linux, Windows e macOS e publica uma **GitHub Release** com todos os instaladores e o `SHA256SUMS.txt`.

Também dá para rodar manualmente em *Actions → Release → Run workflow* (gera os arquivos como artefatos, sem publicar).

## Opção 2 — Na sua máquina

```bash
npm install            # ou: yarn
npm run release          # o que o seu sistema consegue gerar
npm run release:linux    # .deb .rpm .AppImage .tar.gz
npm run release:win      # Windows 64 e 32 bits
npm run release:mac      # .dmg e .zip (só em um Mac)
npm run release:all      # tenta os três
```

Os arquivos ficam em `dist/` com o `SHA256SUMS.txt`. O script confere os pré-requisitos e explica o que falta:

| Gerar… | …em | Precisa de |
|---|---|---|
| Linux | Linux | `rpmbuild` (`sudo apt install rpm` ou `sudo dnf install rpm-build`) |
| Windows | Windows | nada |
| Windows | Linux/macOS | Wine (`sudo apt install wine64`) — ou use o GitHub Actions |
| macOS | macOS | nada |
| macOS | Linux/Windows | **não é possível** — use um Mac ou o GitHub Actions |
| Linux | Windows | use o WSL (Ubuntu) ou o GitHub Actions |

Teste rápido sem instaladores: `npm run release -- --dir` (só empacota em `dist/<sistema>-unpacked`).

## Assinatura de código

Os instaladores saem **sem assinatura** (não há certificado no projeto). Consequências para quem baixa:

- **Windows:** o SmartScreen avisa "app não reconhecido" → *Mais informações → Executar assim mesmo*.
- **macOS:** o Gatekeeper bloqueia. Clique com o botão direito → *Abrir*, ou rode `xattr -cr "/Applications/Llamafile Brain.app"`.

Para assinar, configure os segredos do certificado no repositório e remova `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` do workflow (veja a [documentação do electron-builder](https://www.electron.build/code-signing)).

## Ícones

`assets/icon.svg` é a fonte. `npm run icons` (ou `yarn icons`) regenera `build/icon.png`, `build/icons/*.png` (Linux), `build/icon.ico` (Windows) e `build/icon.icns` (macOS) — precisa de `rsvg-convert` e ImageMagick; o `.icns` é escrito pelo próprio script, então não precisa de um Mac.

## Checklist de uma release

- [ ] `npm test` e `npm run e2e` passam
- [ ] `CHANGELOG.md` e versão atualizados
- [ ] Tag `vX.Y.Z` enviada
- [ ] Release publicada com os 5 tipos de instalador e o `SHA256SUMS.txt`
- [ ] Instalou e abriu em pelo menos um sistema de cada família
