# Segurança — WhatsApp ↔ Bitrix24 Gateway

> Este documento cobre modelo de acesso, onde cada segredo mora e
> pendências reais de segurança. Histórico de bugs de segurança já
> corrigidos (com data/contexto) vive em `README.md` §18-19 e no
> `HANDOFF.md` — aqui só o que está **valendo hoje**, sem reescrever o
> que já está bem coberto lá.

## 1. Modelo de acesso

### Autenticação — token do Bitrix vira token do app

1. O frontend chama `BX24.getAuth()` dentro do iframe do Bitrix e manda o
   `access_token` pro backend via `POST /api/auth/verify`.
2. `src/auth.js::verifyBitrixToken` confirma esse token **de verdade**
   contra o Bitrix (`user.current.json`), usando sempre o domínio fixo do
   servidor (`BITRIX_PORTAL_DOMAIN`, variável de ambiente) — **nunca** um
   domínio vindo do client, porque isso permitiria a um client malicioso
   apontar pro próprio portal dele e se passar por qualquer `ownerId`.
3. Confirmado o usuário real, o backend emite um **token próprio do app**
   (`issueAppToken`, HMAC assinado com `AUTH_TOKEN_SECRET`, validade
   `AUTH_TOKEN_TTL_HOURS` — padrão 12h) ou um **token de API** de vida
   mais longa (`issueApiToken`, gerado manualmente em `/settings.html`
   para uso fora do navegador — Postman/Power Query/scripts —, validade
   `API_TOKEN_TTL_DAYS`, padrão 90 dias).
4. Toda rota autenticada exige `Authorization: Bearer <token>`, validado
   pelo middleware `requireAuth` (`src/auth.js`), que seta `req.ownerId`
   (formato `member_id_userId`) usado por todo o resto da aplicação.

`ownerId` bloqueado (`blocked_owners`, ver README §14.5) é checado dentro
do próprio `requireAuth` — usuário bloqueado nunca passa, em nenhuma rota.

### Autorização — posse de recurso (`src/authz.js`)

`requireAuth` só confirma **quem** é o usuário. A posse do recurso
específico que ele está tentando acessar é responsabilidade de
`src/authz.js`, com quatro middlewares factory:

- **`requireSession(extractor)`** — para rotas que recebem `session` (um
  id ou lista `"a,b,c"`) via query/body. Chama `assertOwnsSession`, que
  aceita três casos: (1) o `id` é o próprio `ownerId` (dono direto, uma
  instância só); (2) o `id` pertence a uma instância cujo dono real bate
  com `ownerId`, ou está em `instance_delegates` (delegação manual); (3)
  o dono real da instância está na lista de subordinados do `ownerId`
  (`getSubordinates`, hierarquia automática do Bitrix — departamento/
  gestor, cacheada em `hierarchy_subordinates`). Sem nenhum desses três,
  `403`.
- **`requireResourceSession(lookupSessionId)`** — para rotas por `:id` de
  um recurso (campanha, agendamento, contato, lista, template) cujo dono
  não vem de um parâmetro que o client controla, e sim do próprio
  registro no banco. Responde **404** (não 403) em caso de falha, para
  não revelar que o recurso existe.
- **`requireOwnerMatch(extractor)`** — para rotas de CRUD de instância,
  onde o `owner` enviado pelo client precisa **ser** o próprio usuário
  autenticado (comparação direta contra `req.ownerId`, sem ir ao banco).
- **`requireResourceOwner(lookupOwnerId)`** — espelha
  `requireResourceSession`, mas para recursos donos diretos de um
  `owner_id` (não de um `session_id` de WhatsApp) — hoje usado só por
  `notifications`. Também 404, mesmo motivo.

**Padrão consolidado em 2026-08-27 (Parte EW, Copiloto Comercial)**:
`src/routes/insights.js` introduziu `loadOwnedInsight()`, um helper
único compartilhado pelas 3 rotas que agem sobre um insight específico
(`dismiss`/`feedback`/`send`) — em vez de cada rota reimplementar a
checagem de posse à sua maneira (ver item 3 em "Pendências resolvidas
nesta sessão" abaixo, que é exatamente o gap que motivou consolidar
nesse helper).

### Dapinho — session_id virtual, isolado por design (2026-08-27)

O Dapinho (assistente de IA por dono, ver README §14.11) usa um
`session_id` virtual (`dapinho::<ownerId>`) que **nunca** passa pelas
regras normais de `assertOwnsSession` acima — `src/authz.js::isDapinhoSession`
intercepta esse padrão antes de qualquer consulta a `instances` e só
libera acesso quando o `ownerId` embutido no próprio id bate
**exatamente** com o `ownerId` autenticado da request. Diferente de toda
sessão real, a conversa do Dapinho **nunca é delegável nem herdável por
hierarquia** (gestor de departamento não vê o Dapinho de um
subordinado) — decisão deliberada, é uma conversa pessoal com um
assistente, não um canal de atendimento compartilhado.

