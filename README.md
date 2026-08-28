# WhatsApp ↔ Bitrix24 Gateway

Gateway em Node.js que conecta **sessões pessoais de WhatsApp** (login por QR Code,
via [Baileys](https://github.com/WhiskeySockets/Baileys) — protocolo não-oficial do
WhatsApp Web) ao **Bitrix24**. Além do chat embutido no card do Negócio, o app inclui
um conjunto de páginas de CRM próprio: disparo em massa (Campanha), agendamento
(Kanban/Calendário), contatos/listas, métricas de campanhas e gestão de múltiplas
instâncias de WhatsApp por usuário.

A aba do card mostra a conversa com o contato daquele Negócio (texto, imagem, áudio e
vídeo), permite gravar e enviar áudio direto do navegador, e recebe mensagens novas
em tempo real (WebSocket).

> ⚠️ **Aviso legal/técnico**: este projeto usa engenharia reversa do WhatsApp Web
> (Baileys), não a API oficial da Meta. Isso viola os Termos de Uso do WhatsApp e o
> número pode ser banido, especialmente com volume comercial (ver §10, Campanha). Use
> por sua conta e risco — para um caminho oficial e suportado, considere a
> [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api).

---

## 1. Arquitetura

### Multi-instância por usuário do Bitrix

Cada **usuário do Bitrix** ("dono") pode conectar **um ou mais números de WhatsApp**
("instâncias"). Ao abrir a aba "WhatsApp" num Negócio, se nenhum WhatsApp ainda
estiver conectado, a própria aba mostra o **QR Code** para escanear. Cada instância
tem credenciais, histórico e status de conexão totalmente independentes das demais —
inclusive de instâncias de outros usuários.

- **Dono** (`ownerId`) = `"<member_id>_<userId>"` (member_id do portal Bitrix + ID do
  usuário logado), resolvido no navegador via `BX24.getAuth()` + `user.current`.
- **Instância** (`sessionId`, usado em toda a API e em todas as tabelas) = o
  identificador técnico de uma conexão WhatsApp específica. A primeira instância de
  cada dono usa `sessionId == ownerId` (compatibilidade — é como o app funcionava
  antes de suportar múltiplas instâncias); instâncias extras ganham um sufixo
  (`<ownerId>__<sufixo>`). Registro em `instances` (Postgres) — ver `src/instances.js`.
- Credenciais Baileys de cada instância ficam em `auth_session/<sessionId>/` — **faça
  backup desta pasta**; perdê-la = a instância precisa ser pareada de novo do zero.
- **Isolamento**: cada página (Campanha, Contatos, Métricas, Agenda de Envios) resolve
  o `ownerId` do usuário logado no próprio navegador e só opera sobre as instâncias
  daquele dono — nunca aparece nem é possível usar a instância de outro usuário. A
  única exceção deliberada é a **Análise de Conversas**, que é uma visão agregada de
  **todas** as sessões (visão gerencial/de time) — ver §8.

### Armazenamento: Supabase (Postgres + Storage)

Schema completo em `db/schema.sql` (rodar com `node db/migrate.js`, idempotente —
pode rodar de novo a qualquer momento sem duplicar nada):

| Tabela | Para quê |
|---|---|
| `conversations` / `messages` | Histórico de mensagens por `(sessionId, phone)`, dedupe por `wa_message_id`. |
| `instances` | Registro de instâncias de WhatsApp por dono (`id`, `owner_id`, `label`). |
| `instance_connection_events` / `instance_metrics_daily` | Alerta de instância caída (§14) — histórico de quedas/retomadas (uma linha por evento) e série diária de métricas (conversas/contatos/grupos). `instance_id` é sempre o `session_id` cru, nunca FK — sobrevive à remoção da instância. |
| `push_subscriptions` | Web Push (§14, Parte FC) — inscrições por `owner_id` (não por instância), múltiplas por dono (vários navegadores/aparelhos). `endpoint` único globalmente, entradas expiradas (404/410 do provedor) são limpas automaticamente. |
| `feed_posts` | Histórico LOCAL de posts publicados no Feed do Bitrix24 (§14.5) — nunca é a fonte de verdade, só registro pra não duplicar anúncio. |
| `contacts` / `contact_lists` / `contact_list_members` | Contatos próprios e listas personalizadas, por **dono** (não por instância — se uma instância cai e o usuário conecta outra, os mesmos contatos/listas continuam aparecendo) — usados na Campanha. |
| `message_templates` | Modelos de mensagem reutilizáveis (corpo com `{{nome}}`/`{{telefone}}`). |
| `campaigns` / `campaign_results` | Histórico de disparos em massa (cabeçalho + resultado por destinatário). |
| `scheduled_campaigns` | Campanhas agendadas pra disparo futuro (Kanban/Calendário), com o payload inteiro (destinatários, texto, mídia em base64) até virarem um envio real. |
| `notifications` | Histórico de notificações por dono (`owner_id`) — Central de Notificações (§15, Kanban/Calendário). |
| `agent_config` | Config do Agente de IA por instância (§14.7) — `active` (nasce `false`), `system_message`, `knowledge_text`. |
| `agent_knowledge_docs` / `agent_knowledge_chunks` | Documentos enviados pra base de conhecimento (status `processing`/`ready`/`error`) e os pedaços de texto com embedding (`vector(1536)`, extensão **pgvector**) usados na busca semântica — §14.7. |
| `agent_retry_queue` | Fila de reenvio quando a instância cai no momento em que o lead manda a mensagem — a resposta é gerada de novo do zero ao reprocessar (§14.7). |
| `agent_example_candidates` / `agent_examples` | Aprendizado few-shot do Agente de IA (§14.8) — fila de candidatas marcadas manualmente (`transcript_raw` com PII de verdade, pro humano revisar) e exemplos já aprovados/anonimizados/com embedding (nunca contém dado bruto). |

- **Mídia** (imagem/áudio/vídeo trocada em conversas): bucket público `media` no
  Supabase Storage. `mediaUrl` nas mensagens é a URL pública direta do arquivo.

### Fluxo de dados (chat)

```
Bitrix24 (aba no card)  <--fetch/WebSocket-->  Express + ws (este gateway)  <--Baileys-->  WhatsApp
                                                        |
                                                        v
                                      Supabase: Postgres (mensagens) + Storage (mídia)
                                                        |
                                                        v
                                    (opcional) crm.timeline.comment.add no Bitrix
```

1. A aba (`public/index.html`) roda dentro de um iframe do Bitrix, identifica o
   Negócio (`dealId`) via SDK `BX24` e autentica (`POST /api/auth/verify`) pra
   obter o `ownerId` verificado e o token de app usado em toda chamada seguinte —
   ver §16.
2. Busca as instâncias desse dono (`GET /api/whatsapp/instances`) — com uma só,
   segue direto; com mais de uma, mostra um seletor no cabeçalho da conversa
   (lembrado por negócio via `localStorage`).
3. Busca o telefone do contato do Negócio (`crm.deal.get` + `crm.contact.get`).
4. Consulta `/api/whatsapp/qr?session=` — se a instância não estiver pareada, mostra
   o QR ali mesmo, com polling a cada 2.5s.
5. Uma vez `online`, carrega o histórico (`/api/whatsapp/history`) e abre um
   WebSocket (`/api/whatsapp/stream`) para receber mensagens novas e mudanças de
   status em tempo real.
6. Envio de texto/imagem/áudio/vídeo passa por `POST /api/whatsapp/send` ou
   `/send-media`, que fala com o WhatsApp via Baileys, salva no Postgres/Storage e
   retransmite (broadcast) para qualquer outra aba aberta na mesma conversa.

### Fluxo de dados (Campanha agendada)

```
POST /campaign/schedule  →  scheduled_campaigns (status: scheduled)
                                     |
              poller a cada 30s (src/scheduler.js) OU drag "Enviar agora" no Kanban
                                     v
                    createCampaign() → campaigns (status: running)
                                     |
                        runCampaign() envia 1 a 1, com delay 4-9s
                                     v
                 scheduled_campaigns.status: sending → sent (linkado por campaign_id)
```

---

## 2. Stack e dependências

- **Node.js** ≥ 20 (CommonJS)
- **express** — HTTP/REST
- **ws** — WebSocket (mesma porta do HTTP, via `server.on('upgrade', ...)`)
- **@whiskeysockets/baileys** `^7.0.0-rc13` — protocolo do WhatsApp Web
- **@supabase/supabase-js** — Storage de mídia (upload + URL pública)
- **pg** — cliente Postgres (todas as tabelas, direto no Supabase)
- **fluent-ffmpeg** + **ffmpeg-static** — converte áudio para OGG/Opus antes de
  enviar (formato que o WhatsApp de fato entrega/reproduz — ver §7)
- **qrcode** — gera o QR como data URL (base64) para exibir na tela
- **pino** — logger interno do Baileys
- **exceljs** — gera o `.xlsx` de exportação de leads (§11.5); deliberadamente não
  se usa a lib `xlsx`/SheetJS em lugar nenhum do projeto (duas vulnerabilidades
  altas sem correção — Prototype Pollution, ReDoS), nem pra ler nem pra gerar planilha
- **cors**, **dotenv**
- **swagger-ui-express** — serve a documentação interativa da API em `GET /api-docs` (§16), a partir do spec OpenAPI em `src/openapi.js`
- **pdf-parse** / **mammoth** — extração de texto de PDF/DOCX enviados na base de conhecimento do Agente de IA (§14.7); TXT/Markdown não precisam de parsing
- **pgvector** (extensão do Postgres, habilitada via `create extension if not exists vector` em `db/schema.sql`) — busca semântica da base de conhecimento (§14.7), sem lib Node dedicada (query SQL direta via `pg`)
- OpenAI (`OPENAI_API_KEY`) via `fetch` cru, sem SDK (`src/openai.js`/`src/embeddings.js`) — chat (`gpt-4o-mini`) e embeddings (`text-embedding-3-small`), modelo sempre fixo, sem opção de escolha em nenhuma tela

Scripts (`package.json`):
```bash
npm start   # node src/server.js
npm run dev # nodemon src/server.js (reinicia sozinho a cada alteração)
```

---

## 3. Instalação e configuração

```bash
npm install
cp .env.example .env
```

Edite o `.env`:

| Var | Uso | Observações |
|---|---|---|
| `PORT` | Porta do gateway (HTTP + WS) | padrão `3333` |
| `AUTH_FOLDER` | Pasta-base das instâncias Baileys; cada uma vira uma subpasta | **faça backup**; persista em disco durável (não em containers efêmeros) |
| `SESSION_STAGGER_MS` | *(opcional)* Intervalo entre reconexões de sessões salvas no boot (`SessionManager.startAllExisting`, `src/sessions.js`) | padrão `15000`ms; existe pra evitar reconectar dezenas de instâncias no mesmo instante a cada redeploy — pico que já derrubou sessões reais mesmo com 4s de intervalo (ver HANDOFF.md, Parte CE) |
| `BITRIX_WEBHOOK_URL` | *(opcional)* Webhook de entrada do Bitrix — timeline do negócio (`crm.timeline.comment.add`) e contato/negócio por lead (`crm.contact.add`/`crm.deal.add`), ver §11.5 | formato `https://SEU-DOMINIO.bitrix24.com.br/rest/USER_ID/WEBHOOK_CODE/`. Precisa de escopo CRM. Como criar: Recursos para desenvolvedores → Outros → Webhook de entrada → marcar CRM → copiar a URL |
| `BITRIX_HR_WEBHOOK_URL` | *(opcional)* Webhook de entrada DEDICADO (separado do de cima) — resolve hierarquia de departamentos pra delegação automática de acesso (gestor vê instâncias de todo subordinado, ver §14) | precisa de DOIS escopos: "Usuários (user)" **e** "Estrutura da empresa (department)" — só "Usuários" não é suficiente, `department.get` falha sem o segundo. Sem esta variável, a feature fica inativa; continua funcionando só a delegação manual. **Falha silenciosa**: se a variável for removida/perdida depois de já estar em produção, não sobra NENHUM log de erro (a checagem corta antes do `fetch`) — só o efeito (cache de hierarquia parado, tela Admin com aviso visível). Já aconteceu de sumir por 8+ dias sem ninguém notar (HANDOFF Parte CS) — depois de editar as Environment Variables no EasyPanel, sempre confirmar que ela sobreviveu ao próximo redeploy |
| `HIERARCHY_CACHE_TTL_HOURS` | *(opcional)* Validade do cache da hierarquia (tabela `hierarchy_subordinates`) antes de recalcular contra o Bitrix | padrão `6` horas |
| `BITRIX_FEED_WEBHOOK_URL` | *(opcional)* Webhook de entrada DEDICADO (separado dos dois de cima) — publica no Feed nativo do Bitrix ("Para todos os colaboradores"), ver §14.5 | precisa do escopo **"Rede Social"** (cobre `log.blogpost.add`). Sem esta variável, o botão "Publicar" falha com mensagem clara — nada mais no sistema é afetado. Publicação é sempre MANUAL, nunca automática a partir de deploy/commit |
| `BITRIX_LEADS_CATEGORY_ID` | *(opcional)* Pipeline ÚNICO e compartilhado onde TODAS as LPs lançam negócio | é o número depois de `/category/` na URL do kanban: `.../crm/deal/kanban/category/<NUMERO>/`. Visibilidade por SDR é permissão nativa do Bitrix (config manual), não código |
| `OPENAI_API_KEY` | *(opcional)* Chave da OpenAI (`platform.openai.com`) usada pelo botão "Gerar com IA" ao encerrar um teste A/B (ver §11.5) | sem ela, o botão mostra erro mas o encerramento continua funcionando com análise manual |
| `ALLOWED_ORIGINS` | Domínio(s) do seu Bitrix24 autorizados no CORS | separe múltiplos por vírgula |
| `PUBLIC_URL` | URL pública deste servidor (ngrok, domínio próprio, etc.) | hoje é só documentação/referência — o fluxo de instalação usa `location.origin` no navegador, não depende desta variável |
| `SUPABASE_URL` | URL do projeto Supabase | `Project Settings → API` |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de acesso privilegiado do backend | `Project Settings → API` → "Secret keys" (chamada de `service_role` na nomenclatura antiga do Supabase) — **nunca** exponha no frontend |
| `DATABASE_URL` | Connection string do Postgres (pooler de transação/pgbouncer) | botão **Connect** no topo do dashboard Supabase → aba URI, porta `6543`, com `?pgbouncer=true` |
| `DIRECT_URL` | Connection string do Postgres (pooler de sessão) | mesmo lugar, porta `5432` — usada só para rodar `db/migrate.js` |
| `DB_POOL_MAX` | *(opcional)* Máximo de conexões simultâneas deste processo com o pooler acima (`src/db.js`) | padrão `10` (mesmo default do `pg`) se não definida. Ajustável sem rebuild — só trocar no EasyPanel e reiniciar. **Confirme o limite do pooler no painel do Supabase antes de subir** — um valor maior do que o Supabase aceita quebra do mesmo jeito que um valor fixo errado quebraria (HANDOFF Parte DH) |
| `BITRIX_PORTAL_DOMAIN` | Domínio do portal Bitrix (ex: `SEU-DOMINIO.bitrix24.com.br`) | usado **só no backend** pra verificar o `access_token` do usuário contra o Bitrix de verdade (`src/auth.js`) — **nunca** vem do cliente, senão um client malicioso poderia apontar pro próprio portal dele e se passar por qualquer `ownerId` |
| `BITRIX_MEMBER_ID` | `member_id` deste portal (o mesmo que compõe `ownerId = member_id_userId`) | fixo no servidor pelo mesmo motivo do domínio acima |
| `AUTH_TOKEN_SECRET` | Segredo pra assinar (HMAC) o token de sessão do próprio app | gere com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `AUTH_TOKEN_TTL_HOURS` | *(opcional)* validade do token do app, em horas | padrão `12` |

### Setup do banco (uma vez, por projeto Supabase novo — ou depois de puxar um schema novo)

```bash
node db/migrate.js         # cria/atualiza todas as tabelas (idempotente)
node db/create-bucket.js   # cria o bucket privado "media" no Storage
```

Migrando um projeto que já tinha o bucket `media` **público** (de antes da
mídia virar privada, ver §7)? Depois de subir o código novo, rode nesta
ordem: `node db/migrate-media-urls.js` (reescreve o histórico de mensagens
pro formato novo) e só então `node db/make-bucket-private.js` (flipa o
bucket) — nessa ordem, pra não deixar mídia quebrada entre os dois passos.

---

## 4. Subir o servidor

```bash
npm start
```

Isso inicia, na mesma porta:
- API REST em `http://localhost:PORT/api/whatsapp/*` e `http://localhost:PORT/api/*` (contatos/listas/modelos)
- WebSocket em `ws://localhost:PORT/api/whatsapp/stream`
- Página de instalação do app Bitrix em `http://localhost:PORT/install`
- Aba do chat em `http://localhost:PORT/` (placements `CRM_DEAL_DETAIL_TAB`
  E `CRM_CONTACT_DETAIL_TAB` — mesma página, distingue os dois contextos
  via `placementInfo.placement`, ver HANDOFF Parte DE)
- `http://localhost:PORT/dashboard.html` — Análise de Conversas
- `http://localhost:PORT/campaign.html` — Campanha (disparo em massa)
- `http://localhost:PORT/contacts.html` — Contatos e listas
- `http://localhost:PORT/sites.html` — Sites (formulários públicos de captura de lead, §11.5)
- `http://localhost:PORT/lead-metrics.html` — Métricas de Sites (§11.6)
- `http://localhost:PORT/campaign-metrics.html` — Métricas de Campanhas
- `http://localhost:PORT/campaign-schedule.html` — Agenda de Envios (Kanban/Calendário)
- `http://localhost:PORT/instances.html` — Gestão de instâncias de WhatsApp
- `http://localhost:PORT/notifications.html` — Central de Notificações (Kanban/Calendário)
- `http://localhost:PORT/settings.html` — Aparência (paleta de cores **por usuário**, HANDOFF Parte DL)
- `http://localhost:PORT/suggestions.html` — Sugestões de usuário (§15.5)
- `http://localhost:PORT/faq.html` — FAQ pública (§15.5)
- `http://localhost:PORT/admin.html` — Painel Admin, restrito (§14.5)
- `http://localhost:PORT/onboarding.html` — Onboarding (§15.6)
- `http://localhost:PORT/apresentacao.html` — relatório executivo (scrollytelling), sem sidebar

No boot, `SessionManager.startAllExisting()` percorre `auth_session/` e reconecta
automaticamente toda instância que já tenha `creds.json` salvo. Também é iniciado um
**poller de agendamentos** (`src/scheduler.js`, a cada 30s) que dispara sozinho
qualquer campanha da Agenda de Envios cuja hora marcada já chegou.

## 5. Expor publicamente (HTTPS obrigatório)

O Bitrix24 só aceita HANDLER em HTTPS, e a aba faz `fetch`/`WebSocket` direto para
este servidor. Em desenvolvimento, use ngrok:

```bash
ngrok http 3333
```

> ⚠️ **ngrok grátis muda a URL a cada reinício do túnel**, a menos que você reserve
> um **domínio estático gratuito** (um por conta, em
> https://dashboard.ngrok.com/domains) e sempre reabra com:
> ```bash
> ngrok http --url=https://SEU-DOMINIO-RESERVADO.ngrok-free.dev 3333
> ```
> Cuidado com **múltiplas contas ngrok** na mesma máquina — se o `authtoken` salvo em
> `ngrok.yml` for de uma conta diferente da que reservou o domínio, o túnel falha com
> `ERR_NGROK_320` ("domain reserved for another account"). Confirme o token certo em
> https://dashboard.ngrok.com/get-started/your-authtoken.

Em produção, use um proxy reverso com certificado válido (nginx + Let's Encrypt,
Caddy, Cloudflare Tunnel) com domínio fixo. Garanta que `/api/whatsapp/stream`
(WebSocket) também passe pelo proxy — em nginx isso exige os headers
`Upgrade`/`Connection` configurados no `location`.

> 📦 **A produção atual já está montada** — VPS Hostinger + EasyPanel (Traefik),
> em `https://whatsapp.bmdholding.com.br`. Não há nginx: o Traefik encaminha o
> WebSocket sem configuração extra. Deploy, variáveis de ambiente, persistência
> da sessão do WhatsApp e diagnóstico estão em **[DEPLOY.md](DEPLOY.md)**.

---

## 6. Configuração no Bitrix24 (Aplicativo Local)

Crie um **Aplicativo local** do tipo **Servidor** em `Bitrix24 → Aplicativos → Meus
aplicativos`. Preencha:

| Campo | Valor |
|---|---|
| **Seu caminho do manipulador** (HANDLER) | `https://SEU-DOMINIO/` |
| **Caminho de instalação inicial** (INSTALL) | `https://SEU-DOMINIO/install` |
| Apenas script | **desmarcado** (o app precisa de UI) |
| Permissões necessárias | `crm`, `placement`, `user` |

Depois de salvar, clique em **Reinstalar** sempre que o domínio (HANDLER/INSTALL)
mudar — necessário sempre que o ngrok gratuito gerar uma URL nova.

### Como a instalação funciona

1. Bitrix abre `POST /install` (ou `GET`, se você testar manualmente) num iframe.
2. A página carrega o SDK `BX24`, chama `placement.unbind`/`placement.bind`
   DUAS vezes (limpa reinstalações antigas antes de cada uma) — registrando
   a aba "DapZAP" em `CRM_DEAL_DETAIL_TAB` (card de Negócio) E
   `CRM_CONTACT_DETAIL_TAB` (card de Contato, HANDOFF Parte DE), ambas
   apontando pro MESMO `location.origin + '/'` — `public/index.html`
   distingue os dois contextos via `placementInfo.placement` (ver
   `initBx24()`), nunca dois handlers diferentes.
3. Chama `BX24.installFinish()` para o Bitrix saber que terminou.
4. Todo esse registro acontece **no navegador**, via `BX24` — o backend não
   precisa extrair `AUTH_ID` do corpo do POST. **Sem atalho por API**:
   `placement.bind` exige o contexto/token OAuth do PRÓPRIO app local
   (confirmado retornando `WRONG_AUTH_TYPE` contra o webhook de entrada
   genérico) — o sistema nunca persiste esse token de propósito, então
   reativar/adicionar um placement novo sempre passa por reabrir esta
   página de instalação de dentro do Bitrix.

Só a aba do chat (`public/index.html`) é registrada como placement — todas as
outras páginas (Análise de Conversas, Chat/inbox, Campanha, Contatos, Sites,
Métricas de Sites, Métricas de Campanhas, Agenda de Envios, Instâncias, Central
de Notificações, Configurações, Sugestões, Onboarding) são acessadas por
navegação normal (link) a partir da aba do chat ou entre si (barra de navegação
lateral em cada página), sempre rodando dentro do iframe do Bitrix. A sidebar é
retrátil (botão circular dourado na borda, mesmo estilo nas 14 páginas que a têm
— `index.html` não usa esse componente; `apresentacao.html` não tem sidebar mas
já autentica via `BX24.init`, ver §14.6) e o estado
(aberta/fechada) fica em `localStorage`. Os itens "Sites" e "Métricas de Sites"
aparecem como um grupo só ("Landing Page", com "Métricas LP" recolhível por uma
seta — estado também em `localStorage`, chave `navGroupLPOpen`) — ver §11.5/§11.6.
Os itens ficam agrupados em três seções visuais (`.nav-section`, com rótulo
`.nav-section-label` — some quando a sidebar está recolhida): **Workspace**
(Dashboard, Chat, Campanha, Contatos, Landing Page, Onboarding, Sugestões,
FAQ), **Configuração** (Aparência, Instâncias, Apresentação — três abas
soltas, sem hierarquia entre elas; "Aparência" é o link antigo
"Configurações", renomeado porque a página edita a paleta de cores do app) e
**Admin** (Auditoria de Conversas + Admin — as 2 telas de acesso restrito
do sistema, isoladas numa seção própria desde a HANDOFF Parte DO, 2026-08-18;
antes ficavam misturadas em Workspace/Configuração). A seção Admin fica
inteira escondida (não só os 2 itens individualmente) até que pelo menos
um deles seja revelado pra quem está logado — super admin vê os 2, quem só
tem grant de Auditoria de Conversas vê só esse. A revelação anima via
`max-height`/`transition` (HANDOFF Parte DQ, 2026-08-20) em vez de
aparecer com `display:none → block` instantâneo — sem isso, a sidebar
"pulava" de repente quando a confirmação de acesso chegava (2 requests
de rede sequenciais em `admin.html`: confirmar com o Bitrix, depois
confirmar super admin), bem na área que a pessoa estava olhando. A paleta
editada ali é **por usuário** desde a HANDOFF Parte DL (2026-08-18) —
antes era um único registro global pra toda a instalação; hoje cada
`ownerId` tem a própria linha em `user_palette` e só vê a própria cor,
nas telas internas (nome/subtítulo/cor de fallback da marca em
`GET /api/brand` continuam globais via `.env`, sem relação com esta
mudança — ver a tabela de rotas mais abaixo). Cache local
(`localStorage`) do brand global e da paleta pessoal fica em chaves
SEPARADAS (`palette_*` vs `personalPalette_*`, HANDOFF Parte DP,
2026-08-18) — antes usava as mesmas chaves pras duas, o que causava
um flash visível "cor pessoal → cor global → cor pessoal" a cada
navegação pra quem tinha paleta pessoal configurada. O
cache-antes-do-paint resolveu o flash entre PÁGINAS (recarregando do
zero); uma janela residual DENTRO da mesma carga (`window.
__applyPalette` sempre reaplicando a cor global visualmente antes do
fetch da paleta pessoal confirmar de novo) ficou documentada como
limitação conhecida por mais de uma semana até ser corrigida de vez
na Parte EO (2026-08-26): `__applyPalette(b, prefix, skipVisual)`
ganhou um 3º parâmetro — com paleta pessoal já em cache, o fetch de
`/api/brand` só atualiza o cache global em segundo plano
(`skipVisual=true`), sem tocar `document.documentElement.style`
nenhuma vez; sem paleta pessoal, nada muda. A
sidebar é duplicada em cada um dos 13 arquivos HTML (não há componente/
template compartilhado — vanilla JS/HTML, sem build step), então qualquer
mudança nela (item novo, reordenar, mudar seção) precisa ser replicada
manualmente nas 13 cópias.

### Uso normal (depois de instalado)

1. Abra um **Negócio** qualquer no CRM.
2. Clique na aba **"WhatsApp"** (pode estar dentro do menu **"Mais ▾"**, dependendo
   de como as abas foram organizadas — isso é um ajuste manual de posição feito
   arrastando no próprio Bitrix, não algo que o app controle).
3. Se o dono logado ainda não tem nenhuma instância conectada, a própria aba mostra
   o QR Code — escaneie com **WhatsApp → Aparelhos conectados → Conectar um
   aparelho**. Se já tiver mais de uma instância, escolha qual usar no seletor do
   cabeçalho.
4. A instância fica salva em `AUTH_FOLDER/<sessionId>/` e sobrevive a reinícios do
   processo — só é preciso escanear de novo se deslogar pelo celular ou apagar essa
   pasta.
5. Para **Análise de Conversas**, **Campanha**, **Contatos**, **Sites**,
   **Métricas de Sites**, **Métricas de Campanhas**, **Agenda de Envios**,
   **Instâncias**, **Central de Notificações**, **Configurações**,
   **Sugestões** ou **Onboarding**, use os links da barra de navegação lateral
   dessas páginas (aparecem entre si). A Análise de Conversas também é o
   destino padrão quando o app é aberto pelo próprio ícone dele no Bitrix,
   fora de um card de Negócio (`PLACEMENT === 'DEFAULT'`).

---

## 7. Mídia (imagem, áudio, vídeo)

- **Enviar**: botão de anexo (📎, escolhe um arquivo), o microfone (🎙️, grava
  direto no navegador via `MediaRecorder`) ou **Ctrl+V** com uma imagem copiada
  (print, ou copiada de outro app/site) direto na caixa de mensagem — captura o
  arquivo via `clipboardData.items` e usa o mesmo caminho de envio do anexo
  (`sendMediaFile`, `public/chat.html`). Vídeo e imagem vão como estão; áudio
  é sempre **convertido para OGG/Opus** antes de enviar (`src/audioConvert.js`,
  via ffmpeg) — é o único formato que o WhatsApp entrega/reproduz de forma
  confiável; áudio gravado no Chrome (`webm/opus`) chega mas não toca sem essa
  conversão.
- **Receber**: `src/whatsapp.js` detecta `imageMessage`/`audioMessage`/`videoMessage`,
  baixa via `downloadMediaMessage` do Baileys e sobe pro Supabase Storage.
- **Exibição no balão**: imagem/vídeo aparecem numa moldura fina (`.media-frame`)
  em vez do preenchimento cru de balão de texto. Imagem sem legenda tem o
  horário+check sobreposto num selo escurecido no canto (estilo WhatsApp);
  imagem/vídeo com legenda mostram o horário numa linha própria abaixo (pra
  não brigar com a barra de controle nativa do `<video>`). Áudio usa
  `accent-color` pra tingir o player nativo na cor da marca.
- Limite de 20MB por arquivo no chat (15MB no anexo de Campanha). Áudio gravado não
  tem limite de duração imposto pelo app, mas fica sujeito ao mesmo teto de tamanho.
- Microfone requer que o navegador libere `getUserMedia` dentro do iframe do
  Bitrix — se o Bitrix bloquear isso por política de permissões do iframe, a única
  opção é anexar um áudio já gravado em outro app.
- **Bucket privado**: o bucket `media` do Supabase Storage não é mais público —
  `saveMedia()` (`src/media.js`) devolve um caminho relativo
  (`/api/whatsapp/media/<filename>`) em vez da URL direta do Supabase. Exibir a
  mídia passa por essa rota autenticada (`GET /media/:filename`, ver §16), que
  gera uma signed URL de curta duração (5 min) e redireciona — qualquer usuário
  autenticado deste portal pode ver qualquer mídia (não é restrito por dono da
  conversa, decisão consciente de simplicidade). O frontend
  (`hydrateMedia()` em `chat.html`/`index.html`) já sabia buscar URLs relativas
  de forma autenticada antes dessa mudança — nenhuma alteração de frontend foi
  necessária **em quem já usava esse mecanismo**. Qualquer tela nova/futura que
  renderize bolhas de mensagem PRECISA usar o mesmo padrão
  (`data-media-url` + `apiFetch` + blob, nunca `src=` direto) — esquecer isso é
  exatamente o bug real encontrado e corrigido em `conversation-analysis.html`
  na Parte DW do HANDOFF (§15.6), onde a mídia falhava silenciosamente porque
  um `src` puro nunca consegue mandar o header `Authorization: Bearer` que
  `GET /media/:filename` exige.
- **Nome do arquivo prefixado por instância**: `saveMedia(sessionId, id, buffer,
  mimetype)` salva em `<sessionId>/<id>.<ext>`, não só `<id>.<ext>`. `id` é o
  `key.id` que o próprio WhatsApp/Baileys atribui à mensagem — único dentro de
  uma instância, mas **não coordenado entre instâncias diferentes**; sem o
  prefixo, duas contas distintas podiam gerar o mesmo id e a segunda mídia
  salva sobrescrevia a primeira no Storage (`upsert: true`), fazendo duas
  conversas de instâncias diferentes exibirem o mesmo áudio/foto — bug real
  encontrado em produção, corrigido em 2026-08-10 (HANDOFF, Parte CJ).

---

## 8. Análise de Conversas (`/dashboard.html`)

Única página que é **agregada de todas as instâncias/usuários** de propósito (visão
gerencial/de time) — aberta pelo ícone do app (fora de um card de Negócio). Principais
peças:

- **Insights de IA**: bloco no topo com 3 a 5 cards curtos (diagnóstico ou
  recomendação prática, cor da borda por `tone` — verde/vermelho/dourado)
  escritos por IA a partir dos próprios agregados da tela (nunca de
  conversa individual). `GET /api/whatsapp/insights` (`generateDashboardInsights`,
  `src/openai.js`, `gpt-4o-mini`) roda uma vez ao carregar a página (fora do
  polling de 30s dos KPIs) e fica cacheado 30min por dono em memória do
  processo; botão "Atualizar" (`?refresh=1`) ignora o cache.
- **Filtro Interna/Externa/Todas**: uma conversa é "**interna**" quando o número do
  outro lado é, na verdade, o WhatsApp de **outra instância conhecida** (ex: teste
  entre colegas) — detectado comparando o telefone da conversa com o `me.id` salvo
  nas credenciais de cada instância (`auth_session/<sessionId>/creds.json`). É
  "**externa**" quando não bate com nenhuma instância conhecida (cliente/lead de
  fora). O padrão hoje é mostrar só **internas**.
- **KPIs**: mensagens totais/recebidas/enviadas, conversas ativas, sessões
  conectadas, tempo médio de resposta, taxa de resposta, mensagens por conversa —
  em grid fixo de 4 colunas. Cada card mostra dois selos de variação (**AH —
  análise horizontal**): **MoM** (mês atual × mês anterior) e **YoY** (mês atual ×
  mesmo mês do ano passado), com seta e cor (verde/vermelho — invertido no "Tempo
  médio de resposta", onde subir é ruim) ou "novo" quando não há período anterior
  pra comparar. Calculado em `src/metrics.js` (`summarizeRange`), devolvido em
  `trend.{current,prevMonth,prevYear}` pela mesma rota de métricas.
- **Gráfico de linha**: mensagens recebidas × enviadas, sempre do dia 1 do mês
  corrente (UTC) até hoje — dias sem mensagem entram zerados no gráfico (não é
  mais uma janela do tamanho de quantos dias já tinham dado, que fazia o gráfico
  "encolher" no começo do mês). Grade e eixo Y, área sombreada sob as linhas, e
  crosshair com tooltip ao passar o mouse (mostra os dois valores exatos daquele
  dia). SVG responsivo (estica pra 100% do painel).
- **Dispersão**: um ponto por dia, posição = (recebidas, enviadas) — mostra se dias
  de mais volume recebido também têm mais respostas. Grade nos dois eixos, tooltip
  no hover, e uma diagonal de referência (recebidas = enviadas).
- **Distribuição por etapa (Bitrix)**: gráfico "Leads por etapa" — busca os negócios
  vinculados às conversas (`crm.deal.list`, em lotes de 50 IDs), resolve o nome de
  cada etapa via `crm.dealcategory.stage.list` e agrupa/ordena
  (`getStageDistribution`, `src/bitrixCrm.js`) — devolvido como `metrics.stages`
  na mesma rota de métricas; best-effort (vazio se o Bitrix falhar).
- **Lista de Conversas**: só as vinculadas a um negócio (`dealId`), paginada (10 por
  página). Cada linha tem um menu "⋯" com **"Abrir conversa"**, que usa
  `BX24.openPath('/crm/deal/details/<dealId>/')` para navegar até o negócio no CRM.
- **Tabela "Por sessão"**: mostra o nome/rótulo que o dono deu à instância
  (`/instances.html`) em vez do id técnico da sessão — cai pro id cru só se não
  achar nenhum rótulo cadastrado.
- O timestamp "Atualizado às HH:MM:SS" fica fixo no rodapé da sidebar (não em cima
  do conteúdo, pra não competir com os filtros).

A rota por trás, `GET /api/whatsapp/metrics?origin=interna|externa`, calcula tudo em
`src/metrics.js` a partir do Postgres — não tem cache, cada request recalcula.
Escopada pelas instâncias do dono autenticado (`req.ownerId`), nunca de outros donos.

---

## 9. Chat — inbox (`/chat.html`)

Diferente da aba `public/index.html` (embutida no card de um Negócio, uma conversa
por vez), esta é a visão de **inbox**: lista todas as conversas do usuário lado a
lado com a conversa aberta, acessada pela sidebar como as demais páginas.

- **Lista de conversas**: busca por contato, filtro por tag, filtro por
  atendente (avatares com iniciais, ao lado do filtro de tags — só aparece
  quando existe pelo menos uma conversa atribuída na lista atual; ver
  delegação de instância, §14), seletor de instância (quando o usuário tem
  mais de uma) — aceita "todas as minhas instâncias" numa lista só.
  Atualiza em tempo real via WebSocket (`/api/whatsapp/stream`). Cada
  avatar tem uma bolinha de status (verde/vermelho/cinza) mostrando se a
  **instância** dona daquela conversa está conectada ao WhatsApp agora —
  `state.instanceStatus`, populado por `GET /instances` e mantido em tempo real
  pelo mesmo evento `status` do WebSocket. Não é presença do contato (o
  WhatsApp não expõe isso pra uma lista inteira, só pra uma conversa aberta por
  vez, e depende da privacidade de cada pessoa).
- **Tag de atendente**: quando uma conversa está atribuída (`assignedToName`,
  ver §14), o card na lista mostra uma tag com iniciais + nome de quem está
  atendendo, ao lado das tags normais do contato — mesmo dado usado na linha
  de atribuição dentro da conversa aberta ("Atribuída a X"). Atualiza em
  tempo real (evento `assignment` no mesmo WebSocket de mensagens) pra
  qualquer aba/usuário olhando a lista, não só depois de recarregar.
- **Tag Pendente**: card ganha uma tag vermelha quando a conversa tem
  mensagem não lida (`unreadCount`, mesmo dado da bolinha de não lida) —
  de propósito não existe uma tag "Lida" complementar, ausência de tag já
  significa "em dia".
- **Foto de perfil real do contato**: o avatar mostra a foto de perfil do
  WhatsApp (`sock.profilePictureUrl`, `WhatsAppGateway.getProfilePicture`)
  em vez de só as iniciais do nome, quando disponível — cai pras iniciais
  se não houver foto ou a privacidade do contato bloquear. Buscada sob
  demanda e cacheada em `conversations.avatar_url` (`GET
  /api/whatsapp/avatar`, sem TTL — nunca revalida uma foto já salva), em
  lotes de 4 em paralelo no front (`fetchMissingAvatars`, 150ms entre
  lotes, HANDOFF Parte DR, 2026-08-20 — era 1 por vez com 250ms entre
  cada, usuário reportou demora real numa lista com várias fotos ainda
  sem cache) pra não disparar tudo de uma vez numa lista grande.
- **Conversa**: mesmo conjunto de recursos da aba do card — texto, imagem, áudio
  (gravado ou anexado), vídeo, tags por conversa, indicador de status da conexão.
  O campo de mensagem tem scrollbar customizado (fino, cor da identidade visual
  do app) em vez do padrão do navegador — mesmo ajuste em `index.html`. Bolha
  tem largura máxima de `min(60%, 480px)` (nunca passa de 480px mesmo em
  monitor largo) e sem borda do lado do contato.
- **Formatação de texto do WhatsApp**: `*negrito*`, `_itálico_`, `~tachado~` e
  `` ```monoespaçado``` `` são interpretados de verdade (não aparecem com os
  símbolos literais) — `formatWhatsAppText()`, mesmas regras do WhatsApp real
  (marcador só conta se colado à palavra). Comum em mensagens de bot/menu
  (ex: `*1. Opção*`), sem isso ficavam com os asteriscos no meio do texto.
- **Avatar do atendente por mensagem + aviso de troca**: cada bolha `mine`
  com `sentByName` preenchido mostra um pequeno avatar (iniciais) de quem
  a enviou (`messages.sent_by`/`sent_by_name`, ver §14) — e um divisor
  dourado "{Nome} assumiu o atendimento" aparece quando duas mensagens
  nossas consecutivas têm remetentes diferentes. `sentBy` é sempre
  `req.ownerId` (nunca aceito do client); só mensagens enviadas depois
  desta feature existir têm o dado — sem backfill retroativo, diferente
  do Painel de atendimento (§9), já que não há como recuperar quem
  enviou uma mensagem já mandada no passado.
- **Confirmação de leitura**: mensagem enviada mostra check simples (enviada),
  check duplo (entregue) ou check duplo **azul** (`#53bdeb`, lida — mesma cor
  do WhatsApp), ícones SVG desenhados em `tickIcon()`. Falha de envio tem ícone
  próprio (círculo vermelho com "!"), não é mais confundida com "entregue". Quando
  a conversa tem negócio vinculado, o mesmo evento também posta um comentário na
  **timeline do negócio no Bitrix** (`logStatusToTimeline`, `src/bitrix.js`,
  `crm.timeline.comment.add`) — "Entregue pelo contato" / "Visualizada pelo
  contato" — best-effort, nunca bloqueia a atualização do check na tela. Um evento
  de status do WhatsApp (`messages.update`) usado só pra entrega/leitura nunca
  vem com o telefone real de contatos `@lid` nos mesmos campos que a mensagem em
  si usa — resolvido chamando o mapeamento LID→telefone interno do próprio
  Baileys (`sock.signalRepository.lidMapping.getPNForLID`, `_resolveLidPhone` em
  `src/whatsapp.js`), senão o check "lida" desses contatos nunca atualizava.
- **Resumo de IA na timeline do Bitrix** (HANDOFF Parte DD): toda vez que o
  resumo de uma conversa é gerado/recalculado (botão no painel do Chat), o
  mesmo comentário (título/subtítulo/resumo) é postado automaticamente na
  timeline do Negócio (`logConversationSummaryToTimeline`, `src/bitrix.js`,
  mesmo `crm.timeline.comment.add` de cima) — best-effort, sem `dealId`
  simplesmente não posta nada.
  Causa raiz **separada** do mesmo sintoma: um sufixo de dispositivo no JID
  (`":0"`, `":12"`...) sobrevivia na extração do telefone e nunca batia com
  o telefone salvo — corrigido em `_jidToPhone` (§19, bug 19).
- **"Digitando…"/"gravando áudio…" nas duas direções**: ao escrever ou gravar
  áudio no composer, o CONTATO vê o indicador no WhatsApp dele
  (`sock.sendPresenceUpdate`, via `POST /presence`); ao abrir uma conversa, o
  Chat pede pro WhatsApp avisar (`sock.presenceSubscribe`, dentro de `GET
  /history`) quando aquele contato digitar/gravar do lado dele — mostrado no
  lugar de "Conectado"/"Desconectado" no cabeçalho enquanto durar. Depende da
  privacidade do contato (pode estar desligado do lado dele, sem erro nenhum
  nesse caso — só nunca chega o indicador).
- **Pré-visualização de link**: mensagem com uma URL ganha um cartão com
  título/descrição/imagem da página (Open Graph), como WhatsApp/Slack fazem
  — `GET /link-preview?url=` (`src/linkPreview.js`), com proteção básica
  contra SSRF (recusa URL que resolva pra endereço privado/interno) e cache
  de 1h por processo. Toda URL no texto também vira link clicável.
- **Reagir e responder citando**: passar o mouse numa mensagem mostra os
  botões 🙂 (reagir, picker com 6 emojis) e ↩ (responder citando) — igual
  WhatsApp Web. Responder mostra uma barra "Respondendo a…" acima do
  composer e a mensagem enviada carrega um pequeno bloco citado dentro do
  balão (clicável, rola até a mensagem original). `POST /react` e o campo
  `replyToId` em `/send`/`/send-media` (`src/whatsapp.js`:
  `sendReaction`/`sendMessage`/`sendMedia`).
- **Painel de detalhes do contato** (à direita, aparece acima de ~1100px de
  largura — some em telas menores pra não espremer o layout): busca dados de
  verdade no Bitrix sobre quem está do outro lado da conversa.
  - Se a conversa já tem um negócio vinculado (`dealId`), usa
    `crm.deal.get` → `crm.contact.get`/`crm.company.get`. Sem negócio vinculado,
    cai para `crm.duplicate.findbycomm` (busca contato ou lead pelo telefone).
  - Mostra nome, cargo + empresa, e-mail, telefone, empresa, endereço e site —
    **sempre os 5 campos, com rótulo**, mesmo vazios (mostra "—" em vez de
    esconder a linha).
  - Telefone cai para o número do WhatsApp da conversa se o Bitrix não tiver um
    cadastrado.
  - Ordem do painel: dados do contato → **grupos em comum** → **resumo da
    conversa via IA** (rodapé fixo com o status do CRM fica sempre por
    último, fora da área que rola).
  - **Status do CRM sempre no mesmo lugar** — rodapé fixo do painel
    (`.contact-panel-footer`, não rola com o resto do conteúdo, `min-height`
    calculado pra alinhar com a altura da barra de composer da coluna do
    meio): achado, mostra o botão "Abrir contato/lead no CRM"; não achado,
    mostra "Nenhum contato encontrado no CRM para X" no lugar do botão (mesmo
    slot, nunca os dois em posições diferentes). Ícone no cabeçalho pra
    esconder/mostrar o painel (fica lembrado só durante a sessão da aba, não
    persiste).
  - **Resumo da conversa via IA**: card **estruturado em título + subtítulo +
    resumo** (não um parágrafo só), grudado no fim do painel (logo acima do
    rodapé). **Sem botão de regenerar manual** (removido a pedido do
    usuário) — mas se regenera **sozinho** conforme a conversa continua:
    gerado na primeira vez que se abre uma conversa com mensagens e ainda
    sem resumo salvo, e depois disso re-executado automaticamente a cada
    mensagem nova (qualquer direção) recebida via WebSocket — no máximo
    **1 vez por hora** (`SUMMARY_REFRESH_MIN_INTERVAL_MS`, HANDOFF Parte
    EB, 2026-08-25 — antes era a cada mensagem com só 15s de debounce,
    reduzido pra limitar o custo real de chamadas à OpenAI numa conversa
    muito ativa), com um debounce de 15s por cima pra não regenerar a
    cada mensagem individual numa rajada assim que a hora completa
    (`scheduleSummaryRefresh`, compara `Date.now()` contra
    `aiSummaryUpdatedAt`). Chama
    `POST /api/whatsapp/conversations/summary` `{ session, phone,
    contactName? }`, que reprocessa até as últimas 80 mensagens da conversa
    (`store.getHistory`) via OpenAI (`gpt-4o-mini`, `response_format:
    json_object`, `summarizeConversation` em `src/openai.js`, devolve
    `{title, subtitle, summary}`) e persiste o resultado (JSON stringificado)
    em `conversations.ai_summary`/`ai_summary_updated_at`. Resumos salvos
    antes dessa mudança estrutural (texto puro) continuam funcionando via
    fallback automático (`{title: null, subtitle: null, summary: <texto
    antigo>}`, ver `store.getConversationSummary`). O resumo salvo vem junto
    de `GET /history` (campo `aiSummary`, já como `{title, subtitle,
    summary}` ou `null`), sem round-trip extra ao abrir a conversa. Sem
    `OPENAI_API_KEY`, a geração automática falha silenciosamente (sem
    toast).
  - **Histórico de resumos** (HANDOFF Parte DY/DZ): cada regeneração
    automática grava também uma linha nova em `conversation_summaries`
    (mesma query atômica de `store.setConversationSummary`, via CTE) —
    vira um registro de como o caso foi evoluindo ao longo do
    atendimento, não só o snapshot mais recente. Link "Ver histórico"
    (perto de "Atualizado X" no card do resumo, só aparece com pelo
    menos 1 resumo salvo) abre um modal com todas as versões, mais
    recente primeiro, cada uma com data **e hora** completas. `GET
    /api/whatsapp/conversations/summary-history?session=&phone=` →
    `store.listConversationSummaryHistory`. Cada versão também mostra
    os tokens gastos na geração (`conversation_summaries.tokens_used`,
    coluna adicionada na Parte DZ — só disponível pra resumos gerados
    a partir de então; versões salvas antes ficam sem esse dado, sem
    forma de recuperar retroativamente, a OpenAI só devolve
    `usage.total_tokens` na hora da chamada).
- Todo o cabeçalho de página (logo da sidebar, cabeçalho da lista, cabeçalho da
  conversa e do painel de contato) e os dois rodapés (sidebar e o selo
  "Desenvolvido por") usam duas alturas fixas compartilhadas (`--header-h`,
  `--footer-h`) pra as linhas divisórias ficarem alinhadas entre as colunas —
  as outras 7 páginas de sidebar usam as mesmas duas variáveis pro logo/rodapé
  (só não têm o cabeçalho de múltiplas colunas, que é exclusivo do layout do
  Chat).
- **Arquivar conversas**: par de botões "Ativas"/"Arquivadas" acima da lista.
  Cada conversa tem um ícone de arquivar/desarquivar (aparece ao passar o
  mouse) — some da lista principal na hora (atualização otimista) e passa a
  aparecer em "Arquivadas". É só organização da lista: histórico, envio e
  recebimento continuam funcionando normalmente numa conversa arquivada, e
  uma mensagem nova **não** desarquiva sozinha. Backend:
  `conversations.archived` (boolean), filtrado em `GET /conversations?archived=`
  (ver §16).
- **Mover uma conversa em andamento pra outra instância** do mesmo dono, sem
  perder histórico — pensado pro cenário de uma instância cair ou ser banida
  no meio de um atendimento (protocolo não-oficial, ver aviso no topo deste
  README): um ícone na conversa abre um modal com as outras instâncias do
  dono, confirma via `window.confirmDialog`. `store.moveConversationToInstance`
  troca só `conversations.session_id` (mensagens, ligadas por
  `conversation_id` e não por `session_id`, não se movem — nada se perde);
  recusa se a instância de destino já tiver a própria conversa com aquele
  contato, pra não fundir duas conversas. Ver `POST /conversations/move-instance`
  em §16.
- **Novo grupo do WhatsApp direto do Chat**: botão na linha do toggle
  "Ativas"/"Arquivadas" (alinhado à direita) abre um modal com nome do grupo,
  uma lista de checkboxes com as conversas da instância (participantes), e um
  atalho **"Selecionar por tag"** que marca sozinho todas as conversas com
  aquela tag (o usuário ainda pode ajustar os checkboxes manualmente depois).
  Com mais de uma instância selecionada no filtro, um seletor extra pede qual
  delas deve criar o grupo (um grupo do WhatsApp pertence a uma instância só).
  Reaproveita a mesma `POST /api/whatsapp/groups` já usada em Contatos (§11) —
  nenhuma rota nova pra isso. Depois de criado, abre a conversa do grupo na
  hora.
- **Notificação de mensagem nova, com silenciar por conversa**: cada conversa
  na lista tem um ícone de sino (ao lado do de arquivar) pra silenciar/
  dessilenciar — notifica por padrão (`conversations.notifications_enabled`,
  default `true`). Quando chega uma mensagem recebida numa conversa fechada e
  não silenciada, dispara um toast (`window.showToast`) — esse mecanismo é
  garantido, não depende de nenhuma permissão do navegador. Se o usuário já
  tiver concedido permissão de notificação nativa do sistema operacional
  (botão "Ativar notificações do sistema" na Central de Notificações, §15),
  também tenta `new Notification(...)`, best-effort — como o app roda num
  iframe do Bitrix, essa permissão pode simplesmente não funcionar (mesma
  limitação já conhecida do microfone, ver §7), por isso o toast/sino nunca é
  opcional. A mesma mensagem também vira uma notificação persistida no banco,
  visível na Central de Notificações (§15) mesmo que ninguém esteja com o
  Chat aberto no momento.
  - **Clicar no toast abre a conversa**: `showToast(message, type, target)`
    aceita um 3º parâmetro opcional — quando presente, o próprio toast fica
    clicável e navega pra conversa (`window.__notifNavigate`) ao clicar.
  - **Deep link**: `chat.html?session=&phone=` na URL abre aquela conversa
    automaticamente assim que a lista carrega — usado pelos cards da Central
    de Notificações (§15) pra navegar de volta pro Chat numa conversa
    específica a partir de uma página diferente.
- **Botão "Grupos"**: ao lado de "Novo grupo" (mesma linha do toggle
  "Ativas"/"Arquivadas"), abre uma lista dos grupos já criados da instância
  atual (`GET /api/whatsapp/groups`, mesma rota do §11 — nenhuma rota nova) e
  reabre a conversa de qualquer um deles ao clicar. Resolve o caso de um grupo
  recém-criado "sumir" da lista principal até receber a primeira mensagem: com
  esse botão dá pra reabrir e mandar mensagem a qualquer momento.
- **Filtro "Grupos"** (Parte EY, 2026-08-27) — diferente do botão acima
  (que abre um modal separado): um pill ao lado de "Pendentes", mesmo
  padrão (independente de Ativas/Arquivadas, combina com qualquer um
  dos dois). Filtra a lista principal pra mostrar só as conversas cujo
  telefone está registrado em `wa_groups` (grupos que o próprio app
  conhece/criou — não qualquer JID de grupo do WhatsApp em geral).
  Reaproveita `GET /api/whatsapp/groups` (mesma rota do item acima),
  agrupando todas as instâncias do filtro atual numa única chamada.
- **Detalhes do contato — estatísticas e grupos em comum**: o painel de
  contato (acima) também mostra a contagem de mensagens trocadas na conversa
  aberta (total, recebidas, enviadas — direto de `state.messages`, sem rota
  nova) e a lista de grupos da instância dos quais esse telefone também é
  participante (`GET /api/whatsapp/contacts/groups`, ver §16) — carregado em
  paralelo com a busca no CRM, sem travar o resto do painel. Como o WhatsApp
  às vezes só expõe um participante como um JID `@lid` anônimo sem telefone
  associado, essa checagem é best-effort (mesma limitação de LID do §19).
- **Painel de atendimento** (subaba "Painel", ao lado de "Chat" no topo —
  só aparece com exatamente uma instância selecionada, não com "todas as
  minhas instâncias"): desempenho da equipe que atende por aquela
  instância — conversas por atendente, pendências, tempo médio de
  resposta, e cards de insight gerados por IA em tom de storytelling
  (`GET /api/whatsapp/team-metrics`/`team-insights`, ver §12.4). Dono real
  da instância vê a equipe inteira; um delegado comum (manual ou via
  hierarquia, ver §14) vê só o próprio desempenho, nunca o dos colegas —
  `isManager` é resolvido no servidor comparando o dono real da instância
  com quem está autenticado, nunca aceito como parâmetro do client.
  Baseado em `conversation_assignment_history` (histórico de quem
  atendeu cada período da conversa, não só a atribuição atual), pra não
  contar o volume/tempo de resposta de uma conversa inteira pra quem só
  pegou ela por último numa transferência.
- **Nota interna** (HANDOFF Parte EA) — mensagem visível SÓ pra quem já
  tem acesso à conversa, nunca ao cliente, mesma regra de posse do
  resto do app (`assertOwnsSession`, sem papel adicional). Diferente do
  drawer lateral de `index.html` (aba do card do negócio): aqui vive
  como uma ABA do próprio composer ("Responder" | "Nota interna",
  inspirado no Chatwoot), cada uma com seu textarea/botão próprio.
  Aparece inline no feed de mensagens como uma faixa âmbar distinta
  (`.bubble-note`), nunca misturada com bolha de mensagem real — o
  array `state.internalNotes` é sempre paralelo a `state.messages`
  (merge só na hora de renderizar, nunca gravado junto) e nunca conta
  como troca de atendente. Backend: `GET`/`POST /api/internal-notes`
  (`src/routes/internalNotes.js`, já genérico — usado também por
  `index.html`), broadcast via WebSocket (`type: 'internal-note'`) pra
  sincronizar entre abas/atendentes em tempo real.
  - **Editar e concluir** (HANDOFF Parte EC): só o AUTOR original edita/
    conclui a própria nota (`requireResourceOwner`, mesmo mecanismo já
    usado por `POST /notifications/:id/read` — 404 pra quem não é o
    autor; qualquer outro com acesso à conversa continua LENDO
    normalmente). Editar preserva o texto anterior em
    `internal_note_revisions` (`GET /api/internal-notes/:id/revisions`,
    modal de histórico) — nunca sobrescreve sem rastro. Nota concluída
    (`PUT`/`POST /api/internal-notes/:id`, `:id/complete`) continua no
    MESMO lugar cronológico do feed, só riscada/opaca — nunca some nem
    muda de posição. `type: 'internal-note-updated'` no WebSocket cobre
    os dois casos (edição e conclusão).
- **Exportar conversa** (HANDOFF Parte EA) — botão no cabeçalho da
  conversa, menu com 2 formatos:
  - **TXT**: montado no client (`buildExportLines()`), a partir do que
    já está carregado na tela (`state.messages` + `state.internalNotes`)
    — garante que o arquivo reflete exatamente o que a pessoa está
    vendo, sem round-trip extra.
  - **PDF**: gerado no BACKEND via `pdfkit` (arquivo real, baixado
    direto — não é fluxo de impressão). `GET
    /api/whatsapp/conversations/export-pdf?session=&phone=` busca o
    histórico + notas de novo no servidor (fonte de verdade).
  - Nos dois formatos, nota interna é SEMPRE incluída, mas claramente
    rotulada `[NOTA INTERNA — não enviada ao cliente]` (dourado/itálico
    no PDF) — nunca podia ser confundida com mensagem real se o
    arquivo circular fora do sistema.

---

## 10. Campanha — disparo em massa (`/campaign.html`)

> ⚠️ Enviar em volume pra muitos contatos de uma vez é o padrão de comportamento que
> mais chama atenção dos sistemas antispam do WhatsApp — o número pode ser bloqueado.
> Use só com contatos que já têm relação com você, nunca com listas frias.

> ⚠️ **"Enviada" não é garantia de entrega**: o WhatsApp pode aceitar a mensagem no
> envio e rejeitá-la DEPOIS, de forma assíncrona, com "error 463: account restricted
> or missing tctoken" — exige um token de privacidade antes de deixar iniciar
> conversa NOVA com quem nunca falou com este número (conversas já existentes não
> são afetadas). O gateway detecta isso e corrige o status real da mensagem (Chat) e
> as métricas da campanha (§12) alguns instantes depois — mas na hora do disparo em
> si não há como saber de antemão quem vai ser rejeitado (ver HANDOFF, Parte CM). Três
> mitigações (nenhuma é cura — o erro 463 é política do WhatsApp, não deste gateway):
> aviso antes de disparar (abaixo), intervalo maior entre mensagens (abaixo), e retry
> automático 24h depois pra quem falhar (§13) — ver HANDOFF, Parte CN.

- **Instância de envio**: dropdown com as próprias instâncias do usuário (nunca as de
  outra pessoa), com status online/offline.
- **Destinatários**: seleção por lista de contatos personalizada (ver §11), por
  checkboxes das conversas já existentes (vinculadas a negócio), e/ou colando números
  manualmente — tudo deduplicado por telefone.
  - **Aviso de risco**: antes de confirmar o disparo (imediato ou agendado), o
    gateway classifica cada destinatário (`POST /campaign/classify-recipients`,
    `hasReplied`: já existe alguma mensagem RECEBIDA de verdade daquele telefone,
    não só uma conversa criada) — se algum nunca respondeu, o diálogo de confirmação
    já existente ganha a contagem de quantos estão em risco de erro 463. Best-effort:
    se a classificação falhar (rede etc.), o disparo segue sem o aviso, não é
    bloqueado por isso.
- **Mensagem**: texto livre com variáveis `{{nome}}` e `{{telefone}}`, substituídas
  por destinatário no momento do envio (contato sem nome cadastrado recebe o telefone
  no lugar de `{{nome}}`). Pode ser escrita na hora ou carregada de um **modelo**
  salvo (ver §11); "Salvar como modelo" grava o texto atual pra reuso.
  - **Anexo**: uma imagem, áudio ou vídeo (até 15MB) enviado a todos, com o texto
    (já com as variáveis substituídas) como legenda.
  - **Vídeo do YouTube**: campo separado "Anexar vídeo do YouTube (opcional)" —
    cola o link no fim da mensagem como texto puro (não existe "vídeo por URL"
    no protocolo do WhatsApp; é o próprio app do destinatário que gera a prévia
    com miniatura, igual quando alguém cola um link à mão).
  - **Preview ao vivo**: mockup de conversa (celular/tablet/computador, alternável,
    coluna de 400px com o frame do celular a 280px/tablet a 340px) mostrando como
    a mensagem chega pro primeiro destinatário selecionado — renderiza a mídia
    anexada de verdade (`<img>`/`<video>`/`<audio>`, a partir do mesmo base64
    capturado pra envio) e, com um link do YouTube preenchido, uma miniatura real
    do vídeo (`extractYoutubeId` extrai o id de 11 caracteres de qualquer formato
    comum de link, monta `https://img.youtube.com/vi/<id>/hqdefault.jpg` — sem
    precisar de chave de API).
- **Envio**: imediato ou **agendado** pra uma data/hora futura (ver §13). Limite de
  100 destinatários por campanha.
  - **Intervalo entre mensagens**: 3 presets (Rápido 4-9s = padrão, Padrão 15-30s,
    Cauteloso 45-90s) ou um valor livre (min/max em segundos) — intervalos maiores
    reduzem (não eliminam) o risco de bloqueio pelo WhatsApp. Persistido junto do
    agendamento (`scheduled_campaigns.min_delay_ms`/`max_delay_ms`) pra um envio
    futuro lembrar a escolha até a hora de disparar de fato.
- Todo envio (imediato ou agendado) fica registrado em `campaigns`/`campaign_results`
  e some no dashboard de Métricas de Campanhas (§12). Se algum destinatário for
  rejeitado pelo WhatsApp depois do envio (erro 463, ver aviso no topo desta seção),
  um retry automático é agendado sozinho pra 24h depois — ver §13.
- Layout em tela cheia (full-bleed, mesmo modelo da Análise de Conversas — sem
  teto de largura central), pra aproveitar melhor telas grandes.

---

## 11. Contatos e listas (`/contacts.html`)

Cadastro de contatos (nome + telefone) e organização em **listas personalizadas**,
usados como fonte de destinatários na Campanha — por **dono** do Bitrix, não por
instância: se uma instância cai e o usuário conecta outra, os mesmos contatos e
listas continuam aparecendo (ver `owner_id` em `db/schema.sql`). Modelos de mensagem
continuam por instância (cada uma pode ter textos próprios).

- **Sync automático**: toda mensagem recebida (qualquer instância, não só quando o
  Chat está aberto, e incluindo backfill de histórico ao conectar — ver §14) já
  cria/atualiza um contato sozinha — `src/server.js`, dentro do mesmo callback
  `onMessage` do `SessionManager` que salva a mensagem e notifica (§15), chama
  `upsertContact(ownerId, {phone, name, dealId})`. Usa o mesmo
  `ON CONFLICT (owner_id, phone) DO UPDATE ... coalesce` de baixo — uma segunda
  mensagem do mesmo telefone nunca sobrescreve um nome/`dealId` já salvo com um
  valor vazio recebido depois. Best-effort (falha não interrompe o recebimento da
  mensagem). Antes disso, um contato só existia por criação manual ou pelos dois
  botões de importação abaixo. O telefone salvo depende de `_resolveLidPhone`
  resolver corretamente o sistema LID do WhatsApp (ver §14, "conectar uma
  instância") — nunca mais aceita o id interno cru como telefone (HANDOFF Parte
  CP); se o WhatsApp ainda não tiver esse mapeamento, o contato simplesmente não
  é sincronizado naquele momento (tenta de novo na próxima mensagem), em vez de
  salvar um telefone errado.
- **Nome de contato — duas fontes independentes** (`onMessage`/`pushName` acima
  cobre só mensagem NOVA recebida — histórico nunca traz esse campo, então toda
  conversa criada via backfill numa 1ª conexão ficava sem nome até a próxima
  mensagem ao vivo, HANDOFF Parte CT): `onContact`, callback novo e paralelo do
  `SessionManager`, alimentado pela AGENDA do próprio WhatsApp
  (`contacts.upsert`/`contacts.update` ao vivo, e o array `contacts` que vem
  dentro do próprio evento de backfill de histórico) — chama `upsertContact` de
  novo, independente do `onMessage` já ter rodado sem nome. Mesmo `coalesce` de
  segurança acima garante que as duas fontes convivem sem se atropelar.
- **Contatos**: criar manualmente, editar, excluir, **"Importar de conversas"**
  (cria um contato pra cada conversa de **qualquer** instância deste dono que ainda
  não tenha virado contato, usando `conversations.push_name` como nome quando
  disponível — corrigido na HANDOFF Parte DO; antes criava sempre sem nome,
  mesmo a coluna já vindo preenchida sozinha pelo WhatsApp. Idempotente: reexecutar
  também preenche retroativamente quem já tinha sido importado sem nome antes,
  sem sobrescrever nome editado manualmente depois), ou **"Importar de arquivo
  (CSV)"** — lê um
  `.csv` (colunas de nome/telefone reconhecidas em português ou inglês, delimitador
  `,` ou `;` detectado automaticamente — Excel em pt-BR exporta com `;`), até 5.000
  linhas, telefones duplicados no mesmo arquivo são mesclados num contato só. Sem
  suporte a `.xlsx` de propósito — a biblioteca padrão pra ler Excel (`xlsx`/SheetJS)
  tem 2 vulnerabilidades altas sem correção (Prototype Pollution, ReDoS) que
  travariam o processo inteiro do gateway com um arquivo malicioso.
- **Listas**: agrupar contatos existentes num conjunto nomeado (ex: "Clientes VIP"),
  reutilizável em qualquer campanha futura, de qualquer instância.
- **Modelos de mensagem**: geridos direto na Campanha (botão "Salvar como modelo"),
  armazenados por instância (diferente de contatos/listas).
- O seletor de instância no topo da página afeta só a seção "Grupos do WhatsApp"
  (um grupo pertence de fato a uma conexão específica, não pode ser compartilhado).

---

## 11.5. Sites — páginas públicas de captura de lead (`/sites.html`)

Cria e gerencia formulários públicos de captura de lead, cada um com a própria URL
(`/l/<slug>`), sem login/Bitrix — pra usar como destino de um anúncio, bio de
Instagram, etc. Por **dono**, igual Contatos (§11); um dono pode ter vários
formulários.

- **Criar um formulário**: nome interno (só pra você), título e subtítulo públicos
  (o que a visita vê), mensagem de boas-vindas (com `{{nome}}`), qual **instância**
  envia essa mensagem, e opcionalmente uma URL personalizada (se não informar, é
  gerada a partir do nome).
- **Personalização visual** (opcional): cor de destaque (hex, com seletor de cor +
  campo de texto sincronizados), logo, e imagem **ou vídeo** de fundo do banner de
  hero — os dois últimos aceitam colar a URL de uma mídia já hospedada em outro
  lugar (detecta `.mp4`/`.webm`/`.mov` na URL pra saber se é vídeo), ou clicar em
  "Enviar arquivo" (imagem: JPG/PNG/WEBP/GIF; vídeo: MP4/WEBM/MOV; bucket com
  limite de 25MB) pra fazer upload de verdade; o arquivo sobe pro bucket público
  `public-assets` do Supabase Storage (ver `src/publicAssets.js`, `saveHeroImage`)
  e vira uma URL pública permanente, preenchida automaticamente no mesmo campo —
  `lead_forms.hero_media_type` (`'image'`/`'video'`) diz pra `lead-form.html` se
  deve renderizar `<img>` ou `<video>`. A imagem de fundo do hero recebe uma
  camada escura por cima automaticamente, pra manter o título legível
  independente da foto escolhida (vídeo não recebe essa camada). O editor mostra
  uma **pré-visualização ao vivo** (miniatura ao lado dos campos) exatamente como
  a página pública vai ficar, atualizada a cada tecla.
- **Seções de conteúdo** (todas opcionais, editor organizado em abas — Principal,
  Visual, Estatísticas, Diferenciais, História, FAQ, Depoimentos): cada uma só
  aparece na página pública se tiver conteúdo.
  - **Estatísticas** (até 4): número + legenda (ex: "500+" / "clientes atendidos").
  - **Diferenciais** (até 6): título + descrição (ex: "Atendimento 24h").
  - **História**: um título + um parágrafo de texto livre sobre a empresa.
  - **FAQ** (até 8): pergunta + resposta, expansível na página pública.
  - **Depoimentos** (até 5): nome, cidade (opcional) e texto — **sempre escritos
    pelo próprio dono do formulário**, nunca inventados por este app; nunca mostra
    depoimento fictício só pra parecer mais confiável.
  Sem seção de "Planos" (preço/assinatura) de propósito — este gateway não tem
  Stripe/pagamento integrado, então seria só decorativo.
- **Página pública** (`public/lead-form.html`) é uma LP de seções completa:
  cabeçalho **full-bleed** (de ponta a ponta da tela, não preso na coluna
  central de 640px do conteúdo — sticky, só com o bloco de marca colado na
  borda esquerda, sem nenhum CTA) → banner de hero (título/subtítulo grandes,
  marca repetida em tamanho maior acima do título + **CTA duplo**: botão
  principal "Falar agora" com halo pulsante sutil que rola até o formulário,
  e botão secundário "Chamar no WhatsApp" que abre o `wa.me` direto — com
  `heroImageUrl` configurado, o hero vira **2 colunas** (texto à esquerda,
  foto num `<img>` de verdade à direita — sangrando até a borda direita real
  da tela e ocupando a altura INTEIRA da seção, não só até a altura do texto
  — não mais um background com camada escura por cima; colapsa pra 1 coluna
  abaixo de 860px); sem imagem,
  mantém o layout centralizado de sempre) → fita rolante de selos de
  confiança (loop contínuo, pausa ao passar o mouse) → estatísticas →
  diferenciais → história → FAQ → depoimentos → cartão de contato (âncora
  `#formulario`) → rodapé **também full-bleed** em **4 colunas** (marca
  colada na borda esquerda / contato do SDR dono da LP / navegação — só
  pras seções que existem — / **"Siga-nos"**: Instagram+LinkedIn da
  empresa + WhatsApp do SDR, selos quadrados dourados) com um **mapa de
  localização** full-bleed no topo (embed do Google Maps por texto, sem
  API key) — mesma identidade visual do resto do app (dourado/escuro). As
  seções **decorativas opcionais** (stats/diferenciais/história/FAQ/
  depoimentos) entram com uma animação sutil de fade+slide ao aparecerem na
  tela (`IntersectionObserver`, respeita `prefers-reduced-motion`) — o
  cartão do formulário em si **nunca** entra nessa animação (é o elemento
  mais importante da página, sempre visível de cara, não pode depender de
  scroll). **Marca no cabeçalho/hero/rodapé**: por padrão mostra o mesmo
  ícone genérico + texto "Durão, Almeida & Pontes" já usado como identidade
  fixa nas páginas internas do app (sobrescrito por `BRAND_NAME`/
  `BRAND_SUBTITLE` via `/api/brand` quando configurado); se a LP específica
  tiver `logoUrl` próprio configurado, ele tem prioridade e substitui o
  ícone genérico pela imagem real nos 3 lugares. **Instagram/LinkedIn/
  endereço da empresa** (`BRAND_INSTAGRAM_URL`/`BRAND_LINKEDIN_URL`/
  `BRAND_ADDRESS`, mesmo padrão do `BRAND_NAME`: vazio some da tela, nunca
  inventa link/endereço) alimentam a coluna "Siga-nos" e o mapa — ficam
  invisíveis até serem configurados. Um **botão flutuante do WhatsApp**
  (verde oficial, com anel pulsante) fica fixo no canto inferior direito
  durante toda a rolagem, além do CTA secundário no hero e do ícone de
  WhatsApp em "Siga-nos" — todos os pontos de entrada pro WhatsApp só
  aparecem se a LP tiver `contactPhone` configurado (instância já pareada)
  — sem número real não faz sentido oferecer um atalho pro WhatsApp. (O
  cabeçalho chegou a ter um 3º botão de WhatsApp — removido depois de
  reportado que não estava redirecionando; hoje o cabeçalho só tem a marca.)
- **Link público pula direto pro formulário**: a URL mostrada/copiada em Sites
  (e usada em "Ir para LP") sempre termina em `#formulario` — quem clica cai
  direto no card de contato, pulando o banner de hero (pensado pra link de
  anúncio/bio, onde a pessoa já sabe do que se trata).
- **Quando alguém preenche** (nome + telefone): cria/atualiza
  o Contato (mesma tabela centralizada por dono, ver §11) e tenta mandar a mensagem
  de boas-vindas pela instância configurada — se ela estiver offline no momento, o
  lead é salvo mesmo assim (só a mensagem automática que não sai; fica registrado
  como "não enviada" na lista de leads do formulário). **"Enviada" aqui significa
  só que o WhatsApp confirmou recebimento no SERVIDOR (`status: 'sent'`) — não
  que o aparelho do destinatário recebeu de verdade.** Numa sessão com conexão
  instável, a mensagem pode ficar presa nesse limbo indefinidamente (nunca vira
  `delivered`/`read`), sem nenhum aviso na tela — investigado a fundo, sem ser
  bug de código; ver HANDOFF Parte AY (ainda em aberto em 2026-07-16). A conversa de WhatsApp
  também ganha uma **tag automática com o nome da LP** (`store.createTag(...,
  fixed=true)`, coluna `tags.fixed`) — sem botão de remover no Chat, mesmo
  tratamento visual das tags sintéticas "Interno"/"Externo" — pra o atendente
  saber de relance de qual LP veio cada lead. Best-effort: falha ao aplicar a
  tag nunca derruba a submissão.
- **Ativar/desativar**: desativar não apaga nada, só faz a página pública mostrar
  "não disponível" e bloqueia novos envios — reversível.
- **Leads recebidos**: por formulário, lista quem preencheu, quando, e se a mensagem
  de WhatsApp saiu. Botão **"Exportar"** baixa a mesma lista em **CSV** (`;` como
  separador + BOM UTF-8, pra abrir certo no Excel em pt-BR) ou **XLSX** (via
  `exceljs` — nunca a lib `xlsx`/SheetJS, que tem vulnerabilidades altas sem
  correção; ver §2) — `GET /api/lead-forms/:id/submissions/export?format=csv|xlsx`.
- **Card do formulário** (lista em `/sites.html`): mostra uma miniatura com o logo
  configurado (ícone genérico se não houver), visualizações da página pública,
  conversão (`leadCount`/`viewCount`, com pelo menos 1 view), e a taxa de
  **"entrega"** da mensagem de boas-vindas (`whatsappSentCount`/`leadCount`, só
  aparece com pelo menos 1 lead) — verde a partir de 80%, vermelho abaixo disso.
  Apesar do nome, essa taxa mede quantas mensagens o WhatsApp aceitou no envio
  (`status: 'sent'`), não quantas o aparelho do destinatário de fato recebeu —
  ver caveat acima e HANDOFF Parte AY; pode estar mostrando verde mesmo com
  leads reais não recebendo a mensagem.
- **Visualizações**: cada carregamento da página pública incrementa um contador
  diário (`lead_form_views`, via `GET /api/leads/:slug/config`) — métrica de
  tendência, sem dedupe de visitante (reloads/bots contam).
- **Negócio no Bitrix por lead, num pipeline ÚNICO compartilhado**: contato no CRM
  (reusa por telefone via `crm.duplicate.findbycomm`, senão `crm.contact.add`) e UM
  negócio na categoria fixa `BITRIX_LEADS_CATEGORY_ID` (a MESMA pra todas as LPs e
  pro Agente de IA, §14.7), **atribuído ao SDR dono da LP** (`ASSIGNED_BY_ID` =
  sufixo do `ownerId`). A visibilidade "cada SDR só vê os próprios leads" é
  resolvida por **permissão nativa do Bitrix** (CRM > Permissões, escopo "somente
  próprios" pro papel do SDR) — configuração manual no portal, fora do alcance da
  API. O deal também é vinculado à conversa de WhatsApp (`setDealForPhone`) — a
  partir daí a timeline do negócio recebe as mensagens trocadas (feature já
  existente). Um único link **"Ver leads no Bitrix"** (não mais um por LP) aparece
  no topo da lista de formulários, apontando pro kanban dessa categoria.
  - **Gatilho: quando o LEAD RESPONDE, não quando o formulário é enviado**
    (mudou na Parte EM, 2026-08-26 — antes o negócio nascia no próprio envio do
    formulário). O envio salva o lead local + tag da LP + tenta a boas-vindas;
    o negócio só é criado depois, quando o visitante manda a 1ª mensagem de
    verdade respondendo — mesmo gatilho já usado pelo fluxo de Campanha (número
    direto, sem formulário), via `agentDispatch.js::handleNewLeadMessage`
    (chamado de dentro de `onMessage`, `src/server.js`). **Só roda se o
    Agente de IA estiver ativo** naquela instância (`agentConfig.active` —
    revertido na Parte EP, 2026-08-26: chegou a ficar incondicional por um
    tempo, mas o usuário confirmou que deve depender do mesmo toggle que já
    liga a resposta automática, não são coisas separadas). Instância sem o
    Agente de IA ativado nunca cria negócio, mesmo que o lead responda.
    `bitrix_deal_id`/`bitrix_contact_id` continuam gravados de volta em
    `lead_form_submissions` no momento da resposta (não mais no envio) quando
    o negócio É criado. Falha no Bitrix **nunca perde o lead local** — a
    submissão já foi gravada antes, `bitrix_deal_id` só fica `NULL`.
  - **Histórico de arquitetura**: a primeira versão criava um pipeline NOVO por LP
    (`crm.category.add`) — abandonado. Uma automação de controle de duplicidade já
    existente neste portal (checa o campo "Número do Processo") apaga automaticamente
    QUALQUER negócio novo sem esse campo preenchido, tratando "vazio" como duplicata
    de "vazio" — afetava até leads 100% novos, não só duplicatas de verdade (ver
    HANDOFF.md Partes AT/AV para o diagnóstico completo). Pivotado pra um pipeline
    único e fixo, decisão do usuário — resolve o problema de raiz (não cria mais
    pipeline novo via API) e simplifica a visibilidade pra permissão nativa do CRM.
- **Quando alguém preenche**: cria/atualiza o Contato, aplica a tag da LP e tenta
  mandar a boas-vindas pela instância configurada — offline não bloqueia o lead.
- Rotas públicas (`/api/leads/*`) ficam **fora** de `requireAuth` de propósito — quem
  preenche o formulário nunca autenticou com nada, o `slug` é o único "segredo" de
  acesso, como qualquer link público de formulário (ver §16).

### Testes A/B entre LPs

Seção "Testes A/B" em `/sites.html`: cria um teste pareando **duas LPs suas** — a URL
pública única `/t/<slug>` divide o tráfego 50/50 (redirect 302 pra `/l/<slug>` da
variante sorteada, com cookie sticky de 90 dias — visitante repetido cai sempre na
mesma variante; query string/utm preservada, âncora `#formulario` mantida).

- **Métricas por variante** (ao vivo no card do teste): views, leads e conversão
  dentro da janela do teste. A atribuição é natural: o visitante acaba na URL da
  própria variante, então view e submissão contam pra ela. **Recomendação**: use LPs
  dedicadas ao teste e divulgue só a URL `/t/` — tráfego direto no `/l/` de uma
  variante durante o teste mistura as métricas.
- **Encerrar**: escolhe o vencedor (A/B/sem vencedor) e escreve a **análise
  obrigatória** (aprendizados) — métricas são congeladas (`final_metrics`) e o teste
  vira histórico imutável. Depois de encerrado, `/t/<slug>` redireciona todo mundo
  pro vencedor.
- **"✨ Gerar com IA"** (botão no modal de encerrar): chama a OpenAI (`gpt-4o-mini`,
  `src/openai.js`) com as métricas AO VIVO do teste (views/leads/conversão de cada
  variante + snapshot da config) e preenche a textarea com uma sugestão de análise —
  o texto é só um rascunho, sempre revisável/editável antes de encerrar. Exige
  `OPENAI_API_KEY` (opcional); sem ela, o botão mostra erro e a análise continua
  podendo ser escrita manualmente (nunca bloqueia o encerramento do teste).
- **Cancelar**: só testes em andamento (remove sem entrar no histórico).
- **Histórico de análises** (`GET /api/ab-tests/history`): estruturado por teste —
  snapshot da config de cada variante (título, cor, seções usadas), métricas finais,
  vencedor e a análise escrita. Pensado pra servir de **base de conhecimento/system
  prompt de uma futura IA geradora de LPs** ("o que já deu certo").
- Uma LP em teste **em andamento** não pode ser excluída (encerre/cancele o teste
  primeiro).

---

## 11.6. Métricas de Sites (`/lead-metrics.html`)

Dashboard agregado de desempenho de **todas as LPs do dono**, mesmo padrão visual/
técnico de Métricas de Campanhas (§12): KPIs, gráfico de linha dos últimos 30 dias,
tabela detalhada. Sem seletor de instância — agrega por dono, não por instância de
WhatsApp (uma LP já escolhe sua própria instância só pra mandar a boas-vindas).

- **KPIs**: formulários ativos/total, visualizações totais, leads recebidos,
  conversão geral (leads/visualizações) e taxa de entrega no WhatsApp
  (mensagens entregues/leads).
- **Gráfico "Visualizações e leads por dia"** (últimos 30 dias, com zero
  preenchido nos dias sem dado — diferente do gráfico de Métricas de Campanhas,
  que só plota os dias com registro): duas linhas (dourado = visualizações, verde
  = leads), agregando todas as LPs daquele dia.
- **Tabela "Por formulário"**: nome, visualizações, leads, conversão, taxa de
  entrega no WhatsApp (verde ≥80%, vermelho abaixo) e status ativo/inativo — por
  LP individualmente.
- Atualiza sozinho a cada 15s (mesmo padrão de Métricas de Campanhas) + botão
  "Atualizar agora".
- Rota: `GET /api/lead-forms/metrics` (autenticada, escopada por `req.ownerId`) —
  ver `leadForms.computeMetrics` em `src/leadForms.js`.

---

## 12. Métricas de Campanhas (`/campaign-metrics.html`)

Histórico e desempenho dos disparos em massa **da própria instância** do usuário (ou
de todas as suas instâncias, se tiver mais de uma — seletor no topo). KPIs (campanhas
disparadas, destinatários totais, enviadas, falharam, taxa de sucesso), gráfico de
envios por dia (últimos 30 dias, enviadas × falharam) e tabela das 25 campanhas mais
recentes com status. Atualiza sozinho a cada 15s.

---

## 13. Agenda de Envios — Kanban e Calendário (`/campaign-schedule.html`)

Gestão de campanhas **agendadas** pra disparo futuro, com duas visões alternáveis:

- **Kanban**: colunas *Agendado* → *Enviar agora* (zona de arrastar-e-soltar: um card
  "Agendado" solto aqui dispara na hora, ignorando a data marcada) → *Enviando*
  (progresso ao vivo) → *Enviado* (resultado final). Cada card também tem botões
  "Enviar agora", "Reagendar" e "Cancelar", pra quem preferir clicar em vez de
  arrastar.
- **Calendário**: visão mensal com os agendamentos no dia marcado; clicar num dia
  abre a lista completa daquele dia com as mesmas ações.
- **Disparo automático**: um poller no servidor (`src/scheduler.js`, a cada 30s)
  verifica agendamentos cuja hora já chegou e dispara sozinho, sem depender de
  ninguém com a página aberta.
- Ao disparar (manual ou automático), o agendamento vira uma campanha de verdade
  (`campaigns`) e passa a aparecer também nas Métricas de Campanhas (§12).
- **Mídia anexada**: sobe pro Storage já na hora de agendar (`POST
  /campaign/schedule` chama `saveMedia()` uma vez), guardando só o caminho
  (`scheduled_campaigns.media_url`) em vez do arquivo em base64 na própria
  linha. `src/scheduler.js` baixa os bytes de volta (`downloadMedia()`) na hora
  de disparar. Agendamentos criados antes dessa mudança continuam com o dado
  no formato antigo (`media_base64`) — `scheduler.js` lê os dois formatos.
  Limitação conhecida: o arquivo "pendente" que fica no Storage entre agendar
  e disparar não é apagado depois (o disparo de verdade sobe uma cópia própria
  por destinatário) — vira lixo órfão no bucket com o tempo, ver §20.
- **Retry automático (erro 463)**: quando um destinatário de uma campanha (§10) é
  rejeitado pelo WhatsApp depois do envio, um agendamento novo é criado sozinho
  aqui — 24h depois, só com os telefones que de fato falharam, com o selo "↻ Retry
  automático" no card pra diferenciar de um agendamento manual. Nunca mais de 1
  tentativa por campanha (mesmo que o próprio retry falhe de novo) — alinhado com
  o aviso do código-fonte do Baileys de que retry repetido tende a piorar a
  restrição, não resolver (ver HANDOFF, Parte CN). Cancela/reagenda como qualquer
  outro card — o selo não muda nenhum comportamento, só identifica a origem.

---

## 14. Instâncias (`/instances.html`)

Gestão das instâncias de WhatsApp do usuário logado — permite conectar mais de um
número e escolher qual usar em cada conversa (chat) ou campanha:

- **+ Nova instância**: abre um modal (no mesmo estilo do "Renomear" da própria
  página, não um `prompt()` nativo do navegador) pedindo um nome (ex: "Vendas",
  "Suporte") e já mostra o QR Code pra parear na hora.
- **Limite de 3 instâncias por dono** (`MAX_INSTANCES_PER_OWNER`,
  `src/routes/whatsapp.js`) — decisão de negócio, não limitação técnica.
  `POST /instances` recusa (400) a partir da 4ª; `GET /instances` devolve
  `limit` pra tela mostrar "X/3" no cabeçalho e desabilitar o botão antes
  do usuário tentar. Só vale pra criar uma nova — não afeta quem porventura
  já tivesse mais de 3 antes desta regra existir (ninguém tinha, conferido
  em 2026-07-17).
- **Renomear** e **Remover** — remover tenta deslogar de verdade do WhatsApp
  (`sock.logout()`, some da lista "Aparelhos conectados" no celular) além de apagar
  o registro e as credenciais locais.
- **Conectar uma instância (1ª vez ou reconexão)**: o Baileys entrega sozinho,
  via `messaging-history.set`, o histórico de conversas anterior à conexão —
  `src/whatsapp.js` sobrescreve `shouldSyncHistoryMessage` pra aceitar TODO
  `syncType` (incluindo `FULL`, o histórico profundo; o default da lib
  descartava isso, só entregava uma janela curta recente). Reusa o mesmo
  pipeline de `messages.upsert` (mesmos filtros, mesma resolução de
  telefone), então o mesmo sync automático de contato (ver §11) já roda
  pras mensagens de histórico também — conectar uma instância nova já traz
  o histórico completo de conversas E os contatos correspondentes, sem
  ação manual. Não é a agenda telefônica inteira (contato que nunca
  trocou mensagem com aquele número) — o Baileys não expõe isso de forma
  utilizável (ver HANDOFF Parte CP).
- **Desconexão e reconexão automática**: uma queda temporária (rede,
  timeout) reconecta sozinha com backoff crescente (3s, 6s, 12s... até um
  teto de 5min, zera ao reconectar de novo) — não precisa de nenhuma ação.
  Já uma recusa que o WhatsApp trata como permanente (número
  restrito/banido, outro aparelho assumiu a sessão, credencial corrompida)
  faz o card mostrar **"Precisa de atenção"** com o motivo explicado e um
  botão **"Tentar reconectar"** — o app para de insistir sozinho nesses
  casos (ver HANDOFF Parte CQ: até 12/08/2026, o código tentava reconectar
  a cada 3s pra sempre mesmo numa recusa permanente, o que sobrecarregava o
  servidor inteiro e cada tentativa nova prolongava o próprio bloqueio do
  WhatsApp). "Tentar reconectar" usa as credenciais já salvas (não apaga
  nada); se não resolver, "Remover" e parear de novo continua disponível.
- **Alerta de instância caída** — histórico de quedas + duração no card +
  push, complementar ao "Precisa de atenção" acima:
  - Enquanto a queda está em aberto, o card mostra **"Fora do ar há
    Xh"** (âmbar, discreto) se for queda temporária reconectando sozinha,
    ou o bloco vermelho "Precisa de atenção" já existente se for
    permanente — nunca os dois juntos. Duração calculada no client a
    partir de um timestamp absoluto (`openConnectionEvent.startedAt`,
    `GET /instances`), atualiza a cada 30s.
  - Botão **"Ver histórico"** (aparece pro dono E pro delegado — rota de
    LEITURA, diferente das de ação abaixo) abre modal com a lista de
    quedas/retomadas (mais recente primeiro, com duração e motivo) + uma
    tabela da série diária de métricas (conversas, contatos, grupos) —
    `GET /instances/:id/health?owner=`.
  - **Alerta em 4 canais** (Parte FC, 2026-08-27): quando uma queda
    escala pra "precisa de atenção" (nunca numa queda temporária isolada
    — inundaria o usuário), o dono e todos os delegados são notificados
    por `src/alertDispatcher.js` — 4 canais **independentes/best-effort**
    (falha em 1 nunca bloqueia os outros): (1) **in-app**, na Central de
    Notificações (§15), sempre funciona; (2) **Web Push** (Service
    Worker, `public/sw.js` + `src/webpush.js`) — diferente da
    notificação nativa simples de antes, funciona mesmo com **todas as
    abas do sistema fechadas** (precisa ter clicado "Ativar notificações
    do sistema" — ícone ao lado do sino, em todas as 17 telas com
    sidebar — pelo menos uma vez); (3) **WhatsApp de sistema**
    (`src/whatsappAlert.js`) — manda uma mensagem pro celular do
    destinatário usando **outra instância do mesmo dono** que ainda
    esteja online (se só houver 1 instância, ou nenhuma outra estiver
    online, este canal simplesmente não dispara); (4) **e-mail**
    (`src/email.js`/`src/emailAlert.js`, via Resend) — destinatário
    resolvido do campo `EMAIL` do cadastro Bitrix. Canais 2-4 dependem
    de configuração opcional (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`,
    `RESEND_API_KEY`, `BITRIX_HR_WEBHOOK_URL`) — sem elas, degradam
    silenciosamente e o canal in-app continua funcionando normalmente.
  - Backend: `instance_connection_events` (uma linha por queda) +
    `instance_metrics_daily` (snapshot diário, job de 1h em
    `src/server.js`) — ver `src/instanceHealthStore.js`. Detecção
    reaproveita 100% o que já existia (`needsAttention`/`loggedOut`/
    `lastDisconnectReason`, ver acima) — só passou a ser persistida e
    conectada ao dispatcher de alerta, nada novo do lado da conexão em si.
- A primeira instância de cada usuário é sempre a "Principal" (compatibilidade com
  quem já usava o app antes desta função existir — nenhum dado precisou ser migrado).
- **Compartilhar acesso** (botão no card, só aparece pra quem é dono de verdade):
  delega a instância pra outro usuário do Bitrix — busca por nome via
  `BX24.callMethod('user.search')`, mas **restrita aos próprios subordinados
  na hierarquia** (`GET /instances/eligible-delegates`, ver "Delegação
  AUTOMÁTICA" abaixo — mesma fonte, `hierarchy_subordinates`); sem
  hierarquia mapeada pro dono, a busca fica vazia de propósito, não abre
  pra todo o portal. Quem recebe passa a ver/responder as
  conversas dela em `chat.html` (aparece com sufixo "(compartilhada)" no
  seletor), sem contar contra o próprio limite de 3. Só o dono concede/revoga
  (tabela `instance_delegates`, ver `src/instances.js`). Cada conversa fica
  **atribuída** a um atendente por vez (dono ou delegado) — "Atender esta
  conversa"/"Transferir pra mim" no cabeçalho do Chat; notificação de mensagem
  nova vai só pra quem está atendendo, ou pra todo mundo com acesso (dono +
  delegados) enquanto ninguém pegou ainda.
- **Delegação AUTOMÁTICA via hierarquia do Bitrix** (`src/bitrixHierarchy.js`,
  opcional — precisa de `BITRIX_HR_WEBHOOK_URL`): diferente do
  "Compartilhar acesso" acima (manual, instância por instância), o gestor
  de um departamento passa a enxergar automaticamente as instâncias de
  **todo** subordinado — cascateando sub-departamentos, não só quem está
  direto abaixo dele. Resolvido via `department.get` (acha o gestor —
  `UF_HEAD` — e a árvore de departamentos) + `user.get` (`UF_DEPARTMENT`,
  quem está em cada um), cacheado na tabela `hierarchy_subordinates` por
  `HIERARCHY_CACHE_TTL_HOURS` (padrão 6h — recalcular a cada request seria
  lento e arriscaria rate limit do Bitrix). O gestor não precisa fazer
  nada — nem o subordinado — pra esse acesso existir; aparece sozinho no
  seletor de instância do Chat com o mesmo sufixo "(compartilhada)" da
  delegação manual. Sem a env var configurada, a feature fica
  silenciosamente inativa (mesmo padrão de degradação graciosa do
  `BITRIX_WEBHOOK_URL` de CRM).
- **Layout em cards** (grid, não lista/tabela): cada instância é um card com nome,
  badge de status colorido (verde "Conectada" / dourado "Aguardando QR" / vermelho
  "Desconectada"), número conectado e duas estatísticas — contagem de **contatos**
  e de **grupos** daquele número.
  - **Grupos**: `WhatsAppGateway.getGroupCount()` chama
    `sock.groupFetchAllParticipating()` — os grupos REAIS que o número participa no
    WhatsApp (diferente da tabela `wa_groups`, que só guarda grupos criados por
    este app via a função "criar grupo" da Campanha). Só disponível com a sessão
    `online`; mostra "—" caso contrário.
  - **Contatos**: acumulado em memória dos eventos `contacts.upsert`/
    `contacts.update` do Baileys (`getContactCount()`), **não** um total exato —
    a lib não expõe nem uma chamada de contagem nem um snapshot completo da
    agenda, só incrementos. O número cresce enquanto a sessão fica online
    recebendo eventos e zera a cada reinício do processo/reconexão do zero; é uma
    estimativa, não vai bater com a agenda telefônica real do celular.

---

## 14.5. Painel Admin — restrito (`/admin.html`)

Tela visível e acessível **só pra uma lista pequena de `ownerId`**
(`SUPER_ADMIN_OWNER_IDS`, CSV em `.env`, ver `src/adminAuth.js`) — nada a
ver com dono de instância ou hierarquia de departamento/gestor (§14
acima). Item "Admin" na sidebar fica `hidden` por padrão em todas as
telas e só é revelado por JS depois que `GET /admin/whoami` confirma
`isSuperAdmin: true` — mas a proteção de verdade está nas próprias rotas
(`requireSuperAdmin`, 403 pra qualquer outro `ownerId`), não no
esconder/mostrar do link.

### Métricas de uso (cards + gráficos)

4 cards no topo (online agora, usuários ativos nos últimos 30 dias,
tempo total do time, página mais acessada) + 2 gráficos de barra
horizontal (páginas mais acessadas por contagem de visitas; onde o time
passa mais tempo por duração real) — via `GET /admin/usage-metrics?days=`,
alimentado por `page_sessions` (ver seção "Usuários" abaixo). Passar o
mouse sobre uma barra mostra um tooltip com o detalhamento DIA A DIA
dos últimos 30 dias (`dailyByPage` na resposta, `getDailyBreakdownByPage`
em `src/pageSessions.js`, HANDOFF Parte CY) — diferente do valor
agregado ao lado da barra, que é só o total do período.

### Usuários (tabela única + trackeamento real)

Substituiu as duas tabelas antigas ("online agora"/"funcionários", ver
histórico no HANDOFF Parte CL) por uma tabela só, um usuário por linha,
via `GET /admin/users` — cruza o **universo completo** de
`listEmployees()` (cadastro do Bitrix via `BITRIX_HR_WEBHOOK_URL`, §14 —
todo mundo aparece, mesmo quem nunca abriu o app) com presença, último
acesso, tempo total (30d), página favorita e bloqueio.

- **Online/offline**: sessão ativa do próprio app, não presença do
  Bitrix24 em si. Toda tela manda um heartbeat pra `POST
  /presence/heartbeat` a cada 30s enquanto estiver aberta — qualquer
  usuário autenticado pode mandar, não só admin — **exceto
  `onboarding.html`**: tem autenticação mínima desde a Parte EG
  (`verifyAuth`/paleta pessoal/revelar seção Admin, ver HANDOFF Partes
  EG e EN), mas deliberadamente sem heartbeat/toast/`confirmDialog` —
  escopo reduzido ao que a tela precisa, nunca aparece como "online" no
  Admin. Considerado offline sem heartbeat por 90s (3 ciclos perdidos).
- **Trackeamento real de tempo/página** (tabela `page_sessions`,
  `src/pageSessions.js`) — diferente do heartbeat (que só marca "app
  aberto agora"), aqui é medido tempo de verdade por página, entrada e
  saída: no boot de cada tela, `POST /page-session/open` cria uma linha
  (`started_at`); a cada ciclo de heartbeat (30s), `POST
  /page-session/ping` atualiza `last_ping_at`; ao trocar/fechar a
  página, `window.addEventListener('pagehide', ...)` dispara
  `navigator.sendBeacon('/api/whatsapp/page-session/close', ...)`, que
  marca `ended_at = now()`. **Sessões órfãs** (crash, queda de luz, aba
  que nunca disparou `pagehide`) são fechadas por um job (`setInterval`
  em `src/server.js`, a cada 60s) depois de 90s sem ping —
  `ended_at = last_ping_at` (não o momento da detecção), pra duração
  registrada nunca incluir o tempo "esquecido" até o job rodar.
  `sendBeacon` não permite header de `Authorization`; a rota de
  fechamento aceita o token no próprio body por isso.
- **Paginação + busca + filtros** (client-side, `public/admin.html`,
  HANDOFF Parte CY/DM): `GET /admin/users` traz TUDO numa chamada só
  (nenhuma paginação de servidor); corte só na hora de renderizar, 20
  por página. Busca filtra por nome, e-mail OU cargo (match parcial,
  case-insensitive). 5 filtros adicionais (dropdown, combináveis entre
  si e com a busca — todos aplicados dentro do mesmo `filtered =
  usersRows.filter(...)`, sem chamada de API extra): **Status**
  (Online/Offline/Bloqueado), **Página favorita** e **Cargo** (as 2
  populadas dinamicamente a partir dos valores que de fato aparecem em
  `usersRows`, não uma lista fixa — cobre página/cargo novo sem editar
  o arquivo), **Acesso à Auditoria de Conversas** (com/sem) e
  **Atividade** (só "nunca usou o app" hoje — `lastAccess` nulo,
  diferente de "sem uso nos últimos 30 dias", que incluiria quem usou
  há 40 dias e seria rótulo confuso). Botão "Limpar filtros" reseta os
  5 selects + a busca de uma vez. O contador "Usuários N" no
  cabeçalho do painel mostra **"N de T"** sempre que algum filtro/
  busca reduz o resultado (antes mostrava sempre o total geral, mesmo
  com a tabela filtrada pra 1 linha — confundiu um usuário real que
  comparou isso com o card "Online agora", HANDOFF Parte DN), e uma
  linha abaixo dos filtros lista em texto qual busca/filtro está
  ativo no momento.
- **Detalhado**: modal expandido (720px, HANDOFF Parte CY) com cadastro
  COMPLETO do Bitrix pra aquela pessoa (cargo, e-mail, celular, telefone
  comercial, cidade, nascimento, data de admissão, criado no Bitrix,
  último login NO BITRIX — distinto do último acesso a ESTE app) +
  seção **"Atividade no app"** (HANDOFF Parte DA: dias ativos nos
  últimos 30d — frequência, não só tempo total —, mensagens enviadas,
  contatos cadastrados, campanhas criadas — este último aproximado por
  DONO da instância, não por quem de fato criou, ícone "ⓘ" explica) +
  **histórico de ações** paginado (HANDOFF Parte DC — instância
  conectada, campanha criada, contato criado/importado, grupo criado,
  conversa atribuída a si mesmo; tabela `action_log`; deliberadamente
  SEM conteúdo digitado nem gravação de tela, decisão confirmada com o
  usuário pelo risco de capturar dado sigiloso de cliente/caso) +
  histórico de `page_sessions` paginado (HANDOFF Parte DB), mais
  recente primeiro. Botão **"Enviar mensagem no WhatsApp"**
  (HANDOFF Parte CZ, some sem celular cadastrado) redireciona pra
  `/chat.html?session=<instância do próprio super admin>&phone=<celular
  normalizado>` — reaproveita o deep-link já existente em `chat.html`
  (usado hoje também por `notifications.html`), sem UI de chat duplicada
  dentro do modal.
- **Ver conversas** (HANDOFF Parte DS, 2026-08-20): link na própria
  linha da tabela (não dentro do modal), pra
  `/conversation-analysis.html?sentBy=<ownerId>` — abre a Auditoria de
  Conversas já filtrada pelas conversas que ESSA pessoa atendeu
  (`messages.sent_by`, não pela instância/dono). A tela de Auditoria lê
  esse parâmetro 1x no boot (`applyFiltersFromUrl`).
- **As 4 ações acima (Detalhado/Revogar/Auditoria/Ver conversas) vivem
  num menu de "3 pontos" por linha** (`.kebab-btn`/`.kebab-menu`,
  HANDOFF Parte DY) — ficavam largas demais expandidas direto na
  célula, com a tabela já cheia de colunas. Puramente apresentação:
  os mesmos `data-*`/delegação de evento em `#usersBody` de sempre,
  nenhum handler mudou. Só um menu aberto por vez; fecha ao clicar
  fora ou ao escolher uma ação.
- **Revogar/Reativar**: bloqueia/desbloqueia o `ownerId` de usar o app
  **inteiro** (tabela `blocked_owners`) — `POST
  /admin/users/:ownerId/block`|`unblock`. Verificado dentro de
  `requireAuth`, em **toda** request autenticada: um `ownerId` bloqueado
  é cortado (403) na próxima chamada, mesmo com um token já emitido
  antes do bloqueio — não espera o token expirar. Um super admin nunca
  consegue bloquear o próprio `ownerId` (trava contra ficar trancado
  fora por engano). Confirmação sempre via `confirmDialog` (nunca
  `confirm()` nativo, regra do projeto) — `admin.html` chamava essa
  função em 3 lugares sem nunca defini-la (bug real corrigido na Parte
  CY, deixava Revogar/Reativar/Marcar sugestão como lançada quebrados).
- **Editar**: só abre um modal com o motivo do bloqueio (`reason`) — não
  existe um cadastro de usuário próprio neste sistema pra editar de fato
  (nome, permissão), a identidade sempre vem do Bitrix.
- **Funcionários (Bitrix)**: cargo (`WORK_POSITION`), foto
  (`PERSONAL_PHOTO`), e-mail, data de criação (`DATE_REGISTER`, "—" se o
  Bitrix não devolver esse campo pra aquele usuário), celular
  (`PERSONAL_MOBILE`), telefone comercial (`WORK_PHONE`), cidade
  (`PERSONAL_CITY`), nascimento (`PERSONAL_BIRTHDAY`), admissão
  (`UF_EMPLOYMENT_DATE`), último login no Bitrix (`LAST_LOGIN`) — mesmo
  webhook `BITRIX_HR_WEBHOOK_URL` da hierarquia automática (§14). Sem a
  variável configurada, a lista fica vazia com um aviso explícito na
  tela (não um erro nem um vazio silencioso).

### Publicar no Feed do Bitrix — restrito a super admin

Painel novo na mesma tela (`admin.html`): anuncia novidades do sistema
no **Feed nativo do Bitrix24** ("Para todos os colaboradores" — Live
Feed, `stream/`), diferente do `crm.timeline` (§17, `src/bitrix.js`)
usado hoje pra comentário dentro de UM negócio. Publicação é sempre
**manual** — o super admin escreve título (opcional) e mensagem, clica
"Publicar" (confirmação antes, via `window.confirmDialog` — nunca
`confirm()` nativo), e o texto vai pro Feed via `log.blogpost.add`.
Depois de publicado, editar/remover só é possível direto no Bitrix —
este app não tenta.

Usa um **webhook de entrada dedicado** (`BITRIX_FEED_WEBHOOK_URL`, ver
§3) — não reaproveita `BITRIX_WEBHOOK_URL` porque `log.blogpost.add`
exige o escopo "Rede Social", que o webhook de CRM não tem. Módulo
`src/bitrixFeed.js`. Histórico LOCAL do que já foi publicado (tabela
`feed_posts`) aparece embaixo do formulário — nunca é a fonte de
verdade (o Bitrix é o dono real do post), só um registro pra não
duplicar anúncio; grava mesmo em falha (`status:'failed'` + o erro),
mostrado em vermelho na lista.

Rotas: `POST /api/whatsapp/admin/feed-post` `{ title?, content }` e
`GET /api/whatsapp/admin/feed-posts` (últimos 100) — ambas restritas a
`requireSuperAdmin` (ver §17, `src/adminAuth.js`). O campo do body se
chama `content`, não `message` (nome usado internamente/na coluna do
banco) — uma proteção na infraestrutura de produção bloqueia POST
nesta rota especificamente quando o body tem uma chave literal
`message` (confirmado não chegar no Express — sem `X-Powered-By`/
`Ratelimit-*` na resposta), descoberto em teste real 2026-08-25.

### Sugestões — Kanban (3 colunas) restrito a super admin

Segunda seção da mesma tela: Kanban de 3 colunas (Pendente / Em análise
/ Lançado) sobre as sugestões enviadas em `/suggestions.html` — cada
card com "Responder" (a resposta publica na FAQ pública, ver §15.5) e
botões pra mover de coluna. Toda ação de triagem (mover, responder,
marcar lançada) exige `requireSuperAdmin`; enviar/listar sugestão
continua aberto a qualquer autenticado (visão de time). Mover pra "Em
análise" notifica automaticamente quem sugeriu (Central de
Notificações, §15).

**Ação manual pendente em produção**: `SUPER_ADMIN_OWNER_IDS` precisa ser
configurada nas env vars do EasyPanel — o `.env` local é gitignored, não
viaja com o código. Sem isso, `/admin.html` fica 403 pra todo mundo até
alguém configurar.

---

## 14.6. Apresentação — relatório executivo (`/apresentacao.html`)

Relatório em formato scrollytelling (rolagem com reveal por seção,
sumário lateral fixo com destaque automático da seção visível, botão
"Baixar apresentação" que abre a caixa de impressão do navegador pra
salvar como PDF) — pensado pra diretoria/CEO, não pra uso operacional
do dia a dia. Sem sidebar (layout próprio, full-width), mas autentica
igual às 14 telas com sidebar (`BX24.init` → `verifyAuth` →
`GET /api/settings`) e aplica a paleta pessoal do usuário por cima da
global — corrigido em 2026-08-25 (antes disso a página nem carregava
o script do BX24, então nunca lia a paleta pessoal, só a global via
`/api/brand`; ver HANDOFF Parte EH).

Conteúdo é HTML estático escrito à mão (não gerado a partir dos dados
reais do sistema) — números citados (contagem de telas, tabelas,
conexões ativas) precisam ser **atualizados manualmente** a cada
mudança relevante de escala ou de escopo do sistema; não há nenhum
mecanismo automático que os mantenha em dia sozinho.

---

## 14.7. Agente de IA (`/agente-ia.html`)

Atendimento automático de **leads novos** (nunca conversa já existente
de cliente antigo) que chegam por WhatsApp — configurável por
instância, desligado por padrão. Tela própria com sidebar (mesmo
boilerplate de autenticação/paleta/heartbeat de `instances.html`),
acessível pelo link "Agente de IA" logo abaixo de "Chat" em todas as
16 telas com sidebar.

**Edição em wizard de 4 etapas** (Parte ES, 2026-08-26 — antes era
uma lista única com as 5 seções abaixo todas empilhadas visíveis de
uma vez): barra de progresso no topo (`.wizard-steps`, puro CSS, sem
lib) + botões Voltar/Próximo navegando entre (1) Instância + Ativação,
(2) Mensagem de sistema, (3) Base de conhecimento — texto e upload
lado a lado num grid de 2 colunas em tela larga, (4) Revisão (resumo
somente-leitura de tudo, lido ao vivo do DOM das etapas anteriores) +
"Salvar configuração", que só aparece na última etapa. Layout
`#app` também ficou mais largo (`max-width: 1100px`, era `820px`),
aproveitando melhor o espaço em tela grande sem virar uma linha de
texto difícil de ler.

- **Ativação por instância** (`agent_config`, PK `session_id`): toggle
  "Agente ativo nesta instância" — **nasce desligado** (`active =
  false`) pra toda instância nova; nenhum negócio é criado nem resposta
  automática é enviada até o usuário ativar manualmente. Não existe
  ativação em massa nem herança entre instâncias. **Piloto restrito**
  (Parte EY, 2026-08-27): só um `ownerId` em `SUPER_ADMIN_OWNER_IDS`
  consegue de fato LIGAR o toggle (`PUT /config` com `active:true`
  devolve `403` pra qualquer outro dono) — desligar ou editar mensagem
  de sistema/base de conhecimento continua liberado normalmente. Vale
  também pro Copiloto Comercial (§14.9). Mesma régua já usada em
  `/admin.html`, sem tabela/config nova.
- **Comportamento quando ativo**: a IA responde automaticamente à
  **1ª mensagem** de um número nunca visto naquela instância — função é
  triagem inicial, não a conversa inteira. Nunca fala primeiro (a
  boas-vindas fixa de LP continua exatamente como sempre foi). Nunca se
  desativa sozinha por conteúdo da mensagem (nada de heurística de
  linguagem) — só para por (a) botão "Desativar IA nesta conversa" no
  Chat, ou (b) automaticamente assim que um humano manda uma mensagem
  manual naquela mesma conversa (evita os dois respondendo em cima um
  do outro); depois de desativada, nunca reativa sozinha.
- **Origem do lead**, refletida no card criado no Bitrix (categoria
  **628**, mesma variável `BITRIX_LEADS_CATEGORY_ID` usada pelas LPs,
  ver §11.5): telefone com submissão de formulário em
  `lead_form_submissions` → título/tag "LP: `<nome da LP>`"; número
  desconhecido mandando mensagem direta, sem formulário → "Campanha".
  A criação do card **só acontece se o Agente de IA estiver ativo**
  naquela instância (mesmo toggle acima — decisão confirmada com o
  usuário na Parte EP: nunca cria negócio automaticamente numa
  instância que não ativou o agente). Criação do negócio + aplicação
  da tag rodam **em background** (fire-and-forget), nunca atrasam a
  resposta da IA ao lead — a tag aparece na lista de conversas do Chat
  em tempo real (WebSocket `type: 'tags-updated'`), sem precisar de
  reload manual.
- **Grupo de WhatsApp automático** (Parte EV, gatilho mudado na Parte FD):
  dispara **quando o negócio FECHA** (atinge a etapa de "ganho" no
  Bitrix) — não mais na criação do card. Cria um grupo de WhatsApp
  reunindo o **cliente** (o próprio lead) e o **dono da instância**
  (celular cadastrado no Bitrix, `PERSONAL_MOBILE`). Nome do grupo =
  mesmo título do card ("LP: `<nome>`" ou "Campanha"). O grupo é gravado
  com `source='card'` + `deal_id` (mesma marca da criação manual pela
  aba DapZap, §15.7) — herda o bypass que faz mensagem recebida de
  grupo ser salva em vez de descartada, e o switch Cliente/Grupo no
  card. Best-effort: se o dono não tiver celular no Bitrix, o grupo é
  criado só com o cliente; se a instância estiver offline no momento, o
  grupo simplesmente não é criado. Idempotente (não cria um segundo
  grupo pro mesmo negócio). **Só** pros cards criados pelo Agente de IA.
  **Rastro visível** (Parte EY, 2026-08-27): a criação avisa em 2
  lugares — comentário na timeline do NEGÓCIO no Bitrix
  (`logStatusToTimeline`) e uma **nota interna** (nunca visível ao
  cliente) na conversa do lead no Chat, rotulada "Nota interna · Agente
  de IA". Ambos best-effort/fire-and-forget.
  - **Detecção do fechamento** (Parte FD, `src/dealStagePoller.js`): o
    Bitrix não avisa o gateway quando um negócio muda de etapa (sem
    webhook de evento configurado) — um poller próprio varre a cada
    ~20min todos os negócios vinculados a conversas (`deal_id`
    preenchido), compara a etapa atual com a última vista
    (`deal_stage_watch`), e dispara o grupo só quando detecta a MUDANÇA
    pra etapa de "ganho" (`STAGE_ID` terminando em `:WON`, resolvido
    dinamicamente por categoria via `crm.dealcategory.stage.list`, nunca
    hardcoded). **Sem retroatividade**: negócio nunca visto antes tem a
    etapa atual gravada como baseline sem disparar nada — só conta
    mudança observada a partir de agora.
- **Mensagem de sistema**: texto livre por instância, complementa (não
  substitui) uma persona padrão embutida — em branco, a IA usa só a
  persona padrão.
- **Base de conhecimento — 3 capacidades juntas**:
  1. **Texto livre**: colado direto na tela, sempre incluído no prompt
     inteiro (sem busca, sem limite de relevância).
  2. **Upload de documento** (PDF, DOCX, TXT ou Markdown): processado
     em segundo plano — extrai o texto, quebra em pedaços de ~2000
     caracteres (com sobreposição de 200), gera embedding de cada
     pedaço (`text-embedding-3-small`) e grava tudo num banco vetorial
     (pgvector). Lista de documentos mostra status (**Processando** →
     **Pronto**/**Erro**, nunca fica preso em "Processando" pra
     sempre) e botão de remover (apaga do banco E do arquivo original
     no Storage).
  3. **Busca semântica**: a cada mensagem do lead, os ~5 pedaços mais
     relevantes de TODOS os documentos da instância entram no prompt
     junto do texto livre — é isso que permite a IA responder com base
     no conteúdo real de um PDF/DOCX enviado, não só o que foi digitado
     na tela.
- **Modelo fixo**, sem campo de escolha: `gpt-4o-mini` pras respostas,
  `text-embedding-3-small` pros embeddings — mesmo par já usado no
  resto do sistema (Análise de Conversas, Insights).
- **Resiliência**: se a instância cai justo no momento em que o lead
  manda a mensagem, o pedido entra numa fila de retry
  (`agent_retry_queue`, até 3 tentativas) — assim que a instância
  reconecta, a resposta é **gerada de novo do zero** (usa o histórico
  real da conversa naquele momento, nunca reenvia um texto congelado
  que pode ter ficado desatualizado).
- **Aprendizado por exemplos de conversa (few-shot)**: ver §14.8 —
  conversas passadas boas, aprovadas manualmente e anonimizadas,
  entram no prompt como referência de estilo/conteúdo (mesmo
  mecanismo de busca semântica da base de conhecimento, aplicado a
  "exemplos" em vez de "documentos").
- **Reconhecimento real de mídia** (Parte EU, 2026-08-26): a mensagem-
  gatilho de um lead novo pode ser áudio (transcrito via Whisper),
  imagem ou vídeo (descritos via Vision, `gpt-4o-mini`) — a IA responde
  ao CONTEÚDO real, não a um placeholder genérico `[áudio]`/`[imagem]`/
  `[vídeo]`. Módulo `src/mediaRecognition.js`. **Escopo**: só a 1ª
  mensagem de um lead novo (mesmo ponto que já dispara a resposta
  automática) — mídia em conversa já em andamento continua com o
  placeholder de sempre. **Condicional ao mesmo toggle** "Agente ativo
  nesta instância" (nunca roda, e portanto nunca gasta API, em instância
  sem o agente ativado — decisão de custo confirmada com o usuário).
  Vídeo: descreve **1 frame único** (segundo 1, via ffmpeg), com
  prefixo `"[Descrição do início do vídeo] "` deixando explícito que é
  parcial. Imagem/vídeo **com legenda própria do lead** preservam o
  texto original (não substituem por descrição de IA). O texto
  reconhecido sobrescreve `messages.text` (sem coluna nova) — todo
  consumidor que já lê essa coluna (histórico da IA, resumo de
  conversa, Auditoria) se beneficia automaticamente; no Chat, áudio
  ganha uma legenda discreta (`.media-transcript`, itálico/menor,
  visualmente distinta da legenda comum) abaixo do player. **Importante**:
  transcrição de áudio depende do modelo `whisper-1` estar habilitado
  no projeto OpenAI associado a `OPENAI_API_KEY` (platform.openai.com →
  projeto → Model access) — sem isso, `transcribeAudio` lança erro e o
  fluxo segue best-effort com o placeholder de sempre (nunca quebra a
  resposta da IA).
- **Playground de teste**: painel próprio abaixo do wizard (visível em
  qualquer etapa, não preso à etapa 3) com conversa simulada REAL — a
  IA responde de verdade, usando a configuração **atual do formulário**
  (mesmo sem clicar "Salvar configuração") + documentos/exemplos já
  salvos no banco. Composer aceita texto e anexo de áudio/imagem/vídeo
  (até 20MB, mesmo limite do Chat) — usa o mesmo `mediaRecognition.js`
  de produção. Switch **Computador/Tablet** encolhe visualmente o
  frame (`max-width: 480px`), só CSS. **Totalmente isolado de produção**:
  histórico só em memória do navegador (nunca persistido), nunca cria
  negócio/tag/conversa no banco, nunca lê nem altera `agent_config` —
  rota dedicada `POST /api/agent/test-reply` (ver §16) recebe a config
  direto no body.

---

## 14.8. Exemplos de conversa — aprendizado few-shot do Agente de IA (`/agent-examples.html`)

Extensão do Agente de IA (§14.7): conversas passadas **boas** viram
referência de estilo/conteúdo pras respostas futuras — não é
fine-tuning (o modelo continua fixo, `gpt-4o-mini`), é busca semântica
de exemplos aprovados incluída no prompt a cada resposta, igual à
base de conhecimento de documentos. Tela própria, acessada só pelo
link "Exemplos de conversa (N pendentes) →" no topo de
`agente-ia.html` — sem item de sidebar próprio.

- **Nada entra automaticamente** — nenhum job varre conversas
  arquivadas nem usa qualquer sinal indireto (ex: "negócio avançou de
  estágio no Bitrix"). O único jeito de uma conversa virar candidata é
  o botão **"Marcar como exemplo"** no Chat (painel de detalhes, ao
  lado de "Resumo da conversa") — sempre uma decisão humana explícita.
- **Fila de revisão, 2 passos, nunca automática**:
  1. **Revisar**: dispara a anonimização (regex + IA) e mostra o
     resultado num textarea **editável** — o humano pode corrigir
     antes de confirmar.
  2. **Confirmar aprovação**: só então o exemplo é gravado (com
     embedding), disponível pra busca semântica. **Rejeitar** em
     qualquer momento antes da confirmação nunca anonimiza nem grava
     nada — a candidata só existe com o texto bruto até ali.
- **Anonimização — nunca "confia" na IA sozinha**: regex determinístico
  primeiro (CPF, CNPJ, telefone, e-mail, valor em R$) redige o que dá
  pra reconhecer por padrão fixo; a IA reescreve o resto (nome próprio,
  endereço, detalhe de caso) substituindo por placeholders (`[NOME]`,
  `[TELEFONE]`, `[VALOR]` etc.); e uma **reverificação determinística**
  roda de novo sobre a saída da IA — se qualquer padrão reconhecível
  ainda sobrar, a anonimização é reprovada (nada é gravado). A mesma
  checagem roda **outra vez** sobre o texto final que o humano
  confirma (mesmo que ele tenha editado manualmente) — última rede de
  segurança contra a própria edição reintroduzir algo sensível.
- **`agent_examples` nunca guarda dado bruto** — só o texto já
  anonimizado e confirmado por um humano. O transcript original (com
  PII de verdade) fica isolado em `agent_example_candidates`, nunca
  exposto pra busca semântica nem pro prompt do agente.
- **Escopo por instância**, mesmo padrão do resto do Agente de IA —
  exemplo aprovado numa instância nunca aparece pra outra.
- **Influência real na resposta**, não só inclusão inerte no prompt —
  a IA é instruída explicitamente a usar os exemplos como referência
  de estilo/estrutura, nunca a copiar um placeholder literal (`[NOME]`)
  na resposta de verdade ao lead.

---

## 14.9. Copiloto Comercial — insights de IA em tempo real (painel dentro de `/agente-ia.html` + Chat)

Feature distinta do Agente de IA (§14.7): ali a IA **atende** o lead
sozinha; aqui a IA só **sugere** pro atendente humano durante uma
conversa em andamento, no setor comercial (venda de precatórios). Só
instâncias marcadas **"comercial"** (toggle novo, painel `#commercialPanel`
em `agente-ia.html`, fora do wizard de 4 etapas — mesmo precedente do
Playground, §14.7) recebem insights; nasce sempre desligado. **Piloto
restrito** (Parte EY, 2026-08-27): mesma régua do §14.7 — só super
admin consegue de fato LIGAR (`PUT /commercial-config` com
`enabled:true` devolve `403` pra qualquer outro dono).

- **Gatilho**: a cada mensagem `in` recebida (`src/server.js::onMessage`),
  fire-and-forget, sem atrasar broadcast/timeline/notificação/Agente de
  IA que já rodaram antes. **Anti-flood de ~60s por conversa** — checado
  ANTES de chamar a OpenAI (barato): se a última geração foi há menos de
  60s, ou não há mensagem nova desde então, pula.
- **Contexto da IA**: transcript da conversa (`buildTranscript`, mesma
  função do Agente de IA) + **playbook** (texto livre por instância com
  as regras do negócio — margem mínima, documento aceito, etc) + dados
  do negócio no CRM (`crm.deal.get` — valor, etapa) + base de
  conhecimento do Agente de IA (busca semântica, se a instância tiver).
  Prompt instrui a IA a nunca tratar texto do CLIENTE como comando
  (mitigação de prompt injection) e a nunca vazar o playbook literal no
  texto do insight (que pode ser enviado de verdade ao próprio cliente).
- **Tópicos** — lista fixa mas editável por instância (default:
  "Passo a passo de documento", "Análise de contraproposta", "Objeção de
  preço", "Qualificação do lead", "Próximo passo"). A IA classifica cada
  insight num desses tópicos; se devolver um tópico fora da lista, o
  insight é descartado (log, não é forçado num tópico ao acaso).
- **UI, em dois lugares**: bolha `.bubble-insight` no feed do Chat (cor
  própria — azulada, deliberadamente distinta do dourado que já
  significa "nota interna humana" e do verde/vermelho que já significam
  positivo/negativo de métrica) e espelho agrupado por tópico no painel
  lateral de detalhes do contato.
- **Ações no insight**: copiar texto; **enviar direto ao cliente**
  (sempre com confirmação explícita — nunca automático, `POST
  /api/insights/:id/send`, idempotente contra reenvio); marcar
  útil/não-útil (feedback, registrado mas não altera o comportamento da
  IA ainda); dispensar (some do feed, mas fica no histórico via API);
  "virar follow-up" — botão presente mas desabilitado, aguardando a
  feature de Follow-ups (roadmap, não implementada).
- **Schema**: `commercial_config` (config por instância, mesmo padrão de
  `agent_config`), `conversation_insight_state` (anti-flood),
  `conversation_insights` (tabela própria — não reaproveita
  `internal_notes`, ciclos de vida diferentes).
- **Autorização**: todas as rotas de `/api/insights/*` exigem posse da
  instância (`requireSession`); `dismiss`/`feedback`/`send` também
  confirmam que o `:id` do insight pertence de fato à `session`+`phone`
  informados no body (`loadOwnedInsight`, helper compartilhado) — achado
  real de revisão de segurança, corrigido antes de fechar a feature.

---

## 15. Central de Notificações — Kanban e Calendário (`/notifications.html`)

O sino da sidebar (compartilhado pelas 8 páginas) deixou de abrir um dropdown
rápido — agora é um link de navegação normal (como as outras abas do menu) pra
esta página, que mostra um **histórico de verdade** das notificações, persistido
no banco (tabela `notifications`), não mais só um array na memória do navegador
que sumia ao recarregar a página.

- **De onde nasce uma notificação**: toda vez que chega uma mensagem recebida
  (não eco do que o próprio usuário mandou) numa conversa que não está
  silenciada, o servidor mesmo cria a notificação — `src/server.js`, dentro do
  callback `onMessage` do `SessionManager`, no mesmo ponto que já salva a
  mensagem (`store.addMessage`) e faz o broadcast por WebSocket. Isso acontece
  **sempre**, não só quando alguém está com o Chat aberto no navegador — é
  diferente do toast/notificação nativa do SO, que continuam sendo só um aviso
  imediato em tela (ver §9), sem relação com o que fica salvo aqui.
- Escopo por **dono do Bitrix** (`owner_id`), não por instância — um usuário com
  várias instâncias de WhatsApp vê tudo junto numa lista só, igual ao que já
  acontece em `GET /instances?owner=`.
- **Kanban**: duas colunas — "Não lidas" e "Lidas". Cada card mostra o nome do
  contato, um trecho da mensagem, quando chegou, e dois botões: "Abrir
  conversa" (navega pra `/chat.html?session=&phone=` — ver deep link em §9) e
  "Marcar como lida/não lida" (ação explícita, sem drag-and-drop nem
  auto-marcar-lido ao clicar — pra não ser surpreendente).
- **Calendário**: mesmo padrão de grid mensal já usado na Agenda de Envios
  (§13) — até 3 chips por dia (dourado = não lida, apagado = lida) + "+N mais";
  clicar num dia abre a agenda completa daquele dia abaixo do grid, com os
  mesmos cards e ações do Kanban.
- **"Marcar todas como lidas"** e **"Ativar notificações do sistema"** (pedido
  de permissão nativa do navegador, `Notification.requestPermission()`) ficam
  no topo da página — o botão de permissão nativa morava dentro do dropdown
  antigo, mudou de lugar pra cá.
- **Badge do sino**: número de não lidas, buscado uma vez por página
  (`GET /notifications/unread-count`) logo depois do login em todas as
  páginas. Só o Chat atualiza esse número **ao vivo** (soma +1 sozinho quando
  chega mensagem nova pelo WebSocket que já tem aberto) — as outras páginas
  mostram a contagem de quando a página carregou, sem atualização em tempo
  real (limitação aceitável; ver §20).
- **Toast em tempo real** (HANDOFF Parte DG): além do badge estático acima,
  as **14 páginas** que rodam o heartbeat de presença (`startPresenceHeartbeat`,
  a cada 30s) também chamam `checkNewNotifications()` no mesmo ciclo —
  reaproveita o heartbeat existente, sem WebSocket dedicado. Compara **ID**
  (não timestamp) contra um `Set` guardado em `sessionStorage` pra decidir o
  que é "novo"; se algo novo chegou, mostra `showToast(title, 'info', target)`
  — clicável, navega pra conversa (`target`) se houver uma. Usa
  `GET /notifications/latest-unread` (abaixo), não a lista completa.
- Sem exclusão permanente — "marcar como lida" cobre o caso de uso de "limpar",
  mesma filosofia de arquivar conversa (esconder, não apagar).

---

## 15.5. Sugestões (`/suggestions.html`) e FAQ pública (`/faq.html`)

Qualquer usuário autenticado manda uma sugestão de melhoria (`POST
/api/suggestions`, até 2.000 caracteres) e acompanha o próprio status —
badge com 3 estados: **Pendente** → **Em análise** → **Lançada**. Listar
(`GET /`) e enviar (`POST /`) são visão de **time**, igual Análise de
Conversas (todo mundo vê todas as sugestões de todo mundo, sem
`owner_id` na leitura), sem `requireSuperAdmin` — só a **triagem** é
restrita.

- **Triagem (Kanban)**: vive dentro do Admin (§14.5, seção "Sugestões"),
  não em `/suggestions.html` — 3 colunas (Pendente/Em análise/Lançado),
  restrita a `requireSuperAdmin`. Mover pra "Em análise"
  (`POST /:id/move-to-review`) notifica automaticamente quem sugeriu
  (Central de Notificações, §15); marcar como lançada
  (`POST /:id/release`) idem. Responder (`POST /:id/respond`, até 2.000
  caracteres) não notifica ninguém sozinho — a resposta só aparece
  publicada na FAQ (abaixo). Resposta e "lançada" são independentes: dá
  pra responder ("não vamos fazer isso porque...") sem nunca marcar como
  lançada.
- **WhatsApp automático ao lançar** (HANDOFF Parte DG): `POST /:id/release`
  também tenta mandar uma mensagem de WhatsApp de verdade pro celular de
  quem sugeriu (cadastro do Bitrix, `PERSONAL_MOBILE` via `user.get`),
  além da notificação dentro do app acima — reaproveita o mesmo mecanismo
  de envio do botão "Enviar mensagem" do Admin (§14.5), usando uma
  instância do **próprio admin que lançou** (quem sugere não tem
  instância própria). Best-effort: sem celular cadastrado, ou sem
  instância do releaser online agora, desiste em silêncio (nunca força
  reconectar) — a notificação dentro do app já aconteceu de qualquer
  forma.
- **FAQ pública** (`/faq.html`, `GET /api/suggestions/faq`): lista em
  acordeão só as sugestões que já têm resposta, mais antigas primeiro,
  visível a **qualquer** usuário autenticado (não só admin) — mas
  **sem o `owner_id`** de quem perguntou, de propósito (não expor quem
  perguntou o quê numa tela pública pro time inteiro).

---

## 15.6. Auditoria de Conversas — painel restrito (`/conversation-analysis.html`)

Tela **totalmente separada** do dashboard "Análise de Conversas"
(§8) — aquele é agregado só das PRÓPRIAS instâncias de quem está
logado; esta lê o **conteúdo real** de mensagens de **qualquer
instância/owner do sistema**, por isso o acesso é restrito e
concedido nominalmente (ver HANDOFF Parte DK).

- **Controle de acesso**: super admin (`SUPER_ADMIN_OWNER_IDS`)
  sempre tem acesso; qualquer outro owner precisa de um grant
  explícito, concedido pelo super admin na tabela de Usuários do
  Admin (§14.5) — botão "Auditoria: Conceder"/"Ativo" por linha, com
  `confirmDialog` deixando o alcance claro. Verificado a cada request
  (`requireConversationAnalysisAccess`, `src/adminAuth.js`), sem
  cache — revogação corta acesso na próxima chamada.
- **O que a tela mostra**: filtros (termo de busca no CONTEÚDO da
  mensagem, instância, atendente — por mensagem individual que essa
  pessoa escreveu, não por quem é o responsável atual da conversa —,
  período, com botão "Limpar filtros" ao lado de "Aplicar filtros",
  HANDOFF Parte DY — zera os 5 campos + a query string da URL, pra um
  F5 depois de limpar não reaplicar um `?sentBy=` antigo vindo do link
  "Ver conversas" do Admin), métricas agregadas do filtro atual, lista
  de conversas paginada no servidor (o universo é o sistema todo, não
  as instâncias de 1 dono), e o histórico completo de uma conversa em
  bolhas **somente leitura** ao clicar numa linha. O cabeçalho desse
  modal de histórico mostra também o tempo de diálogo (primeira →
  última mensagem) e a contagem de mensagens enviadas/recebidas
  (HANDOFF Parte DW) — tudo calculado no frontend a partir do mesmo
  payload de histórico, sem rota nova.
- **Dropdown "Instância" inclui também instâncias "órfãs"** (HANDOFF
  Parte ED, `instancesStore.listAll()`) — `session_id`s já removidos
  da tabela `instances` mas com mensagem real preservada
  (`instances.remove()` nunca apaga `conversations`/`messages` de
  propósito, pra não perder histórico de atendimento só por
  desconectar/remover uma instância); marcadas `isOrphan: true`,
  `ownerId: null` (nunca um dono adivinhado por heurística sobre o
  formato do `session_id` — não há hoje nenhuma fonte que preserve o
  dono/label reais depois da remoção), com texto próprio no dropdown
  (pra não repetir label duas vezes) e de fora do filtro de Atendente
  (sem dono real, as 27 cairiam todas na mesma opção, misturando
  instâncias diferentes). O card "Instâncias" da tela já contava essas
  certo antes desta correção (agrega por `messages.session_id`, não
  pela tabela `instances`) — só o dropdown de filtro tinha a lacuna.
- **Mídia no histórico usa hidratação autenticada** (`data-media-url`
  + `apiFetch` + blob, mesmo mecanismo de `chat.html` — ver §9), não
  `src=` direto: como as rotas de mídia exigem `Authorization: Bearer`,
  um `src` puro nunca conseguiria enviar esse header, e a mídia
  falhava silenciosamente (bug real corrigido na Parte DW do HANDOFF —
  não confundir com a robustez adicionada em `chat.html` na mesma
  parte, que é uma causa diferente e não totalmente confirmada).
- **Insight de IA sobre o conjunto filtrado**: amostra até 60
  conversas/400 mensagens (teto fixo, evita prompt gigante com um
  filtro amplo) — a resposta sempre mostra "baseado em N de T
  conversas", nunca dando a entender que cobriu o filtro inteiro.
- **Auditoria própria**: toda vez que uma conversa é aberta, uma
  busca é feita, ou um insight é gerado aqui, uma linha é registrada
  em `conversation_analysis_audit` — **nunca** com texto de mensagem
  ou do insight, só o recurso acessado (ex: `{sessionId, phone}`) —
  diferente do histórico de ações do Admin (§14.5), que é sobre o
  próprio uso do app, não sobre acesso a dado de terceiro.
- Um aviso fixo (não um modal que se esquece) fica sempre visível no
  topo da tela, lembrando do alcance e de que o acesso é registrado.

---

## 15.7. "Criar grupo" no card do negócio + Nota interna (aba DapZap, `public/index.html`)

Dentro da aba DapZap (placement `CRM_DEAL_DETAIL_TAB`, mesma tela que
já mostra a conversa 1-a-1 com o cliente), um botão "Criar grupo" monta
um grupo de WhatsApp real reunindo automaticamente: o Responsável
principal do negócio (`ASSIGNED_BY_ID` — só o principal, 2º
Responsável/Supervisor do Responsável ficam de fora), a pessoa do
campo customizado "[AUT] Resp. Ver. Contratos", quem está logado
clicando no botão, e o cliente (telefone já resolvido pela própria
tela). HANDOFF Parte DX tem o histórico completo da implementação.

- **Diferente de `POST /groups`** (`src/routes/whatsapp.js`, tela
  Contatos/Chat, "grupo em comum") — grupos criados aqui são marcados
  `wa_groups.source = 'card'` (com `deal_id`), o que os torna os
  ÚNICOS grupos cujas mensagens recebidas são processadas e salvas
  (ver bypass condicional em `src/whatsapp.js`, item abaixo). Qualquer
  outro grupo continua com mensagem recebida descartada por completo,
  decisão deliberada anterior (ver HANDOFF Parte DX pro histórico
  completo dessa decisão).
- **Switch "Cliente"/"Grupo"** no cabeçalho, visível só depois do
  grupo criado — as duas conversas convivem, nenhuma substitui a
  outra. Bolha recebida no modo Grupo mostra o nome de quem mandou
  (grupo tem N remetentes possíveis; DM sempre teve só 1) via
  `messages.group_sender_phone`/`group_sender_name`, novos.
- **Nota interna** (`/api/internal-notes`, tabela `internal_notes`) —
  mensagens visíveis só pros internos (Responsável, Verificação,
  atendente), nunca pro cliente, mesmo estando todos no mesmo grupo.
  Serve conversa 1-a-1 e grupo-com-cliente igualmente. É a MESMA
  infraestrutura pedida antes na Parte DW do HANDOFF (insight de IA em
  tempo real + nota do gerente pro atendente) — tratada como uma peça
  só, não duas. Nunca lida por `GET /history`/`POST /send`.
- **Resolução do Bitrix** (`src/bitrixDealFields.js`) — o nome técnico
  (`UF_CRM_*`) do campo "[AUT] Resp. Ver. Contratos" é descoberto via
  `crm.deal.fields` em tempo de execução (cacheado em memória, 24h),
  não fixado no código. **Ainda não validado contra o portal real**
  (webhook local com credencial inválida no momento da implementação —
  ver HANDOFF Parte DX) — código degrada graciosamente (erro tratado,
  nunca crash) até isso ser corrigido e confirmado.

---

## 16. Rotas / API

Salvo indicação contrária, toda rota abaixo espera um identificador de **instância**
(`session`) ou de **dono** (`owner`) — cada usuário só enxerga/opera as próprias
instâncias. `GET /metrics` (Análise de Conversas) agrega as instâncias do **próprio
dono autenticado** (`req.ownerId`, resolvido via `instancesStore.listByOwner` — ver
§8 e §17.x, `src/metrics.js`) — até 2026-07-09 essa rota agregava de TODOS os donos
por engano (bug de isolamento, corrigido; ver HANDOFF Parte AR), nunca foi
intencional agregar entre donos diferentes.

### Autenticação

Todas as rotas de `/api/whatsapp/*` e `/api/*` (exceto o próprio login) exigem
`Authorization: Bearer <token>`; o WebSocket exige o mesmo token como query param
`token=` (browser não manda headers customizados no handshake). Ver `src/auth.js`
e `src/authz.js` para a implementação completa.

| Rota | Método | Uso |
|---|---|---|
| `/api/auth/verify` | POST | Body `{ accessToken }` (o `access_token` de `BX24.getAuth()`). Verifica contra o Bitrix de verdade (domínio fixo do servidor, `BITRIX_PORTAL_DOMAIN`) e devolve `{ ownerId, token, expiresIn }` — o `token` é o que vai em todo `Authorization: Bearer` daqui pra frente. |
| `/api/brand` | GET | Pública, sem autenticação (só config de exibição). Devolve `{name, subtitle, color, instagramUrl, linkedinUrl, address}` a partir de `BRAND_NAME`/`BRAND_SUBTITLE`/`BRAND_COLOR`/`BRAND_INSTAGRAM_URL`/`BRAND_LINKEDIN_URL`/`BRAND_ADDRESS` no `.env` (`null` em cada campo não definido). As 8 páginas com sidebar usam só `name`/`subtitle`/`color`; `lead-form.html` usa todos os 6 campos (os 3 últimos alimentam a coluna "Siga-nos" e o mapa do rodapé, ver §11.5) — sem nenhuma variável definida, nada muda (é o caso da Durão hoje). |
| `/api-docs` | GET | Pública, sem autenticação (documentação interativa da API — Swagger UI, a partir de `src/openapi.js`). Nenhum dado real é servido aqui, só a descrição das rotas; as chamadas de verdade continuam exigindo o token de sempre. |

Por trás dos panos: `requireAuth` (middleware nos routers) só confirma que o
`token` é de um usuário Bitrix real deste portal — cada rota individual ainda
confere, via `requireSession`/`requireResourceSession`/`requireOwnerMatch`
(`src/authz.js`), que a `session`/`owner` recebida pertence de fato a esse
usuário (403 se não pertencer, 404 em rotas por `:id` de recurso, pra não
revelar que o recurso existe).

### Páginas (Express, estático + handlers POST)

| Rota | Método | Uso |
|---|---|---|
| `/` | GET/POST | Handler principal do app Bitrix. Serve `public/index.html` (a aba do chat dentro do card do Negócio). |
| `/install` | GET/POST | Página de instalação (registra o placement + `installFinish`). |
| `/dashboard.html` | GET/POST | Análise de Conversas. |
| `/chat.html` | GET/POST | Chat — inbox (todas as conversas, ver §9). |
| `/campaign.html` | GET/POST | Campanha (disparo em massa). |
| `/contacts.html` | GET/POST | Contatos e listas. |
| `/campaign-metrics.html` | GET/POST | Métricas de Campanhas. |
| `/campaign-schedule.html` | GET/POST | Agenda de Envios (Kanban/Calendário). |
| `/instances.html` | GET/POST | Gestão de instâncias. |
| `/notifications.html` | GET/POST | Central de Notificações (Kanban/Calendário, ver §15). |
| `/admin.html` | GET/POST | Painel Admin — restrito a `SUPER_ADMIN_OWNER_IDS` (ver §14.5). O arquivo é servido igual a qualquer outro estático; a restrição real está nas rotas `/api/whatsapp/admin/*` abaixo. |
| `/suggestions.html` | GET/POST | Sugestões — enviar e acompanhar status (ver §15.5). |
| `/faq.html` | GET/POST | FAQ pública — perguntas já respondidas (ver §15.5). |
| `/conversation-analysis.html` | GET/POST | Auditoria de Conversas — acesso restrito (ver §15.6). |
| `/agente-ia.html` | GET/POST | Agente de IA — configuração por instância (ver §14.7). |
| `/agent-examples.html` | GET/POST | Exemplos de conversa — fila de aprovação few-shot (ver §14.8). |
| `/api/whatsapp/page-session/close` | POST | Fora do middleware `requireAuth` de propósito (ver tabela `/api/whatsapp/*` abaixo) — montada aqui, direto em `src/server.js`, ANTES do `app.use('/api/whatsapp', requireAuth, ...)`. |
| `/*` (estático) | GET | Arquivos de `public/`. |

### `/api/whatsapp/*`

| Rota | Método | Uso |
|---|---|---|
| `metrics?origin=` | GET | Métricas agregadas das instâncias do dono autenticado (`req.ownerId`) — ver §8. |
| `insights?refresh=` | GET | `{ insights:[{title,text,tone}], generatedAt, cached }` — cards de "Insights de IA" do Dashboard (§8), cacheados 30min por dono; `?refresh=1` força recalcular. |
| `team-metrics?session=` | GET | Desempenho por atendente de UMA instância (400 se `session` tiver mais de um id) — ver §9 "Painel de atendimento". `isManager` decidido no servidor, nunca vindo do client. |
| `team-insights?session=&refresh=` | GET | Mesmo formato de `insights`, só que pro Painel de atendimento — cacheado 30min por `owner::session`. |
| `sessions?session=` | GET | Status de uma instância (ou de todas, sem o parâmetro — uso interno). |
| `instances?owner=` | GET | Lista as instâncias do dono (cria a "Principal" automaticamente se não existir nenhuma). Cada item inclui `status`/`phone` + `contactCount`/`groupCount` + `needsAttention`/`lastDisconnectReason` + `openConnectionEvent` (Alerta de instância caída, §14) + `ownerName` (nome do dono pelo ID do Bitrix, só resolvido/exibido pra instância DELEGADA — Parte EQ) — resposta também traz `limit`. |
| `instances` | POST | Body `{ owner, label }`. Cria uma instância nova e já inicia o pareamento (QR). 400 se o dono já tiver atingido `MAX_INSTANCES_PER_OWNER` (3, ver §14). |
| `instances/:id` | PUT | Body `{ owner, label }`. Renomeia. |
| `instances/:id?owner=` | DELETE | Desconecta e remove a instância. |
| `instances/:id/reconnect?owner=` | POST | Botão "Tentar reconectar" (§14) — só faz efeito se a instância estiver marcada `needsAttention`; tenta reconectar com as credenciais já salvas, sem apagar nada. 404 se a instância não existe ou não está ativa no processo. |
| `instances/:id/health?owner=` | GET | Alerta de instância caída (§14). `{ openEvent, events, metrics }` — histórico de quedas + série diária de métricas. Rota de LEITURA — diferente de `reconnect`/`delete`/`put` acima (só dono), esta aceita também DELEGADO (`instance_delegates`). 404 pra quem não é dono nem delegado. |
| `qr?session=` | GET | Cria/inicia a instância e devolve `{ qr, status }`. |
| `status?session=` | GET | `{ status }` — `'connecting' \| 'online' \| 'offline'`. |
| `history?session=&dealId=&phone=` | GET | Histórico de mensagens + `connectionStatus` + `aiSummary`/`aiSummaryUpdatedAt` (resumo salvo, se já foi gerado). Também salva o vínculo telefone → negócio. |
| `avatar?session=&phone=` | GET | `{ url }` — foto de perfil do contato/grupo (cache em `conversations.avatar_url`; busca no WhatsApp só se ainda não tiver nada salvo) — ver §9. |
| `conversations?session=&search=&archived=` | GET | Lista as conversas (tela Chat) — nome, prévia da última mensagem, tags. `archived` (`true`/`false`, padrão `false`) filtra arquivadas vs ativas — ver §9. |
| `conversations/archive` | POST | Body `{ session, phone, archived }`. Arquiva/desarquiva uma conversa — só organiza a lista, não afeta envio/recebimento. |
| `conversations/notifications` | POST | Body `{ session, phone, enabled }`. Silencia/dessilencia notificações de uma conversa — notifica por padrão (§9). |
| `conversations/summary` | POST | Body `{ session, phone, contactName? }`. Gera (OpenAI) e persiste o resumo estruturado da conversa (até as últimas 80 mensagens), devolve `{title, subtitle, summary, updatedAt}` — ver §9. |
| `conversations/summary-history?session=&phone=` | GET | Devolve `{history: [{title,subtitle,summary,createdAt}, ...]}`, mais recente primeiro — toda versão de resumo já gerada pra essa conversa, não só a atual (§9, HANDOFF Parte DY). |
| `conversations/export-pdf?session=&phone=` | GET | Devolve o arquivo PDF pronto (`Content-Disposition: attachment`) da conversa inteira (mensagens + notas internas), gerado com `pdfkit` — nota interna sempre rotulada `[NOTA INTERNA — não enviada ao cliente]`, em dourado/itálico (§9, HANDOFF Parte EA). |
| `groups?session=` | GET | Lista os grupos do WhatsApp já criados pela(s) instância(s) (aceita várias separadas por vírgula). |
| `groups` | POST | Body `{ session, name, phones:[...] }`. Cria um grupo de verdade no WhatsApp (`sock.groupCreate`) — usado em `contacts.html` e no botão "Novo grupo" do Chat (§9). |
| `contacts/groups?session=&phone=` | GET | Lista os grupos da instância dos quais esse telefone é participante (`{ groups: [{id, name}] }`) — usado em "grupos em comum" no painel de contato do Chat (§9). Uma chamada ao WhatsApp por grupo da instância; best-effort com participantes `@lid` sem telefone resolvido. |
| `notifications?owner=` | GET | Lista o histórico de notificações do dono, mais recentes primeiro, limit 500 — usado pela Central de Notificações (§15). |
| `notifications/unread-count?owner=` | GET | `{ count }` — usado pelo badge do sino nas páginas. |
| `notifications/latest-unread?owner=` | GET | `{ notifications: [{id,title,body,target,createdAt}] }` — só as 5 mais recentes NÃO lidas, usado pelo toast em tempo real (`checkNewNotifications`, ver §15, HANDOFF Parte DG). Deliberadamente pequeno, não é o histórico completo. |
| `notifications/push-public-key` | GET | `{ publicKey }` — chave pública VAPID (`.env`, `VAPID_PUBLIC_KEY`), pro frontend montar `PushManager.subscribe({applicationServerKey:...})`. `null` se não configurada. |
| `notifications/push-subscribe` | POST | Body `{ subscription: {endpoint, keys:{p256dh, auth}} }` — salva a inscrição de Web Push (`push_subscriptions`, ver §14, Parte FC). `owner_id` é sempre `req.ownerId` do token, nunca do body. |
| `notifications/push-unsubscribe` | POST | Body `{ endpoint }`. Remove a inscrição. |
| `notifications/read-all` | POST | Body `{ owner }`. Marca todas as notificações do dono como lidas. |
| `notifications/:id/read` | POST | Body `{ read }`. Marca uma notificação como lida/não lida — posse conferida pelo próprio registro no banco (`requireResourceOwner`), não por um `owner` que o client mande. |
| `media/:filename` | GET | Redireciona (302) pra uma signed URL de curta duração do bucket privado `media` (§7). Qualquer usuário autenticado deste portal pode pedir qualquer arquivo — não é restrito por dono da conversa. |
| `send` | POST | Body `{ session, dealId, phone, text, replyToId? }`. Envia texto via WhatsApp; `replyToId` (opcional) cita outra mensagem da conversa. |
| `send-media` | POST | Body `{ session, dealId, phone, type, mimetype, dataBase64, caption, replyToId? }`. `type` é `image`/`audio`/`video`. |
| `presence` | POST | Body `{ session, phone, state }`. `state` é `composing`/`recording`/`paused` — avisa o contato que a empresa está digitando/gravando áudio (ver §9). |
| `link-preview?url=` | GET | `{ url, title, description, image, siteName }` (Open Graph da página, campos `null` se não achar nada) — usado pra pré-visualizar link nas mensagens (ver §9 e `src/linkPreview.js`). Sem `session`/`requireSession`, só `requireAuth`. |
| `react` | POST | Body `{ session, phone, messageId, emoji }`. Reage a uma mensagem (`emoji` vazio remove a reação) — ver §9. |
| `campaign/classify-recipients` | POST | Body `{ session, phones:[...] }`. `{ results:[{phone, hasReplied}] }` — usado antes de disparar pra avisar risco de erro 463 (ver §10). Telefone sem nenhuma conversa não aparece no resultado (frontend trata ausência como `hasReplied:false`). |
| `campaign` | POST | Body `{ session, name?, recipients:[{phone,name?}], text, media?, minDelayMs?, maxDelayMs? }`. Dispara uma campanha imediatamente. `minDelayMs`/`maxDelayMs` (ms, opcionais) sobrescrevem o intervalo padrão de 4-9s — validados entre 1s e 120s, min ≤ max. |
| `campaign/:id` | GET | Progresso "ao vivo" de uma campanha em andamento/concluída. |
| `campaign/schedule` | POST | Mesmo body de `campaign`, + `scheduledAt` (ISO, no futuro). Agenda em vez de disparar na hora. |
| `campaigns/metrics?session=` | GET | Métricas de campanhas — aceita uma instância ou várias separadas por vírgula (`session=a,b`). |
| `scheduled-campaigns?session=` | GET | Lista os agendamentos (idem, aceita várias instâncias separadas por vírgula). |
| `scheduled-campaigns/:id/send-now` | POST | Dispara um agendamento imediatamente, ignorando a data marcada. |
| `scheduled-campaigns/:id` | PUT | Body `{ scheduledAt }`. Reagenda. |
| `scheduled-campaigns/:id` | DELETE | Cancela (só enquanto ainda estiver `scheduled`). |
| `presence/heartbeat` | POST | Body `{ page?, ownerName? }`. Sinal de "app aberto agora" pro Painel Admin (§14.5) — QUALQUER usuário autenticado pode chamar, não só admin. `page` é `window.location.pathname`; `ownerName` é texto solto resolvido no frontend (`BX24 user.current`), nunca tratado como identidade. |
| `page-session/open` | POST | Body `{ page, ownerName? }`. Abre uma visita rastreada (§14.5) — devolve `{ sessionId }`. QUALQUER usuário autenticado. |
| `page-session/ping` | POST | Body `{ sessionId }`. Mantém a visita viva (`last_ping_at`) — chamado no mesmo ciclo de 30s do heartbeat. |
| `page-session/close` | POST | Body `{ sessionId, token }`. **Fora de `requireAuth`** — montada em `src/server.js` antes do `app.use('/api/whatsapp', requireAuth, ...)` de propósito, porque `navigator.sendBeacon` (quem chama essa rota, no `pagehide` de cada página) não permite header `Authorization`; o `token` vai no body e é verificado direto com `verifyAppToken`. |
| `admin/whoami` | GET | `{ isSuperAdmin }` — sem expor a lista de admins. Usado pra revelar/esconder o item "Admin" da sidebar. |
| `admin/users` | GET | Restrito a `SUPER_ADMIN_OWNER_IDS`. Lista TODO o cadastro do Bitrix (`listEmployees`, mesmo sem nunca ter aberto o app) cruzado com presença/último acesso/tempo total 30d/página favorita/bloqueio — tabela principal do Admin (§14.5). |
| `admin/instances` | GET | Restrito a `SUPER_ADMIN_OWNER_IDS`. TODAS as instâncias do sistema (`instancesStore.listAll()`, inclusive órfãs) cruzado com `listEmployees` (nome do dono) e `getOwnNumbersBySession` (número real) — gestão cross-usuário, seção "Instâncias" do Admin (§14.5, Parte EQ). `hrConfigured:false` (200) se `BITRIX_HR_WEBHOOK_URL` não estiver configurada — `ownerName` fica `null` pra todo mundo, lista de instâncias continua completa. |
| `admin/users/:ownerId` | GET | Restrito a `SUPER_ADMIN_OWNER_IDS`. Histórico completo de `page_sessions` de uma pessoa, mais recente primeiro — botão "Detalhado". |
| `admin/usage-metrics?days=` | GET | Restrito a `SUPER_ADMIN_OWNER_IDS`. Agregados globais (online agora, usuários ativos, tempo total do time, página mais acessada) + os 2 gráficos de barra — `days` padrão 30. |
| `admin/users/:ownerId/block` | POST | Restrito a `SUPER_ADMIN_OWNER_IDS`. Body `{ reason? }`. Bloqueia o `ownerId` de usar o app inteiro (§14.5) — 400 se `ownerId === req.ownerId` (não dá pra se autobloquear). |
| `admin/users/:ownerId/unblock` | POST | Restrito a `SUPER_ADMIN_OWNER_IDS`. Remove o bloqueio. |
| `admin/presence` | GET | Restrito a `SUPER_ADMIN_OWNER_IDS` (403 pra qualquer outro `ownerId`). `{ presence:[{ownerId, ownerName, lastPage, lastSeenAt}] }` — quem já mandou heartbeat alguma vez. |
| `admin/employees` | GET | Restrito a `SUPER_ADMIN_OWNER_IDS`. `{ employees:[{id, name, workPosition, email, photo, departmentIds, dateRegister}], hrConfigured }` — cadastro do Bitrix via `BITRIX_HR_WEBHOOK_URL` (mesma variável do §14); `hrConfigured:false` (200, não erro) se a variável não estiver configurada. |
| `admin/diagnostics/sessions` | GET | Restrito a `SUPER_ADMIN_OWNER_IDS`. Só leitura. `{ sessions:[{sessionId, status, hasSock}] }` — sessões WhatsApp já em memória no processo (`SessionManager.listActive()`), SEM criar nenhuma sessão nova (diferente de acessar via `session=` em qualquer outra rota, que cria+inicia se ainda não existir). Usada pra saber quais instâncias têm um socket Baileys de verdade conectado agora — pré-requisito de `resolve-lid` abaixo. Ferramenta de diagnóstico permanente (HANDOFF Parte CP), não removida depois de usada. |
| `admin/diagnostics/resolve-lid` | POST | Restrito a `SUPER_ADMIN_OWNER_IDS`. Só leitura (não altera nenhuma linha do banco, não envia nada pro WhatsApp). Body `{ sessionId, lidNumbers:[...] }` (máx. 500). Tenta resolver cada número do sistema LID do WhatsApp pro telefone real, via o socket JÁ CONECTADO daquela sessão (`signalRepository.lidMapping`) — `null` no resultado se não conseguir. 400 se a sessão não estiver `online` agora. Usada pra medir/corrigir conversas antigas salvas com o LID cru no lugar do telefone — ver `scripts/fix-lid-phones.js`/`fix-lid-contacts.js` e HANDOFF Parte CP. |
| `admin/feed-post` | POST | Restrito a `requireSuperAdmin`. Body `{ title?, content }` — o nome é `content`, não `message` (ver §14.5, o bloqueio real descoberto em produção). Publica no Feed nativo do Bitrix (`src/bitrixFeed.js`) e registra em `feed_posts` (sucesso ou falha). 400 sem `content`; 502 se a publicação em si falhar (webhook não configurado, erro da API do Bitrix). |
| `admin/feed-posts` | GET | Restrito a `requireSuperAdmin`. `{ posts:[{id, ownerId, title, message, bitrixPostId, status, error, createdAt}] }` — histórico LOCAL, últimos 100, mais recente primeiro. |

### `/api/agent/*` (`src/routes/agent.js`)

Ver §14.7. Toda rota exige `session` (query em GET/DELETE, body em
POST/PUT) — `requireSession` confere que a instância pertence ao
`ownerId` autenticado.

| Rota | Método | Uso |
|---|---|---|
| `config?session=` | GET | `{ sessionId, active, systemMessage, knowledgeText, updatedAt }` — config atual do agente daquela instância. Instância sem linha em `agent_config` devolve `active:false` e os demais campos `null` (nunca 404). |
| `config` | PUT | Body `{ session, active?, systemMessage?, knowledgeText? }`. Upsert dinâmico — só os campos presentes no body são alterados (mesmo padrão de `PUT /api/settings`); `active:false` explícito é tratado como valor real, não como "campo ausente". Nasce `active:false` na 1ª vez que a instância recebe qualquer config. **403** se `active:true` e o `ownerId` não estiver em `SUPER_ADMIN_OWNER_IDS` (piloto restrito, Parte EY — `active:false` e demais campos continuam liberados pra qualquer dono). |
| `knowledge/upload` | POST | Body `{ session, fileName, fileType, dataBase64 }` (`fileType` é `pdf`/`docx`/`txt`/`md`; `dataBase64` sem o prefixo `data:...;base64,`, mesmo padrão de `/send-media`). Processa em segundo plano (extrai texto → chunка → embeddings → grava) e devolve `{ docId, status, chunkCount }` já com o resultado — não é assíncrono do ponto de vista do client, a resposta só volta depois de pronto (ou com `status:'error'`). |
| `knowledge?session=` | GET | `{ docs:[{id, fileName, fileType, status, errorMessage, createdAt}] }` — mais recente primeiro. |
| `knowledge/:docId?session=` | DELETE | Remove o documento (chunks em cascata) e o arquivo original do Storage. 404 se o documento não existir ou não for dessa instância. |
| `conversations/toggle` | POST | Body `{ session, phone, enabled }`. Liga/desliga o agente numa conversa específica — usado pelo botão "Desativar IA nesta conversa" do Chat (§9) e pela auto-desativação quando um humano responde manualmente. |
| `conversations/status?session=&phone=` | GET | `{ enabled }` — `null` se a conversa nunca teve o agente envolvido (cliente antigo, nunca foi lead novo com agente ativo). |
| `test-reply` | POST | Body `{ session, systemMessage?, knowledgeText?, history?, leadMessage?, mediaBase64?, mediaType?, mimetype? }` (`leadMessage` ou `mediaBase64` obrigatório; `mediaType` um de `audio`/`image`/`video`). Playground de teste (§14.7) — gera resposta REAL usando a config **do body**, nunca lida de `agent_config` (reflete o formulário mesmo sem "Salvar"). Devolve `{ reply, recognizedText }` (`recognizedText` só quando havia mídia). **Isolado de produção**: nunca chama `store.addMessage`/`agentDispatch`/`agentConfigStore.get` — só lê via busca semântica (`searchRelevantChunks`/`searchRelevantExamples`, read-only). |
| `examples/candidates` | POST | Body `{ session, phone, contactName?, transcriptRaw, markedByName? }`. Cria uma candidata a exemplo few-shot (§14.8) — usado pelo botão "Marcar como exemplo" do Chat. `markedBy` é sempre `req.ownerId` (nunca do body). |
| `examples/candidates?session=&status=` | GET | `{ candidates:[...] }` — lista candidatas, `status` opcional filtra (`pending_review`/`approved`/`rejected`/`anonymization_failed`). |
| `examples/candidates/:id/review` | POST | Body `{ session }`. Passo 1 de aprovação: roda a anonimização (regex+IA+reverificação), devolve `{ status:'ready_for_review', draft }` ou `{ status:'anonymization_failed', error }` — nunca cria exemplo definitivo aqui. |
| `examples/candidates/:id/confirm` | POST | Body `{ session, finalText, approvedByName? }`. Passo 2: reverifica `finalText` (editado ou não) antes de gravar — 400 se ainda houver dado sensível reconhecível. Sucesso grava embedding + linha em `agent_examples`. |
| `examples/candidates/:id/reject` | POST | Body `{ session, reviewedByName? }`. Rejeita sem nunca anonimizar nem gravar nada. |
| `examples?session=` | GET | `{ examples:[{id, anonymizedText, approvedBy, approvedByName, createdAt}] }` — exemplos já aprovados daquela instância. |
| `examples/:id?session=` | DELETE | Remove um exemplo aprovado. 404 se não existir/não for dessa instância. |

### `/api/*` (Contatos, listas, modelos — `src/routes/crm.js`)

Contatos e listas são escopados por `req.ownerId` direto (do token, sem precisar de
`session` na chamada) — igual em qualquer instância do dono, ver §11. Modelos de
mensagem continuam por instância (`session` obrigatório).

| Rota | Método | Uso |
|---|---|---|
| `contacts` | GET | Lista os contatos do dono autenticado (todas as instâncias). |
| `contacts` | POST | Body `{ name?, phone }`. Cria/atualiza (upsert por telefone). |
| `contacts/:id` | PUT | Body `{ name?, phone }`. |
| `contacts/:id` | DELETE | |
| `contacts/import-conversations` | POST | Sem body. Cria um contato pra cada conversa (de qualquer instância do dono) sem contato ainda. |
| `contacts/import-csv` | POST | Body `{ csvText }` (texto puro do arquivo, não base64). Devolve `{ imported, skipped, contacts }`. Máximo 5.000 linhas. |
| `contact-lists` | GET | Lista as listas do dono (com contagem de contatos). |
| `contact-lists/:id` | GET | Detalhe de uma lista + seus contatos. |
| `contact-lists` | POST | Body `{ name, contactIds:[] }`. |
| `contact-lists/:id` | PUT | Body `{ name, contactIds:[] }` (substitui os membros). |
| `contact-lists/:id` | DELETE | |
| `templates?session=` | GET | Lista os modelos de mensagem da instância. |
| `templates` | POST | Body `{ session, name, body }`. |
| `templates/:id` | PUT | Body `{ name, body }`. |
| `templates/:id` | DELETE | |

### `/api/suggestions/*` (`src/routes/suggestions.js`)

Ver §15.5. `list`/`create`/`faq` são visão de time, abertos a qualquer
autenticado; as 3 rotas de triagem exigem `requireSuperAdmin` (403 pra
qualquer outro `ownerId`) — vivem no Kanban do Admin (§14.5), não em
`/suggestions.html`.

| Rota | Método | Uso |
|---|---|---|
| `suggestions` | GET | Lista todas as sugestões (visão de time), mais recentes primeiro, limit 500. |
| `suggestions` | POST | Body `{ text }` (até 2.000 caracteres). Envia uma sugestão nova, status inicial `pending`. |
| `suggestions/faq` | GET | Pública pra qualquer autenticado (não exige `requireSuperAdmin`). `{ faq:[{id, question, answer, respondedAt}] }` — só sugestões já respondidas, mais antigas primeiro, **sem `ownerId`** de propósito. |
| `suggestions/:id/move-to-review` | POST | Restrito a `requireSuperAdmin`. Avança `pending → in_review` (404 se já não estiver `pending`) e notifica quem sugeriu. |
| `suggestions/:id/respond` | POST | Restrito a `requireSuperAdmin`. Body `{ response }` (até 2.000 caracteres; vazio/`null` limpa a resposta). Publica (ou remove) a resposta na FAQ — independente do status. |
| `suggestions/:id/release` | POST | Restrito a `requireSuperAdmin` (antes era aberto a qualquer autenticado — mudou junto com o Kanban, ver HANDOFF Parte CO). Marca `released` (404 se já estava) e notifica quem sugeriu. |

### `/api/conversation-analysis/*` (`src/routes/conversationAnalysis.js`)

Ver §15.6. TODA rota abaixo passa primeiro por
`requireConversationAnalysisAccess` (super admin ou grant explícito,
ver `src/adminAuth.js`) — nunca `requireSession`/`assertOwnsSession`,
que bloqueariam por design (o propósito desta tela é ler dado de
QUALQUER owner). Rotas de administração da própria permissão exigem
`requireSuperAdmin` por cima desse portão.

| Rota | Método | Uso |
|---|---|---|
| `whoami` | GET | `{ hasAccess: true }` — só chega aqui quem já passou pelo portão; usado pelas 15 telas pra decidir se revela o item de navegação. |
| `instances` | GET | Todas as instâncias do sistema, qualquer dono, com nome do dono já cruzado — popula os filtros de Instância e Atendente da tela. |
| `conversations?search=&sessionId=&sentBy=&from=&to=&page=&pageSize=` | GET | Lista cross-owner paginada no SERVIDOR (`pageSize` máx. 100). `sentBy` filtra por MENSAGEM INDIVIDUAL (`messages.sent_by`, quem escreveu), não por `conversations.assigned_to`. `search` usa full-text search em `messages.text_search` (stemming em português). Audita como `search`. |
| `conversations/:sessionId/:phone/history` | GET | Histórico completo de UMA conversa, qualquer dono. Audita como `view_conversation`. |
| `metrics?sessionId=&sentBy=&from=&to=` | GET | Métricas agregadas (total, recebidas/enviadas, conversas, instâncias) pro mesmo filtro de `conversations` (sem busca/paginação). |
| `insight` | POST | Body `{ search?, sessionId?, sentBy?, from?, to? }`. Gera insight de IA sobre até 60 conversas/400 mensagens do filtro (teto fixo) — resposta inclui `sampledConversations`/`totalMatching`. Não persiste. Audita como `generate_insight`. |
| `admin/grants` | GET | Restrito a `requireSuperAdmin`. Lista quem tem acesso concedido hoje, com nome já cruzado. |
| `admin/grants/:ownerId` | POST | Restrito a `requireSuperAdmin`. Concede acesso a esse owner. |
| `admin/grants/:ownerId` | DELETE | Restrito a `requireSuperAdmin`. Revoga — corta acesso na próxima chamada desse owner, sem esperar token expirar. |

### `/api/card-group/*` (`src/routes/cardGroup.js`)

Ver §15.7. "Criar grupo" no card do negócio — toda rota exige
`requireSession` (posse da instância, mesma régua do resto do app).

| Rota | Método | Uso |
|---|---|---|
| `participants?session=&dealId=` | GET | Resolve os 3 participantes internos padrão (Responsável via `ASSIGNED_BY_ID`, Verificação via o campo customizado, quem está logado) com nome+telefone (`getEmployeeInfo`). Nunca 500 por participante sem celular — `resolved:false` no item, quem chama decide. |
| `/` (raiz) | POST | Body `{ session, dealId, name, phones }`. Cria o grupo via `gateway.createGroup` (já existente) e marca `wa_groups.source='card'`/`deal_id`. |
| `/` (raiz) | GET | `?session=&dealId=` — devolve o grupo de card já criado pra esse negócio, ou `{group:null}`. Alimenta o switch Cliente/Grupo do frontend. |

### `/api/internal-notes/*` (`src/routes/internalNotes.js`)

Ver §15.7. Serve conversa 1-a-1 e grupo-com-cliente igualmente — nunca
lida por `GET /history`/`POST /send` (rota própria, dedicada).

| Rota | Método | Uso |
|---|---|---|
| `?session=&phone=` | GET | Lista notas da conversa, em ordem cronológica. Não cria a conversa se ela ainda não existir (lista vazia). |
| `/` (raiz) | POST | Body `{ session, phone, text, authorName? }`. `author_owner_id` sempre `req.ownerId` (nunca do client). Broadcast via WebSocket (`type:'internal-note'`) pra outra aba ver em tempo real. |
| `/:id` | PUT | Body `{ session, phone, text }`. Edita o texto, preservando a versão anterior em `internal_note_revisions` — HANDOFF Parte EC. Exige ser o AUTOR original (`requireResourceOwner`, 404 senão). Broadcast `type:'internal-note-updated'`. |
| `/:id/complete` | POST | Body `{ session, phone, completed }`. Marca/desmarca como concluída (toggle) — mesma restrição de autor de `PUT /:id`. Nota concluída continua na mesma posição cronológica do feed, só riscada/opaca no client. |
| `/:id/revisions?session=&phone=` | GET | Histórico de versões substituídas de uma nota, mais antiga primeiro — leitura, SEM restrição de autor (quem já lê a nota via `GET /` lê o histórico dela). |

### `/api/insights/*` (`src/routes/insights.js`)

Ver §14.9 — Copiloto Comercial. Gerado automaticamente por
`src/insightGenerator.js` a partir de `onMessage` (mensagem recebida em
instância comercial); estas rotas são só leitura/ação do que já foi
gerado + config, nunca disparam uma geração nova sob demanda.

| Rota | Método | Uso |
|---|---|---|
| `?session=&phone=` | GET | Lista insights `active` da conversa, ordem cronológica. |
| `/:id/dismiss` | POST | Body `{ session, phone }`. Marca `status='dismissed'` — some do feed do client, continua acessível via API. Confirma posse (`loadOwnedInsight`) antes de agir. |
| `/:id/feedback` | POST | Body `{ session, phone, feedback: 'useful'\|'not_useful' }`. Confirma posse antes de agir. |
| `/:id/send` | POST | Body `{ session, phone }`. Envia `insight.body` como mensagem de WhatsApp DE VERDADE ao cliente (`gateway.sendMessage` + persiste + broadcast `type:'message'`), depois marca `status='sent'`. Idempotente — insight já `sent` responde 409, não reenvia. Confirma posse antes de agir. |
| `/commercial-config?session=` | GET | Config do copiloto pra instância (`{ enabled, playbook, topics }`). |
| `/commercial-config` | PUT | Body `{ session, enabled?, playbook?, topics? }` — patch parcial, mesmo padrão de `agent_config`. **403** se `enabled:true` e o `ownerId` não estiver em `SUPER_ADMIN_OWNER_IDS` (piloto restrito, Parte EY — mesma régua de `PUT /api/agent/config`). |

### `/api/settings/*` (`src/routes/settings.js`)

| Rota | Método | Uso |
|---|---|---|
| `settings` | GET | Paleta de cores do `ownerId` autenticado (**por usuário** desde a HANDOFF Parte DL, 2026-08-18 — antes era um singleton global, tabela `app_settings`; hoje cada owner tem a própria linha em `user_palette`, `null` em cada campo ainda não configurado por aquela pessoa). |
| `settings` | PUT | Body `{ accentColor?, accentColorDim?, greenColor?, redColor?, bgColor? }` (cada campo hex ou `null` pra restaurar o padrão) — grava só na linha do `ownerId` autenticado, upsert (`insert ... on conflict do update`). |
| `settings/api-token` | POST | Gera um novo token de API de validade longa (`API_TOKEN_TTL_DAYS`, padrão 90 dias) pro dono autenticado — devolve `{ token, expiresAt }`. Mesmo formato/verificação de `issueAppToken` (`src/auth.js`), só que pensado pra uso fora do navegador (scripts, Postman, Power Query), não pro login da própria SPA. Não é persistido/revogável no servidor — gerar de novo não invalida os anteriores, cada um expira sozinho no próprio prazo. UI em `/settings.html`, seção "Token de API"; rotas documentadas de forma interativa em `GET /api-docs` (Swagger UI, `src/openapi.js`). |

### `/api/lead-forms/*` (CRUD autenticado — `src/routes/leadForms.js`)

Escopado por `req.ownerId`, igual contatos (ver §11.5). `sessionId` é validado
contra `req.ownerId` via `assertOwnsSession` antes de salvar.

| Rota | Método | Uso |
|---|---|---|
| `lead-forms` | GET | `{ forms, leadsKanbanUrl }` — lista os formulários do dono (com contagem de leads recebidos e `viewCount`), mais `leadsKanbanUrl`: link ÚNICO pro kanban do pipeline compartilhado (`BITRIX_LEADS_CATEGORY_ID`), `null` se não configurado. |
| `lead-forms` | POST | Body `{ name, title, subtitle?, welcomeMessage?, sessionId, slug?, accentColor?, logoUrl?, heroImageUrl?, storyTitle?, storyText?, testimonials?, stats?, differentials?, faq? }`. `accentColor` precisa ser hex de 6 dígitos (`#rrggbb`); `logoUrl`/`heroImageUrl` precisam começar com `http://`/`https://`. As 4 listas (`testimonials` até 5, `stats` até 4, `differentials` até 6, `faq` até 8) têm campos obrigatórios próprios — ver `sanitizeList` em `src/routes/leadForms.js`. |
| `lead-forms/:id` | PUT | Body parcial — qualquer campo, incluindo `{ active }` pra ativar/desativar. |
| `lead-forms/:id` | DELETE | Apaga o formulário e o histórico de leads dele (cascade); os contatos já criados continuam existindo. 400 se a LP está em teste A/B em andamento. O pipeline do Bitrix nunca é excluído. |
| `lead-forms/:id/submissions` | GET | Lista os leads recebidos por esse formulário (incl. `bitrixDealId`), mais recente primeiro. |
| `lead-forms/upload-logo` | POST | Body `{ mimetype, dataBase64 }`. Sobe a imagem pro bucket público `public-assets` (pasta `logos/`) e devolve `{ url }`. Limite de 6MB; só JPG/PNG/WEBP/GIF. |
| `lead-forms/upload-hero-image` | POST | Mesmo formato de `upload-logo`, pasta `hero/` — imagem de fundo do banner. |
| `lead-forms/metrics` | GET | Métricas agregadas de todas as LPs do dono (ver §11.6): `{ totals, byDay, forms }` — alimenta `/lead-metrics.html`. |

### `/api/ab-tests/*` (autenticado — `src/routes/abTests.js`)

Testes A/B entre duas LPs do dono (ver §11.5, "Testes A/B entre LPs").

| Rota | Método | Uso |
|---|---|---|
| `ab-tests` | GET | Lista os testes do dono com métricas ao vivo por variante (`viewsA/B`, `leadsA/B`, janela `createdAt..finishedAt`). |
| `ab-tests` | POST | Body `{ name, formAId, formBId }` — LPs distintas, do próprio dono, e fora de outro teste em andamento. Gera o slug do teste e grava `variant_snapshot`. |
| `ab-tests/:id/finish` | POST | Body `{ winner: 'a'\|'b'\|null, analysis }` (`analysis` obrigatória). Congela `final_metrics`, marca `finished` — imutável a partir daí. |
| `ab-tests/:id/suggest-analysis` | POST | Sem body. Chama a OpenAI com as métricas ao vivo do teste e devolve `{ analysis }` — sugestão pro campo de análise do `finish`, nunca salva sozinha. 502 se `OPENAI_API_KEY` ausente/erro na API. |
| `ab-tests/:id` | DELETE | Cancela um teste **em andamento** (sem histórico). 400 se já encerrado. |
| `ab-tests/history` | GET | Histórico estruturado dos testes encerrados (snapshot das variantes + métricas finais + vencedor + análise) — base pra futura IA geradora de LPs. |

### `/api/leads/*` (PÚBLICO, sem login — `src/routes/leads.js`)

Fora de `requireAuth` de propósito — consumido por `public/lead-form.html`
(`/l/:slug`), sem nenhuma autenticação Bitrix. O `slug` é o único "segredo" de
acesso, como qualquer link público de formulário.

| Rota | Método | Uso |
|---|---|---|
| `leads/:slug/config` | GET | `{ title, subtitle, active, accentColor, logoUrl, heroImageUrl, contactPhone, testimonials, stats, differentials, faq, storyTitle, storyText }` — 404 se o slug não existir. Também incrementa a visualização do dia (`lead_form_views`, best-effort). `contactPhone` vem da instância conectada (`getOwnNumbersBySession`, ver `src/ownNumbers.js`), `null` se nunca pareada. |
| `leads/:slug` | POST | Body `{ name?, phone }`. Cria/atualiza o contato, aplica a tag da LP e tenta mandar a mensagem de boas-vindas por WhatsApp (best-effort — não falha se a instância estiver offline). Não cria negócio no Bitrix aqui — isso só acontece quando o lead RESPONDE à boas-vindas (ver §11.5, HANDOFF Parte EM). 404 se o formulário não existir ou estiver inativo. |

Fora de `/api`: `GET /t/:slug` (público, `src/server.js`) — URL única do teste A/B;
302 pra `/l/<slug>` da variante sorteada (cookie sticky `ab_<id>`, 90 dias; teste
encerrado → vencedor; preserva query string + `#formulario`).

### WebSocket

| Rota | Uso |
|---|---|
| `/api/whatsapp/stream?session=&phone=&token=` | Envia `{ type: 'message', message }` (mensagem nova), `{ type: 'status', status }` (mudança de conexão), `{ type: 'reaction', ... }`, `{ type: 'message-status', ... }`, `{ type: 'presence', phone, state }` (contato digitando/gravando — ver §9) e `{ type: 'tags-updated', phone, tags }` (tag aplicada pelo SERVIDOR sem ação do usuário na tela — ex: Agente de IA marcando a origem do lead, §14.7) em tempo real. Broadcast direcionado por `(session, phone)` — todas as abas olhando a mesma conversa recebem. `token` é obrigatório e precisa pertencer ao dono da `session` (senão a conexão é recusada com 401/403 antes do upgrade). |

---

## 17. Mapa do código

```
src/
  server.js            # bootstrap HTTP+WS; rotas de página; hub de WebSocket; inicia o poller do scheduler
  sessions.js          # SessionManager: 1 WhatsAppGateway por instância; retoma no boot; remove() desconecta+apaga; repassa isCardGroup (§15.7)
  whatsapp.js          # WhatsAppGateway: encapsula UMA instância Baileys (QR, status, envio/recebimento, disconnect) — bypass condicional de mensagem de grupo "de card" (§15.7)
  audioConvert.js       # converte áudio para OGG/Opus via ffmpeg antes de enviar
  db.js                # pool de conexão Postgres (pg), usa DATABASE_URL
  store.js             # persistência em Postgres — conversations + messages; grupo de card + nota interna (§15.7)
  media.js             # upload de mídia pro Supabase Storage (bucket "media")
  publicAssets.js        # upload de logo pro Supabase Storage (bucket "public-assets", PÚBLICO)
  linkPreview.js         # busca metadados Open Graph de uma URL (título/descrição/imagem), com guard de SSRF
  metrics.js           # cálculo das métricas da Análise de Conversas
  instances.js          # CRUD de instâncias de WhatsApp por dono
  contacts.js           # CRUD de contatos e listas de contatos, por owner_id (não por instância)
  csvImport.js           # parser de CSV escrito à mão (sem dependência) pra importar contatos
  leadForms.js           # CRUD dos formulários de captura de lead ("Sites") + slugify/getBySlug público + views + computeMetrics
  abTests.js             # testes A/B entre LPs: CRUD, métricas por variante, histórico p/ IA
  templates.js          # CRUD de modelos de mensagem
  campaigns.js          # estado "ao vivo" (em memória) + loop de envio de uma campanha
  campaignStore.js       # persistência do histórico de campanhas + métricas agregadas
  scheduledCampaigns.js  # CRUD de agendamentos (Kanban/Calendário)
  scheduler.js          # dispara um agendamento (manual ou pelo poller) e faz o poller de 30s
  bitrix.js             # cliente REST mínimo p/ webhook do Bitrix (log opcional na timeline)
  bitrixCrm.js           # criação de contato/negócio no Bitrix pra LPs, pipeline único fixo (best-effort, nunca lança)
  openai.js              # OpenAI (gpt-4o-mini): sugestão de análise de teste A/B, resumo de conversa do Chat, insights do Dashboard + callOpenAIRaw (usado pelo Agente de IA, §14.7)
  embeddings.js          # OpenAI (text-embedding-3-small): generateEmbedding/generateEmbeddingsBatch — base de conhecimento do Agente de IA (§14.7)
  knowledgeDocs.js       # extração de texto (pdf-parse/mammoth/TXT-MD) + chunking + orquestra processUploadedDocument/listDocs/deleteDoc (§14.7)
  agentKnowledge.js      # searchRelevantChunks — busca semântica via pgvector (<=>, cosseno) na base de conhecimento (§14.7)
  agentConfig.js         # get/upsert da config do Agente de IA por instância (agent_config, upsert dinâmico por patch) (§14.7)
  agent.js               # generateAgentReply — monta system message (persona+texto livre+chunks relevantes) + histórico, chama a OpenAI (§14.7)
  agentDispatch.js        # orquestrador central: resolveLeadOrigin (LP vs Campanha), handleNewLeadMessage, dispatchAgentReply, cria negócio+tag em background (§14.7)
  agentRetryQueue.js       # fila de retry (agent_retry_queue) — enqueue/listPendingForSession/markSent/markFailed, MAX_ATTEMPTS=3 (§14.7)
  agentRetryWorker.js      # reprocessa a fila quando a instância volta a ficar online — re-gera a resposta do zero (§14.7)
  exampleCandidates.js     # CRUD da fila de candidatas a exemplo few-shot (agent_example_candidates), mesma máquina de estados de suggestions.js (§14.8)
  exampleAnonymizer.js     # anonymizeTranscript (regex+IA+reverificação) + findPiiLeaks reusada 3x (pós-regex/pós-IA/pós-edição-humana) (§14.8)
  exampleApproval.js       # orquestra os 2 passos de aprovação (reviewCandidate/confirmApproval), grava embedding + agent_examples (§14.8)
  agentExamples.js         # searchRelevantExamples — busca semântica de exemplos aprovados, espelha agentKnowledge.js (§14.8)
  auth.js               # verifica access_token contra o Bitrix de verdade + emite/valida o token de app (sessão + API)
  authz.js              # confere que session/owner de cada request pertence ao dono autenticado
  adminAuth.js           # requireSuperAdmin — confere req.ownerId contra SUPER_ADMIN_OWNER_IDS (Painel Admin, §14.5)
  presence.js            # heartbeat()/listPresence() — "quem está com o app aberto agora" (admin_presence)
  pageSessions.js        # trackeamento real de navegação (page_sessions) — open/ping/close + closeStaleSessions + agregações (§14.5)
  blockedOwners.js       # bloqueio de acesso individual ao app inteiro (blocked_owners), verificado em requireAuth (§14.5)
  bitrixHierarchy.js     # hierarquia de departamento/gestor via user.get/department.get + listEmployees()/getEmployeePhone()/getEmployeeInfo() (§14/§14.5/§15.7)
  bitrixDealFields.js    # resolve o UF_CRM_* do campo customizado "[AUT] Resp. Ver. Contratos" via crm.deal.fields, cacheado (§15.7)
  suggestions.js         # sugestões dos usuários — CRUD + moveToReview/respond/listFaq (Kanban do Admin + FAQ, §15.5)
  conversationAnalysisGrants.js # quem tem acesso à Auditoria de Conversas (conversation_analysis_grants), espelha blockedOwners.js (§15.6)
  conversationAnalysisAudit.js  # auditoria de acesso ao painel acima (conversation_analysis_audit) — nunca conteúdo de mensagem (§15.6)
  conversationAnalysisStore.js  # consultas CROSS-OWNER (deliberado) pra Auditoria de Conversas — listAll/getHistory/computeAggregateMetrics (§15.6)
  openapi.js             # spec OpenAPI da API REST, servido em GET /api-docs (Swagger UI)
  routes/
    whatsapp.js        # rotas REST /api/whatsapp/* (chat, instâncias, campanhas, agendamentos)
    crm.js             # rotas REST /api/* (contatos, listas, modelos)
    leadForms.js         # rotas REST /api/lead-forms/* (CRUD autenticado dos formulários + pipeline Bitrix)
    leads.js             # rotas REST /api/leads/* (PÚBLICO, sem login — config+views + submissão+Bitrix)
    abTests.js           # rotas REST /api/ab-tests/* (CRUD autenticado dos testes A/B + histórico)
    settings.js          # rotas REST /api/settings/* (paleta de cores POR USUÁRIO, HANDOFF Parte DL + geração de token de API)
    suggestions.js        # rotas REST /api/suggestions/* (sugestões dos usuários)
    conversationAnalysis.js # rotas REST /api/conversation-analysis/* (Auditoria de Conversas, acesso restrito, §15.6)
    cardGroup.js           # rotas REST /api/card-group/* ("Criar grupo" no card do negócio, §15.7)
    internalNotes.js        # rotas REST /api/internal-notes/* (nota interna, nunca visível ao cliente, §15.7)
    agent.js               # rotas REST /api/agent/* (config, upload de base de conhecimento, toggle por conversa, §14.7; fila de exemplos few-shot, §14.8)
public/
  index.html           # frontend da aba do chat (vanilla JS + SDK BX24) — seletor de instância, "Criar grupo"/switch Cliente-Grupo e nota interna no cabeçalho (§15.7)
  dashboard.html        # Análise de Conversas
  chat.html             # Chat — inbox com todas as conversas + painel de detalhes do contato (Bitrix)
  campaign.html         # Campanha (disparo em massa)
  contacts.html         # Contatos e listas
  sites.html             # Sites — CRUD dos formulários públicos de captura de lead
  lead-form.html         # página PÚBLICA (/l/:slug) que o visitante vê e preenche, sem login/Bitrix
  lead-metrics.html      # Métricas de Sites — dashboard agregado de todas as LPs do dono
  campaign-metrics.html # Métricas de Campanhas
  campaign-schedule.html# Agenda de Envios (Kanban/Calendário)
  instances.html        # Gestão de instâncias
  notifications.html    # Central de Notificações (Kanban/Calendário)
  suggestions.html       # Sugestões — enviar e acompanhar o próprio status (§15.5)
  faq.html               # FAQ pública — perguntas já respondidas na triagem do Admin (§15.5)
  admin.html             # Painel Admin — restrito a SUPER_ADMIN_OWNER_IDS (§14.5)
  conversation-analysis.html # Auditoria de Conversas — acesso restrito, leitura cross-instância (§15.6)
  apresentacao.html      # relatório executivo (scrollytelling) pra diretoria/CEO — sem sidebar, exportável em PDF
  agente-ia.html         # Agente de IA — config por instância, base de conhecimento, upload de documentos (§14.7)
  agent-examples.html    # Exemplos de conversa — fila de aprovação few-shot, anonimização, edição manual (§14.8)
db/
  schema.sql            # DDL de todas as tabelas
  migrate.js            # roda schema.sql contra o Postgres (usa DIRECT_URL)
  create-bucket.js       # cria o bucket privado "media" no Supabase Storage
  create-public-bucket.js # cria o bucket público "public-assets" (logo/hero de LP)
  migrate-media-urls.js  # reescreve messages.media_url do formato público antigo pro novo (rodar 1x)
  make-bucket-private.js # flipa um bucket "media" já existente pra privado (rodar 1x)
  import-legacy-data.js  # importa o histórico de antes do Postgres (rodar 1x)
  migrate-to-company-supabase.js         # copia as 21 tabelas entre dois projetos Supabase (rodar 1x por migração de conta)
  migrate-storage-to-company-supabase.js # copia os buckets "media"/"public-assets" entre dois projetos Supabase (idem)
scripts/
  fix-lid-phones.js      # corrige conversations/messages salvos com telefone LID cru — --dry-run/--apply (HANDOFF Parte CP)
  fix-lid-contacts.js    # idem, escopo contacts — --dry-run/--apply (HANDOFF Parte CP)
auth_session/
  <sessionId>/         # credenciais Baileys por instância — faça backup
```

### `src/auth.js`
- `verifyBitrixToken(accessToken)`: chama `https://${BITRIX_PORTAL_DOMAIN}/rest/user.current.json` (domínio sempre fixo do `.env`, nunca do cliente) e devolve o ID real do usuário Bitrix, ou `null`.
- `issueAppToken(ownerId)` / `verifyAppToken(token)`: token assinado com HMAC (`crypto` nativo, sem lib de JWT), payload `{ ownerId, exp }`, TTL `AUTH_TOKEN_TTL_HOURS`.
- `requireAuth`: middleware Express — valida o `Authorization: Bearer`, seta `req.ownerId`, ou 401.
- `ownerIdFor(bitrixUserId)`: `` `${BITRIX_MEMBER_ID}_${bitrixUserId}` `` — sempre construído com config do servidor, nunca com dado do cliente.

### `src/authz.js`
- `assertOwnsSession(sessionIdOuCsv, ownerId)`: confere posse **ou acesso delegado** — manual (`instancesStore.listDelegates()`) OU automático via hierarquia do Bitrix (`bitrixHierarchy.getSubordinates()`, só consultado se não bater dono nem delegado manual, e no máximo uma vez por chamada mesmo com vários ids) — via `instancesStore.get()` (trata o caso comum de dono com uma instância só, `id === ownerId`, sem ir ao banco). Dono, delegado manual, ou subordinado (na hierarquia) do dono passa; qualquer outro, nega. Como `requireSession` (linha abaixo) é usado por praticamente toda rota de conversa/mensagem/QR/status, essa única função é o que propaga os dois tipos de acesso pro app inteiro.
- `requireSession(extractor)`: middleware factory pras rotas que recebem `session` (query/body, uma ou várias) — 400 se faltando, 403 se não pertence (nem posse nem delegação) ao `req.ownerId`.
- `requireResourceSession(lookupFn)`: pras rotas por `:id` de recurso (campanha, agendamento) — descobre o dono do recurso primeiro, então confere posse; 404 (não 403) pra não revelar que o recurso existe.
- `requireOwnerMatch(extractor)`: pras rotas de CRUD de instância, onde o `owner` recebido precisa ser exatamente o próprio usuário autenticado. **Não conhece delegação** — de propósito: renomear/remover/gerenciar delegados continua exigindo o dono de verdade, conferido explicitamente dentro do handler (`instancesStore.get(id).ownerId`).
- `requireResourceOwner(lookupOwnerId)`: espelha `requireResourceSession`, mas pra recursos donos diretos de um `owner_id` (não de um `session_id`) — hoje só `notifications`; compara `owner_id` do registro direto contra `req.ownerId`, sem a indireção de `assertOwnsSession`.

### `src/instances.js`
- `get(id)` / `listByOwner(ownerId)` / `ensureDefault(ownerId)` / `create` / `rename` / `remove`: CRUD de instâncias (tabela `instances`, `id` = `session_id` usado no resto do app).
- `ownerOf(sessionId)`: resolve o dono de uma sessão — mesmo fallback que `assertOwnsSession` usa (`id === ownerId` quando não há linha em `instances`, caso do dono com uma instância só). Usado em `src/server.js` pra saber de quem é uma notificação nova.
- **Delegação de acesso** (tabela `instance_delegates`, ver §14 "Instâncias"): `listDelegates(instanceId)` / `addDelegate(instanceId, ownerId, delegateOwnerId, delegateName)` / `removeDelegate(instanceId, ownerId, delegateOwnerId)` — sempre conferem `ownerId` contra o dono real antes de mexer (mesmo padrão de `rename`/`remove`). `listAccessible(ownerId)`: instâncias próprias + delegadas manualmente + delegadas via hierarquia do Bitrix (`hierarchy_subordinates`, ver `src/bitrixHierarchy.js`), todas com `delegated: true/false` — usado em `GET /instances`; `MAX_INSTANCES_PER_OWNER` continua checando só `listByOwner`, então nenhuma das duas formas de delegação ocupa vaga de quem recebeu o acesso. Dispara `ensureHierarchyCacheFresh()` (fire-and-forget, não atrasa a resposta) toda vez que é chamada, pra manter o cache de hierarquia quente sem custar latência desta request.

### `src/sessions.js` — `SessionManager`
- `get(sessionId)`: cria (lazy) e inicia o `WhatsAppGateway` da instância; sanitiza o
  `sessionId` antes de usar como nome de pasta (evita path traversal); se a instância
  já existir e estiver deslogada, chama `requestFreshQr()` sozinho.
- `remove(sessionId)`: desconecta (`gateway.disconnect()`) e apaga a pasta de
  credenciais — usado ao remover uma instância em `/instances.html`.
- `startAllExisting()`: no boot, percorre `auth_session/` e reinicia toda instância
  que já tenha `creds.json` salvo.

### `src/whatsapp.js` — `WhatsAppGateway extends EventEmitter`
Encapsula uma instância Baileys. Eventos emitidos: `qr`, `status`, `message`.
- `sendMessage(phone, text)` / `sendMedia(phone, {type, buffer, mimetype, caption})`:
  enviam via `sock.sendMessage`; lançam erro se a instância não estiver `online`.
  `sendMedia` converte áudio para OGG/Opus antes de enviar (ver §7) e devolve o
  buffer/mimetype realmente usados, para quem chamou salvar os bytes certos.
- `disconnect()`: tenta `sock.logout()` (deslogar de verdade do lado do WhatsApp) e
  sempre apaga as credenciais salvas, mesmo se o logout falhar.
- Reconecta automaticamente em quedas de conexão (exceto `loggedOut`, que exige novo
  QR Code via `requestFreshQr()`). O log de desconexão inclui o nome da sessão e o
  `statusCode`/motivo reais do Baileys (`DisconnectReason[statusCode]` — ex.:
  `401 loggedOut`, `408 timedOut`, `440 connectionReplaced`), não só um booleano —
  útil pra diferenciar sessão deslogada (precisa reescanear QR) de queda de rede
  passageira (reconecta sozinha).
- Processa mensagens em **ambas as direções**: `fromMe: true` (enviadas, seja pelo
  widget ou direto do celular do usuário) e `fromMe: false` (recebidas) — o dedupe
  por `id` no `store.js` evita duplicar quando o WhatsApp ecoa uma mensagem que já
  havíamos salvo ao enviar pelo widget.
- **Mapeamento de telefone real por trás de endereços `@lid`**: o WhatsApp moderno
  identifica remetentes/destinatários por um ID opaco (`<numero>@lid`) em vez do
  telefone, por privacidade. O telefone real vem em `key.participantAlt` (mensagens
  de grupo) ou `key.remoteJidAlt` (conversa direta) — **não** em
  `key.senderPn`/`participantPn` (campos que não existem nesta versão do Baileys,
  apesar de aparecerem em exemplos antigos da lib).
- `getGroupParticipantPhones(groupId)`: chama `sock.groupMetadata(groupId)` e
  resolve o telefone de cada participante via o campo `phoneNumber` do tipo
  `Contact` do Baileys (mesma ideia do `participantAlt` acima, só que pro tipo
  específico de `GroupParticipant`) — usado por `GET /contacts/groups` (§16,
  "grupos em comum" no painel de contato do Chat, §9). Best-effort: um
  participante que só aparece como `@lid` sem telefone resolvido não é
  encontrado.
- `getGroupCount()`: chama `sock.groupFetchAllParticipating()` — total de
  grupos REAIS que o número participa (não a tabela `wa_groups`, que só
  guarda grupos criados por este app). `null` se a sessão não estiver
  `online`. Usado pelo card de instância (§14).
- `getContactCount()`: tamanho de um `Set` de IDs acumulado a partir dos
  eventos `contacts.upsert`/`contacts.update` do Baileys, escutados em
  `start()`. **Não é o total real da agenda** — Baileys não expõe nem uma
  chamada de contagem nem um snapshot completo, só incrementos; o número
  cresce enquanto a sessão fica online e zera a cada reinício/reconexão do
  zero (ver §14 para a limitação completa).
- `getProfilePicture(phone)`: `sock.profilePictureUrl(jid, 'image')` — foto
  de perfil do contato/grupo, `null` (nunca lança) se a sessão não estiver
  `online`, o contato não existir ou a privacidade dele bloquear. Usado por
  `GET /avatar` (§16), cacheada em `conversations.avatar_url` pelo chamador.

### `src/store.js`
Interface (todas `async`): `addMessage`, `getHistory`, `updateMessageStatus`,
`setDealForPhone`, `getDealForPhone`, `setConversationArchived` (arquivar/
desarquivar, tela Chat — ver §9), `setConversationNotifications` (silenciar/
dessilenciar, idem — ver §9), `getAll(sessionIds)` (usada só pela Análise de
Conversas — **exige** a lista de instâncias, filtra com `where session_id =
any($1)`; chamar sem escopo reintroduziria o vazamento entre donos corrigido
na Parte AR do HANDOFF).
`listConversations(sessionIds, search, { archived })` filtra por
`conversations.archived` (padrão `false`) e devolve `notificationsEnabled`
(`conversations.notifications_enabled`, padrão `true`) por conversa.
`getAvatarUrl`/`setAvatarUrl` (`conversations.avatar_url`) cacheiam a foto
de perfil do WhatsApp de um contato — ver §9/§16.

Central de Notificações (§15, tabela `notifications`): `getConversationNotifPrefs(sessionId, phone)`
(silenciada? nome do contato?, usado só antes de criar uma notificação),
`addNotification({ownerId, title, body, target})` (gera o próprio id, mesmo
padrão de `src/campaigns.js`), `listNotifications(ownerId)` (mais recentes
primeiro, limit 500), `countUnreadNotifications(ownerId)`,
`getNotificationOwner(id)` (pro `requireResourceOwner`), `markNotificationRead(id, read)`,
`markAllNotificationsRead(ownerId)`.

### `src/campaigns.js`
Estado "ao vivo" de campanhas em memória (`Map`, some num restart no meio de uma
campanha — não é uma fila de verdade). `createCampaign(total, meta)` é `async` e
**precisa ser aguardada** — ela grava o cabeçalho em `campaigns` (Postgres) antes de
devolver o id, porque outros updates (resultado por destinatário, vínculo de
agendamento) referenciam esse id via foreign key (ver §19, bug #9).
`runCampaign(id, {...})` roda o loop de envio (não é aguardada pelo caller — o
progresso é consultado via `getCampaign(id)`).
`onCampaignMessageStatus(messageId, status)`: corrige retroativamente `sent`/`failed`
quando o WhatsApp rejeita a entrega DEPOIS do envio (`status === 'failed'`, ver
HANDOFF Parte CM) — chamada dentro de `onMessageStatus` em `src/server.js`, não
faz nada se o `messageId` não for de uma campanha (mapa em memória
`messageIdToCampaign`, populado a cada envio dentro de `runCampaign`).

### `src/scheduler.js`
`sendScheduled(id, sessions)`: transforma um agendamento em uma campanha real
(chamado tanto pelo poller quanto pelo "Enviar agora" manual) — resolve a mídia
via `row.media_url` (`downloadMedia`, formato novo) com fallback pra
`row.media_base64` (agendamentos criados antes do bucket virar privado, ver §7/§13).
`startPolling(sessions)` roda a cada 30s (chamado uma vez em `server.js`) e
dispara todo agendamento vencido.

### `src/media.js`
- `saveMedia(sessionId, id, buffer, mimetype)` → `async`, sobe pro bucket
  `media` do Supabase Storage (privado) em `<sessionId>/<id>.<ext>` (prefixo
  de instância evita colisão de `key.id` entre instâncias diferentes, ver
  §7) e devolve um caminho relativo (`/api/whatsapp/media/<filename>`), não
  mais a URL pública.
- `getSignedMediaUrl(filename, expiresIn=300)`: usado pela rota `GET
  /media/:filename` (§16) pra gerar a signed URL na hora de exibir.
- `downloadMedia(relativeUrl)`: extrai o filename e baixa os bytes direto do
  Storage (server-to-server, sem gerar signed URL) — usado por
  `src/scheduler.js` pra reconstituir a mídia de um agendamento pendente.

### `src/server.js`
- `subscribers`: `Map<"sessionId::phone", Set<WebSocket>>`.
- `broadcast(sessionId, phone, payload)`: envia para todas as abas olhando aquela
  conversa específica.
- `broadcastStatus(sessionId, status)`: avisa todas as abas abertas daquela
  instância, independente do telefone.
- `onMessage` (callback do `SessionManager`): além de salvar a mensagem e fazer
  o broadcast, cria a notificação persistida (§15) quando é mensagem recebida
  numa conversa não silenciada — resolve o dono via `instancesStore.ownerOf`
  e chama `store.addNotification`. Roda sempre, não só quando o Chat está aberto.

### Boilerplate compartilhado (8 páginas de `public/`)
Bloco de script duplicado de propósito nas 8 páginas com sidebar (chat,
dashboard, instances, contacts, campaign, campaign-metrics,
campaign-schedule, notifications) — qualquer mudança nele precisa ser
replicada manualmente em todas.
- `window.showToast(message, type, target?)`: toast que expira sozinho (~4.5s);
  `target` opcional deixa o próprio toast clicável (ver §9).
- `window.updateNotifBadge(count)` / `window.__bumpNotifBadge()`: número no
  sino da sidebar (§15).
- `window.confirmDialog(message)` → `Promise<boolean>`: substitui o
  `confirm()` nativo do navegador — cria o próprio `.overlay`/`.modal` via
  `document.createElement` na primeira chamada (não duplica HTML por
  página), resolve `true`/`false` nos botões ou `false` no ESC. Usado em
  todo ponto que antes tinha `confirm()` (remover instância, excluir
  contato/lista, cancelar agendamento, confirmar envio de campanha em massa).
- Handler global de `keydown` (ESC): fecha qualquer `.overlay.open` — inclui
  o `confirmDialog` acima, contando como "Cancelar".

### `public/index.html` — fluxo `boot()`
1. `initBx24()` → pega `dealId` do placement; se `PLACEMENT === 'DEFAULT'` (aberto
   pelo ícone do app, fora de um card), redireciona para `/dashboard.html`.
2. `resolveOwner()` → `verifyAuth()`: pega `BX24.getAuth().access_token`, chama
   `POST /api/auth/verify`, guarda o token de app devolvido (usado em toda chamada
   seguinte via `apiFetch`) e usa o `ownerId` que o **servidor** devolve — já
   verificado contra o Bitrix, não mais calculado só no navegador.
3. `loadInstances(ownerId)` → busca as instâncias do dono; usa a lembrada por negócio
   (`localStorage`) se ainda existir, senão a primeira da lista.
4. `loadDealContact()` → `crm.deal.get` + `crm.contact.get` → telefone (normalizado
   para E.164 com DDI 55 — ver `normalizePhone`) e nome do contato.
5. `ensureConnected()` → consulta `/qr` da instância selecionada; se `online`, carrega
   histórico; senão mostra o QR embutido e faz polling a cada 2.5s até conectar.
6. `connectRealtime()` → abre o WebSocket para mensagens/status em tempo real;
   reconecta sozinho em 4s se cair.
- `switchInstance(newId)`: troca a instância ativa (fecha WebSocket/polling da
  anterior, salva a escolha no `localStorage` por negócio, chama `ensureConnected()`
  de novo) — só aparece um seletor no cabeçalho/tela de QR quando o dono tem mais de
  uma instância.
- Envio de mensagem/mídia: mostra a bolha otimisticamente e, ao ter a confirmação do
  `POST /send` ou `/send-media`, troca o `id` temporário pelo `id` real — assim,
  quando o WebSocket ecoar a mesma mensagem de volta, o dedupe por `id` evita
  duplicar na tela.

---

## 18. Segurança — pendências antes de produção

- ~~Nenhuma autenticação real nas rotas REST~~ — **resolvido**: toda rota de
  `/api/whatsapp/*` e `/api/*` exige `Authorization: Bearer <token>`, emitido só
  depois de `POST /api/auth/verify` confirmar contra o Bitrix de verdade (domínio
  fixo do servidor) que o usuário é real; cada rota ainda confere posse da
  `session`/`owner` recebida (403/404 se não pertencer a quem está autenticado).
  `/dashboard.html`/`/api/whatsapp/metrics` também exigem token válido, e desde
  2026-07-09 `GET /metrics` filtra pelas instâncias do dono autenticado
  (`req.ownerId` via `instancesStore.listByOwner`) — antes agregava de TODOS os
  donos por engano, ver bug #18 em §19. Ver §16 ("Autenticação") e
  `src/auth.js`/`src/authz.js`.
- `ALLOWED_ORIGINS` deve conter o domínio real do portal Bitrix (não o placeholder de
  exemplo).
- ~~O servidor rodava direto via `node src/server.js`, sem supervisor~~ —
  **resolvido**: em produção roda como serviço do EasyPanel (Docker Swarm), que
  recria a task sozinho numa falha fatal e volta no boot da VPS. O histórico
  com PM2 valia para o deploy anterior em máquina Windows; ver
  [DEPLOY.md](DEPLOY.md) §4 para como reiniciar (`docker service update
  --force`, **não** `docker restart` — este último conflita com o
  gerenciamento de rede do Swarm e, na prática, o Swarm detecta a falha e
  recria o container do zero de qualquer jeito, a partir da ÚLTIMA IMAGEM
  buildada, não do filesystem em memória — não existe "hot-swap" de código
  num container rodando).
- **Todo deploy desconecta e reconecta TODAS as sessões de WhatsApp de todos
  os usuários** — inerente a rodar com 1 réplica só (`UpdateConfig.Parallelism:
  1`, sem redundância): o container novo sobe primeiro (`Order: start-first`,
  ~5s de monitoramento antes do antigo desligar), mas os sockets WebSocket do
  Baileys não sobrevivem à troca de processo de qualquer forma. Reconexão
  acontece sozinha, escalonada (`SESSION_STAGGER_MS`, 15s por sessão — ver
  §env vars), sem intervenção manual. Isto é DIFERENTE do incidente do loop de
  reconexão infinito (HANDOFF Parte CQ) — aquilo era um loop descontrolado de
  centenas de tentativas martelando o processo; isto é uma queda única e
  controlada por deploy, esperada, não um bug. Ambiente de teste separado
  (aplicação própria no EasyPanel, banco+auth_session próprios) pra validar
  antes de produção — planejado, não implementado ainda (HANDOFF Parte CU).
- ~~O bucket `media` no Supabase Storage é público~~ — **resolvido**: o bucket é
  privado, mídia é servida via signed URL de curta duração por uma rota
  autenticada (`GET /media/:filename`, qualquer usuário deste portal — não
  restrito por dono da conversa) — ver §7 e §16.
- ~~O `Pool` do Postgres (`src/db.js`) não tinha listener de erro~~ —
  **resolvido**: uma conexão ociosa fechada pelo pooler do Supabase (comum,
  acontece de tempos em tempos) disparava um evento `'error'` sem tratamento
  no `Pool`, o que derrubava o processo Node inteiro — passava por cima até
  do `process.on('uncaughtException')`. Corrigido com `pool.on('error', ...)`
  em `src/db.js`, que só loga o erro (o pool cria conexão nova sozinho na
  próxima query).
- `SUPABASE_SERVICE_ROLE_KEY` e as connection strings do Postgres dão acesso total
  ao banco — nunca as exponha no frontend nem em repositórios públicos. Note que
  `docker inspect` imprime **todas** as env vars em claro; ver
  [DEPLOY.md](DEPLOY.md) §5 e §9.
- ~~`POST /` logava o payload de instalação do Bitrix inteiro~~ — **resolvido**
  (2026-07-29): `console.log('[debug] POST / body:', ...)` em `src/server.js`
  despejava `AUTH_ID`, `REFRESH_ID` e `APPLICATION_TOKEN` no log do container,
  legíveis por qualquer um com acesso à VPS via `docker logs`. Agora loga só
  `event`, `PLACEMENT` e `member_id`. **O `REFRESH_ID` e o `APPLICATION_TOKEN`
  não expiram sozinhos** — só reinstalar o app local no Bitrix os revoga.
- **Retry agressivo em `403`** (`src/whatsapp.js`, branch `!loggedOut` do
  `connection.update`): reconecta a cada 3s indefinidamente. Em jul/2026 uma
  sessão ficou 41h em loop de `403 (forbidden)` — risco de ban do número.
  Falta um backoff exponencial e tratamento específico para `403` (que costuma
  significar rejeição daquela conexão, não instabilidade de rede).
- **5 vulnerabilidades no `npm audit`** (1 low, 3 moderate, 1 high — número
  atualizado em 2026-08-17; a maior parte das 12 anteriores já foi resolvida
  por atualizações de dependência ao longo do tempo). A restante é em `uuid`,
  via dependência transitiva do `exceljs`. Não rodar `npm audit fix --force`
  sem testar — aplica breaking change (trocaria a versão do `exceljs`).
- ~~`scheduled_campaigns` guarda mídia anexada como base64 direto na tabela~~ —
  **resolvido**: a mídia sobe pro Storage já na hora de agendar, só o caminho
  fica na tabela (`media_url`) — ver §13.
- ~~Sem rate limiting em nenhuma rota~~ — **resolvido** (2026-08-17): `POST
  /api/*` (todo o backend) passou a ter um limite de 600 requisições/minuto
  por IP (`express-rate-limit`, `src/server.js`), retornando `429` só ao
  exceder. O número é deliberadamente generoso, calculado com margem pro
  próprio tráfego legítimo do app (heartbeat de 30s em até 14 telas
  simultâneas, várias pessoas atrás do mesmo IP corporativo) — protege
  contra abuso claro sem afetar uso humano normal. `/api-docs` não é afetado.
- ~~Erros internos não tratados podiam vazar detalhe técnico pro cliente~~ —
  **parcialmente resolvido** (2026-08-17): adicionado um middleware de
  última linha em `src/server.js` (depois de todas as rotas) que responde
  genérico a qualquer erro que escape sem tratamento. **Limitação real**:
  no Express 4 (versão usada aqui), isso só entra em ação para erro
  SÍNCRONO num handler não-`async`, ou se algum código chamar `next(err)`
  explicitamente — nenhuma das ~108 respostas de erro já existentes
  (`res.status(...).json({ error: err.message })`, escritas de propósito
  como mensagens de negócio: "sessão não encontrada", "imagem maior que
  6MB") foi tocada nem passa por este middleware, continuam expondo
  `err.message` como sempre. Decisão deliberada (ver HANDOFF Parte DI): não
  reescrever os 108 pontos de uma vez, risco real de quebrar uma mensagem
  da qual o frontend dependa do texto.
- **Versionamento de API avaliado e descartado por ora**: hoje o único
  consumidor das rotas é o próprio frontend deste projeto (mesmo
  repositório, atualizado junto a cada deploy) — não há terceiro externo
  dependendo de uma versão antiga que se beneficiaria de `/api/v1/...`.
  Reavaliar se algum consumidor externo passar a existir.

---

## 19. Bugs conhecidos já corrigidos (histórico)

Estes problemas já apareceram e foram resolvidos — documentados aqui para não serem
reintroduzidos por engano:

1. **Placement nunca registrava a aba** — o código antigo só chamava
   `placement.bind` se o POST de instalação trouxesse `event === 'ONAPPINSTALL'`, o
   que não ocorre na instalação interativa padrão. Resolvido criando a rota
   `/install`, que registra o placement via `BX24` no navegador.
2. **"Não foi possível carregar a conversa"** — a página de aviso do ngrok grátis
   interceptava os `fetch` (devolvia HTML em vez de JSON). Resolvido adicionando o
   header `ngrok-skip-browser-warning: true` em todas as chamadas do frontend.
3. **`SessionError: No session record`** ao receber mensagens de endereços `@lid` no
   Baileys `6.7.23`. Resolvido atualizando para `@whiskeysockets/baileys@7.0.0-rc13`
   (suporte nativo a LID).
4. **Mensagens recebidas não apareciam na aba** — causa raiz: o mapeamento de
   telefone real por trás de um endereço `@lid` usava os campos
   `key.senderPn`/`key.participantPn`, que **nunca são preenchidos** nesta versão do
   Baileys. Resolvido usando `key.participantAlt` / `key.remoteJidAlt`.
5. **Mensagem enviada aparecia duplicada na tela** — o backend retransmitia
   (`broadcast`) a mensagem enviada de volta pra própria aba que enviou. Resolvido
   substituindo o `id` temporário da mensagem otimística pelo `id` real, e
   ignorando no WebSocket qualquer mensagem cujo `id` já esteja na tela.
6. **Mensagens enviadas direto do celular (fora do widget) não eram salvas** — o
   código descartava de propósito todo evento `fromMe: true`, assumindo que só
   vinham do próprio envio via API. Resolvido processando os dois sentidos, com
   dedupe por `id` no `store.js` para não duplicar o que o widget já salvou.
7. **Áudio gravado no navegador chegava mas não tocava no destinatário** — o
   WhatsApp só entrega/reproduz áudio em OGG/Opus; `webm/opus` (formato nativo do
   `MediaRecorder` no Chrome) era aceito no upload mas silenciosamente não
   entregue. Resolvido convertendo sempre para OGG/Opus via ffmpeg antes de enviar
   (`src/audioConvert.js`).
8. **Túnel ngrok em porta/domínio errado** — não é bug de código, mas recorrente em
   ambiente local: o ngrok pode ficar apontando para uma porta antiga (ex. `80`) ou
   para um domínio reservado por outra conta ngrok. Sempre confirme com
   `curl http://127.0.0.1:4040/api/tunnels` que `config.addr` bate com a `PORT` do
   `.env` e que `public_url` é o mesmo cadastrado no Bitrix.
9. **`insert or update on table "scheduled_campaigns" violates foreign key
   constraint "scheduled_campaigns_campaign_id_fkey"`** ao clicar "Enviar agora" num
   agendamento — `createCampaign()` gravava o cabeçalho da campanha no Postgres em
   segundo plano, sem esperar terminar, e já devolvia o `campaignId` na hora; o
   código então tentava vincular o agendamento a esse id **antes** da linha existir
   de verdade na tabela `campaigns`. Resolvido tornando `createCampaign()` `async` e
   aguardando a gravação antes de devolver o id (ver `src/campaigns.js`).
10. **Vazamento de dados entre usuários** nas páginas de Campanha, Contatos,
    Métricas de Campanhas e Agenda de Envios — os seletores de sessão listavam
    **todas** as instâncias de **todos** os usuários, permitindo escolher enviar
    campanhas ou ver contatos/métricas de outra pessoa. Resolvido travando cada
    página na própria instância do usuário logado (resolvida via BX24 no
    navegador), com filtro obrigatório correspondente no backend
    (`GET /instances?owner=`, `?session=` em métricas/agendamentos).
11. **Spoofing de `session`/`owner` e IDOR** — nenhuma rota validava que o
    `session`/`owner` enviado pelo navegador pertencia de verdade a quem fazia a
    requisição (ver histórico do bug #10 acima, que só filtrava a UI, não o
    backend); além disso `contacts`, `contact_lists` e `message_templates` usam id
    sequencial (`bigserial`, enumerável) e as funções de update/delete não
    filtravam por `session_id` no SQL — mesmo um usuário legítimo podia
    editar/apagar recurso de outro só incrementando o id. Resolvido com
    autenticação real (`src/auth.js`/`src/authz.js`, ver §16) + cláusula
    `and session_id = $n` nas funções por `:id` (`src/contacts.js`,
    `src/templates.js`). De quebra, `GET /scheduled-campaigns` e
    `GET /campaigns/metrics` sem `session` devolviam os dados de **todo mundo** —
    agora exigem e filtram como as demais rotas; e a página `/admin/login` (debug
    de QR sem nenhuma autenticação) foi removida por ser, ela mesma, uma forma de
    sequestrar uma instância ainda não pareada.
12. **`BX24.getAuth()` chamado antes do `BX24.init` terminar** — ao trocar o
    cálculo de `ownerId` (antes via `BX24.callMethod`, tolerante a chamadas
    antes do BX24 estar pronto) pelo novo fluxo baseado em `BX24.getAuth()`
    (síncrono, só populado depois que o callback do `BX24.init` dispara), 6
    páginas chamavam a função de carregar dados antes desse callback rodar —
    `BX24.getAuth()` voltava vazio, autenticação falhava com "não foi possível
    obter o token do Bitrix", e a criação de instância falhava com "owner é
    obrigatório". Resolvido com uma promise `bx24Ready` que só resolve dentro do
    callback do `BX24.init`; `verifyAuth()` espera essa promise antes de ler
    `BX24.getAuth()`, não importa de onde for chamada.
13. **Servidor caindo por completo numa falha de rede transitória com o Bitrix**
    — uma chamada `fetch` pro Bitrix (ex: `verifyBitrixToken` ou
    `logMessageToTimeline`) que sofre um `ECONNRESET` no meio da leitura da
    resposta pode escapar do `try/catch` normal (bug conhecido do `undici`, onde
    o erro chega como evento `'error'` cru numa Readable em vez de rejeição de
    Promise) e derrubar o processo Node inteiro — junto com todas as sessões de
    WhatsApp conectadas. Resolvido adicionando
    `process.on('uncaughtException'/'unhandledRejection', ...)` em
    `src/server.js`, que loga o erro e mantém o servidor no ar (ver §18 sobre
    considerar também um supervisor de processo).
14. **Mensagem de grupo do WhatsApp caindo na conversa individual do
    participante** — `src/whatsapp.js` resolvia o telefone de toda mensagem
    por `participantAlt || remoteJidAlt || participant || remoteJid`, ordem
    que sempre prioriza o remetente quando presente. Numa mensagem de GRUPO
    o WhatsApp sempre preenche `participant`, então bate-papo de qualquer
    grupo que o número conectado participa (família, torcida, grupo de
    promoção) acabava misturado na conversa 1:1 daquele contato — inclusive
    criando "contatos" com o ID do grupo inteiro como telefone (18-23
    dígitos, nunca um telefone real) quando o remetente não era resolvível.
    Primeira correção isolou a mensagem de grupo numa conversa própria
    (JID do grupo, já arquivada por padrão); depois, a pedido do usuário
    (mensagem de grupo ainda aparecia fisicamente na tabela `messages` pelo
    Table Editor do Supabase, mesmo isolada), a versão final **descarta a
    mensagem de grupo por completo** — mesmo tratamento do Status (item 15).
    Efeito colateral aceito: `createGroup()` continua criando grupo e
    enviando mensagem nele, mas respostas de quem está no grupo não
    aparecem mais em lugar nenhum do CRM.
15. **Status (Stories) do WhatsApp virando mensagem de conversa** — quando o
    número conectado consegue ver o Status de um contato, o Baileys entrega
    isso pelo mesmo evento de mensagem normal (`remoteJid =
    "status@broadcast"`) — sem tratamento, virava uma "mensagem" de verdade
    salva na conversa 1:1 daquele contato (uma foto/vídeo que a pessoa só
    postou no Status dela, nunca mandou pra ninguém). Resolvido descartando
    a mensagem por completo quando `isJidBroadcast(remoteJid)` (utilitário
    do próprio `@whiskeysockets/baileys`) — não grava nada, nem isolado.
    Investigação em produção achou 767 conversas (de 886 no total) que nunca
    tinham recebido nenhuma resposta da empresa — praticamente certeza de
    ser só Status vazando — apagadas (com backup local antes) depois de
    confirmar com o usuário o escopo exato. Mais 29 conversas de grupo (482
    mensagens, já isoladas pela correção do item 14 mas ainda fisicamente no
    banco) também foram apagadas na mesma limpeza. Ao final, restaram só as
    conversas com relacionamento real de cliente (posteriormente, a pedido
    explícito do usuário, o banco de conversas/mensagens foi zerado por
    completo, ver HANDOFF.md).
16. **Post de Canal do WhatsApp (`@newsletter`) também virando mensagem de
    conversa** — terceiro tipo de conteúdo vazando pelo mesmo caminho de 14
    e 15 (ESPN Brasil, Netflix Brasil, etc., aba "Atualizações" do celular),
    com `remoteJid` terminado em `@newsletter`. Resolvido descartando por
    completo com `isJidNewsletter(remoteJid)` (utilitário do próprio
    `@whiskeysockets/baileys`), mesmo tratamento de grupo/Status. 3 registros
    que já tinham vazado antes do fix foram apagados (com backup local).
17. **Mensagem com falha de envio aparecia como "entregue"** — `tickIcon()`
    só tratava explicitamente `status === 'sent'` (check simples); qualquer
    outro valor, incluindo `'failed'`, caía no `else` e mostrava check duplo
    — visualmente indistinguível de uma mensagem realmente entregue. Corrigido
    tratando `'failed'` primeiro, com um ícone próprio (círculo vermelho com
    "!").
18. **Vazamento de conversas entre donos diferentes no dashboard** — `GET
    /api/whatsapp/metrics` chamava `computeMetrics()` sem nenhum filtro por
    dono; um comentário antigo no código dizia isso ser "intencional (visão
    de time)", mas na prática qualquer usuário autenticado via
    `Análise Conversas` (`/dashboard.html`) via as conversas, números de
    telefone e métricas de TODOS os donos cadastrados no banco, não só das
    próprias instâncias — reportado pelo usuário ao logar em outro
    computador e ver contatos que não eram dele. Resolvido em 3 camadas:
    `store.getAll(sessionIds)` agora exige a lista de sessões e filtra no
    SQL; `computeMetrics({ sessionIds })` exige esse parâmetro (retorna
    métricas zeradas se vier vazio, nunca agrega por omissão); `GET
    /metrics` busca `instancesStore.listByOwner(req.ownerId)` e passa só as
    instâncias do próprio dono autenticado. Testado com os `sessionIds` de 3
    donos diferentes direto contra o banco — cada um só recebeu os próprios
    totais (ver HANDOFF Parte AR).
19. **LP não acrescentava o código do país (`55`) ao telefone digitado** —
    `POST /:slug` (`src/routes/leads.js`) só fazia `replace(/\D/g, '')` no
    telefone do formulário público ("Telefone (com DDD)", sem código de
    país); o JID resultante (`_phoneToJid`, `src/whatsapp.js`) ficava
    incompleto e não correspondia a nenhuma conta real do WhatsApp — a
    mensagem de boas-vindas tinha certeza de nunca chegar, mesmo aparecendo
    "enviada". Corrigido prependendo `"55"` quando o telefone limpo tem
    até 11 dígitos (por tamanho — DDD `55`, do Rio Grande do Sul, é um DDD
    real, então checar se já "começa com 55" daria falso positivo). Mesma
    lacuna existe em `contacts.js`/`csvImport.js`/`routes/whatsapp.js`
    (nenhum ponto de entrada de telefone do app completa o código do
    país) — não corrigido nesses outros pontos ainda, ver HANDOFF Parte AY
    item 259.
20. **"✓✓ visualizado" nunca chegava, por um sufixo de dispositivo no JID** —
    `_jidToPhone(jid)` (`src/whatsapp.js`) só cortava a parte depois de `@`;
    o WhatsApp às vezes manda o JID de `messages.update` com um sufixo de
    dispositivo (`"5521965628397:0@s.whatsapp.net"`), que sobrevivia no
    telefone extraído e nunca batia com o telefone puro salvo em
    `conversations.phone` — `updateMessageStatus` não achava a linha,
    então o check duplo azul nunca aparecia, mesmo com a resolução de LID
    da §9 já funcionando (causa raiz diferente, mesmo sintoma). Corrigido
    cortando também o que vier depois de `:` (`split('@')[0].split(':')[0]`)
    — ver HANDOFF Parte BU.

---

## 20. Próximos passos sugeridos

- [x] ~~Rodar o servidor sob um supervisor (PM2, `nodemon` com auto-restart, ou
  serviço do Windows) pra reiniciar sozinho numa falha fatal~~ — resolvido:
  gateway rodando sob PM2 (`pm2 start src/server.js --name whatsapp-gateway`),
  com `pm2-windows-startup` registrado (chave `Run` do Windows, usuário
  atual) pra chamar `pm2 resurrect` a cada login e trazer o processo de
  volta sozinho depois de um reinício da máquina. Testado forçando a queda
  do processo direto pelo PID (fora do PM2) — reiniciou sozinho em poucos
  segundos, sessões de WhatsApp reconectando normalmente. **Limitação**:
  como é a chave `Run` por usuário (não um Serviço do Windows), só sobe
  depois que alguém faz login na conta — não antes disso, nem sem sessão
  nenhuma aberta.
- [ ] Domínio fixo (sair do ngrok grátis) para não precisar reconfigurar o app a cada
  reinício do túnel.
- [ ] Avaliar fixar o Baileys numa versão estável (hoje é release candidate `rc13`).
- [ ] `AUTH_FOLDER` persistente é uma pendência **condicional**, não um risco
  ativo hoje: não existe Dockerfile/container/host de disco efêmero neste
  projeto — o deploy real é um processo de longa duração sob PM2 (ver item
  acima), e `./auth_session` já sobrevive normalmente a reinícios nesse
  modelo. Só vira ação de verdade **se/quando** o gateway for containerizado
  — nesse momento, `AUTH_FOLDER` precisa apontar pra um volume montado.
- [ ] O `prompt()` nativo do navegador pra nomear um modelo de mensagem
  (`campaign.html`, botão "Salvar como modelo") ainda não foi trocado por
  modal — todos os `alert()`/`confirm()` das 8 páginas já foram (ver
  `window.confirmDialog`, §17).
- [ ] Mídia "pendente" de agendamentos (§13) fica órfã no bucket depois do
  disparo — o envio de verdade sobe uma cópia própria por destinatário, e o
  arquivo original (usado só entre agendar e disparar) nunca é apagado.
  Considerar uma limpeza periódica se o volume de agendamentos com mídia
  crescer muito.
- [ ] Contatos com telefone real cujo histórico já ficou misturado com
  mensagem de grupo compartilhado (de antes da correção do bug #14, §19) não
  foram limpos — o schema não guarda a origem de cada mensagem antiga
  (grupo ou direto), então separar isso com segurança exigiria revisão
  manual. Mensagens novas já não têm mais esse problema.
- [ ] Desde a correção dos bugs #14/#15 (§19), a funcionalidade de "criar
  grupo do WhatsApp direto do Chat" (`createGroup()`) ficou incompleta: dá
  pra criar o grupo e mandar mensagem nele, mas nenhuma resposta de quem
  está no grupo aparece em lugar nenhum do CRM (mensagem de grupo agora é
  sempre descartada, sem exceção). Se essa funcionalidade for usada de
  verdade no futuro e isso incomodar, precisa de um jeito de distinguir
  "grupo criado pela própria empresa" (deveria mostrar resposta) de
  "qualquer outro grupo que o número participa" (não deveria) — hoje o
  código trata todo grupo igual, de propósito, pela simplicidade.
- [ ] **Instabilidade de conexão na sessão `..._183168` ("Daniel") — não é
  específica das LPs** — em aberto desde 2026-07-13, reconfirmado em
  2026-07-16 com teste real (usuário checou o próprio celular de destino:
  a mensagem realmente não chegou, não é só o "✓✓" que não atualiza).
  Comparando no banco: das mensagens de boas-vindas de LP, 100% ficam
  presas em `status: 'sent'`; mas das mensagens em conversas normais
  (humanas, ida e volta) dessa mesma sessão, **91% também** ficam presas
  em `sent`, só 9% chegam a `delivered`/`read` — ou seja, não é um
  bloqueio de anti-spam mirado na mensagem automática, é a conexão dessa
  sessão específica entregando mal a confirmação (e a mensagem em si) na
  maior parte do tempo, provável ligação com quedas/reconexão frequentes
  (`statusCode` 408/428/503 no log). Não é bug de código — precisa de
  alguém com acesso físico ao celular pareado desse número (WhatsApp →
  Aparelhos conectados) e à rede da máquina que roda o gateway; ver
  HANDOFF Parte AY, itens 257-258, e o caveat em §11.5 sobre a taxa de
  "entrega" não medir entrega de verdade.
- [x] ~~Agente de IA (§14.7) — webhook `BITRIX_WEBHOOK_URL` (CRM) com
  credencial inválida~~ — resolvido, mas a causa real era outra: o
  webhook em si sempre esteve válido em produção; o card criado pelo
  teste real caiu na categoria **229** ("FUNIL DE TESTE") em vez de
  **628** porque `BITRIX_LEADS_CATEGORY_ID` só tinha sido trocada no
  `.env` **local** (Parte EJ) — `.env` nunca é versionado, então a
  troca nunca chegou no `.env` de produção (EasyPanel). Corrigido
  atualizando a variável direto no painel + reiniciando o processo;
  validado com um 2º teste real (negócio criado na 628 de verdade,
  sem "FUNIL DE TESTE"). Ver HANDOFF Parte EK.
- [x] ~~Agente de IA (§14.7) — `src/routes/leads.js` ainda cria o
  negócio no `POST /:slug`~~ — migrado: o negócio agora é criado
  quando o lead RESPONDE à boas-vindas (via `agentDispatch.js`, mesmo
  gatilho já usado por Campanha), não mais no envio do formulário.
  Roda **sempre**, com ou sem o Agente de IA ativo naquela instância —
  só a resposta automática da IA continua condicionada a
  `agentConfig.active` (achado importante durante a migração: sem essa
  separação, LP em instância sem IA teria parado de criar negócio).
  `bitrix_deal_id`/`bitrix_contact_id` continuam gravados na própria
  submissão do formulário, só que depois, no momento da resposta. Ver
  HANDOFF Parte EM.
- [ ] **Agente de IA (§14.7) — auditar outros pontos que aplicam tag
  fora de ação direta do usuário na tela** — a tag de origem aplicada
  pelo Agente de IA (background, sem UI aberta) ficava sem aparecer no
  Chat sem F5 até a Parte EK adicionar um broadcast dedicado
  (`type: 'tags-updated'`); não foi auditado se existe alguma outra
  rotina do sistema com a mesma lacuna (tag aplicada pelo servidor sem
  o usuário estar interagindo, logo sem o update otimista local que o
  botão manual de tag já tem). Ver HANDOFF Parte EK.
