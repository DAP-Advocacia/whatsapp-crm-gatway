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