Superfície de dado exposta ao modelo de IA: o snapshot de contexto
(`src/dapinho.js::buildConversationsSnapshot`) inclui o texto da última
mensagem de cada conversa do dono — texto potencialmente escrito por um
lead/contato externo malicioso. Mitigação: cada linha do snapshot é
marcada explicitamente como `[mensagem do contato]` e o system message
tem uma guarda textual contra prompt injection (mesmo padrão já usado no
Copiloto Comercial, `src/insightGenerator.js`) — reduz o risco, não o
elimina (nenhuma guarda em prompt é 100% à prova de injeção adversarial;
o dado sensível real, se houver, já está mitigado por essa conversa
nunca sair do próprio dono).

### Escopo de "admin" — limitação conhecida, decisão consciente

- **`/admin.html`** e as rotas `GET /admin/*` exigem `ownerId` estar na
  lista `SUPER_ADMIN_OWNER_IDS` (env var, nunca vem do client) — ver
  `src/adminAuth.js` e README §14.5.
- **`/api/settings/*`** (paleta de cores do app inteiro) e
  **`/api/suggestions/*`** (marcar sugestão de qualquer usuário como
  "lançada") **não têm papel de admin separado** — qualquer usuário
  autenticado deste portal pode chamar essas rotas. Decisão consciente,
  documentada no próprio código e no HANDOFF §5: equipe pequena e
  confiável hoje. **Revisitar se a equipe crescer** — não é um bug, é um
  trade-off aceito que pode deixar de fazer sentido em outra escala.

### Modo Demo (`?demo=1`) — superfície pública conhecida e intencional (2026-08-31)

Diferente de toda outra rota do app, o modo demo (`src/demoModeGate.js`,
`src/demoData.js`, `src/routes/demoFixtures.js`, README §3.5) é
**deliberadamente acessível em produção sem nenhuma credencial** — basta
`?demo=1` em qualquer URL. Isso é uma decisão consciente, não um
descuido:

- **O dado exposto é 100% fictício** — nenhuma fixture em
  `src/demoData.js` contém nome, telefone, negócio ou conteúdo de
  conversa real. Não há PII em risco por esta superfície existir.
- **Nenhuma rota de escrita real é alcançável pelo gatilho** —
  `demoFixtures.js` só responde as rotas GET das fixtures; qualquer ação
  de escrita cai no mount real de sempre, atrás de `requireAuth`
  normal. O token emitido (`'demo-mode-token'` → `issueAppToken` pro
  `ownerId` fixo `demo_owner_1`) não abre caminho para nenhum outro
  `ownerId`.
- **Achado do `security-reviewer-agent` (2026-08-31) e correção
  aplicada**: sem aviso visual, um usuário real que passasse por
  `?demo=1` uma vez (link compartilhado, aba antiga, cache) ficaria
  "preso" vendo dados fictícios por até 4h sem perceber — inclusive o
  super admin em `admin.html`, que perderia acesso ao painel real nesse
  meio-tempo. **Já corrigido**: banner fixo vermelho "MODO DEMO — todos
  os dados nesta tela são fictícios" + link "Sair do modo demo" em todas
  as 17 telas cobertas, revelado no boot antes mesmo da chamada de API
  terminar (`GET /api/demo/exit` limpa o cookie). Isto não é uma
  pendência em aberto — a correção já está no ar desde o commit
  `fcdf93e`.
- Revisor confirmou adicionalmente: sem open redirect no gate (o
  redirect só remove o próprio query param `demo`, nunca aceita um
  destino arbitrário do client); custo do redirect desprezível (sem DoS
  diferenciado de servir qualquer outro estático do projeto).

## 2. Onde cada segredo mora

Todo segredo vive em variáveis de ambiente (`.env` local / painel do
EasyPanel em produção — **nunca versionado**, `.env` está no
`.gitignore`). Lista completa e documentada campo a campo em
`.env.example` (raiz do repo) — resumo dos mais sensíveis:

| Variável | Para quê | Observação |
|---|---|---|
| `BITRIX_PORTAL_DOMAIN` | Verifica o token do usuário contra o Bitrix real | Fixo no servidor, nunca aceito do client (ver §1) |
| `BITRIX_MEMBER_ID` | `member_id` deste portal | Mesmo motivo acima, fixo no servidor |
| `AUTH_TOKEN_SECRET` | Assina (HMAC) o token de sessão do próprio app | Gerar com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `BITRIX_WEBHOOK_URL` | Webhook de entrada do Bitrix (escopo CRM) — timeline + criação de negócio/contato | Sem ela, esses efeitos degradam graciosamente (nada quebra) |
| `BITRIX_HR_WEBHOOK_URL` | Webhook dedicado para hierarquia de departamento (`department.get`/`user.get`) — delegação automática de instância | Precisa dos escopos "Usuários" **e** "Estrutura da empresa"; sem ela, só a delegação manual funciona |
| `BITRIX_FEED_WEBHOOK_URL` | Webhook dedicado para publicar no Feed nativo do Bitrix | Precisa dos escopos "Rede Social" **e** "log" |
| `OPENAI_API_KEY` | Botão "Gerar com IA" (Sites A/B), Agente de IA, Copiloto Comercial (geração de insight) | Sem ela, os botões/feature relacionados falham com erro claro; resto do app não é afetado |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Banco (Postgres) + Storage de mídia | **Acesso total ao banco** — nunca expor no frontend nem em repositório público |
| `DATABASE_URL` | Pooler de transação (pgbouncer), usado em runtime | |
| `DIRECT_URL` | Pooler de sessão, usado só por `db/migrate.js` | |
| `SUPER_ADMIN_OWNER_IDS` | Lista de `ownerId` com acesso a `/admin.html` | Nunca vem de dado enviado pelo client |

