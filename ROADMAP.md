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

**Escopo confirmado bem maior em 2026-08-31** (checker rodado no redesign
do Dashboard): 4 `title=` na sidebar de `public/dashboard.html` (botão de
recolher, 2 carets de submenu, botão de notificações do sistema) — e o
checker confirmou o **mesmo texto/atributo idêntico em 18 das ~23
páginas do projeto**, `chat.html` incluído (a própria referência do
padrão de tooltip customizado). Ou seja: o componente `.app-tooltip`
existe desde 2026-08-30 mas nunca foi aplicado nos controles de sidebar
de NENHUMA tela — só em usos pontuais de conteúdo (badge de sentimento,
agora `.agent-name` do Dashboard). Corrigir só numa tela (ex: só o
Dashboard, por ter sido a que foi tocada agora) criaria inconsistência
com as outras 17 telas que mantêm o padrão antigo — decisão explícita de
NÃO fazer isso pontual, mesma lição já registrada acima sobre o Dapinho.

- **Critério de validação atualizado**: os 4 controles de sidebar
  (`title="Recolher/expandir menu"`, os 2 carets de submenu, `title="Ativar
  notificações do sistema"`) usando `data-tooltip` em vez de `title`
  nativo, replicado nas ~23 telas de uma vez — não tela por tela.
- **Escopo revisado**: como o texto do `title` é IDÊNTICO nas 23 telas
  (mesmo boilerplate de sidebar copiado em todas), a migração é um
  patch mecânico único aplicável a todas de uma vez (mesmo padrão de
  script usado nesta sessão pra corrigir o modal "Atalhos e recursos"
  em 17 telas) — não precisa de 23 decisões manuais separadas.

## 3.7. Débito de acessibilidade — `prefers-reduced-motion` ausente

Observação do `design-system-checker-agent` (2026-08-30, revisão da
animação de ícone das abas do painel de detalhes): `public/chat.html`
não tem NENHUM `@media (prefers-reduced-motion: reduce)` no arquivo
inteiro, apesar de já ter várias transições/animações (indicador
deslizante das abas, fade+slide de troca de aba, escala de ícone ativo,
hover de foto, etc.). Não é regressão de uma sessão específica — é uma
característica sistêmica da base de código desde antes de qualquer uma
dessas features existir.

- **Critério de validação**: toda animação/transição não-essencial
  (decorativa, não ligada a dar feedback de uma ação crítica) respeita
  `prefers-reduced-motion: reduce` — reduzida a algo instantâneo ou bem
  mais sutil pra quem ativou essa preferência do sistema operacional.
- **Escopo**: baixo risco, mas espalhado (não é 1 componente, é uma
  convenção a aplicar em CADA `transition`/`animation` do CSS) — cabe
  resolver como uma varredura dedicada, não pontualmente a cada feature
  nova que adicionar mais uma animação. Não é bloqueio pra nenhuma
  feature nova continuar usando transição/animação normalmente.

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

## 5. Incidente — sessões nunca pareadas sobrecarregando o boot (2026-09-28)

**RESOLVIDO** (correção em produção, commit `85226da` em `src/sessions.js`,
2026-09-28). Registrado aqui porque é exatamente o risco já antecipado
no item 2 acima ("Escalonar a reconexão em massa de sessões no boot"),
só que materializado em escala muito maior que a esperada.

**O que aconteceu**: depois do deploy do redesign visual (Fase 0-3, ver
`docs/design-system.md`), o usuário reportou pico de CPU no EasyPanel e,
logo em seguida, um WhatsApp novo não conseguia completar o pareamento
(QR escaneado, celular confirmava, mas a tela ficava presa em
"Status: connecting" e nunca fechava). Investigação encontrou **566
pastas** em `auth_session/` no servidor de produção — cruzado com a
tabela `instances` no banco, a esmagadora maioria são instâncias
"Principal" criadas automaticamente ao longo de meses (a tela de
Conexões cria uma na primeira visita de cada usuário do Bitrix) mas
**nunca pareadas de verdade** (ninguém escaneou o QR). `startAllExisting()`
tentava reconectar TODA pasta com `creds.json`, sem distinguir isso de
uma sessão real — cada boot virava centenas de tentativas de conexão
simultâneas/escalonadas ao WhatsApp, sobrecarregando CPU/rede e
(hipótese mais provável) levando o WhatsApp a atrasar/recusar conexões
vindas do mesmo IP, incluindo pareamentos novos legítimos.

**Correção aplicada**: filtro por `creds.registered` (campo nativo do
Baileys, só vira `true` depois que o QR é escaneado com sucesso — ver
`initAuthCreds` em `node_modules/@whiskeysockets/baileys/lib/Utils/auth-utils.js`).
Sessões nunca pareadas (ou com `creds.json` corrompido) deixam de
entrar na lista de reconexão do boot.

**Pendente, não crítico**: a limpeza física das ~566 pastas órfãs já
acumuladas em disco não foi feita — a correção só impede que o
problema volte a crescer daqui pra frente. Fazer essa limpeza é uma
ação manual separada (mexe direto em dado de produção em disco),
avaliar quando houver tempo dedicado a isso, cruzando de novo pasta
por pasta contra a tabela `instances` antes de apagar qualquer coisa.

## 6. Redesign visual — pendências reportadas em uso real (2026-09-29)

Lista de ajustes reportados pelo usuário depois de usar a versão nova
em produção por um dia. Nenhum implementado ainda nesta entrada —
registrado primeiro para não perder o contexto, execução entra em
commits separados por item.

1. **Mini-chat dentro do card do Bitrix — RESOLVIDO (2026-09-29)**.
   `public/index.html` recebeu a mesma paleta verde-petróleo + cinza-
   chumbo neutro já validada em `chat.html` (tema claro como padrão,
   wallpaper do feed de mensagens, redução de uso de verde — mantido só
   em ação primária/item selecionado/indicador de estado). Essa página
   não tem sidebar (é só o card embutido), então não precisou do corte
   de menu nem da troca de logo.
2. **Conversas demoram a aparecer no Chat — RESOLVIDO (2026-09-29)**.
   Causa raiz encontrada em `store.listConversations` (`src/store.js`):
   a query monta a lista de conversas (até 200) com uma subquery LATERAL
   por linha que conta notificações não lidas, filtrando por
   `target->>'sessionId'`/`target->>'phone'` (campos dentro de uma
   coluna `jsonb`) — **sem nenhum índice** pra esse acesso. Isso forçava
   um table scan completo da tabela `notifications` inteira, uma vez
   PARA CADA conversa retornada — o custo cresce tanto com o número de
   conversas quanto com o histórico de notificações acumulado (o print
   do usuário mostrava 155+11 notificações só numa conta). Bug
   pré-existente, não regressão do redesign. Corrigido com um índice de
   expressão parcial (`idx_notifications_unread_target`, `db/schema.sql`)
   casando exatamente o filtro da subquery — aplicado em produção via
   `node db/migrate.js` (operação aditiva seguro, `create index if not
   exists`, não mexe em nenhum dado existente).
3. **Item "Como usar (vídeo)" na sidebar — RESOLVIDO (2026-09-29)**.
   Removido o botão `tutorialVideoReopenBtn`, a função
   `bindTutorialVideoModal()` e o modal `tutorialVideoModal` (CSS + HTML)
   das 17 páginas que tinham (confirmado hash idêntico nas 13 páginas
   fora do menu enxuto, processadas em lote com um script Node — mesmo
   texto/estrutura byte-a-byte nas 13). Nas 4 páginas do menu enxuto
   (`chat`, `contacts`, `dashboard`, `instances`) e na própria
   `how-to.html`, o botão vira/já era um link para `/how-to.html`
   ("Como usar?"), mantendo a mesma posição visual na sidebar. Nas
   outras 13 páginas antigas (fora do escopo do redesign), o item foi
   só removido, sem substituto (não fazia sentido linkar pra uma sidebar
   que ainda não tem a estrutura nova). Vídeo em si
   (`public/video/video-onboarding.mp4`) não foi apagado do disco, só
   parou de ser referenciado — pode ser removido numa limpeza futura se
   não for mais usado em lugar nenhum.

   **Bug de inconsistência corrigido (2026-09-29, mesmo dia)**: ao criar
   `how-to.html`, o link "Como usar?" foi colocado na seção
   "Configuração" (junto de "Conexões do WhatsApp"), marcado `active`
   ali — diferente das outras páginas, onde o link fica na posição fixa
   de baixo (junto de "Atalhos e recursos"/"Notificações"). Usuário
   reportou com 2 prints: o item "salta" de lugar entre `chat.html`
   (embaixo) e `how-to.html` (lá em cima, sumindo da posição de baixo),
   o que também contribuía pra sensação de altura/estrutura inconsistente
   entre abas. Corrigido: `how-to.html` agora só tem "Conexões do
   WhatsApp" na seção Configuração (igual todas as outras) e o link
   "Como usar?" na MESMA posição fixa de baixo, marcado `active` só
   nesta página — mesmo padrão que "Notificações" já usa (o ícone/link
   fixo vira `active` na própria página de destino, sem mudar de lugar).
