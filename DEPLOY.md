# Deploy em produção — VPS Hostinger + EasyPanel

Infra real em que este gateway roda hoje. Complementa o `README.md` (que cobre a
aplicação em si) e o `HANDOFF.md` (histórico de decisões de produto).

Última revisão: 29/07/2026.

---

## 1. Visão geral

| Item | Valor |
|---|---|
| VPS | Hostinger KVM 2, Ubuntu 24.04 LTS, 100 GB |
| IP | `179.198.96.125` |
| Painel | EasyPanel (Docker Swarm + Traefik) — `https://vps.bmdholding.com.br` |
| App | `https://whatsapp.bmdholding.com.br` |
| Projeto/serviço | `whatsapp-gateway` / `gateway` |
| Container | `whatsapp-gateway_gateway.1.<task>` |
| Banco + Storage | Supabase (externo — não roda nada de banco na VPS) |

O EasyPanel provê o proxy reverso (Traefik) e o SSL via Let's Encrypt. **Não há
nginx nesta VPS** — o WebSocket de `/api/whatsapp/stream` passa pelo Traefik sem
configuração extra de `Upgrade`/`Connection`, diferente do que a seção 5 do
README descreve para nginx.

---

## 2. Como o deploy funciona

```
git push (branch main)
  └─> EasyPanel: build da imagem via Dockerfile
        └─> easypanel/whatsapp-gateway/gateway:latest
              └─> Swarm substitui a task em execução
```

O build usa o `Dockerfile` da raiz do repositório. Configuração no painel:

- **Source**: Github → `DAP-Advocacia/whatsapp-crm-gatway`, branch `main`
  (o campo espera `owner/repo`, não a URL completa)
- **Build**: Dockerfile, arquivo `Dockerfile`
- **Port**: `3333`

> ✅ **Webhook de deploy automático resolvido em 31/07/2026.** A integração
> Github↔EasyPanel (Settings → Github) de fato nunca chegou a ser
> estabelecida (Source preenchido manualmente). Em vez de refazer aquele
> fluxo, cadastramos direto um webhook no repositório do GitHub
> (`Settings → Webhooks` no repo, evento `push`) apontando pra
> **Deployment Trigger** que já existe na aba Deployments deste serviço
> (`http://179.198.96.125:3000/api/deploy/<token>` — token visível/renovável
> ali, botão "Refresh Deploy Token" se precisar invalidar o atual). Testado
> com `pings` da API do GitHub, entrega `status: OK, 200`. `git push` agora
> dispara o deploy sozinho, sem precisar clicar em nada no painel.
>
> Verificar `last-modified` confirma qual build está no ar:
> ```bash
> curl -sI https://whatsapp.bmdholding.com.br | grep -i last-modified
> ```

### Node 22 é obrigatório

O `Dockerfile` fixa `node:22-bookworm-slim`. **Não baixe para o 20**: o
`@supabase/realtime-js` usa o `WebSocket` global, que só existe nativamente a
partir do Node 22. Com o 20 o processo morre no boot, em `src/media.js:14`:

```
Error: Node.js detected but native WebSocket not found.
```

O sintoma no build é um `npm warn EBADENGINE ... required: { node: '>=22.0.0' }`
— um aviso que na prática é fatal em runtime.

---

## 3. Persistência da sessão do WhatsApp (crítico)

As credenciais do Baileys ficam num **bind mount**, não num volume nomeado:

| Host | Container |
|---|---|
| `/srv/whatsapp-gateway-data/auth_session` | `/app/auth_session` |

E a env var precisa casar com o destino:

```
AUTH_FOLDER=/app/auth_session
```

> ⚠️ Não use o `AUTH_FOLDER=./auth_session` do `.env.example` — aquele valor é de
> desenvolvimento. Caminho relativo faz o app gravar fora do mount, e todas as
> instâncias pedem QR Code de novo.

Confirmar que o mount pegou:

```bash
docker inspect $(docker ps -q -f name=whatsapp-gateway_gateway) --format '{{json .Mounts}}'
```

Nos logs, o sinal de que funcionou é `[sessions] retomando sessão salva: <id>`.

### Backup

```bash
tar -czf /root/auth_session-backup-$(date +%Y%m%d).tar.gz \
  -C /srv/whatsapp-gateway-data auth_session
```

Vale rodar antes de qualquer mexida em deploy ou volume.

---

## 4. Reiniciar o serviço

O EasyPanel roda em **Docker Swarm**, então `docker restart` na task não é o
comando certo — o Swarm trata a task como unhealthy e cria outra, e é possível
acabar com múltiplas rodando ao mesmo tempo. Isso é grave aqui: **Baileys é
stateful**, e duas instâncias lendo o mesmo `auth_session` corrompem as
credenciais.

```bash
# certo
docker service update --force whatsapp-gateway_gateway

# ou o botão Restart na UI do EasyPanel
```

