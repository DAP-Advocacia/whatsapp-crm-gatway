# Roadmap — WhatsApp ↔ Bitrix24 Gateway

> Próximos passos, hipóteses ativas e tetos de escala conhecidos.
> Derivado de `HANDOFF.md` §5 (dívidas técnicas) e da Parte EW
> (2026-08-27, Copiloto Comercial) — não inventa item novo, só organiza
> o que já está registrado por prioridade. Ver `README.md` §20 para o
> histórico completo (itens já resolvidos ficam lá, riscados).

## 1. Features aprovadas, ainda não implementadas

Registradas explicitamente na sessão de 2026-08-27 (Parte EW), a pedido
do usuário, para entrar **depois** do Copiloto Comercial — nesta ordem
de prioridade:

### 1.1. Tela de Follow-ups

Criar/gerenciar lembretes de retorno a lead. Reusa o padrão
Kanban+Calendário já construído à mão em `notifications.html` (mesmo
componente de calendário custom do projeto). O botão "Virar follow-up"
já existe como stub desabilitado na bolha de insight do Copiloto
Comercial (`public/chat.html`, `.bubble-insight-actions`), esperando
esta tela existir para ligar.

- **Critério de validação**: um insight do Copiloto vira um follow-up
  agendado com uma data/hora real, aparece no Kanban/Calendário novo, e
  o atendente consegue marcá-lo como feito — sem depender de nenhuma
  infraestrutura nova (o padrão de UI já existe, é replicar).

### 1.2. Relatórios personalizados com entrega agendada

Entrega por e-mail, WhatsApp ou canal à escolha, a partir das 8 fontes
de métrica já calculadas no backend hoje. Reusa `pdfkit`/`exceljs`
(dependências já existentes no projeto, usadas em exports atuais).

- **Bloqueador conhecido**: **nenhuma lib de envio de e-mail existe no
  projeto hoje** — infraestrutura nova de verdade (SMTP ou serviço tipo
  Resend/SendGrid), não só reaproveitar código existente. Envio via
  WhatsApp não tem esse problema (`gateway.sendMessage` já existe).
- **Critério de validação**: um relatório configurado (métrica +
  frequência + canal) chega de fato ao destino escolhido, no formato
  certo (PDF/XLSX), sem intervenção manual a cada disparo.
- **Decisão em aberto para o Daniel**: qual serviço de e-mail usar (SMTP
  próprio vs. serviço pago tipo Resend/SendGrid) é um trade-off
  arquitetural real (dependência paga nova) — não decidir sozinho na
  implementação, trazer a escolha explicitamente antes de começar.

### 1.3. Tab "Agenda" no Chat

Vincular Bitrix Calendar e/ou Google Calendar, marcar reunião direto do
Chat (DapZap).

- **Bloqueador conhecido**: **Google exige OAuth novo — setup grande**
  (fluxo de consentimento, refresh token por usuário, escopos de
  Calendar). Bitrix Calendar é mais simples (mesmo padrão de webhook já
  usado no resto do projeto).
- **Critério de validação**: consegue criar um evento real num dos dois
  calendários, visível pelo dono, a partir de uma ação dentro do Chat.
- **Decisão em aberto para o Daniel**: se o escopo inicial cobre só
  Bitrix Calendar (menor esforço, já usa o padrão de webhook existente)
  ou já nasce com Google Calendar também (OAuth, esforço bem maior) —
  vale confirmar antes de estimar a sessão que vai implementar isso.

## 2. Infraestrutura para escala (Revisão de Prontidão)

Itens levantados numa revisão de prontidão para crescer além do piloto
atual — nenhum é bloqueante hoje, mas todos têm um teto de escala
conhecido em que passam a importar de verdade.

- **Escalonar a reconexão em massa de sessões no boot** (item 03) — o
  `SessionManager` reconecta todas as sessões salvas de uma vez só ao
  reiniciar o processo. Inofensivo com poucas dezenas; em **centenas de
  instâncias** vira um padrão de login simultâneo do mesmo IP que os
  sistemas antiabuso do WhatsApp associam a automação.
  - **Teto de escala conhecido**: hoje mitigado parcialmente por
    `SESSION_STAGGER_MS` (15s entre cada sessão no boot — testado com
    4s em 2026-08-03, e mesmo assim 5 de 11 sessões caíram no mesmo
    boot). Considerar `p-queue`/lotes explícitos antes de crescer muito
    além do piloto atual.
- **Fila de taxa nas chamadas ao Bitrix do dia a dia** (item 04) — o
  rate limit de ~2 req/s por webhook do Bitrix já é respeitado no
  disparo de campanhas (`CAMPAIGN_MIN_DELAY_MS`/`MAX_DELAY_MS`), mas
  **não** no fluxo normal (criar negócio, logar timeline, buscar
  contato).
  - **Teto de escala conhecido**: com muitos atendentes simultâneos
    gerando esses eventos ao mesmo tempo, o limite pode estourar
    silenciosamente (sem fila, sem retry — a chamada simplesmente
    falha). Baixo risco/escopo claro de resolver (adicionar fila de
    taxa reaproveitando o mesmo mecanismo já usado em campanhas) — não
    decisão arquitetural grande, mas ainda não priorizado.
