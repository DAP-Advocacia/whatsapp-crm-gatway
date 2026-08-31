# Roteiro do vídeo de onboarding — WhatsApp Gateway

> Formato: mesmo padrão usado no BI-DAP (`roteiro-video-apresentacao-3min.md`)
> — texto corrido de locução com marcadores **[TELA: Nome]** intercalando onde
> a gravação de tela real entra na edição. A narração é contínua; o editor
> sincroniza o corte de tela por cima, sem pausar a fala.
>
> Diferente do BI-DAP v1 (slides + narração), este vídeo já nasce **v2 real**
> — todas as cenas são screencast de verdade do MODO DEMO
> (`?demo=1`, ver `src/demoModeGate.js`), nunca slide estático nem produção
> sanitizada. Zero PII: nome do escritório, contatos, telefones e conversas
> são todos fictícios de origem (`src/demoData.js`).

---

## Texto corrido para a locução

Oi! Esse é um tour rápido pelo WhatsApp Gateway, o sistema que conecta o
WhatsApp direto ao Bitrix24 — conversa, campanha, agente de inteligência
artificial e métricas, tudo numa aba só dentro do CRM. Em dois minutos eu
mostro as telas que você mais vai usar.

**[TELA: Dashboard]**

A primeira tela é o Dashboard. Assim que abre, a inteligência artificial já
gera alguns insights automáticos sobre o período — taxa de resposta, picos de
volume, instância com menos atividade. Logo abaixo ficam os números
principais: mensagens totais, recebidas, enviadas, conversas ativas e tempo
médio de resposta, cada um comparando com o mês e o ano anterior. Mais para
baixo, a tabela de conversas vinculadas a negócio, e os gráficos de volume por
dia e de dispersão entre recebidas e enviadas.

**[TELA: Contatos]**

Em Contatos você cadastra e organiza contatos em listas personalizadas — dá
pra importar direto das conversas existentes ou de um arquivo CSV. As listas
servem depois pra escolher destinatários numa campanha, e também dá pra criar
grupos de WhatsApp de verdade a partir daqui.

**[TELA: Campanha]**

A aba Campanha envia a mesma mensagem, personalizada por contato, pra vários
destinatários de uma vez — com um aviso importante sobre o risco de banimento
do próprio WhatsApp, e um controle de intervalo entre cada envio pra reduzir
esse risco. O preview ao vivo do lado mostra exatamente como a mensagem vai
aparecer pro destinatário, com as variáveis de nome e telefone já substituídas.

**[TELA: Agente de IA]**

No Agente de IA você configura um atendimento automático de triagem — ele
responde sozinho a mensagem de um lead novo, até um humano assumir a
conversa. Cada instância tem sua própria configuração: mensagem de sistema,
base de conhecimento e uma revisão final antes de salvar. E tem um playground
aqui embaixo pra testar a configuração conversando com a IA antes de ativar de
verdade.

**[TELA: Configurações]**

Em Configurações dá pra personalizar a paleta de cores do sistema inteiro —
com modelos prontos ou ajustando cada cor à mão, e uma prévia ao vivo mostrando
como fica nas telas reais antes mesmo de salvar.

**[TELA: encerramento]**

Isso cobre o essencial do WhatsApp Gateway. Tem outras telas também, como
Instâncias, Auditoria de Conversas e Análise de Sugestões, mas essas cinco já
dão conta do dia a dia. Qualquer dúvida, o guia de atalhos fica disponível em
qualquer tela, no ícone de teclado lá no topo. Bom trabalho!

---

## Notas de produção

- Duração estimada da fala: ~85-100s dependendo do ritmo da voz.
- Voz: preset pt-BR, tom corporativo/didático, ritmo tranquilo — mesmo
  padrão do BI-DAP (`pt-BR-AntonioNeural`/`FranciscaNeural` via `edge-tts`,
  ou Higgsfield se houver créditos).
- Pontos **[TELA]** marcam onde entra cada screen recording na edição — a
  narração não pausa, é contínua; o editor sincroniza o corte de tela por
  cima.
- **Todas** as gravações de tela saem do MODO DEMO (`?demo=1` em cada URL,
  ver `src/demoModeGate.js`) — nunca de produção, nunca com dado real. O
  banner vermelho "MODO DEMO" que aparece no topo de cada tela deve ser
  **cortado/escondido na edição** (crop do topo do frame, ou começar a
  gravação já com scroll leve) — ele é intencional pra uso interno/gravação,
  não deve aparecer no vídeo final publicado.
- Nome do escritório usado no modo demo: "Andrade & Camargo" (fictício).

## Scripts (a construir na próxima etapa)

- `scripts/video/rec.mjs` — Playwright abre cada URL do modo demo, grava
  `.webm`, navega/aguarda conforme este roteiro.
- `scripts/video/narracao.py` (ou `.mjs`) — gera a narração via `edge-tts`,
  concatena com `ffmpeg` (mesmo padrão do BI-DAP).
- `scripts/video/build.mjs` — corta/concatena os `.webm` casando com a
  duração da narração, adiciona cartão de abertura/encerramento.
- Saída: `public/video/video-onboarding.mp4` + `public/video/video-poster.png`.

Ver o plano completo em `C:\Users\eunom\.claude\plans\structured-petting-twilight.md`.
