# Design System — WhatsApp ↔ Bitrix24 Gateway

> Extraído diretamente do `:root` de `public/chat.html` (mesma paleta
> compartilhada pelas 8+ páginas do projeto — index, campaign, contacts,
> instances, dashboard, agente-ia, notifications, admin, etc). Nenhum
> valor abaixo é inventado; tudo vem do CSS real já em produção.

## 1. Paleta (tema padrão — "Durão, Almeida & Pontes")

```css
:root{
  --bg: #15120d;
  --surface: #1d1812;
  --surface-2: #241d15;
  --border: #34291a;

  --gold: #d8ab4f;
  --gold-rgb: 216,171,79;
  --gold-dim: #8a6b32;

  --text: #f3ede2;
  --text-muted: #a89a83;
  --text-faint: #6e6353;

  --green: #4caf6e;
  --green-rgb: 76,175,110;
  --red: #d9685f;
  --red-rgb: 217,104,95;

  --radius: 14px;
  --bubble-mine: var(--gold);
  --bubble-mine-text: #1a1408;
  --bubble-theirs: #261f16;
}
```

Tema escuro por padrão (fundo `#15120d`, quase preto com fundo quente).
`--surface`/`--surface-2` são os dois níveis de fundo de card/painel
(o segundo, mais claro, para hierarquia visual dentro de um card).

## 2. Cores semânticas — o que cada uma significa

O projeto usa cor para **comunicar tipo de conteúdo**, não só estética —
isto é intencional e documentado no próprio código (ver Parte EW do
`HANDOFF.md`). Três categorias distintas hoje:

| Cor | Token | Significa | Onde aparece |
|---|---|---|---|
| Dourado | `--gold` / `--gold-dim` | **Nota interna humana** — algo que um atendente escreveu para outro atendente ver, nunca visível ao cliente | `.bubble-note` (bolha de nota no feed do Chat), marca d'água de "mensagem própria" (`--bubble-mine`), destaque geral da marca |
| Verde / vermelho | `--green` / `--red` | **Métrica positiva/negativa** — sucesso vs. falha, entregue vs. erro | Status de envio, KPIs de dashboard, badges de resultado |
| Azulado (`#78aadc`) | sem variável CSS própria ainda — hardcoded | **Sugestão de IA para o atendente** (Copiloto Comercial) — 3ª categoria semântica, deliberadamente distinta das outras duas | `.bubble-insight` (bolha de insight no feed do Chat), painel lateral de insights agrupados por tópico |

### Por que existe uma 3ª cor (azulada, adicionada em 2026-08-27)

Antes do Copiloto Comercial (Parte EW, `HANDOFF.md`), só existiam duas
categorias de cor semântica no Chat: dourado (humano) e verde/vermelho
(métrica). Ao introduzir o Copiloto — insights gerados por IA, visíveis
como bolha no feed, mas **de natureza diferente** de uma nota humana
(não é uma anotação livre, é uma sugestão estruturada com tópico/
confiança/ações) — usar dourado teria confundido "isto foi um humano que
escreveu" com "isto foi a IA que sugeriu". O `design-system-checker-agent`
revisou essa decisão explicitamente na sessão e confirmou: **nenhum
token existente servia para essa 3ª categoria** — cor nova era a escolha
certa, não um desvio do design system.

```css
/* public/chat.html — bolha de insight do Copiloto Comercial */
.bubble-insight{
  background: rgba(120,170,220,.08);
  border: 1px solid rgba(120,170,220,.25);
  border-left: 3px solid rgba(120,170,220,.6);
}
.bubble-insight-head svg,
.bubble-insight-topic,
.contact-insight-topic-label{ color:#78aadc; }
```

**Pendência de consistência conhecida**: essa cor ainda é um valor
hardcoded (`#78aadc` / `120,170,220`) espalhado em vários seletores, não
uma variável `--insight`/`--insight-rgb` no `:root` como as outras
cores semânticas. Baixo risco, escopo claro — considerar extrair para
variável CSS na próxima vez que o arquivo for tocado, para ficar
consistente com o resto da paleta (`--gold-rgb`, `--green-rgb`,
`--red-rgb`).

## 3. Tipografia

```css
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&display=swap" rel="stylesheet">
```

- **Inter** (sans-serif) — corpo de texto, UI geral (`body`, botões,
  labels, itens de navegação).
- **Fraunces** (serif, variável em `opsz`) — títulos e elementos de
  destaque: nome da marca na sidebar (`.logo-text .firm-name`), títulos
  de página (`.conv-pane-head h1`), títulos de modal (`.modal h3`),
  valor de KPI (`.painel-kpi-card .value`), títulos de painel
  (`.painel-panel h3`). O contraste serif/sans-serif é o principal
  sinal tipográfico de hierarquia no app — título "elegante", corpo
  "funcional".

## 4. Motion / interação

- **Hover em item de navegação**: ícone escala levemente
  (`.nav-item:hover .nav-icon{ transform: scale(1.16); }`) + muda de cor
  para `--gold`.
- **Barra de rolagem customizada**: reskin da scrollbar nativa com as
  cores do tema (`::-webkit-scrollbar-thumb`, hover em `--gold-dim`) em
  vez do cinza padrão do sistema operacional — aplicado globalmente,
  não só em elementos específicos.
- **Raio padrão de card/botão**: `--radius: 14px` (cards maiores),
  raios menores (~8-10px) em elementos internos como badges/tags/
  bolhas de insight.
- Para setas de rolagem customizadas (horizontal em tabelas largas,
  vertical em página longa), tooltip customizado, modal com ESC — ver
  as regras globais de design (`~/.claude/CLAUDE.md`), que valem para
  este projeto como para todos os outros do Daniel; não duplicadas
  aqui.

## 5. Customização por instância (`user_palette`)

A paleta acima é o **padrão**, mas não é fixa por código — é
sobrescrevível por usuário via `/settings.html`, persistida na tabela
`user_palette` (`owner_id` como chave, ver `src/settings.js`). O usuário
pode trocar `--gold`/`--gold-rgb`, `--green`/`--green-rgb`,
`--red`/`--red-rgb`, `--bg`, e os dois níveis de superfície
(`--surface`/`--surface-2`) — aplicado via `document.documentElement.
style.setProperty(...)` no boot de cada página, com cache local para não
piscar a cor padrão antes do valor real carregar (ver `cachedSurface`/
`cachedSurface2` no bootstrap de `chat.html`).

Também existe uma camada **de instalação inteira** (não por usuário) via
`.env`: `BRAND_NAME`/`BRAND_SUBTITLE`/`BRAND_COLOR` sobrescrevem o nome/
subtítulo/cor de destaque exibidos nas 8 páginas com sidebar, pensada
para reaproveitar o mesmo código para outro cliente sem editar HTML (ver
`GET /api/brand` em `src/server.js`). `accent_color` de `user_palette`
tem prioridade sobre `BRAND_COLOR` do `.env` quando preenchido.
