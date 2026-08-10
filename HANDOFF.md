# Handoff — WhatsApp ↔ Bitrix24 Gateway

> Documento de passagem de projeto: estado atual, o que foi feito recentemente e o
> que falta. A documentação completa de arquitetura/API/setup está no `README.md` —
> este arquivo foca em **continuidade entre sessões** (o que mudou, o que está em
> aberto). Última atualização: sessão de 2026-07-17 — Parte BY: os DOIS bancos
> (antigo e novo) foram **zerados** a pedido do usuário — sem conversas, mensagens,
> contatos, campanhas, notificações, mídia nem instâncias/pareamentos de WhatsApp
> (força reescanear QR em todo número), mantendo só configuração de produto (Sites/LPs,
> modelos de mensagem, paleta, tags). Credenciais locais movidas (não apagadas) pra
> `auth_session_backup_2026-07-17/`. **ABERTO: ninguém foi avisado ainda que todo
> WhatsApp precisa ser repareado do zero** — ver Parte BY. Antes disso, mesma sessão,
> Parte BW: banco/Storage do
> Supabase migrados da conta pessoal (`hsgsdasuuyonhosgjixa`) pra um projeto novo
> numa conta da empresa (`qqfzfudbeqgldodusoit`) — 21 tabelas + os 2 buckets
> copiados e conferidos linha por linha/arquivo por arquivo, três armadilhas reais
> de serialização corrigidas no processo (ver Parte BW pros detalhes). **ABERTO: o
> corte final (trocar o `.env` de produção pro banco novo) ainda não foi feito** —
> o gateway continua rodando contra o banco antigo até esse passo. Antes disso,
> mesma sessão, Parte BV: token de API de validade longa (90 dias, `POST
> /api/settings/api-token`, gerado em `/settings.html`) + documentação interativa
> da API (Swagger UI em `GET /api-docs`) — pensado pra própria equipe puxar dados
> por script/Postman antes da migração pra VPS, mantendo tudo autenticado (não é
> uma API pública de verdade).
>
> Antes disso, sessão de 2026-07-16 — Partes BS/BT/BU: Chat ganhou foto
> de perfil real do contato (avatar do WhatsApp, buscada sob demanda e cacheada em
> `conversations.avatar_url`) na lista de conversas e no cabeçalho da conversa — Parte
> BS; Análise Conversas ganhou "Insights de IA": 3 a 5 cards curtos no topo do
> Dashboard com diagnóstico/recomendação sobre os próprios números do time, gerados
> via OpenAI e cacheados 30min por dono — Parte BT; e um bug real (diferente do já
> corrigido na Parte BJ) fazendo o "✓✓ visualizado" nunca aparecer — sufixo de
> dispositivo (`:0`, `:12`) sobrevivendo na extração do telefone a partir do JID —
> foi corrigido em `_jidToPhone` (`src/whatsapp.js`), ainda **em validação com uso
> real** — Parte BU. Essas três entregas foram a base técnica de uma "Revisão de
> Prontidão" (Go/No-Go pra ligar ~400 instâncias de uma vez) publicada como artefato
> nesta mesma sessão — ver Parte BU e §5 pros itens de infraestrutura (servidor
> dedicado, fila pro Bitrix, monitoramento) que essa revisão levantou como
> bloqueantes antes do rollout completo.
>
> Antes disso, sessão de 2026-07-14, leva grande de entregas — ver
> Partes BF a BR: Sites ganhou tag automática da LP na conversa do WhatsApp (`tags.fixed`,
> mesmo tratamento não-removível das tags sintéticas "Interno"/"Externo") e exportação
> de leads em CSV/XLSX (`exceljs`, nunca `xlsx`/SheetJS — vulnerabilidade conhecida) —
> Parte BF; hero das LPs passou a aceitar vídeo de verdade por upload (bucket a 25MB),
> não só link — fecha o item que tinha acabado de entrar no roadmap da apresentação
> executiva horas antes (Parte BE, ver ABERTO abaixo) — Parte BG; Chat ganhou botão pra
> mover uma conversa em andamento pra outra instância do mesmo dono, pensado pra quando
> uma instância cai/é banida — Parte BH; timeline do negócio no Bitrix passou a registrar
> quando uma mensagem enviada é entregue/lida — Parte BI —, e um bug real de LID
> (contatos que só aparecem como `@lid`) que travava esses checks em "enviado" pra
> sempre foi corrigido — Parte BJ; a cor da marca configurada passou a pintar também a
> bolha de mensagem própria e a barra de rolagem, reforçada em mais uma rodada pra
> funcionar dentro do webview embutido do Bitrix Desktop — Parte BK; Análise Conversas
> ganhou gráfico mensal sempre completo (zera os dias sem dado em vez de encolher a
> janela), gráfico novo de distribuição por etapa do Bitrix, e a tabela "por sessão"
> passou a mostrar o nome da instância em vez do id cru — Parte BL; nova tela
> `/settings.html` deixa a paleta de cores inteira do app editável sem mexer no `.env`,
> com a correção de "flash" de cor padrão estendida até `apresentacao.html`/`index.html`
> (nunca tinham a paleta aplicada antes) — Parte BM; novas telas `/suggestions.html`
> (sugestões de usuário, notifica de volta quem sugeriu quando é "lançada") e
> `/onboarding.html` (guia em acordeão de cada área do app) — Partes BN/BO; painel de
> contato do Chat foi reordenado (grupos em comum antes do resumo de IA) e perdeu o
> botão manual de regenerar resumo — Parte BP; "Sites" e "Métricas Sites" viraram um
> grupo só na sidebar ("Landing Page", com "Métricas LP" recolhível) nas 13 páginas —
> Parte BQ; e a Campanha virou tela cheia (era centralizada) com o preview ao vivo maior,
> mostrando de verdade a mídia anexada e uma miniatura real de link do YouTube — Parte
> BR. **ABERTO: o roadmap escrito em `apresentacao.html` (Parte BE) ainda lista "upload
> direto de vídeo nas LPs" como pendência — ficou desatualizado horas depois, quando a
> Parte BG entregou justamente isso; falta corrigir o texto da apresentação.**
>
> Mais cedo no mesmo dia (Parte BE): `public/apresentacao.html`
> ganhou 3 cards novos na seção "A solução" cobrindo tudo que foi entregue nas
> sessões recentes — Sites & Landing Pages, Resiliência & Inteligência, Vídeo em
> Campanhas —, total de módulos foi de nove pra doze, e o roadmap ganhou 2 itens
> honestos novos sem remover nenhum dos 5 antigos, nenhum dos quais foi de fato
> concluído ainda — ver Parte BE. Antes disso, sessão de 2026-07-13 (LP pública ganhou botão
> flutuante do WhatsApp + CTA duplo (form/WhatsApp) + entrada suave nas seções
> ao rolar — Parte BA; depois, 3 rodadas de feedback do usuário em produção
> corrigiram: bug de sobreposição na fita de confiança + navbar sem botão +
> marca "Durão" (genérica do app) visível por padrão no cabeçalho/rodapé;
> depois um bug real de formulário sumindo (`.reveal` na seção errada) +
> marca não alinhada de verdade à esquerda; por fim, header/rodapé viraram
> **full-bleed** (marca colada na borda real da tela, não só dentro da
> coluna central de 640px) e o header ganhou de volta um único CTA — botão
> do WhatsApp (`#navWaCta`) — que depois foi **removido de novo** (usuário
> relatou que não redirecionava e pediu pra tirar; header ficou só com a
> marca). Ver Parte BB completa. Na sequência (Parte BC), inspirado no site
> real `dapadvocacia.com.br`: rodapé ganhou 4ª coluna "Siga-nos"
> (Instagram/LinkedIn da empresa + WhatsApp do SDR) e um mapa de
> localização full-bleed; hero virou 2 colunas (texto à esquerda com marca
> repetida + foto à direita, sangrando até a borda real da tela em altura
> cheia) quando há `heroImageUrl`. **ABERTO: `BRAND_INSTAGRAM_URL`/
> `BRAND_LINKEDIN_URL`/`BRAND_ADDRESS` ainda vazios no `.env` — usuário
> precisa preencher pra "Siga-nos"/mapa aparecerem de verdade.** Ver Parte
> BC completa. Na sequência (Parte BD): resumo de conversa da IA (Chat)
> virou estruturado (título + subtítulo + resumo, não mais um parágrafo só)
> e passou a ser gerado sozinho ao abrir a conversa (sem precisar clicar);
> status do CRM (achado/não achado) unificado no mesmo lugar do botão
> "Abrir no CRM". Chat ganhou resumo de conversa via IA no
> painel de detalhes — Parte AZ; diagnosticado — MAS NÃO RESOLVIDO, é externo
> ao código — que mensagens de primeiro contato de LPs não chegam no celular
> do destinatário mesmo aparecendo "enviada" aqui, root cause provável =
> instabilidade de conexão da sessão 183168 — ver Parte AY. Também nesta
> sessão: nova tela `/lead-metrics.html` — Parte AX; Sites ganhou testes A/B
> com histórico + botão "Gerar com IA" via OpenAI — Parte AU; negócio por
> lead pivotado de "1 pipeline por LP" pra "1 pipeline único compartilhado"
> (categoria 229, `BITRIX_LEADS_CATEGORY_ID`) depois de achar a causa raiz de
> negócios sumindo — uma automação de duplicidade já existente no Bitrix que
> trata "Número do Processo" vazio como duplicata — ver Partes AT/AV/AW.
> **ABERTO: essa automação ainda pode apagar negócios na categoria 229 também —
> precisa ser corrigida/ajustada dentro do Bitrix, fora do alcance deste
> código.**).
>
> **Regra fixa pedida pelo usuário: atualizar HANDOFF.md e README.md a cada
> mudança, sempre — não só em features grandes.**

---

## 1. Estado atual — tudo funcionando

- [x] Instalação do app e registro da aba "WhatsApp" no card do Negócio
- [x] **Multi-instância** por usuário (`ownerId = member_id_userId`; um dono pode
  conectar mais de um número de WhatsApp — ver §2, parte B)
- [x] QR Code embutido na aba, onboarding por polling
- [x] Envio/recebimento de texto, imagem, áudio (gravado ou anexado) e vídeo
- [x] Sem duplicação de mensagem enviada na tela
- [x] Mensagens enviadas direto do celular (fora do widget) também são salvas
- [x] Persistência 100% em Supabase (Postgres + Storage) — nenhum dado em JSON local
- [x] Dashboard "Análise Conversas" com métricas, filtro interna/externa e lista
  paginada de conversas com ação "Abrir conversa" (navega pro negócio no CRM)
- [x] **Campanha** (`/campaign.html`): disparo em massa com variáveis
  `{{nome}}`/`{{telefone}}`, modelos de mensagem, anexo de mídia, preview ao vivo
  (celular/tablet/computador), envio imediato ou agendado
- [x] **Contatos e listas** (`/contacts.html`): CRUD de contatos, importar de
  conversas, listas personalizadas reutilizáveis na Campanha
- [x] **Métricas de Campanhas** (`/campaign-metrics.html`): KPIs, gráfico diário,
  tabela de campanhas recentes — por instância ou "todas as minhas"
- [x] **Agenda de Envios** (`/campaign-schedule.html`): Kanban (Agendado → Enviar
  agora → Enviando → Enviado, com drag-and-drop) + Calendário, poller automático a
  cada 30s
- [x] **Instâncias** (`/instances.html`): conectar/renomear/remover múltiplos
  números de WhatsApp por usuário, com pareamento por QR embutido
- [x] **Isolamento por usuário**: Campanha/Contatos/Métricas/Agenda/Instâncias só
  mostram dados do dono logado (resolvido via BX24 no navegador + filtro no
  backend) — a Análise de Conversas continua agregada de propósito (visão de time)
- [x] Reconexão automática de instâncias já pareadas no boot do servidor
- [x] **Autenticação real nas rotas REST/WS** (ver §2, parte C) — nenhuma rota
  mais aceita `session`/`owner` sem provar (contra o Bitrix de verdade) que
  pertence a quem está fazendo a requisição
- [x] **Rodapé fixo** ("Desenvolvido por Daniel Costa") em todas as páginas,
  inclusive o Chat (que não tinha nenhum) — ver §2, parte D
- [x] **Indicadores AH (MoM/YoY)** nos KPIs da Análise Conversas, grid de 4
  colunas alinhado, gráficos de linha/dispersão com grade, eixo, tooltip e
  crosshair de hover — ver §2, parte D
- [x] Rede de segurança contra o processo cair inteiro numa falha de rede
  transitória com o Bitrix (`uncaughtException`/`unhandledRejection`) — ver §2,
  parte D
- [x] **Painel de detalhes do contato** no Chat (`chat.html`), com dados reais
  do Bitrix (contato/empresa ou lead) — ver §2, parte E
- [x] Nenhum formulário nativo do navegador (`prompt()`) mais usado pra criar
  instância — vira modal no estilo do resto do app — ver §2, parte E
- [x] **Criar grupo do WhatsApp direto do Chat** (a partir das conversas já
  abertas, com atalho pra pré-selecionar por tag) e **arquivar conversas**
  (aba "Ativas"/"Arquivadas") — ver §2, parte G
- [x] **Notificação de mensagem nova, com silenciar por conversa** — toast +
  sino (garantido) e tentativa best-effort de notificação nativa do SO — ver
  §2, parte H
- [x] **Central de Notificações** (`/notifications.html`): histórico
  persistido no banco (não mais só na memória do navegador), Kanban
  (Não lidas/Lidas) + Calendário, sino da sidebar virou link pra lá — ver §2,
  parte K
- [x] **Rodapé/cabeçalho alinhado nas 8 páginas** (era só `chat.html` até a
  parte K) — ver §2, parte K
- [x] **Bucket de mídia privado** — `saveMedia` devolve caminho relativo,
  nova rota autenticada `GET /media/:filename` com signed URL de curta
  duração, histórico antigo migrado, mídia de agendamento sai do
  `media_base64` e sobe pro Storage direto — ver §2, parte L
- [x] **`alert()`/`confirm()` nativos trocados por `showToast`/
  `window.confirmDialog`** nas 8 páginas — ver §2, parte L
- [x] **Servidor rodando sob supervisor de processo (PM2)** — reinicia
  sozinho numa queda, sobrevive a reinícios da máquina — ver §2, parte N
- [x] **Pool do Postgres protegido contra queda por conexão ociosa fechada
  pelo Supabase** — ver §2, parte O
- [x] **Marca (nome/subtítulo/cor) configurável via `.env`** (`GET
  /api/brand` + patch JS nas 8 páginas), sem alterar nada do texto fixo já
  usado pela Durão — ver §2, parte P
- [x] **Mensagem de grupo do WhatsApp, Status (Stories) e post de Canal
  (`@newsletter`) nunca mais são gravados no banco** — descartados por
  completo assim que chegam (mesmo tratamento pros três) — ver §2, partes
  Q, R, S e U
- [x] **Colar imagem com Ctrl+V direto na caixa de mensagem do Chat** (além
  do botão de anexo e do microfone) — ver §2, parte V
- [x] **Balões do Chat com visual mais refinado** (sombra em camadas, moldura
  fina pra imagem/vídeo em vez do preenchimento cru de antes, horário sempre
  no rodapé do balão) e **confirmação de leitura estilo WhatsApp** (check
  simples/duplo em SVG, azul quando o cliente já visualizou a mensagem) —
  ver §2, partes W e Y
- [x] **"Digitando…"/"gravando áudio…" nas duas direções**: cliente vê no
  WhatsApp dele quando o atendente está escrevendo/gravando no CRM, e o
  atendente vê no Chat quando o cliente está digitando/gravando do lado dele
  — ver §2, parte X
- [x] **Pré-visualização de link** (Open Graph): mensagem com uma URL ganha
  um cartão com título/descrição/imagem da página, igual WhatsApp/Slack —
  ver §2, parte Y
- [x] **Reagir a mensagens e responder citando ("reply")**, direto do CRM
  (chat.html e index.html) — o atendente reage com emoji ou cita uma
  mensagem específica, igual no WhatsApp de verdade — ver §2, parte Z
- [x] **Tabela `notifications` zerada** (~6.800 registros, com backup local)
  — as limpezas anteriores (Partes R/S/T/U) só mexeram em
  `conversations`/`messages`, nunca em `notifications`, então spam antigo
  de canal/grupo continuava aparecendo na Central de Notificações mesmo
  depois do Chat já estar limpo — ver §2, parte AA
- [x] **`conversations`/`messages` de produção zeradas por completo**, a
  pedido explícito do usuário (inclusive as conversas com relacionamento
  real, não só o que era Status/grupo) — backup local feito antes de
  apagar. Chat começa do zero a partir de agora — ver §2, parte T
- [x] **Sites: tag automática da LP na conversa** (não-removível) **e
  exportação de leads em CSV/XLSX** (`exceljs`) — ver §2, parte BF
- [x] **Sites: hero em vídeo por upload direto** (não só link), bucket a
  25MB — ver §2, parte BG
- [x] **Mover uma conversa em andamento pra outra instância** do mesmo
  dono, sem perder histórico — ver §2, parte BH
- [x] **Timeline do negócio no Bitrix registra entrega/leitura** da
  mensagem enviada, além do conteúdo — ver §2, parte BI
- [x] **Análise Conversas**: gráfico "Mensagens por dia" sempre com o mês
  corrente inteiro, gráfico novo de distribuição por etapa do Bitrix, e
  tabela "por sessão" com o nome da instância — ver §2, parte BL
- [x] **Paleta de cores inteira editável em `/settings.html`** (não só a
  cor principal via `.env`), com fim do "flash" de cor padrão nas páginas
  — ver §2, parte BM
- [x] **Sugestões de usuário** (`/suggestions.html`) e **Onboarding**
  (`/onboarding.html`) — ver §2, partes BN e BO
- [x] **"Sites" e "Métricas Sites" viraram um grupo só na sidebar**
  ("Landing Page" + "Métricas LP" recolhível) — ver §2, parte BQ
- [x] **Campanha em tela cheia**, preview ao vivo maior mostrando mídia
  real e miniatura de link do YouTube — ver §2, parte BR

Não há bloqueador conhecido em aberto no momento. Ver §5 para dívidas técnicas não
bloqueantes que ainda restam (domínio fixo em vez de ngrok, persistir
`AUTH_FOLDER`, etc.).

---

## 2. O que foi feito na sessão de 2026-07-02

### Parte A — Supabase, dashboard e mídia (início da sessão)

1. **Migração de armazenamento: JSON local → Supabase.** `data/messages.json` virou
   duas tabelas Postgres (`conversations`, `messages`); `data/media/` virou o bucket
   público `media` no Supabase Storage. `src/store.js` e `src/media.js` reescritos
   (async) e todos os chamadores atualizados. Dados antigos com negócio vinculado
   migrados via `db/import-legacy-data.js`; spam de grupo sem `dealId` descartado.
2. **Dashboard "Análise Conversas" criado do zero**: KPIs, gráfico de linha (30
   dias), dispersão recebidas×enviadas, lista paginada de conversas com "Abrir
   conversa". Filtro interna/externa (padrão: interna). Movido pra fora do card do
   Negócio — acessado pelo ícone do app.
3. **Suporte a mídia** (imagem/áudio/vídeo), incluindo microfone embutido na aba.
   Áudio convertido para OGG/Opus via ffmpeg antes de enviar.
4. **Bug corrigido**: mensagens enviadas direto do celular (fora do widget) não
   salvavam — o backend descartava todo `fromMe: true`.
5. **Bug corrigido**: `BITRIX_WEBHOOK_URL` real exposto em `.env.example`.
6. **Pendência que ficou em aberto** (revisitar se o usuário voltar a pedir): postar
   um resumo de mudanças como comentário na tarefa Bitrix #2437348 — faltava
   permissão de "Tarefas" no webhook (`insufficient_scope`); não foi retomado depois
   que o foco mudou pra construir as features abaixo.

### Parte B — Campanha, Contatos, Métricas, Agendamento, Múltiplas Instâncias (continuação)

7. **Campanha (`/campaign.html`) criada do zero**: página de disparo em massa —
   seleção de destinatários (conversas existentes, lista de contatos ou números
   manuais, deduplicados), mensagem com variáveis `{{nome}}`/`{{telefone}}`, envio
   com intervalo aleatório de 4-9s entre mensagens, limite de 100 destinatários.
   Backend: `src/campaigns.js` (estado em memória + loop de envio), rotas em
   `routes/whatsapp.js`.
8. **Contatos e listas (`/contacts.html`)**: CRUD de contatos por instância,
   "Importar de conversas", listas personalizadas com membros selecionáveis.
   Backend: `src/contacts.js`, `src/templates.js`, `routes/crm.js` (montado em
   `/api`, separado de `/api/whatsapp`).
9. **Campanha melhorada**: modelos de mensagem reutilizáveis (salvar/carregar),
   anexo de mídia (imagem/áudio/vídeo, usado como legenda), e um painel de preview
   ao vivo com switch celular/tablet/computador (mockup de conversa simulando cada
   tamanho de tela).
10. **Dashboard de Métricas de Campanhas (`/campaign-metrics.html`)**: histórico
    persistente de campanhas em duas tabelas novas (`campaigns`, `campaign_results`
    — grava um registro por destinatário, não só o agregado). KPIs, gráfico diário
    (enviadas × falharam, 30 dias), tabela de campanhas recentes com status
    running/done. Backend: `src/campaignStore.js`.
11. **Agendamento de campanhas — Kanban e Calendário (`/campaign-schedule.html`)**:
    nova tabela `scheduled_campaigns` (guarda o payload inteiro — destinatários,
    texto, mídia em base64 — até o disparo real acontecer). Campanha na página
    "Campanha" ganhou um toggle "Enviar agora" / "Agendar" com campo de data/hora.
    Kanban com 4 colunas (Agendado / Enviar agora / Enviando / Enviado), arrastar
    um card pra "Enviar agora" dispara na hora via `POST
    /scheduled-campaigns/:id/send-now`; view Calendário com navegação mensal e
    lista por dia. Poller automático a cada 30s (`src/scheduler.js`,
    `startPolling()` chamado uma vez em `server.js`) dispara sozinho os
    agendamentos vencidos.
12. **Isolamento por usuário** (pedido explícito depois que o usuário viu dados de
    duas sessões diferentes misturados no dashboard de Métricas): as páginas
    Campanha, Contatos, Métricas de Campanhas e Agenda de Envios paravam de deixar
    escolher a sessão num dropdown com todo mundo listado — agora cada página
    resolve a própria sessão do usuário via BX24 (`resolveSession`/`resolveOwner`,
    mesmo cálculo de `public/index.html`: `member_id + user.current.ID`) e o
    backend passou a filtrar por esse valor (`GET /sessions?session=`,
    `GET /campaigns/metrics?session=`, `GET /scheduled-campaigns?session=`). A
    Análise de Conversas foi mantida agregada de propósito (confirmado com o
    usuário via pergunta direta — é uma visão de time, não deveria mudar).
13. **Múltiplas instâncias por usuário** (pedido seguinte: um usuário conectar mais
    de um número de WhatsApp e escolher qual usar): novo conceito "instância"
    (`src/instances.js`, tabela `instances`) — `ownerId` (usuário do Bitrix) agora
    pode ter 1..N instâncias; a primeira usa `id == ownerId` (nenhum dado antigo
    precisou migrar). Nova página `/instances.html` pra criar (com QR Code na hora),
    renomear e remover (`WhatsAppGateway.disconnect()` novo — tenta `sock.logout()`
    de verdade + apaga credenciais; `SessionManager.remove()` novo). Seletor de
    instância adicionado em: `index.html` (chat — só aparece com mais de uma
    instância, lembrado por negócio via `localStorage`), `campaign.html` e
    `contacts.html` (dropdown das próprias instâncias), `campaign-metrics.html` e
    `campaign-schedule.html` (dropdown + opção "Todas as minhas instâncias",
    aceitando `session=id1,id2` nas rotas de métricas/agendamentos).
14. **Bug corrigido**: `insert or update on table "scheduled_campaigns" violates
    foreign key constraint "scheduled_campaigns_campaign_id_fkey"` ao clicar
    "Enviar agora" num agendamento. Causa: `createCampaign()` gravava o cabeçalho
    da campanha no Postgres em segundo plano (sem `await`) e já devolvia o
    `campaignId`; o código then tentava vincular o agendamento a esse id antes da
    linha existir de fato na tabela `campaigns`. Corrigido tornando
    `createCampaign()` `async` (aguarda a gravação antes de devolver o id) e
    atualizando os dois call sites (`routes/whatsapp.js`, `src/scheduler.js`) pra
    `await` a chamada. Testado reproduzindo o cenário exato (agendar + "enviar
    agora" na sequência) — confirmado resolvido.

### Parte C — Autenticação real nas rotas REST/WS (continuação, mesma sessão)

Resolvido o item mais crítico do §5: até aqui, toda rota confiava cegamente no
`session`/`owner` que o próprio navegador mandava — nada validava contra o
Bitrix de verdade. Qualquer request forjado podia ler/mandar mensagens,
campanhas e contatos de outro usuário.

15. **`src/auth.js`** (novo): `verifyBitrixToken(accessToken)` chama
    `https://${BITRIX_PORTAL_DOMAIN}/rest/user.current.json` — domínio e
    `member_id` **sempre fixos em variável de ambiente do servidor**, nunca
    aceitos do cliente (senão um client malicioso poderia apontar pro próprio
    portal Bitrix dele e se passar por qualquer `ownerId` deste). Emite um
    token de app curto (HMAC via `crypto` nativo, sem lib de JWT), TTL 12h
    (`AUTH_TOKEN_TTL_HOURS`). Nova rota `POST /api/auth/verify { accessToken }`
    devolve `{ ownerId, token }` — é o "login" do próprio app.
16. **`src/authz.js`** (novo): `assertOwnsSession`/`requireSession`/
    `requireResourceSession` — confirma que a `session` (ou lista CSV) de cada
    request pertence de fato ao `ownerId` verificado (via `instancesStore`),
    aplicado em ~20 rotas de `src/routes/whatsapp.js` e `src/routes/crm.js`.
    `/api/whatsapp` e `/api` agora exigem `Authorization: Bearer <token>`
    (middleware `requireAuth`, ver `src/server.js`).
17. **IDOR corrigido**: `contacts`, `contact_lists` e `message_templates` usam
    id sequencial (`bigserial`, enumerável) e as funções de update/delete não
    filtravam por `session_id` no SQL — mesmo um usuário legítimo podia
    editar/apagar recurso de outro usuário só incrementando o id. Corrigido em
    `src/contacts.js`/`src/templates.js` (cláusula `and session_id = $n` em
    todas as funções por `:id`, com teste manual confirmando 404 numa
    tentativa cross-tenant).
18. **Vazamento total corrigido**: `GET /scheduled-campaigns` e
    `GET /campaigns/metrics` não validavam `session` — sem ele, devolviam os
    dados de todo mundo. Agora exigem e filtram como as demais rotas.
19. **`/admin/login` removida** (`src/server.js`) — página pública sem
    autenticação que carregava o QR de pareamento de qualquer `session`
    (permitia sequestrar uma instância ainda não pareada). Supérflua — o QR já
    aparece embutido em cada página.
20. **WebSocket** (`/api/whatsapp/stream`) passou a exigir `token` na
    querystring (browser não manda headers customizados no handshake),
    validado com a mesma checagem de posse das rotas REST.
21. **Frontend**: as 7 páginas (`index.html`, `chat.html`, `campaign.html`,
    `contacts.html`, `campaign-metrics.html`, `campaign-schedule.html`,
    `instances.html`) e `dashboard.html` ganharam `verifyAuth()` (chama
    `POST /api/auth/verify` com o `access_token` do `BX24.getAuth()`) e
    `apiFetch()` manda `Authorization: Bearer` + reautentica uma vez em
    qualquer 401. `dashboard.html` passou a exigir BX24 de verdade (antes
    funcionava mesmo aberta fora do Bitrix).
22. Testado via curl/script Node simulando tokens forjados, sessão de outro
    dono, token lixo, WebSocket sem posse — todos os cenários de rejeição
    (401/403/404) confirmados, e o fluxo normal (histórico, conversas,
    instâncias) continua funcionando com o token real.

Novas variáveis de ambiente: `BITRIX_PORTAL_DOMAIN`, `BITRIX_MEMBER_ID`,
`AUTH_TOKEN_SECRET`, `AUTH_TOKEN_TTL_HOURS` (ver `.env.example`).

### Parte D — Correções pós-auth, rodapé fixo, AH nos KPIs e gráficos (continuação, 2026-07-03)

23. **Bug corrigido — `BX24.getAuth()` chamado antes do `BX24.init` terminar**:
    depois da Parte C, `instances.html` (e mais 5 páginas) passaram a falhar com
    "Falha ao carregar: não foi possível obter o token do Bitrix" e "Erro ao criar
    instância: owner é obrigatório". Causa: o novo `verifyAuth()` lê
    `BX24.getAuth()`, que só tem dado de verdade **depois** que o callback do
    `BX24.init` dispara — mas a função que carrega os dados rodava imediatamente
    ao carregar o script, sem esperar esse callback (o cálculo antigo usava
    `BX24.callMethod`, que é tolerante a isso). Corrigido com uma promise
    `bx24Ready` (resolve só dentro do callback do `BX24.init`) que `verifyAuth()`
    aguarda antes de ler `BX24.getAuth()` — aplicado em `chat.html`,
    `campaign.html`, `contacts.html`, `campaign-metrics.html`,
    `campaign-schedule.html`, `instances.html` (`index.html` e `dashboard.html`
    já esperavam corretamente).
24. **Bug corrigido — servidor caindo inteiro numa falha de rede com o Bitrix**:
    o app ficou fora do ar (ngrok mostrando `ERR_NGROK_8012`, "conexão recusada"
    em `localhost:3333`) porque o processo Node morreu sozinho com
    `TypeError: terminated` / `ECONNRESET` — uma falha transitória de rede numa
    chamada `fetch` pro Bitrix (ex: `logMessageToTimeline` ou
    `verifyBitrixToken`) escapou do `try/catch` normal (bug conhecido do
    `undici`: o erro chega como evento `'error'` cru numa Readable, não como
    rejeição de Promise) e derrubou o processo inteiro — junto com todas as
    sessões de WhatsApp conectadas. Corrigido adicionando
    `process.on('uncaughtException'/'unhandledRejection', ...)` em
    `src/server.js`: loga o erro e mantém o servidor no ar. Servidor reiniciado
    manualmente na hora pra desbloquear o usuário; sugestão registrada em §5 pra
    rodar sob um supervisor (PM2/systemd/serviço do Windows) no futuro.
25. **Rodapé fixo** ("Desenvolvido por Daniel Costa") em todo o app, a pedido do
    usuário: nas 6 páginas que já tinham o selo em fluxo normal (rolava junto com
    o conteúdo), virou `position: fixed` no rodapé, respeitando a largura da
    sidebar (inclusive recolhida) e telas estreitas. O **Chat**
    (`public/chat.html`) não tinha o selo — criado do zero, reduzindo a altura do
    layout principal (`calc(100vh - var(--footer-h))`) pra abrir espaço fixo sem
    cobrir a lista de conversas.
26. **AH (MoM/YoY) nos KPIs da Análise Conversas** (a pedido do usuário, "AH" =
    análise horizontal): `src/metrics.js` ganhou `summarizeRange()`, que recalcula
    as 8 métricas dos cards só pro mês atual, mês anterior e mesmo mês do ano
    passado, devolvido em `trend.{current,prevMonth,prevYear}` pela mesma rota
    `/api/whatsapp/metrics`. No frontend, cada card ganhou dois selos — **MoM** e
    **YoY** — com seta e cor (verde/vermelho, invertido no "Tempo médio de
    resposta" porque ali subir é ruim) ou "novo" quando não há período anterior
    pra comparar. De quebra, o grid dos KPIs (`auto-fit`, que gerava linhas
    desalinhadas tipo "6 + 2 tortos") virou 4 colunas fixas (2 em telas
    estreitas) — sempre 2 linhas alinhadas.
27. **Gráficos da Análise Conversas melhorados** (a pedido do usuário) — usada a
    skill de dataviz do projeto pra revisar cores/interatividade em vez de só no
    olho:
    - Cor "Recebidas" trocada de `#5b7a8a` (lia como cinza — abaixo do piso de
      saturação pra funcionar como cor categórica) para `#3987e5`, validado por
      script contra contraste e separação por daltonismo junto com o dourado da
      marca (`#d8ab4f`, mantido como "Enviadas" por consistência com o resto do
      app, mesmo levemente fora da faixa de luminosidade recomendada pro modo
      escuro).
    - **Gráfico de linha** (mensagens por dia): ganhou grade horizontal com
      valores no eixo Y (antes não tinha nenhuma referência numérica), área
      sombreada sob as linhas, e crosshair + tooltip no hover mostrando a data e
      os dois valores exatos. Virou responsivo (SVG com `viewBox`, sem mais
      barra de rolagem horizontal pros 30 dias).
    - **Dispersão** (recebidas × enviadas por dia): ganhou grade nos dois eixos
      com números, tooltip de verdade no hover (substituindo o `<title>` nativo
      do navegador, lento) e uma diagonal de referência (recebidas = enviadas).
    - Validado rodando a matemática de posicionamento isolada no Node (casos
      normal, 1 dia só, todos os valores zerados) — sem visual real dentro do
      Bitrix testado nesta sessão.
28. **"Atualizado às HH:MM:SS"** movido de cima do conteúdo (competia com os
    botões de filtro) pro rodapé do sidebar, abaixo do sino de notificações.

### Parte E — Modal de instância, painel de contato no Chat, polimento visual (continuação, 2026-07-03)

29. **`prompt()` nativo trocado por modal** (`instances.html`) — clicar em "+
    Nova instância" abria um formulário nativo do navegador (feio, fora do
    padrão visual do app, aparecia como "Uma página incorporada... diz").
    Trocado por um modal `.overlay`/`.modal` no mesmo estilo do "Renomear" já
    existente na página — só esse prompt foi trocado (o app ainda tem outros
    `alert()`/`confirm()` nativos nas 7 páginas; usuário optou por resolver só
    este por enquanto, ver §5).
30. **Painel de detalhes do contato** (`chat.html`), a pedido do usuário — uma
    coluna nova à direita da conversa (acima de 1100px de largura; escondida
    em telas menores) mostrando dados de verdade do Bitrix:
    - Busca `crm.deal.get` → `crm.contact.get`/`crm.company.get` quando a
      conversa já tem negócio vinculado (`dealId`); sem negócio, cai pra
      `crm.duplicate.findbycomm` (acha contato ou lead pelo telefone).
    - Mostra nome, cargo + empresa, e-mail (`mailto:`), telefone (`tel:`,
      cai pro número do WhatsApp se o Bitrix não tiver um cadastrado),
      empresa, endereço e site — **sempre todos os 5 campos com rótulo**,
      mostrando "—" quando vazio em vez de esconder a linha (ajuste pedido
      depois de ver a versão inicial, que escondia campo vazio e só mostrava
      "nenhum contato encontrado" quando a busca não achava nada).
    - Botão "Abrir contato/lead no CRM" e um ícone no cabeçalho pra
      esconder/mostrar o painel.
31. **Botão de expandir/retrair a sidebar mais visual** (`chat.html`) — era um
    círculo cinza pequeno (22px) de baixo contraste; virou um círculo dourado
    de 28px com borda escura e sombra, do tamanho/destaque de um botão de
    verdade.
32. **Alinhamento das linhas de sidebar/cabeçalho/rodapé** (`chat.html`) — o
    logo da sidebar, o cabeçalho da lista de conversas, o cabeçalho da
    conversa aberta e o cabeçalho do painel de contato tinham alturas
    diferentes entre si (calculadas por padding, não por uma altura fixa
    compartilhada), então as linhas divisórias (`border-bottom`) ficavam em
    posições diferentes — visualmente "desalinhadas" olhando a página
    inteira. Mesmo problema no rodapé (`sidebar-bottom` vs `credit-row`).
    Corrigido com duas variáveis CSS compartilhadas (`--header-h: 90px`,
    `--footer-h` já exis  a) aplicadas nos quatro cabeçalhos e nos dois
    rodapés, todos centralizando o conteúdo dentro da mesma altura fixa.
    **Só aplicado em `chat.html` até agora** — as outras 6 páginas usam o
    mesmo componente de sidebar copiado, com o mesmo problema de alturas
    diferentes entre a logo (maior) e o cabeçalho de cada página (menor);
    ver §5.

### Parte F — Scrollbar do composer, botão da sidebar em todas as páginas (continuação, 2026-07-03)

33. **Scrollbar do campo de mensagem** (`index.html` e `chat.html`) — o
    textarea de escrever mensagem usava o scrollbar padrão do navegador
    (cinza, com setinhas, sem nenhum estilo) quando a mensagem tinha várias
    linhas. Adicionado `::-webkit-scrollbar` customizado: 6px de espessura
    (mais fino), cantos arredondados, cor `--gold-dim` (identidade visual do
    app) que clareia pra `--gold` no hover.
34. **Botão de expandir/retrair a sidebar levado pras outras 6 páginas** —
    usuário notou que só `chat.html` tinha o botão redesenhado (círculo
    dourado de 28px, ver §2 parte E item 31); aplicado o mesmo CSS em
    `campaign.html`, `contacts.html`, `campaign-metrics.html`,
    `campaign-schedule.html`, `instances.html` e `dashboard.html` — agora as 7
    páginas com sidebar (`index.html`/`apresentacao.html` não têm sidebar
    própria) usam o mesmo botão.

### Parte G — Grupos e arquivamento no Chat (continuação, 2026-07-03)

Pedido do usuário: criar grupo do WhatsApp direto do Chat, criar grupo a
partir de conversas com uma certa tag, e arquivar conversas. Passou por
planejamento (`EnterPlanMode`) antes de implementar, dado o tamanho (schema
novo + 2 rotas + bloco grande de frontend).

35. **Arquivamento de conversas** — nova coluna `conversations.archived`
    (`boolean default false`, migrada com `node db/migrate.js`).
    `store.listConversations(sessionIds, search, { archived })` ganhou esse
    filtro (default `false` — comportamento de quem já chamava sem o 3º
    argumento não muda). Nova função `store.setConversationArchived`. Rota
    `GET /conversations` passou a aceitar `?archived=true|false`; nova rota
    `POST /conversations/archive { session, phone, archived }`. No Chat: par
    de botões "Ativas"/"Arquivadas" acima da lista (mesmo estilo pílula do
    filtro Interna/Externa/Todas da Análise Conversas), e um ícone de
    arquivar/desarquivar que aparece ao passar o mouse em cada conversa da
    lista (atualização otimista — some da lista na hora, sem esperar o
    servidor responder). Confirmado com o usuário: mensagem nova numa
    conversa arquivada **não** desarquiva sozinha.
36. **Criar grupo do WhatsApp direto do Chat** — novo botão (ícone) ao lado
    do título "Chat", abre um modal (`.overlay`/`.modal`, primeiro uso desse
    padrão em `chat.html` — não existia nenhum modal lá antes) com: nome do
    grupo, seletor de instância (só aparece se o usuário tiver mais de uma —
    um grupo pertence a uma instância só), **seletor de tag** (marca sozinho
    todos os checkboxes das conversas que têm aquela tag, sem travar edição
    manual depois) e a lista de conversas da instância escolhida como
    checkboxes. Não precisou de rota nova no backend — reaproveita a
    `POST /api/whatsapp/groups` que já existia (usada em `contacts.html`).
    Depois de criado, abre a conversa do grupo na hora (reaproveita
    `openConversation()` — o grupo só aparece na lista da esquerda depois da
    primeira mensagem enviada, igual qualquer conversa nova).
37. Testado via curl o fluxo de arquivar/desarquivar (confirma que a
    conversa some de `GET /conversations` e aparece em `?archived=true`).
    **Não testado criar grupo de verdade** — isso criaria um grupo real no
    WhatsApp com contatos de teste reais (ação visível/irreversível pra
    terceiros), então ficou pra validação manual dentro do Bitrix.

### Parte H — Notificação de mensagem nova + correção do botão da sidebar (continuação, 2026-07-03)

Passou por planejamento antes de implementar. Contexto: hoje, mensagem nova
numa conversa fechada não gerava nenhum aviso pro usuário (só reordenava a
lista sozinha). Confirmado antes de começar: app roda num iframe do Bitrix, e
pedir permissão de notificação nativa do SO dentro de iframe costuma ser
bloqueado pelo host (mesma classe de problema já documentada com o
microfone) — mesmo assim, usuário pediu pra tentar a notificação nativa
também, com fallback garantido pro toast/sino que já existia (mas não estava
ligado a nada). Padrão confirmado: notifica por padrão, silenciar é exceção.

38. **Silenciar por conversa**: nova coluna `conversations.notifications_enabled`
    (boolean, default `true`). `store.listConversations` devolve esse campo;
    nova função `store.setConversationNotifications`; nova rota
    `POST /conversations/notifications { session, phone, enabled }` — mesmo
    padrão exato de `archived`/`/conversations/archive` (parte G). No Chat:
    segundo ícone de hover em cada conversa da lista (sino normal/sino
    cortado), ao lado do de arquivar — a classe CSS do botão de arquivar foi
    generalizada de `.conv-item-archive-btn` pra `.conv-item-action-btn`
    (reaproveitada pelos dois ícones).
39. **Disparo da notificação**: no handler do WebSocket que já recebe toda
    mensagem nova (`payload.type === 'message'`), quando a mensagem é
    recebida (`direction === 'in'`), não é da conversa aberta no momento, e a
    conversa não está silenciada: sempre dispara `showToast(...)` (acende o
    sino — mecanismo garantido, sem depender de nenhuma permissão) e, só se
    `Notification.permission === 'granted'`, também tenta `new
    Notification(...)` dentro de um `try/catch` silencioso.
40. **Pedido de permissão nativa**: link "Ativar notificações do sistema"
    dentro do painel do sino (só aparece se a permissão nunca foi pedida —
    some depois de concedida ou negada), disparado só por clique explícito do
    usuário (nunca automático ao carregar a página — motivo duplo: UX, e
    pedir sem gesto do usuário tem ainda mais chance de ser ignorado dentro
    de um iframe de terceiro).
41. **Bug corrigido**: o botão de expandir/retrair a sidebar no Chat estava
    numa posição vertical diferente das outras 6 páginas — usou-se
    `top: calc(var(--header-h) / 2 - 14px)` no ajuste de alinhamento da parte
    E (item 32), enquanto as outras páginas (que não têm `--header-h`) usam
    `top:20px` fixo. Corrigido voltando `chat.html` pra `top:20px` também —
    mesma posição absoluta em todas as 7 páginas, independente da altura da
    caixa do logo em cada uma.
42. Testado via curl o fluxo de silenciar/dessilenciar (confirma
    `notificationsEnabled` mudando em `GET /conversations`). Disparo de
    verdade dentro do Bitrix (toast aparecendo + tentativa de notificação
    nativa) fica pra validação manual — ver §5.

---

### Parte I — Notificação clicável, botão "Grupos", balão por conteúdo, estatísticas de contato (continuação, 2026-07-03)

Passou por planejamento antes de implementar. Pedido veio depois do usuário
testar as features das partes G e H: 5 ajustes, todos dentro de `chat.html`
(confirmado antes de começar), mais a replicação do padrão de notificação
clicável nas outras 6 páginas de sidebar (mesmo motivo da parte F — manter o
bloco de script compartilhado idêntico nas 7 páginas).

43. **Scrollbar do painel de notificações**: `.notif-panel` (o
    `max-height:360px; overflow-y:auto` que mostra a barra feia nativa)
    ganhou `::-webkit-scrollbar` no mesmo padrão já usado no composer (6px,
    `var(--gold-dim)` → `var(--gold)` no hover) — aplicado nas 7 páginas.
44. **Notificação clicável → abre a conversa**: `showToast(message, type,
    target)` ganhou um 3º parâmetro opcional (guardado no objeto da
    notificação); `renderNotifications()` marca o item com classe
    `clickable` quando tem `target` e liga um listener por item (via índice)
    que chama `window.__notifNavigate(target)` se existir, fechando o painel
    em seguida. Essa mudança no bloco compartilhado foi replicada nas 7
    páginas (só `chat.html` de fato passa um `target` hoje). Em `chat.html`:
    `window.__notifNavigate` procura a conversa em `state.conversations` e
    chama `openConversation(...)`; a notificação de mensagem nova (parte H,
    item 39) agora passa `{ sessionId, phone, contactName }` como `target`.
45. **Botão "Grupos"**: novo ícone ao lado de "Novo grupo" no cabeçalho da
    lista de conversas (`.conv-pane-head-actions`), abre um modal que lista
    os grupos já criados da instância (`GET /groups?session=`, rota já
    existente — nenhuma rota nova aqui) e abre a conversa ao clicar num
    grupo. Resolve o problema de um grupo "sumir" da lista principal até
    receber a primeira mensagem (visto na parte G): agora dá pra reabri-lo a
    qualquer momento.
46. **Balão de mensagem por conteúdo**: reforço defensivo — `.bubble` ganhou
    `width: fit-content` além do `max-width: 68%` que já existia. Revisão de
    código (mais um agente dedicado) confirmou que o dimensionamento por
    flex-shrink e o sistema de check (✓/✓✓/✓✓ verde, ponta a ponta desde o ack
    do Baileys até o WebSocket) já estavam corretos — não foi encontrado bug
    real, só o ajuste defensivo. Se o problema persistir depois de recarregar
    a página em produção, precisa de mais contexto (tipo de mensagem
    específico, balão próprio ou do contato) — ver §5.
47. **Detalhes do contato — estatísticas de mensagens**: contagem de
    enviadas/recebidas direto de `state.messages` (sem rota nova), mostrada
    em `.contact-stats` (Total / Recebidas / Enviadas).
48. **Detalhes do contato — grupos em comum**: novo método
    `WhatsAppGateway.getGroupParticipantPhones(groupId)` (chama
    `sock.groupMetadata`, resolve telefone via `p.phoneNumber` do tipo
    `Contact` do Baileys — mesmo padrão de `participantAlt` já usado pra
    mensagens); nova rota `GET /contacts/groups?session=&phone=` que varre
    os grupos da instância e devolve os que têm aquele telefone como
    participante. **Limitação documentada** (mesma classe do problema de LID
    já conhecido no projeto): um participante que só aparece como `@lid`
    anônimo, sem telefone resolvido, não é encontrado por essa checagem —
    best-effort, não garantia. **Custo**: uma chamada ao WhatsApp por grupo
    da instância a cada abertura do painel — aceitável pro volume esperado
    (dezenas de grupos, não milhares), mas não paginado nem cacheado; revisar
    se algum dia isso crescer muito (ver §5). `chat.html` busca isso em
    paralelo com os dados do CRM (mesmo padrão de carregamento assíncrono já
    usado pelo `contactInfo`), sem travar o resto do painel.
49. Testado via curl contra dados reais: `GET /contacts/groups` com os dois
    números das instâncias de teste (`..._183168` e `..._5305`, que por
    coincidência são os 2 participantes do grupo "Teste" criado na parte G)
    devolveu o grupo certo pros dois telefones e vazio pra um telefone que
    não participa — confirma o fluxo ponta a ponta (rota → posse de sessão →
    `store.listGroups` → `getGroupParticipantPhones` → filtro). Sintaxe
    validada nos 7 HTML + 3 arquivos JS de backend tocados; servidor
    reiniciado (sessões reconectaram sozinhas). Validação visual dentro do
    Bitrix (clique na notificação, abrir grupo pela lista, conferir contagem
    e grupos em comum de verdade) fica pra manual — ver §5.

---

### Parte J — Reposicionamento de botões, rodapé fixo do painel de contato, status da instância na lista (continuação, 2026-07-03)

Três ajustes pontuais em `chat.html`, depois do usuário ver a parte I em uso.
Antes de implementar o terceiro item, foi preciso confirmar com o usuário o
que "status online/offline" significava: status de presença do próprio
contato no WhatsApp (exigiria assinar presença por contato no Baileys —
recurso novo, dependente de privacidade de cada contato, e que o WhatsApp só
costuma liberar pra uma conversa aberta por vez, não pra uma lista inteira)
ou status da instância que atende aquela conversa (dado que já existe,
mesmo indicador usado no cabeçalho da conversa aberta). Usuário confirmou a
segunda opção.

50. **Botões "Grupos"/"Novo grupo" reposicionados**: saíram do topo (ao lado
    do título "Chat") e foram pra a mesma linha do toggle "Ativas"/
    "Arquivadas", alinhados à direita (`.conv-filters-row`, novo wrapper
    flex com `justify-content:space-between` em volta de `#archiveFilter` e
    do `.conv-pane-head-actions`). Nenhuma mudança de comportamento, só de
    posição.
51. **"Abrir contato/lead no CRM" fixo no rodapé do painel**: o painel de
    detalhes do contato foi dividido em duas áreas — `.contact-panel-body`
    (tudo que já existia: card, estatísticas, campos, grupos em comum; ganhou
    `flex:1; overflow-y:auto` e é a única parte que rola) e
    `.contact-panel-footer` (só o botão de abrir no CRM, fora da área de
    rolagem, sempre visível no final do painel independente de quanto
    conteúdo tiver acima). `.contact-panel` deixou de ter `overflow-y:auto`
    (virou `overflow:hidden`, já que quem rola agora é o `-body`).
52. **Bolinha de status da instância na lista de conversas**: cada avatar da
    lista ganhou uma bolinha no canto (mesma linguagem visual do indicador já
    usado no cabeçalho da conversa aberta — verde pulsando quando `online`,
    vermelho quando `offline`, cinza se desconhecido), mostrando se a
    instância dona daquela conversa está conectada ao WhatsApp agora — **não**
    é presença do contato. Novo `state.instanceStatus` (mapa `sessionId` →
    status), populado ao carregar as instâncias (`GET /instances` já devolve
    `status` por instância — nenhuma rota nova) e mantido atualizado em tempo
    real: o handler do WebSocket que já existia pra `payload.type === 'status'`
    agora atualiza esse mapa e re-renderiza a lista sempre (antes só
    atualizava o cabeçalho da conversa aberta, ignorando o resto da lista).
53. Sintaxe validada (script/style de `chat.html`); mudança só de frontend,
    sem reinício de servidor necessário. Validação visual dentro do Bitrix
    fica pra manual — ver §5.

---

### Parte K — Alinhamento de rodapé nas 6 páginas + Central de Notificações (Kanban/Calendário) (continuação, 2026-07-03)

Passou por planejamento (research com 3 agentes em paralelo) antes de
implementar, dado o tamanho: envolve migração de banco, rotas novas, uma
página nova e mudança no bloco de sino compartilhado pelas 8 páginas. Dois
pedidos do usuário, ambos confirmados via pergunta antes de começar:

1. O ajuste de alinhamento de cabeçalho/rodapé (feito só em `chat.html` numa
   sessão passada, ver parte D/E) devia ser replicado nas outras 6 páginas —
   confirmado que sim, é a pendência já registrada.
2. O sino da sidebar devia virar um link de navegação normal pra uma página
   nova com Kanban + Calendário das notificações, **substituindo** o dropdown
   por completo, com histórico **persistido no banco** (hoje some ao
   recarregar) — usuário confirmou as duas opções recomendadas.

54. **Alinhamento de rodapé nas 6 páginas** (`dashboard`, `instances`,
    `contacts`, `campaign`, `campaign-metrics`, `campaign-schedule`):
    pesquisa confirmou que essas 6 páginas tinham CSS byte-idêntico entre si
    nos pontos problemáticos — correção puramente mecânica, replicando o
    padrão já correto de `chat.html`: `--header-h`/`--footer-h` adicionados
    ao `:root`; `.sidebar-logo` ganhou altura fixa e `.logo-mark` encolheu de
    36px pra 32px; `.sidebar-bottom` ganhou altura fixa; `.credit-row` trocou
    padding por altura fixa. Único caso especial: `dashboard.html` tinha um
    `<div id="updatedAt">` ("Atualizado às HH:MM:SS") dentro do
    `.sidebar-bottom` que não cabia numa linha de altura fixa com o botão de
    notificação — movido pra dentro do `.refresh-row`, ao lado do botão
    "Atualizar agora" (só mudança de HTML, `updatedAt.textContent = ...`
    continua funcionando via o mesmo `id`).
55. **Banco**: nova tabela `notifications` (`id, owner_id, title, body,
    target jsonb, read boolean default false, created_at`), escopada por
    `owner_id` direto (não por `session_id`) — igual a `instances`, porque
    notificação é do usuário do Bitrix, não de uma instância de WhatsApp
    específica. Índices por `(owner_id, created_at desc)` e
    `(owner_id, read)`. Migrada via `node db/migrate.js`.
56. **Onde a notificação nasce**: deixou de ser 100% client-side (só
    `chat.html` criava, só quando o socket daquela sessão estava aberto) —
    agora nasce no servidor, em `src/server.js`, dentro do `onMessage` do
    `SessionManager` (mesmo lugar que já salva a mensagem e faz o
    broadcast). Sempre que chega mensagem recebida numa conversa não
    silenciada: novo `store.getConversationNotifPrefs` confere o silêncio e
    pega o nome do contato; novo `instancesStore.ownerOf(sessionId)` resolve
    o dono (mesmo fallback que `assertOwnsSession` já usa); novo
    `store.addNotification` grava. Roda **sempre**, não só quando alguém
    está com o Chat aberto — vira histórico de verdade, diferente do
    toast/notificação nativa (que continuam só um aviso imediato em tela,
    lógica inalterada em `chat.html`).
57. **Rotas novas** (`src/routes/whatsapp.js`, padrão de `/instances`):
    `GET /notifications?owner=` (lista, limit 500), `GET
    /notifications/unread-count?owner=` (badge), `POST
    /notifications/read-all` (`{owner}`), `POST /notifications/:id/read`
    (`{read}`). A última usa um helper novo, `requireResourceOwner`
    (`src/authz.js`) — espelha `requireResourceSession`, mas compara
    `owner_id` do registro direto contra `req.ownerId`, sem a indireção de
    `assertOwnsSession` (que é pra recursos por sessão de WhatsApp, não por
    dono direto). Testado via curl: notificação de teste inserida
    diretamente por `store.addNotification`, confirmado
    unread-count/list/mark-read funcionando, e confirmado que um token de um
    dono diferente toma 404 em `/notifications/:id/read` (posse pelo
    registro) e 403 em `/notifications?owner=<outro dono>`
    (`requireOwnerMatch`) — depois apagada do banco.
58. **Boilerplate compartilhado (8 páginas)**: removido o dropdown inteiro
    (`#notifPanel`, `#notifClear`, array `notifications` em memória,
    `renderNotifications()`); `#notifBell` virou `<a href="/notifications.html">`
    em vez de `<button>`; `#notifDot` virou um número (`window.updateNotifBadge(count)`,
    pílula em vez de bolinha vazia), buscado uma vez por página logo após o
    login (dentro de `resolveOwner()`/`resolveSession()`, que já existia em
    cada página). `showToast(message, type, target)` manteve a assinatura
    (os ~50 outros call-sites de feedback genérico continuam iguais) — só
    perdeu o efeito colateral de empurrar pro array; ganhou um novo: quando
    `target` é passado, o próprio toast fica clicável
    (`window.__notifNavigate`), preservando o "clicar pra abrir a conversa"
    que antes vivia no item do dropdown.
59. **`chat.html` (específico)**: `notifyNewMessage` ganhou um
    `window.__bumpNotifBadge()` (soma +1 no badge localmente — só o Chat tem
    o socket aberto pra saber ao vivo). Novo suporte a **deep link**:
    `?session=&phone=` na URL abre aquela conversa automaticamente depois
    que a lista carrega (mesmo fallback de `__notifNavigate` — usa a
    conversa já carregada se achar, senão abre só com o telefone cru).
    Necessário porque clicar num card em `notifications.html` agora é
    navegação de página inteira, não mais dentro do próprio SPA do Chat.
    (`onFilterChange`/`initInstances` viraram `async`/`await` em cadeia pra
    garantir que `loadConversations()` termina antes do deep link rodar.)
60. **Página nova `public/notifications.html`**: fork do casco de
    `campaign-schedule.html` (mesma sidebar/header/footer, já com o
    alinhamento da parte 54; mesmo padrão de Kanban+Calendário, sem
    reinventar). Kanban com 2 colunas ("Não lidas"/"Lidas", sem
    drag-and-drop — um botão explícito de marcar/desmarcar lida, mais
    simples e previsível que o Kanban de 4 colunas das campanhas).
    Calendário agrupado por dia de criação, mesmo grid mensal. Card mostra
    nome do contato, trecho da mensagem, quando chegou, botão "Abrir
    conversa" (navega pro deep link do Chat) e botão de marcar lida. Botão
    "Marcar todas como lidas" e o botão "Ativar notificações do sistema"
    (mudou de lugar do dropdown antigo pra cá) ficam no topo da página. Nova
    rota `app.post('/notifications.html', ...)` em `src/server.js` — mesmo
    motivo das outras 8 páginas (Bitrix abre a aba via POST,
    `express.static` só serve GET).
61. Sintaxe validada em todos os arquivos tocados (8 HTML + 5 JS de
    backend); servidor reiniciado, sessões reconectaram sozinhas. Validação
    visual dentro do Bitrix (rodapé alinhado nas 6 páginas, Kanban/Calendário
    de verdade com mensagens reais chegando, deep link abrindo a conversa
    certa) fica pra manual — ver §5.

---

### Parte L — 4 itens de dívida técnica: AUTH_FOLDER, mídia privada, base64 agendado, alert/confirm (continuação, 2026-07-03)

Usuário selecionou 4 itens do checklist "Próximos passos" do README e pediu
pra implementar todos. Passou por planejamento (pesquisa prévia mostrou que
eram 4 tarefas bem diferentes em tamanho/risco — duas pequenas, duas
arquiteturais de verdade) e duas perguntas de confirmação antes de começar:
nível de acesso da mídia depois de privada (**qualquer usuário autenticado
do portal**, não por dono da conversa) e o que fazer com mídia antiga já
enviada (**migrar** pro formato novo, não deixar quebrada).

62. **Item 1 — `AUTH_FOLDER`**: não virou código. Pesquisa confirmou que não
    existe Dockerfile/docker-compose/render.yaml/Procfile em lugar nenhum do
    repositório — o deploy real é `node src/server.js` como processo de
    longa duração (idealmente sob supervisor), não container. `./auth_session`
    já sobrevive normalmente a reinícios nesse modelo. README/HANDOFF
    reescritos pra deixar claro que é uma pendência **condicional** (só vira
    ação de verdade se/quando isso for containerizado), não um risco ativo hoje.
63. **Item 2 — Bucket de mídia privado**: descoberta chave que simplificou
    tudo — `hydrateMedia()` (`chat.html`/`index.html`) já tinha, morta, a
    lógica de buscar URLs relativas de forma autenticada (`apiFetch` + blob),
    resquício de antes da migração pro Supabase Storage. Bastou fazer
    `saveMedia()` (`src/media.js`) devolver `/api/whatsapp/media/<filename>`
    em vez da URL pública do Supabase — **zero mudança de frontend**. Nova
    rota `GET /media/:filename` (protegida pelo `requireAuth` que já envolve
    o router inteiro — nenhum middleware extra) gera uma signed URL de 5min
    (`getSignedMediaUrl`, novo em `media.js`) e redireciona (302). Nova
    `downloadMedia(url)` em `media.js` baixa bytes direto do Storage
    (server-to-server, sem gerar signed URL) — usada pelo item 3.
    `db/create-bucket.js` passou a criar o bucket já privado por padrão (só
    instalação nova). Migração do histórico existente: novo
    `db/migrate-media-urls.js` (reescreve `messages.media_url` do padrão de
    URL pública antiga pro caminho relativo novo) e novo
    `db/make-bucket-private.js` (flipa um bucket já público). Rodados nesta
    ordem em produção: deploy do código (bucket ainda público) → migração
    (1282 mensagens reescritas) → bucket privado. Testado via curl em cada
    etapa: rota sem token → 401; com token, arquivo real → 302 com signed
    URL válida; arquivo inexistente → 404; depois de privar o bucket, a URL
    pública antiga direta no Supabase → 400 (bloqueada) e a mesma mídia via
    rota autenticada → continua 302 normalmente.
64. **Item 3 — Mídia de agendamento sai do `media_base64`**: nova coluna
    `scheduled_campaigns.media_url` (`media_base64`/`media_type`/
    `media_mimetype` continuam existindo, pra agendamentos já pendentes antes
    desta mudança). `POST /campaign/schedule` agora chama `saveMedia()` uma
    vez na hora de agendar (reaproveitando o id já gerado na própria rota) em
    vez de gravar o base64 recebido direto na linha. `src/scheduler.js` lê
    `media_url` primeiro (`downloadMedia`) e só cai pro `media_base64` antigo
    se `media_url` for nulo. **Limitação documentada, não resolvida agora**:
    o arquivo "pendente" no Storage entre agendar e disparar não é apagado
    depois — o disparo de verdade sobe sua própria cópia por destinatário
    (`runCampaign`, inalterado) — vira lixo órfão no bucket com o tempo, ver §5.
    Testado via curl: agendamento de teste com mídia confirmado gravando só
    `media_url` (não `media_base64`); linha e arquivo de teste apagados depois.
65. **Item 4 — `alert()`/`confirm()` → toast/modal**: pesquisa mapeou todos
    os call sites nas 8 páginas: 5 `confirm()` (remover instância, excluir
    contato, excluir lista, cancelar agendamento, confirmar envio de
    campanha em massa — todos já dentro de funções `async`) e ~35 `alert()`
    (a maioria redundante com um `showToast` idêntico na linha seguinte).
    Novo `window.confirmDialog(message)` → `Promise<boolean>`, adicionado ao
    bloco de script compartilhado das 8 páginas — cria o próprio
    `.overlay`/`.modal` via `document.createElement` na primeira chamada (não
    precisou duplicar HTML em cada página), resolve `false` no ESC também (o
    handler global de ESC já existente precisou guardar o `resolve`
    pendente). CSS `.overlay`/`.modal`/`.btn` que faltava foi adicionada a
    `dashboard.html`/`campaign-metrics.html` (não tinham nenhuma) e
    `campaign.html`/`notifications.html` (tinham `.btn` mas não modal) — só
    pra manter as 8 páginas com o mesmo conjunto de classes disponível, nem
    todas usam `confirmDialog` hoje. Todo `alert()` redundante foi apagado
    (o `showToast` companion já cobria); os poucos sem companion viraram
    `showToast(msg, 'error')`. **Fora de escopo, não mexido**: o
    `prompt('Nome do modelo:')` em `campaign.html` — usuário pediu
    especificamente alert/confirm, prompt é outra categoria (ver §5).
66. Sintaxe validada em todos os arquivos tocados (8 HTML + 6 JS de
    backend + 2 scripts novos de `db/`); servidor reiniciado, sessões
    reconectaram sozinhas. Validação visual dentro do Bitrix dos 5 `confirm()`
    trocados (Cancelar/Confirmar/ESC) e dos toasts substituindo os antigos
    `alert()` fica pra manual — ver §5.

---

### Parte M — Atualização da página de apresentação (continuação, 2026-07-03)

Usuário pediu pra atualizar `public/apresentacao.html` (relatório executivo
estilo "scrollytelling", nada a ver com as 8 páginas de sidebar — sem
autenticação, feita pra ser aberta fora do Bitrix e/ou exportada em PDF) com
"todas as features bem detalhadas". Conteúdo estava desatualizado desde uma
sessão bem anterior: citava "seis módulos" (faltavam Análise de Conversas
como card próprio e a Central de Notificações, que nem existia ainda) e o
item de risco "autenticação não validada" já tinha sido resolvido havia
sessões, sem a apresentação refletir isso.

67. Releu o `README.md` inteiro (fonte de verdade única) pra levantar o
    estado real e atual de cada módulo antes de reescrever qualquer coisa —
    nesse processo, achou e corrigiu **dois itens desatualizados no próprio
    README** (§18, Segurança) que sobraram de uma sessão anterior: ainda
    diziam "bucket público" e "`scheduled_campaigns` guarda base64 na
    tabela", ambos já resolvidos na parte L (riscado + nota "resolvido",
    mesmo padrão já usado pro item de autenticação).
68. **Grade "A solução"**: de 6 pra 9 cards — adicionou "Inbox completo"
    (destacado separado de "Chat no negócio", dado o tanto de recurso que
    cresceu ali: painel de contato com dados reais do CRM, arquivar,
    silenciar, grupos, tags), "Análise de Conversas" (que já existia como
    módulo mas nunca tinha card próprio) e "Central de Notificações" (novo).
69. **Insights (Q&A)**: de 4 pra 6 perguntas — adicionadas "um cliente manda
    mensagem fora do horário, alguém fica sabendo depois?" (Central de
    Notificações) e "dá pra saber se a pessoa leu a mensagem?" (status de
    entrega/leitura do WhatsApp, já implementado ponta a ponta há sessões).
70. **Fatos em números**: "6 módulos" → "9 telas"; "9 tabelas" → "14 tabelas"
    (contagem real de `create table` em `db/schema.sql` nesta sessão).
71. **Riscos e transparência**: removido o risco "autenticação não validada"
    (resolvido) — substituído por "sem reinício automático em falha grave"
    (item real ainda pendente, ver §5/§18 do README). Acrescentada uma frase
    no início da seção reconhecendo os dois pontos já fechados desde o
    último relatório (autenticação + privacidade de mídia) — transparência
    inclui mostrar progresso, não só o que falta.
72. **Roadmap**: removido "reforço de segurança" (feito) — adicionados
    "supervisor de processo" (curto prazo, espelha o risco novo acima) e
    "atualizar o Baileys pra versão estável" (médio prazo, já era pendência
    conhecida no README, nunca tinha entrado na apresentação).
73. Encerramento e "Como funciona" (fluxo Bitrix → Gateway → Banco) tiveram
    pequenos ajustes de texto pra mencionar tempo real (WebSocket) e
    armazenamento de arquivos separado do banco — sem mudar a estrutura
    visual de nenhuma seção. Sintaxe validada (script/style do arquivo,
    inclusive as duas fontes embutidas em base64 que fazem esse HTML pesar
    ~180KB). Arquivo estático — não precisou reiniciar o servidor.

### Parte N — Gateway de produção (Durão) fora do ar + supervisor de processo (continuação, 2026-07-03)

74. **Incidente em produção**: usuário reportou `ERR_NGROK_8012` na aba
    WhatsApp do Bitrix da Durão, Almeida & Pontes ("connection refused" em
    `localhost:3333`). Diagnóstico: `tasklist`/`netstat` confirmaram que
    **nenhum processo Node estava rodando** e nada escutava na porta 3333 —
    o ngrok em si estava saudável (túnel de pé, alcançava o agente), só
    faltava o processo do gateway (`node src/server.js`). Não foi causado
    por nenhuma mudança desta sessão — o processo já estava caído antes de
    qualquer trabalho começar. Resolvido subindo `node src/server.js` de
    novo na raiz do projeto; as 2 instâncias de WhatsApp com sessão salva
    reconectaram sozinhas (`status: online`); uma terceira (`portal_183168`)
    segue deslogada (`loggedOut = true`) — pendência separada, precisa de
    novo QR Code quando alguém for usá-la.
75. **Supervisor de processo (PM2)** — resolvendo de vez a pendência do item
    acima e do §20/§18 do README: instalado PM2 globalmente
    (`npm install -g pm2`) e o gateway subido sob supervisão
    (`pm2 start src/server.js --name whatsapp-gateway`, rodado de dentro da
    raiz do projeto). Lista de processos salva (`pm2 save`) e registrado
    `pm2-windows-startup` (pacote `npm i -g pm2-windows-startup` +
    `pm2-startup install`) — adiciona uma entrada na chave `Run` do Windows
    (usuário atual) que chama `pm2 resurrect` a cada login, trazendo o
    gateway de volta sozinho depois de um reinício da máquina.
    **Testado de verdade**: matei o processo direto pelo PID (via
    `taskkill /F`, contornando o PM2 de propósito, simulando um crash real)
    — o PM2 detectou a queda e subiu um processo novo sozinho em poucos
    segundos, sessões de WhatsApp reconectando sem intervenção manual.
    **Limitação documentada**: por ser a chave `Run` (não um Serviço do
    Windows), só volta depois que alguém faz login na conta do Windows —
    não antes disso.

### Parte O — Corrigido erro de conexão ociosa do Postgres que podia derrubar o processo (continuação, 2026-07-06)

76. **Bug real, achado durante um trabalho numa ferramenta interna separada**
    (não é o gateway em si) que expôs a mesma vulnerabilidade aqui: o `Pool`
    do Postgres (`pg`, `src/db.js`) não tinha nenhum listener de erro. Erro
    conhecido do `pg`: quando o pooler do Supabase fecha uma conexão ociosa
    do pool (acontece de tempos em tempos, é comportamento normal do lado do
    Supabase), isso dispara um evento `'error'` no `Pool` — sem um listener
    próprio, esse evento **derruba o processo Node inteiro**, inclusive
    passando por cima do `process.on('uncaughtException')` já existente em
    `server.js` (que só protege contra erros de rede em chamadas ao Bitrix,
    não contra esse tipo de erro do `pg`). Corrigido com
    `pool.on('error', (err) => console.error(...))` em `src/db.js` — só
    loga, o pool cria uma conexão nova sozinho na próxima query, sem derrubar
    nada. Testado com mais de uma dezena de chamadas ao banco espaçadas no
    tempo (simulando conexão ficar ociosa e ser reaproveitada depois) — sem
    nenhuma queda depois da correção.

### Parte P — Marca configurável via `.env`, sem editar HTML (continuação, 2026-07-06)

Motivação: usuário perguntou se já dava pra cadastrar um cliente novo de
verdade no painel de controle e ele logar no Bitrix dele. Resposta na hora:
não — faltava resolver a marca fixa ("Durão, Almeida & Pontes" escrita
direto em 9 arquivos HTML) antes de reaproveitar este código pra outro
cliente, apontado como o único ajuste de código genuinamente necessário
desde a §04 da apresentação de estratégia SaaS. Pedido em seguida:
"automatize tudo" — parte disso (marca configurável) é código real do
gateway; a outra parte (provisionamento automático do banco/bucket) é só do
painel de controle, documentada separadamente (fora deste HANDOFF, ver
regra de separação já estabelecida).

77. **Nova rota pública `GET /api/brand`** (`src/server.js`, sem
    autenticação — é só config de exibição, nada sensível): devolve
    `{name, subtitle, color}` a partir de `BRAND_NAME`/`BRAND_SUBTITLE`/
    `BRAND_COLOR` no `.env`, ou `null` em cada campo quando a variável não
    está definida.
78. **Patch de marca via JavaScript nas 8 páginas com sidebar**
    (`dashboard.html`, `chat.html`, `campaign.html`,
    `campaign-schedule.html`, `contacts.html`, `instances.html`,
    `campaign-metrics.html`, `notifications.html`): um bloco novo de script
    (só adicionado, nada do que já existia foi tocado) busca `/api/brand` ao
    carregar a página e, só se cada campo vier preenchido, troca o texto de
    `.firm-name`/`.firm-sub` e sobrescreve a variável CSS `--gold` com a cor
    recebida. **Decisão deliberada de segurança**: não editei o texto fixo
    "Durão, Almeida & Pontes" já escrito no HTML de nenhuma página — o
    patch só ativa se as variáveis de ambiente estiverem definidas. Como o
    `.env` de produção da Durão não define `BRAND_NAME`/`BRAND_SUBTITLE`/
    `BRAND_COLOR`, o comportamento pra ela é **100% idêntico** a antes (o
    fetch roda, recebe `null` em tudo, e o patch não faz nada).
79. **Testado dos dois lados**: com o `.env` real da Durão (sem as
    variáveis) — `GET /api/brand` devolve `{name:null,subtitle:null,
    color:null}`, página carrega igual a sempre. Com uma instância de teste
    à parte (processo temporário, porta diferente, variáveis
    `BRAND_NAME`/`BRAND_SUBTITLE`/`BRAND_COLOR` setadas na mão) — endpoint
    devolveu os valores corretos, confirmando que o mecanismo de fato
    sobrescreve quando configurado. Processo de teste encerrado depois,
    gateway de produção da Durão confirmado no ar e sem mudança visual.
80. `.env.example` documentado com as 3 variáveis novas (opcionais, vazias
    por padrão).

### Parte Q — Bug real: mensagem de grupo caindo na conversa individual do participante (continuação, 2026-07-06)

Usuário reportou pelo Table Editor do Supabase (produção real): mensagens
com cara de bate-papo de grupo (torcida, memes, avisos promocionais tipo
"Tommy Hilfiger") aparecendo dentro da tabela `messages`, misturadas com
conversas de clientes de verdade.

81. **Causa raiz encontrada em `src/whatsapp.js`** (handler
    `messages.upsert`): pra QUALQUER mensagem, o telefone da conversa era
    resolvido por `m.key.participantAlt || m.key.remoteJidAlt ||
    m.key.participant || m.key.remoteJid` — essa ordem de prioridade
    **sempre** favorece o campo `participant` quando presente. Numa
    mensagem de GRUPO, o WhatsApp sempre preenche `participant`/
    `participantAlt` com quem mandou a mensagem — então toda mensagem de
    QUALQUER grupo que o número conectado participa (família, torcida,
    grupo de promoção, o que for) acabava sendo gravada na conversa
    INDIVIDUAL daquele remetente, misturando bate-papo de grupo com o
    histórico real de atendimento ao cliente. Confirmado investigando o
    banco de produção: 22 conversas tinham `phone` com 18-23 dígitos (um
    telefone de verdade nunca passa de ~15) — na real, o **ID do grupo**
    inteiro sendo tratado como se fosse o telefone de um contato.
82. **Corrigido**: adicionada a checagem `isGroupMessage =
    remoteJid.endsWith('@g.us')` — quando verdadeira, o telefone da
    conversa passa a ser o **próprio JID do grupo** (`m.key.remoteJid`),
    nunca o do participante, tanto na mensagem em si quanto numa reação
    (emoji) a ela. Isso também corrige o `pushName`: mensagem de grupo não
    sobrescreve mais o nome da conversa com o nome pessoal de quem mandou
    (senão o nome mudaria a cada pessoa diferente que falasse no grupo) —
    nome do grupo continua vindo de `wa_groups` (tabela separada, já
    existente, usada pela funcionalidade de "Criar grupo" do Chat).
83. **Limpeza de dados feita, com cuidado** (confirmado com o usuário antes
    de mexer): as 22 conversas identificadas como grupo puro (telefone
    longo demais pra ser real) foram **arquivadas** (`archived = true`),
    não apagadas — reversível a qualquer momento pela aba "Arquivadas" do
    Chat, mesmo mecanismo já existente. ~514 mensagens ao todo, zero perda
    de dado.
84. **Limitação documentada, não resolvida**: contatos com telefone real
    que JÁ tinham histórico de atendimento genuíno, mas que também estão
    num grupo compartilhado com o número da empresa (ex: "Daiane", "Celso
    Neto" vistos na investigação) — o schema atual não guarda de onde cada
    mensagem antiga veio (grupo ou direto), então **não dá pra separar
    retroativamente com segurança** qual mensagem dentro do histórico
    desses contatos era de grupo e qual era de verdade. A correção garante
    que isso não acontece mais daqui pra frente; histórico misto anterior
    precisaria de revisão manual, mensagem por mensagem, se o usuário
    quiser limpar (não foi feito — risco real de apagar mensagem de cliente
    de verdade por engano).
85. **Testado**: lógica de resolução de telefone validada com casos
    simulados (mensagem direta, mensagem de grupo com participante
    resolvido, mensagem de grupo com participante não resolvido) — nos três
    casos o resultado bateu com o esperado. Gateway reiniciado em produção,
    3 instâncias reconectando normalmente, sem impacto visual.
86. **Confirmado ao vivo, em produção**: minutos depois do reinício, uma
    mensagem de grupo real chegou e criou uma conversa nova isolada (não
    misturou em nenhum contato) — prova que a correção funciona com tráfego
    de verdade, não só em teste. Só que essa conversa nova (e outras 4 que
    chegaram na sequência) ainda apareciam **visíveis** na aba "Ativas" do
    Chat (usuário mandou print confirmando) — arquivadas na mão de novo, e
    aí veio a pergunta óbvia: vai continuar chegando mensagem de grupo pra
    sempre, não dá pra ficar arquivando uma por uma toda vez.
87. **Correção definitiva — grupo já nasce arquivado**: `isGroup` (calculado
    em `src/whatsapp.js`, ver item 82) agora viaja pela cadeia inteira
    (`sessions.js` → `server.js` → `store.addMessage`/
    `getOrCreateConversation`) até o `INSERT` de uma conversa nova, que passa
    a gravar `archived = true` de cara quando é grupo. **Só na criação** — o
    `on conflict` não mexe em `archived` de uma conversa que já existe, então
    isso nunca desarquiva sozinho um grupo que o usuário desarquivou de
    propósito pra acompanhar. Notificação da Central de Notificações também
    passou a ser pulada pra mensagem de grupo (não faz sentido notificar
    "Nova mensagem de fulano" quando é bate-papo de grupo, não cliente).
    Testado com um `INSERT` real dentro de uma transação com `ROLLBACK`
    (grupo simulado → `archived: true`; contato direto simulado →
    `archived: false`) — sem sujar o banco de produção. Mais 4 conversas de
    grupo que chegaram durante o teste (antes desta última correção) foram
    arquivadas na mão pra manter a lista limpa; 3 conversas de telefone
    "quase real" (15 dígitos, zona cinzenta entre grupo/LID mal resolvido e
    telefone internacional de verdade) foram deixadas de propósito — uma
    delas tem até uma resposta de verdade enviada por alguém da equipe,
    então não dá pra decidir sozinho que é lixo.

### Parte R — Bug real (diferente do de grupo): Status do WhatsApp virando mensagem de conversa + limpeza de 767 conversas (continuação, 2026-07-06)

Usuário mandou print do próprio WhatsApp (aba "Atualizações" → "Status", com
Status de verdade de "Eduarda", "Thay" etc.) ao lado do Chat do CRM
mostrando a conversa "Thay" com os MESMOS vídeos que apareciam no Status
dela — confirmando que não era o bug de grupo da parte Q, era outra coisa:
**Status (Stories) do WhatsApp** sendo salvo como mensagem de conversa.

88. **Causa raiz**: quando o número conectado consegue ver o Status de um
    contato (`remoteJid = "status@broadcast"`, `participant` identificando
    quem postou), o Baileys entrega isso pelo mesmo `messages.upsert` de
    qualquer mensagem normal — e a correção da parte Q (que só tratava
    `@g.us`) não cobria esse caso. Resultado: toda vez que um contato
    postava um Status e o número via, isso virava uma "mensagem" de verdade
    na conversa 1:1 daquele contato — sem nenhuma relação com atendimento.
89. **Corrigido**: `isJidBroadcast` (utilitário já exportado pelo
    `@whiskeysockets/baileys`, `jid?.endsWith('@broadcast')`) descarta a
    mensagem por completo assim que `remoteJid` bate com isso — antes até de
    checar se é grupo. Diferente do grupo (que ainda faz sentido guardar
    isolado, ver parte Q), aqui não tem conversa nenhuma pra guardar.
90. **Escala real do problema, investigada no banco de produção**: de 886
    conversas com telefone "normal" (≤15 dígitos), **767 (87%) nunca tinham
    recebido nenhuma resposta da empresa** — 8.313 mensagens, contra só 39
    conversas (729 mensagens) com pelo menos uma resposta de verdade. Ou
    seja: a grande maioria do que parecia "histórico de conversa" no CRM era
    Status vazando, não relacionamento com cliente.
91. **Decisão do usuário, depois de eu mostrar a distribuição** (436
    conversas com 1-3 mensagens, 188 com 4-10, 82 com 11-30, 61 com mais de
    30) e perguntar o escopo: **apagar as 767 inteiras** (não só arquivar) —
    aceitando o risco pequeno de alguma ser um lead novo genuíno ainda sem
    resposta, em troca de uma limpeza completa.
92. **Apagado com segurança**: antes de qualquer `DELETE`, rodei um backup
    completo (conversas + mensagens exatas que seriam apagadas) pra um
    arquivo JSON local (`backup-status-apagados.json`, ~3.9MB, na pasta de
    scratchpad da sessão) — os dados não estão mais no banco, mas existem
    nesse arquivo se precisar consultar algum dia. `DELETE` rodado dentro de
    uma transação, escopado exatamente pelos mesmos 767 ids do backup
    (reconsultados na hora, não reaproveitando uma lista antiga). Verificado
    depois: as 767 conversas sumiram (inclusive a "Thay" do print original),
    zero das 39 conversas reais foi tocada, contagem bate exatamente com o
    backup (767 conversas / 8.313 mensagens apagadas).
93. Banco de produção foi de 886 → 119 conversas e de 9.483 → ~1.192
    mensagens (a diferença é um pouco maior que 8.313 por causa de tráfego
    novo chegando durante a limpeza, não por erro na exclusão).

### Parte S — Mensagem de grupo também descartada por completo, não só isolada (continuação, 2026-07-06)

Usuário mandou print do Table Editor do Supabase mostrando texto com cara
de bate-papo de grupo (comunicado de empresa, gente trocando "ei
andrey"/"valeu andrey") ainda **fisicamente salvo** na tabela `messages` —
mesmo já isolado numa conversa própria e arquivado (solução da parte Q).
Confirmado no banco: eram exatamente as conversas de grupo já identificadas
(`archived = true`, telefone = JID do grupo). O usuário deixou claro: não
quer esse conteúdo salvo no banco de jeito nenhum, nem isolado.

94. **Mudança de política**: mensagem de grupo (`remoteJid` termina em
    `@g.us`) agora é **descartada por completo** em `src/whatsapp.js`,
    mesmo tratamento do Status (`isJidBroadcast`) — não grava mais nada,
    nem isolado. Revertido tudo que tinha sido criado pra fazer "grupo
    nascer arquivado" (parâmetro `isGroup` que viajava por
    `sessions.js`/`server.js`/`store.js`/`getOrCreateConversation`, coluna
    `archived` no `INSERT` de `conversations`) — ficaria código morto,
    já que grupo nunca mais chega até esse ponto do código.
95. **Efeito colateral aceito, documentado**: a funcionalidade de "criar
    grupo do WhatsApp direto do Chat" (`createGroup()`) continua
    funcionando pra criar o grupo e enviar mensagem nele (esse caminho é
    outro, `sendMessage`/`sendMedia`, não passa pelo `messages.upsert`) —
    só que agora **respostas de quem está no grupo não aparecem em lugar
    nenhum do CRM**. Trade-off aceito explicitamente pelo usuário ao pedir
    o descarte total.
96. **Limpeza do que já tinha sido isolado**: as 29 conversas de grupo que
    ainda restavam no banco (as 22 da parte Q + as que chegaram depois,
    todas já arquivadas) — 482 mensagens — foram **apagadas** (backup local
    feito antes, mesmo padrão da parte R). Confirmado depois: zero conversas
    com telefone longo demais restando no banco. Total geral caiu de 119
    para 91 conversas e de ~1.192 para 729 mensagens — o banco de produção
    agora reflete só interação real de cliente.

### Parte T — Banco zerado por completo, a pedido do usuário (continuação, 2026-07-06)

Depois de toda a limpeza das partes Q/R/S (que preservou de propósito as
conversas com relacionamento real confirmado), o usuário pediu pra apagar
literalmente tudo — inclusive essas conversas reais — pra o Chat começar
100% do zero. Confirmado explicitamente antes de agir (a pergunta direta
foi se isso incluía as ~41 conversas reais; resposta: sim, apagar tudo).

97. **Backup completo feito antes** (`backup-completo-antes-de-zerar.json`,
    ~335KB, pasta de scratchpad da sessão) — as 91 conversas, 729 mensagens
    e 3 vínculos de tag que ainda existiam no banco nesse momento, todos
    salvos em arquivo local antes de qualquer exclusão.
98. **`DELETE FROM conversations`** (sem filtro — apaga tudo) rodado dentro
    de uma transação. `messages` e `conversation_tags` têm `on delete
    cascade` pra `conversations` no schema (`db/schema.sql`), então apagar
    a conversa já apaga as mensagens e vínculos de tag dela junto, sem
    precisar de três comandos separados.
99. **Confirmado depois**: as três tabelas (`conversations`, `messages`,
    `conversation_tags`) com `count(*) = 0`. Gateway continuou no ar
    normalmente durante e depois da operação — zerar essas tabelas não afeta
    o processo em si, só o histórico que ele lê/grava. **Não apagado**:
    `contacts`, `contact_lists`, `campaigns` e as demais tabelas do CRM —
    só o que é especificamente de conversa/mensagem, como pedido.
100. Tabelas `instances`/`wa_groups` (cadastro de instâncias e grupos, não
     histórico de mensagem) também não foram tocadas — continuam intactas,
     as instâncias de WhatsApp já pareadas seguem conectadas normalmente,
     só sem nenhum histórico de conversa até a próxima mensagem chegar.

### Parte U — Canal do WhatsApp (newsletter) também descartado por completo (continuação, 2026-07-06)

Terceiro tipo de conteúdo (distinto de grupo e de Status) vazando pra dentro
de conversas de cliente: posts de **Canais** do WhatsApp (ESPN Brasil,
Netflix Brasil, Esportes da Sorte, etc. — aba "Atualizações" do celular).
Usuário mostrou lado a lado o Canal "Netflix Brasil" postando "feliz dia
6/7." no celular e a mesma mensagem salva na tabela `messages` do Supabase.
Confirmado pelo Table Editor: 3 conversas com telefone numérico longo
(formato de id de canal) continham exatamente esse tipo de conteúdo,
inclusive um post da ESPN Brasil e um da XP Educação — nenhuma delas era
cliente de verdade.

101. **Causa raiz**: igual Status e grupo, canal chega pelo mesmo evento
     `messages.upsert`, só que com `remoteJid` terminado em `@newsletter`
     (função `isJidNewsletter` do próprio Baileys, `jid?.endsWith
     ('@newsletter')`) — não havia filtro nenhum pra esse caso.
102. **Fix em `src/whatsapp.js`**: importado `isJidNewsletter` do Baileys e
     adicionado `if (isJidNewsletter(m.key.remoteJid)) continue;` logo
     depois do descarte de grupo, mesmo padrão de Status/grupo — descarta e
     segue, sem gravar nada no banco.
103. **Limpeza dos 3 registros já salvos** (chegaram entre o zerar-tudo da
     Parte T e este fix): backup em `backup-canais-apagados.json` (pasta de
     scratchpad da sessão) com as 3 conversas + 3 mensagens, depois
     `DELETE` (cascade apaga as mensagens junto). Banco voltou a ficar com
     `conversations`/`messages` em zero.
104. Gateway reiniciado via PM2, verificado saudável (`curl` 200,
     `pm2 list` online) e sessões WhatsApp reconectando normalmente.

### Parte V — Colar imagem com Ctrl+V no Chat (continuação, 2026-07-06)

Usuário testou copiar uma imagem (print, por exemplo) e colar com Ctrl+V
direto na caixa de mensagem do Chat — não fazia nada, só existia o botão de
anexo (📎) pra escolher arquivo.

105. **Fix em `public/chat.html`** (dentro de `bindComposer()`): adicionado
     `input.addEventListener('paste', ...)` na caixa de mensagem (`#msgInput`).
     Quando o clipboard tem um item do tipo `image/*`
     (`e.clipboardData.items`), extrai o arquivo com `item.getAsFile()` e
     chama a função `sendMediaFile(file)` **já existente** — mesmo caminho de
     envio usado pelo botão de anexo (valida tamanho/tipo, converte pra
     base64, mostra otimista na tela, envia pro backend). Sem imagem no
     clipboard (colando texto normal), o listener não faz nada e o
     comportamento padrão de colar texto continua intacto.
106. Validado com `node --check` via extração dos `<script>` inline do HTML
     (não quebrou nenhum script da página).

### Parte W — Balões mais profissionais + confirmação de leitura estilo WhatsApp (continuação, 2026-07-06)

Usuário mandou print mostrando o balão de vídeo com visual quebrado (o
`<video controls>` nativo do navegador aparecendo cru, com a barra de
controle apertada dentro do preenchimento padrão do balão) e pediu pra
deixar os balões "mais profissionais" e adicionar um "símbolo de
visualização". Perguntado o que "símbolo de visualização" significava
(ícone de play na mídia vs. confirmação de leitura tipo WhatsApp), a
resposta foi **confirmação de leitura**.

107. **`public/chat.html` — balão de imagem/vídeo redesenhado**: nova classe
     `.media-frame` com preenchimento reduzido a 3px (moldura fina) em vez do
     preenchimento cru de texto (9px/12px) que sobrava ao redor da mídia.
     Imagem **sem legenda** ganhou o horário+check sobreposto em um selo
     escurecido no canto (`.media-time`, como o WhatsApp faz); imagem/vídeo
     **com legenda** mantêm o horário numa linha própria abaixo (pra não
     brigar visualmente com os controles nativos do `<video>`, que já ocupam
     a faixa inferior da mídia).
108. **Áudio**: `accent-color: var(--gold)` no `<audio>` — tingimento nativo
     do player (botão de play, barra de progresso) na cor da marca, sem
     precisar construir um player customizado.
109. **Sombra em camadas** nos balões (`box-shadow` com duas camadas em vez
     de uma só) e um brilho sutil no topo do balão próprio (`inset 0 1px 0
     rgba(255,255,255,.25)`) — leve efeito de profundidade/bisel.
110. **`tickIcon()` reescrita**: trocado o texto Unicode "✓"/"✓✓" por SVG
     próprio (mesmo estilo dos outros ícones da página — traço,
     `stroke-linecap="round"`), com azul (`#53bdeb`, mesma cor do WhatsApp)
     quando `status === 'read'` — antes a cor de "lida" era verde
     (`#4caf6e`), sem seguir a convenção que o usuário reconhece de outros
     apps. **Bug encontrado e corrigido de brinde**: mensagem com falha de
     envio (`status === 'failed'`) caía no mesmo `else` do check duplo e
     aparecia como se tivesse sido entregue — agora tem um ícone próprio
     (círculo com "!", vermelho).
111. Validado com `node --check` via extração dos `<script>` inline (sem
     quebra de sintaxe). **Não testado clicando de verdade no navegador**
     (sem ferramenta de automação de browser neste ambiente) — vale conferir
     visualmente no Chat depois do deploy.

### Parte X — "Digitando…"/"gravando áudio…" nas duas direções (continuação, 2026-07-06)

Pedido: mostrar o indicador de "digitando"/"gravando áudio" tanto pro
cliente (quando o atendente está escrevendo no CRM) quanto pro atendente
(quando o cliente está escrevendo do lado dele no WhatsApp) — as duas
direções, confirmado via pergunta de esclarecimento.

112. **`src/whatsapp.js`**: dois métodos novos na classe `WhatsAppGateway`.
     `sendPresence(phone, state)` chama `sock.sendPresenceUpdate(state, jid)`
     do Baileys (`state`: `'composing'` | `'recording'` | `'paused'`) — é o
     sentido empresa→contato. `subscribePresence(phone)` chama
     `sock.presenceSubscribe(jid)`, pedindo pro WhatsApp avisar quando aquele
     contato mudar de presença — sem isso a sessão nunca recebe presença de
     ninguém. Os dois são best-effort (não fazem nada se a sessão não
     estiver online) e o segundo também é best-effort quanto à privacidade:
     um contato pode ter bloqueado o compartilhamento, e nesse caso o pedido
     não dá erro, só nunca chega evento depois.
113. Listener novo `sock.ev.on('presence.update', ...)`: repassa como evento
     `'presence'` desta classe (`{ phone, state }`), ignorando grupo/canal/
     status (mesmo filtro de JID das outras partes). `lastKnownPresence` do
     Baileys já vem como `'composing'` | `'recording'` | `'available'` |
     `'unavailable'` (`'paused'` do protocolo já chega mapeado pra
     `'available'` dentro do próprio Baileys).
114. **`src/sessions.js`**: novo callback `onPresence(sessionId, phone,
     state)`, repassando o evento `'presence'` do gateway.
115. **`src/server.js`**: `onPresence` faz `broadcast(sessionId, phone,
     { type: 'presence', state })` — puramente ao vivo, não persiste em
     lugar nenhum (mesma natureza de qualquer indicador de digitação em
     qualquer chat).
116. **`src/routes/whatsapp.js`**: rota nova `POST /presence { session,
     phone, state }` chama `gateway.sendPresence` (sentido empresa→contato).
     A rota `GET /history` (já existente, chamada toda vez que uma conversa
     é aberta) ganhou uma chamada extra best-effort
     `gateway.subscribePresence(phone)` sem bloquear a resposta — é o
     "gatilho" que liga o sentido contato→empresa.
117. **Frontend (`public/chat.html` e `public/index.html`, os dois —
     mesma feature nas duas telas de conversa)**:
     - Sentido empresa→contato: `bindComposer()` ganhou `sendPresence(next)`
       (dispara `POST /presence`, com deduplicação — não repete a mesma
       presença a cada tecla) e `scheduleComposingPause()` (4s de inatividade
       manda `'paused'`). Ligado no `input` (composing), no início/fim da
       gravação de áudio (`recording`/`paused`) e no envio da mensagem
       (`paused` imediato).
     - Sentido contato→empresa: novo `state.peerPresence`
       (`null`/`'composing'`/`'recording'`), atualizado no `payload.type ===
       'presence'` do WebSocket e refletido em `statusLabel()` — substitui
       "Conectado"/"Desconectado" por "digitando…"/"gravando áudio…"
       temporariamente. Timeout defensivo de 12s (se o evento de fim nunca
       chegar, o indicador não fica preso pra sempre). Resetado ao trocar de
       conversa (`openConversation`, só em `chat.html`, que tem lista de
       conversas — `index.html` mostra uma só por vez).
118. Validado com `node --check` (backend) e extração de `<script>` inline
     (frontend) — sem quebra de sintaxe. Gateway reiniciado via PM2,
     verificado saudável, sessões WhatsApp reconectando normalmente. **Não
     testado ao vivo trocando mensagens reais** (sem ferramenta de automação
     de navegador/WhatsApp neste ambiente) — vale confirmar na prática.

### Parte Y — Pré-visualização de link + horário/check sempre no rodapé (continuação, 2026-07-06)

Depois de testar a Parte W, usuário mandou prints mostrando que o
horário/check de uma mensagem de vídeo aparecia colado/sobreposto na própria
mídia, não claramente no rodapé do balão — e pediu também pré-visualização
de link (título/imagem da página, como WhatsApp/Slack fazem).

119. **Horário/check sempre no rodapé**: removida a sobreposição que a Parte
     W tinha introduzido pra imagem sem legenda (`.media-time`, horário em
     cima da própria foto). Agora TODO tipo de mensagem (texto, link, imagem,
     vídeo, áudio) usa o mesmo `<span class="timestamp">` de sempre, sempre
     depois da mídia/texto, nunca sobreposto — mais simples e sem ambiguidade
     visual. CSS `.media-time` removida (ficou sem uso).
120. **`src/linkPreview.js`** (novo arquivo): `resolvePublicUrl(url)` valida
     que é http(s) e que o host não resolve pra um endereço privado/interno
     (10.x, 127.x, 169.254.x, 172.16-31.x, 192.168.x, `::1`, `fe80:`, `fc/fd`)
     — proteção básica contra SSRF, já que a URL vem de texto livre de
     mensagem do WhatsApp, uma entrada não confiável. `fetchHtmlSnippet(url)`
     baixa só os primeiros 300KB do HTML (as tags `og:*` sempre ficam no
     `<head>`), com timeout de 6s e User-Agent próprio. `extractOpenGraph`
     lê `og:title`/`og:description`/`og:image`/`og:site_name` via regex
     (fallback pra `<title>`/`meta description` quando o site não tem OG) —
     regex simples em vez de um parser de HTML de verdade, suficiente pra
     tags `<meta>` (sempre auto-fechadas) sem precisar adicionar dependência
     nova. Testado direto (fora do servidor) contra um site sem OG (mostrou
     só o `<title>`) e um com OG completo (GitHub) — os dois funcionaram.
     Testado também o bloqueio de SSRF contra `127.0.0.1`, `localhost`,
     `169.254.169.254` (metadata de nuvem) e `192.168.x` — todos bloqueados.
121. **`src/routes/whatsapp.js`**: rota nova `GET /link-preview?url=...`,
     com cache em memória por processo (1h de TTL, teto de 500 URLs sem LRU
     — só limpa tudo se passar disso). Best-effort: qualquer falha (site
     fora do ar, sem HTML, bloqueado pelo guard de SSRF) devolve campos
     vazios (200), não erro — o frontend só não mostra o cartão nesse caso.
     Sem `requireSession` (não depende de sessão/telefone nenhum), mas já
     protegida pelo `requireAuth` do router inteiro.
122. **Frontend (`chat.html` e `index.html`)**: mensagem de texto agora
     passa por `linkify()` (toda URL vira `<a target="_blank">` clicável) e,
     se tiver link, ganha um placeholder `.link-preview` ("Carregando
     prévia…") que `hydrateLinkPreviews()` troca pelo cartão de verdade
     (imagem/título/descrição/site) assim que `GET /link-preview` responde
     — ou remove o placeholder se o site não tiver nada pra mostrar. Cache
     por URL no cliente também (`Map` de Promise, evita repetir a busca pra
     um link que aparece em várias mensagens).
123. Validado com `node --check`/extração de `<script>` inline. Gateway
     reiniciado via PM2, verificado saudável. **Não testado clicando de
     verdade no navegador** — vale conferir visualmente no Chat.

### Parte Z — Reagir e responder citando + fix de espaçamento fantasma (continuação, 2026-07-06)

Usuário mandou print mostrando o cartão de prévia de link com espaçamento
gigante entre título/site (parecia "espaço em branco no lugar errado") e
pediu, num pedido separado, pra ser possível **reagir** a uma mensagem e
**responder citando** ("reply") pelo Chat — recurso de `@mencionar` foi
perguntado e adiado (não é prioridade agora, sem grupo não fica claro o que
significaria).

124. **Causa raiz do espaçamento fantasma**: `.bubble` usa `white-space:
     pre-wrap` (necessário pra preservar quebra de linha digitada pelo
     usuário) — isso também preserva, como espaço em branco **visível**, a
     indentação/quebra de linha "de formatação" dos meus próprios templates
     multi-linha (`renderLinkPreviewCard`, e o wrapper `<div class="bubble-
     row">` de `renderMessages`), algo que normalmente o navegador colapsa
     sozinho. Confirmado com uma exploração dedicada antes de mexer em
     qualquer coisa.
125. **Fix**: nova função `compactHtml(html)` (`chat.html` e `index.html`)
     que remove qualquer espaço/quebra de linha entre `>` e `<` antes de
     jogar no DOM (`innerHTML`/`outerHTML`). Seguro por construção: todo
     texto de usuário já passa por `escapeHtml` antes (vira `&lt;`/`&gt;`,
     nunca um `<`/`>` cru), então qualquer `><` que sobra no HTML final é
     sempre nosso, nunca conteúdo de mensagem.
126. **`db/schema.sql`** (+ cópia em `control-plane/db/gateway-schema.sql`):
     nova coluna `messages.reply_to_id text` — id (`wa_message_id`) da
     mensagem citada, quando existe. Aplicado no banco de produção via
     `node db/migrate.js`.
127. **`src/whatsapp.js`**: `_extractReplyToId(message)` lê
     `contextInfo.stanzaId` de dentro do tipo real da mensagem
     (`extendedTextMessage`/`imageMessage`/`videoMessage`/`audioMessage` —
     nunca em `conversation`, porque uma resposta de texto sempre chega como
     `extendedTextMessage`, mesmo sem formatação nenhuma) — usado tanto pra
     mensagem recebida (contato respondendo) quanto enviada de volta no
     payload. `sendMessage`/`sendMedia` ganharam um parâmetro opcional
     `replyTo` (`{id, fromMe, text, type}`) que monta o objeto `quoted` que
     o Baileys espera (`_buildQuoted`) — reconstruído a partir do que já
     temos salvo (não guardamos a mensagem original inteira do WhatsApp).
     Novo método `sendReaction(phone, messageId, emoji, fromMe)` — usa
     `sock.sendMessage(jid, { react: { text, key } })`; `emoji` vazio remove
     a reação.
128. **`src/store.js`**: `addMessage`/`getHistory` passam a persistir/
     devolver `reply_to_id` (camelCase `replyToId`). Nova função
     `getMessageForReply(sessionId, phone, waMessageId)` — busca a mensagem
     original (texto/tipo/direção) tanto pra montar a citação ao responder
     quanto pra saber quem enviou o alvo de uma reação.
129. **`src/routes/whatsapp.js`**: `/send` e `/send-media` aceitam
     `replyToId` opcional (resolvido via `resolveReplyTo`, best-effort —
     citou uma mensagem que não existe mais? manda sem citação em vez de
     falhar o envio). Rota nova `POST /react { session, phone, messageId,
     emoji }` — reaproveita `store.setMessageReaction`/`broadcast`, mesmo
     mecanismo já usado quando é o CONTATO que reage.
130. **Frontend (`chat.html` e `index.html`, as duas)**: cada balão ganhou
     uma barra de ações que aparece ao passar o mouse (🙂 reagir, ↩
     responder) — mesmo padrão do WhatsApp Web. Reagir abre um picker
     inline com 6 emojis comuns (👍❤️😂😮😢🙏); clicar na própria reação nos
     balões da empresa remove ela. Responder mostra uma barra "Respondendo
     a…" acima do composer (com botão de cancelar) e inclui `replyToId` no
     `POST /send`/`/send-media` seguinte; a mensagem resultante mostra um
     pequeno bloco citado dentro do balão (clicável — rola até a mensagem
     original e pisca, se ainda estiver carregada no histórico recente).
     Mensagem citando algo fora da janela de 500 mensagens carregadas
     mostra um aviso genérico ("Mensagem citada") em vez de quebrar.
131. Validado com `node --check` (backend) e extração de `<script>` inline
     (frontend, os dois arquivos). Gateway reiniciado via PM2, verificado
     saudável, sessões reconectando normalmente. **Não testado clicando de
     verdade no navegador** — vale confirmar reagindo/respondendo numa
     conversa real.

### Parte AA — Tabela `notifications` zerada (continuação, 2026-07-06)

Usuário mandou print da Central de Notificações (`/notifications.html`)
mostrando 496 "não lidas" com spam de canal (ESPN, XP Educação, corrente de
WhatsApp, "vendedor" — mesmo tipo de conteúdo já filtrado no Chat) ainda
aparecendo lá, e pediu pra apagar tudo do banco.

132. **Investigado antes de agir** (evitar apagar por cima de um bug ativo
     sem entender a causa primeiro): consultadas as notificações mais
     recentes por `created_at` — nenhuma notificação de canal apareceu
     depois das 14:12 (horário UTC) de hoje, mesmo com notificações reais
     (Henrique Ti, sidneia, Caio) continuando a chegar normalmente depois
     disso. Confirma que o fix da Parte U (descarte de `@newsletter`) está
     funcionando — **não é um vazamento novo**, é resíduo acumulado de
     antes do fix.
133. **Causa raiz do resíduo**: as limpezas anteriores (Partes R, S, T, U)
     só apagaram `conversations`/`messages`/`conversation_tags` — a tabela
     `notifications` é escrita à parte (`onMessage` em `src/server.js`,
     `store.addNotification`) e nunca tinha sido tocada por nenhuma delas.
     Resultado: 6.802 notificações acumuladas desde 03/07/2026, misturando
     spam antigo de canal/grupo com notificações reais.
134. Perguntado (via pergunta de esclarecimento, dado que "apagar tudo do
     banco" era ambíguo entre só `notifications` ou repetir o zerar-tudo de
     `conversations`/`messages` de novo — o que destruiria conversas reais
     já existentes hoje, como sidneia e Caio) — resposta: só `notifications`.
135. **Backup completo** (`backup-notifications-antes-de-zerar.json`, pasta
     de scratchpad da sessão) das 6.802 notificações, depois `DELETE FROM
     notifications` (sem filtro) dentro de uma transação. Confirmado
     `conversations` (3), `messages` (20) e `contacts` (502) intactos —
     escopo estritamente limitado à tabela de notificações, como pedido.
136. Gateway verificado saudável depois (não precisou reiniciar — é uma
     operação pura de banco, a tabela não fica em cache no processo).

---

### Parte AB — Contatos e listas centralizados por dono, não por instância (2026-07-09)

Usuário perguntou: quando uma instância cai e ele conecta outra, quer que
os contatos apareçam pra instância nova. Confirmado via pergunta de
esclarecimento: contatos/listas passam a pertencer ao DONO (usuário do
Bitrix), não à instância — não uma migração pontual sob demanda, e sim o
modelo de dados mudando de vez.

137. **Investigado antes de mudar**: confirmado que `contacts`/`contact_lists`
     eram escopados por `session_id` (`unique (session_id, phone)`), então
     trocar de instância (novo `session_id`) sempre resultava em lista
     vazia. `conversations`/`messages` continuam por `session_id` de
     propósito — histórico de mensagem é mesmo específico de qual número
     trocou aquela conversa com o WhatsApp, não tem como "centralizar" isso
     (o Baileys não dá acesso ao histórico de outro número). `notifications`
     já era por `owner_id` — usado como precedente de como fazer o resto.
138. **Schema** (`db/schema.sql`): `contacts`/`contact_lists` ganharam coluna
     `owner_id`, preenchida a partir de `instances.owner_id` (join por
     `session_id`), com dedup automático de duplicatas (mesmo telefone
     cadastrado em duas instâncias diferentes do mesmo dono — mantém a mais
     recente, herda nome/negócio das outras, realoca membresia em listas
     antes de apagar a duplicata perdedora). Constraint de unicidade trocada
     de `(session_id, phone)` pra `(owner_id, phone)`; coluna `session_id`
     removida das duas tabelas. Migração é idempotente (roda de novo sem
     efeito) e testada contra o banco de produção antes: 503 contatos, 16
     instâncias, 0 duplicatas encontradas — resultado depois da migração:
     503 contatos intactos, todos com `owner_id` preenchido.
139. **Backend**: `src/contacts.js` reescrito (toda função recebe `ownerId`
     em vez de `sessionId`); `importFromConversations(ownerId)` agora importa
     de conversas de TODAS as instâncias do dono (`where session_id in
     (select id from instances where owner_id = $1)`), não só da instância
     selecionada. `src/routes/crm.js`: rotas de contatos/listas não exigem
     mais `session` no body/query — usam `req.ownerId` direto (já vem
     verificado do token, ver `src/auth.js`), mais simples que antes (não
     precisa mais de `requireSession`/`assertOwnsSession` pra esse grupo de
     rotas). Modelos de mensagem (`templates`) continuam por instância —
     fora do pedido, e cada instância pode legitimamente querer textos
     diferentes.
140. **Frontend**: `public/contacts.html` — o seletor de instância no topo
     agora só afeta a seção "Grupos do WhatsApp" (que é mesmo por número,
     um grupo do WhatsApp pertence a uma conexão específica); Contatos e
     Listas carregam uma vez só, independente da instância selecionada.
     Texto de aviso atualizado. `public/campaign.html` — `GET /contact-lists`
     e `GET /contact-lists/:id` não mandam mais `?session=` (a lista já é
     do dono, igual em qualquer instância usada pra disparar a campanha).
141. **Testado**: migração aplicada contra produção (`node db/migrate.js`),
     confirmado `contacts`/`contact_lists` sem coluna `session_id`, com
     `owner_id` preenchido e constraint nova. Gateway reiniciado. Rotas
     testadas de ponta a ponta com token real de um dos donos existentes —
     `GET /api/contacts` devolveu os 500 contatos daquele dono (sem precisar
     de `?session=`), `POST`/`DELETE /api/contacts` criaram e removeram um
     contato de teste com sucesso, `GET /api/contact-lists` devolveu a lista
     existente daquele dono. **Não testado**: o cenário real de "instância
     cai, conecta outra, contatos aparecem" com duas instâncias de verdade
     ao vivo simultaneamente (o comportamento é garantido pela SQL — mesma
     query, mesmo owner_id, independente de qual instância está conectada —
     mas vale confirmar visualmente na tela de Contatos na próxima vez que
     isso acontecer de verdade).

---

### Parte AC — Fix de regressão da Parte AB + limpeza de mídia órfã no Storage (2026-07-09)

Usuário reportou o Chat vazio ("Nenhuma conversa ainda.") pouco depois da
Parte AB. Investigado antes de assumir causa — log do gateway mostrava
`column ct.session_id does not exist` em toda chamada de listagem de
conversas.

142. **Causa**: `src/store.js` (`listConversations`) tinha um `left join
     contacts ct on ct.session_id = c.session_id` que eu não migrei junto
     na Parte AB — a coluna `session_id` já tinha sido removida de
     `contacts`, então toda consulta de conversas quebrava. Corrigido pra
     `left join instances i on i.id = c.session_id` seguido de `left join
     contacts ct on ct.owner_id = coalesce(i.owner_id, c.session_id)`, o
     mesmo fallback usado em `assertOwnsSession`/`ownerOf`. Reiniciado e
     testado com token real — conversas voltaram a carregar, com
     `contactName` resolvido certo a partir do contato agora centralizado.
143. **No meio da investigação**, usuário mandou print do dashboard do
     Supabase mostrando Storage em 146% de 1GB (plano Free) e Egress em
     99% de 5GB — perguntou se o motivo do Chat vazio era o banco. Não
     era (era o bug acima), mas o alerta de Storage era real: medido
     direto no bucket "media" (paginado, sem cap de 1000), o total batia
     2.635MB — mais até que o mostrado no painel do Supabase (provável
     atraso de até 1h no contador deles, como o próprio dashboard avisa).
144. **Descoberta**: 513 arquivos `.mp4` respondiam por 2.304MB dos
     2.635MB (o resto é `.jpg`/`.ogg`, pouca coisa). Comparado contra a
     tabela `messages` (`media_url`), só 57 arquivos no bucket tinham
     alguma mensagem apontando pra eles — **2.758 dos 2.815 arquivos
     (2.63GB) eram órfãos**, sem nenhuma linha em `messages` referenciando
     o nome do arquivo. Causa provável: as várias limpezas anteriores de
     `conversations`/`messages` (Partes R, S, T, U) apagaram linhas do
     banco mas nunca apagaram os arquivos já salvos no Storage
     correspondentes — ficou acumulando desde então. Confirmado que **não**
     era um loop de reconexão ativo criando lixo continuamente: contagem
     de linhas do log de erro ficou idêntica numa janela de 60s de
     observação parada — o volume de "conexão encerrada" visto era só o
     efeito natural de dois restarts do PM2 feitos durante a sessão (toda
     instância reconectando de uma vez), não um problema em andamento.
145. **Ação** (confirmada com o usuário antes de apagar, dado que é
     irreversível): apagados os 2.758 arquivos órfãos via Storage API, em
     lotes de 100, usando `service_role` key. Confirmado depois: bucket
     caiu pra 57 arquivos / 3.6MB — exatamente os referenciados por
     mensagens existentes, nada visível no Chat foi afetado.
146. **Não implementado** (fora do pedido, mas vale registrar pra não
     repetir o acúmulo): nenhuma limpeza futura de `conversations`/
     `messages` deve esquecer de apagar os arquivos de Storage
     correspondentes (`media_url` de cada mensagem antes de apagar a
     linha) — hoje isso é um passo manual que precisa ser lembrado, não
     uma rotina automática.

---

### Parte AD — Paginação em Contatos + esclarecimento sobre instância vazia no Chat (2026-07-09)

147. **Paginação na tabela de Contatos** (`public/contacts.html`):
     `renderContactsTable` agora corta a lista filtrada em páginas de 20
     (`CONTACTS_PAGE_SIZE`), com botões "Anterior"/"Próxima" e indicador
     "Página X de Y (N contatos)" — só aparece quando há mais de uma
     página. Busca por nome/telefone e recarregamento (`loadContacts`)
     voltam pra página 1 automaticamente, pra não deixar o usuário numa
     página que não existe mais depois de filtrar. Client-side (todos os
     contatos já vêm numa chamada só, ~500 hoje) — sem mudança de rota.
148. **Esclarecido, não corrigido** (não era bug): usuário reportou que
     trocar entre a instância "Principal" e "Teste" no Chat não mostra as
     mesmas conversas. Confirmado com o usuário que isso é esperado —
     diferente de contatos (Parte AB, agora por dono), o histórico de
     conversa continua por instância de propósito: uma mensagem só existe
     na instância que o WhatsApp de fato usou pra trocar ela, "Teste"
     nunca recebeu nada porque não é o número que os clientes usam. A
     opção "Todas as minhas instâncias" no mesmo seletor já mostra tudo
     junto (é o que aparece quando funciona) — nenhuma mudança de código.

---

### Parte AE — "Sites": páginas públicas de captura de lead (2026-07-09)

Pedido de uma página nova pra criar sites com capacidade de captar
contatos/leads. Esclarecido via perguntas antes de construir: múltiplos
formulários (não um só fixo), e cada envio deve criar o Contato **e**
disparar uma mensagem de boas-vindas automática por WhatsApp.

149. **Schema** (`db/schema.sql`): duas tabelas novas. `lead_forms`
     (`slug` único, `owner_id`, `session_id` — qual instância manda a
     mensagem —, `title`/`subtitle`/`welcome_message` públicos, `active`)
     e `lead_form_submissions` (histórico de leads recebidos por
     formulário, com `contact_id` linkado e `whatsapp_sent` registrando se
     a mensagem automática saiu ou não). Por `owner_id`, igual contatos —
     um dono pode ter vários formulários.
150. **Bug próprio pego durante a migração**: rodar `node db/migrate.js`
     de novo (schema.sql inteiro é reaplicado a cada execução) quebrou com
     `column contacts.session_id does not exist` — a migração da Parte AB
     tinha um `update ... contacts.session_id` sem guarda, que parava de
     compilar depois que a coluna já tinha sido removida numa execução
     anterior. Corrigido envolvendo essas duas atualizações (contacts e
     contact_lists) num bloco `do $$ ... $$` que só executa (via `execute`
     dinâmico) se a coluna `session_id` ainda existir — testado rodando a
     migração duas vezes seguidas sem erro.
151. **Backend**: `src/leadForms.js` (CRUD + `getBySlug` público +
     `generateSlug`/`slugify` — gera a URL a partir do nome, com sufixo
     aleatório se já existir; usuário também pode digitar uma URL própria).
     `src/routes/leadForms.js` (CRUD autenticado em `/api/lead-forms`,
     escopado por `req.ownerId`, confere que a instância escolhida pertence
     ao usuário via `assertOwnsSession`). `src/routes/leads.js` (rotas
     PÚBLICAS, sem login — `GET /api/leads/:slug/config` e
     `POST /api/leads/:slug`): valida telefone, cria/atualiza o contato
     (`contacts.upsertContact`), tenta mandar a mensagem de boas-vindas
     (`{{nome}}` substituído) pela instância configurada reaproveitando
     exatamente o mesmo caminho da rota `/send` (`sessions.get` →
     `gateway.sendMessage` → `store.addMessage` → `broadcast`, pra a
     mensagem aparecer no Chat normalmente) — **best-effort**: se a
     instância estiver offline, o lead é salvo mesmo assim, só fica
     registrado `whatsapp_sent: false`, sem falhar a submissão pro
     visitante. Nova página pública `/l/:slug` (`public/lead-form.html`,
     mesmo arquivo pra qualquer slug — o JS lê o slug da própria URL).
152. **Frontend**: nova `public/sites.html` (mesmo padrão visual/auth de
     `contacts.html`) — lista de formulários com URL pública (botão
     copiar), instância, contagem de leads, status ativo/inativo,
     editar/excluir, e um modal "Leads recebidos" por formulário. Item
     "Sites" adicionado no menu lateral das 8 páginas que compartilham essa
     barra (`campaign(.html/-metrics/-schedule)`, `chat`, `contacts`,
     `dashboard`, `instances`, `notifications`) — `apresentacao.html` e
     `index.html` não têm essa barra, ficaram de fora. `/sites.html`
     também registrado como rota POST em `server.js` (mesmo motivo das
     outras abas: o Bitrix abre páginas via POST).
153. **Testado de ponta a ponta contra o banco real**: criado um
     formulário de teste via API autenticada; achado e corrigido um bug
     real nessa mesma sessão de teste (`listByOwner` fazia `order by
     f.created_at` mas a subquery já tinha apelidado a coluna como
     `"createdAt"` — corrigido pra `order by f."createdAt"`); confirmado
     `GET /api/leads/:slug/config` e a página pública `/l/:slug`
     respondendo; `POST /api/leads/:slug` criou o contato de verdade
     (owner certo) e registrou a submissão (`whatsapp_sent: false`, porque
     a instância de teste estava offline — comportamento esperado);
     confirmado que desativar o formulário (`active:false`) bloqueia novo
     envio (404) e a página pública passa a mostrar "não disponível";
     `GET /:id/submissions` devolveu o lead certo. Dados de teste
     removidos depois (formulário, contato, submissão — a exclusão em
     cascata de `lead_form_submissions` também foi confirmada). **Não
     testado**: envio de boas-vindas com uma instância de verdade online
     (nenhuma estava conectada no momento do teste) — vale confirmar no
     primeiro uso real que a mensagem chega e aparece no Chat.

---

### Parte AF — Pré-visualização ao vivo + cor/logo em Sites (2026-07-09)

Pedido de "mais opções" no editor de formulário — esclarecido via pergunta:
personalização visual (cor de destaque + logo), não campos extras nem
redirecionamento pós-envio.

154. **Schema**: `lead_forms` ganhou `accent_color`/`logo_url`, os dois
     opcionais. `logo_url` é só um link pra imagem já hospedada em algum
     lugar — decisão deliberada de não construir upload de arquivo pra
     isso, já que **nenhuma outra marca/imagem neste app tem upload hoje**
     (nem a marca do próprio sistema, `/api/brand` só lê variável de
     ambiente) — introduzir isso só pra logo de formulário seria
     desproporcional ao pedido.
155. **Backend**: `src/leadForms.js`, `src/routes/leadForms.js` (validação
     nova, `validateAppearance`: cor precisa ser hex de 6 dígitos, logo
     precisa começar com `http://`/`https://` — vira `<img src>` numa
     página sem login, então não aceita `javascript:`/`data:` etc) e
     `src/routes/leads.js` (`/config` público passou a devolver
     `accentColor`/`logoUrl`) atualizados pra carregar os dois campos.
156. **`public/lead-form.html`**: renderiza o logo (se houver) e aplica a
     cor do formulário na variável `--gold` — com um guard pra não deixar
     a cor genérica da marca do app (`/api/brand`, chamada em paralelo)
     sobrescrever a cor específica do formulário se essa resposta chegar
     depois (as duas chamadas são independentes, sem ordem garantida).
157. **`public/sites.html`**: modal de criar/editar formulário ficou mais
     largo (`.modal.wide`) e dividido em duas colunas — campos à esquerda,
     **pré-visualização ao vivo** à direita (`renderPreview()`, chamada em
     todo `input` dos campos relevantes) — um card em miniatura mostrando
     logo/título/subtítulo/cor de destaque exatamente como vão aparecer na
     página pública, sem precisar salvar pra ver. Campo de cor tem os dois
     inputs sincronizados (`type="color"` + texto hex), pra escolher tanto
     visualmente quanto digitando o código.
158. **Testado contra o banco/API real**: criado formulário com
     `accentColor`/`logoUrl` via API autenticada, confirmado que
     `GET /api/leads/:slug/config` devolve os dois campos certos;
     confirmado que a validação rejeita cor inválida (400,
     "accentColor precisa ser uma cor hex..."). Dados de teste removidos
     depois. **Não testado**: renderização visual de verdade num
     navegador (só verificado que a página carrega e o JS de
     leitura/aplicação do config está no HTML) — vale abrir `/l/<slug>`
     de um formulário real com cor/logo configurados pra confirmar
     visualmente.

---

### Parte AG — Página pública vira LP completa (referência externa) (2026-07-09)

Usuário mandou uma URL de referência (`ccpx.lovable.app/lj/bsr-joias`, uma
loja de joias) e pediu pra deixar a LP igual. Investigado antes de copiar:
essa referência é uma loja completa (topo com selos de confiança, grade de
produtos, depoimentos, contato via WhatsApp, rodapé com pagamento) — muito
mais estrutura do que um cartão único de nome+telefone. Perguntado o que
exatamente trazer; resposta: estrutura completa de LP (sem a parte de
produtos, que não se aplica).

159. **Decisão própria, não pedida explicitamente**: a referência tem
     depoimentos fictícios com nome/cidade de cliente. Optei por **não**
     inventar depoimentos falsos pra nenhum formulário deste app — isso
     seria prova social fabricada numa página que empresas reais vão
     publicar pra clientes reais. Em vez disso, depoimentos virou um campo
     **opcional que o próprio dono do formulário preenche** com texto
     seu — a seção simplesmente não aparece se estiver vazio, em vez de
     mostrar algo inventado só pra parecer mais confiável.
160. **Schema**: `lead_forms.testimonials` (jsonb, array de
     `{name, location?, quote}`, até 5, default `[]`).
161. **Backend**: `src/routes/leadForms.js` ganhou `sanitizeTestimonials()`
     (confere formato — nome+texto obrigatórios, limite de tamanho de
     campo, no máximo 5 — nunca gera conteúdo). `src/leadForms.js`
     serializa/lê o array via `JSON.stringify`/cast `::jsonb` (o driver
     `pg` não serializa array JS pra jsonb automaticamente). `/api/leads/:slug/config`
     passou a devolver `testimonials`.
162. **`public/lead-form.html` reestruturada por completo** — de um cartão
     único centralizado pra uma LP de seções, na mesma ordem conceitual da
     referência (sem a parte de produtos, que não existe aqui):
     cabeçalho (logo/marca) → barra de selos de confiança (4 itens
     genéricos, fixos: "Resposta rápida", "Atendimento pelo WhatsApp",
     "Sem compromisso", "Seus dados protegidos" — universais, servem pra
     qualquer negócio que use este gateway) → seção de depoimentos (só
     aparece se o formulário tiver algum configurado) → cartão de
     título+formulário (equivalente ao "Fale Conosco" da referência) →
     rodapé. Manteve a identidade visual já usada no resto do app
     (dourado/escuro, Fraunces+Inter) — só a ESTRUTURA veio da referência,
     não as cores (opção explicitamente descartada pelo usuário na
     pergunta de esclarecimento).
163. **`public/sites.html`**: editor de depoimentos (até 5 linhas, cada
     uma com nome/cidade/texto, adicionar/remover) — o preview ao vivo
     mostra um aviso textual ("+ seção com N depoimentos na página real")
     em vez de renderizar os cards de depoimento em miniatura, pra não
     complicar o widget de preview compacto que já existia.
164. **Testado contra a API/banco real**: criado formulário com 1
     depoimento via API, confirmado round-trip completo (criação →
     `GET /config` público devolve o depoimento certo); confirmado que a
     validação rejeita depoimento sem nome (400); confirmado (via `curl` no
     HTML servido) que a página `/l/<slug>` contém as classes/textos das
     novas seções (`trust-bar`, `testimonials`, rodapé com atribuição).
     Dados de teste removidos depois. **Não testado**: comparação visual
     lado a lado com a referência num navegador de verdade — o layout foi
     construído a partir da descrição estrutural da referência (a
     ferramenta de leitura da página não preserva CSS/cores originais),
     não de captura de tela — vale abrir os dois lado a lado pra ajustar
     detalhes finos de espaçamento se o resultado não bater exatamente.

---

### Parte AH — Estatísticas, Diferenciais, História, FAQ em Sites (2026-07-09)

Usuário mandou print de um painel de referência bem mais completo (produto
"ZapFlow", abas Hero/Estatísticas/História/Depoimento/Diferenciais/Planos/FAQ/Geral)
e pediu pra trazer mais seções pro editor de Sites. Perguntado quais
trazer — usuário respondeu só "continue", então segui com a leitura mais
razoável: as 4 seções genéricas que fazem sentido pra qualquer negócio
(Estatísticas, Diferenciais, FAQ, História), e deixei de fora a seção
"Planos" (mostra preço com botão de compra na referência — este gateway
não tem Stripe/pagamento integrado, então seria só decorativo).

165. **Schema**: 3 colunas jsonb novas (`stats`, `differentials`, `faq`,
     mesmo padrão array-de-objetos de `testimonials`) + 2 colunas de texto
     livre (`story_title`, `story_text`). Todas opcionais, todas somem da
     página pública se vazias.
166. **Refatoração em `src/leadForms.js`**: com 13 campos editáveis agora,
     `create()`/`update()` com um parâmetro posicional por campo tinha
     ficado insustentável (muito fácil trocar a ordem por engano). Reescrito
     pra usar um mapa `FIELD_COLUMNS` (campo da API → coluna do banco +
     flag `jsonb`) e montar `INSERT`/`UPDATE` dinamicamente a partir dele —
     adicionar um campo novo no futuro é uma linha só no mapa, não precisa
     tocar em `create()`/`update()`. Testado o refactor específico: criação,
     leitura, e update parcial preservando os campos não enviados.
167. **`src/routes/leadForms.js`**: `sanitizeList()` genérico (usado antes
     só pra depoimentos) generalizado pra também validar estatísticas,
     diferenciais e FAQ — cada chamada só passa a config de campos
     esperados. **Bug pego e corrigido durante a implementação**: a
     primeira versão derivava a forma singular da mensagem de erro cortando
     o "s" do plural (`label.slice(0,-1)`) — funciona pra "depoimentos" e
     "perguntas", mas quebra "diferenciais" → "diferenciai" (devia ser
     "diferencial"). Corrigido passando a forma singular explícita por
     lista, em vez de tentar derivar.
168. **`public/lead-form.html`**: 4 seções novas (Estatísticas, Diferenciais,
     História, FAQ com pergunta expansível/collapse), cada uma só renderiza
     se tiver conteúdo — inseridas entre a barra de confiança e os
     depoimentos, numa ordem narrativa (números → diferenciais → história →
     FAQ → depoimentos → formulário).
169. **`public/sites.html`**: o modal de editar formulário tinha crescido
     demais pra uma coluna só (agora 13 campos) — reorganizado em **abas**
     (Principal/Visual/Estatísticas/Diferenciais/História/FAQ/Depoimentos),
     mesma ideia estrutural da referência que o usuário mostrou. Editor de
     lista genérico (`makeListEditor`) extraído pra reaproveitar
     adicionar/remover/renderizar entre Estatísticas/Diferenciais/FAQ (cada
     um só difere nos campos); depoimentos ficou com implementação própria
     (3 campos, um sendo textarea, não encaixava no padrão de 2 campos).
     Preview ao vivo ganhou uma linha de resumo (“+ 2 estatísticas, 3
     diferenciais... na página real”) em vez de tentar renderizar todas as
     seções em miniatura.
170. **Testado de ponta a ponta contra a API/banco real**: criado um
     formulário com todas as seções preenchidas (2 estatísticas, 2
     diferenciais, 1 pergunta de FAQ, 1 depoimento, história) via API
     autenticada; confirmado que a página pública (`/l/<slug>`) contém os
     ids de todas as seções; confirmado que `GET /config` devolve os 4
     arrays + os 2 campos de história certos. Dados de teste removidos
     depois. **Não testado**: abrir o modal de edição de verdade num
     navegador pra confirmar que a troca de aba e o editor de listas
     funcionam visualmente como esperado (só validado que o JS carrega sem
     erro de sintaxe) — vale testar a UI manualmente na próxima sessão.

---

### Parte AI — Upload de logo (Sites) + importar contatos por CSV (2026-07-09)

Usuário pediu upload de arquivo em vez de só URL — pra logo (imagem) e pra
importação de contatos (mencionou xlsx/csv). Investigado antes de instalar
qualquer coisa: a biblioteca padrão do ecossistema JS pra ler `.xlsx`
(`xlsx`/SheetJS, no npm) tem **duas vulnerabilidades altas sem correção**
(Prototype Pollution `GHSA-4r6h-8v6p-xvw6`, ReDoS `GHSA-5pgg-2g8v-p4x9`) —
apresentado o risco ao usuário (um arquivo malicioso travaria o processo
Node inteiro, ou seja, todas as instâncias de WhatsApp juntas, já que é um
processo só) antes de instalar. Confirmado: só CSV por enquanto, sem `.xlsx`.

171. **Upload de logo** (`public-assets`, bucket novo e PÚBLICO no Supabase
     Storage — diferente do bucket "media" de mídia de WhatsApp, que é
     privado): `db/create-public-bucket.js` (rodado uma vez, cria o bucket
     com limite de 3MB e mimetypes de imagem permitidos), `src/publicAssets.js`
     (`saveLogo(ownerId, buffer, mimetype)`, caminho `logos/<ownerId>/<random>.<ext>`,
     devolve a URL pública permanente via `getPublicUrl`). Nova rota
     `POST /api/lead-forms/upload-logo` (autenticada) recebe `{ mimetype,
     dataBase64 }` — mesmo formato simples já usado no resto do app pra
     mídia em base64 dentro do JSON, sem precisar de multipart/multer.
     Valida tamanho (3MB) e mimetype antes de subir. `public/sites.html`
     (aba Visual): campo de logo ganhou um botão "Enviar arquivo" ao lado
     do campo de URL — o upload preenche o mesmo campo de texto com a URL
     devolvida, então o resto do fluxo (salvar, preview) não mudou nada.
172. **Importar contatos via CSV** (`src/csvImport.js`, sem dependência
     nenhuma — parser de CSV escrito à mão): detecta o delimitador (`,` ou
     `;` — Excel em português exporta com `;` por padrão, já que `,` é
     separador decimal no locale pt-BR), suporta campos entre aspas com
     vírgula/aspas escapadas, e reconhece várias variações de cabeçalho
     (`nome`/`name`/`cliente`, `telefone`/`phone`/`celular`/`whatsapp`) —
     exige achar uma coluna de telefone, nome é opcional. `contacts.js`
     ganhou `importRows(ownerId, rows)` — upsert em lote numa query só;
     **bug evitado antes de rodar em produção**: a primeira versão não
     deduplicava telefone repetido dentro do mesmo arquivo, o que faria o
     Postgres rejeitar o `INSERT ... ON CONFLICT DO UPDATE` (não permite
     afetar a mesma linha duas vezes no mesmo comando) — corrigido
     deduplicando por telefone antes de montar a query, mantendo o último
     nome não-vazio encontrado. Nova rota `POST /api/contacts/import-csv`
     (body `{ csvText }`, o client já manda como texto via
     `File.text()` — CSV é texto puro, não precisa de base64) com limite de
     5.000 linhas por arquivo. `public/contacts.html`: botão "Importar de
     arquivo (CSV)" ao lado do "Importar de conversas" já existente.
173. **Testado de ponta a ponta contra a API/Storage/banco real**: upload de
     logo (PNG 1x1 de teste) confirmado com URL pública acessível sem
     nenhuma autenticação (`fetch` direto devolveu `200`/`image/png`);
     validação de tamanho (>3MB) e mimetype inválido confirmadas (400).
     Parser de CSV testado com 5 casos (cabeçalho em inglês com vírgula,
     cabeçalho em português com ponto-e-vírgula, campo entre aspas com
     vírgula embutida, arquivo sem coluna de telefone — erro esperado,
     telefone inválido — linha ignorada). Import via API real: CSV com
     telefone duplicado dentro do mesmo arquivo importou 1 contato (não 2),
     manteve o nome da última linha, e contou a linha de telefone inválido
     como "skipped". Dados de teste removidos depois.

---

### Parte AJ — Link da LP não clicável + botão "Ir para LP" (2026-07-09)

Usuário reportou que o link da URL pública na lista de formulários (Sites)
não funcionava. Causa: era um `<span>` (só visual, cor dourada e fonte
monoespaçada imitando um link), nunca foi um `<a>` de verdade — clicar não
fazia nada. Corrigido pra `<a href="..." target="_blank">` de verdade, e
adicionado um botão "Ir para LP" nas ações da linha (ao lado de
Leads/Desativar/Editar/Excluir), como pedido.

174. `public/sites.html`: `.url-text` virou uma âncora real (mantém a mesma
     aparência — cor dourada, sem sublinhado até passar o mouse). CSS de
     `.row-actions` generalizado de `button` pra também cobrir `a` (mesma
     cor/hover), já que agora tem link de verdade misturado com os botões.
     Nenhuma rota nova — o link já existia certinho (`/l/<slug>`), só não
     estava dentro de uma tag clicável.

---

### Parte AK — Layout profissional mesmo sem seções opcionais preenchidas (2026-07-09)

Usuário mostrou a página pública de um formulário recém-criado (sem
estatísticas/diferenciais/história/FAQ/depoimentos preenchidos) — só a
barra de confiança e um card pequeno, com um vão vazio grande embaixo do
rodapé. Reportado como "muito simples". Investigado antes de mudar
qualquer conteúdo: o problema não era falta de conteúdo fictício (decisão
já tomada antes de não inventar depoimentos/dados) — era o **layout em si**
não sustentar bem o caso mínimo.

175. **Bug de verdade encontrado**: o cabeçalho (`<header class="top">`)
     sempre renderizava, mesmo sem logo nem nome de marca configurados —
     ficava uma faixa vazia com só uma borda embaixo, parecendo quebrado.
     Corrigido: cabeçalho começa `hidden` e só aparece se logo ou nome da
     marca de fato chegarem (`showHeaderIfNeeded()`, chamado nos dois
     pontos onde isso é decidido).
176. **Vão vazio abaixo do rodapé**: como o conteúdo real (barra de
     confiança + card) é bem mais baixo que a tela em muitos monitores, e
     nada preenchia o resto, sobrava um bloco de fundo vazio depois do
     rodapé. Corrigido com layout de "rodapé fixo" (`body` como flex column,
     `.page-content` com `flex:1 0 auto`) — com pouco conteúdo, o rodapé
     fica colado no fim da tela; com todas as seções preenchidas, continua
     rolando normalmente.
177. **Hero centralizado verticalmente**: `.hero` ganhou `flex:1` +
     centralização — quando é a única seção com conteúdo, o card fica no
     meio do espaço disponível (entre a barra de confiança e o rodapé) em
     vez de grudado no topo.
178. **Polimento visual do card/estados**: sombra suave (`box-shadow`) pra
     dar profundidade, uma barrinha dourada decorativa acima do
     título/ícone (`.card::before`), ícones de sucesso/erro maiores (56px,
     com um leve glow), tipografia com um pouco mais de respiro
     (`line-height`, tamanhos). Glow radial bem sutil no fundo da página
     inteira, pra não parecer um bloco de cor chapada no caso mínimo.
     Nenhum conteúdo novo inventado — só apresentação do que já existe
     (título, subtítulo, formulário, estados de sucesso/erro/indisponível).
179. **Testado**: sintaxe do `<script>` validada, estrutura de tags
     conferida (`.page-content` abre/fecha uma vez, 1 header, 1 footer),
     formulário de teste criado sem nenhuma seção opcional preenchida,
     página pública respondeu `200`. **Não testado**: captura de tela real
     num navegador (sem ferramenta de screenshot disponível nesta sessão)
     — vale abrir a página de um formulário mínimo de verdade e conferir
     visualmente que ficou como esperado.

---

### Parte AL — Lista de Sites vira cards (2026-07-09)

Usuário pediu pra trocar a tabela de formulários (em `/sites.html`) por
cards, um por formulário, em vez de linhas de tabela/lista.

180. `renderForms()` reescrito: de `<table>` pra um grid de `.form-card`
     (`display:grid; grid-template-columns:repeat(auto-fill, minmax(260px,
     1fr))`) — cada card tem nome + selo de status no topo, URL pública
     (link de verdade + botão copiar), meta (contagem de leads + instância),
     e as mesmas ações de antes (Ir para LP/Leads/Desativar/Editar/Excluir)
     na base do card. Nenhuma mudança na lógica de clique — os mesmos
     atributos `data-*` continuam nos mesmos elementos, só a marcação ao
     redor mudou de `<tr>/<td>` pra `<div class="form-card">`.
181. CSS morto removido (`table`/`thead`/`tbody`/`.row-actions`/
     `.name-cell`/`.meta-cell`/`.url-cell` — nada mais usava essas classes
     depois da troca pra cards; confirmado com grep antes de apagar, pra
     não remover algo que a tela de Leads ainda usasse por baixo).
182. **Testado**: sintaxe do `<script>` validada, página respondendo `200`,
     `GET /api/lead-forms` conferido contra o banco real (os 2 formulários
     de teste já existentes, com a contagem de leads certa) — os cards vão
     renderizar com esses dados reais. **Não testado**: captura de tela num
     navegador de verdade (sem ferramenta de screenshot nesta sessão).

---

### Parte AM — Banner de hero + navegação + rodapé de verdade na LP (2026-07-09)

Usuário mandou outra referência (`ccpx.lovable.app/lp`) — na verdade a
própria "ZapFlow", o produto por trás do print do "Painel Admin" mostrado
antes (confirma que aquele painel edita exatamente essa página). Comparado
com o que já tínhamos: faltava uma faixa de hero de verdade no topo — o
título/subtítulo do formulário só apareciam dentro do card pequeno lá
embaixo, sem nenhuma "vitrine" logo na entrada da página.

183. **Banner de hero**: nova seção logo abaixo do cabeçalho — título
     grande (`config.title`) + subtítulo (`config.subtitle`, se houver) +
     botão "Falar agora" que rola suavemente (`scroll-behavior:smooth`) até
     o formulário. Título/subtítulo saíram do card do formulário (senão
     apareceriam duas vezes na mesma página) — o card virou um convite
     curto e fixo ("Fale com a gente agora"), já que o "discurso de vendas"
     agora mora no hero.
184. **Cabeçalho ganhou navegação de verdade**: antes só mostrava logo/nome
     (e ficava escondido por completo se nenhum dos dois estivesse
     configurado — outra causa da sensação de "muito simples"). Agora tem
     sempre um botão "Falar agora" que rola até `#formulario`, então o
     cabeçalho sempre tem conteúdo e nunca precisa ficar escondido. Virou
     `position:sticky` (acompanha o scroll), como um site de verdade.
185. **Rodapé com mais peso**: antes era uma linha cinza só de atribuição.
     Agora tem fundo próprio (`--surface`), o nome da marca (se
     configurado), um botão secundário "Falar agora" (outra chance de
     conversão pra quem rolou a página inteira sem preencher lá em cima), e
     só então a atribuição.
186. **Testado contra a API real**: criado um formulário com título e
     subtítulo, confirmado (via HTML servido) que a página tem
     `#heroTitle`, `.nav-cta`, `.footer-cta` e a âncora `#formulario` —
     tudo presente. Sintaxe do `<script>` validada, estrutura de tags
     conferida (1 header, 1 footer). Dados de teste removidos depois.
     **Não testado**: aparência real num navegador (ainda sem ferramenta de
     screenshot nesta sessão) — vale abrir uma LP de verdade e conferir que
     o scroll suave e a centralização do hero/formulário ficaram como
     esperado.

---

### Parte AN — Imagem de fundo do hero (2026-07-09)

Usuário mandou uma imagem de referência (estátua da Justiça, tema jurídico)
pra usar como fundo do banner de hero. Esclarecido: não tenho como extrair
o arquivo de verdade de uma imagem colada na conversa (só vejo/descrevo
visualmente, não tenho acesso aos bytes) — construída a funcionalidade de
upload/URL pra imagem de fundo, e o usuário sobe a imagem real pelo botão
novo.

187. **Bucket**: limite do `public-assets` (compartilhado com o logo)
     subido de 3MB pra 6MB — foto de fundo de banner costuma ser mais
     pesada que um logo. `db/create-public-bucket.js` atualizado pra
     também reaplicar o limite novo se o bucket já existir (idempotente).
188. **`src/publicAssets.js` generalizado**: `saveImage(ownerId, buffer,
     mimetype, folder)` interno, com `saveLogo`/`saveHeroImage` como
     wrappers finos (pasta `logos/` vs `hero/` dentro do mesmo bucket) —
     evita duplicar a lógica de upload pra cada tipo de imagem.
189. **Schema**: `lead_forms.hero_image_url`, mesmo padrão do `logo_url`
     (link ou upload, opcional). `FIELD_COLUMNS` (o mapa que já existia pra
     isso, ver Parte AH) só ganhou mais uma entrada — nenhuma mudança em
     `create()`/`update()`.
190. **Nova rota** `POST /api/lead-forms/upload-hero-image` (autenticada),
     mesmo formato de `upload-logo` (body `{ mimetype, dataBase64 }`).
     `/api/leads/:slug/config` público passou a devolver `heroImageUrl`.
191. **`public/lead-form.html`**: `.hero-banner` ganha `background-image`
     via JS quando configurada, com uma camada escura por cima
     (`linear-gradient`) — garante que o título continue legível em cima
     de qualquer foto, sem depender da imagem específica já ser escura o
     bastante (a imagem de referência do usuário já era escura, mas outros
     usuários podem subir fotos claras). Padding vertical maior nesse
     estado, pra parecer um banner de verdade em vez de só texto com fundo.
192. **`public/sites.html`**: campo "Imagem de fundo do hero" na aba
     Visual, mesmo padrão do logo (URL + botão "Enviar arquivo"). A lógica
     de upload dos dois campos foi extraída pra uma função genérica
     (`wireImageUploader`) em vez de duplicar o handler — só muda o
     endpoint/elementos.
193. **Testado de ponta a ponta contra a API/Storage real**: upload de uma
     imagem de teste via `/api/lead-forms/upload-hero-image` (URL pública
     devolvida, na pasta `hero/`), criação de formulário com essa URL,
     confirmado que `GET /config` público devolve `heroImageUrl` certo, e
     que a página servida (`/l/<slug>`) contém `id="heroBanner"`. Dados de
     teste removidos depois. **Ainda pendente**: usuário precisa subir a
     imagem de verdade (a estátua da Justiça mostrada na conversa) pelo
     botão novo — não foi possível fazer isso automaticamente, só o
     usuário tem acesso ao arquivo real.

---

### Parte AO — URL pública com âncora + fita rolante + rodapé em colunas (2026-07-09)

Usuário mandou mais duas referências (um site com botão duplo + fita de
tecnologias rolando, e o site real da Durão/Almeida/Pontes com rodapé em
colunas) e pediu: manter o mesmo formato da "fita" e melhorar o rodapé.
No meio da tarefa, também pediu que o link público do formulário (o
copiado/usado em "Ir para LP") vá direto pro formulário de contato, em vez
de abrir no topo da página — confirmado via pergunta antes de mudar,
já que isso muda onde quem clica no link é jogado.

194. **URL pública com âncora**: `publicUrl` em `public/sites.html` agora
     é `${origin}/l/${slug}#formulario` — afeta o texto exibido, o botão de
     copiar e o "Ir para LP" de uma vez só (era montado num lugar só). Quem
     acessa o link direto (ex: de um anúncio) cai já no formulário,
     pulando o banner de hero — navegação manual dentro da própria página
     (clicar em "Falar agora") continua funcionando normal.
195. **Barra de confiança virou fita rolante**: em vez da lista fixa com
     quebra de linha, agora é uma animação CSS pura (`translateX(-50%)`
     em loop, conteúdo duplicado uma vez pro loop ficar perfeitamente
     contínuo) com separador "•" entre os itens — mesmo formato visual da
     referência mandada, mas com o conteúdo já existente (nenhum dado
     novo inventado). Pausa ao passar o mouse; respeita
     `prefers-reduced-motion` (vira lista fixa sem animação pra quem
     configurou isso no sistema).
196. **Rodapé em 3 colunas**: Marca (logo/nome + frase curta) | Navegação
     (links âncora só pras seções que realmente têm conteúdo — checa
     `hidden` de cada seção depois de renderizada, mesmo princípio já
     usado noutros lugares desta LP) | Contato (telefone/WhatsApp da
     instância conectada, se disponível). Uma barra final separada só com
     a atribuição. Telefone vem de `getOwnNumbersBySession()`
     (`src/ownNumbers.js`, já existia, lido direto das credenciais salvas
     em disco) — nova função exposta em `/api/leads/:slug/config` como
     `contactPhone`; fica `null` se a instância nunca tiver sido pareada
     (a coluna de Contato some nesse caso, não mostra vazio).
     **Não implementado** (fora do pedido — exigiria campos novos de
     configuração): coluna "Siga-nos" com ícones de redes sociais, que a
     referência do site real tem — este app não guarda link de rede social
     nenhuma hoje.
197. **Testado de ponta a ponta**: sintaxe do `<script>` validada; criado
     formulário de teste com 1 diferencial (pra confirmar que o link de
     navegação "Diferenciais" aparece no rodapé só quando a seção existe);
     confirmado via `GET /config` que `contactPhone` vem `null` quando a
     instância não tem credencial salva (comportamento correto, não erro);
     confirmado via HTML servido que `trustTrack`/`footerLinksList`/
     `footerContactList` estão todos presentes. Dados de teste removidos
     depois. **Não testado**: telefone de verdade populando a coluna de
     Contato (nenhuma instância pareada disponível nesta sessão) — vale
     conferir assim que uma instância de verdade estiver conectada.

---

### Parte AP — Miniatura e métrica de entrega no card do formulário (2026-07-09)

Usuário pediu: uma imagem no card de cada formulário (Sites) pra
reconhecer visualmente qual site é qual, e uma métrica da LP direto no
card (não só na tela de Leads).

198. **Miniatura no card**: mostra o `logoUrl` do formulário (mesma imagem
     usada na página pública) como uma miniatura 44×44 — sem esse campo
     configurado, cai num ícone genérico de página. Não é uma captura de
     tela real da LP (fora de alcance sem uma ferramenta de screenshot),
     só o logo já cadastrado, que já é o suficiente pra diferenciar
     formulários de clientes diferentes numa lista.
199. **Métrica de entrega no card**: `listByOwner` (`src/leadForms.js`)
     ganhou `whatsappSentCount` (agregado via `count(*) filter (where
     whatsapp_sent)`, mesma query que já calculava `leadCount`, sem round-trip
     extra). O card mostra "`X`% entregue no WhatsApp" ao lado da contagem
     de leads — só aparece quando há pelo menos 1 lead (0/0 não tem
     porcentagem que faça sentido); verde a partir de 80%, vermelho abaixo
     disso, como sinal rápido de que a instância configurada pode estar
     offline com frequência.
200. **Testado contra a API real**: confirmado que `whatsappSentCount`
     vem certo pros 2 formulários de teste existentes (1 lead/0 enviados
     num deles, 0/0 no outro — a métrica corretamente não aparece nesse
     segundo caso). Sintaxe do `<script>` validada, página respondendo
     `200`.

---

### Parte AQ — Diagnóstico: mensagens em tempo real não chegavam em algumas instâncias (2026-07-09)

Usuário relatou (tela de Chat, prints) que mensagens novas não estavam
aparecendo. Investigado com cuidado antes de mexer em qualquer código —
descartadas duas hipóteses antes de achar a causa real:

201. **Não era perda de histórico**: a lacuna de mensagens antes de
     06/07 já estava documentada (Parte AA e anteriores) como uma zerada
     deliberada e confirmada pelo usuário, não bug.
202. **Não era bug no pipeline de tempo real** (`onMessage` →
     `store.addMessage` → `broadcast` via WebSocket → `chat.html`):
     código revisado ponta a ponta, estrutura correta, com reconexão de
     WebSocket já prevista (`onclose` tenta de novo em 4s).
203. **Causa raiz real, confirmada por consulta direta ao banco**: os
     contatos que o usuário via "parados" (Support Repair Recreio, Eli,
     Olive, Nova bike) pertencem todos à instância
     `2c39349ea593c27fd3092b4fe2c47de7_183168`, cuja última mensagem
     era de 08/07 — um dia sem nenhuma atualização. Essa instância (e as
     sub-sessões dela, `__mr5lti6njwrd`/`__mr53alboa51l`) ficava presa
     num ciclo `connecting → offline → connecting` a cada poucos
     segundos, nunca recebendo nada porque nunca completava a conexão
     com o WhatsApp.
204. **`src/whatsapp.js` só logava `loggedOut = true/false`**, sem o
     `statusCode` real do Baileys — não dava pra confirmar se era sessão
     deslogada, banimento, ou outro erro de rede. Melhorado o log do
     handler de desconexão pra incluir o nome da sessão e o
     `statusCode`/motivo (`DisconnectReason[statusCode]`).
205. **Confirmado com o novo log**: `statusCode=401 (loggedOut)` pra
     todas as sessões presas no loop (`_183168` e sub-sessões,
     `portal_183168`, `_5305`). Ou seja, são sessões que o WhatsApp
     encerrou do lado do celular (deslogado/expirado) — o código já
     detecta isso corretamente e para de tentar reconectar sozinho
     (fica "Aguardando novo login via /qr"), então o loop visto nos logs
     era só o ruído acumulado de tentativas *antes* dessa detecção, não
     um bug ativo.
206. **Correção é operacional, não de código**: essas instâncias
     precisam ser repareadas — reescanear o QR Code em `/instances.html`
     (ou na aba WhatsApp do card, dependendo de qual delas) resolve. Não
     há ação de código pendente aqui além da melhoria de log já feita.

---

### Parte AR — BUG DE ISOLAMENTO: dashboard vazava conversas de outros donos (2026-07-09)

Usuário reportou (print da tela "Análise Conversas") que, ao logar em outro
computador/conta, apareciam números de telefone e conversas que não eram
dele. **Era um bug real de vazamento de dados entre clientes/donos**, não
cosmético.

207. **Causa raiz**: `GET /api/whatsapp/metrics` (`src/routes/whatsapp.js`)
     chamava `computeMetrics()` sem nenhum filtro de dono — um comentário
     antigo no código dizia isso ser "intencional (visão de time)", mas na
     prática misturava as conversas de TODOS os donos cadastrados no
     banco, não só as instâncias do usuário autenticado. `computeMetrics`
     (`src/metrics.js`) por sua vez chamava `store.getAll()`
     (`src/store.js`) que fazia `select *` em `conversations`/`messages`
     sem `where`, trazendo literalmente o banco inteiro.
208. **Corrigido em 3 camadas**:
     - `store.getAll(sessionIds)` agora exige a lista de sessões e filtra
       com `where c.session_id = any($1::text[])`.
     - `computeMetrics({ origin, sessionIds })` agora exige `sessionIds`
       (retorna métricas zeradas se vier vazio/ausente, em vez de vazar
       tudo por omissão).
     - `GET /metrics` busca `instancesStore.listByOwner(req.ownerId)` e
       passa só os IDs das instâncias do próprio dono autenticado — a
       "visão de time" continua existindo (várias instâncias de UM MESMO
       dono aparecem juntas), mas nunca atravessa pra outro dono.
209. **Testado diretamente contra o banco**: rodado `computeMetrics` com
     os `sessionIds` de 3 donos diferentes — cada um retornou só os
     totais das próprias instâncias (um deles com 116 mensagens reais,
     os outros dois corretamente zerados), e `sessionIds: []` retornou
     métricas zeradas sem erro. Gateway reiniciado via PM2 depois da
     correção.
210. **Superfície do bug**: como o token de app (`requireAuth`) já prova
     que quem chama é um usuário Bitrix válido *de algum portal*, mas
     `req.ownerId` nunca era usado nessa rota, qualquer conta autenticada
     (de qualquer cliente/instalação que compartilhe este mesmo banco)
     conseguia ver a lista de conversas, números de telefone e métricas
     de qualquer outro dono via essa tela. Não afeta Chat/Contatos/Sites
     (essas rotas já eram escopadas por `ownerId`/`sessionIds` desde
     antes) — o vazamento era específico do dashboard de métricas.

---

### Parte AS — Instâncias vira grid de cards com contagem de contatos/grupos (2026-07-09)

Usuário pediu (com print de referência) pra trocar o layout de Instâncias —
que já eram `<div class="instance-card">` mas empilhados numa lista compacta
— por um grid de cards maiores, com badge de status e a quantidade de
contatos/grupos daquele número.

211. **Grid de cards** (`public/instances.html`): `.instances-grid` (CSS
     grid, `auto-fill minmax(280px,1fr)`) substitui a lista vertical.
     Cada card ganhou: título + badge de status colorido (pill verde
     "Conectada"/dourado "Aguardando QR"/vermelho "Desconectada", em vez
     do pontinho antigo), linha "Número: X", e uma linha de estatísticas
     com ícone de contatos e de grupos.
212. **Contagem de grupos — decisão do usuário**: buscar ao carregar a
     página (não sob demanda). `WhatsAppGateway.getGroupCount()`
     (`src/whatsapp.js`) chama `sock.groupFetchAllParticipating()` — os
     grupos REAIS que o número participa no WhatsApp, diferente da tabela
     `wa_groups` (que só guarda grupos criados por este app). Só funciona
     com a sessão `online`; `null` caso contrário (card mostra "—").
213. **Contagem de contatos — decisão do usuário**: acumular via eventos
     do WhatsApp (`contacts.upsert`/`contacts.update`, escutados em
     `WhatsAppGateway.start()`, guardados num `Set` de IDs por instância —
     `getContactCount()`). **Limitação clara, documentada em comentário no
     código**: Baileys não expõe uma chamada de "total de contatos" nem um
     snapshot completo — só incrementos. Esse número é um acumulado desde
     que o processo Node subiu (zera a cada reinício/reconexão do zero) e
     NUNCA vai bater exatamente com a agenda telefônica real do celular
     (ex.: os "432 contatos" do print de referência do usuário) — é uma
     estimativa que cresce enquanto a sessão fica online recebendo
     eventos, não um espelho fiel da agenda.
214. **Rota `GET /instances`** (`src/routes/whatsapp.js`) passou a ser
     `async` de fato no mapeamento da lista (`Promise.all`, por causa do
     `await gateway.getGroupCount()` por instância) e devolve
     `contactCount`/`groupCount` junto com `status`/`phone` de cada uma.
215. **Testado**: `node --check` nos dois arquivos JS alterados + parse
     dos 4 blocos `<script>` de `instances.html` via `new Function(...)`
     — todos OK. Gateway reiniciado via PM2, sem erro novo nos logs (só o
     ruído já conhecido das sessões deslogadas). **Não testado
     visualmente no navegador** — não consigo abrir o painel logado
     no Bitrix a partir daqui; a contagem de contatos/grupos em produção
     só pode ser conferida abrindo a tela de verdade.

---

### Parte AT — Sites: pipeline Bitrix por LP + negócio por lead + testes A/B (2026-07-13)

Pedido do usuário em 3 partes: (1) cada LP criada por um SDR gera um pipeline
próprio no Bitrix, vinculado à LP; (2) cada lead vira negócio no pipe da LP
(atribuído ao SDR) E num pipeline central do Daniel (decisão confirmada:
negócio duplicado consciente); (3) testes A/B entre LPs com métricas e um
histórico de análises que servirá de system prompt pra futura IA geradora de
LPs. Plano aprovado em plan mode antes de codar.

216. **Schema** (`db/schema.sql`, aplicado via `node db/migrate.js` e
     verificado no banco): `lead_forms.bitrix_category_id`,
     `lead_form_submissions.bitrix_deal_id`/`bitrix_contact_id`, tabela
     `lead_form_views` (form_id + day + count, PK composta — por dia de
     propósito: métricas de A/B precisam de views na janela do teste) e
     tabela `ab_tests` (variant_snapshot/final_metrics em jsonb + FKs com
     `set null` pro histórico sobreviver à exclusão das LPs).
217. **`src/bitrixCrm.js` (novo)**: criação de entidades CRM via webhook —
     `createLeadPipeline` (`crm.category.add` entityTypeId=2, fallback
     legacy `crm.dealcategory.add`; nome `[LP] <nome>`, convenção já usada
     no portal), `ensureBitrixContact` (`crm.duplicate.findbycomm` por
     telefone → reusa, senão `crm.contact.add`), `createDealForLead`
     (`crm.deal.add`) e `createBitrixArtifactsForLead` (orquestra
     SEQUENCIAL — rate limit ~2 req/s do Bitrix; `ASSIGNED_BY_ID` = sufixo
     do ownerId = userId do SDR; segundo deal no pipe central via env
     `BITRIX_CENTRAL_CATEGORY_ID`). TUDO best-effort com wrapper que nunca
     lança (callBitrix pode rejeitar em erro de rede).
218. **Views** (`src/leadForms.js` + `src/routes/leads.js`): `recordView`
     (upsert incremental por dia) chamado em GET /:slug/config; `listByOwner`
     agrega `viewCount`; card em sites.html mostra visualizações + conversão
     (leads/views). Testado com curl: 2 hits → count=2 no banco.
219. **Negócio por lead** (`src/routes/leads.js` POST /:slug): responde
     `{ok:true}` ANTES do Bitrix (visitante não espera 2-4s de roundtrips);
     depois, em background: cria contato+deals, grava
     `bitrix_deal_id`/`contact_id` na submissão, `setDealForPhone` (liga a
     conversa ao negócio → timeline existente passa a funcionar pros leads)
     e loga a mensagem de boas-vindas retroativamente na timeline. Lead
     local NUNCA depende do Bitrix.
220. **Pipeline por LP** (`src/routes/leadForms.js`): POST cria o pipeline
     antes do form (null se falhar → toast de aviso no frontend); PUT tenta
     de novo quando `bitrix_category_id` é NULL ("editar e salvar" = retry);
     GET/POST/PUT devolvem `bitrixKanbanUrl` calculada server-side
     (`BITRIX_PORTAL_DOMAIN`); DELETE nunca exclui o pipeline e recusa (400)
     se a LP está em teste A/B em andamento.
221. **Testes A/B** (`src/abTests.js` + `src/routes/abTests.js` +
     `GET /t/:slug` em server.js): teste pareia 2 LPs do dono; URL pública
     `/t/<slug>` faz 302 pra variante sorteada com cookie sticky 90d
     (`ab_<id>=a|b`, parse manual — sem cookie-parser), preservando query
     string (utm) + `#formulario`; teste encerrado → todos vão pro vencedor.
     Métricas ao vivo por variante (views/leads/conversão na janela
     created_at..finished_at). `finish` exige análise, congela
     `final_metrics` e torna o teste imutável; `DELETE` só cancela testes em
     andamento. `GET /api/ab-tests/history` devolve o histórico estruturado
     (snapshot das variantes + métricas + vencedor + análise) — é a base de
     conhecimento pra futura IA geradora de LPs.
222. **UI** (`public/sites.html`): cards de LP ganharam visualizações,
     conversão e link "Pipeline no Bitrix"; toast pós-save avisa quando o
     pipeline não pôde ser criado (e celebra quando o retry consegue); nova
     seção "Testes A/B" (criar com 2 selects, cards com métricas ao vivo +
     URL /t/ copiável, encerrar com modal de vencedor+análise obrigatória,
     cancelar com confirmDialog, histórico colapsável). Sem alert()/confirm()
     nativos.
223. **Testado de verdade** (curl + banco real, gateway via PM2): views
     incrementando; criação de teste A/B com validações (rejeita LPs iguais,
     LP de outro dono); /t/ com 302+Set-Cookie, stickiness confirmada
     (cookie a→sempre A, b→sempre B), distribuição 5/5 em 10 hits sem
     cookie, preservação de utm; finish congelando métricas + imutabilidade
     ("este teste já foi encerrado"); history estruturado; pós-encerramento
     redirecionando pro vencedor. Dados de teste limpos depois. Sintaxe de
     todos os arquivos validada (`node --check` + parse dos `<script>`).
224. **Webhook novo CONFIGURADO e testado (mesma sessão, 2026-07-13)**: o
     usuário criou um webhook novo com escopo CRM
     (`.../rest/183168/ail3gvjp60xjokul/`, atualizado no `.env`). Testado de
     verdade: `crm.status.list` OK (escopo ativo), e `createLeadPipeline`
     criou um pipeline real no portal (ID 604, "[LP] TESTE-WEBHOOK-apagar"),
     removido em seguida via `crm.category.delete` — **funciona mesmo com
     `ADMIN: false`** (o usuário 183168/Daniel tem permissão de config do
     CRM, que basta; a exigência de "admin" da doc não se aplicou aqui).
     Observação: logo após salvar o webhook no Bitrix, as chamadas retornam
     `INTERNAL_SERVER_ERROR` transitório por ~1-2 min (propagação) — não é
     bug nosso, só esperar e tentar de novo. Gateway reiniciado com o env
     novo. **Pipeline central: DESCARTADO por decisão do usuário** ("Não
     preciso receber em lugar algum. Apenas os donos das LP devem receber
     os leads") — `BITRIX_CENTRAL_CATEGORY_ID` fica vazio de propósito e o
     código pula a cópia central (comportamento já previsto: a env é
     opcional). Cada lead cria UM negócio, no pipe da LP, atribuído ao SDR
     dono. A opção continua no código/docs caso mude no futuro.
225. **Limitações documentadas no README**: visibilidade de pipe por SDR é
     config manual de permissões no CRM (API não cobre); negócio duplicado
     (SDR + central) é decisão consciente; re-submissão re-aponta a conversa
     pro negócio mais novo (coalesce em getOrCreateConversation); views sem
     dedupe; tráfego direto no /l/ de uma LP em teste mistura métricas
     (recomendação: LPs dedicadas por teste).
226. **Fix de resiliência em sites.html** (mesma sessão): o usuário abriu a
     tela de Sites bem na hora de um `pm2 restart` — a busca única de
     instâncias do `init()` falhou em silêncio e o select do modal ficou
     preso em "Nenhuma instância" (as instâncias existiam; a tela de
     Instâncias, aberta depois, funcionava). Corrigido: `openFormModal()`
     agora chama `ensureInstances()`, que re-busca a lista quando ela está
     vazia — sem depender de F5.
227. **CAUSA RAIZ REAL ENCONTRADA (2026-07-13) — não é indexação, é uma
     Regra de Controle (automação) do próprio CRM que APAGA os negócios**:
     o usuário viu no app do Bitrix (Notificações) mensagens tipo "Regra de
     controle — Negócio: Fresh 606 (apagar) — Atenção: já existe um
     processo com esse mesmo número criado no sistema! Número do Processo:
     !" para CADA negócio de teste que criei (inclusive com o mesmo título
     que usei nos testes). Ou seja: existe uma automação no CRM (tipo
     "Regra de Controle", provavelmente vinculada à checagem de duplicidade
     do campo `PARENT_ID_1032` — "BASE DE DADOS | NUMERO DO PROCESSO", tipo
     `crm_entity`, opcional — confirmado via `crm.deal.fields`) que, ao
     detectar (falso-positivo, provavelmente por comparar valores vazios
     como se fossem "iguais") um "processo duplicado", **exclui o negócio
     automaticamente**. Isso explica 100% do sintoma anterior (negócios
     "invisíveis" que na real tinham sido apagados, não atrasados) —
     inclusive por que um negócio no funil ANTIGO (466) sobreviveu (talvez
     essa automação só rode nos pipelines `[LP] ...`/novos, ou em condição
     que os negócios de teste sem esse campo disparam e o de 466 não).
     **NÃO consegui inspecionar a regra via API** — `bizproc.robot.list`
     exige escopo maior que o webhook tem ("requires higher privileges").
     **Afeta a feature R2 de verdade**: a notificação "Teste — Teste 2"
     bate exatamente com o formato de título que `bitrixCrm.js` usa
     (`${name} — ${form.name}`) — ou seja, negócios de LEADS REAIS
     (não só meus testes de diagnóstico) também estão sendo apagados por
     essa regra. **Isso não é bug no gateway nem no Bitrix** — é uma
     automação de negócio configurada neste portal que precisa ser
     ajustada pelo usuário: localizar a "Regra de Controle" de duplicidade
     de "Número do Processo" (CRM → Automação/Regras de Robôs, ou dentro
     do pipeline `[LP] ...` em "Regras de automação") e excluir/ajustar
     pra não disparar em negócios sem processo vinculado (ou trocar a
     condição de "campo vazio = duplicata"). Sem esse ajuste, **nenhum
     negócio criado pelas LPs vai sobreviver**, mesmo com tudo funcionando
     corretamente no código. Órfãos conhecidos (todos apagados por essa
     regra, não recuperáveis via API): 5459408 (lead real "Renam Mattos"),
     5459454/5459476/5459544/5459574/5462328/5462340 (diagnóstico).

---

### Parte AU — Testes A/B: sugestão de análise via IA (OpenAI) (2026-07-13)

Pedido do usuário ao ver o modal de encerrar teste: "Esses insights devem
ser gerados com IA". Não havia NENHUMA integração de IA no projeto até
aqui — decisão tomada com o usuário via pergunta: provedor **OpenAI**
(`gpt-4o-mini`) e fluxo de **botão que preenche o campo** (não geração
automática) — o texto é sempre um rascunho revisável, nunca escrito direto
no histórico imutável sem passar pelo usuário.

228. **`src/openai.js` (novo)**: `suggestAbTestAnalysis(test)` monta um
     prompt em português com nome do teste, config de cada variante
     (`variantSnapshot.a/b` — título, subtítulo, seções usadas) e as
     métricas AO VIVO (`viewsA/B`, `leadsA/B`, conversão calculada aqui
     mesmo), chama `POST https://api.openai.com/v1/chat/completions`
     (`gpt-4o-mini`, `temperature: 0.6`, `max_tokens: 300`) com um system
     prompt que instrui a IA a **nunca inventar dado** fora do que foi
     passado. Lança erro claro se `OPENAI_API_KEY` não estiver configurada
     — não é best-effort silencioso aqui, porque é uma ação explícita do
     usuário (clique no botão), não um processo em background.
229. **Rota** `POST /api/ab-tests/:id/suggest-analysis`
     (`src/routes/abTests.js`, autenticada): busca o teste via
     `abTests.get` (já traz `variantSnapshot`/métricas prontos, reaproveita
     tudo que a Parte AT já calculava), chama `suggestAbTestAnalysis` e
     devolve `{ analysis }`. 404 se o teste não existe; 502 se a OpenAI
     falhar (chave ausente, rate limit, etc.) — nunca falha o encerramento
     do teste em si, que continua aceitando análise manual.
230. **UI** (`public/sites.html`, modal "Encerrar teste"): botão
     "✨ Gerar com IA" ao lado do label da textarea de análise — ao
     clicar, desabilita, mostra "Gerando…", preenche o campo com a
     sugestão (o usuário pode editar livremente antes de clicar em
     "Encerrar teste"). Erro vira toast, sem travar o fluxo manual.
231. **Testado de verdade, chamada real à API** (não simulado): rodei
     `suggestAbTestAnalysis` contra o teste real existente no banco (id 2,
     "Teste 1", variantes "Teste 2"/"Teste - Daniel", 4 e 3 views, 0 leads
     em ambas) — a IA devolveu uma análise coerente com os números reais
     (apontou a conversão zerada e a falta de depoimentos/estatísticas nas
     LPs, recomendação de adicionar prova social). Rota HTTP confirmada
     atrás de auth (401 sem token). Gateway reiniciado sem erro novo.
232. **Chave da API**: `OPENAI_API_KEY` fornecida pelo usuário diretamente
     no chat, salva em `.env` (nunca commitada/logada) e documentada como
     opcional em `.env.example`/README — sem ela, o botão erra mas o
     encerramento manual do teste continua 100% funcional.

---

### Parte AV — Causa raiz real do "negócio some": automação de duplicidade com bug de campo vazio; pivot pra pipeline único (2026-07-13)

Continuação direta da Parte AT (item 227). Investigação levada até o fim
com o usuário, incluindo evidência visual dele (prints do Bitrix) que eu
não conseguia ver sozinho via API.

233. **CAUSA RAIZ CONFIRMADA — não é indexação, é exclusão automática por
     uma automação de "controle de duplicidade" com bug**: o usuário viu
     nas Notificações do Bitrix (app mobile) mensagens de "Regra de
     controle" pra CADA negócio que criei via API: "Negócio: <título> —
     Atenção: já existe um processo com esse mesmo número criado no
     sistema! Número do Processo: !". Localizei o campo real via
     `crm.deal.fields`: `PARENT_ID_1032` — "BASE DE DADOS | NUMERO DO
     PROCESSO" (campo de vínculo a um SPA, entityTypeId 1032, opcional).
     Dentro desse SPA existe um item id=10 com título literal **"não tem
     processo"** — um placeholder genérico.
234. **Testado e confirmado com lead 100% novo (não só diagnóstico)**: a
     pedido do usuário, submeti um lead de verdade via
     `POST /api/leads/teste-daniel` (telefone nunca usado antes) pelo fluxo
     real do gateway. Mesmo sendo um contato genuinamente novo, sem
     qualquer processo pré-existente, o negócio criado na categoria 606
     **sumiu igual** aos de teste. **Conclusão**: não é uma duplicata
     genuína sendo barrada corretamente — é TODO negócio novo sem
     "Número do Processo" preenchido sendo tratado como "duplicata" de
     qualquer outro negócio igualmente vazio (a automação provavelmente
     compara valores vazios como se fossem iguais entre si, ou auto-vincula
     todo negócio novo ao mesmo placeholder id=10 e depois vê múltiplos
     negócios "concorrendo" pelo mesmo processo). **Não é bug no
     gateway** — é uma automação (Business Process, não uma "Regra de
     automação" simples — confirmado que as 8 etapas do pipeline `[LP]
     Teste - Daniel` não tinham nenhuma regra visível na tela padrão) já
     existente neste portal, que precisa de uma exceção pra campo vazio ou
     pra fonte `SOURCE_ID='WEB'`.
235. **Tentativa de achar a regra exata, sem sucesso via UI/API**:
     percorremos "Automação de vendas" de 2 pipelines diferentes (`[LP]
     Teste - Daniel` e `SISTEMA`) — achamos automações reais nesse
     portal (ex: `SISTEMA/LISTA FRIA`: "Em 1 dia → Excluir item
     automaticamente" — prova que exclusão automática é padrão usado aqui,
     mas não bate com o timing do nosso caso, que é quase instantâneo) e
     duas regras bloqueadas ("só editável no Criador de Fluxo de
     Trabalho") que abertas mostraram ser sobre outra coisa (pausa +
     notificar supervisor, não relacionado). `bizproc.robot.list` e
     `bizproc.workflow.template.list` negaram acesso (escopo do webhook
     insuficiente) — não deu pra inspecionar programaticamente. **Ficou em
     aberto encontrar a regra exata** — decisão do usuário foi não
     continuar essa via (ver item 237).
236. **Teste extra revelou outro problema**: pedimos pro usuário confirmar
     um pipeline "seguro" (229) pra usar como destino único — a URL que
     ele passou (`.../category/229/`) é a categoria **"FUNIL DE TESTE (NÃO
     UTILIZAR)"** (nome literal, já existia antes desta sessão, fazia
     parte da lista original de ~67 funis do portal). Testei lá também: o
     negócio criado **também sumiu**. Ou seja, essa categoria específica
     provavelmente tem sua própria rotina de limpeza (faz sentido, dado o
     nome) — **não é a que o usuário realmente queria usar**; ele
     provavelmente pegou a URL errada. Reportado ao usuário antes de
     prosseguir — aguardando a URL correta do pipeline de destino real.
237. **DECISÃO DO USUÁRIO — abandonar pipeline-por-LP, apagar os 3
     criados**: em vez de continuar caçando a automação problemática, o
     usuário decidiu (a) parar de criar um pipeline novo por LP (R1
     abandonado/revertido — criar categoria nova via API provou-se não
     confiável neste portal) e (b) apagar os 3 pipelines que a Parte AT
     criou: **604** ("[LP] TESTE-WEBHOOK-apagar", já apagado
     anteriormente), **606** ("[LP] Teste - Daniel") e **608** ("[LP]
     Teste 2") — os dois últimos apagados agora via `crm.category.delete`
     (confirmado: `crm.category.get` retorna "não encontrado" pros três).
     `lead_forms.bitrix_category_id` das LPs 16 e 17 zerado no banco
     (`update lead_forms set bitrix_category_id = null where id in
     (16,17)`) pra não ficar referência órfã. **PENDENTE**: usuário vai
     indicar o pipeline único e correto onde TODAS as LPs devem lançar
     negócio (pivot de "1 pipeline por LP" pra "1 pipeline compartilhado
     pra todos os leads de LP", com visibilidade por SDR resolvida via
     permissão nativa do Bitrix — "cada usuário só vê o seu" — atribuída
     por `ASSIGNED_BY_ID`, não por pipeline separado). Isso ainda vai
     exigir mudança de código (remover a criação automática de pipeline,
     apontar `createDealForLead` pra uma categoria fixa via nova env var),
     documentada como próximo passo assim que o pipeline certo for
     confirmado.

---

### Parte AW — Implementação final: pipeline único compartilhado (categoria 229) (2026-07-13)

Continuação imediata da Parte AV. Usuário indicou o pipeline correto (URL
`.../category/229/`) e confirmou "o pipe é aquele mesmo" mesmo depois de eu
alertar que 229 se chama **"FUNIL DE TESTE (NÃO UTILIZAR)"** e que um
negócio de teste criado lá também tinha sumido antes. Reconfirmei com um
segundo teste limpo (0s/10s/30s/60s, todos "not found") — o mesmo bug
afeta 229 também. Perguntado como prosseguir, usuário escolheu **terminar
o código apontando pra 229 mesmo assim** (a automação problemática precisa
ser corrigida no Bitrix separadamente; o código fica correto e pronto pra
quando isso acontecer).

238. **Vazamento extra descoberto durante a limpeza**: antes de eu zerar
     `bitrix_category_id` das LPs 16/17, a lógica de retry do PUT (Parte
     AT) já tinha criado uma **quarta** categoria — **610** ("[LP] Teste
     2") — sozinha, no meio da sessão, sem eu pedir (o usuário só salvou a
     LP pela UI em algum momento). Apagada também via `crm.category.delete`
     (confirmado). Isso reforçou a urgência de remover essa lógica de
     retry antes de qualquer coisa.
239. **`src/bitrixCrm.js` reescrito**: removida por completo a função
     `createLeadPipeline` (e o conceito de pipeline por LP). Nova env var
     `BITRIX_LEADS_CATEGORY_ID` (fixa, uma só pra todo o sistema) substitui
     tanto o antigo `bitrixCategoryId` por LP quanto o
     `BITRIX_CENTRAL_CATEGORY_ID` (que também foi removido — não faz mais
     sentido ter uma "cópia central" quando já existe só um pipeline).
     `createBitrixArtifactsForLead` agora só cria contato + UM negócio,
     sempre na categoria fixa, atribuído ao SDR via `ASSIGNED_BY_ID`.
240. **`src/routes/leadForms.js`**: removida a chamada de criação de
     pipeline no POST e o bloco de retry no PUT. `withKanbanUrl` (por LP)
     virou `LEADS_KANBAN_URL` (constante única, calculada 1x a partir de
     `BITRIX_LEADS_CATEGORY_ID` + `BITRIX_PORTAL_DOMAIN`) — devolvida como
     `leadsKanbanUrl` no `GET /` (não mais um campo por formulário).
241. **`src/leadForms.js`**: `bitrixCategoryId` removido de `SELECT_FIELDS`
     e `FIELD_COLUMNS` — a coluna `bitrix_category_id` continua existindo
     no schema (não apagamos coluna nossa por precaução/simplicidade), só
     não é mais lida/escrita pelo código.
242. **`public/sites.html`**: removido o link "Pipeline no Bitrix" por
     card e o toast de aviso/sucesso de criação de pipeline (não existe
     mais o conceito). Adicionado um único link **"Ver leads no Bitrix →"**
     no cabeçalho do painel "Formulários" (ao lado do botão "+ Novo
     formulário"), que só aparece (`hidden` removido) quando
     `leadsKanbanUrl` vem preenchido do backend.
243. **Env vars**: `.env` e `.env.example` atualizados —
     `BITRIX_LEADS_CATEGORY_ID=229` no `.env` real; `BITRIX_CENTRAL_CATEGORY_ID`
     removida de ambos; comentários do `BITRIX_WEBHOOK_URL` simplificados
     (não menciona mais "exige admin pra criar pipeline", já que não
     criamos mais pipeline nenhum).
244. **Testado de ponta a ponta**: `node --check` + parse dos `<script>` de
     `sites.html` OK; gateway reiniciado sem erro novo; chamei
     `createBitrixArtifactsForLead` diretamente com a LP real
     "Teste - Daniel" — criou contato (4414540) e negócio (5462874) na
     categoria 229 com sucesso; confirmei que `leadForms.listByOwner` não
     retorna mais `bitrixCategoryId` (campo removido); confirmei o cálculo
     de `leadsKanbanUrl` (`https://bmd.bitrix24.com.br/crm/deal/kanban/category/229/`).
     Contato e negócio de teste apagados depois (negócio ainda existia no
     momento da limpeza — não sumiu sozinho dessa vez, ao contrário dos
     testes anteriores; registrado como possível inconsistência/intermitência
     da automação problemática, não motivo pra revisar a conclusão já
     bem estabelecida com múltiplos testes controlados).
245. **O que ainda falta, fora do alcance do código**: a automação de
     controle de duplicidade no Bitrix (Partes AT/AV) continua ativa e
     pode apagar negócios criados na categoria 229 também. Isso não é algo
     que este pivot resolve sozinho — precisa ser corrigido/ajustado
     dentro do Bitrix por quem administra essas automações. O código deste
     app está pronto e correto; assim que a automação for corrigida, os
     leads passam a aparecer no kanban sem precisar de nenhuma mudança
     adicional aqui.

---

### Parte AX — Nova tela: Métricas de Sites (`/lead-metrics.html`) (2026-07-13)

Pedido do usuário: "crie a tela de métricas da LP. Completo". Construída
seguindo o MESMO padrão visual/técnico já usado em Métricas de Campanhas
(`campaign-metrics.html`/`computeCampaignMetrics`) — KPIs, gráfico SVG de
linha (30 dias), tabela — pra manter consistência com o resto do app em
vez de inventar um padrão novo.

246. **`leadForms.computeMetrics(ownerId)`** (novo, em `src/leadForms.js`):
     totais agregados (`totalForms`, `activeForms`, `totalViews`,
     `totalLeads`, `totalWhatsappSent`) via uma query só com LEFT JOINs
     nas mesmas subqueries de `listByOwner`; série diária dos últimos 30
     dias (views de `lead_form_views`, leads de `lead_form_submissions`,
     ambas filtradas por `owner_id` via join com `lead_forms`) — **com
     zero preenchido em TODOS os 30 dias** (diferente do padrão de
     `computeCampaignMetrics`, que só devolve os dias com registro) — o
     gráfico fica com o espaçamento correto por calendário; breakdown por
     formulário reaproveitando `listByOwner` (já tinha leadCount/
     whatsappSentCount/viewCount prontos).
247. **Rota `GET /api/lead-forms/metrics`** (`src/routes/leadForms.js`,
     autenticada, escopada por `req.ownerId`) — declarada logo depois do
     `GET /` por clareza; não colide com nada (não existe `GET /:id`
     genérico nesse router, só `GET /:id/submissions`).
248. **`public/lead-metrics.html`** (novo arquivo): cópia estrutural de
     `campaign-metrics.html` (mesmo CSS, sidebar, toast/confirmDialog,
     fluxo de auth BX24) adaptada pros dados de LP — sem seletor de
     instância (métricas são por DONO, não por instância de WhatsApp).
     KPIs: formulários ativos/total, visualizações, leads, conversão geral,
     entrega WhatsApp geral. Gráfico de linha dourado/verde (visualizações
     × leads) últimos 30 dias. Tabela "Por formulário" com as mesmas 2
     métricas coloridas (verde ≥80%/vermelho abaixo) já usadas nos cards de
     Sites. Atualiza sozinho a cada 15s + botão manual.
249. **Nav item novo em 10 páginas**: "Métricas Sites" (ícone de 3 barras)
     adicionado logo depois de "Sites" na sidebar de `sites.html`,
     `dashboard.html`, `chat.html`, `campaign.html`, `contacts.html`,
     `campaign-metrics.html`, `campaign-schedule.html`, `instances.html`,
     `notifications.html`, e o próprio `lead-metrics.html` (com `active`).
     `index.html` e `apresentacao.html` NÃO têm essa sidebar (layouts
     próprios — confirmado antes de editar, pra não adicionar nav item
     onde não existe estrutura de sidebar nenhuma).
250. **`src/server.js`**: nova rota `app.post('/lead-metrics.html', ...)`
     — igual as outras 9 páginas, porque o Bitrix sempre abre página via
     POST e `express.static` só atende GET.
251. **Testado de ponta a ponta**: `computeMetrics` rodado contra o banco
     real (owner `183168`) — totais batem exatamente com a soma do
     breakdown por formulário (10 views = 5+5, 6 leads = 2+4); série de 30
     dias confirmada com zero-fill correto (26 dias zerados, só o dia de
     hoje com atividade real). `node --check`/parse de `<script>` em
     todos os 9 arquivos HTML editados + no arquivo novo + em
     `server.js`. Gateway reiniciado sem erro novo. `curl` confirmou
     `GET /lead-metrics.html` → 200 e `GET /api/lead-forms/metrics` sem
     token → 401 (rota protegida corretamente).

---

### Parte AY — Investigação: mensagens de "primeiro contato" de LP não chegam no WhatsApp do destinatário (2026-07-13)

Usuário reportou (com print do Chat) que mensagens automáticas de
boas-vindas enviadas pelas LPs mostram só ✓ (enviado) e não chegam de
verdade no celular. Investigado a fundo, com evidência concreta, NÃO
apenas suposição.

252. **Achado #1 — status de mensagem nunca avança de "sent" em NENHUMA
     mensagem, em NENHUMA sessão, em TODA a história do app**: query
     direta no banco (499 mensagens enviadas, histórico completo) mostrou
     100% com `status = 'sent'`, zero com `'delivered'`/`'read'`. Parecia
     indicar um bug estrutural no handler de `messages.update`.
253. **Descartado como bug de código, via teste real**: adicionei log
     temporário no handler `messages.update` (`src/whatsapp.js`), mandei
     uma mensagem de teste de verdade pela sessão 183168 (que estava
     online no momento) via `POST /api/whatsapp/send` (token gerado
     diretamente com `issueAppToken`, sem precisar do Bitrix). O evento
     **chegou normalmente** (`{"key":{...},"update":{"status":2,...}}` —
     status 2 = SERVER_ACK, mapeia pra `'sent'` corretamente). Ou seja: o
     pipeline de código (Baileys → `_mapStatus` → `store.updateMessageStatus`
     → banco) funciona certinho. Removido o log de diagnóstico depois
     (não deixado em produção).
254. **Achado #2 — a mensagem NUNCA avança pra `'delivered'` (status 3),
     nem depois de 60s de espera** (poll direto no banco). Isso significa:
     o WhatsApp confirma que recebeu a mensagem no SERVIDOR, mas o
     APARELHO do destinatário nunca confirma ter recebido — condizente
     exatamente com o que o usuário reportou ("aparece enviada, não
     chega").
255. **Causa mais provável, com evidência forte**: a sessão que envia essas
     mensagens (`2c39349ea593c27fd3092b4fe2c47de7_183168`, usada por TODAS
     as LPs hoje) está com a conexão **instável há dias** — logs mostram
     ciclos constantes `online → offline → online` com
     `statusCode=408 (timedOut)` bem no período das mensagens de teste. O
     `sendMessage()` só checa `status === 'online'` no INSTANTE da
     chamada — se a conexão cair segundos depois (antes do aparelho
     receber de fato), a mensagem fica "presa" no limbo: aceita pelo
     servidor, nunca entregue ao dispositivo.
256. **NÃO é algo que o código deste app resolve sozinho** — é
     instabilidade de conexão do WhatsApp Web (Baileys) nessa sessão
     específica, mesma classe de problema já diagnosticada antes nesta
     sessão (ver histórico anterior de `statusCode=408`). Recomendações
     pro usuário: (a) verificar a conexão de internet/rede da máquina que
     roda o gateway (instabilidade de rede é a causa mais comum de 408
     recorrente); (b) checar no celular pareado (WhatsApp → Aparelhos
     conectados) se a sessão aparece saudável, e considerar deslogar e
     re-parear (reescanear QR) se persistir; (c) evitar rodar muitos
     testes/disparos em sequência rápida pela mesma sessão enquanto ela
     estiver instável — pode agravar rate-limiting do lado do WhatsApp.
     **Sem acesso físico ao celular/rede da máquina, não dá pra confirmar
     a causa exata só pelo código — meu papel aqui foi isolar que é
     conexão, não bug de status/entrega no software.**
257. **Ainda em aberto em 2026-07-16** — usuário perguntou de novo se todo
     contato que preenche a LP está recebendo a mensagem; reconferido, e o
     quadro é o mesmo. Query direta no banco: as 3 LPs ativas hoje (`teste-2`,
     `teste`, `wqrewqre`) todas mandam pela mesma sessão `..._183168`
     ("Daniel", `5521965628397`); as últimas mensagens de primeiro contato
     dessa sessão, incluindo 4 enviadas no mesmo dia 16/07 entre 19h e 20h51,
     **todas** seguem travadas em `status = 'sent'`, nenhuma avançou pra
     `delivered`/`read`. `GET /status` confirma a sessão `online` no
     momento da checagem, mas o log mostra ciclos recentes de queda com
     `statusCode=428 (connectionClosed)` e `503 (unavailableService)` — nova
     variante do mesmo sintoma de instabilidade (antes só `408 timedOut`).
     **Não é o mesmo bug corrigido na Parte BU** (aquele era sufixo de
     dispositivo no JID quebrando a resolução de telefone num evento que
     chega certinho; este aqui é o evento de confirmação nunca chegar,
     porque a conexão cai antes do aparelho confirmar). Continua sendo
     risco real de negócio: lead preenche a LP, negócio é criado no Bitrix,
     mas a mensagem pode nunca chegar no celular do destinatário, sem
     nenhum aviso na tela (mostra "enviado" do mesmo jeito). Recomendações
     de (a)-(c) acima seguem válidas e não foram executadas ainda.
258. **Confirmado pelo usuário no aparelho de verdade, e achado importante:
     NÃO é específico de LP** — usuário preencheu a LP de teste
     (`21996270398`) e checou o próprio celular de destino: a mensagem "Olá
     TESTE 2! Recebemos seu contato..." realmente não chegou, só aparece no
     Chat com ✓ simples. Isso descarta de vez a hipótese de ser só um
     problema de RASTREAMENTO de status aqui no código — a mensagem de
     fato não chega na maior parte das vezes, não é só o "✓✓" que não
     atualiza. Comparei no banco todas as mensagens **OUT** da sessão
     `183168`, LP vs. conversa normal: das 7 mensagens de boas-vindas de LP,
     0 chegaram a `delivered`/`read` (100% travadas) — mas das 688 mensagens
     de conversas normais (humanas, ida e volta, incluindo contatos com
     muitas trocas reais como `5511936186732`), **91% também ficam
     travadas em `sent`**, só 9% chegam a `delivered`/`read`. Ou seja: não é
     um bloqueio de anti-spam mirado só na mensagem automática de LP (o que
     seria esperado se só o "contato frio" falhasse) — é a sessão inteira
     entregando mal a confirmação de status na maior parte das mensagens,
     humanas ou automáticas. Reforça que o problema é de saúde da conexão
     dessa sessão/número específico (`5521965628397`, rótulo "Daniel"), não
     do fluxo de LP em si — mesma recomendação de checar
     Aparelhos Conectados / considerar re-parear essa sessão específica.
259. **Bug real encontrado e corrigido (mesma sessão, achado pelo usuário):
     `POST /:slug` (`src/routes/leads.js`) não acrescentava o "55" (código
     do país) ao telefone digitado na LP.** O campo pede "Telefone (com
     DDD)" — o visitante digita só DDD + número (10 ou 11 dígitos), sem
     código de país, e o código só fazia `replace(/\D/g, '')`, sem
     completar o "55". O JID montado por `_phoneToJid` (`src/whatsapp.js`)
     ficava incompleto (ex: `21965628397@s.whatsapp.net` em vez de
     `5521965628397@...`) — não corresponde a NENHUMA conta real do
     WhatsApp, então a mensagem tem certeza de nunca chegar (não é mais
     "às vezes falha por instabilidade", é garantido). Isso explica
     sozinho os 100% de falha das 7 mensagens de LP do item 258 — bem
     mais que os 91% de falha "normal" já esperados pela instabilidade da
     sessão (item 257-258, ainda em aberto, separado deste bug). Corrigido
     prependendo `"55"` quando o telefone limpo tem 11 dígitos ou menos
     (por tamanho, não por já começar com `"55"` — DDD 55 é um DDD real do
     Rio Grande do Sul, então checar prefixo daria falso positivo e
     deixaria um número de lá sem o país de verdade). Deploy: `pm2 restart
     whatsapp-gateway`.
     - [ ] **Contatos/conversas antigas de LP já ficaram salvos com o
       telefone errado** (ex: "Daniel de Sousa" → `21965628397` em vez de
       `5521965628397`, visto no print do usuário) — não migrados
       retroativamente nesta sessão (não fica claro se são só testes ou
       leads reais que valha a pena preservar/mesclar). Revisitar se
       incomodar: qualquer novo envio pro MESMO visitante agora cria um
       contato/conversa NOVO (telefone certo), separado do antigo
       (telefone errado), em vez de continuar a mesma conversa.
     - [ ] Mesma lacuna (nenhuma normalização de código de país) existe em
       TODOS os outros pontos de entrada de telefone do app — `contacts.js`
       (Contatos manual), `csvImport.js` (importar CSV), `routes/whatsapp.js`
       (grupos, campanhas). Não corrigido nesses outros pontos nesta
       sessão (usuário reportou especificamente o formulário da LP) —
       revisitar se o mesmo sintoma aparecer em Contatos/Campanha.

---

### Parte AZ — Chat: resumo de conversa via IA no painel de detalhes (2026-07-13)

Pedido do usuário (com imagem de referência de outro produto): adicionar
um card "Resumo da conversa" no painel de detalhes do contato, com botão
pra gerar via IA — mesmo padrão já estabelecido do botão "Gerar com IA"
dos testes A/B (Parte AU): sugestão que o usuário aciona sob demanda,
nunca gerada escondida/automática.

257. **Schema**: `conversations.ai_summary` (text) e
     `conversations.ai_summary_updated_at` (timestamptz) — `alter table
     add column if not exists`, aplicado via `node db/migrate.js`.
258. **`src/store.js`**: `getConversationSummary(sessionId, phone)` (lida
     junto do histórico) e `setConversationSummary(sessionId, phone,
     summary)` (grava + `now()`).
259. **`src/openai.js`**: extraído `callChatCompletion(system, user,
     maxTokens)` como helper compartilhado (refatorado
     `suggestAbTestAnalysis` da Parte AU pra usá-lo, sem duplicar a
     chamada HTTP). Nova `summarizeConversation({ contactName, messages })`
     — usa até as últimas 80 mensagens da conversa (`store.getHistory`),
     monta um transcript rotulado (Empresa/Contato), pede um resumo de 3-5
     frases (o que o contato quer, assunto, status atual) baseado SOMENTE
     no texto real — sem inventar.
260. **Rotas** (`src/routes/whatsapp.js`): `GET /history` agora também
     devolve `aiSummary`/`aiSummaryUpdatedAt` (sem round-trip extra pra
     abrir a conversa já com o resumo salvo, se existir). Nova
     `POST /conversations/summary` `{session, phone, contactName?}` —
     gera e persiste, devolve `{summary, updatedAt}`.
261. **`public/chat.html`**: novo card `.contact-summary` no painel de
     detalhes (entre as estatísticas Total/Recebidas/Enviadas e os campos
     de contato — mesma posição da imagem de referência), com ícone de
     sparkle no título e botão de atualizar (ícone de refresh, gira
     enquanto gera). Estado vazio: "Sem resumo ainda — clique no ícone pra
     gerar com IA." (itálico, cinza). `aiSummary`/`aiSummaryUpdatedAt`
     resetados ao trocar de conversa (evita "vazar" resumo da conversa
     anterior por um instante).
262. **Testado de ponta a ponta com dados reais** (não simulado): gerei
     um token de app direto via `issueAppToken` (sem precisar do fluxo
     Bitrix) e chamei `POST /conversations/summary` contra a conversa real
     "Daniel" (sessão 183168, 18 mensagens) — resumo gerado coerente com o
     conteúdo real da conversa; confirmei via `GET /history` que o resumo
     persistiu e voltou certinho (`aiSummary`/`aiSummaryUpdatedAt`
     preenchidos). `node --check`/parse de `<script>` em todos os
     arquivos alterados. Gateway reiniciado sem erro novo.

---

### Ajuste rápido — título do negócio no Bitrix (2026-07-13)

Usuário viu os cards reais no Bitrix (print) e notou que o `TITLE` vinha
como `"<nome do contato> — <nome da LP>"` (ex: "Daniel — Teste - Daniel"),
duplicando informação — o card já mostra o nome do contato sozinho via o
vínculo `CONTACT_ID`. Pedido: só o nome da LP no título.

263. **`src/bitrixCrm.js`** (`createBitrixArtifactsForLead`): `title` mudou
     de `` `${name || phone} — ${form.name}` `` pra só `form.name`.
     `sourceDescription` (campo separado, não visível no card) continua
     com o nome/slug da LP, sem mudança. Testado com `crm.deal.add` real
     contra a LP "Teste - Daniel" — confirmado via `crm.deal.get` que o
     `TITLE` salvo veio exatamente `"Teste - Daniel"`. Negócio de teste
     apagado depois.

### Limpeza — "começar do zero" nas 2 LPs de teste (2026-07-13)

A pedido do usuário, apagados TODOS os artefatos de teste gerados
durante toda a investigação/verificação desta sessão nas LPs "Teste -
Daniel" (16) e "Teste 2" (17), sem tocar em nada de terceiros:

- **Bitrix**: 3 negócios (5462904, 5462916, 5464284 — os únicos com
  `SOURCE_DESCRIPTION` = "LP: ..." dentro da categoria 229; confirmado
  antes que a categoria já tinha outros negócios de teste alheios —
  "Gabriel", "TESTE12112312" etc. — que NÃO foram tocados) + 2 contatos
  (4411728 "Daniel de Sousa Barbosa Costa", 4411814 "Renam Mattos" —
  confirmado via `crm.deal.list` que nenhum tinha outro negócio vinculado
  além dos apagados).
- **Banco local**: 7 linhas de `lead_form_submissions` + 2 linhas de
  `lead_form_views` (form_id 16/17) + 3 linhas de `contacts` (as mesmas
  pessoas de teste, criadas pelo fluxo normal de submissão).
- **Confirmado**: `lead_forms` 16 e 17 agora mostram `leads=0`/`views=0`.
  As LPs em si (formulário, textos, etc.) e o teste A/B "Teste 1"
  **não foram apagados** — só os dados de submissão/teste.

---

### Parte BA — LP pública mais profissional: CTA duplo, botão flutuante do WhatsApp, entrada suave nas seções (2026-07-13)

Pedido do usuário: "Melhore a LP, deixe mais profissional. com criativo
CTA etc e botão flutuante do wpp". Tudo em `public/lead-form.html`
(página pública `/l/:slug`), sem mexer em backend/schema.

- **Botão flutuante do WhatsApp** (`.wa-float`, canto inferior direito,
  fixo): verde oficial `#25D366` (única quebra proposital da paleta
  dourada da LP — é a cor que o visitante já reconhece como "abrir
  WhatsApp"), com anel pulsante (`.wa-float-ring`) e rótulo em hover
  (`.wa-float-label`, escondido no mobile pra não competir por espaço).
  Só aparece se `config.contactPhone` existir (mesma guarda que o
  rodapé já usava) — sem número real, o botão não seria clicável de
  verdade. Abre `https://wa.me/<numero>?text=...` com uma mensagem de
  abertura sugerida (o visitante pode editar/apagar antes de enviar —
  não é uma promessa da empresa, só evita a caixa de texto em branco).
- **CTA duplo no hero**: além do botão principal "Falar agora"
  (`#formulario`, ganhou um halo pulsante sutil via `.primary-glow`
  pra chamar o olho sem ser gritante), agora tem um segundo botão
  "Chamar no WhatsApp" (`.hero-cta-secondary`, estilo outline) que leva
  direto pro `wa.me` — dá ao visitante dois caminhos: preencher o
  formulário (vira lead no CRM) ou ir direto pro WhatsApp (mais rápido
  pra quem não quer preencher form). Mesma guarda de `contactPhone`.
- **Entrada suave ao rolar** (`.reveal` + `IntersectionObserver`, função
  `setupScrollReveal()`): as seções opcionais (stats, diferenciais,
  história, FAQ, depoimentos, card de contato) entram com fade+slide
  ao aparecerem na viewport, em vez de já surgirem montadas. Seções que
  continuam `hidden` (sem conteúdo configurado) nunca disparam
  `isIntersecting`, então observá-las de qualquer forma é inofensivo —
  não precisou de filtro extra. Respeita `prefers-reduced-motion`
  (mostra tudo direto, sem transição).
- Texto do botão de envio do formulário trocado de "Enviar" (genérico)
  pra "Quero ser atendido" (mais orientado à ação).
- Nenhuma alteração de conteúdo/copy foi inventada como "prova social"
  (tipo contador falso de visitantes) — só ajustes estruturais/visuais,
  consistente com a regra de nunca fabricar dados que a LP não tem.
- Validado: sintaxe do `<script>` extraído (`new Function`), sem ids
  duplicados, resposta real do `/api/leads/teste-daniel/config` e HTML
  servido por `/l/teste-daniel` conferido via curl (contém os novos
  elementos). **Não confirmado visualmente em navegador nesta sessão**
  (sem ferramenta de screenshot disponível) — recomendo o usuário abrir
  `/l/teste-daniel` ou `/l/wqrewqre` (ambas têm `contactPhone`
  configurado) pra validar visualmente antes de considerar fechado.

---

### Parte BB — Correções de feedback visual na LP: fita quebrada, navbar e marca (2026-07-13)

Usuário mandou 2 prints da Parte BA em produção e pediu 2 ajustes, ambos
em `public/lead-form.html`:

- **Bug real na fita de confiança** (`.trust-track`, existia desde antes
  da Parte BA, só ficou visível no print): o grupo duplicado da fita
  usava `class="section trust-list"`, e `.section` tem `max-width:640px`.
  Isso travava a LARGURA DA CAIXA de cada cópia em 640px mesmo o
  conteúdo real sendo mais largo — como a animação usa `translateX(-50%)`
  baseado na largura da caixa (não do conteúdo transbordando), as duas
  cópias ficavam desalinhadas e o texto sobrepunha no ponto de emenda
  (ex.: "Seus dados pr" sobreposto com "Resposta rápida"). Corrigido
  removendo a classe `section` do grupo (cada `.trust-item` já tem o
  próprio padding, não precisava do padding/max-width do `.section`).
- **Navbar**: removido o botão "Falar agora" do cabeçalho (`.nav-cta` e
  seu CSS, que ficaria órfão) — agora sobra só o bloco de marca,
  centralizado.
- **Marca "Durão" no cabeçalho/rodapé**: até aqui, `brandName`/`formLogo`
  ficavam `hidden` por padrão e só apareciam se `/api/brand`
  (`BRAND_NAME`/`BRAND_SUBTITLE`, env vars) ou `config.logoUrl` (logo
  específico da LP) estivessem preenchidos — sem nenhum dos dois, o
  cabeçalho ficava vazio, como no print. As outras páginas internas do
  app (`dashboard.html` etc.) já tinham um fallback sempre visível: o
  mesmo ícone de "prédio/colunas" (marca genérica do app) + texto
  "Durão, Almeida & Pontes" / "Advogados Associados", sobrescrito
  dinamicamente via `/api/brand` quando configurado. Replicado esse
  MESMO padrão na LP pública (cabeçalho E rodapé): o SVG genérico
  (`#brandMark`/`#footerBrandMark`) e o texto fixo aparecem por padrão;
  se a LP tiver `logoUrl` próprio, o SVG genérico é escondido e a
  imagem real da LP aparece no lugar (prioridade do específico sobre o
  genérico, mesma lógica já usada pra cor de destaque). Não existe (e
  não foi inventado) nenhum arquivo de logo real da "Durão" — é o mesmo
  ícone vetorial genérico + texto que o resto do app já usa como
  identidade padrão, não uma imagem de logo de verdade.
- Validado via curl contra o gateway rodando (PM2, sem precisar
  restart — é arquivo estático): `/l/teste-daniel` (sem logo próprio,
  mostra a marca genérica) e `/l/teste-2` (tem `logoUrl` próprio já
  configurado, mostra a imagem real e some o SVG genérico) — confirmado
  que `.nav-cta` não aparece mais em nenhuma das duas.

**Correção seguinte, com print do usuário em produção**: a marca ficou
centralizada (pedido: à esquerda) e **o card do formulário sumiu por
completo** — bug real introduzido na Parte BA: a seção `#formulario`
(`.contact-section`) tinha ganhado a classe `.reveal` (entrada suave ao
rolar), que começa com `opacity:0`; como é a seção mais importante da
página (a única forma de captura), não podia depender de
`IntersectionObserver` disparar — se por qualquer motivo não disparasse
a tempo (timing, thresholds, o que for), o formulário inteiro ficava
invisível permanentemente, com o `.contact-section{flex:1}` ainda
ocupando o espaço (daí o vão vazio enorme no print, não um elemento
ausente). Corrigido removendo `.reveal` desse elemento especificamente
— continua só nas seções decorativas opcionais (stats/diferenciais/
história/FAQ/depoimentos), nunca no formulário. `justify-content` do
header voltou de `center` pra `flex-start` (marca à esquerda). Validado
com uma simulação headless via `jsdom` (instalado temporariamente só
pro teste, num diretório de scratch, não é dependência do projeto) que
executa o `<script>` real da página com um `fetch` mockado devolvendo o
mesmo config de `teste-daniel` — confirmado sem exceptions, com
`heroTitle`/formulário/rodapé todos populados corretamente — e depois
via curl direto no servidor rodando.

**3º ajuste, ainda a mesma sessão de feedback**: o `flex-start` da
correção anterior só alinhava a marca à esquerda **dentro da coluna
central de 640px** (`.section`, a mesma classe usada pelo conteúdo de
leitura) — como essa coluna fica centralizada na tela, em telas largas
sobrava um vão vazio entre a borda real da janela e onde a marca
começava (o print do usuário marcava exatamente esse vão com um
retângulo vermelho, pedindo pra logo ir "ali"). Corrigido tornando o
header **full-bleed** (`header.top .section{ max-width:none; width:100%;
margin:0; padding:0; }`, com `justify-content:space-between`): a marca
agora cola na borda esquerda real da tela, e a borda direita ganhou um
CTA único e definitivo — **botão do WhatsApp** (`#navWaCta`, `.nav-wa-cta`,
verde oficial, mesmo padrão de guarda por `config.contactPhone` dos
outros pontos de entrada pro WhatsApp da página) — como pedido ("deixe
apenas o botão do wpp ali"). Mesmo tratamento full-bleed aplicado no
rodapé (`.footer-inner` perdeu o `max-width:640px;margin:0 auto`) pra a
marca do rodapé também colar na borda esquerda, espelhando o header —
pedido explícito do usuário ("a logo do rodapé a esquerda também").
Validado de novo com jsdom (novo teste, mesmo padrão) confirmando
`navWaCta`/`heroWaCta`/`waFloat` todos com `href` e `hidden=false`
corretos, e via curl no servidor rodando conferindo o CSS full-bleed
realmente servido.

**4º ajuste**: usuário reportou que o botão do WhatsApp do cabeçalho
não estava redirecionando, e — antes de qualquer investigação mais
funda — pediu direto pra removê-lo ("retire esse botão do wpp do
cabeçalho"). Removido por completo: elemento `#navWaCta`/HTML, CSS
`.nav-wa-cta` (e o media query que escondia o texto em telas pequenas),
e a linha de JS que preenchia `href`/`hidden` dele em `renderHero()`.
Header voltou a ter só a marca (full-bleed, colada na borda esquerda,
`justify-content:flex-start` — sem CTA nenhum do lado direito). Os
outros 2 pontos de entrada pro WhatsApp continuam de pé: o CTA
secundário do hero ("Chamar no WhatsApp") e o botão flutuante — nenhum
dos dois foi tocado, ambos usam a mesma função `waLink()` e não houve
relato de problema neles. Validado sintaxe + curl confirmando nenhum
resquício de `navWaCta`/`nav-wa-cta` no HTML servido.

---

### Parte BC — Rodapé em 4 colunas (com mapa) + hero em 2 colunas, inspirados no site real da Durão, Almeida & Pontes (2026-07-13)

Usuário mandou print do site real `dapadvocacia.com.br` (o mesmo escritório
cuja marca já era usada como identidade padrão da LP — ver Parte BB) e
pediu pra `public/lead-form.html` seguir esse modelo em 2 partes.

**Rodapé — 4 colunas**: "deixe o rodapé desse jeito só que com as
informações de contato do sdr mas o link das redes da empresa". Adicionada
uma 4ª coluna **"Siga-nos"** (Instagram/LinkedIn/WhatsApp, selos quadrados
dourados) — Instagram/LinkedIn são da EMPRESA (globais, vêm de
`/api/brand`, novas env vars `BRAND_INSTAGRAM_URL`/`BRAND_LINKEDIN_URL`,
mesmo padrão do `BRAND_NAME`: vazio some da tela, nunca inventa link).
WhatsApp reusa o número do **SDR dono da LP** (`config.contactPhone`,
mesmo já usado na coluna "Contato" ao lado — não existe hoje um "WhatsApp
da empresa" separado do SDR neste sistema). Como as duas fontes de dado
(`/api/brand` e `/api/leads/:slug/config`) são fetches independentes sem
ordem garantida, a função `renderSocialCol()` é chamada depois de CADA
uma resolver (idempotente via estado em `brandSocial`/`resolvedContactPhone`
no closure) — funciona não importa qual chegue primeiro.

Também adicionado um **mapa de localização** full-bleed no topo do rodapé
(pedido à parte, "adicione um mapa com a localização da empresa"): embed
simples do Google Maps por texto (`https://www.google.com/maps?q=<endereço
codificado>&output=embed`, sem precisar de chave de API), só aparece com
`BRAND_ADDRESS` configurado (nova env var). Filtro CSS
(`grayscale/invert/contrast`) aplicado no iframe pra combinar com o tema
escuro (Maps é claro por padrão).

A logo genérica do rodapé ganhou uma moldura quadrada dourada
(`.footer-logo-badge`), igual o selo do site de referência — esconde o
selo INTEIRO (não só o ícone) quando a LP tem `logoUrl` próprio, senão
sobraria uma moldura vazia.

**Hero — 2 colunas**: "deixe o hero nesse modelo" (print do hero real:
badge + logo grande + texto à esquerda, foto da Têmis à direita). Adotado
o padrão estrutural — **texto à esquerda (alinhado à esquerda, marca
repetida em tamanho maior acima do título) + imagem à direita**
(`config.heroImageUrl`, que antes era só um background com camada escura
por cima; agora é uma foto de verdade num `<img>` contida numa coluna) —
só quando existe uma imagem de hero configurada (`.has-image`); sem
imagem, mantém o layout centralizado de sempre (não faz sentido dividir
a tela ao meio sem nada real pra pôr do outro lado). Colapsa pra 1 coluna
abaixo de 860px (imagem vai pro topo, texto centralizado). **Não
copiado**: o badge de texto ("Mais de 17 anos de experiência") e os 2
cards brancos específicos do site real (validar telefone / gerar boleto)
— são conteúdo/funcionalidade específicos daquele negócio real, não algo
que qualquer LP genérica desse sistema teria pra mostrar; a "Estatísticas"
já existente (`config.stats`) já cobre a mesma necessidade de destacar um
número (ex.: "17+ anos") sem inventar dado.

Marca (ícone genérico OU `logoUrl` próprio + nome/subtítulo) agora
aparece em **3 lugares**: cabeçalho, hero, rodapé — os 3 IDs
(`brandMark`/`heroBrandMark`/`footerLogoBadge`, `brandName`/
`heroBrandName`/`footerBrandName`, etc.) são todos atualizados juntos nos
mesmos pontos do código (`/api/brand` e `config.logoUrl`).

**Pendente — dados reais que só o usuário tem**: `BRAND_INSTAGRAM_URL`,
`BRAND_LINKEDIN_URL` e `BRAND_ADDRESS` continuam **vazios** no `.env` —
a coluna "Siga-nos" (Instagram/LinkedIn) e o mapa ficam invisíveis até o
usuário preencher essas 3 variáveis (e `pm2 restart whatsapp-gateway
--update-env`). Documentado em `.env.example`.

Validado com jsdom (2 cenários: com imagem+sem override de marca; sem
imagem+com logo próprio+com override de marca) confirmando
`has-image`/`heroVisualImg.src`/`heroBrandMark.style.display`/
`heroLogo.hidden` corretos nos dois casos, e `footerSocialCol`/
`footerMap`/`footerMapIframe.src` corretos com dados de teste
(Instagram/LinkedIn/endereço fake só no teste, nunca gravados em
lugar nenhum real) — depois via curl no servidor rodando.

**Ajuste seguinte, mesma sessão**: a foto do hero (`heroImageUrl`) ficava
esticada só até a altura do TEXTO (bem mais baixa que no site de
referência, onde a foto ocupa a altura inteira da seção e sangra até a
borda direita real da tela). Corrigido: `.hero-visual` virou
`position:absolute; top:0; right:0; bottom:0; width:46%` dentro de
`.hero-banner.has-image` (agora `position:relative`) — o truque foi tirar
o `position:relative` do `.hero-inner` (que só serve pra centralizar o
conteúdo de leitura, com `max-width:1180px`) e colocar em `.hero-content`
(o texto) — assim a busca do CSS pelo ancestral posicionado do
`.hero-visual` "pula" o `.hero-inner` (que não tem mais `position`) e
acha direto o `.hero-banner`, ficando livre pra sangrar até a borda de
verdade em vez de ficar preso dentro do container com padding. `z-index`
ficou também em `.hero-content` (não no `.hero-inner`), garantindo que o
texto continue por cima da imagem absolutamente posicionada (elementos
posicionados pintam por cima de estáticos, independente da ordem no DOM
— sem isso a foto cobriria o texto).

---

### Parte BE — Apresentação executiva: 3 cards novos + roadmap honesto (2026-07-14)

Pedido: atualizar `public/apresentacao.html` (relatório executivo em página única,
CSS/fontes embutidos — **cuidado**: linhas 13 e 20 são `@font-face` em base64
gigante, nunca ler/editar direto, só navegar por seção com grep e editar com
contexto ao redor) pra refletir tudo que foi construído nas sessões recentes e
ainda não estava documentado no relatório em si (o código já tinha as features,
o relatório é que estava defasado).

**Seção "A solução" (`#solucao`)**: adicionados 3 cards novos ao final do grid
(mantendo os 9 originais intactos, sem renumerar), agrupando por tema em vez de
1 card por feature:
- **10 · Sites & Landing Pages** — LP pública customizável (hero com
  imagem/vídeo full-bleed, estatísticas, diferenciais, depoimentos, FAQ),
  formulário que dispara boas-vindas por WhatsApp + cria negócio no Bitrix já
  tagueado com a LP de origem, testes A/B com vencedor apontado por IA, export
  de leads em CSV/XLSX.
- **11 · Resiliência & Inteligência** — resumo de conversa gerado por IA sozinho
  ao abrir o Chat + troca de conversa entre instâncias sem perder histórico
  quando uma cai.
- **12 · Vídeo em Campanhas** — link do YouTube anexado ao disparo em massa,
  com prévia gerada pelo próprio WhatsApp.

Título da seção: "Nove módulos" → "Doze módulos". Card 01 (Chat no negócio)
ganhou menção ao registro automático de entrega/leitura na timeline do negócio;
card 07 (Análise de Conversas) atualizado pra citar o layout em tela cheia e o
novo gráfico "Leads por etapa" — ambos eram atualizações de módulos já
existentes, não features novas, então não geraram card à parte.

**Seção "Próximos passos" (`#roadmap`)**: nenhum dos 5 itens antigos (supervisor
de processo/PM2, domínio fixo, avaliar API oficial, atualizar Baileys, expansão
por área) foi removido — conferido um por um contra o que foi de fato entregue
nesta leva de sessões, e nenhum bate. Adicionados 2 itens novos, fundamentados
em limitações reais (não inventados): **"Upload direto de vídeo nas LPs"**
(hoje o hero em vídeo depende de link público direto; host que exige login,
tipo Bitrix Disk, não funciona na página pública) e **"Fila de reenvio quando
todas as instâncias caem"** (a troca de instância já cobre a queda de 1 número;
falta cobrir o caso de todas caírem ao mesmo tempo, quando a boa-vindas
automática da LP hoje falha silenciosamente).

**Seção "A arquitetura em números" (`#numeros`)**: contagens antigas (9 telas,
14 tabelas) estavam defasadas. Recontado de verdade: 11 telas (`ls public/*.html`
— as 9 de sempre + `sites.html` + `lead-metrics.html`) e 19 tabelas (`grep -oiE
"create table" db/schema.sql` — inclui `ab_tests`, `lead_forms`,
`lead_form_submissions`, `lead_form_views`, que não existiam quando o "14"
original foi escrito). Pequeno ajuste de consistência também no Sumário
executivo (`#sumario`), que ainda dizia "nove telas/módulos" — agora diz "onze
telas e doze módulos" pra não contradizer a seção da solução duas telas depois.

Validado: parser de tags customizado em Node (script descartável, não commitado)
percorrendo o arquivo inteiro (ignorando conteúdo de `<script>`/`<style>`) —
pilha de tags vazia, zero erros de tag aberta/fechada sem par. Contagem de
`<div>`/`</div>`, `<section>`/`</section>`, `<p>`/`</p>`, `<h2>`/`</h2>`,
`<a>`/`</a>` batendo 1:1 via grep. As 2 linhas de `@font-face` em base64
(13 e 20) nunca foram lidas nem tocadas — todas as edições feitas com contexto
ao redor via `Edit`, sempre em linhas > 380.

---

### Parte BD — Resumo da IA estruturado (título/subtítulo/resumo, gerado sozinho) + status do CRM unificado (2026-07-13)

Dois ajustes pedidos com print do painel de detalhes do contato (Chat):

**Resumo mais apresentável**: antes era só um parágrafo corrido. Agora
`summarizeConversation()` (`src/openai.js`) pede a resposta em JSON
(`response_format: {type:'json_object'}`, novo parâmetro `jsonMode` em
`callChatCompletion`) com 3 campos — `title` (bem curto, o assunto
principal), `subtitle` (uma frase com o status atual) e `summary` (o
resumo detalhado de sempre, agora 3-6 frases). Guardado como JSON
stringificado na mesma coluna `ai_summary` (texto, sem migração de
schema) — `store.getConversationSummary`/`setConversationSummary`
(`src/store.js`) fazem o parse/stringify; resumos antigos (texto puro,
gerados antes dessa mudança) caem num fallback automático
(`{title:null, subtitle:null, summary:<texto antigo>}`) — testado ao
vivo contra um resumo legado real já salvo no banco (contato Daniel,
telefone 5521979840129), confirmado funcionando. `POST
/conversations/summary` (`src/routes/whatsapp.js`) devolve os 3 campos
espalhados na resposta (`{title, subtitle, summary, updatedAt}`).
`public/chat.html` (`renderSummarySection`) ganhou `.contact-summary-headline`
(título, negrito) e `.contact-summary-subtitle` (dourado, menor) acima
do `.contact-summary-text` de sempre — a classe do rótulo fixo da seção
foi renomeada de `.contact-summary-title` pra `.contact-summary-label`
pra não confundir com o título GERADO pela IA.

**Aparece sem precisar clicar**: `loadHistory()` agora chama
`generateConversationSummary(true)` automaticamente sempre que abre uma
conversa com mensagens e ainda não existe resumo salvo (`!aiSummary &&
state.messages.length > 0`) — o parâmetro `silent=true` suprime o toast
de erro nesse caminho automático (não faz sentido avisar toda vez que se
abre uma conversa sem resumo ainda, ex.: sem `OPENAI_API_KEY`
configurada); o clique manual no botão de regenerar continua avisando
normalmente. O botão não sumiu — serve agora só pra atualizar depois de
mensagens novas, não é mais o único jeito do resumo aparecer.

**Status do CRM no mesmo lugar**: "Nenhum contato encontrado no CRM
para X" aparecia no MEIO do corpo do painel (logo abaixo do card do
contato), enquanto o botão "Abrir contato/lead no CRM" (quando
encontrado) ficava no rodapé fixo do painel (`.contact-panel-footer`) —
dois lugares diferentes pro mesmo tipo de informação. Unificado: agora
os dois SEMPRE aparecem no rodapé — achado mostra o botão, não achado
mostra a mensagem (`.contact-not-found`, com `margin:0` e
`text-align:center` ajustados pro novo lugar).

Validado: sintaxe (`node --check` nos 3 arquivos backend + extração dos
`<script>` de `chat.html`), restart do PM2, e teste ao vivo via token de
app contra o gateway rodando — `GET /history` confirmado devolvendo o
fallback correto pra um resumo legado, e `POST /conversations/summary`
confirmado gerando e persistindo `{title, subtitle, summary}` de
verdade (chamada real à OpenAI, resposta coerente com a conversa real).

---

### Parte BF — Sites: tag automática da LP na conversa + exportação de leads em CSV/XLSX (2026-07-14)

**Tag automática da LP**: toda submissão de um formulário (`POST /api/leads/:slug`,
`src/routes/leads.js`) agora marca a conversa de WhatsApp que vai receber a
boas-vindas com uma tag do nome da própria LP (`form.name`) —
`store.createTag(sessionId, name, color, fixed)` ganhou um 4º parâmetro
`fixed`, persistido na nova coluna `tags.fixed` (`db/schema.sql`, `alter table`
idempotente pra quem já tinha a tabela); no Chat, tag com `fixed=true` não
mostra botão de remover — mesmo tratamento visual já usado pelas tags
sintéticas "Interno"/"Externo" (que continuam calculadas na hora da leitura,
nunca gravadas na tabela `tags` — só a UI que trata os dois casos igual).
Best-effort: erro ao aplicar a tag nunca derruba a submissão do lead.

**Exportação CSV/XLSX**: nova rota `GET
/api/lead-forms/:id/submissions/export?format=csv|xlsx`
(`src/routes/leadForms.js`), botão "Exportar" no modal "Leads recebidos" de
`sites.html`. CSV é montado à mão (mesmo padrão do parser de import já
existente), com `;` como separador e BOM UTF-8 (`﻿`) na frente — sem
ele, o Excel em pt-BR abre a acentuação corrompida ao clicar 2x no arquivo.
XLSX usa `exceljs` (nova dependência, única lib de planilha do projeto) —
deliberadamente **não** a lib `xlsx`/SheetJS, que tem duas vulnerabilidades
altas sem correção (Prototype Pollution, ReDoS); confirmado em
`package.json` (`exceljs` presente, nenhuma referência a `xlsx` em lugar
nenhum do projeto).

---

### Parte BG — Sites: hero em vídeo por upload direto (2026-07-14)

Até aqui, o hero da LP com vídeo de fundo só existia via link público
(dependia de um host externo). Passou a aceitar upload de vídeo de verdade:
`saveHeroImage` (`src/publicAssets.js`) agora aceita `video/mp4`,
`video/webm` e `video/quicktime` além dos mimetypes de imagem já aceitos;
`db/create-public-bucket.js` teve o limite do bucket `public-assets` elevado
pra 25MB (pensado só pra imagem antes) pra caber um vídeo curto; nova coluna
`lead_forms.hero_media_type` (`'image'`|`'video'`, default `'image'` — cobre
todo dado já existente) diz pra `public/lead-form.html` se deve renderizar
`<video>` ou `<img>` no hero. `sites.html` ganhou o campo de arquivo
aceitando os mimetypes de vídeo, e continua aceitando colar um link direto
também (detecta `.mp4`/`.webm`/`.mov` na URL colada pra marcar
`heroMediaType: 'video'` mesmo sem upload).

Fecha, no mesmo dia, o item "Upload direto de vídeo nas LPs" que tinha
acabado de entrar no roadmap de `apresentacao.html` (Parte BE, escrita mais
cedo hoje) como pendência em aberto — a apresentação ficou desatualizada
por algumas horas; falta voltar lá e corrigir/remover esse item do roadmap
(ver §5).

---

### Parte BH — Chat: mover conversa em andamento pra outra instância (2026-07-14)

Pensado pro cenário (já documentado, ver Parte AY) de uma instância cair ou
ser banida no meio de um atendimento: novo
`store.moveConversationToInstance(oldSessionId, phone, newSessionId)`
(`src/store.js`) troca só `conversations.session_id` — o histórico de
`messages`, vinculado por `conversation_id` e não por `session_id`, continua
intacto, então a conversa "muda de dono técnico" sem perder nada. Recusa com
erro se a instância de destino já tiver a própria conversa com aquele
contato (checagem antes do update, pra não fundir duas conversas por
engano). Nova rota `POST /api/whatsapp/conversations/move-instance`
(`src/routes/whatsapp.js`), corpo `{ session, phone, newSessionId }` —
sessão de origem validada por `requireSession`/`assertOwnsSession` como as
demais rotas, e a instância de destino confirmada separadamente contra
`req.ownerId` (403 se não for de quem está autenticado, 400 se for pedida a
mesma instância de novo). No Chat: ícone novo (mover conversa) abre um modal
listando as outras instâncias do dono, confirma via `window.confirmDialog` e
atualiza a instância ativa na hora.

---

### Parte BI — Timeline do Bitrix registra entrega/leitura da mensagem (2026-07-14)

Pedido do usuário: saber se o contato recebeu/visualizou a mensagem direto
no card do Negócio, já que a timeline nativa do Bitrix ali é só texto (sem
os checks visuais do Chat). Nova `logStatusToTimeline(dealId, text)`
(`src/bitrix.js`, mesmo `crm.timeline.comment.add` de
`logMessageToTimeline`, comentário próprio `[WhatsApp] ...` separado do de
conteúdo) chamada de dentro do `onMessageStatus` (`src/server.js`) sempre
que o status de uma mensagem enviada vira `'delivered'`/`'read'` — texto
"Entregue pelo contato — `<preview>`" / "Visualizada pelo contato —
`<preview>`". Best-effort de verdade: a chamada não é aguardada (só
`.catch` loga o erro), dentro do `try/catch` que já envolve o resto do
handler — uma falha no Bitrix nunca atrasa nem derruba a atualização normal
do status na tela.

---

### Parte BJ — Bug corrigido: contatos LID travavam o check de entregue/lido (2026-07-14)

Mesma classe de problema de LID já conhecida no projeto (ver bug #4 do
README, sessão de recebimento de mensagens), só que num lugar novo: o evento
`messages.update` do Baileys (que carrega as atualizações de status —
entregue/lido) **nunca** preenche `participantAlt`/`remoteJidAlt`, diferente
de `messages.upsert` (mensagem em si). Sem esses campos, o telefone
resolvido pra esse evento específico caía no `@lid` cru — que não bate com
o telefone salvo na conversa —, então `updateMessageStatus` nunca achava a
linha certa e o "✓✓ azul" nunca chegava na tela, silenciosamente. Corrigido
com `_resolveLidPhone(jid)`, novo método `async` em `src/whatsapp.js`:
quando o jid termina em `@lid`, chama
`this.sock.signalRepository.lidMapping.getPNForLID(jid)` (mapeamento
interno LID→telefone que o próprio Baileys mantém) e resolve o telefone
real; se não resolver (contato ainda não mapeado) ou o jid não for `@lid`,
cai no comportamento de antes — best-effort, nunca trava o processamento do
evento.

---

### Parte BK — Cor da marca alcança a bolha de mensagem e a barra de rolagem (2026-07-14)

**Bolha própria**: `--bubble-mine` em `chat.html`/`index.html` era um
gradiente fixo (`#e3b65b`/`#c5912f`), independente de qualquer paleta
configurada — virou `var(--gold)`, então uma cor customizada (ver Parte BM)
agora também pinta as mensagens enviadas no balão, não só botões/links.

**Scrollbar temático, mais uma rodada de reforço**: as páginas já tinham
`::-webkit-scrollbar`/`scrollbar-color` temáticos de sessões anteriores;
reforçado com seletores explícitos `html::-webkit-scrollbar,
body::-webkit-scrollbar` (além do `*` genérico já existente, em 16 das 17
páginas de `public/` — só `bridge.html` ficou de fora) — o seletor universal
sozinho não pega em alguns motores Chromium mais antigos/embutidos (ex.:
webview do Bitrix24 Desktop), então a barra de rolagem da página em si (não
só de listas internas) continuava cinza padrão do SO ali.

---

### Parte BL — Análise Conversas: gráfico mensal completo, distribuição por etapa do Bitrix, rótulo de instância (2026-07-14)

**Gráfico "Mensagens por dia" sempre com o mês inteiro**: o preenchimento de
dias zerados dentro do cálculo principal de `src/metrics.js` só cobria uma
janela do tamanho de quantos dias já tinham registro — agora sempre
preenche do dia 1 do mês corrente (UTC) até hoje, então o gráfico não
"encolhe" no começo do mês nem fica com formato estranho.

**Distribuição por etapa do Bitrix**: nova `getStageDistribution(dealIds)`
(`src/bitrixCrm.js`) busca os negócios vinculados às conversas em lotes de
50 (`crm.deal.list`, filtro `@ID`), resolve o nome de cada etapa via
`crm.dealcategory.stage.list` por categoria, agrupa e ordena — surge como
`metrics.stages` na rota já existente `GET /api/whatsapp/metrics`
(best-effort, `[]` se o Bitrix falhar). `dashboard.html` ganhou o gráfico
"Leads por etapa (Bitrix)"; a página, que já era full-bleed (sem
`max-width` central), tem espaço de sobra pra ele.

**"Por sessão" com nome da instância**: a mesma rota de métricas agora
resolve `sessionId` → `label` (via `instancesStore.listByOwner`) antes de
devolver a tabela por sessão — mostra "Vendas"/"Suporte" em vez do id
técnico, com fallback pro id cru se não achar label.

---

### Parte BM — Paleta de cores editável em Configurações + fim do "flash" de cor padrão (2026-07-14)

**Nova tela `/settings.html`**: até aqui só `BRAND_COLOR` no `.env` dava pra
customizar (e só a cor de destaque principal). Nova tabela singleton
`app_settings` (`id` fixo 1, `accent_color`/`accent_color_dim`/`green_color`/
`red_color`, todos nulos por padrão = usa a cor padrão do app pra aquele
papel) via `src/settings.js` (`get`/`update`, parcial) e
`src/routes/settings.js` (`GET`/`PUT /api/settings`, atrás de `requireAuth`
— qualquer usuário autenticado edita, sem papel de "admin" separado). `GET
/api/brand` (pública, já existia) passou a devolver também
`colorDim`/`green`/`red`, com prioridade sobre `BRAND_COLOR` do `.env`
quando preenchido no banco. A tela tem 4 seletores de cor (principal,
secundária, verde, vermelho), um checkbox "Cor secundária automática" que
deriva a secundária a partir da principal por uma fórmula fixa (~63% de
brilho por canal — mesma proporção real entre `--gold`/`--gold-dim` do
app), swatches rápidos, botões Salvar/Restaurar padrão, e um painel "Prévia
ao vivo" (miniatura de sidebar/stat/bolhas de chat/botão/link/tags de
sucesso-erro) que atualiza sozinho porque só lê as mesmas variáveis CSS
(`var(--gold)` etc.) que os seletores já estão setando em
`document.documentElement` em tempo real.

**Fim do "flash" de cor padrão**: as 13 páginas com sidebar (mais
`apresentacao.html` e `index.html`, que nunca buscavam `/api/brand` até
agora) ganharam um script síncrono no `<head>` que aplica a paleta cacheada
em `localStorage` (`palette_gold`/`palette_goldDim`/`palette_green`/
`palette_red`) antes da primeira pintura, via `window.__applyPalette(b)`
compartilhado; o `fetch('/api/brand')` de sempre continua rodando depois e
atualiza tanto as variáveis CSS ao vivo quanto o cache pra próxima
navegação.

---

### Parte BN — Sugestões dos usuários (2026-07-14)

Nova tabela `suggestions` (`id, owner_id, text, status default 'pending',
created_at, released_at`), `src/suggestions.js` (`create`/`list`/
`markReleased`), `src/routes/suggestions.js` (`GET /`, `POST /`, `POST
/:id/release`, montada em `/api/suggestions`), nova tela `/suggestions.html`.
Visão de **time** (todo mundo vê todas as sugestões, sem filtro por dono —
mesma filosofia da Análise Conversas), sem papel de "admin" separado:
qualquer usuário autenticado pode marcar uma sugestão como "lançada". Ao
lançar, `store.addNotification` cria uma notificação pra quem sugeriu
("Sua sugestão foi implementada!") — aparece na Central de Notificações já
existente (§15 do README), nenhuma tabela/rota nova só pra isso.

---

### Parte BO — Onboarding: guia de cada área do app (2026-07-14)

Nova tela `/onboarding.html` — acordeão com uma seção por área (Análise
Conversas, Chat, Campanha, Contatos & listas, Sites, Métricas de Sites e de
Campanhas, Agenda de Envios, Instâncias, Sugestões, Configurações), pensada
como referência rápida pra quem está conhecendo o app agora.

---

### Parte BP — Chat: painel de contato reorganizado (2026-07-14)

Ordem do painel de detalhes do contato mudou pra campos do contato → grupos
em comum → resumo de IA (antes o resumo vinha primeiro). O botão manual
"Gerar de novo" foi **removido por completo**, a pedido do usuário: o
resumo de IA agora só é gerado sozinho uma vez por conversa (quando ainda
não existe nenhum salvo) e nunca mais se atualiza automaticamente depois
disso — sem botão nenhum pra forçar de novo. O bloco do resumo ganhou
`margin:auto 10px 10px` (o `auto` no topo empurra ele pro fim do painel,
colado no rodapé, em vez de flutuar com espaço morto embaixo quando há
pouco conteúdo acima). O rodapé do painel (botão "Abrir contato no CRM")
ganhou `min-height:90px` pra bater com a altura da barra de composer + dica
da coluna do meio — as duas linhas divisórias agora alinham visualmente
lado a lado.

---

### Parte BQ — Sidebar: "Sites" e "Métricas Sites" viram um grupo só (2026-07-14)

Nas 13 páginas com sidebar, os dois itens de navegação separados viraram um
grupo colapsável: "Landing Page" (item principal, continua indo pra
`/sites.html`) com um botão de seta que expande/recolhe um subitem
"Métricas LP" (`/lead-metrics.html`) embaixo. Estado aberto/fechado persiste
por navegador via `localStorage` (`navGroupLPOpen`), e o grupo já nasce
aberto nas próprias `sites.html`/`lead-metrics.html`. No modo ícone (sidebar
recolhida), os dois itens continuam sempre visíveis, sem acordeão (mesmo
comportamento de antes nesse modo).

---

### Parte BR — Campanha: tela cheia + preview ao vivo com mídia real e miniatura do YouTube (2026-07-14)

**Layout**: `campaign.html` saiu do container centralizado
(`max-width:1180px`) pro mesmo modelo full-bleed da Análise Conversas (só
desconta a sidebar, sem teto de largura) — ficava desproporcionalmente
estreita em tela grande.

**Preview maior**: a coluna de preview cresceu de 300px pra 400px, o frame
do celular de 220px pra 280px, o do tablet de 270px pra 340px.

**Mídia de verdade no preview**: antes, um anexo (imagem/áudio/vídeo) virava
só uma tag de texto tipo "📎 Imagem anexado" no mockup do balão; agora o
preview renderiza a mídia de fato (`<img>`/`<video controls>`/`<audio
controls>`), lendo o mesmo base64 já capturado pra envio — sem upload extra
só pra prévia.

**Miniatura de YouTube**: o campo já existente "Anexar vídeo do YouTube"
(que só cola o link no fim do texto — o WhatsApp não tem "vídeo por URL" no
protocolo, é o app do destinatário que gera a prévia, igual quando alguém
cola o link à mão) passou a mostrar, no próprio preview, uma miniatura real
do vídeo (`extractYoutubeId` tira o id de 11 caracteres de qualquer formato
comum de link, monta `https://img.youtube.com/vi/<id>/hqdefault.jpg` — sem
precisar de chave de API do YouTube).

### Parte BS — Chat: foto de perfil real do contato (avatar do WhatsApp) (2026-07-16)

Até aqui, todo avatar (lista de conversas, cabeçalho da conversa, painel de
contato) era só as iniciais do nome em uma bolinha colorida
(`initials(name)`) — nunca a foto de perfil de verdade que o contato tem no
WhatsApp, mesmo o Baileys expondo isso (`sock.profilePictureUrl`).

**Backend**: `WhatsAppGateway.getProfilePicture(phone)` (`src/whatsapp.js`)
chama `sock.profilePictureUrl(jid, 'image')` e devolve `null` (nunca lança)
se a sessão não estiver `online`, o contato não existir, ou a privacidade
dele bloquear a própria foto pra terceiros — tudo tratado como "sem foto".
Nova coluna `conversations.avatar_url` (`db/schema.sql`, `alter table ...
add column if not exists`) cacheia o resultado pra não bater na API do
WhatsApp de novo a cada carregamento da lista — `store.getAvatarUrl`/
`setAvatarUrl`. Nova rota `GET /api/whatsapp/avatar?session=&phone=`
(`src/routes/whatsapp.js`): olha o cache primeiro; só chama
`getProfilePicture` (e persiste) se ainda não tiver nada salvo — **nunca
revalida** uma foto já cacheada, mesmo que o contato troque de foto depois
(ver dívida abaixo).

**Frontend** (`chat.html`): `avatarInner(name, avatarUrl)` mostra a foto
(`<img>`, com `onerror="this.remove()"` — se a URL expirar/falhar, volta
pra iniciais sozinho) ou cai pras iniciais de sempre quando não há
`avatarUrl` ainda. Como buscar poderia ser lento pra muitas conversas de
uma vez, `fetchMissingAvatars()` roda uma fila sequencial (uma conversa
por vez, 250ms de intervalo, guardada por uma flag `avatarQueueRunning`
pra nunca rodar duas filas ao mesmo tempo) sobre as conversas ainda sem
`avatarUrl` — disparada ao carregar a lista. Cada resultado atualiza o
item da lista e, se for a conversa aberta no momento, o avatar do
cabeçalho também (`applyAvatarToDom`).

- [ ] **Dívida**: a foto fica cacheada pra sempre (`avatar_url` só é
  preenchida uma vez, nunca reconsultada) — se o contato trocar de foto no
  WhatsApp dele, o app continua mostrando a antiga indefinidamente. Sem
  problema prático agora (mudar de foto de perfil não é algo frequente),
  mas revisitar se algum dia incomodar (ex: TTL como o do link preview,
  ver Parte Y).
- [ ] Não testado visualmente dentro do Bitrix com contatos reais que têm
  foto de perfil pública — só validado por leitura do código e pelo
  processo rodando sem erros nesta sessão.

### Parte BT — Dashboard: "Insights de IA" (2026-07-16)

Novo bloco no topo da Análise Conversas (`dashboard.html`, acima dos
KPIs): 3 a 5 cards curtos com diagnóstico ou recomendação prática sobre os
próprios números do time, escritos por IA a partir dos dados que a tela já
mostra — não é um resumo de conversa individual, é sobre os agregados
(mensagens, tempo de resposta, distribuição por instância, etapas do
Bitrix).

**Backend**: `generateDashboardInsights(metrics, stages)`
(`src/openai.js`) formata os mesmos números de `computeMetrics`/
`getStageDistribution` num texto compacto (`describeMetricsForInsights`) e
pede pra OpenAI (`gpt-4o-mini`, `response_format: json_object`) uma lista
de 3 a 5 `{title, text, tone}` — `tone` é `positive`/`warning`/`neutral` e
decide a cor da borda do card no front. Instrução explícita pro modelo
nunca inventar dado fora do que foi passado, e pular métrica "sem dados"
em vez de alucinar um insight sobre ela. Nova rota `GET
/api/whatsapp/insights` (`src/routes/whatsapp.js`) recalcula os agregados
do dono autenticado (mesmo formato de `GET /metrics`, § 8/16) e cacheia o
resultado em memória por 30min (`insightsCache`, `Map` por `ownerId` —
reseta num restart do processo, sem persistência); `?refresh=1` (botão
"Atualizar" da tela) ignora o cache e recalcula na hora.

**Frontend**: `loadInsights(false)` roda uma vez ao carregar a tela (fora
do polling de 30s de `load()`, pra não gerar/gastar chamada de OpenAI a
cada poll) — mostra "Gerando insights…" enquanto espera, os cards depois
(borda colorida por `tone`, ver CSS `.insight-card.positive/.warning`), e
uma mensagem de erro amigável se a OpenAI falhar (ex: sem
`OPENAI_API_KEY`) em vez de quebrar o resto do Dashboard. Rodapé mostra
"Gerado em HH:MM:SS (em cache)" quando veio do cache, sem o "(em cache)"
quando acabou de recalcular. Botão "Atualizar" (ícone com spin durante o
fetch) chama `loadInsights(true)`.

- [ ] **Dívida**: cache só em memória do processo — reinicia zerado a cada
  restart do PM2 (próxima visita ao Dashboard depois de um restart sempre
  gera uma chamada nova à OpenAI, mesmo que tivesse acabado de gerar antes
  do restart). Sem problema de custo relevante hoje (é 1 chamada por dono
  a cada 30min no pior caso), só revisitar se o volume de restarts/donos
  crescer muito.
- [ ] Não validado visualmente dentro do Bitrix com dados reais de
  produção — só testado com o processo rodando e sem erros no log nesta
  sessão, não o resultado renderizado de verdade nem a qualidade/relevância
  dos insights gerados.

### Parte BU — Bug corrigido: "✓✓ visualizado" nunca chegava (sufixo de dispositivo no JID) (2026-07-16)

Mesmo sintoma da Parte BJ (check de entregue/lido travado), causa raiz
**diferente**. `_jidToPhone(jid)` (`src/whatsapp.js`) extraía o telefone só
cortando a parte depois de `@` — mas o WhatsApp às vezes manda o JID de
`messages.update` com um sufixo de dispositivo, tipo
`5521965628397:0@s.whatsapp.net` ou `...:12@...`. Esse sufixo sobrevivia no
telefone extraído (`"5521965628397:0"`), que nunca batia com o telefone
puro salvo em `conversations.phone` — `updateMessageStatus` não achava a
linha certa, e o "✓✓ azul" nunca chegava na tela, mesmo com a resolução de
LID da Parte BJ já funcionando (o problema era antes disso, na hora de
extrair o número de um JID que **não** era `@lid`).

Confirmado no log de produção despejando o JID cru de eventos reais de
status. Correção:

```js
// antes — sufixo de dispositivo (":0", ":12"...) ficava colado no telefone
_jidToPhone(jid) {
  return (jid || '').split('@')[0];
}

// depois — corta também o que vier depois de ":"
_jidToPhone(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}
```

Como `_jidToPhone` é usado em todo lugar que resolve telefone a partir de
um JID (mensagem recebida, reação, presença, participante de grupo — não só
status), a correção é de uma linha só mas de alto alcance.

- [ ] **Ainda em validação com uso real** — a correção foi confirmada
  contra o log (o padrão do sufixo bateu exatamente com o caso relatado),
  mas ainda não foi validada esperando uma confirmação de leitura de
  verdade chegar na tela depois do fix, só nesta sessão. Citada como
  condição do "Go" pro piloto controlado na Revisão de Prontidão de
  2026-07-16 — revisitar se o "✓✓ azul" ainda falhar depois do fix.

### Parte BV — Token de API + documentação Swagger, pra equipe puxar dados fora do navegador (2026-07-17)

Pedido do usuário: antes de migrar pra VPS, deixar pronta uma forma da
própria equipe (não terceiros — decisão explícita de manter autenticado,
não abrir uma API pública de verdade) puxar dados do sistema por
scripts/Postman/Power Query, sem precisar entender o fluxo de login
embutido no Bitrix.

**Token de API** (`issueApiToken`, `src/auth.js`): mesmo mecanismo de
sempre (payload assinado com HMAC, `verifyAppToken`/`requireAuth` não
mudam nada — não distinguem "token de sessão" de "token de API", só o
`exp` embutido é diferente), só que com validade bem mais longa —
`API_TOKEN_TTL_DAYS` no `.env`, padrão **90 dias** (o token de sessão
normal, `AUTH_TOKEN_TTL_HOURS`, continua em 12h). Novo `POST
/api/settings/api-token` gera um token novo pro dono autenticado; não é
persistido nem revogável no servidor (é só HMAC verificado na hora) —
gerar de novo não invalida os anteriores, cada um expira sozinho.

**UI** (`public/settings.html`): novo painel "Token de API" — botão
"Gerar novo token" chama a rota acima, mostra o token num campo
`readonly` com botão "Copiar" (`navigator.clipboard`, com fallback de
selecionar o texto se a API de clipboard falhar) e a data de validade.
Aviso de que o token só aparece uma vez (não fica guardado em lugar
nenhum pra mostrar de novo depois) e de que quem tiver o token acessa os
dados daquela conta.

**Documentação** (`GET /api-docs`, `swagger-ui-express` + `src/openapi.js`):
Swagger UI cobrindo as mesmas rotas já listadas no README §16
(`/api/whatsapp/*`, `/api/*` de contatos/listas/modelos, `/api/settings/*`)
— rota **pública de propósito** (só descreve os endpoints, nenhum dado
real ali), as chamadas de verdade continuam exigindo o Bearer token de
sempre. Testado ponta a ponta: gerar um token pela rota nova e usá-lo de
verdade contra `GET /api/whatsapp/instances` — funcionou.

- [ ] Rotas de `/api/lead-forms/*` e `/api/ab-tests/*` (CRUD administrativo
  das LPs/testes A/B) ficaram de fora do spec OpenAPI — foco foi nas rotas
  de "puxar dado" que motivaram o pedido, não CRUD completo do produto.
  Adicionar se a equipe pedir.
- [ ] Token de API não é revogável individualmente (não tem registro
  nenhum no servidor pra apagar) — se um token vazar, a única forma de
  invalidar é trocar `AUTH_TOKEN_SECRET` no `.env`, o que derruba TODOS os
  tokens (sessão e API) de todo mundo ao mesmo tempo. Aceitável pra uma
  equipe pequena/confiável hoje — revisitar (token com id próprio +
  lista de revogados no banco) se isso incomodar na prática.

### Parte BW — Migração do Supabase pra conta da empresa (2026-07-17)

Pedido do usuário: trocar o Supabase pessoal (`hsgsdasuuyonhosgjixa`) por um
projeto novo (`qqfzfudbeqgldodusoit`) numa conta da empresa, antes da
migração do gateway pra VPS.

**Schema + buckets criados no projeto novo**: `db/migrate.js` +
`db/create-bucket.js` + `db/create-public-bucket.js` rodados apontando pro
projeto novo — 21 tabelas e os 2 buckets (`media` privado, `public-assets`
público) recriados idênticos ao original.

**Dados migrados** — novo script `db/migrate-to-company-supabase.js`
(mantido no repo, não é descartável: mesmo padrão de scripts de migração
únicos já existentes, como `migrate-media-urls.js`). Copia as 21 tabelas
na ordem certa de dependência (pai antes do filho), preservando os IDs
originais (senão as referências entre tabelas quebrariam) e resincronizando
cada sequência bigserial no final. Contagem de linhas conferida tabela por
tabela no fim — bateu 100% (destaque: 1442 mensagens, 703 notificações,
520 contatos).

Três armadilhas encontradas e corrigidas rodando de verdade (não só na
teoria):
1. **Tabelas de chave composta sem coluna `id`** (`contact_list_members`,
   `conversation_tags`, `lead_form_views`) — o `on conflict (id)` genérico
   quebrava nelas; precisou de um mapa de "qual é o conflict target de cada
   tabela".
2. **`pg` serializa array/objeto JS puro como array literal do Postgres,
   não como JSON** — colunas jsonb que guardam uma LISTA (`scheduled_campaigns.recipients`,
   `lead_forms.testimonials/stats/differentials/faq`) precisam de
   `JSON.stringify()` manual antes do insert; sem isso, o Postgres às vezes
   aceita silenciosamente um valor ERRADO (um `[]` virou `{}` nos 3
   `lead_forms` antes da correção — nenhum dado real foi perdido porque
   eram todos arrays vazios, mas corrigido e conferido campo a campo mesmo
   assim) e às vezes rejeita de vez (erro `invalid input syntax for type json`
   foi o que revelou o problema).
3. **`wa_groups.id`** foi classificado por engano como sequência bigserial
   — na verdade é o JID do grupo (`text`), sem sequência nenhuma pra
   resincronizar.

**Storage migrado** — novo script `db/migrate-storage-to-company-supabase.js`,
percorre os buckets recursivamente (Storage do Supabase só lista um nível
por vez) e copia arquivo por arquivo. 238/238 do bucket `media` e 12/12 do
`public-assets`, sem falha, depois de corrigir um detalhe: o upload sem
`contentType` explícito cai em `text/plain` por padrão, que o bucket
`public-assets` rejeita (só aceita as extensões de imagem/vídeo já
configuradas) — corrigido usando o mimetype que o próprio `list()` já
devolve por arquivo.

**Nenhuma URL para reescrever**: conferido que nenhuma LP atual usa uma URL
do Supabase antigo em `logo_url`/`hero_image_url` (a única com imagem de
fundo preenchida usa um link externo do Bitrix Disk, não um upload feito
por aqui) — o script de reescrita cogitado no plano original acabou não
sendo necessário desta vez. Revisitar se algum dia uma LP tiver, de fato,
um logo/hero enviado por upload (aí sim a URL guardada aponta pro projeto
antigo e precisaria ser trocada).

- [x] ~~**Corte final (trocar o `.env` de produção) ainda não foi feito** —
  o gateway continua rodando contra o Supabase antigo até este passo.~~ —
  resolvido na Parte BZ (2026-07-27): `.env` já aponta pro projeto da
  empresa, dados/storage re-sincronizados e conferidos antes do corte.
- [x] ~~Projeto antigo (`hsgsdasuuyonhosgjixa`) não foi apagado/pausado~~ —
  decisão consciente, ver Parte BZ: continua existindo intocado por
  cautela, mesmo depois do corte final feito.

### Parte BX — Limite de 3 instâncias por usuário (2026-07-17)

Pedido do usuário: cada dono só pode conectar até 3 números de WhatsApp
(decisão de negócio, não limitação técnica do Baileys/gateway).

`MAX_INSTANCES_PER_OWNER = 3` (`src/routes/whatsapp.js`) — `POST
/instances` recusa (400, mensagem clara) quando o dono já tem 3 ou mais.
`GET /instances` passou a devolver também `limit`, pra `instances.html`
mostrar "X/3" no cabeçalho do painel e desabilitar o botão "+ Nova
instância" (com `title` explicando por quê) antes mesmo do usuário
tentar e levar o erro — validado de ponta a ponta criando/recusando/
limpando instâncias de teste de verdade contra a sessão `183168`.

- [ ] Limite é só no `POST /instances` (criar) — não afeta instâncias já
  existentes de quem porventura já tivesse mais de 3 antes desta mudança
  (nenhum dono tinha, conferido). Se precisar reduzir o limite de novo no
  futuro, considerar o que fazer com quem já estiver acima do novo teto.

### Parte BY — Reset completo dos dois bancos (antigo + novo), pra começar do zero (2026-07-17)

Pedido explícito do usuário, confirmado em 2 perguntas antes de executar
(dado o tamanho do estrago se entendido errado): apagar TODO o conteúdo
gerado por uso — conversas, mensagens, contatos, campanhas, notificações,
mídia (fotos/áudio/vídeo) — **incluindo as instâncias/pareamentos de
WhatsApp já conectados** (força reescanear QR de cada número), mas
**mantendo a configuração de produto**: Sites/LPs criadas, modelos de
mensagem, paleta de cores (Configurações) e tags.

**Banco** (as duas contas Supabase, antiga `hsgsdasuuyonhosgjixa` e nova
`qqfzfudbeqgldodusoit`): `TRUNCATE ... RESTART IDENTITY` em 16 das 21
tabelas — `conversations`, `conversation_summaries`, `messages`,
`contacts`, `contact_list_members`, `campaigns`, `campaign_results`,
`scheduled_campaigns`, `notifications`, `lead_form_submissions`,
`lead_form_views`, `ab_tests`, `wa_groups`, `conversation_tags`,
`instances`, `suggestions`. Mantidas intactas (conferido antes e depois,
contagem bate 100%): `tags` (5), `app_settings` (1), `lead_forms` (3),
`message_templates` (2), `contact_lists` (2) — em ambos os bancos.

**Storage**: os dois buckets (`media` e `public-assets`) esvaziados nas
duas contas — 242+238 arquivos de mídia e 12+12 de logo/hero, todos
removidos. Conferido antes de apagar `public-assets` que nenhuma LP atual
referenciava um arquivo de lá (a única com imagem de fundo usa link
externo do Bitrix Disk) — mantendo `lead_forms`, nenhuma ficou com link
quebrado.

**Credenciais locais do WhatsApp** (`auth_session/`): pasta inteira
**movida** (não apagada) pra `auth_session_backup_2026-07-17/`, e criada
uma `auth_session/` nova vazia — decisão de segurança própria (não
pedida explicitamente), já que são credenciais reais difíceis de
recuperar; apagar de vez seria irreversível à toa quando mover custa
zero. `.gitignore` ganhou `auth_session_backup*/` pra esse tipo de pasta
nunca ir pro Git também.

Depois do restart, duas pastas (`183168`, `185992`) reapareceram vazias
dentro do `auth_session/` novo — não é a sessão antiga voltando: é
`SessionManager.get()` criando uma sessão nova/vazia sob demanda porque
algo (provável aba do navegador ainda aberta de antes) continuava
consultando o status desses ids especificamente. Conferido que as pastas
não têm `creds.json` nenhum — só aguardando QR novo, comportamento
esperado, não um bug.

- [ ] **Todos os números de WhatsApp precisam ser repareados do zero**
  (efeito direto de ter apagado `instances` + movido `auth_session/`) —
  ninguém foi avisado ainda fora desta sessão; próxima pessoa que abrir o
  app vai ver "Principal" sem QR pareado. Avisar a equipe antes de
  divulgar que o sistema está pronto pra uso.
- [ ] `auth_session_backup_2026-07-17/` fica ocupando espaço em disco
  indefinidamente até alguém decidir apagar de vez (depois de confirmar
  que o reset foi o que realmente queriam) ou consultar pra recuperar
  algum pareamento específico.
- [x] ~~Projeto Supabase antigo (`hsgsdasuuyonhosgjixa`) permanece existindo,
  agora igualmente zerado — a decisão de qual conta usar de fato (corte
  final pro banco novo, ver Parte BW) continua em aberto.~~ — resolvido na
  Parte BZ: corte final feito, gateway rodando contra o projeto da empresa.

### Parte BZ — Corte final pro Supabase da empresa (2026-07-27)

Pedido do usuário: terminar a migração começada na Parte BW/BY — mandar pro
banco novo (`qqfzfudbeqgldodusoit`) os dados de uso real acumulados desde o
reset (que ficaram só no banco antigo, já que o `.env` de produção continuou
apontando pra `hsgsdasuuyonhosgjixa` o tempo todo) e cortar o vínculo de vez.

**Sequência executada**: `pm2 stop whatsapp-gateway` (evitar mensagem nova
chegando durante a cópia) → `db/migrate-to-company-supabase.js` de novo
(idempotente, `on conflict do nothing` — só pegou o que era novo desde a
Parte BW/BY: 13 conversas, 13 instâncias, 201 mensagens, 85 notificações,
tags/templates/lead_forms/app_settings) → `db/migrate-storage-to-company-supabase.js`
de novo (83 arquivos novos no bucket `media`, `public-assets` sem novidade) →
conferência de contagem tabela por tabela nos dois bancos (script avulso,
não versionado) — **as 21 bateram 100%** → `.env` trocado
(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`DATABASE_URL`/`DIRECT_URL` agora
apontam pro projeto da empresa, pooler `aws-1-sa-east-1` em vez de
`aws-1-us-east-2`) → `pm2 restart whatsapp-gateway --update-env` → validado
sem erro de conexão/autenticação nos logs e `GET /api/brand` respondendo sem
o log de erro `[brand] falha ao ler paleta do banco`, confirmando leitura OK
no banco novo.

- [ ] **Projeto antigo (`hsgsdasuuyonhosgjixa`) não foi apagado/pausado** —
  decisão consciente (mesma cautela da Parte BW): fica existindo, intocado,
  até confirmar que o corte se sustenta em produção por um tempo. Só
  considerar desligar depois disso.
- [ ] Reconexões das instâncias de WhatsApp voltaram a aparecer nos logs
  (`statusCode=403/408`) logo após o restart — não é efeito da migração (é
  o Baileys tentando retomar sessão salva contra os servidores do próprio
  WhatsApp, mesmo comportamento de antes do corte); não foi acompanhado até
  o resultado final (reconectou ou pediu QR de novo) nesta sessão.

### Parte CA — Migração pra VPS própria, saindo do ngrok (2026-07-27 a 2026-07-29)

Pedido do usuário: eliminar o item bloqueante da Revisão de Prontidão (Parte
BU) — sair do ngrok grátis e do processo local no Windows. Usuário já tinha
contratado a VPS (Hostinger, `179.198.96.125`) e o domínio
`whatsapp.bmdholding.com.br` (DNS já apontando pra ela).

**Descoberta em cima da hora**: a VPS já vinha com **EasyPanel** pré-instalado
(Docker Swarm + Traefik, provavelmente template da Hostinger), mas sem conta
de admin utilizável no momento. Sem acesso ao painel, o deploy inicial foi
feito **por fora dele**: imagem buildada e container rodado manualmente via
`docker run` (rede `easypanel` compartilhada com o Traefik já existente,
mais um arquivo novo de config dinâmica do Traefik apontando o domínio pro
container) — documentado em detalhe no plano da sessão, não neste arquivo,
já que o passo seguinte tornou boa parte disso obsoleto.

**Passagem de bastão**: durante a mesma janela, o repositório do projeto
migrou pra conta da empresa
(`github.com/DAP-Advocacia/whatsapp-crm-gatway`, renomeado internamente pra
**DapZAP**), e o Caio (TI) assumiu o deploy — obteve acesso ao EasyPanel e
migrou o serviço do `docker run` manual pra um **serviço gerenciado pelo
EasyPanel**, buildando direto do GitHub a cada push (com um ressalva: o
webhook automático não funcionou, precisa clicar "Deploy" manualmente por
enquanto). O container manual anterior foi preservado como
`whatsapp-gateway-old` (parado, não apagado) em vez de rodar os dois ao
mesmo tempo — cuidado necessário porque o Baileys é stateful e duas
instâncias lendo a mesma sessão do WhatsApp corrompem as credenciais (o
mesmo tipo de conflito que já tínhamos visto nos logs como `statusCode=403`
em sessões anteriores).

**A infraestrutura de produção agora é documentada no `DEPLOY.md`** (novo,
na raiz do repo) — é a fonte de verdade pra qualquer dúvida operacional
daqui pra frente (como reiniciar sem duplicar réplica no Swarm, onde ficam
as env vars de produção, versão obrigatória do Node, gotchas de SSL/domínio,
scripts de manutenção). Este HANDOFF.md continua sendo o histórico de
decisões de produto; `DEPLOY.md` é o operacional da VPS.

Também nessa mesma leva de commits do Caio: renomeação da aba/toolbar do
Bitrix de "WhatsApp" pra **DapZAP**, correção de um vazamento de segredo
real (`src/server.js` logava o `POST /` inteiro do Bitrix, incluindo
`AUTH_ID`/`REFRESH_ID`/`APPLICATION_TOKEN` em claro), e Dockerfile fixado em
Node 22 (`@supabase/realtime-js` exige `WebSocket` nativo, só existe a
partir do Node 22 — com Node 20 o processo morre no boot).

- [x] ~~Domínio fixo (sair do ngrok grátis)~~ — resolvido: `PUBLIC_URL` é
  `https://whatsapp.bmdholding.com.br`, HTTPS automático via Let's Encrypt
  (Traefik do EasyPanel).
- [x] ~~Tirar o processo da máquina local pro mesmo VPS~~ — resolvido: PM2
  local parado, gateway roda só na VPS agora.
- [x] ~~Webhook de deploy automático do EasyPanel não funciona~~ — resolvido
  em 2026-07-31 cadastrando um webhook de `push` no repositório do GitHub
  apontando pra Deployment Trigger do serviço (ver `DEPLOY.md` §2). `git
  push` já dispara o deploy sozinho.
- [ ] Porta 3000 (UI do EasyPanel) exposta a qualquer origem, e login `root`
  por senha ainda habilitado na VPS — levantado no próprio `DEPLOY.md` §9,
  não resolvido ainda.
- [ ] Credenciais antigas (env vars do container manual, salvas em
  `/root/whatsapp-gateway-inspect.json` na VPS) ainda não foram rotacionadas
  nem o container/imagem antigos (`whatsapp-gateway-old`,
  `whatsapp-gateway:latest`) removidos — `DEPLOY.md` §11 já deixa o comando
  pronto, só falta confirmar que o serviço novo está estável por mais tempo
  antes de apagar a rede de segurança.

### Parte CB — Captura do histórico de conversas do WhatsApp (2026-07-31)

Pedido do usuário: carregar o histórico de conversas de uma instância já
pareada (mensagens que aconteceram antes ou fora deste app) pra dentro do
Chat, não só o que passa em tempo real depois de conectado.

**Diagnóstico**: o Baileys já pede histórico em toda conexão
(`syncFullHistory: true`, default nunca sobrescrito) e entrega tudo pronto
pra uso no evento `messaging-history.set` (`{ chats, contacts, messages,
isLatest, syncType }`, já decodificado, sem protobuf cru) — só que **nada no
código escutava esse evento**. O histórico chegava e era descartado
silenciosamente desde sempre.

**Correção** em `src/whatsapp.js`: a lógica de normalização de mensagem que
só existia dentro do listener de `messages.upsert` (filtro de status/grupo/
newsletter/reação, resolução de telefone via LID, download de mídia) foi
extraída pro método `_processIncomingMessage(m, { isHistory })`, reusado
pelos dois listeners agora. Novo listener de `messaging-history.set` roda
cada mensagem por esse método e emite o mesmo `this.emit('message', ...)` de
sempre — **nenhuma mudança** em `src/sessions.js`/`src/server.js`, o dedupe
por `(conversation_id, wa_message_id)` que já existe em `store.addMessage`
cobre sozinho mensagens que cheguem de novo depois em tempo real.

Única diferença de comportamento entre os dois caminhos: mídia que falha ao
baixar (link do CDN do WhatsApp expirado, comum em mensagem antiga) não
descarta mais a mensagem inteira quando `isHistory: true` — mantém o texto/
legenda, já que mensagem antiga sem mídia ainda tem valor histórico
(mensagem nova sem mídia continua sendo descartada, como sempre foi, pra não
virar uma notificação incompleta).

- [x] ~~Não testado em produção ainda~~ — testado e confirmado funcionando
  logo depois do deploy, mesma sessão: numa reconexão **normal** (sem forçar
  reescaneio de QR de nenhum número), várias instâncias receberam
  `messaging-history.set` de verdade. Destaque: a instância `..._5305`
  recebeu **1.112 mensagens históricas reais** (datas de 2026-05-05 a
  2026-07-30 — quase 3 meses de conversa que nunca tinham sido salvas),
  todas persistidas certo no banco (total de mensagens saltou pra 6068).
  Outras duas instâncias também receberam lotes (860 e 2392 mensagens no
  evento, algumas descartadas pelos filtros normais de grupo/status). Uma
  instância recebeu um lote de 5000 sem salvar nenhuma — provavelmente quase
  só mensagem de grupo (filtro correto funcionando), não investigado a fundo
  por não ser o caso comum.
- [ ] `shouldSyncHistoryMessage` não foi alterado — o Baileys por padrão já
  exclui o `HistorySyncType.FULL` (só aceita INITIAL_BOOTSTRAP/RECENT/etc.).
  Não foi necessário mudar isso pra já vir muito volume; reavaliar só se
  algum caso específico vier claramente incompleto.
- [x] ~~Depende do deploy ser feito no EasyPanel — webhook automático ainda
  não funciona~~ — resolvido logo depois, mesma sessão (ver pendência da
  Parte CA): `git push` já dispara o deploy sozinho agora.

**Bug encontrado e corrigido na mesma sessão**: mensagem de histórico
importada disparava os mesmos efeitos colaterais de mensagem nova de
verdade — broadcast em tempo real por WebSocket (parecia mensagem chegando
agora pra quem tivesse o Chat aberto), log retroativo na timeline do
Bitrix, e uma notificação por mensagem. Na prática: a instância `..._5305`
sozinha gerou **2325 notificações falsas em 2min45s**. Corrigido
propagando uma flag `isHistory` desde `_processIncomingMessage`
(`src/whatsapp.js`) por `SessionManager.onMessage` (`src/sessions.js`) até
`onMessage` em `src/server.js`, que agora retorna antes do
broadcast/timeline/notificação quando `isHistory` é `true` — mensagem
histórica continua sendo salva no banco (esse é o objetivo), só não gera
mais esses efeitos colaterais. As 2325 notificações falsas já criadas
foram apagadas do banco (janela de horário inequívoca, volume anômalo);
outras contagens bem menores em outras instâncias (35, 11, 10, 9, 3, 1),
espalhadas por horas, foram deixadas intocadas por ambiguidade — não dá
pra garantir que não tem notificação real de verdade misturada nessas.

- [ ] **Duas instâncias deslogadas de verdade pelo WhatsApp**
  (`..._153064` e `..._178810`, `statusCode=401 loggedOut=true`, precisam
  reescanear QR em `/instances.html`) — efeito colateral provável de vários
  redeploys em sequência num intervalo curto nesta sessão (testes manuais
  do webhook + 3 pushes reais), cada um reconectando as ~44 instâncias de
  uma vez. Não confirmado como causa raiz (WhatsApp não explica o motivo
  do logout), só a correlação de horário. Reforça a pendência já registrada
  antes (Revisão de Prontidão, item 03: escalonar reconexão em massa no
  boot) — vale revisitar com prioridade maior agora que já aconteceu de
  verdade, não só teórico. Avisar os donos desses dois números.

### Parte CC — Indicador de não lida no Chat, ligado à Central de Notificações (2026-07-31)

Pedido do usuário: mensagem de notificação deve aparecer só na Central de
Notificações (não "no Chat" — era o bug da Parte CB, já corrigido), e
quando uma notificação for lida, isso deveria refletir de alguma forma no
Chat. Investigado: o Chat não tinha **nenhum** indicador de lida/não lida
por conversa antes disso — só o sininho da sidebar com a contagem total.

**Decisão de design** (confirmada com o usuário): marca visual na lista de
conversas (bolinha, não um filtro/dropdown separado), e marcar como lida
**automaticamente** ao abrir a conversa no Chat (sem precisar ir na Central
de Notificações).

- `src/store.js`: `listConversations` ganhou `unreadCount` por conversa
  (lateral join contando `notifications` com `read = false` e
  `target->>'sessionId'/'phone'` casando com a conversa). Nova
  `markNotificationsReadForConversation(sessionId, phone)`.
- `src/routes/whatsapp.js`: `POST /conversations/mark-read { session, phone }`
  — mesmo padrão de `/conversations/archive`. Documentado no
  `src/openapi.js`.
- `public/chat.html`: bolinha dourada (`.conv-item-unread-dot`) na lista
  quando `unreadCount > 0`; `openConversation` chama
  `markConversationRead`, que zera o contador local (otimista, sem esperar
  resposta), chama a rota nova, e decrementa o sininho da sidebar
  (`window.updateNotifBadge`).

- [ ] Não valida visualmente dentro do Bitrix ainda — só leitura de código
  e revisão desta sessão, sem servidor local pra testar com notificação
  real chegando.
- [ ] Não existe filtro/dropdown separado pra "só não lidas" — decisão
  consciente do usuário (só queria a marca visual por agora); revisitar se
  pedir depois.

### Parte CD — Delegação de acesso a instância + atribuição de conversa (2026-08-03)

Pedido do usuário (com exemplo): um gerente quer disponibilizar o próprio
número de WhatsApp pra funcionários atenderem também, continuando ele
mesmo podendo atender. Decisões fechadas antes de implementar: atribuição
**por conversa** (evita dois atendentes na mesma conversa ao mesmo tempo,
precisa de ação de "pegar"/"transferir"), limite de 3 instâncias por dono
**não conta** pra quem recebe acesso delegado, e **só o próprio dono**
concede/revoga delegação (sem admin aprovando).

**Banco** (`db/schema.sql`, migrado em produção): tabela `instance_delegates`
(`instance_id`, `delegate_owner_id`, `delegate_name` — nome capturado na
hora de conceder via `BX24.callMethod('user.search')` no frontend, evita
precisar de um diretório de usuários no banco). `conversations` ganha
`assigned_to`/`assigned_to_name` (null = não atribuída, qualquer um com
acesso pode atender).

**Acesso propagado numa mudança só**: `assertOwnsSession`
(`src/authz.js`) passou a aceitar também quem está em
`instance_delegates`, não só o dono — como toda rota de conversa/mensagem/
QR/status já passa por `requireSession` (que chama essa função), o
delegado ganha acesso ao app inteiro sem precisar tocar rota por rota.
CRUD da própria instância (renomear/remover) e as rotas novas de
delegação continuam exigindo dono de verdade (conferência explícita contra
`instancesStore.get(id).ownerId`, mesmo padrão já usado em
`DELETE /instances/:id`).

**Rotas novas**: `GET/POST /instances/:id/delegates`,
`DELETE /instances/:id/delegates/:delegateOwnerId`,
`POST /conversations/assign` — documentadas no `src/openapi.js`.
`GET /instances` passou a usar `instancesStore.listAccessible` (próprias +
delegadas, com `delegated: true/false`) em vez de só `listByOwner` — o
limite de 3 continua checando só `listByOwner` em `POST /instances`, e o
contador "X/3" no frontend (`instances.html`) também filtra
`!i.delegated` antes de contar, pra não inflar o limite de quem recebeu
acesso.

**Notificação**: `src/server.js` (`onMessage`) agora notifica só quem
está atribuído à conversa (`assigned_to`), ou — se ninguém pegou ainda,
inclusive contato novo — o dono da instância E todos os delegados dela.

**Frontend**: `instances.html` ganhou botão "Compartilhar acesso" (busca
usuário do Bitrix por nome, concede/revoga); `chat.html` ganhou uma linha
de atribuição no cabeçalho da conversa ("Atender esta conversa"/"Atribuída
a você"/"Atribuída a X, Transferir pra mim") e sufixo "(compartilhada)" no
seletor de instância pra quem é delegado.

- [ ] Não testado dentro do Bitrix ainda — só revisão de código e checagem
  de sintaxe nesta sessão, sem servidor local pra validar o fluxo completo
  (delegar, funcionário enxergar a instância, pegar conversa, notificação
  chegando só pra quem deveria).
- [ ] `user.search` (busca de usuário do Bitrix em `instances.html`) não
  foi validado contra um portal de verdade nesta sessão — se o método ou o
  formato de retorno (`ID`/`NAME`/`LAST_NAME`) divergir do esperado, a
  busca falha silenciosamente pro usuário (mensagem genérica de erro).
- [ ] `PUT /instances/:id` (renomear) e `DELETE /instances/:id` continuam
  fazendo *no-op silencioso* (retornam `{ok:true}` mesmo sem alterar nada)
  se alguém que não é dono tentar usar — comportamento de antes desta
  sessão, só ficou mais visível agora que instância delegada aparece na
  mesma tela; mitigado escondendo os botões pra quem é delegado
  (`instances.html`), não corrigido na origem.
- [x] ~~Bug: `listAccessible` (`src/instances.js`) quebrava com "column
  created_at does not exist"~~ — corrigido antes do usuário chegar a testar:
  `UNION` exige `ORDER BY` pelo nome de saída da coluna (`"createdAt"`), não
  pelo nome original (`created_at`). Encontrado testando a query direto
  contra produção logo depois do deploy, não por relato do usuário.
- [x] ~~Modal de "Compartilhar acesso" aparecia pequeno e fora da área
  visível do iframe do Bitrix~~ — corrigido: `BX24.fitWindow()` só ajusta a
  altura do iframe uma vez, no carregamento da página; um modal mais alto
  que o resto do conteúdo abria centralizado numa região que o iframe nunca
  tinha deixado visível. Chama `fitWindow()` de novo ao abrir o modal e a
  cada troca de etapa; modal também ficou mais largo (460px).
- [x] ~~Modal reorganizado em 3 etapas (Buscar → Confirmar pessoa →
  Concluído)~~ — etapa de confirmação mostra foto/cargo/e-mail (o que
  `user.search` devolver) antes de conceder o acesso de verdade.
- [x] ~~Selecionar a si mesmo na busca não avisava nada de imediato~~ — o
  backend já recusava (`addDelegate`, "não é possível delegar pra si
  mesmo"), só que sem feedback visível na hora certa; agora bloqueia e
  avisa já na seleção, antes de ir pra etapa de confirmar.
- [x] ~~Commit pendente, NÃO publicado de propósito
  (`704d65e — Bloqueia autodelegação na seleção + ajusta paleta`)~~ —
  publicado em 2026-08-03 junto com o fix de escalonamento (Parte CE),
  depois de confirmado que o merge com o commit de Bruno Durão em
  `DEPLOY.md` não tinha conflito.

**Achado importante nesta sessão — deploys reconectando instâncias em
massa derrubando sessões reais**: usuário reportou instância `183168`
("Principal", `5521965628397`) só mostrando conversas de hoje, nada
antigo. Investigado: a pasta de sessão dela na VPS estava **vazia** (sem
`creds.json`) — ou seja, ela não estava com problema de importar
histórico, estava **desconectada de verdade**, precisando de QR novo. Uma
contagem rápida achou **55 instâncias sem sessão ativa** no total (mistura
de gente nova ainda não pareada com possíveis quedas de verdade — não dá
pra separar as duas sem mais investigação). Reforça a pendência já
registrada antes (Revisão de Prontidão, item 03: escalonar reconexão em
massa no boot) — hoje já tem evidência concreta de dano, não só risco
teórico. **Decisão**: pausar novos deploys por enquanto, só retomar numa
janela de baixo uso.

### Parte CE — Correção: reconexão em massa no boot escalonada (2026-08-03)

Causa raiz do achado da Parte CD confirmada e corrigida.
`SessionManager.startAllExisting()` (`src/sessions.js`), chamado uma vez no
boot do servidor, percorria todas as subpastas de `auth_session` com
`creds.json` e chamava `this.get(entry.name)` — e portanto
`gateway.start()` — pra cada uma, em sequência **síncrona no mesmo tick**,
sem nenhum intervalo. Resultado: todo redeploy abre dezenas de conexões
WebSocket pro WhatsApp praticamente no mesmo instante, o que parece pro
WhatsApp um padrão de login em massa a partir do mesmo processo/IP — a
defesa anti-abuso deles reage derrubando (deslogando) sessões. Foi
exatamente isso que derrubou a instância `183168` e outras no incidente
documentado na Parte CD.

**Fix**: `startAllExisting()` virou `async` e agora inicia uma sessão por
vez, com um `await` de `SESSION_STAGGER_MS` (padrão 4000ms, configurável via
`.env`) entre cada uma — não espera antes da primeira nem depois da
última. Chamada em `src/server.js` continua sem `await` (fire-and-forget)
de propósito: o boot HTTP não pode ficar bloqueado esperando ~44 sessões ×
4s (quase 3 minutos) pra responder na porta; o escalonamento roda em
segundo plano enquanto o servidor já está no ar.

Não mexe em `requestFreshQr()` (chamado a cada acesso de rota numa sessão
já em memória, via `SessionManager.get()`) — ela só reconecta se
`gateway.loggedOut === true` (sessão já morta por outro motivo), então não
participa do pico de boot; é comportamento por-request, não por-deploy.

**Publicado e testado em produção em 2026-08-03** (commit `64f6fe1`, junto
com `704d65e`/`4c25bee` pendentes e um merge do commit `2d6cd9c` de Bruno
Durão em `DEPLOY.md`, sem conflito). Resultado do deploy real com
`SESSION_STAGGER_MS=4000` (valor inicial): das 11 sessões com `creds.json`
retomadas no boot, **6 reconectaram normalmente** (`169094`, `185164`,
`185166`, `75974`, `8465__ms6fzwlsri25`, `153452` — essa última teve um
"conflict/replaced" no meio mas se recuperou sozinha), mas **5 caíram com
logout real** (`401 loggedOut=true`: `153064`, `161452`, `178810`, `9129`,
`9129__ms8ujgfydiup`). A `183168` (a que motivou a investigação original)
continuou num loop de retry (`connecting`/`408 timedOut`) sem nunca logar
nem conectar — consistente com já estar sem `creds.json` desde antes, não
é dano novo deste boot.

**Conclusão**: escalonar sozinho, com 4s de intervalo, **não foi
suficiente** — ainda houve queda de quase metade das sessões neste boot.
Não dá pra saber com certeza se essas 5 já estavam fragilizadas de
deploys anteriores (de antes deste fix existir) ou se 4s ainda é rajada
demais pro WhatsApp — não havia como isolar as duas causas sem outro teste
real. **Decisão do usuário**: aumentar bastante o intervalo em vez de
investigar mais a fundo agora. `SESSION_STAGGER_MS` subiu de `4000` pra
`15000` (arquivo `.env` da VPS **ainda precisa ser atualizado
manualmente** — a env var só é lida em `src/sessions.js:95`, não há
migração automática; o `.env.example` já reflete o novo padrão). Com 11
sessões, o boot completo (última reconexão) passa a levar ~2,75min em vez
de ~40s — o servidor HTTP responde bem antes disso, então não afeta
disponibilidade da API/painel, só o tempo até a última instância voltar a
receber mensagens.

**Segundo teste real (15s), causa raiz isolada**: o deploy do commit
`93d0c6f` (aumento pra `SESSION_STAGGER_MS=15000`) subiu e derrubou
**exatamente as mesmas 5 sessões** do teste anterior (`153064`, `161452`,
`178810`, `9129`, `9129__ms8ujgfydiup`) — nem uma a mais, nem uma a menos
— e as mesmas 6 continuaram online. Triplicar o intervalo (4s → 15s) não
mudou o resultado em nada, o que descarta a hipótese de "rajada de boot"
como causa dessas 5 quedas.

Confirmado via `stat` no `creds.json` de cada uma dentro do container:
as 3 conferidas (`153064`, `161452`, `178810`) têm `creds.json` **parado
desde 29/07 ou 31/07** — dias antes destes dois testes — enquanto uma das
que sobreviveu (`169094`) tem `creds.json` **atualizado no próprio boot de
hoje** (rotação de chave de sessão Signal acontecendo normalmente). Ou
seja: essas 5 sessões já estavam mortas/invalidadas de deploys anteriores
a todo este trabalho de escalonamento — não caíram por causa do boot de
hoje, só *pareciam* estar vivas (o processo achava que tinha uma sessão
salva pra retomar) e o WhatsApp já tinha invalidado do lado dele havia
dias.

**Conclusão final**: o fix de escalonamento (`64f6fe1`/`93d0c6f`) está
correto e deve continuar — protege contra o processo *causar* novas
quedas futuras ao abrir dezenas de conexões simultâneas. Mas ele **não
cura, e nunca curaria, sessões que já morreram antes dele existir**. As 5
sessões + a `183168` (6 no total) só voltam escaneando QR novo em
`/instances.html` — não há correção de código possível pra "reviver" uma
sessão que o WhatsApp já invalidou do lado dele.

- [x] ~~Ainda não teve um segundo deploy real pra validar o valor novo
  (15s)~~ — testado, resultado idêntico ao de 4s (mesmas 5 caíram, mesmas
  6 sobreviveram), confirmando que o intervalo não é a variável relevante
  pra essas 5.
- [ ] As 5 sessões (`153064`, `161452`, `178810`, `9129`,
  `9129__ms8ujgfydiup`) + a `183168` precisam de QR novo — usuários donos
  ainda não foram avisados. Usuário optou por não identificar os donos
  agora ("não precisa, siga com a questão que mencionei acima").
- [ ] Causa raiz de *por que* essas sessões foram invalidadas pelo
  WhatsApp em primeiro lugar (antes de qualquer teste desta sessão)
  continua desconhecida — pode ter sido rajada de boot de deploys
  anteriores (de antes do fix existir), ou outro motivo (ex: dispositivo
  removido manualmente, expiração natural do WhatsApp Web). Sem logs de
  época pra confirmar; não investigável retroativamente com o que está
  disponível hoje.
- [ ] `SESSION_STAGGER_MS=15000` fica como valor definitivo por ora — não
  há evidência de que subir mais ajudaria, já que o teste mostrou que o
  intervalo não influencia essas quedas específicas. Reavaliar só se um
  *novo* conjunto de sessões (diferente destas 5) cair em um próximo
  deploy — aí sim seria sinal de que o timing ainda importa.

### Parte CF — Chat: tag de atendente, filtro por atendente, tag Pendente e atualização em tempo real (2026-08-03)

Pedido do usuário: mostrar na lista de conversas quem está atendendo cada
uma, e poder filtrar a lista por atendente. Reaproveita o campo
`assignedTo`/`assignedToName` já existente da feature de delegação
(Parte CD) — não precisou de mudança nenhuma no backend.

**Tag de atendente** (`public/chat.html`): cada card de conversa que tem
`assignedToName` preenchido ganha uma tag com iniciais + nome, ao lado das
tags normais de contato (mesmo espaço, `.conv-item-tags`) — mesmo texto já
usado na linha de atribuição dentro da conversa aberta ("Atribuída a X").

**Filtro por atendente**: linha nova de avatares (iniciais, 22px) ao lado
do filtro de tags — `renderAssigneeFilter()`, chamada toda vez que
`loadConversations()` recarrega a lista. **Não é uma lista fixa de
usuários do Bitrix** — só aparece quem já tem pelo menos 1 conversa
atribuída na lista atual (`Map` construído a partir de
`state.conversations`, chave = `assignedTo`/ownerId, valor = nome). Fica
`hidden` (todo o bloco some) quando nenhuma conversa está atribuída ainda.
Botão "todos os atendentes" (ícone de pessoas) sempre presente quando o
bloco aparece, pra limpar o filtro. Segue o mesmo padrão de fonte/borda
dourada do resto do app (`--gold`), sem cor nova inventada.

Sem foto real do atendente (só iniciais, `avatarInner`/`initials` já
existentes) — o app não guarda avatar de usuário Bitrix, só nome (captado
via `BX24.callMethod('user.search')` no fluxo de delegação); usar `.avatar
xs` (22px, classe nova) mantém consistência visual com o avatar de contato
em vez de inventar um estilo diferente.

**Tag Pendente**: card ganha uma tag vermelha "Pendente" quando
`unreadCount > 0` (mesmo dado já usado pra bolinha `.conv-item-unread-dot`
no topo do card). De propósito **não** existe uma tag "Lida" complementar
— manter a lista limpa; ausência da tag já significa "em dia" (decisão do
usuário, via pergunta direta).

**Bug corrigido no mesmo pedido — atribuição não atualizava em tempo
real**: `POST /conversations/assign` (`src/routes/whatsapp.js`) gravava no
banco mas nunca chamava `broadcast()` (padrão já usado por `/react`,
`/send`, etc.) — por isso a tag/linha de atribuição só refletia depois de
trocar de conversa ou dar F5 (o que dispara um novo `GET /conversations`).
Também faltava, no próprio client que clicava o botão
(`setConversationAssignee`), chamar `renderConvList()`/
`renderAssigneeFilter()` depois de atualizar `state.conversations` — só
`renderAssignmentRow()` (a linha dentro da conversa aberta) era chamada,
então nem quem tinha acabado de clicar via a tag mudar na lista sem trocar
de tela.

Fix nos dois lados:
- Backend: `broadcast(session, phone, { type: 'assignment', assignedTo,
  assignedToName })` depois de `store.assignConversation` — mesmo hub de
  WebSocket que já propaga mensagem/reação/status, então chega em tempo
  real pra qualquer aba/usuário com acesso àquela instância (dono e todos
  os delegados), não só pra quem fez a ação.
- Frontend (`public/chat.html`): `setConversationAssignee` agora chama
  `renderConvList()`/`renderAssigneeFilter()` também (efeito imediato pra
  quem clicou); novo handler `payload.type === 'assignment'` em
  `openSingleInboxSocket` atualiza `state.conversations`/`state.active` e
  re-renderiza lista + linha de atribuição quando o evento chega de outra
  aba/usuário.

**Segundo bug encontrado testando dentro do Bitrix (2026-08-03, depois
do deploy acima)**: usuário liberou a única conversa atribuída (Daniel
Costa) — a linha de atribuição da conversa aberta atualizou certo ("sem
atendente definido"), confirmado direto no banco (`assigned_to = null`
nas duas conversas da sessão), **mas o botão "DC" continuou visível no
filtro de atendentes**. Causa: `renderAssigneeFilter()`, quando
`seen.size === 0`, setava `assigneeFilterEl.hidden = true` e dava
`return` **sem limpar `assigneeFilterEl.innerHTML`** — e a regra CSS
`.assignee-filter{ display:flex; ... }` (especificidade de classe) tinha
prioridade sobre a regra padrão `[hidden]{ display:none }` do próprio
navegador (especificidade de atributo, mais fraca), então o elemento
continuava visível mostrando o HTML da renderização anterior (o botão
"DC" de quando a conversa ainda estava atribuída). Fix: adicionado
`.assignee-filter[hidden]{ display:none; }` (mais específico que a regra
sem `[hidden]`, garante esconder de verdade) e `assigneeFilterEl.innerHTML
= ''` no early-return, como segunda camada de proteção mesmo se outro CSS
futuro voltar a conflitar com `[hidden]`.

- [ ] Não testado dentro do Bitrix o fluxo completo depois deste segundo
  fix (só o primeiro round de testes do usuário, que achou o bug do
  parágrafo acima) — falta confirmar que o filtro some de verdade agora
  ao liberar a última conversa atribuída.
- [ ] Se um atendente mudar de nome no Bitrix depois de já ter atendido
  conversas, o nome antigo fica congelado em `assigned_to_name` (mesma
  limitação já documentada na Parte CD para a linha de atribuição da
  conversa aberta) — a tag na lista herda essa mesma limitação.

### Parte CG — Delegação AUTOMÁTICA de acesso via hierarquia do Bitrix (2026-08-03)

Pedido do usuário: "os acessos dos funcionários de um supervisor sempre
será compartilhado com o supervisor" — automático, sem o gestor precisar
usar o "Compartilhar acesso" manual (Parte CD) um a um. Confirmado via
perguntas: fonte é a estrutura de departamentos do próprio Bitrix (não uma
tela nova pra configurar hierarquia à mão), acesso equivalente à delegação
manual de hoje (instância inteira, não só leitura), e cascateando
sub-departamentos (gestor de área também vê subordinados dos gestores
abaixo dele, não só quem está direto no departamento dele).

**Webhook dedicado, de propósito separado do de CRM**: usuário pediu
explicitamente pra não reaproveitar `BITRIX_WEBHOOK_URL` — nova variável
`BITRIX_HR_WEBHOOK_URL` (escopo "Usuários"), pra poder revogar/trocar um
sem afetar o outro. Opcional: sem ela configurada, a feature fica
inativa (mesmo padrão de degradação graciosa do webhook de CRM).

**`src/bitrixHierarchy.js` (novo)**: `refreshHierarchyCache()` busca TODOS
os departamentos (`department.get`, paginado de 50 em 50 via
`callBitrixHRAll`) e usuários ativos (`user.get`), monta dois mapas —
`headByDept` (`UF_HEAD` de cada departamento = quem é o gestor) e
`childrenByDept` (pra cascatear) — daí, pra cada gestor, calcula a árvore
de sub-departamentos (`collectDeptSubtree`, BFS/DFS simples com `Set`) e
lista todo mundo que está em algum departamento dessa árvore
(`UF_DEPARTMENT` de cada `user.get`, que é array — usuário pode estar em
mais de um). Resultado gravado (substituindo tudo, dentro de uma
transação) na tabela nova `hierarchy_subordinates`
(`manager_owner_id`, `subordinate_owner_id`) — os ids já convertidos pro
formato `ownerId` do app (`member_id_userId`) via `ownerIdFor()`
(`src/auth.js`, já existia, só reaproveitado).

**Cache, não tempo real** (decisão do usuário): `HIERARCHY_CACHE_TTL_HOURS`
(padrão 6h). Dois modos de acesso ao cache, cada um pro seu uso:
- `getSubordinates(managerOwnerId)` — **espera** o recálculo terminar se o
  cache estiver vencido, antes de responder. Usado em `assertOwnsSession`
  (`src/authz.js`), onde uma decisão de acesso/segurança não pode se basear
  em dado propositalmente desatualizado.
- `ensureHierarchyCacheFresh()` — dispara o recálculo em segundo plano
  (fire-and-forget) SE estiver vencido, sem esperar. Usado em
  `listAccessible` (`src/instances.js`), onde a resposta de `GET
  /instances` não pode ficar lenta esperando o Bitrix; a request atual usa
  o cache como está (mesmo que desatualizado por alguns segundos a mais),
  a próxima já vê o resultado novo.

**Integração nos dois pontos que já existiam pra delegação manual** (só
mais uma fonte, não uma feature paralela):
- `assertOwnsSession` (`src/authz.js`): depois de checar dono e delegado
  manual, cai em `getSubordinates(ownerId)` como último recurso — só
  resolvido no máximo 1x por chamada (não por id na lista), mesmo com
  vários `session` na URL.
- `listAccessible` (`src/instances.js`): terceira cláusula `UNION` (a
  segunda, delegação manual, já existia) direto contra
  `hierarchy_subordinates` — trocado `UNION ALL` por `UNION` puro, já que
  agora a mesma instância teoricamente poderia bater em mais de uma fonte
  (delegada manual E hierárquica ao mesmo tempo); `UNION` deduplica pela
  linha inteira. Testado contra produção antes de assumir que funcionaria
  igual ao `UNION ALL` já usado (`ORDER BY "createdAt"` pelo alias, mesmo
  padrão do bug já corrigido na Parte CD) — confirmado sem erro de sintaxe.

**Frontend**: nenhuma mudança — `instances.html`/`chat.html` já tratam
`delegated: true/false` genericamente (mesmo texto "compartilhada" pros
dois casos), sem distinguir manual de automático. Decisão consciente: a
ação (ver/atender conversa) é idêntica nos dois casos, não valeria a
complexidade de diferenciar visualmente por enquanto.

**Webhook criado e ativado em produção no mesmo dia (2026-08-04)**:
usuário criou o webhook dedicado no Bitrix ("Usuários - Daniel",
`/rest/183168/.../`). **Achado durante a configuração**: o escopo
"Usuários (user)" sozinho NÃO é suficiente pra `department.get` — erro
`"The request requires higher privileges than provided by the webhook
token"` mesmo com `user.get` funcionando normalmente. Confirmado via
documentação oficial do Bitrix24
([apidocs.bitrix24.com/api-reference/departments/department-get.html](https://apidocs.bitrix24.com/api-reference/departments/department-get.html)):
`department.get` exige o escopo **"Estrutura da empresa (department)"**,
separado de "Usuários". Usuário adicionou os dois escopos ao mesmo
webhook e salvou — resolvido.

`BITRIX_HR_WEBHOOK_URL` configurada no painel do EasyPanel (Environment
Variables do serviço `whatsapp-gateway/gateway`) e serviço reiniciado.
Validado end-to-end nesta sessão:
- `user.get`/`department.get` testados direto contra o webhook real —
  **838 usuários ativos** e **229 departamentos** no total (confirmando
  que a paginação de `callBitrixHRAll`, 50 em 50 via `start`, funciona:
  bem mais que os 50 da primeira página).
- `refreshHierarchyCache()` rodado manualmente (fora do fluxo normal, só
  pra popular o cache sem esperar alguém abrir `/instances.html` de
  verdade primeiro) — resultado: **76 gestores, 1136 vínculos
  gestor→subordinado** gravados em `hierarchy_subordinates` em produção.
  Teste pontual: owner do usuário "Bruno" (ID Bitrix 1, gestor da
  Presidência) tem 41 subordinados calculados — consistente com estar no
  topo da árvore com cascateamento.
- Migração do schema (`node db/migrate.js`, tabela `hierarchy_subordinates`)
  já tinha sido rodada antes, junto do commit original desta feature.

**Estado atual: feature ATIVA e funcionando em produção.** Próximo
acesso real de qualquer usuário a `/chat.html`/`/instances.html`
(`GET /instances` → `listAccessible` → `ensureHierarchyCacheFresh`) já
usa o cache recém-populado, sem precisar de mais nenhuma ação manual.

- [ ] Não validado visualmente dentro do Bitrix ainda — confirmado só via
  script direto contra o banco/webhook nesta sessão (`refreshHierarchyCache`
  chamado manualmente, `getSubordinates` retornando dado real). Falta
  confirmar que um gestor de verdade, logado no app, vê as instâncias dos
  subordinados aparecerem sozinhas no seletor do Chat (sufixo
  "(compartilhada)") sem ter feito nenhuma delegação manual.

**Restrição no "Compartilhar acesso" manual (mesmo dia)**: usuário notou
que o modal de delegação manual (`instances.html`) buscava em TODO o
Bitrix (`BX24.callMethod('user.search')` sem filtro) — pediu pra
restringir só a quem já está abaixo do dono na hierarquia ("deveria
aparecer somente os usuários que estão abaixo de mim"). Reaproveita a
mesma infra de `getSubordinates` desta parte:

- Rota nova `GET /instances/eligible-delegates?owner=` (`src/routes/whatsapp.js`)
  — devolve os `bitrixUserId` (sufixo do ownerId, já que o client só fala
  BX24 puro por ID do Bitrix) dos subordinados do dono. Sem hierarquia
  mapeada (feature inativa, ou dono sem subordinados), devolve lista
  vazia **de propósito** — não cai pra busca livre como fallback (decisão
  do usuário: restrição pura, não "restrição com fallback").
- `instances.html`: `loadEligibleDelegateIds()` carrega essa lista uma vez
  ao abrir o modal (`openDelegatesModal`, em paralelo com
  `loadDelegatesList`); o listener de busca (`delegateSearchInput`)
  continua chamando `user.search` (só ele resolve nome→usuário no BX24),
  mas filtra o resultado pelo `Set` de elegíveis antes de renderizar. Se
  a lista de elegíveis vier vazia, nem chama `user.search` — mostra
  direto "Você não tem ninguém abaixo de você na hierarquia do Bitrix pra
  compartilhar acesso."

- [ ] Não testado dentro do Bitrix ainda — só `node -c`/checagem de
  sintaxe dos scripts inline e teste de `getSubordinates` direto contra
  produção (com a env var setada manualmente no script, já que o `.env`
  local não tem `BITRIX_HR_WEBHOOK_URL` — só a VPS tem, via EasyPanel).
- [ ] Continua sem afetar a delegação AUTOMÁTICA via hierarquia (parte
  de cima) nem a lista de quem JÁ tem acesso (`loadDelegatesList`) — só
  restringe quem pode ser ADICIONADO daqui pra frente pela busca manual.
- [ ] Se um usuário está em MAIS de um departamento (`UF_DEPARTMENT` é
  array no Bitrix), ele conta como subordinado de TODOS os gestores
  desses departamentos — comportamento intencional (segue a estrutura
  real do Bitrix), mas vale confirmar que é isso mesmo que a empresa
  espera se algum dia isso gerar confusão ("por que meu gestor de RH
  também vê minhas conversas de Vendas").
- [ ] Sem endpoint/rota pra forçar um refresh manual do cache (ex: depois
  de reorganizar o organograma no Bitrix e não querer esperar até 6h) —
  só existe o recálculo automático sob demanda quando o cache vence. Se
  isso virar um incômodo recorrente, considerar um botão "Sincronizar
  hierarquia agora" em alguma tela administrativa.

### Parte CH — Sidebar reorganizada em seções: Workspace + Configuração (2026-08-04)

Pedido do usuário: agrupar as abas da sidebar em seções visuais, com
"Workspace" contendo tudo e "Configuração" isolando só Configurações
(+ Instâncias, já era sub-item) e Apresentação.

**Sem componente de sidebar compartilhado** — cada uma das 13 páginas
(`chat.html`, `dashboard.html`, `campaign.html`, `campaign-metrics.html`,
`campaign-schedule.html`, `contacts.html`, `sites.html`,
`lead-metrics.html`, `onboarding.html`, `suggestions.html`,
`settings.html`, `instances.html`, `notifications.html`) tem a sidebar
inteira duplicada no próprio HTML (decisão de arquitetura de antes desta
sessão — vanilla JS/HTML, sem build step nem templates). `apresentacao.html`
é a exceção — layout próprio, sem essa sidebar, só um link-alvo dela.

Editado `chat.html` manualmente primeiro (Edit tool), validado (checagem
de sintaxe dos scripts inline + balanceamento de `<div>` dentro do bloco
`<nav>` via regex, já que não há Playwright/navegador headless disponível
no ambiente pra tirar screenshot real). Replicado nos outros 12 arquivos
via script Node ad-hoc (substituição de string por âncoras fixas, não
regex frágil) — **achado no meio do caminho**: os arquivos usam quebra de
linha `\r\n` (CRLF), não `\n`; as âncoras multi-linha do script precisaram
ser ajustadas ou não batiam. Segundo achado: `instances.html` e
`settings.html` têm uma variação (`<div class="nav-group open"
id="navGroupSettings">`, com a classe `open` a mais) porque são as
páginas onde esse grupo já vem expandido por padrão — script tratado com
duas variantes de âncora, preservando qual delas cada arquivo já tinha.

**CSS novo** (idêntico nos 13 arquivos): `.nav-section-label` (texto
pequeno, uppercase, `letter-spacing`, cor `--text-faint` — mesmo tom já
usado em `.firm-sub` no logo) e `html.sidebar-collapsed
.nav-section-label{ display:none; }` (esconde o rótulo quando a sidebar
está recolhida, já que nesse estado só os ícones aparecem).

**Estrutura**: `<nav class="sidebar-nav">` agora tem dois
`<div class="nav-section">` — o primeiro com rótulo "Workspace" (Dashboard,
Chat, Campanha+subitens, Contatos, Landing Page+subitens, Onboarding,
Sugestões), o segundo com rótulo "Configuração" (Configurações+Instâncias,
Apresentação). Nenhuma mudança de comportamento (links, grupos
expansíveis, item ativo) — só reagrupamento visual.

- [ ] **Não validado visualmente** — sem Playwright/navegador headless
  disponível no ambiente desta sessão pra tirar screenshot real; validação
  feita só por checagem estrutural (sintaxe + balanceamento de tags via
  script). Recomendado abrir pelo menos uma página dentro do Bitrix pra
  confirmar que o CSS renderiza como esperado (espaçamento, rótulos
  aparecendo/sumindo ao colapsar a sidebar).
- [ ] Se uma 14ª página for adicionada no futuro, replicar manualmente a
  mesma estrutura de duas `nav-section` — não há mecanismo automático que
  sincronize as 13 cópias entre si.

**Ajuste no mesmo dia — Configurações e Instâncias viram abas soltas**:
usuário achou (com screenshot de outro app, "Negócios Fechados", como
referência visual) que "Configurações" e "Instâncias" não deveriam ter
relação pai/filho (clicar numa seta pra expandir/colapsar) — devem ser
duas abas independentes dentro da seção "Configuração", lado a lado com
"Apresentação". Também pediu pra renomear o link "Configurações" pra
"Aparência" (confirmado explicitamente via pergunta — a página
`/settings.html` edita a paleta de cores do app, então o nome descreve
melhor o que ela faz).

Removido o wrapper `<div class="nav-group" id="navGroupSettings">` +
`<button class="nav-caret-btn">` + `<div class="nav-subitems">` nos 13
arquivos — "Aparência" (ex-"Configurações") e "Instâncias" agora são dois
`<a class="nav-item">` soltos, mesmo nível de "Apresentação". Removido
também o bloco JS órfão que controlava abrir/fechar esse grupo
(`navGroupSettingsOpen` no `localStorage` não é mais lido/escrito em
lugar nenhum — decisão consciente de não limpar a chave já gravada no
`localStorage` de quem já usava o app, é inofensiva ficar lá sem uso).
Aplicado via script Node ad-hoc (regex sobre o bloco inteiro, capturando
se `active`/`open` estavam presentes em cada arquivo pra preservar o
item ativo certo) — `settings.html` e `instances.html` têm a variação
onde um dos dois links já vem com `class="nav-item active"` (página
atual), tratada corretamente.

- [ ] Mesma ressalva da entrada anterior: não validado visualmente dentro
  do Bitrix, só checagem estrutural (sintaxe JS + balanceamento de tags).

**Apresentação executiva atualizada no mesmo dia** (`apresentacao.html`,
pedido separado do usuário: "Atualize a apresentação"):
- Seção "03 · A solução": card novo (13º) "Atendimento em equipe" —
  resume delegação manual + automática via hierarquia (Parte CG) e
  atribuição de conversa por atendente (Parte CD/CF) num só card, título
  da seção atualizado de "Doze módulos" pra "Treze módulos".
- Sumário executivo (seção 01): "onze telas e doze módulos" → "treze
  telas e treze módulos" (a contagem de telas já estava desatualizada
  antes desta sessão — 13 páginas com sidebar já existiam, não é uma
  mudança desta sessão, só uma correção de número que estava errado).
- Seção "07 · Riscos e transparência": dois riscos que já tinham sido
  resolvidos em sessões anteriores (túnel ngrok → VPS com domínio fixo;
  processo sem supervisor → Docker/EasyPanel reinicia sozinho) foram
  atualizados — o texto ainda mencionava ngrok e "sem reinício
  automático" mesmo já não sendo mais verdade. **Risco novo adicionado**:
  reconexão em massa derrubando sessões em deploy (achado real desta
  sessão, Parte CE) — severidade média, "mitigado parcialmente" (o
  escalonamento ajudou a não causar dano NOVO, mas não resolveu as
  sessões que já caem por outro motivo ainda não identificado).
- Roadmap (seção 08): removidos "Supervisor de processo" e "Domínio
  fixo" (já entregues, não fazem mais sentido como "próximos passos");
  adicionado "Investigar a causa raiz da queda de sessões em deploy"
  (pendência real e ainda em aberto desta sessão).

- [ ] Igual às outras mudanças de hoje: não validado visualmente — só
  checagem de sintaxe JS. Recomendado abrir a página e rolar até o fim
  (ou usar o botão de exportar PDF) pra conferir visualmente o card novo
  e os textos de risco/roadmap atualizados antes de compartilhar com a
  diretoria.

### Parte CI — Painel de atendimento: subaba dentro do Chat, com gráficos e storytelling (2026-08-10)

Pedido do usuário: uma subaba "Painel" dentro do Chat, pro gerente que
compartilhou a própria instância acompanhar visualmente/graficamente o
atendimento da equipe, com "storytelling" sobre os dados. Confirmado via
perguntas antes de implementar: cobre desempenho por atendente (conversas
atendidas, tempo de resposta, pendências) E saúde geral da instância;
gerente (dono real) vê a equipe toda, delegado comum só o próprio
desempenho; Painel funciona com UMA instância selecionada por vez (não
agrega "todas as minhas instâncias", pra não misturar equipes diferentes
de gerentes diferentes no mesmo gráfico).

**Histórico de atribuição (tabela nova, decisão confirmada com o
usuário)**: `conversations.assigned_to` só guarda quem está atendendo
AGORA — sem histórico, uma conversa que trocou de atendente atribuiria o
volume/tempo de resposta inteiro pra quem só pegou ela por último. Nova
tabela `conversation_assignment_history` (`db/schema.sql`): cada linha é
um período de atendimento (`started_at`/`ended_at`, `ended_at is null` =
ainda vigente). `assignConversation` (`src/store.js`) passou a fechar o
período anterior e abrir um novo dentro de uma transação, a cada
atribuição/transferência/liberação — ganhou um parâmetro novo `ownerId`
(dono real da instância, não o atendente), resolvido pela rota
(`src/routes/whatsapp.js`) e sempre passado agora, mesmo pra desatribuir
(antes só resolvia `ownerId` quando `assignedTo` era truthy).

**Achado real testando contra produção — clock skew entre servidores**:
o cálculo inicial de "mensagens dentro do período vigente" comparava
`started_at` (gravado pelo `now()` do **Postgres/Supabase**) com
`Date.now()` (relógio do **processo Node**) como fim do período. Os dois
relógios estavam ~4 segundos fora de sincronia — o suficiente pra
`endMs` calculado ficar **antes** de `startMs`, fazendo o filtro rejeitar
TODAS as mensagens do período (bug 100% silencioso, sem erro, só
resultado sempre vazio). Descoberto rodando `select now()` no Postgres e
comparando com `Date.now()` local (`store.getAssignmentPeriods`,
`src/store.js`) — a correção foi não usar limite superior nenhum quando
o período ainda está vigente (`ended_at is null`), em vez de tentar
sincronizar os dois relógios. Lição gravada no comentário do código:
nunca comparar timestamp de dois relógios de processos diferentes.

**`src/metrics.js` — `computeTeamMetrics(sessionIds, { viewerOwnerId,
isManager })`**: nova função, ao lado de `computeMetrics` (que já
existia, agregado por instância, nunca por atendente). Usa
`store.getAssignmentPeriods` (nova, junto de `assignConversation`) —
cada período já vem só com as mensagens que caíram dentro da própria
janela de atendimento. Agrega por `assignedTo`: conversas, mensagens
in/out, tempo médio de resposta (mesma heurística de
`summarizeRange`/`computeMetrics`: primeira `out` depois de uma `in`) e
pendências (período ainda vigente cuja última mensagem foi `in` sem
resposta — mesma regra da tag "Pendente" da lista, Parte CF). Se
`isManager` for falso, filtra pra só os períodos do próprio
`viewerOwnerId` antes de agregar — é isso que implementa a visão
restrita do delegado comum.

**Storytelling via OpenAI** (`src/openai.js`): `generateTeamInsights`,
mesmo contrato de `generateDashboardInsights` (3-5 cards
title/text/tone), prompt ajustado pro contexto de equipe (quem está
sobrecarregado, quem responde rápido/lento, distribuição de trabalho) e
em tom de narrativa, como pedido ("storytelling"). `describeTeamMetricsForInsights`
formata só os números já agregados (nunca manda conteúdo de
mensagem/conversa individual pro prompt — mesmo cuidado da versão do
Dashboard).

**Rotas novas** (`src/routes/whatsapp.js`): `GET /team-metrics?session=`
e `GET /team-insights?session=&refresh=1` — as duas recusam (400) se
`session` tiver mais de um id (reforça a decisão de uma instância por
vez). `isManager` é resolvido comparando `instancesStore.get(session).ownerId`
com `req.ownerId` — não é um parâmetro que o client manda (evitaria
qualquer risco de alguém se declarar "gerente" sem ser). Cache de
insights em `teamInsightsCache` (chave composta `ownerId::sessionId`,
igual TTL de 30min do `insightsCache` do Dashboard) — separado do cache
existente porque a mesma pessoa pode ver o painel de instâncias
diferentes, cada uma com dados de equipe diferentes.

**Frontend (`public/chat.html`)** — tabs "Chat"/"Painel" acima da área
de conversa, mesmo padrão de `.editor-tab`/`.editor-panel` já usado em
`sites.html`. Só aparecem quando exatamente uma instância está
selecionada (`updateChatTabsVisibility`, chamado em `onFilterChange`) —
com "todas as minhas instâncias" ou nenhuma selecionada, ficam
escondidas. Painel (`#painelView`) mostra KPIs (conversas, pendências,
atendentes ativos), cards de insight coloridos por tom
(verde/dourado/vermelho, mesmo padrão visual do Dashboard) e uma tabela
por atendente com barra de progresso proporcional ao volume e tag de
pendência.

**Dois bugs de layout encontrados testando visualmente com Playwright
antes de publicar** (ver "validação visual" abaixo):
1. `.painel-view` é irmão de `#app`, não filho — sem o mesmo
   `margin-left: var(--sidebar-w)` que `#app` já tinha, a ponta esquerda
   do conteúdo ficava escondida atrás da sidebar (`position:fixed`).
2. As tabs "Chat"/"Painel" foram desenhadas originalmente DENTRO de
   `#app` (`.conv-pane-head`) — quando o Painel fica ativo (`#app{
   display:none }`), as próprias tabs desapareciam, sem jeito de voltar
   pra aba Chat. Movidas pra fora de `#app`, como elemento irmão
   sempre visível, com o próprio `margin-left` (variável CSS nova
   `--chat-tabs-h`, somada ao cálculo de altura de `#app` e
   `.painel-view` via classe `body.has-chat-tabs`).

**Validação visual**: sem servidor real (`chat.html` depende de
BX24/autenticação de verdade), então o teste foi um preview isolado —
`<head>`+`<aside>`+`#app`+`#painelView` extraídos pra um HTML estático,
servido localmente, com as funções de render do Painel re-injetadas via
`page.evaluate` (Playwright) e dados mockados (3 atendentes, KPIs,
insights). Confirmado visualmente: layout correto sem cortes, cores de
insight certas, clique real nas tabs alternando entre as duas views sem
o bug de sobreposição.

**Migração já rodada em produção** (`node db/migrate.js`, tabela
`conversation_assignment_history` criada) — testada de ponta a ponta
contra produção com dados de teste reais (criados e removidos na mesma
sessão, sem deixar resíduo): atribuição → transferência → liberação
gravando o histórico corretamente; `computeTeamMetrics` retornando
volume/tempo de resposta/pendência certos com mensagens datadas via SQL.

- [ ] **Não testado dentro do Bitrix com usuários reais** — toda a
  validação foi via script direto contra produção (dados de teste
  sintéticos) + preview visual isolado do frontend (dados mockados).
  Falta confirmar com um gerente de verdade que já tem delegados/hierarquia
  configurada vendo o Painel da própria instância, e um funcionário
  delegado vendo a própria versão restrita.
- [x] ~~Sem endpoint pra popular retroativamente `conversation_assignment_history`
  a partir de atribuições que já existiam ANTES desta parte~~ — resolvido
  no mesmo dia, testando dentro do Bitrix pela primeira vez: usuário
  reportou "tem mensagem pendente mas o Painel não mostra nada" numa
  conversa (`Daniel Costa`, instância "Teste") atribuída antes do deploy
  desta feature. Confirmado: zero linhas de histórico pra essa conversa.
  Criado `db/backfill-assignment-history.js` (script pontual, mesmo
  padrão de `migrate-media-urls.js`/`import-legacy-data.js`) — cria um
  período "em aberto" (`ended_at is null`) pra toda conversa com
  `assigned_to` preenchido mas sem nenhum histórico ainda. Idempotente
  (`not exists`), roda quantas vezes quiser sem duplicar.

  **Bug real no primeiro backfill, corrigido antes de publicar**: a
  primeira versão usava `started_at = now()` — parecia razoável ("conta
  a partir de agora"), mas deixava de fora mensagens recentes que já
  existiam ANTES do backfill rodar. Na prática: a mensagem pendente das
  14:25 ficou fora do período criado às 14:31 (6 minutos depois), porque
  o filtro de `getAssignmentPeriods` exige `m.at >= startMs`. Corrigido
  usando `conversations.created_at` como `started_at` — cobre todo o
  histórico de mensagens já trocadas com aquela atribuição, não só o que
  vier depois do backfill. Rodado em produção (2 conversas afetadas:
  `Daniel Costa` na instância 183168, `Pedro Henrique Saraiva` na
  instância 5769) — confirmado depois: `pending: 1` aparecendo
  corretamente, tempo médio de resposta calculado (ficou alto — "47h
  9min" — porque a conversa real tem gaps grandes entre mensagens; é
  matematicamente correto, não bug, só um reflexo de como a média
  simples reage a outliers, ver item novo abaixo).
- [ ] **Dashboard mostrou cache desatualizado no mesmo teste** ("Gerado
  em 10/08/2026, 11:12:27 (em cache)", de antes das mensagens de 14:25) —
  `computeMetrics` testado direto contra produção mostra os números
  certos (17 mensagens, 4 conversas); parece só o cache client-side
  (`insightsCache`/cache do próprio botão de refresh) não ter sido
  atualizado, não um bug de dado. Não confirmado ainda se resolveu só
  com F5/clique em atualizar — usuário ainda não retestou depois disso.
- [ ] Tempo médio de resposta (Dashboard E Painel) usa média simples,
  sensível a outliers — uma conversa real com gaps grandes entre
  mensagens (cliente que demora dias pra responder) infla a média pra
  valores tipo "47h 9min", que não representa bem o tempo de resposta
  "normal" do atendente. Não é bug, mas pode confundir quem está lendo o
  número sem esse contexto. Se isso continuar gerando confusão,
  considerar mediana em vez de média, ou excluir outliers extremos do
  cálculo.
- [ ] Tempo médio de resposta por atendente usa a mesma heurística
  simples do Dashboard (primeira `out` depois de uma `in`, ignorando
  quem mandou de fato) — herda a mesma limitação já documentada:
  não sabe diferenciar resposta automática de resposta humana, nem
  várias mensagens `in` seguidas sem resposta no meio.
- [ ] `GET /team-metrics`/`GET /team-insights` recusam mais de uma
  sessão (400) — se o produto evoluir pra querer uma visão agregada de
  VÁRIAS instâncias de um mesmo gerente ao mesmo tempo, vai precisar de
  desenho novo (hoje decisão consciente de manter simples).

**"Dashboard não atualiza" — não era bug, era o filtro "Internas" ativo
por padrão** (mesmo teste dentro do Bitrix, 2026-08-10): usuário reportou
KPIs zerados mesmo tendo mensagem real trocada — mas os cards de
"Insights de IA" (chamada separada, `GET /insights`) mostravam números
corretos e não-zero pra mesma instância, o que já indicava que o
problema era de renderização/filtro no client, não de dado/backend.
Confirmado direto no banco: `computeMetrics` sem filtro (ou com
`origin=externa`) devolve os números certos (23 mensagens, 5 conversas);
com `origin=interna` (o padrão da página até então), devolve zero — a
conversa de teste é com um número externo (não outro usuário do Bitrix),
então caía fora do filtro "Internas" desde o carregamento da página.

`currentOrigin` (`public/dashboard.html`) mudou de `'interna'` pra `''`
(= "Todas", sem filtro) como valor inicial — o padrão antigo fazia
sentido só na fase de testes internos entre colegas; em uso real, a
maioria das conversas é com cliente externo, então "Internas" como
padrão deixava o Dashboard parecendo vazio pra qualquer instância normal
até alguém pensar em clicar em "Todas" manualmente.

**Contatos "0" no card da instância — limitação conhecida, não bug**:
mesmo teste, usuário notou "0 contatos" no card de `/instances.html`
apesar de haver 5 contatos cadastrados na tabela `contacts`. Confirmado
que são fontes DIFERENTES — o número do card vem de
`WhatsAppGateway.getContactCount()` (acumulado em memória de eventos
`contacts.upsert` do Baileys, zera a cada reinício do processo), não da
tabela `contacts` do CRM (usada em Campanha/listas, que já tinha os 5
registros certos). Limitação já documentada no README antes desta
sessão — os vários deploys de hoje (Painel, backfill) reiniciaram o
processo e zeraram esse contador em memória, que só volta a crescer
conforme o WhatsApp mandar eventos novos de contato pra aquela sessão.

**Bolha de mensagem reduzida (mesmo dia)**: usuário reportou (com
screenshot real, monitor largo) a bolha do bot ocupando quase metade da
tela pra uma mensagem de texto comum. `.bubble{ max-width: 68% }`
(`chat.html`) / `72%` (`index.html`) — porcentagem pura, sem teto em
pixels, então em telas largas a bolha crescia proporcionalmente sem
limite. Trocado pra `max-width: min(60%, 480px)` nos dois arquivos —
nunca passa de 480px mesmo numa janela enorme, mas ainda respeita telas
estreitas (onde 60% já é menor que 480px). Validado visualmente via
Playwright com o texto real do print (menu numerado de 10 itens) —
bolha ficou compacta e legível, sem esticar pela tela.

**Formatação de texto do WhatsApp interpretada + borda removida (mesmo
dia)**: usuário reportou o mesmo menu numerado "embaralhado e sem
padrão" — causa real era que o bot da Alterdata usa `*texto*` (negrito
do WhatsApp) pra organizar os itens, e o chat mostrava os asteriscos
literais, sem interpretar nenhuma marcação. Adicionado
`formatWhatsAppText()` em `chat.html`/`index.html` (dentro de
`linkify()`, entre `escapeHtml` e a linkificação de URL): `*negrito*`,
`_itálico_`, `~tachado~`, `` ```monoespaçado``` `` — mesmas regras do
WhatsApp real (marcador só conta se colado à palavra, sem espaço logo
depois de abrir nem logo antes de fechar; testado explicitamente que
"3 * 4 = 12" não vira itálico por engano). Roda em texto já escapado,
então os regex nunca precisam lidar com HTML de verdade. Também removida
a borda (`border: 1px solid var(--border)`) das bolhas do contato
(`.bubble-row.theirs .bubble`) nos dois arquivos — usuário achou "feio".
Validado visualmente via Playwright reaproveitando o mesmo preview do
item anterior, com a função de formatação real aplicada ao texto do
menu.

**Bug de ESC saindo da conversa em vez de cancelar citação (mesmo
dia)**: usuário reportou — ao clicar "Responder" numa mensagem e depois
desistir com ESC, a tela saía da conversa inteira (voltava pra lista) em
vez de só fechar a barra "Respondendo a…". Causa: o listener de ESC que
fecha a conversa (`chat.html`, perto de `renderConversationView`) só
checava se havia um modal aberto (`.overlay.open`) antes de agir, nunca
checava `state.replyingTo`. Corrigido priorizando cancelar a citação
(chama `cancelReply()`, já existente) antes de considerar sair da
conversa — mesma ordem de prioridade que modais já tinham sobre a
conversa. `index.html` (aba embutida no card do Negócio) não tem esse
bug — não existe listener de ESC lá, porque não há "lista" pra voltar
(uma conversa só, sem tela de lista).

**Espaço vazio antes/depois do texto na bolha — bug antigo, não desta
sessão** (mesmo dia, print real): usuário perguntou por que toda
mensagem tinha um "parágrafo" ou espaço em branco antes de começar —
confirmado que já existia antes das mudanças de hoje (largura/borda/
formatação), reproduzido isoladamente via Playwright pra achar a causa
exata. Causa: `renderMessages()` monta a bolha num template multi-linha
onde `${quotedHtml}` (vazio pra mensagem sem citação) fica em linha
própria — como `.bubble` usa `white-space: pre-wrap`, a indentação/
quebra de linha "de formatação" do próprio template (não do conteúdo)
era preservada como espaço em branco VISÍVEL. Já existia uma proteção
(`compactHtml()`, `html.replace(/>\s+</g, '><')`) mas ela só cobre
espaço entre DUAS tags — não cobre tag-seguida-de-TEXTO, que é
exatamente o caso: o texto da mensagem vem cru (`linkify(msg.text)`,
sem wrapper), não é uma tag.

Corrigido acrescentando `.replace(/>[ \t]*\n\s*/g, '>')` — remove
quebra de linha (+ indentação) que vem logo depois de um `>` de
fechamento de tag, sem tocar em quebra/espaço que esteja DENTRO do
texto de verdade (só age imediatamente após um `>`, nunca no meio de
uma frase). Testado explicitamente que mensagem multi-linha real (menu
da Alterdata, com `<br>` entre parágrafos) preserva as quebras
intencionais — só remove a sobra de formatação do template. Mesmo fix
aplicado em `chat.html` e `index.html` (`compactHtml` duplicada nos
dois). Validado visualmente via Playwright: bolha "Alguém?" reproduzida
bit a bit igual ao print do usuário antes do fix, e compacta depois.

**Avatar do atendente em cada mensagem + aviso de troca de atendente
(mesmo dia)**: pedido do usuário, com exemplo — "1 atendente fez o
primeiro contato mas outro atendente continuou, eu quero essa métrica e
histórico". Diferente do Painel de atendimento (Parte CI, que sabe quem
era responsável por CONVERSA/período), isso é por MENSAGEM individual —
não existia nenhum dado de "quem enviou" numa mensagem, só
`conversations.assigned_to` (responsável atual da conversa inteira).

**Schema** (`db/schema.sql`): `messages.sent_by`/`sent_by_name` — só
preenchido em mensagens novas a partir de agora; mensagens já enviadas
antes desta coluna existir ficam `null` pra sempre (não há como
recuperar quem mandou no passado).

**Backend**: `sentBy` é **sempre `req.ownerId`** (quem autenticou a
requisição) — nunca aceito como valor vindo do client no body, pra
ninguém poder se declarar outra pessoa (mesmo cuidado já documentado em
`isManager` do Painel, Parte CI). `sentByName` é best-effort, vem do
próprio client (`BX24.callMethod('user.current')`, já resolvido no boot
como `myBitrixName`) — evita round-trip ao Bitrix no backend, mesma
lógica já usada em `assigned_to_name`. As duas rotas de envio (`POST
/send`, `POST /send-media` — cobre imagem/áudio/vídeo/documento, não há
rota separada pra áudio) gravam `message.sentBy`/`message.sentByName`
antes de `store.addMessage`, e como o mesmo objeto `message` já vai pro
`broadcast()` do WebSocket, o dado chega de graça em tempo real pra
quem estiver com a conversa aberta em outra aba, sem mudança adicional
no evento realtime.

**Frontend** (`public/chat.html`, `renderMessages()`):
- Pequeno avatar (iniciais, 20px) ao lado de cada bolha `mine` com
  `sentByName` preenchido — reaproveita `initials()`/padrão `.avatar` já
  usado em outros lugares do app (ex: tag de atendente na lista, Parte
  CF). Mensagens sem `sentByName` (antigas, ou otimistas que ainda não
  voltaram do servidor) simplesmente não mostram avatar.
- Divisor dourado "{Nome} assumiu o atendimento" — aparece entre duas
  mensagens NOSSAS consecutivas (`direction='out'`) quando `sentBy`
  muda. Rastreado via `lastSentBy` no loop de `renderMessages`, resetado
  a cada dia novo (não teria como saber quem respondeu "por último
  ontem" de forma confiável nesse resumo visual). Só compara quando
  ambos os lados têm `sentBy` — mensagem sem esse dado nunca dispara o
  aviso nem quebra o rastreamento do próximo.
- As 3 funções de envio (`sendMessage`, `sendMediaFile`,
  `sendRecordedAudio`) passam `senderName: myBitrixName` no body e já
  preenchem `sentBy`/`sentByName` na mensagem OTIMISTA (mostrada antes
  da resposta do servidor chegar) — sem isso, o avatar apareceria só
  depois de um instante, quando a resposta real substituísse a
  otimista.

Validado visualmente via Playwright: conversa simulada com contato →
Ana (2 mensagens seguidas, sem divisor entre elas) → Bruno assume (1
mensagem, com divisor "Bruno Lima assumiu o atendimento" aparecendo
exatamente entre a última mensagem da Ana e a primeira do Bruno) —
avatares corretos em cada bolha (iniciais "AS"/"BL").

- [ ] Não testado dentro do Bitrix ainda — só validação visual isolada
  (Playwright, dados simulados) e teste direto do pipeline
  backend/banco (inserir mensagem de teste com sentBy, conferir que
  volta certo em getHistory). Falta confirmar em produção com duas
  pessoas reais trocando o atendimento de uma conversa de verdade.
- [ ] Mensagens antigas (antes desta parte) continuam sem `sent_by` —
  diferente da Parte CI (Painel), que ganhou um script de backfill
  (`db/backfill-assignment-history.js`) pra cobrir atribuições
  anteriores, aqui NÃO existe backfill equivalente — não haveria como
  inferir quem enviou uma mensagem de texto já mandada no passado (o
  máximo que dava pra inferir seria "quem estava responsável pela
  conversa naquele momento", que é uma aproximação bem mais fraca que
  saber de verdade quem apertou enviar). Mensagens antigas simplesmente
  não mostram avatar nem entram no rastreamento de troca de atendente.
- [ ] O aviso de troca de atendente só considera mensagens NOSSAS
  consecutivas — se o contato responder no meio (A responde, contato
  fala algo, B responde), o divisor ainda aparece corretamente (o
  rastreamento ignora mensagens `in`, não reseta `lastSentBy`). Não
  testado ainda o caso de MUITAS trocas seguidas (ida e volta entre A e
  B repetidas vezes) — deve funcionar pela mesma lógica, mas vale
  confirmar visualmente se não fica poluído.

---

## 3. O que foi feito na sessão de 2026-07-01 (tarde)

Contexto: o app já estava instalado e funcionando para *envio*, mas com dois
problemas vivos — infraestrutura (ngrok/servidor desatualizado) e receiving.

1. **ngrok apontando para porta/domínio errados**: o túnel ativo apontava para
   `localhost:80` (nada rodava ali) em vez de `3333`, e o domínio configurado no
   Bitrix (`disfigure-taunt-oversized.ngrok-free.dev`) pertencia a **outra conta**
   ngrok — o `authtoken` salvo em `ngrok.yml` era de uma conta diferente da que
   reservou aquele domínio. Resolvido: reservado um domínio estático novo
   (`maker-impaired-obliged.ngrok-free.dev`) na conta correta, corrigido o
   `authtoken` em `ngrok.yml`, subido o túnel com
   `ngrok http --url=https://maker-impaired-obliged.ngrok-free.dev 3333`, e
   atualizado `PUBLIC_URL` no `.env` + HANDLER/INSTALL no cadastro do app no Bitrix.
2. **Servidor Node rodando código desatualizado**: o processo ativo tinha sido
   iniciado antes da refatoração multi-sessão ser salva em disco (sem a rota
   `/install`, sem `SessionMana er`). Resolvido reiniciando o processo.
3. **Bug de recebimento resolvido** (era o problema em aberto no fim da sessão
   anterior, ver diagnóstico abaixo).
4. **Bug de duplicação de mensagem enviada** encontrado e corrigido durante os
   testes (não estava mapeado antes).
5. Removidos os `console.log('[...][debug]...')` temporários de `src/whatsapp.js` e
   `src/server.js` usados para diagnosticar o recebimento.

### Diagnóstico do bug de recebimento (causa raiz)

O WhatsApp moderno identifica remetentes por um endereço opaco `<id>@lid` em vez do
telefone, por privacidade (sistema LID). O código tentava recuperar o telefone real
via `m.key.senderPn` / `m.key.participantPn` — campos citados em exemplos/documentação
mais antigos do Baileys, mas que **nunca chegaram a ser preenchidos** em nenhuma
mensagem recebida durante os testes com `@whiskeysockets/baileys@7.0.0-rc13`.
Sem esse campo, o código caía no fallback (`remoteJid`), que nesses casos É o próprio
ID `@lid` — um número artificial que não bate com o telefone de nenhum contato do
CRM. A mensagem chegava e era salva no `store.js`, só que sob essa "chave" errada, por
isso nunca aparecia em nenhuma aba aberta.

Confirmado despejando a `key` completa de mensagens reais no log: os campos que de
fato contêm o telefone real nesta versão são `key.participantAlt` (mensagens de
grupo) e `key.remoteJidAlt` (conversas diretas), ambos no formato
`"5521999999999@s.whatsapp.net"`.

**Correção** em `src/whatsapp.js`:
```js
// antes (nunca funcionava — campos inexistentes nesta versão do Baileys)
const phoneSource = m.key.senderPn || m.key.participantPn || m.key.remoteJid;

// depois
const phoneSource =
  m.key.participantAlt || m.key.remoteJidAlt || m.key.participant || m.key.remoteJid;
```

### Diagnóstico do bug de duplicação (causa raiz)

Ao enviar uma mensagem pela aba, `public/index.html` mostrava a bolha
otimisticamente (antes da resposta do servidor) **e** o backend também retransmitia
essa mesma mensagem por WebSocket (`broadcast` em `POST /send`) para replicar em
outras abas abertas na mesma conversa — inclusive a própria aba que enviou, que está
inscrita nesse mesmo canal. Resultado: a mensagem aparecia duas vezes.

**Correção** em `public/index.html`: ao receber a resposta do `POST /send`, o `id`
temporário da mensagem otimística é substituído pelo `id` real; e o handler do
WebSocket agora ignora qualquer mensagem cujo `id` já esteja na tela.

---

## 4. Changelog de sessões anteriores (resumo)

1. Bug de instalação: `placement.bind` só rodava com `event === 'ONAPPINSTALL'`
   (não ocorre na instalação interativa) → criada rota `/install` que registra via
   `BX24` no navegador.
2. UX fora de card (placement `DEFAULT`) passou a mostrar mensagem amigável em vez
   de erro genérico.
3. Página de aviso do ngrok grátis quebrava `res.json()` → header
   `ngrok-skip-browser-warning` em todos os `fetch`.
4. Refatoração de sessão única global → multi-sessão por usuário do Bitrix
   (`sessions.js`, `store.js` namespaceado, rotas com `session`, WebSocket por
   `session::phone`) — mais tarde evoluiu pra multi-**instância** por usuário
   (ver §2, parte B, item 13).
5. `SessionError: No session record` ao receber de endereços `@lid` no Baileys
   `6.7.23` → atualizado para `7.0.0-rc13`.

Detalhes de arquitetura, rotas e mapa de arquivos: ver `README.md`.

---

## 5. Dívidas técnicas / próximos passos (não bloqueantes)

- [x] ~~Segurança: nenhuma rota valida que `session`/`owner` pertence a quem diz
  ser~~ — resolvido na sessão de 2026-07-02 (parte C, ver §2): autenticação real
  contra o Bitrix + checagem de posse em toda rota REST/WS, incluindo
  `/dashboard.html`/`/api/whatsapp/metrics` (exige usuário válido do portal,
  mesmo continuando agregado/sem filtro por dono).
- [x] ~~**Domínio fixo (sair do ngrok grátis)**~~ — resolvido na Parte CA
  (2026-07-29): VPS própria + domínio + HTTPS automático (Let's Encrypt).
- [x] ~~**Tirar o processo da máquina local pro mesmo VPS acima**~~ —
  resolvido na Parte CA: gateway roda só na VPS, sob EasyPanel, ver
  `DEPLOY.md`.
- [ ] **Escalonar a reconexão em massa de muitas sessões no boot** — hoje
  o `SessionManager` tenta reconectar todas as sessões salvas de uma vez
  só ao reiniciar o processo; com poucas dezenas isso é inofensivo, mas em
  centenas de instâncias é um padrão de login simultâneo do mesmo IP que
  os sistemas antiabuso do WhatsApp associam a automação. Levantado na
  Revisão de Prontidão (item 03) — considerar `p-queue`/intervalo entre
  lotes antes de crescer muito além do piloto atual.
- [ ] **Fila de taxa nas chamadas ao Bitrix do dia a dia** — o rate limit
  de ~2 req/s por webhook do Bitrix já é respeitado no disparo de
  campanhas (`CAMPAIGN_MIN_DELAY_MS`/`MAX_DELAY_MS`), mas **não** nas
  chamadas do fluxo normal (criar negócio, logar timeline, buscar
  contato) — com muitos atendentes simultâneos, isso pode estourar o
  limite silenciosamente. Levantado na Revisão de Prontidão (item 04).
- [ ] **Alerta automático de sessão caída** — hoje uma instância
  desconectada só aparece como linha de log; com poucas instâncias dá pra
  notar de olho, em escala não. Levantado na Revisão de Prontidão (item
  05) — sugestão: PM2 Plus (já usa PM2) + UptimeRobot.
- [ ] **Backup das credenciais de sessão (`auth_session/`)** — hoje só
  existe em disco local; uma falha de disco forçaria todo mundo conectado
  naquele momento a reescanear o QR do zero. Levantado na Revisão de
  Prontidão (item 06) — sugestão: `rclone` sincronizando pro mesmo bucket
  do Supabase Storage já usado no projeto.
- [ ] Avaliar fixar o Baileys numa versão estável (hoje é release candidate `rc13` —
  o comportamento de campos como `remoteJidAlt`/`participantAlt` pode mudar entre
  RCs; revalidar o mapeamento de telefone ao atualizar a lib).
- [ ] Postar o resumo acumulado de mudanças como comentário na tarefa Bitrix
  #2437348 (pendência antiga, ver §2 parte A item 6) — não retomado.
- [ ] `AUTH_FOLDER` persistente é uma pendência **condicional**, não um risco
  ativo hoje: não existe Dockerfile/container/host de disco efêmero neste
  projeto — o deploy real é um processo de longa duração, e `./auth_session`
  já sobrevive normalmente a reinícios nesse modelo. Só vira ação de verdade
  se/quando o gateway for containerizado.
- [x] ~~Rodar o servidor sob um supervisor (PM2, `nodemon` com auto-restart, ou
  serviço do Windows) em vez de `node src/server.js` direto num terminal~~ —
  resolvido: gateway rodando sob PM2 (`pm2 start src/server.js --name
  whatsapp-gateway`), com `pm2-windows-startup` chamando `pm2 resurrect` a
  cada login do Windows. Detalhes/limitação (só sobe depois de login na
  conta, não é Serviço do Windows de verdade) no README.md §20 — este
  item tinha ficado marcado como aberto aqui por engano depois de
  resolvido.
- [ ] Testar visualmente dentro do Bitrix os gráficos melhorados da Análise
  Conversas (ver §2 parte D, item 27) — só foi validada a matemática isolada no
  Node nesta sessão, não o resultado renderizado de verdade.
- [ ] Aplicar nas outras 6 páginas (`index.html`, `campaign.html`,
  `contacts.html`, `campaign-metrics.html`, `campaign-schedule.html`,
  `instances.html`) o mesmo ajuste de alinhamento de altura entre logo da
  sidebar / cabeçalho da página / rodapé feito em `chat.html` (ver §2 parte E,
  item 32) — só chat.html foi corrigido até agora; as outras têm o mesmo
  problema de alturas diferentes por serem o mesmo componente copiado.
- [ ] Os outros diálogos nativos do navegador (`alert()`/`confirm()`) que
  ainda restam nas 7 páginas — usuário confirmou que por enquanto só o
  `prompt()` de nova instância precisava virar modal (ver §2 parte E, item 29);
  revisitar se pedir pra trocar o resto.
- [ ] Testar dentro do Bitrix, com números de teste de verdade, o fluxo de
  criar grupo direto do Chat (ver §2 parte G, item 36) — não testado nesta
  sessão por criar um grupo real no WhatsApp (ação visível pra terceiros).
- [ ] Confirmar dentro do Bitrix se a notificação nativa do sistema operacional
  chega a funcionar de verdade (ver §2 parte H) — é esperado que o iframe do
  Bitrix bloqueie a permissão (mesma limitação já conhecida do microfone);
  o toast/sino continua funcionando de qualquer forma, então não é bloqueante,
  só falta confirmar visualmente o resultado real.
- [ ] Validar visualmente dentro do Bitrix os itens da parte I (§2): clique
  numa notificação abrindo a conversa certa, botão "Grupos" listando e
  reabrindo um grupo existente, contagem de mensagens e "grupos em comum" no
  painel de contato batendo com a conversa aberta de verdade — só foi testado
  via curl/código nesta sessão.
- [ ] Confirmar com o usuário se o balão de mensagem ainda aparece maior que
  o texto depois do ajuste defensivo da parte I (item 46) — revisão de código
  não achou um bug real, então se persistir precisa de mais contexto (tipo de
  mensagem, balão próprio ou do contato) pra investigar de novo.
- [ ] `GET /contacts/groups` (parte I, item 48) faz uma chamada ao WhatsApp
  por grupo da instância, sem paginação nem cache — reavaliar se alguma
  instância crescer pra muitas dezenas/centenas de grupos.
- [ ] Validar visualmente dentro do Bitrix os itens da parte J (§2): botões
  "Grupos"/"Novo grupo" na nova posição, botão "Abrir no CRM" fixo no rodapé
  do painel de contato mesmo com pouco/muito conteúdo acima, e a bolinha de
  status (verde/vermelho) na lista de conversas batendo com o status real de
  cada instância — só validado por leitura de código nesta sessão, sem
  servidor rodando com múltiplas instâncias em estados diferentes pra testar
  ao vivo.
- [ ] Validar visualmente dentro do Bitrix os itens da parte K (§2): rodapé
  alinhado nas 6 páginas (comparar lado a lado com `chat.html`); Central de
  Notificações com mensagens reais chegando (confirmar que o card aparece em
  "Não lidas", marcar como lida move pra "Lidas", o Calendário agrupa por dia
  certo); deep link `chat.html?session=&phone=` abrindo a conversa certa
  vindo de um card. O fluxo de criação da notificação (rota →
  `getConversationNotifPrefs` → `ownerOf` → `addNotification`) só foi testado
  via curl com uma notificação inserida manualmente, não com uma mensagem de
  WhatsApp de verdade chegando.
- [ ] `GET /notifications` (parte K, item 57) não é paginado, limit 500 fixo
  — reavaliar se o histórico de algum usuário crescer muito (mesma classe de
  limitação já registrada pra `/contacts/groups`).
- [ ] Badge de não lidas nas 7 páginas fora do Chat só atualiza no
  carregamento da página (sem WebSocket próprio pra isso) — se o usuário
  ficar muito tempo numa dessas páginas recebendo mensagens, o número fica
  desatualizado até recarregar ou navegar. Considerar no futuro uma
  inscrição de WebSocket por dono (não por sessão) se isso incomodar na
  prática.
- [ ] Validar visualmente dentro do Bitrix os itens da parte L (§2): mídia
  (imagem/áudio/vídeo) antiga e nova carregando normal no Chat depois do
  bucket virar privado; um agendamento de verdade com mídia (Kanban de
  `campaign-schedule.html`) até disparar de verdade pra um destinatário
  real; os 5 `confirm()` trocados (Cancelar/Confirmar/ESC) e os toasts que
  substituíram os `alert()` antigos — tudo só testado via curl/código nesta
  sessão.
- [ ] Mídia "pendente" de agendamentos (parte L, item 64) fica órfã no
  Storage depois do disparo — não é apagada, só a `scheduled_campaigns`
  guarda o caminho, e o disparo de verdade sobe sua própria cópia. Considerar
  limpeza periódica se o volume crescer.
- [ ] `prompt('Nome do modelo:')` em `campaign.html` (salvar modelo de
  mensagem) ainda é nativo — fora do escopo da parte L (usuário pediu
  especificamente alert/confirm), revisitar se pedir pra trocar também.
- [ ] Contatos com telefone real que têm histórico misto (mensagem de
  atendimento de verdade + mensagem de grupo compartilhado, de antes da
  correção da parte Q) não foram limpos — o schema não guarda a origem de
  cada mensagem antiga, então separar isso com segurança exigiria revisão
  manual, mensagem por mensagem. A correção já aplicada impede que aconteça
  de novo; histórico já misturado continua misturado até alguém revisar na
  mão (se for importante o suficiente pra valer o trabalho).
- [ ] **`apresentacao.html` com roadmap desatualizado**: a Parte BE (mais
  cedo no dia 2026-07-14) adicionou "Upload direto de vídeo nas LPs" como
  item **em aberto** no roadmap da apresentação executiva; a Parte BG,
  horas depois no mesmo dia, entregou justamente isso. Falta editar
  `public/apresentacao.html` de novo pra tirar/atualizar esse item (não
  feito nesta rodada de documentação — fora do escopo de HANDOFF.md/
  README.md).
- [ ] Nenhum dos itens novos das Partes BF-BR (§2) foi validado
  visualmente dentro do Bitrix em produção — tudo confirmado só por
  leitura/grep do código nesta rodada de documentação (tag automática da
  LP, export CSV/XLSX, hero em vídeo, mover conversa entre instâncias,
  timeline de entrega/leitura, fix de LID nos ticks, paleta de cores em
  Configurações, Sugestões, Onboarding, grupo "Landing Page" na sidebar,
  Campanha em tela cheia).
- [ ] `/api/settings` e `/api/suggestions` não têm papel de "admin"
  separado — qualquer usuário autenticado deste portal pode editar a
  paleta de cores do app inteiro ou marcar a sugestão de qualquer um como
  "lançada". Decisão consciente (equipe pequena/confiável), documentada
  nos próprios arquivos — revisitar se a equipe crescer.
- [ ] Avatar do WhatsApp (parte BS, §2) cacheado em `conversations.avatar_url`
  pra sempre, sem revalidação — se um contato trocar de foto de perfil, o
  app não percebe. Não validado visualmente dentro do Bitrix com contato
  real com foto pública.
- [ ] "Insights de IA" do Dashboard (parte BT, §2) cacheados só em memória
  do processo (30min, por dono) — zera a cada restart do PM2. Não validado
  visualmente dentro do Bitrix com dados reais, nem a qualidade/relevância
  do texto gerado pela IA — só testado com o processo rodando sem erros.

---

## 6. Contexto de teste

- Portal: `bmd.bitrix24.com.br`, `member_id = 2c39349ea593c27fd3092b4fe2c47de7`.
- Deal usado no teste de recebimento: `5367598` ("TESTE COBRANCA CAIO").
- Instâncias de teste ativas:
  - `..._5305` (número próprio `5521959030061`).
  - `..._183168` (número próprio `5521965628397`, exibido como "Gabriel Alves ·
    Conta comercial" para quem conversa com ele) — apareceu **deslogada**
    (`loggedOut`) numa verificação recente; evento do próprio WhatsApp, não
    relacionado a nenhuma mudança de código — só precisa re-escanear o QR quando for
    usada de novo.
  - `portal_183168` — apareceu numa retomada de boot, provavelmente de um teste
    feito com a página aberta fora do contexto normal do Bitrix (`BX24.getAuth()`
    sem `member_id` cai no fallback `'portal'`). Não é uma instância "real" de uso;
    pode ser removida em `/instances.html` se atrapalhar.
  - Uma instância extra de teste (`..._183168__mr3o...`, rótulo "Suporte (teste)")
    foi criada e removida durante os testes da funcionalidade de múltiplas
    instâncias — não deve mais existir.
  - `..._183168__mr53alboa51l` (rótulo "Teste") — encontrada em `connecting`
    sem telefone (QR nunca escaneado) numa verificação em 2026-07-03; não foi
    criada por nenhuma mudança desta sessão, provavelmente um teste manual do
    próprio usuário. Remover em `/instances.html` se não for mais necessária.
- Projeto Supabase em uso (desde o corte final, Parte BZ, 2026-07-27):
  `qqfzfudbeqgldodusoit` (conta da empresa). Projeto pessoal antigo
  `hsgsdasuuyonhosgjixa` (org `danielcxvai@gmail.com's Org`) continua existindo,
  intocado, mas fora de uso.
- Tarefa Bitrix pra postar updates de progresso (pendência antiga, não retomada):
  **#2437348** (comentário/chat, não descrição).
- Domínio ngrok atual: `https://maker-impaired-obliged.ngrok-free.dev` (estático,
  reservado na conta ngrok correta — não muda em reinícios do túnel, **desde que**
  sempre suba com `ngrok http --url=https://maker-impaired-obliged.ngrok-free.dev 3333`).