Nunca escale este serviço acima de 1 réplica, pelo mesmo motivo.

---

## 5. Variáveis de ambiente

Ficam na aba **Environment** do serviço (não em `.env` no host). A lista completa
e o que cada uma faz está no `.env.example`; os valores de produção estão no
painel.

Pontos de atenção:

- `AUTH_FOLDER=/app/auth_session` — ver seção 3
- `PUBLIC_URL=https://whatsapp.bmdholding.com.br`
- `DATABASE_URL` / `DIRECT_URL` — a senha do Postgres precisa vir
  **URL-encoded** (`@` → `%40`), senão a conexão falha
- `AUTH_TOKEN_SECRET` — trocar desloga todos os usuários do app de uma vez
- `BITRIX_PORTAL_DOMAIN` / `BITRIX_MEMBER_ID` — ver seção 5.1
- A opção **Create env file** grava um `.env` dentro do container, redundante com
  as env vars do Swarm. Pode ficar desligada.

### 5.1 Trocar de portal Bitrix (nuvem → on-premise, ou outro portal)

**Quatro** variáveis apontam para o Bitrix, e é fácil trocar só as óbvias:

| Variável | Observação |
|---|---|
| `BITRIX_PORTAL_DOMAIN` | só o host — sem `https://`, sem barra final |
| `BITRIX_MEMBER_ID` | **muda junto com o portal** |
| `BITRIX_WEBHOOK_URL` | webhook novo, gerado no portal novo |
| `PUBLIC_URL` | só muda se o domínio do app mudar |

`BITRIX_PORTAL_DOMAIN` é a que passa despercebido: [`src/auth.js`](src/auth.js) monta
`https://${BITRIX_PORTAL_DOMAIN}/rest/user.current.json?auth=…` para validar o
token do usuário. Apontando para o portal antigo, o token do portal novo é
rejeitado e **toda** tela mostra `Falha ao carregar: falha ao autenticar com o
Bitrix` (o `POST /api/auth/verify` responde `401`).

O `member_id` novo sai do log da instalação do app:

```bash
docker service logs whatsapp-gateway_gateway --tail 200 | grep bitrix
```

> ⚠️ **Trocar `BITRIX_MEMBER_ID` órfã os dados existentes.** O `ownerId` é
> `${BITRIX_MEMBER_ID}_${userId}`, então instâncias, conversas e mensagens do
> portal antigo deixam de ser visíveis — é preciso reconectar as instâncias
> (QR Code novo). Para preservar, um `UPDATE` trocando o prefixo do `ownerId`
> nas tabelas resolve.

Se o erro de autenticação persistir mesmo com o domínio certo, as duas causas
seguintes são específicas de on-premise:

1. **Módulo REST inacessível externamente** — testar de dentro do container:
   `curl "https://<portal>/rest/user.current.json?auth=<token>"`
2. **Certificado autoassinado ou cadeia incompleta** — o `fetch()` do Node falha
   e o `catch` devolve `null`, dando o mesmo erro na tela. Distinguir pelo log:
   `[auth] falha ao verificar token com o Bitrix: <mensagem TLS>`

> 🔒 `docker inspect` imprime **todas** as env vars em claro. Ao inspecionar em
> troubleshooting, filtre o que for colar em qualquer lugar:
> ```bash
> docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' | sed 's/=.*/=***/'
> ```

---

## 6. Domínios e SSL

Emissão automática via Let's Encrypt pelo Traefik. O e-mail do ACME fica em
`Settings → General → Let's Encrypt Email`.

- **Domínio do painel**: `Settings → General → Panel Domain → Custom Domain`.
  O toggle *Serve on IP address* mantém o acesso por `IP:3000` como reserva —
  útil para não ficar trancado fora se um certificado falhar.
- **Domínio do app**: aba **Domains** dentro do serviço (host, porta `3333`,
  HTTPS ligado). O Traefik termina o TLS; o destino interno é HTTP.

Depois de salvar, o certificado pode levar alguns minutos. Enquanto isso o
Traefik serve um certificado autoassinado — sintoma:

```
curl: (60) SSL certificate problem: self-signed certificate
```

Isso normalmente se resolve sozinho. Se persistir, checar o log:

```bash
docker service logs easypanel-traefik --tail 50 2>&1 | grep -Ei 'acme|certificate|error'
```

Nunca ter duas regras de domínio para o mesmo host — elas conflitam no Traefik.

---

## 7. Scripts de manutenção

Rodam da máquina local, com um `.env` que tenha `DIRECT_URL` e as chaves do
Supabase. Exigem `--yes` porque são irreversíveis.

```bash
npm install --omit=dev          # se não houver node_modules local

node db/migrate.js              # aplica db/schema.sql (idempotente)
node db/reset-storage.js --yes  # esvazia os buckets "media" e "public-assets"
node db/reset-test-data.js --yes # TRUNCATE nos dados de teste
```