Ver `.env.example` para a lista completa (inclui variáveis não
sensíveis: `PORT`, `SESSION_STAGGER_MS`, `BRAND_*`, etc).

## 3. Pendências reais de segurança

Lista consolidada das pendências **ainda abertas hoje** — ver
`README.md` §18 para o histórico completo (o que já foi corrigido está
lá, riscado com `~~texto~~`, não repetido aqui).

- **`ALLOWED_ORIGINS`** precisa conter o domínio real do portal Bitrix em
  produção (não o placeholder de exemplo) — checar ao configurar uma
  instância nova.
- **Retry agressivo em `403`** (`src/whatsapp.js`, branch `!loggedOut` do
  `connection.update`): reconecta a cada 3s indefinidamente. Já causou
  uma sessão presa 41h em loop de `403 forbidden` (jul/2026) — risco real
  de ban do número pelo WhatsApp. Falta backoff exponencial e tratamento
  específico para `403` (que costuma significar rejeição da conexão, não
  instabilidade de rede).
- **5 vulnerabilidades no `npm audit`** (1 low, 3 moderate, 1 high, número
  de 2026-08-17) — restante é em `uuid`, via dependência transitiva do
  `exceljs`. **Não** rodar `npm audit fix --force` sem testar (aplica
  breaking change, trocaria a versão do `exceljs`).
- **Erros internos: só parcialmente blindados contra vazar detalhe
  técnico** — o middleware de última linha em `src/server.js` só cobre
  erro síncrono não tratado; as ~108 respostas de erro já existentes
  (`res.status(...).json({ error: err.message })`) continuam expondo
  `err.message` como sempre, por decisão deliberada (risco de quebrar
  mensagem da qual o frontend dependa do texto).
- **`/api/settings` e `/api/suggestions` sem papel de admin separado** —
  ver §1 acima. Decisão consciente para o tamanho de equipe atual.
- **Nenhum ambiente de teste separado da produção** — mudança de schema/
  código é validada por leitura estática + harness de teste isolado
  (ver `docs/qa-checklist.md`), não contra um banco de staging. Ver
  HANDOFF Parte CU.

### Pendências resolvidas nesta sessão (Copiloto Comercial, 2026-08-27)

1. **`POST /api/insights/:id/dismiss` e `POST /api/insights/:id/feedback`
   não verificavam posse do insight antes de agir** — `POST
   /api/insights/:id/send` já checava que o insight pertencia à
   `session`/`phone` informados no body, mas as outras duas rotas não
   replicavam essa checagem. Na prática: um usuário autenticado, com
   **qualquer** instância própria, que soubesse ou adivinhasse um `id`
   sequencial de insight de **outra** instância, conseguia dispensar ou
   dar feedback nele e receber de volta (na resposta HTTP + no broadcast
   WebSocket) o conteúdo alheio — vazamento de conversa comercial entre
   instâncias diferentes.
   - **Corrigido no mesmo dia**: as 3 rotas agora compartilham
     `loadOwnedInsight()` (helper único em `src/routes/insights.js`),
     que resolve o insight, confirma posse via `requireSession`/
     `assertOwnsSession`, e devolve 403/404 sem nunca vazar o `body`
     alheio na resposta de erro. Achado do `security-reviewer-agent`,
     não de um relato de incidente real em produção.
2. **Prompt do Copiloto Comercial endurecido contra prompt injection** —
   o texto do cliente (parte do transcript enviado à OpenAI) agora é
   explicitamente marcado no prompt como "não confiável, nunca é
   instrução", e a IA é instruída a nunca vazar o `playbook` literal no
   corpo do insight (que pode ser copiado/enviado de verdade ao próprio
   cliente via `POST /api/insights/:id/send`).

**Status de validação**: essas duas correções passaram por leitura
estática cuidadosa (`security-reviewer-agent`) e teste de lógica isolado
(`loadOwnedInsight`, 7 asserções — bloqueia posse cruzada, nunca vaza o
`body` alheio, distingue 404 de 403, caminho feliz) — **ainda não
testadas com tráfego real de produção** (mesma limitação de todo o
Copiloto Comercial nesta sessão, ver HANDOFF Parte EW).