- **Alerta automático de sessão caída** (item 05) — hoje uma instância
  desconectada só aparece como linha de log.
  - **Teto de escala conhecido**: com poucas instâncias dá pra notar de
    olho; em escala, não. Sugestão já registrada: PM2 Plus (o projeto já
    usa PM2 localmente/histórico) + UptimeRobot.
- **Backup das credenciais de sessão (`auth_session/`)** (item 06) —
  hoje só existe em disco local/volume da VPS.
  - **Teto de escala conhecido**: uma falha de disco forçaria todo mundo
    conectado naquele momento a reescanear o QR do zero. Sugestão já
    registrada: `rclone` sincronizando pro mesmo bucket do Supabase
    Storage já usado no projeto.
- **Fixar o Baileys numa versão estável** — hoje roda em release
  candidate `rc13`. O comportamento de campos como
  `remoteJidAlt`/`participantAlt` pode mudar entre RCs; revalidar o
  mapeamento de telefone sempre que a lib for atualizada.

## 3. Hipóteses ativas do Copiloto Comercial (2026-08-27) — critério de validação

O Copiloto Comercial (Parte EW) foi construído e passou por revisão de
design/segurança, mas **ainda não foi testado com WhatsApp real em
produção** — o DDL das 3 tabelas (`commercial_config`,
`conversation_insight_state`, `conversation_insights`) já está confirmado
existindo no banco real (`qqfzfudbeqgldodusoit`, projeto "Wpp CRM",
confirmado na sessão do Dapinho, 2026-08-27 — ver `HANDOFF.md` Parte FF),
só falta o teste de ponta a ponta com WhatsApp real.

- **Hipótese 1 — anti-flood de 60s é o intervalo certo**: evita gerar
  insight repetido a cada mensagem numa conversa corrida, sem deixar o
  atendente esperando demais por uma sugestão nova.
  - **Critério de validação**: observar em produção real se 60s deixa o
    Copiloto "devagar demais" (atendente já resolveu a dúvida sozinho
    antes do insight aparecer) ou "rápido demais" (insight repetido
    incomodando). Ajustar a constante se algum dos dois sinais aparecer.
- **Hipótese 2 — a cor azulada (`#78aadc`) é suficientemente distinta**
  do dourado (nota interna) e do verde/vermelho (métrica) para o
  atendente nunca confundir os três tipos de bolha no feed do Chat.
  - **Critério de validação**: nenhum relato de confusão visual depois
    de uso real; já confirmado como decisão correta pelo
    `design-system-checker-agent` na revisão estática, falta a
    confirmação de uso real.
- **Hipótese 3 — a lista fixa de 5 tópicos padrão cobre a maior parte
  dos insights reais** do setor comercial (venda de precatórios) sem
  precisar de tópico livre.
  - **Critério de validação**: taxa de insight descartado por "tópico
    fora da lista" (logado, não forçado num tópico ao acaso) — se for
    alta, a lista de tópicos padrão precisa crescer ou virar mais
    flexível.

## 3.5. Débito de UX pendente — tooltip nativo em Chat e Admin