O `reset-test-data.js` preserva `app_settings` e `message_templates`, e imprime a
contagem antes/depois. Limpar as sessões do disco é passo separado, na VPS:

```bash
rm -rf /srv/whatsapp-gateway-data/auth_session/*
docker service update --force whatsapp-gateway_gateway
```

O restart é necessário porque o `SessionManager` mantém sessões em memória.

> Enquanto houver gente usando a aba no Bitrix, novas instâncias vão sendo
> criadas continuamente. Para uma limpeza estável, faça fora do horário de uso.

---

## 8. Diagnóstico

```bash
# o container está de pé?
docker ps --filter name=whatsapp-gateway_gateway --format '{{.ID}} {{.Names}} {{.Status}}'

# quantas réplicas o Swarm acha que deveria ter?
docker service ls | grep gateway

# logs (docker service logs funciona mesmo com a task morta — útil quando o
# processo cai no boot e docker ps volta vazio)
docker service logs whatsapp-gateway_gateway --tail 50

# o domínio responde?
curl -I https://whatsapp.bmdholding.com.br
```

| Sintoma | Causa provável |
|---|---|
| `502` no domínio | processo morreu no boot — ver logs do serviço |
| `Service is not reachable` (página do EasyPanel) | idem |
| `native WebSocket not found` | build com Node < 22 (seção 2) |
| pede QR para todas as instâncias | `AUTH_FOLDER` relativo ou bind mount ausente (seção 3) |
| `falha ao autenticar com o Bitrix` em todas as telas | `BITRIX_PORTAL_DOMAIN` aponta para o portal errado (seção 5.1) |
| instâncias antigas desaparecem da lista | `BITRIX_MEMBER_ID` mudou — `ownerId` órfão (seção 5.1) |
| `last-modified` antigo | o deploy não rodou (seção 2) |
| `something is already running on port 80` no instalador | o EasyPanel **já está instalado** — não reinstalar |

---

## 9. Segurança da VPS

Configurado:

- **UFW** ativo no boot, liberando 22, 80, 443 e 3000
- **fail2ban** instalado (jail `sshd`)
- **Monarx** (antimalware da Hostinger) — vem no template, aparece como
  repositório apt `repository.monarx.com`

> ⚠️ **UFW não filtra portas publicadas por containers.** O Docker escreve direto
> no `iptables` e contorna o UFW. As portas 80/443/3000 estão acessíveis porque
> são publicadas pelo Traefik e pelo EasyPanel, independentemente das regras.
> Para fechar de fato uma porta de container, é preciso mudar a publicação dela.

Pendências conhecidas:

- Login `root` por senha ainda habilitado (`ssh root@179.198.96.125`)
- Porta 3000 (UI do EasyPanel) exposta a qualquer origem — poderia ser
  restringida ao IP do escritório, ou fechada agora que há domínio com HTTPS

### Vazamento de segredos — lições desta VPS

Duas fontes de vazamento apareceram em produção e valem como regra permanente:

1. **`docker inspect`** imprime env vars em claro (ver seção 5).
2. **`console.log` de payload do Bitrix** — `src/server.js` logava o corpo do
   `POST /` inteiro, incluindo `AUTH_ID`, `REFRESH_ID` e `APPLICATION_TOKEN`.
   Corrigido em 29/07/2026 para logar só `event`, `PLACEMENT` e `member_id`.

O `REFRESH_ID` e o `APPLICATION_TOKEN` **não expiram sozinhos** — só uma
reinstalação do app local no Bitrix os revoga.

---

## 10. Renomear a aba no Bitrix

Os títulos vêm de `placement.bind` em `src/server.js` (`CRM_DEAL_DETAIL_TAB` e
`CRM_DEAL_DETAIL_TOOLBAR`), hoje `DapZAP` nos dois.

`placement.bind` roda **só na instalação**. Trocar o código e dar deploy não
renomeia o que já está registrado no portal — é preciso **reinstalar o app local**
no Bitrix24. O código já faz `placement.unbind` antes do `bind`, justamente para
reinstalações.

O nome do *app* na lista de Aplicativos é um campo do cadastro no Bitrix, não do
código.

---

## 11. Histórico

O deploy original (jul/2026) foi feito com `docker run` manual: sem labels, sem
compose, fora do controle do EasyPanel, com Node 24 e a imagem
`whatsapp-gateway:latest` como único artefato — não havia Dockerfile versionado.

Em 29/07/2026 migrou para serviço gerenciado pelo EasyPanel, buildando do GitHub,
com Dockerfile no repositório. O container antigo foi preservado como
`whatsapp-gateway-old` (parado) e a definição salva em
`/root/whatsapp-gateway-inspect.json` — de onde se pegam os valores atuais das
env vars. Ambos podem ser removidos depois que as credenciais forem rotacionadas:

```bash
docker rm whatsapp-gateway-old
docker rmi whatsapp-gateway:latest
```
