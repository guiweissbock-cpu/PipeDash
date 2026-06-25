# Guia de Versionamento — PipeDash

Fluxo obrigatório para qualquer alteração no projeto. Nunca editar direto na `main`.

---

## 1. Antes de qualquer mudança — criar backup da branch

```bash
# Verificar estado atual
git status

# Criar branch de trabalho
git checkout -b ajuste/nome-da-feature
```

**Exemplos de nome:**
```
ajuste/filtro-visao-geral
ajuste/novo-grafico-meta
fix/calculo-reunioes
feat/exportar-pdf
```

> A `main` só recebe código aprovado localmente. Nunca editar direto nela.

---

## 2. Testar localmente antes de qualquer commit

Com o servidor rodando:

```bash
node server.js
```

Acessar em: `http://localhost:3001`

> **Nota:** PipeDash roda na porta **3001** (Report-Meta usa a 3000).

Verificar:
- A funcionalidade alterada funciona corretamente
- Nenhuma aba ou seção quebrou
- Console do navegador sem erros críticos

Só avançar para o próximo passo após aprovação local.

---

## 3. Commit com nome claro

```bash
git add .
git commit -m "Ajusta filtro mestre da visão geral"
```

**Padrão de mensagem:**
| Prefixo | Quando usar |
|---------|-------------|
| `feat:` | Nova funcionalidade |
| `fix:` | Correção de bug |
| `ajuste:` | Ajuste pequeno em existente |
| `refactor:` | Reorganização sem mudar comportamento |
| `docs:` | Só documentação |
| `config:` | Variáveis, portas, ambiente |

---

## 4. Enviar para produção (após aprovação local)

```bash
# Voltar para main
git checkout main

# Incorporar a branch testada
git merge ajuste/nome-da-feature

# Enviar para GitHub → Vercel faz deploy automático em ~10s
git push origin main
```

> **Nunca** usar `vercel --prod` diretamente. O deploy deve sempre vir de um push para `main` no GitHub.

---

## 5. Criar tag de versão estável

Após confirmar que o deploy está funcionando na Vercel:

```bash
git tag vAAAA-MM-DD-descricao
git push origin --tags
```

**Exemplos:**
```bash
git tag v2026-06-25-remove-creative-studio
git push origin --tags

git tag v2026-06-24-live-estavel
git push origin --tags
```

As tags servem como pontos de restauração nomeados.

---

## 6. Como voltar para a última versão estável

**Opção A — Ver qual é a última tag estável:**
```bash
git tag --sort=-creatordate | head -5
```

**Opção B — Restaurar local para uma tag específica (sem afetar produção):**
```bash
git checkout v2026-06-25-remove-creative-studio
```

**Opção C — Reverter produção para uma tag (deploy de emergência):**
```bash
# Criar branch de hotfix a partir da tag
git checkout -b hotfix/rollback v2026-06-24-live-estavel

# Depois de testar local:
git checkout main
git merge hotfix/rollback
git push origin main
# Vercel faz re-deploy automático
```

> Nunca usar `git push --force` na main sem avisar o time.

---

## 7. Verificar se local está igual ao último deploy

```bash
# Hash do commit local
git rev-parse --short HEAD

# Hash no rodapé do dashboard (localhost:3001)
# Deve mostrar: v2.x.x · <hash> · development
```

Se os hashes baterem, local e produção estão sincronizados.

---

## 8. Credenciais e arquivos sensíveis

- `.env` — nunca versionar, está no `.gitignore`
- `.env*` — todos protegidos pelo `.gitignore`
- Para replicar o ambiente: copiar `.env.example` → `.env` e preencher os valores

```bash
cp .env.example .env
# Preencher os tokens manualmente
```

---

## Resumo rápido

```
1. git checkout -b ajuste/minha-feature
2. [editar código]
3. Testar em localhost:3001
4. git add . && git commit -m "descrição clara"
5. git checkout main && git merge ajuste/minha-feature
6. git push origin main          ← Vercel deploya automaticamente
7. git tag vAAAA-MM-DD-desc && git push origin --tags
```