Achado do `design-system-checker-agent` na construção do Dapinho
(2026-08-27): a regra global do Daniel ("tooltip/ícone informativo
sempre no MESMO componente visual do app, nunca `title` nativo") foi
corrigida só no item NOVO (badge de não-lidas do Dapinho,
`public/chat.html`) — os itens de conversa **pré-existentes** da mesma
lista continuam usando `title` nativo no badge equivalente
(`public/chat.html:3186`), nunca migrados porque o Chat nunca teve um
componente de tooltip customizado reaproveitável (diferente de outras
telas do projeto que já usam `.chart-tooltip`/`data-tooltip`). Não é
regressão desta sessão — é débito que já existia antes.

**Confirmado também em `public/admin.html`** (checker rodado de novo em
2026-08-28, na revisão do botão "Baixar CSV"): `title` nativo
pré-existente em várias linhas (601, 630, 657, 742, 1650, 1765, 2408) —
mesmo padrão de débito, mesma causa (nenhum tooltip customizado nesse
arquivo ainda).

**Propagado de novo em 2026-08-30** (checker rodado na feature de
"pendente manual"): o botão novo de toggle (`data-pending-toggle`,
`public/chat.html:3225`) copiou o `title` nativo dos dois botões vizinhos
pré-existentes (`data-mute-toggle`/`data-archive-toggle`, mesma linha de
ações) — confirma o padrão descrito acima: **enquanto o componente de
tooltip custom não existir**, todo botão novo na mesma família visual
vai continuar herdando `title` nativo por replicar o vizinho, não por
descuido pontual. Reforça que isso não vai se resolver sozinho "na
próxima vez que alguém tocar o arquivo" — precisa ser priorizado
deliberadamente.

**Componente criado em 2026-08-30** (checker apontou o mesmo padrão pela
4ª vez, agora no rosto de sentimento da navegação por abas): `.app-tooltip`
+ `bindAppTooltip()` em `public/chat.html` — 1 elemento reaproveitado no
DOM, delegado no `document` (`mouseenter`/`mouseleave`/`focus`/`blur` em
capture), posicionado via `getBoundingClientRect()` com clamp contra a
viewport, paleta do projeto (`--surface-2`/`--border`/`--text`, segue
tema claro/escuro automaticamente por já usar variáveis CSS), fecha
junto do ESC global. Qualquer elemento com `data-tooltip="texto"` ganha
o tooltip automaticamente — usado pela primeira vez no rosto de
sentimento (`.contact-sentiment-face`).

- **Critério de validação (ainda pendente)**: nenhum `title=` sobrando em
  `public/chat.html`/`public/admin.html` explicando algo pro usuário
  (crachá, ícone de ação, etc.) — todos usando `.app-tooltip`/
  `data-tooltip` em vez de `title` nativo. O componente já existe e
  funciona (1 uso real confirmado); falta migrar os `title=`
  PRÉ-EXISTENTES (badge de não-lidas dos itens de conversa, botões de
  ação `data-mute-toggle`/`data-archive-toggle`/`data-pending-toggle`
  citados acima, e tudo em `admin.html`) — nenhum deles foi tocado nesta
  sessão, só o elemento novo nasceu já correto.
- **Escopo**: baixo risco, ação mecânica (trocar N atributos `title` por
  `data-tooltip` em 2 arquivos, sem mudar comportamento) — componente já
  existe em `public/chat.html`; `public/admin.html` pode importar a
  mesma função/CSS (copiar, já que os arquivos não compartilham módulo
  JS) na hora de migrar.

## 3.6. Flash residual de cor padrão → cor pessoal — RESOLVIDO (2026-08-30)

Reportado de novo pelo usuário (2026-08-28, depois de novo em 2026-08-30
especificamente na página de Apresentação): "a tela dá uma piscada,
aparece a cor marrom padrão e depois muda para a cor selecionada no
config" / "quando eu vou para a página da apresentação do projeto ela
pisca a tela e aparece a cor marrom (cor padrão)". Já tinha havido 2
rodadas de correção documentadas (`68ca6de` "Elimina o flash residual...
(18 telas)" e o mecanismo de 2 caches separados `palette_`/
`personalPalette_` + parâmetro `skipVisual`) — mas nenhuma cobria
`public/apresentacao.html` até agora.

**Causa raiz encontrada**: `apresentacao.html` tinha uma cópia
**desatualizada** de `window.__applyPalette` — só 2 parâmetros (`b,
prefix`), sem o terceiro `skipVisual` que as outras 17 telas já tinham.
Sem esse parâmetro, o fetch de `/api/brand` (paleta GLOBAL) sempre
reaplicava visualmente a cor por cima da paleta PESSOAL já aplicada do
cache — exatamente o "pisca" reportado. Provavelmente porque
`apresentacao.html` foi criada/copiada ANTES do commit `68ca6de` corrigir
as outras telas, e nunca recebeu essa atualização retroativamente.

**Fix**: `skipVisual` implementado igual às outras 17 telas (`if
(!skipVisual)` em cada `setProperty`/`removeProperty`), e o fetch de
`/api/brand` passa `hasPersonalPalette =
!!localStorage.getItem('personalPalette_gold')` como terceiro argumento.

**Auditoria de todas as 23 páginas de `public/`** (rodada na mesma
sessão, pra confirmar que não sobrava mais nenhuma): 18 com o mecanismo
completo e correto (incluindo `apresentacao.html` já corrigida), 0
quebradas, 5 sem o mecanismo por design (páginas públicas sem sessão de
usuário ou sem consumir `/api/brand` visualmente — `index.html`,
`settings.html`, `lead-form.html`, `bridge.html`,
`satisfaction-form.html`). **Critério de validação cumprido**: nenhuma
página com esse bug restando.

## 4. Teto de escala já documentado em outras áreas do projeto

Consolidado do HANDOFF §5, para não perder de vista junto do resto do
roadmap:

- **`GET /contacts/groups`** — uma chamada ao WhatsApp por grupo da
  instância, sem paginação nem cache. Reavaliar se alguma instância
  crescer para muitas dezenas/centenas de grupos.
- **`GET /notifications`** — não paginado, limit 500 fixo. Reavaliar se
  o histórico de algum usuário crescer muito.
- **Badge de não lidas fora do Chat** — só atualiza no carregamento da
  página (sem WebSocket próprio). Considerar inscrição de WebSocket por
  dono (não por sessão) se isso incomodar na prática em uso contínuo.
- **Mídia "pendente" de agendamentos** fica órfã no Storage depois do
  disparo (o disparo real sobe cópia própria). Considerar limpeza
  periódica se o volume crescer.
