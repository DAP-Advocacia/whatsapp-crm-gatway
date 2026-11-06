# Painel de auditoria (`/painel`)

Painel fora do Bitrix, com login e senha próprios, para auditar quem está com o DapZap conectado,
por equipe, e avisar o gestor quando alguém desconecta.

URL: `https://whatsapp.bmdholding.com.br/painel`

## Colocar no ar (ordem)

1. **Criar as tabelas** (SQL avulso, só tabelas novas — não mexe nas existentes):
   `set lock_timeout = '3s';` e depois o conteúdo de `db/painel.sql`, no Supabase.
   Sem isso o resto do DapZap funciona normal; o painel só mostra "tabelas não criadas".
2. **Deploy** do código (push não dispara deploy).
3. **Criar o usuário** no servidor: `node scripts/panel-user.js <login> "Nome"`.
   A senha é gerada e mostrada uma vez (a pessoa troca no painel, em Configurações).
4. Entrar, conferir **Equipes** e **Regras de gestor**, e só então ligar o monitor.

Não precisa de variável nova: o cookie de sessão é assinado com `AUTH_TOKEN_SECRET`
(ou `PANEL_TOKEN_SECRET`, se quiser um segredo só do painel). Outras variáveis opcionais:
`PANEL_SESSION_HOURS` (8), `MONITOR_BOOT_QUIET_MIN` (60), `TEAM_DIRECTORY_TTL_MS` (10 min).

## O que tem

| Aba | Para quê |
|---|---|
| Visão geral | Total de colaboradores, números, instâncias; conectados/offline/etc.; equipes com mais gente sem conexão |
| Equipes | Uma linha por gestor que recebe o alerta, com barra de situação; clique abre as pessoas; exporta a equipe |
| Pessoas | Todas, com busca e filtros (situação, departamento, equipe); seleção para notificar; exporta Excel/CSV |
| Alertas | Tudo que o monitor enviou ou deixou de enviar (inclusive "simulado") |
| Regras de gestor | Quem recebe o alerta de quem |
| Notificar | Disparo manual (por filtro ou seleção) e resumo aos gestores |
| Configurações | Liga/desliga o monitor, espera, resumo diário, troca de senha, histórico do painel |

Situações: **Conectado**, **Offline (caiu)** (sessão carregada e fora do ar), **Não verificado**
(já conectou, mas a sessão não está carregada porque a pessoa não abriu o DapZap desde o último
deploy — *não dá para afirmar que desconectou*), **Nunca conectou**, **Sem instância**.

## Quem recebe o alerta

Ordem: regra da **pessoa** → regra do **departamento** → gestor do perfil no Bitrix
(`[GER]` → `[DIR]` → chefe do departamento). Ninguém recebe o alerta de si mesmo.
Para a equipe da Carol: regra do departamento "Vendas Carol" → Carol. Aí a vendedora da gerente
avisa a Carol, e não a gerente.

## Monitor de desconexões

Padrão **desligado**: tudo é registrado como "simulado" em Alertas, sem enviar nada.
Ao ligar, só eventos *a partir daquele momento* avisam.

- **Na hora:** desvinculou o aparelho no celular; removeu a conexão no DapZap; outro aparelho assumiu.
- **Com espera** (30 min, configurável): caiu e não voltou sozinho.
- **Nunca avisa:** quem nunca conectou; pessoa fora do cadastro ativo do Bitrix; recusa do WhatsApp
  (403, é banimento — já tem o alerta próprio); quedas nos 60 min seguintes a um deploy/reinício de
  worker; o mesmo evento duas vezes.
- **Resumo diário** (opcional): cada gestor recebe a lista de quem, na equipe dele, está sem DapZap.

### Limite conhecido

Com `SESSION_BOOT_MODE=lazy` a sessão só é conferida depois que a pessoa abre o DapZap. Quem
desvincula o aparelho e não abre o app só é detectado quando a sessão voltar a subir.

**Decisão (2026-11-06):** produção passou para `SESSION_BOOT_MODE=all`. Com o WhatsApp liberado na
rede, ninguém abre o DapZap só para reconectar; com as sessões sempre ligadas o monitor enxerga a
queda na hora. O custo é o tempo de recuperação a cada deploy/reinício (ver `DEPLOY.md`, seção 4.1).
Sessão **deslogada** (401) não volta sozinha: continua exigindo QR Code, e o caminho para essas é o
alerta ao gestor. Ligue o monitor em Configurações só depois que o boot terminar.

## Acesso dos diretores (painel dentro do Bitrix)

Além do login `gabriel` (admin, vê tudo), o painel abre **dentro do Bitrix** para CEO e diretores, sem
criar conta: `https://whatsapp.bmdholding.com.br/painel/app`. O Bitrix identifica a pessoa (OAuth do
BX24), o servidor confirma o usuário no próprio Bitrix e calcula o que ela pode ver.

- **Regra:** quem chefia (`UF_HEAD`) um departamento marcado `[CEO]` ou `[DIR]` vê as pessoas desse
  departamento **e de todos abaixo**. `[GER]` fica de fora por enquanto (decisão de 06/11/2026).
- **O que o diretor vê:** só a aba **Equipes** (cada equipe e cada pessoa expandem, com número por número),
  e exporta Excel/CSV só da própria equipe. Não vê Visão geral, Alertas, Regras, Notificar nem
  Configurações. O filtro é **no servidor**: as outras rotas respondem 403 e os totais da base
  (números repetidos, órfãos) não são enviados.
- **Auxiliares/adjuntos e exceções:** o "supervisor adjunto" não existe na API do Bitrix, então entra na
  tabela `panel_access_grants` (aba *Regras de gestor* → *Acesso por hierarquia*, só admin). A pessoa passa
  a ver o departamento escolhido e todos abaixo. Criar a tabela: `db/painel_acesso.sql` (já traz Thais Maia →
  Ana Caroline, Monalisa Figueiredo → Adriano, e Lorena Pontes tratada como diretora da equipe do Adriano).
  Sem a tabela vale só a regra do chefe do departamento.
- **Cortar acesso:** sair do cargo de chefe no Bitrix, ser desativado ou bloqueado no Admin do DapZap
  corta o acesso (conferido a cada requisição, cache de até 10 min na árvore de departamentos).
- **Cadastrar no Bitrix:** o app precisa de um item de menu/placement apontando para `/painel/app`
  (a página só pode ser enquadrada pelo portal `BITRIX_PORTAL_DOMAIN`).

## Segurança

Senha com hash scrypt; cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` em HTTPS) restrito a
`/api/panel`; cabeçalho `X-Panel-CSRF` obrigatório em toda escrita; 5 erros bloqueiam IP e usuário
por 15 min; a página recusa `iframe`; disparos limitados a 10 a cada 10 min por usuário; tudo que
muda algo grava em `panel_audit`. O painel só **lê** o estado das sessões — não inicia, reconecta nem
apaga nenhuma.
