# Deploy Process — PipeDash

## Regra de ouro

**Local → GitHub → Vercel.**  
Nunca editar código diretamente na Vercel. Nunca fazer deploy manual via CLI sem commit no GitHub.

---

## Branches

| Branch | Finalidade |
|--------|-----------|
| `main` | Produção — qualquer push aqui dispara deploy automático na Vercel |
| `develop` | Desenvolvimento e testes — não conectada ao deploy de produção |
| `feature/nome` | Novas funcionalidades — merge em `develop` primeiro, depois em `main` |

---

## Fluxo de deploy padrão

### 1. Trabalhar numa feature

```bash
git checkout develop
git checkout -b feature/nome-da-feature

# ... edita arquivos localmente ...

git status
git add nome-do-arquivo.js          # adicionar arquivos específicos, nunca git add -A cego
git commit -m "feat: descrição clara da alteração"
```

### 2. Testar localmente antes de qualquer merge

```bash
npm install
node server.js
# Acesse http://localhost:3000 e valide a feature
```

### 3. Merge em develop (testes)

```bash
git checkout develop
git merge feature/nome-da-feature
git push origin develop
```

### 4. Merge em main e deploy para produção

```bash
git checkout main
git merge develop
git push origin main
# A Vercel detecta o push e inicia o deploy automaticamente.
```

### 5. Validar o deploy

Após o push, acesse o painel da Vercel e confirme:
- Status do deploy: **Ready**
- Commit SHA exibido na Vercel == commit enviado ao GitHub

---

## Versionamento com tags

Marcar toda versão estável com uma tag:

```bash
git tag v2.4.0-live
git push origin v2.4.0-live
```

Convenção de nomes:

| Tipo | Exemplo |
|------|---------|
| Versão de produção | `v2.4.0-live` |
| Hotfix | `v2.4.1-fix-dashboard` |
| Feature major | `v3.0.0-live` |

---

## Checklist antes de todo deploy

- [ ] Código testado localmente em `http://localhost:3000`
- [ ] Nenhum arquivo `.env`, token ou credencial staged (`git status`)
- [ ] `npm install` rodou sem erros
- [ ] Commit tem mensagem clara e descritiva
- [ ] Branch correta: está em `main` antes do push final

---

## Regras de segurança

- `.env` e todos os arquivos `.env*` estão no `.gitignore` — **nunca remover essa linha**
- Tokens e credenciais ficam **somente** no `.env` local e nas variáveis de ambiente da Vercel
- A pasta `.vercel/` também está no `.gitignore`
- Variáveis de ambiente são gerenciadas pelo painel da Vercel (Settings → Environment Variables)

---

## Sincronizar variáveis de ambiente da Vercel para local

```bash
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"   # necessário no Windows
vercel env pull .env.vercel --environment production --yes
```

O arquivo `.env.vercel` gerado é gitignored automaticamente. Use-o apenas para comparar chaves — não substitua seu `.env` diretamente.

---

## Recuperar versão de produção localmente

Caso precise restaurar o estado exato de um deploy:

```bash
# Descubra o commit SHA no painel da Vercel ou no GitHub
git checkout <commit-sha>
git checkout -b hotfix/descricao
```

---

## Estado atual do projeto (baseline — 24/06/2026)

| Ambiente | Branch | Commit |
|----------|--------|--------|
| Local | `main` | `fd0e488` |
| GitHub (`origin/main`) | `main` | `fd0e488` |
| Vercel (produção) | `main` | `fd0e488` |

Todos os ambientes sincronizados em: `fd0e488`
