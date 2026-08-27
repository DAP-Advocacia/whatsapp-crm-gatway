# QA Checklist — WhatsApp ↔ Bitrix24 Gateway

> Este projeto é **Node/CommonJS puro, sem suíte de testes automatizados
> formal** — não há Jest/Mocha/Vitest no `package.json` (só `nodemon`
> como devDependency, para o modo `npm run dev`). A verificação real
> usada nas últimas sessões (documentada em dezenas de entradas do
> `HANDOFF.md`, ex: Partes EU/EV/EW) segue o padrão abaixo. Não é uma
> aspiração — é literalmente o que já foi executado e funcionou como
> rede de segurança em produção até aqui.

## 1. Sintaxe — sempre, em todo arquivo tocado

```bash
node -c src/arquivo.js
```

`node -c` (ou `node --check`) valida sintaxe sem executar o módulo — não
pega erro de runtime (`ReferenceError`, dependência faltando), só erro de
parse. Rodar em **todo** arquivo `.js` alterado antes de considerar a
mudança pronta.

## 2. Blocos `<script>` inline nas páginas HTML

As 8+ páginas de `public/` (`chat.html`, `agente-ia.html`,
`instances.html`, `admin.html`, etc.) têm o JS do frontend embutido
direto no HTML, não em arquivo `.js` separado — `node -c` não alcança
esse código. Duas formas equivalentes já usadas, dependendo da sessão:

```js
// Opção A — extrai o texto de cada <script>...</script> do HTML e roda
// via new Function(), que faz o parse sem executar de fato (ok para
// pegar erro de sintaxe; NÃO detecta ReferenceError de variável não
// definida em runtime — isso só aparece rodando de verdade no navegador,
// ver HANDOFF, incidente de revealAdminNavItemIfSuperAdmin()).
const fs = require('fs');
const html = fs.readFileSync('public/chat.html', 'utf-8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
scripts.forEach((m, i) => {
  try { new Function(m[1]); console.log(`script ${i}: OK`); }
  catch (e) { console.error(`script ${i}: ${e.message}`); }
});
```

```js
// Opção B — mesmo objetivo via módulo nativo `vm` (usado em sessões que
// tocaram muitas páginas de uma vez, ex: 13-15 telas na mesma leva).
const vm = require('vm');
new vm.Script(scriptContent); // lança SyntaxError se inválido
```

**Limitação conhecida das duas**: nenhuma pega erro que só existe em
runtime (variável não definida, `undefined` chamando `.method()`) — só
erro de sintaxe. Para esse tipo de bug, só checagem visual/Playwright
contra produção real resolve (ver §4).

## 3. Lógica isolada — harness de extração de função via regex

Para validar uma função específica (não o arquivo inteiro, que pode ter
dependências como `pg`/`express` não instaladas no ambiente de execução
do teste) sem montar um projeto de teste completo, o padrão usado nas
Partes EU/EV/EW (Agente de IA, grupo automático, Copiloto Comercial) é:

1. Ler o arquivo-fonte real (`fs.readFileSync`).
2. Extrair o corpo de uma função específica via regex (ex: a função
   `shouldGenerate` inteira, do `function shouldGenerate(...) {` até o
   fechamento correspondente).
3. Rodar esse corpo via `new Function(...)`, injetando manualmente as
   dependências que a função espera (ex: um objeto `deps` fake no lugar
   do módulo `pg`/`db` real) — sem precisar `pg`/`express` instalados de
   verdade no ambiente do teste.
4. Escrever asserções manuais (`assert.strictEqual`/comparação direta),
   contando quantas passaram/falharam.

Exemplo real (Parte EW, Copiloto Comercial): `shouldGenerate` (5
asserções — sem estado, dentro/fora da janela de anti-flood de 60s,
mensagem repetida/nova), `parseInsightsResponse` (10 asserções — JSON
vazio/inválido/sem campo, trim, tópico fora da lista descartado,
confidence inválido vira `null`, múltiplos insights),
`commercialConfig.upsert` (12 asserções — patch parcial preserva campo
não tocado, `enabled:false` explícito não vira "ausente", serialização
de `topics` jsonb), `loadOwnedInsight` (7 asserções — bloqueia posse
cruzada, nunca vaza o `body` alheio na resposta de erro, distingue 404
de 403, caminho feliz).

**Onde rodar**: sempre via um script temporário no diretório de
scratchpad da sessão (nunca commitado no repositório) — o harness em si
é descartável, só o resultado (passou/falhou) importa para a sessão.

```bash
node caminho/para/harness-temporario.js
```

## 4. Schema — aplicar/validar `db/schema.sql`

```bash
node db/migrate.js
```

Lê `db/schema.sql` inteiro e aplica contra `DIRECT_URL` (pooler de
**sessão** do Supabase — não `DATABASE_URL`/pgbouncer, que não suporta
bem múltiplos statements/DDL na mesma conexão). Todo `create table`
usa `if not exists` e toda coluna nova usa `alter table ... add column
if not exists` — o schema inteiro é idempotente, seguro de rodar de novo
a qualquer momento sem duplicar nada.

**Quando o MCP do Supabase não tem acesso ao projeto de produção**
(cenário real, Parte EW, 2026-08-27): o token MCP disponível só enxerga
a organização errada, sem acesso ao banco real do gateway. Nesse caso, a
validação do DDL fica só em **revisão estática cuidadosa do SQL**
(conferir sintaxe, tipos, FKs, defaults manualmente) — `db/migrate.js`
aplica de verdade no próximo deploy normal na VPS, como sempre.

## 5. Teste end-to-end contra produção (quando necessário)

Para mudanças que dependem de comportamento real do WhatsApp/Bitrix
(status de mensagem, criação de negócio, upload de mídia), algumas
sessões subiram um **servidor de teste isolado numa porta separada**
(ex: `3399`, nunca a instância real na `3333`) para testar contra
produção sem afetar tráfego real.

## 6. Antes de considerar uma feature de UI pronta

Regra global do Daniel (`CLAUDE.md`), não específica deste projeto:
toda UI nova ou alterada passa pelo `design-system-checker-agent` antes
de ser dada como pronta; toda mudança sensível de segurança passa pelo
`security-reviewer-agent` antes do commit. Ambos rodaram na feature mais
recente (Copiloto Comercial, Parte EW) e encontraram achados reais —
ver `SECURITY.md` §3 para o que foi corrigido.

## 7. O que este checklist **não** cobre (limitação honesta)

- Nenhum teste automatizado roda em CI hoje (não existe
  `.github/workflows/` neste projeto ainda — pendência de documentação
  estrutural, fora do escopo desta sessão).
- `node -c`/`vm.Script`/harness de função isolada não substituem teste
  real contra WhatsApp/Bitrix em produção — várias features recentes
  (Agente de IA, grupo automático do Agente de IA, Copiloto Comercial)
  estão marcadas no `HANDOFF.md`/`ROADMAP.md` como "não testadas com
  WhatsApp real ainda" mesmo depois de passar por todo este checklist.