4. **Aba Notificações (`public/notifications.html`) não foi migrada** —
   confirmado visual antigo completo (dourado, sidebar antiga com todos
   os itens). Ficou fora do escopo das Fases 0-3 (só as 4 páginas do
   menu novo foram tratadas) — mas como o sino de notificação é acessível
   de qualquer tela do app novo, o contraste de visual é muito visível.
5. **App abre direto em "Análises" em vez de "Chat" — RESOLVIDO (2026-09-29)**.
   Causa: `public/index.html`, tratamento do erro `NO_PLACEMENT` (app
   aberto pelo ícone na sidebar do Bitrix, fora de um card de Negócio)
   redirecionava explicitamente para `/dashboard.html` — decisão de
   produto anterior ("único ponto de entrada sem card específico, é
   onde a Análise de Conversas mora"). Trocado para `/chat.html`, mesmo
   raciocínio que já motivou reordenar Chat/Contatos antes de Análises
   no menu lateral (Fase 3).
6. **Painel de detalhes do contato — JÁ RESOLVIDO, feature já existia
   (2026-09-29)**. O botão de ícone "ⓘ" no cabeçalho da conversa
   (`#toggleDetailsBtn`, `public/chat.html`) já mostra/esconde o painel
   por completo — confirmado com o usuário que essa funcionalidade
   atende, sem precisar de um modo "mini" intermediário (como o colapso
   da sidebar principal). Nenhuma mudança de código necessária.
7. **Scroll para cima na conversa não funciona — RESOLVIDO (2026-09-29)**.
   Causa raiz: bug PRÉ-EXISTENTE (confirmado no commit `a24476c`, antes
   de qualquer trabalho do redesign) — `.messages{ justify-content:
   flex-end }` combinado com `overflow-y: auto` é uma combinação
   historicamente problemática do flexbox: o Chromium não recalcula
   `scrollHeight` corretamente quando o conteúdo excede a área visível,
   então `scrollHeight` ficava igual a `clientHeight` mesmo com
   centenas de mensagens — nenhum scroll possível. Invisível em
   qualquer teste com poucas mensagens (não há overflow real pra
   expor o bug), por isso nunca foi percebido antes. Confirmado com
   teste isolado via Playwright (200 bubble-rows de teste,
   `scrollHeight`/`clientHeight` idênticos com `flex-end`, valor real
   restaurado e scroll funcional trocando para `margin-top: auto` no
   primeiro filho). Corrige mantendo o mesmo efeito visual (mensagens
   ancoradas embaixo quando a conversa tem poucas) sem quebrar o
   cálculo de overflow do container — `.messages > :first-child{
   margin-top: auto }` em vez de `justify-content` no pai.

## 7. Altura de página inconsistente entre abas — RESOLVIDO (2026-09-29)

Usuário reportou: a altura da página varia dependendo da aba clicada —
ficou muito perceptível em `how-to.html` (bastante conteúdo, ficava bem
mais alta que o resto) mas existia em todas as páginas de conteúdo
(`dashboard`, `contacts`, `instances`, `notifications`, e as 12 páginas
"antigas" fora do menu enxuto). Causa: `html, body{ min-height: 100% }`
sem `overflow` travado — cada página crescia conforme o próprio
conteúdo, e o `<body>` inteiro rolava. Diferente de `chat.html` (já
usava altura fixa de viewport com painéis internos rolando).

Corrige travando `html, body{ height: 100%; overflow: hidden }` (nunca
mais o documento rola) e `#app{ height: 100vh; overflow-y: auto;
box-sizing: border-box }` (a área de conteúdo é quem rola por dentro,
sempre do tamanho exato da tela) — preservando o `max-width`/
`margin-left`/`padding` específico de cada página (variam entre 720px
e 1180px conforme o layout). Aplicado nas 17 páginas com o padrão
antigo (`dashboard`, `contacts`, `instances`, `notifications`, `admin`,
`agent-examples`, `agente-ia`, `campaign`, `campaign-metrics`,
`campaign-schedule`, `conversation-analysis`, `faq`, `lead-metrics`,
`onboarding`, `settings`, `sites`, `suggestions`) — `chat.html`,
`how-to.html` e `index.html` já usavam (ou já foram corrigidas para
usar) esse padrão de altura fixa antes.

Validação: teste via Playwright em 6 páginas representativas —
`html.scrollHeight === html.clientHeight` (documento nunca rola) em
todas, `#app` rola internamente só quando o conteúdo excede a tela
(confirmado tanto o caso "rola" quanto "não precisa rolar"). Sintaxe OK
e HTTP 200 nas 24 páginas do projeto.

## 8. Mini-chat do card do Bitrix — área vazia à direita (2026-09-29)

Usuário reportou (print real, dentro de um card de Negócio): uma faixa
vertical clara e uma área preta totalmente vazia no canto direito da
tela do mini-chat (`public/index.html`), como se o conteúdo não
preenchesse a largura real do iframe do placement. Confirmado com o
usuário que **já existia antes do redesign** (não é regressão desta
sessão).

Causa provável (tentativa 1): `#app`/`html`/`body` não tinham
`width: 100%` explícito — em determinadas larguras de iframe do
Bitrix, o `display:flex` sem width podia não esticar para a largura
real disponível. Corrigido adicionando `width: 100%` explícito em
`html`, `body` e `#app` (commit `18e2fc7`).

**Atualização (mesmo dia, novo print pós-deploy)**: usuário confirmou
que o corte persiste, idêntico, mesmo com o `width:100%` em produção.
Isso descarta a hipótese de CSS interno. Conclusão revisada: a área
vazia não está dentro do nosso `<iframe>` — é espaço reservado pelo
próprio Bitrix ao redor da aba `CRM_DEAL_DETAIL_TAB`/
`CRM_CONTACT_DETAIL_TAB` (o layout padrão de card do Bitrix reserva
uma coluna à direita para o painel de atividades/timeline nativo,
fora do controle do app hospedado). `BX24.fitWindow()` (já chamado)
só ajusta ALTURA do iframe — não existe, no SDK do Bitrix, um
equivalente para pedir largura total da aba; isso é decidido pelo
layout do card no portal, não pelo app.

**Correção real encontrada (mesmo dia, terceira tentativa)**: usuário
esclareceu que a área vazia tem a cor do próprio app (não preto do
Bitrix) e é parecida com o drawer de notas internas — pista certa.
Causa raiz confirmada: `.notes-drawer{ display:flex; ... }` no CSS
tem a mesma especificidade que a regra padrão do navegador
`[hidden]{ display:none }`, e por vir depois na cascata, VENCE —
então o `<div class="notes-drawer" id="notesDrawer" hidden>` fica
sempre renderizado (`position:fixed; right:0; width:100%;
max-width:360px; background:var(--bg)`), mesmo com `hidden=true`
setado via JS (`openNotesDrawer()`/`closeNotesDrawer()`, que só
mexem na propriedade `.hidden`, nunca em classe). É exatamente a
"parede" sólida cobrindo a lateral direita do mini-chat — o painel de
nota interna (funcionalidade real do chat, não lixo) que nunca deveria
aparecer fora de quando o usuário clica no botão de nota, mas ficava
sempre visível e vazio.

Mesma classe de bug já historicamente corrigida em `chat.html` (ver
`.composer[hidden]`, `.export-menu[hidden]`, `.reply-preview-bar[hidden]`
— comentário lá já alertava "correção já feita... só faltou" em outros
seletores). Passou despercebido em `index.html` quando o drawer de
notas foi replicado ali.

Corrigido adicionando `.notes-drawer[hidden]{ display: none; }` logo
abaixo da regra `.notes-drawer{...}` (maior especificidade, sempre
vence). Validado: HTML de teste com `hidden=true` confirma
`getComputedStyle(...).display === 'none'`. Sintaxe OK, HTTP 200.

A hipótese de "limitação do Bitrix" (parágrafo anterior) estava
**errada** — mantida acima só como registro do processo de
investigação; não se aplica mais.

## 9. Crédito "Desenvolvido por Gabriel Alves" — abrir usuário do Bitrix na lateral (2026-09-29)

Pedido do usuário: a badge de crédito fixa (rodapé de todas as 21
páginas com sidebar/mini-chat) linkava para o LinkedIn pessoal, abrindo
em nova guia (`target="_blank"`). Trocar para abrir o usuário 5305
(perfil no próprio Bitrix) num slider/lateral, sem sair do CRM.

Corrigido: `<a class="credit-badge" href="...linkedin..." target="_blank">`
virou `<button type="button" class="credit-badge" id="creditBadgeBtn">`
(ou `<span id="creditBadgeBtn">` em `apresentacao.html`, que já tem um
link de contato separado — "Falar com o responsável técnico" — mantido
como está, fora do escopo deste pedido). Um listener por delegação de
evento (`document.addEventListener('click', ...)`) filtra por
`#creditBadgeBtn` e chama `BX24.openPath('/company/personal/user/5305/')`
— mesmo mecanismo já usado no projeto para abrir card de negócio/contato
(`BX24.openPath`), que o Bitrix sempre abre num slider lateral, nunca em
nova guia. Em `index.html` (mini-chat, template literal recriado a cada
`renderChat()`), o listener é religado a cada render, no mesmo bloco que
já faz isso para `openCrmBtn`/`themeToggleBtn`.

Aplicado nas 21 páginas: as 18 padrão (`admin`, `agent-examples`,
`agente-ia`, `campaign-metrics`, `campaign-schedule`, `campaign`,
`contacts`, `conversation-analysis`, `dashboard`, `faq`, `how-to`,
`instances`, `lead-metrics`, `notifications`, `onboarding`, `settings`,
`sites`, `suggestions`) + `chat.html` + `index.html` + `apresentacao.html`.

Validação: sintaxe de todos os `<script>` inline via `vm.Script` (sem
erro), HTTP 200 nas 21 páginas via servidor local, grep confirma zero
ocorrência restante de `credit-badge" href` e 21/21 com
`BX24.openPath('/company/personal/user/5305/')`.

## 10. Uso real em produção (Caio/testegabriel) — 3 bugs de chat (2026-09-29)

Usuário testou o chat de verdade com um contato externo (Caio Araujo) e
reportou 3 problemas com prints do nosso painel + WhatsApp Web real do
outro lado (prova de que o envio/recebimento em si funcionava, só a
exibição no nosso app que falhava).

**(a) Áudio sempre "Não foi possível carregar o áudio" (envio e
recebimento), mesmo tendo "carregado" depois de 1-2 min.** Causa raiz
em `hydrateOneMedia()` (`chat.html`): o caminho de SUCESSO nunca
chamava `hideMediaError(el)` — só o `catch` chamava `showMediaError`.
Se qualquer tentativa anterior (fetch falho, evento `error` nativo do
elemento) já tinha mostrado a caixa de erro, uma tentativa posterior
bem-sucedida trocava o `src`/blob mas a caixa de erro ficava presa na
tela pra sempre (o áudio ficava tocável de fato, só a UI que nunca
avisava). Também sem proteção contra `blob.size === 0` (corpo vazio —
ex: signed URL do Supabase expirada respondendo 200 sem conteúdo),
que geraria um blob inválido silenciosamente.

Corrigido: `hideMediaError(el)` chamado em TODOS os caminhos de
sucesso de `hydrateOneMedia` (URL direta, cache, fetch novo), e
`blob.size === 0` agora lança erro explícito (cai no catch, mostra a
caixa com botão "Tentar de novo" de forma correta, em vez de silêncio).
Aplicado em `chat.html` (com a UI de erro completa) e `index.html`
(mini-chat, só a checagem de blob vazio — esse arquivo não tem a UI de
`.media-error`, mídia lá é best-effort silencioso).

**(b) Imagem aparece mas com "Não foi possível carregar a imagem /
Tentar de novo" grudado embaixo.** Mesma causa raiz de (a) — a imagem
às vezes carrega numa segunda tentativa, mas a caixa de erro da
primeira tentativa nunca era escondida. Resolvido pela mesma correção
de `hideMediaError` no caminho de sucesso.

**(c) "Bug rápido": mensagem enviada pisca em duplicidade (aparecem
duas, uma some, fica só a certa) — sem duplicata real salva.** Causa
raiz: mensagem otimista (`id: 'tmp-...'`) inserida na hora do envio,
ANTES da resposta HTTP de `/send`/`/send-media` voltar. Se o eco da
mensagem chegar pelo WebSocket nesse meio-tempo (comum — o socket
costuma ser mais rápido que o round-trip HTTP completo), o dedupe por
id (`payload.message.id === m.id`) não reconhecia a otimista (ids
diferentes: `tmp-...` vs id real), então o socket empurrava uma
SEGUNDA entrada. Só quando a resposta HTTP chegava depois,
`resolveOptimisticId` removia a otimista (já havia lógica pra isso,
mas só cobria a duplicata *persistente* — não o flash visual de
1 frame com as duas na tela ao mesmo tempo).

Corrigido: handler do socket agora, ao receber uma mensagem própria
(`direction === 'out'`) sem correspondência ainda, procura uma
otimista pendente (id começando com `tmp-`) e SUBSTITUI o item no
array em vez de empurrar um novo — nunca há um frame com as duas.
`resolveOptimisticId` continua funcionando sem alteração (o filtro por
referência de objeto simplesmente não encontra mais nada pra remover,
o que é inofensivo). Aplicado em `chat.html` e `index.html` (mesma
lógica duplicada nos dois arquivos).

Validação: sintaxe de scripts inline OK (`vm.Script`) nos dois
arquivos, HTTP 200, teste isolado em Node simulando as duas ordens de
chegada possíveis (socket antes/depois da resposta HTTP) e o caso de
mensagem recebida no meio — 3/3 cenários sem duplicata e sem perda de
mensagem.

Figurinha com legenda "não importa muito" pro usuário — não investigado
(fora de prioridade, por pedido dele).

## 11. Áudio/imagem ainda com erro preso — causa raiz real era o proxy de mídia (2026-09-29, mesmo dia)

A correção do item 10 (a)/(b) (`hideMediaError` no caminho de sucesso)
não resolveu — usuário voltou com novo print mostrando exatamente o
mesmo sintoma (imagem visível, caixa de erro grudada embaixo, mesmo
"depois de uns minutos"). Isso indicava que a causa raiz não era só a
UI nunca escondendo o erro — tinha um fetch que FALHAVA de verdade,
intermitentemente, sem relação com o conteúdo do arquivo em si.

Causa raiz real, encontrada revisando `GET /media/:filename`
(`src/routes/whatsapp.js`): a rota fazia `res.redirect(302, signedUrl)`
pro Supabase Storage. O frontend busca essa rota via `fetch()` com
header `Authorization: Bearer <token>` (autenticação do nosso próprio
app, ver `apiFetch`/`hydrateOneMedia`). Um redirect 302 seguido
automaticamente por `fetch()` vira uma requisição CROSS-ORIGIN pro
domínio do Supabase — que só funciona se o bucket tiver CORS liberado
pra origem do app. Isso é intermitente/dependente de configuração
externa ao nosso código (cache de preflight do navegador, propagação
de config de CORS no Supabase), o que bate com o sintoma relatado
("às vezes funciona, às vezes não", sem relação com o arquivo).

Corrigido trocando o redirect por PROXY: a rota agora baixa os bytes
do Supabase Storage no próprio servidor (`downloadMediaByFilename`,
nova função em `src/media.js`, usa `.storage.from(BUCKET).download()`
— mesmo SDK que `downloadMedia` já usava server-to-server pro
scheduler/agente de IA) e reenvia direto na resposta
(`res.set('Content-Type', ...); res.send(buffer)`), com
`Cache-Control: private, max-age=3600`. O `fetch()` do frontend nunca
mais sai do nosso próprio domínio — elimina de vez a dependência de
CORS do bucket.

`getSignedMediaUrl` (gera URL assinada) mantida no arquivo, só não é
mais usada por essa rota — reserva pra eventual uso futuro.
`downloadMedia` (usada por `scheduler.js`/`agentDispatch.js`,
server-to-server, formato de entrada diferente — recebe a URL relativa
inteira) não foi tocada.

Validação: sintaxe OK (`node -c` nos dois arquivos), rota testada
localmente (responde 401 sem token, confirma que carrega e roteia sem
erro; teste do caminho de sucesso depende de credencial real do
Supabase de produção, não reproduzível localmente).

## 12. Causa raiz DEFINITIVA — cache do navegador preso, não CORS (2026-09-29, mesmo dia)

A correção do item 11 (proxy em vez de redirect) também não resolveu —
usuário confirmou "continua a mesma coisa" com novo print. Pedido
então print do DevTools (Network, filtro "media") pra parar de
especular e ver o erro real.

**Achado decisivo**: TODAS as requisições de mídia (`fetch` a partir
de `chat.html:1977`) retornavam **status 200**, servidas do
**"disk cache"** do próprio navegador — não do servidor. Ou seja, a
requisição nem chegava a sair do navegador; ele respondia direto do
cache local, com um corpo antigo (vazio/inválido).

Causa raiz: a correção do item 11 adicionou
`res.set('Cache-Control', 'private, max-age=3600')` na rota
`GET /media/:filename`. Qualquer resposta ruim que essa URL já tivesse
retornado ANTES da correção (ex: 404 por corrida de upload, ou falha
do redirect/CORS antigo) ficou cacheada no disco do navegador do
usuário por até 1h — e como o filename de cada mensagem é único e
nunca muda, o navegador nunca mais perguntou ao servidor pra aquela
URL específica, nem quando o usuário clicava "Tentar de novo" (o clique
disparava um novo `fetch`, mas o browser respondia do cache sem rede).
Isso explica por que a correção anterior "não teve efeito nenhum" pro
usuário mesmo estando correta no servidor — o navegador dele nunca
chegou a testá-la de fato pras mensagens já vistas antes.

Corrigido em duas camadas (defesa dupla, pra cobrir tanto o servidor
quanto qualquer cache HTTP intermediário):
1. Servidor: `Cache-Control: no-store` (em vez de `private,
   max-age=3600`) tanto no sucesso quanto no erro 404 de
   `GET /media/:filename`.
2. Frontend: `apiFetch(url, { cache: 'no-store' })` em
   `hydrateOneMedia` (`chat.html` e `index.html`) — o próprio `fetch()`
   do navegador é instruído a nunca reaproveitar cache de disco pra
   essa URL, mesmo que algum proxy/CDN intermediário no meio do
   caminho tentasse permitir cache.

**Isso NÃO limpa cache já salvo em navegadores que já viram o erro
antes desta correção** — só previne que aconteça de novo daqui pra
frente. Usuário/atendentes que já tiveram esse problema precisam de
UM hard refresh (Ctrl+Shift+R) ou limpar cache do site uma vez, depois
disso o problema não deve mais voltar a acontecer (nem em mensagens
novas, nem reabrindo as antigas).

Validação: sintaxe OK (`node -c`/`vm.Script`) nos 3 arquivos alterados.

## 13. Segunda causa de sobrecarga: sessões pareadas mas mortas, reconectando pra sempre (2026-09-30)

Enquanto investigava o item 12, pedido acesso aos logs do container via
SSH pra ver `GET /media/:filename` ao vivo — os logs revelaram outro
problema, sem relação direta com mídia, mas potencialmente relevante
pra ela (servidor sobrecarregado pode atrasar/falhar outras
requisições): dezenas de sessões (`_491`, `_106922`, `_174806`,
`_145374`, `_178968`, `_192667`, `_8465`, entre outras) em loop
constante `connecting` → `offline` (statusCode 408, timeout) →
`tentativa N, próxima em 300s`, com N chegando a 137-142 (mais de 11h
tentando sem parar).

Diferente do incidente do item 5 (sessões NUNCA pareadas, corrigido
filtrando por `creds.registered` no boot, `sessions.js`): estas JÁ tem
`creds.registered=true` (passaram no filtro), mas estão mortas na
prática (número trocado de aparelho, instância de teste abandonada,
etc). O código de reconexão (`src/whatsapp.js`, handler de
`connection.update`) já tinha backoff exponencial (3s → 5min) e parava
de insistir sozinho pra códigos claramente permanentes (403 forbidden,
440 connectionReplaced, 500 badSession — mesma proteção do HANDOFF
Parte CQ, depois de um incidente quase idêntico anterior). Mas um
código 408 (timeout) repetido pra sempre não é permanente nem
temporário de verdade — cai no `else` genérico, que só cresce o
INTERVALO entre tentativas, nunca desiste de vez. Sem teto de
tentativas TOTAIS, uma sessão morta reconecta pra sempre, a cada 5min,
indefinidamente.

Corrigido: novo teto `MAX_CONSECUTIVE_FAILURES` (constante no topo de
`whatsapp.js`, configurável via env `MAX_RECONNECT_ATTEMPTS`, padrão
20 — com o backoff exponencial até 5min, já representa mais de 1h30
tentando, tempo generoso pra qualquer instabilidade de rede real se
resolver sozinha). Ao atingir o teto, a sessão é tratada como os
códigos permanentes: `needsAttention=true`, para de reconectar sozinha,
fica visível na tela de Instâncias com o botão "Tentar reconectar" já
existente (zera o contador e tenta nas credenciais salvas — sem
escanear QR de novo, caso volte a funcionar) — nada é apagado
automaticamente, decisão de reconectar ou remover fica com o usuário
(pedido explícito: "se estão abandonadas... pode remover, inclusive
deveria colocar algo com limite de tentativas, tipo tentou 5 vezes
remove" — implementado como "para de insistir sozinho e marca pra
atenção manual", não como remoção automática, que seria destrutivo
demais pra tomar sem confirmação).

Validação: sintaxe OK (`node -c`).

Usuário sinalizou separadamente que o fluxo de "parar instância
Principal" não está muito intuitivo hoje — vai detalhar depois, ainda
não implementado/investigado.

## 14. Causa raiz REAL do erro de mídia — fetch duplicado no cliente (2026-09-30)

As três correções anteriores (itens 10-12: hideMediaError, proxy em vez
de redirect, Cache-Control no-store) não resolveram — usuário
confirmou de novo "continua do mesmo jeito", com print mostrando
exatamente o mesmo sintoma (imagem visível + caixa de erro grudada
embaixo). Adicionado log temporário em `GET /media/:filename`
(`[media] pedido`/`[media] ok`) e pedido acesso direto aos logs do
container via SSH (`docker logs`) pra ter certeza absoluta, em vez de
continuar corrigindo às cegas.

**Achado definitivo**: os logs mostraram que o SERVIDOR SEMPRE
respondeu certo — toda mídia testada (imagem nova enviada, e o
histórico inteiro da conversa ao recarregar a página) retornou HTTP
200 com bytes corretos, sem uma única falha. Só que a MESMA imagem
recém-enviada apareceu no log **3-4 vezes seguidas** (`[media]
pedido`/`[media] ok` repetido pro mesmo filename, em rajada). Ou seja:
nunca foi bug de rede, CORS ou cache HTTP (as três hipóteses
anteriores, todas descartadas por evidência real, não suposição) — o
cliente estava disparando MÚLTIPLOS fetches concorrentes e redundantes
pra mesma mídia.

Causa raiz: `renderMessages()` roda várias vezes em sequência rápida
pro mesmo envio de mensagem (mensagem otimista local → eco do
WebSocket → resposta HTTP do `/send-media`), e cada chamada recria
TODOS os elementos de mídia do zero via `innerHTML`, disparando
`hydrateMedia()`/`hydrateOneMedia()` de novo — antes da primeira
chamada terminar de popular `mediaBlobCache`, a segunda/terceira já
checavam o cache como vazio e disparavam seu próprio fetch. Com
respostas chegando fora de ordem, uma tentativa mais lenta podia
`setMediaSrc`/`hideMediaError` DEPOIS de outra já ter deixado o
elemento num estado diferente — inclusive `showMediaError` reabrindo a
caixa por cima de uma imagem que uma tentativa concorrente já tinha
carregado com sucesso. Detalhe que também explica a aparência do bug:
`.media-error` no CSS não é `position:absolute` — é um bloco normal
dentro do balão, então quando ficava visível ele aparecia EMBAIXO da
imagem (não sobreposto), exatamente como reportado nos prints.

Corrigido com deduplicação por Promise: `mediaFetchPromises` (novo Map,
paralelo ao `mediaBlobCache` já existente) garante que só UMA busca de
rede rode por URL por vez — qualquer chamada concorrente reaproveita a
MESMA Promise em vez de disparar um fetch próprio; a Promise se
autolimpa do Map ao terminar (sucesso ou erro), então uma tentativa
seguinte de verdade (ex: botão "Tentar de novo") ainda funciona
normalmente. Aplicado em `chat.html` e `index.html` (mesma lógica
duplicada nos dois arquivos, mini-chat não tem a UI de erro mas tinha
o mesmo desperdício de fetch).

Removido o log de diagnóstico temporário do item anterior (cumpriu o
papel, confirmou que o servidor nunca foi a causa).

Validação: sintaxe OK (`node -c`/`vm.Script`) nos 3 arquivos. Teste
isolado em Node simulando 4 chamadas concorrentes pra mesma URL contra
um "servidor" fake que conta requisições — confirmado 1 única chamada
de rede real, todos os 4 callers recebendo o mesmo resultado, e uma
5ª chamada posterior usando o cache sem nova rede.

## 15. CAUSA RAIZ DE VERDADE, finalmente confirmada por evidência direta (2026-09-30)

A correção do item 14 (dedupe de fetch) também não resolveu — usuário
confirmou de novo com print, agora com DUAS imagens diferentes. Nesse
ponto, decidido parar de corrigir por hipótese e investigar por
evidência direta em cada camada, do servidor até o pixel na tela,
nessa ordem:

1. **Logs do servidor via SSH** (`docker logs`, container
   `whatsapp-gateway_gateway...`): confirmado que TODA mídia buscada
   (histórico inteiro + mensagem nova) retornava 200 com bytes
   corretos — nenhuma falha real do backend em momento nenhum.
2. **Console do DevTools filtrado por `chat.html`**: zero erros JS —
   descartou qualquer exceção não tratada no fluxo de hidratação.
3. **Inspecionar elemento (aba Elements)** na mensagem com erro:
   revelou `<img src="blob:...">` com um blob VÁLIDO e
   `<div class="media-error" hidden>` — ou seja, o HTML real já
   estava no estado correto (imagem carregada, erro marcado como
   escondido), mas a caixa de erro aparecia visualmente mesmo assim.
4. **Aba Network → clique na requisição específica → Preview**:
   confirmado que o arquivo baixado (PNG de 15-38KB) era exatamente
   a imagem certa que o usuário enviou (confirmado por ele: "é a foto
   que eu mandei mesmo", um logo de cliente) — abrindo o blob em nova
   guia mostrou a imagem correta, sem nenhum CSS interferindo.

**Conclusão**: nunca foi bug de rede, servidor, CORS, cache HTTP, fetch
duplicado ou conteúdo errado — todas essas quatro hipóteses anteriores
(itens 10, 11, 12, 14) descreviam problemas REAIS que existiam e
foram corrigidos corretamente, mas nenhuma delas era a causa deste
sintoma específico. A causa real, uma vez que o passo 3 provou que o
próprio HTML já tinha `hidden` presente no elemento: **mesmo bug de
especificidade CSS do item 9 (drawer de notas do mini-chat)**, desta
vez em `.media-error` de `chat.html` — `.media-error{ display: flex;
... }` tem a MESMA especificidade que a regra padrão do navegador
`[hidden]{ display: none }`, e por vir depois na cascata, VENCE. A
caixa de erro fica sempre visível mesmo com `hidden=true` corretamente
setado pelo JS (`hideMediaError()` sempre funcionou — só que a
mudança no atributo nunca tinha efeito visual nenhum).

Curiosamente, `chat.html` já tinha essa exata correção aplicada em
OUTROS cinco seletores (`.composer[hidden]`, `.export-menu[hidden]`,
`.reply-preview-bar[hidden]`, `.composer-note-wrap[hidden]`,
`.assignee-filter[hidden]`) — inclusive com comentário histórico
"correção já feita... só faltou" em pelo menos um deles — mas
`.media-error` nunca tinha recebido o mesmo tratamento.

Corrigido adicionando `.media-error[hidden]{ display: none; }` logo
abaixo da regra existente. Validado via Playwright que
`getComputedStyle(...).display` vira `'none'` com o atributo presente.

**Lição pra próxima vez que algo parecido acontecer**: quando uma
correção lógica (JS) não resolve um sintoma visual, checar a
ESPECIFICIDADE CSS do seletor envolvido com `[hidden]`/`[disabled]`
ANTES de assumir que a lógica de negócio está errada — este mesmo
padrão de bug já apareceu 2 vezes neste projeto (aqui e no item 9) e é
completamente invisível olhando só o JavaScript.

## 16. Melhorias pedidas após confirmar o fix do item 15: loading + imagem em tela cheia (2026-09-30)

Usuário confirmou que o erro sumiu ("agora foi, sumiu a mensagem de
erro"), com dois pedidos de melhoria (não bugs):

**(a) Spinner enquanto a imagem/vídeo carrega.** Antes do fix do item
15, a moldura ficava preta e vazia por ~1s a cada carregamento — sem
saber que ia carregar, "parece um erro" pra quem usa. Adicionado
`.media-loading` (novo elemento por mídia, reaproveita a mesma moldura
`.media-frame`), com um spinner simples via CSS (`@keyframes
mediaSpin`). `hideMediaLoading(el)` chamado tanto no sucesso
(`hideMediaError`) quanto no erro de verdade (`showMediaError`) — o
spinner nunca fica visível junto de nenhum dos dois estados finais.
Só imagem/vídeo (não áudio — o player nativo já é pequeno e não dá a
mesma sensação de "vazio quebrado").

**(b) Clique na imagem abre em tela cheia.** Antes só dava pra ver a
foto grande clicando com o botão direito > "Abrir imagem em nova
guia". Criado um lightbox próprio (`#imageLightbox`, sem depender do
`.modal` genérico do projeto, que tem largura máxima fixa pensada pra
formulário) — fundo preto quase opaco, imagem centralizada com
`object-fit:contain`, botão X e fecha com Escape ou clique fora da
imagem. Marcado via `data-lightbox` no `<img>` de mensagem (não em
`img` de qualquer outro lugar da página, ex: avatares). Listener de
clique por delegação a nível de módulo (mesmo padrão já usado pro menu
de exportar) — funciona mesmo com `renderMessages()` recriando os
elementos a cada render, sem precisar religar nada.

Validação: sintaxe OK. Teste isolado em Playwright: (1) spinner some e
o layout ajusta pra altura real da imagem ao "carregar"; (2) lightbox
abre ao clicar na imagem, fecha com Escape, fecha com botão X, fecha
ao clicar fora da imagem — 4/4 cenários corretos.

## 17. Praticidade de primeiro uso — 3 pedidos do usuário (2026-09-30)

Usuário pediu 3 melhorias de fluxo pra facilitar o primeiro uso de
quem nunca viu a ferramenta (equipe do escritório abrindo o DapZap
pela 1ª vez), com prints mostrando: tela "Selecione uma conversa"
vazia sem nenhuma pista do que fazer; página de Conexões cheia de
"Principal ainda não pareado — reconectando sozinha" (evidência visual
do mesmo problema de sessões órfãs do item 5/13); e o seletor de
instância "escondido" dentro do Chat.

**(a) Aviso "conectar WhatsApp" no Chat vazio.** `renderEmptyView()`
(chat.html) ganhou um parâmetro `noInstances` — quando
`initInstances()` detecta zero instâncias (`!list.length`, mesmo
caminho que já existia), mostra "Você ainda não conectou um WhatsApp"
+ botão "Conectar WhatsApp agora" linkando pra `/instances.html`, em
vez do genérico "Selecione uma conversa".

**(b) QR direto no primeiro acesso a Conexões, SEM criar instância
órfã antes de parear.** Causa raiz do problema visto nos prints do
usuário (várias "Principal" nunca pareadas): `GET /instances`
(src/routes/whatsapp.js) sempre chama `instancesStore.ensureDefault()`
incondicionalmente — o simples fato de abrir `instances.html` já
gravava uma linha "Principal" no Postgres, mesmo que o usuário fechasse
a aba sem escanear nada. Investigado com agente de exploração antes de
mexer: confirmado que a checagem de autorização (`assertOwnsSession`,
src/authz.js) já tem um atalho pra quando `id === ownerId` (exatamente
o caso da "Principal") que DISPENSA a linha existir no banco — ou
seja, gerar/consultar QR nunca dependeu tecnicamente da linha existir
antes, só o fluxo de produto que sempre criava de qualquer jeito.

Corrigido com dois endpoints novos, isolados (não mexe no
comportamento de `GET /instances` usado por chat.html/index.html, que
já tratam bem o caso de zero instâncias):
- `GET /instances/status?owner=...` — mesma lista, SEM `ensureDefault`,
  só responde `{hasInstance: bool}`.
- `POST /instances/confirm-default {owner}` — grava a "Principal" (via
  `ensureDefault`, idempotente) só quando `sessions.get(owner).getStatus()
  === 'online'` de verdade (senão responde 409).

`instances.html`: `boot()` novo, primeiro chama `GET /instances/status`;
se `hasInstance:false`, substitui o `.panel` inteiro (grid + botão) por
um QR inline (reaproveita o mesmo `GET /qr?session=<ownerId>` e a
mesma animação de "foguete" carregando, com ids próprios pra não
colidir com o modal). Ao detectar `status:'online'` no polling, chama
`POST /instances/confirm-default`, restaura o `.panel` original
(guardado antes de qualquer substituição) e chama `loadInstances()` —
que agora encontra a instância já persistida. `newInstanceBtn` (e as
demais refs de DOM do painel) precisaram virar `let` + uma função
`rebindPanelRefs()`, já que a substituição de innerHTML destrói os nós
originais.

**(c) Atalho por instância na sidebar.** Antes só dava pra trocar de
instância pelo `<select>` discreto dentro do Chat. `chat.html` ganhou
`renderInstanceShortcuts(list)`, chamado dentro de `initInstances()` —
um item por instância (só aparece com 2+, não duplica "Chat" quando só
tem 1), visualmente um sub-item recuado logo abaixo de "Chat". Clicar
navega pra `/chat.html?session=<id>`, que `initInstances()` usa pra
pré-selecionar essa instância no `<select>` do filtro antes do
`onFilterChange()` — mesmo padrão de deep link (`?session=&phone=`) já
usado pelas notificações, só que sem o `phone` (pré-seleciona a
instância inteira, não uma conversa específica).

Validação: sintaxe OK (`node -c`/`vm.Script`) em todos os 4 arquivos
tocados. Teste isolado em Playwright interceptando as chamadas de API:
fluxo completo (zero instâncias → QR → confirma → restaura grid)
confirmado via inspeção direta do DOM (elemento do QR removido,
`.instances-grid` presente); `confirm-default` chamado na ordem certa
(depois do 2º poll `online`, antes de `loadInstances()`); botão "+
Conectar outro WhatsApp" religado corretamente após a restauração
(clique disparado via `.click()` no DOM confirma o modal abrindo —
Playwright `page.click()` real não foi usado nesse teste específico
por um modal de atalhos genérico, pré-existente e sem relação com esta
mudança, interceptando cliques na primeira visita da página em
ambiente de teste limpo).

## 18. Item 17 incompleto — GET /instances ainda recriava a "Principal" (2026-09-30)

Usuário testou com 2 colaboradores reais (Henrique Gomes, Caio Marques)
que nunca conectaram nada, e o aviso novo do item 17 não apareceu —
continuava mostrando a instância "Principal" órfã, e nem removê-la
manualmente resolvia (voltava sozinha). Rodado o script de limpeza
(item de manutenção, ver `db/cleanup-orphan-instances.js`) ANTES desta
correção: 239 instâncias órfãs removidas de fato (confirmado, banco
caiu de 425 para 186) — mas a causa raiz continuava ativa, recriando
órfãs novas a cada acesso.

Causa raiz: o item 17 só removeu `ensureDefault` do fluxo de
`instances.html` (criando `GET /instances/status`, que não o chama) —
mas `GET /instances` (a rota ORIGINAL, ainda usada por `chat.html` e
`index.html`) continuava chamando `ensureDefault` incondicionalmente.
Como o app sempre abre pelo Chat (confirmado com o usuário: "todo
mundo sempre abre o dapzap pelo chat"), a "Principal" era recriada ali
ANTES da pessoa sequer chegar em Conexões — por isso o aviso nunca
aparecia (a rota que o Chat consulta já devolvia `hasInstance` como
tendo 1 instância) e remover manualmente não resolvia (o próximo
carregamento do Chat recriava de novo).

Corrigido removendo `ensureDefault` de `GET /instances` também (a
única rota que ainda faltava) — agora só `listAccessible` roda, sem
side-effect nenhum. `chat.html` já tratava corretamente `!list.length`
(item 17, `renderEmptyView(true)`), então não precisou de mudança ali.
`POST /instances` (criar instância EXTRA, ação explícita do botão "+
Conectar outro WhatsApp") trocado de `ensureDefault` para
`listByOwner` — só precisa contar quantas instâncias já existem pro
limite, não precisa (e não deve) criar nada.

De quebra, `index.html` (mini-chat embutido no card) ganhou um código
de erro próprio (`NO_INSTANCE`) pro mesmo caso de "zero instâncias" —
antes caía no erro genérico "Não foi possível abrir a conversa", agora
mostra "Nenhum WhatsApp conectado ainda" com instrução clara.

A limpeza já feita (239 instâncias removidas) continua válida — com
esta correção, novas órfãs não voltam a ser criadas a cada reload do
Chat.

Validação: sintaxe OK (`node -c`/`vm.Script`) em todos os 3 arquivos.

## 19. Filtro "WhatsApp: nunca conectou" no Admin + lembrete diário via IM do Bitrix (2026-09-30)

Com a causa raiz das instâncias órfãs corrigida (itens 17/18), `u.instances
=== []` em `GET /admin/users` passou a significar "de verdade nunca
conectou" — usuário pediu pra identificar quem está nessa situação e
programar lembretes.

**Parte 1 — visualização/exportação (aba Usuários do Admin)**: novo
filtro `usersFilterWhatsapp` ("WhatsApp: nunca conectou"), mesmo padrão
dos filtros já existentes (Status, Atividade, etc) — não precisou de
rota nova, `u.instances` já vinha pronto de `GET /admin/users`. CSV
exportado (`exportUsersCsv`, já respeita `usersFiltered()`) ganhou
colunas de Celular/Ramal — antes não tinha telefone, insuficiente pra
mandar lembrete manual.

**Parte 2 — automação (pedido explícito: "vai ser notificação im nativa
do bitrix mesmo")**: novo `src/whatsappReminderPoller.js`, mesmo
esqueleto de `src/instanceBanPoller.js` (`runOnce()` + `startPolling()`,
registrado em `server.js`). Regras confirmadas com o usuário:
- Carência de 1 dia desde `dateRegister` (criação da conta no Bitrix)
  antes do primeiro lembrete — evita incomodar gente recém-contratada.
- Repete 1x por dia até conectar (dedupe por dia civil em memória, reseta
  a cada restart — mesmo raciocínio de `instanceBanPoller.js`: pior caso
  manda 1 extra depois de deploy, nunca deixa de lembrar).
- Para automaticamente assim que `instancesStore.listByOwner(ownerId)`
  deixa de retornar vazio.

**Decisão de canal, com achado técnico relevante**: cogitado reusar
`alertDispatcher.notifyAttention` (4 canais: in-app, Web Push, WhatsApp de
sistema, e-mail), mas descartado — `whatsappAlert.notifyOwner` só
funciona se o dono já tiver OUTRA instância online (nunca é o caso de
quem nunca conectou nada) e Web Push exige opt-in prévio que essa pessoa
não teria motivo de ter dado. Usuário confirmou preferência por canal
próprio: IM nativo do Bitrix (`im.message.add`), via o mesmo webhook já
usado por `bitrixHierarchy.js` (`callBitrixHR`, exportado agora pra
reaproveitar) — **exige o escopo "im" habilitado no webhook de entrada
(`BITRIX_HR_WEBHOOK_URL`)**, usuário vai confirmar/configurar isso no
painel do Bitrix separadamente; sem o escopo, a chamada falha e é
logada (mesmo padrão de degradação graciosa do resto do módulo), não
derruba nada.

Validação: sintaxe OK (`node -c`) em `whatsappReminderPoller.js`,
`bitrixHierarchy.js`, `server.js`. Teste isolado em Node com
dependências mockadas (instâncias, `listEmployees`, `im.message.add`):
3 cenários — usuário recém-criado (dentro da carência) não recebe,
usuário já conectado não recebe, usuário elegível recebe exatamente 1x
e não duplica numa segunda rodada no mesmo dia — 3/3 corretos.

Validação de ponta a ponta (chamada real ao Bitrix) pendente — depende
da confirmação do escopo "im" no webhook, fora do que dá pra testar
localmente.

**Atualização (mesmo dia)**: usuário confirmou o escopo "im" já
habilitado e reiniciou o container pra testar — nenhuma mensagem
chegou, e os logs não tinham NENHUMA linha de
`[whatsapp-reminder-poller]`, nem sucesso nem erro. Causa: `startPolling()`
usava só `setInterval`, que só dispara a PRIMEIRA vez depois do
intervalo completo (1h) — igual todos os outros pollers do projeto
(`instanceBanPoller`, `dealStagePoller`), nenhum roda imediatamente no
boot. Reiniciar o container não era suficiente pra ver resultado antes
de 1h, e não havia log nenhum no caminho "rodou e não achou ninguém"
pra diferenciar de "ainda não rodou".

Corrigido: `startPolling()` agora chama `runOnce()` uma vez imediatamente
antes de armar o `setInterval` — sem isso, um deploy/restart ficava até
1h sem nenhum lembrete sair, mesmo com gente elegível o dia inteiro.
Adicionado log incondicional ao final de cada tick (`N funcionário(s),
M elegível(is), K enviado(s)`) e um log de sucesso por envio — antes só
logava em caso de erro, tornando impossível diagnosticar à distância se
o job estava rodando sem achar ninguém elegível ou simplesmente não
tinha rodado ainda.

Validado de novo com o mesmo teste isolado (3 cenários) — lógica
intacta, só a visibilidade/timing mudou.

**Atualização (mesmo dia, 2ª correção)**: com os logs em mãos,
confirmado que o lembrete de fato chegou — só que como MENSAGEM DE
CHAT, saindo do perfil pessoal do dono do webhook (Bruno), não como
notificação do sistema. Usuário esclareceu: "a ideia era notificação e
não mensagem direta". Causa: `im.message.add` sempre sai em nome de
quem autentica a chamada (o dono do webhook) — não existe parâmetro
pra mascarar isso como "sistema".

Corrigido trocando pra `im.notify.personal.add` (notificação real do
Bitrix, aparece no sino, atribuída ao app/sistema — não a uma pessoa).
`sendBitrixIm` renomeada pra `sendBitrixNotification`, parâmetros
trocados de `DIALOG_ID` pra `USER_ID` (formato da API de notificação,
diferente da API de mensagem), adicionado `TAG` único por dia+usuário
(defesa extra de dedupe do lado do Bitrix — o dedupe real continua
sendo `lastRemindedDate` em memória, TAG é só redundância).

Validado com o mesmo teste isolado, adaptado pra confirmar
explicitamente que `im.message.add` NUNCA é mais chamado (o mock lança
erro se for) e que `im.notify.personal.add` recebe os parâmetros
certos — PASS.

**Atualização (mesmo dia, 3ª correção)**: usuário publicou um anúncio no
Feed do Bitrix (tutorial passo a passo com print + link do app) pra
quem respondeu não sabendo como conectar. Texto do lembrete atualizado
pra apontar pro link desse post
(`https://bitrix.dapadvocacia.com.br/company/personal/user/5305/blog/15670/`)
em vez de só instruir genericamente "vá em Conexões do WhatsApp" — dá
o passo a passo completo pra quem clicar.

## 20. Performance — lazy load de mídia + paginação de mensagens no Chat (2026-09-30)

Usuário reportou, observando os próprios logs de produção (volume
grande de "mídia histórica indisponível" ao abrir conversas): "quando
abro um chat, tenta carregar tudo de uma vez só a conversa, não tem
como paginar?". Confirmado: `GET /history` buscava até 500 mensagens
de uma vez (`store.getHistory`), `renderMessages()` desenhava todas no
DOM de uma vez, e `hydrateMedia()` disparava um fetch de mídia por
elemento — TODOS de uma vez, mesmo fora da área visível da tela.

**(a) Lazy load de mídia por viewport** — `hydrateMedia()` (chat.html e
index.html/mini-chat) agora usa `IntersectionObserver` com
`rootMargin: 600px` — só busca o blob de imagem/áudio/vídeo quando o
elemento está perto de entrar na tela (carrega com antecipação, não
exatamente no frame em que aparece). Documentos (`<a>`, sem bytes de
mídia baixados adiante) e mídia já em `mediaBlobCache` continuam
hidratados na hora, sem passar pelo observer. Toda a lógica de
erro/retry/dedupe existente (itens anteriores do ROADMAP) preservada
intacta — só mudou O MOMENTO em que `hydrateOneMedia` é chamado.

**(b) Paginação real de mensagens** — nova `store.getHistoryPage(sessionId,
phone, {before, limit})`, função SEPARADA de `store.getHistory`
(mantida intacta — usada por agente de IA/resumo/insights/auditoria,
que precisam do histórico COMPLETO pra contexto, nunca paginados).
`GET /history` (1º carregamento da conversa) passou a devolver só 50
mensagens mais recentes + `hasMore`; nova rota `GET /history/older`
(com `before=<timestamp da mais antiga já carregada>`) busca a página
seguinte, chamada pelo frontend ao rolar pro topo da lista
(`bindMessagesScroll`, gatilho a 150px do topo, religado a cada troca
de conversa).

Preservação de posição de leitura: `renderMessages({preserveScrollFromBottom:
true})` mede a distância até o fim da lista ANTES de inserir as
mensagens antigas no topo e restaura essa MESMA distância depois — sem
isso, cada página nova "puxaria o tapete" da leitura em andamento. Só
usado no caminho de "carregar mais antigas"; o carregamento normal
(1ª vez, mensagem nova chegando) continua rolando pro final como
sempre.

Validação: sintaxe OK (`node -c`/`vm.Script`) em store.js, whatsapp.js
(rotas), chat.html e index.html. Testes isolados em Playwright: (1)
lazy load — 0 fetches com elemento a 2000px de distância, 1 fetch
exato ao rolar até 600px dele; (2) gatilho de scroll — não dispara
longe do topo, dispara a 150px; (3) preservação de posição — distância
até o fim idêntica antes/depois de inserir 150px de conteúdo no topo.
Teste isolado em Node da lógica de `hasMore`/reversão cronológica de
`getHistoryPage` — 3 cenários (página intermediária, última página,
exatamente no limite) corretos.

## 21. Nova conversa com número não salvo + seletor de número do negócio (2026-10-01)

Dois pedidos independentes vindos de questionamentos reais de uso.

**(a) "Nova conversa" em chat.html** — botão (ícone de lápis) na barra de
ações do painel de conversas, ao lado de "Grupos do WhatsApp". Abre um
modal simples (`#newChatModal`): escolhe a instância (só aparece se
houver mais de uma individual, mesmo `groupInstanceOptions()` já usado
pelo modal de grupo) e digita o número (`normalizePhone`, mesma regra
de index.html — DDI 55 somado automaticamente se vier só DDD+número).
Reaproveita `openConversation()` já existente (genérica o bastante pra
abrir uma conversa sem histórico, é o mesmo caminho de uma conversa
nova chegando por mensagem recebida) — se já existir conversa com esse
telefone na instância escolhida, reabre ela em vez de duplicar.
Decisão confirmada com o usuário: conversa fica SOLTA, sem `dealId`,
igual ao WhatsApp Web — sem vínculo automático a negócio/contato do
Bitrix.

**(b) Seletor de número no mini-chat (index.html)** — usuário reportou
que o campo personalizado `[S] NUMERO CORRETO DO CLIENTE`
(`UF_CRM_1752095090`), usado pela equipe pra marcar manualmente qual é
o número de verdade do cliente num negócio com vários contatos
anexados, era ignorado: `loadDealContact` só olhava
`deal.CONTACT_ID` (contato "principal") e pegava `contact.PHONE[0]`
sempre, sem opção de trocar.

Nova `loadDealPhoneOptions(dealId)` substitui `loadDealContact`: busca
o contato principal (`CONTACT_ID`) + demais contatos anexados via
`crm.deal.contact.items.get` (API padrão do Bitrix pra "múltiplos
contatos" de um deal — protegida por `try/catch`, se o recurso não
estiver habilitado no CRM cai de volta só no `CONTACT_ID`, sem
quebrar) + o valor do campo `UF_CRM_1752095090` se preenchido. Dedupe
por telefone normalizado. Prioridade de seleção padrão confirmada com
o usuário: campo "número correto" > contato principal > primeiro
contato anexado.

`state.phoneOptions` guarda a lista; seletor (`#phoneSelect`, mesmo
estilo visual do `#instanceSelect` já existente) só aparece no
cabeçalho do chat quando `entityType === 'deal'` e há mais de 1 opção.
`boot()` foi reestruturado: a parte de "telefone conhecido →
`loadInstances`/`pickBestInstance`/`ensureConnected`" virou
`resolvePhoneAndConnect(phone, name)`, reaproveitada tanto no boot
inicial quanto em `switchPhone(newPhone)` (troca de número no
seletor — já que `hasHistory`/melhor instância dependem do telefone
escolhido, não dá pra só trocar `state.phone` e re-renderizar).

Validação: sintaxe OK (`vm.Script`/`new Function`) em chat.html e
index.html. Pendente: confirmar em produção, num negócio real com mais
de 1 contato anexado, que `crm.deal.contact.items.get` retorna os
contatos adicionais esperados (depende do recurso "múltiplos contatos"
estar habilitado no CRM do escritório).

## 22. Lembrete automático de WhatsApp removido a pedido do usuário (2026-10-01)

Usuário pediu explicitamente pra não disparar mais nenhuma mensagem/
notificação automática pras pessoas, antes de subir as mudanças do
item 21 pro Git. Removido por completo (não só desativado):

- `require('./whatsappReminderPoller').startPolling()` tirado de
  `src/server.js` (chamada no boot do processo).
- `src/whatsappReminderPoller.js` apagado por inteiro (ver itens 19 e
  a nota de troca de canal no HANDOFF — não é mais necessário manter
  o arquivo morto no código).
- `callBitrixHR` voltou a ser privado em `src/bitrixHierarchy.js` (só
  tinha sido exportado pra esse uso específico).

Filtro "WhatsApp: nunca conectou" no Admin (item 19) foi MANTIDO — é
só uma visualização passiva (não dispara nada sozinho), usuário
confirmou que pode ficar.

Validação: `node -c` em server.js e bitrixHierarchy.js; grep confirma
zero referência a `whatsappReminderPoller`/`im.notify.personal.add`/
`im.message.add` restante em `src/`.

## 23. Barra de gravação de áudio com enviar/cancelar explícitos (2026-10-01)

Usuário reportou que o fluxo de gravação de áudio não era intuitivo:
era 1 botão só (microfone) alternando iniciar gravação / parar+enviar
no mesmo clique, com o único indício visual sendo o próprio botão
ficando vermelho (`#micBtn.recording`) — sem nenhuma forma de cancelar
uma gravação feita por engano, só enviar ou enviar.

Trocado por uma barra de gravação dedicada (`#recordingBar`, mesmo
padrão visual do WhatsApp): ao clicar no microfone, o composer normal
(`#composerReply`) é escondido e a barra aparece no lugar — bolinha
vermelha pulsando + "Gravando áudio" + cronômetro (`0:00` crescente) +
botão de lixeira (cancela, descarta o áudio sem enviar) + botão de
seta (para a gravação e envia), lado a lado, nunca mais um clique só
decidindo os dois.

Implementação: `MediaRecorder` e o fluxo de captura (`getUserMedia`,
chunks, blob) continuam os mesmos de antes — só o que mudou é *como* a
gravação é finalizada. `stopRecording({discard})` virou o único ponto
de parada: `discard:true` (lixeira) marca `recordingDiscarded` e não
monta/envia o blob no handler `'stop'`; `discard:false` (seta) segue o
caminho de sempre (`sendRecordedAudio`).

Dois vazamentos de microfone corrigidos juntos (existiam mesmo antes
desta mudança, ficaram mais visíveis ao reorganizar o fluxo):
- Trocar pra aba "Nota interna" no meio de uma gravação agora CANCELA
  ela automaticamente — antes a gravação continuava em segundo plano
  (microfone captando áudio) mesmo com o composer de Resposta escondido.
- Trocar de conversa (`openConversation`) ou fechar a conversa
  (`closeConversation`) no meio de uma gravação agora também cancela —
  antes o composer era recriado do zero por `bindComposer()` (chamado a
  cada `renderConversationView`), a referência JS ao `MediaRecorder`
  antigo se perdia, mas o stream do microfone (`getUserMedia`) ficava
  preso aberto pra sempre (só é liberado dentro do handler `'stop'` do
  próprio objeto). Nova variável de módulo `stopActiveRecording`
  (reatribuída a cada `bindComposer()`) permite cancelar de fora.

Validação: sintaxe OK (scripts inline, `vm.Script`/`new Function`).
Teste isolado em Node simulando a máquina de estados (gravar→cancelar,
gravar→enviar, trocar de aba no meio, `stop()` chamado sem gravação
ativa) — 4 cenários corretos, nenhuma exceção.

## 24. Acesso à Auditoria de Conversas + painel de controle de chips por setor (2026-10-01)

Contexto do usuário: o DapZap vai passar a ser usado pra controlar os
CHIPS físicos de WhatsApp do escritório (todo chip precisa estar
conectado em algum usuário do sistema), não só canal de atendimento —
por isso virou necessário saber, com granularidade, quem já conectou,
quantos números cada um tem, quais são esses números, e como isso se
distribui por setor (Vendas/Jurídico/Administrativo/etc). O destino
final desses dados é um agente externo de disparo/leitura de resposta
(motivo explícito de ter pedido pra desfazer o lembrete automático do
item 22 — "consigo controlar melhor do que fazendo disparo em massa
programado pelo app").

**(a) Acesso à Auditoria de Conversas** — concedido manualmente via
`conversationAnalysisGrants.grantAccess()` (rotas já existiam,
`POST /conversation-analysis/admin/grants/:ownerId`, só sem UI) pros
owner_ids do usuário (`..._5305`) e do Dr. Bruno (`..._1`), rodado
via SSH/`node -e` direto no container.

**(b) Macro-setor por colaborador** — a árvore de departamentos do
Bitrix tem 216 nós (confirmado via `department.get` 2026-10-01), com
um ramo próprio por gestor/vendedor individual dentro de Vendas (ex:
"[GER] Diego Cordeiro | 725"). Agrupar pelo departamento-FOLHA
(`UF_DEPARTMENT` direto) resultaria em dezenas de "setores" de 1
pessoa só. Nova `buildTopLevelDepartmentMap(departments)` em
`src/bitrixHierarchy.js` sobe a árvore de `PARENT` a partir de cada
departamento até achar o nível logo abaixo da raiz (id `'1'`,
"Presidência", confirmado com o usuário como o único nó sem `PARENT`)
— esse nível É o macro-setor (ADMINISTRATIVO, FINANCEIRO, NEGOCIAÇÃO
E ACORDOS, VENDAS, JURÍDICO, SEM DEPARTAMENTO). Cacheada em memória do
processo (`topLevelDeptCache`, mesmo TTL de `HIERARCHY_CACHE_TTL_MS`)
pra não repetir a chamada a `department.get` em toda listagem. Nova
`listEmployeesWithDepartment()` (reaproveitada por `GET /admin/users`
em vez de `listEmployees()`) devolve cada funcionário já com o campo
`department` resolvido, e também `bitrixUserId` (ID numérico puro,
sem o prefixo de `ownerId`) pro CSV exportável.

**(c) UI em admin.html (aba Usuários)** — nova coluna "Setor" na
tabela (e ID do Bitrix visível junto do cargo, embaixo do nome), novo
filtro "Setor: todos/X" (mesmo padrão dos filtros já existentes),
novo painel `#usersDeptSummary` logo acima da tabela: um card por
macro-setor mostrando "N de T colaboradores conectou" + "M números de
WhatsApp ao todo" — calculado sobre o universo TOTAL (`usersRows`),
não o filtrado, pra sempre mostrar o panorama completo independente
de busca/filtro ativo na tabela abaixo. CSV export ganhou as colunas
Setor e ID Bitrix (`u.instances` com label+telefone por conexão já
existia desde o item 19 — "quais números" já estava coberto).

Validação: sintaxe OK (scripts inline + `node -c`). Teste isolado em
Node da resolução de macro-setor com a árvore REAL de departamentos
colada pelo usuário (13 cenários, incluindo nó órfão sem pai
resolvível) — todos corretos após corrigir um bug de lógica na 1ª
tentativa (comparava com "avô inexistente" em vez de com a raiz fixa,
retornava o NOME DO PAI errado pra departamentos de 2º nível como
ADMINISTRATIVO). Teste isolado da agregação por setor (contagem de
conectados/total/números) — 7 cenários corretos.

## 25. Delegação automática por hierarquia desativada (privacidade) + admin força compartilhamento manual (2026-10-01)

Usuário levantou questão de privacidade: gestor enxergava automaticamente
as conversas/instâncias de TODO subordinado dele na hierarquia do Bitrix
(feature de `src/bitrixHierarchy.js`/`hierarchy_subordinates`, item mais
antigo do projeto), sem ninguém ter pedido isso explicitamente. Pedido:
desligar essa atribuição automática até uma regra própria ser definida,
mas MANTER a delegação manual já existente ("Compartilhar acesso" em
instances.html — o próprio dono escolhendo compartilhar).

**(a) Desativação da hierarquia automática** — `src/instances.js`
(`listAccessible`, usada por `GET /instances`/Chat/sidebar) perdeu o
3º `union` da query (que juntava `hierarchy_subordinates`) e a chamada a
`ensureHierarchyCacheFresh()`. `src/authz.js` (`assertOwnsSession`,
portão central de toda rota com `requireSession`/`requireResourceOwner`)
perdeu o passo de checar `getSubordinates(ownerId)` como último critério
de acesso — agora só dono direto ou delegado manual (`instance_delegates`)
passam. `getSubordinates`/`hierarchy_subordinates`/`refreshHierarchyCache`
NÃO foram removidos (só deixaram de ser consultados nesses 2 pontos) —
ficam prontos pra reativar (código comentado em `assertOwnsSession`)
quando o usuário definir a regra nova. `GET /instances/eligible-delegates`
(sugestão de quem é elegível a RECEBER uma delegação manual) continua
usando `getSubordinates` normalmente — isso nunca foi a feature
questionada, é só um filtro de sugestão pra quem já está compartilhando
conscientemente.

**(b) Admin força compartilhamento manual entre qualquer par de pessoas**
— pedido complementar: "se der pra eu escolher qual usuário é o gestor
na hora de compartilhar seria bom pq a hierarquia da empresa é meio
errada as vezes". Novas `instancesStore.addDelegateAsAdmin`/
`removeDelegateAsAdmin` (mesma tabela `instance_delegates`, sem exigir
que o chamador seja o dono real — a autorização fica inteiramente na
rota) e rotas `GET/POST/DELETE /admin/instances/:id/delegates`
(`requireSuperAdmin`). Na aba Usuários do Admin, nova ação "Compartilhar
instância" no menu de cada colaborador (só aparece se ele tiver pelo
menos 1 instância) abre um modal: escolhe qual instância, busca o
destinatário LOCALMENTE em `usersRows` (nome/e-mail, já carregado — sem
BX24.callMethod nem filtro de hierarquia, de propósito irrestrito), lista
quem já tem acesso com botão de remover. `instancesByOwner` em
`GET /admin/users` ganhou o campo `id` de cada instância (antes só
label/phone, suficiente pra exibição mas não pra identificar qual
compartilhar).

Validação: sintaxe OK (scripts inline + `node -c` em authz.js,
instances.js, routes/whatsapp.js). Teste isolado em Node da lógica de
filtro de destinatários (busca por nome/e-mail, excluindo o próprio
dono) — 3 cenários corretos.
