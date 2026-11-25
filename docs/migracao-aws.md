# Migração do DapZap para a AWS (sa-east-1)

Rascunho de 05/11/2026. Só planejamento: nada aqui foi executado. Onde um número é medido, diz a fonte; onde é estimativa ou ainda precisa ser verificado, está marcado como **[estimativa]** ou **[verificar]**. Preços **não foram cotados**.

> **Atualização de 11/11/2026 (decisão pendente com o Bruno):** steal de CPU medido de 03 a 11/11 (sar, tabela do Elder): média diária de 3,8 % a 14,0 %
> (pico de 47,1 % em 04/11 às 20:10), sem padrão de horário (em 10/11: 10,5 % de dia e 10,6 % de madrugada; a faixa "15–27 % em dia útil contra 1–5 % de madrugada" anotada antes não se confirmou), com a VM 60–75 % ociosa, ou seja, vem do host. O gateway usa ~1,5 de 8 núcleos em horário comercial; o
> dimensionamento da seção 4 (16 vCPU) veio do pico de reconexão em massa e deve ser revisto (8 vCPU dedicados provavelmente bastam; não cotado).
> As mortes de worker de 11/11 são estouro de heap (615 MB a 4 GB em 5 min) e a migração, sozinha, não as corrige (ver `docs/arquitetura-workers.md`,
> "Quedas em cascata"). Recomendação: corrigir o heap primeiro, pedir troca de nó à Hostinger (Elder) e reavaliar em 7 dias; migrar se ainda morrer
> 1 ou mais workers por dia útil com steal acima de 20 %. Referência de preço, não cotação: `c7a.4xlarge` US$ 0,821/h (~US$ 600/mês), região não confirmada.
> Produção hoje: `SESSION_WORKERS=6`, `WORKER_HEAP_MB=4096`, `SESSION_BOOT_MODE=all` (a seção 2 descreve 4 e 7168).

## 1. Por que migrar

O gargalo hoje é CPU, não banco nem rede.

| Medição (05/11/2026) | Valor |
|---|---|
| VPS atual | Hostinger KVM 8, Campinas, 8 vCPU (AMD EPYC 9354P), 32 GB, disco 387 GB (35 GB usados) |
| Steal de CPU (CPU que o host tira da VM) | 21% a 43% durante o dia; já foi de 24% a 58% em dias anteriores |
| CPU do container do gateway | média ~310% (faixa 177% a 552%) em 1 min medido pelo cgroup, num momento de reconexão em massa. O painel do EasyPanel chegou a mostrar 1407%, número distorcido (o teto real é 800%) |
| Memória dos workers | até 6,4 GB cada antes do reinício; voltam a crescer de ~200 MB para 2,3 GB em 34 min |
| Estouros de memória (OOM) | 6 em 6 h (04/11) |
| Envios que estouram o tempo (2 min) | ~80 por hora antes do deploy do meio-dia |
| Quedas de sessão online | ~1.000 em 3 h (04/11) |

A Hostinger confirmou o steal e não tem vaga para migrar dentro do Brasil. Reinstalar nos EUA foi descartado (latência e risco de ban por troca de região).

**O que a migração resolve:** o steal (CPU dedicada) e dá espaço para dimensionar com folga.
**O que ela não resolve sozinha:** o crescimento de memória dos workers e o consumo de CPU do Node (uma thread por worker). Esses dois continuam sendo trabalho de código (ver `docs/backlog.md`).

## 2. Como o sistema está hoje (levantado na VPS, só leitura)

- Orquestração: Docker Swarm gerenciado pelo EasyPanel, com Traefik na frente. Serviços na VPS: `whatsapp-gateway_gateway`, `bidap_bi`, `easypanel`, `easypanel-traefik`. **A VPS não roda só o gateway** (ver 7, item 1).
- Gateway: 1 container com 1 processo principal e 4 workers de sessão (`SESSION_WORKERS=4`, `WORKER_HEAP_MB=7168`, `SESSION_BOOT_MODE=lazy`, `DB_POOL_MAX=20`).
- **Sessões do WhatsApp:** pasta `/srv/whatsapp-gateway-data/auth_session` no host (bind mount para `/app/auth_session`). Tem **2.110 pastas de sessão**, cada uma com milhares de arquivos pequenos (exemplo medido: 2.358, 2.553 e 6.358 arquivos; a maioria é mapeamento `lid-*`). Ou seja, são **milhões de arquivos pequenos**. O tamanho total em GB **[verificar]** (`du` não terminou em tempo hábil; rodar fora do pico).
- Banco: Supabase (Postgres), acessado por `DATABASE_URL` / `DIRECT_URL`. Na data deste rascunho foi trocado para o plano Large. Região do projeto Supabase **[verificar]**.
- Integrações de saída: Bitrix24 (webhooks), OpenAI. De entrada: Bitrix → `PUBLIC_URL`.
- Variáveis de ambiente (só nomes): `ADRIANO_CAMPAIGN_SESSION_ID`, `ALLOWED_ORIGINS`, `AUTH_FOLDER`, `AUTH_TOKEN_SECRET`, `AUTH_TOKEN_TTL_HOURS`, `BITRIX_FEED_WEBHOOK_URL`, `BITRIX_HR_WEBHOOK_URL`, `BITRIX_LEADS_CATEGORY_ID`, `BITRIX_MEMBER_ID`, `BITRIX_PORTAL_DOMAIN`, `BITRIX_WEBHOOK_URL`, `DATABASE_URL`, `DB_POOL_MAX`, `DEAL_GROUP_TRIGGER_TOKEN`, `DIRECT_URL`, `NODE_ENV`, `NODE_OPTIONS`, `OFFICE_OWNER_PHONE`, `OPENAI_API_KEY`, `PAIRING_MIN_GAP_MS`, `PORT`, `PUBLIC_URL`, `SESSION_BOOT_MODE`, `SESSION_STAGGER_MS`, `SESSION_WORKERS`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SUPER_ADMIN_OWNER_IDS`, `VERIFICATION_SECTOR_PHONE`, `WORKER_HEAP_MB`. Os valores ficam no EasyPanel e **não devem ser copiados para este documento nem para o repositório**.
- Dockerfile: `node:22-bookworm-slim`, porta 3333, sem dependência de sistema além de `ca-certificates` (o ffmpeg vem do `ffmpeg-static`). Portável sem mudança.

## 3. Risco principal: o IP muda

Todas as sessões passam a conectar ao WhatsApp a partir de um IP novo, de datacenter diferente.

- Houve **ban em massa em 31/07 e 03/08**. A causa registrada foi abertura de muitas sessões em rajada; por isso o intervalo de **5 s entre logins não pode ser reduzido** (`PAIRING_MIN_GAP_MS`, `SESSION_STAGGER_MS`). Mantém igual na AWS.
- Não sei se o WhatsApp trata a troca de IP de ~570 sessões ao mesmo tempo como anômala. **Não há como testar isso sem risco real.** Por isso a migração deve ser **em ondas**, não de uma vez (seção 6).
- Usar **Elastic IP** (fixo) na AWS, para o IP não mudar de novo em reinícios.
- **Nunca** deixar a mesma sessão rodando nos dois servidores ao mesmo tempo: o WhatsApp derruba uma delas (`connectionReplaced` / 440) e brigar por isso é risco de ban.

## 4. Dimensionamento

Base: a carga medida hoje (4 workers ocupando de 3 a 5,5 núcleos efetivos, mais o processo principal) numa máquina que perde 21% a 43% para o steal, mais folga para pico e para crescimento. As famílias de instância abaixo são **candidatas a conferir** no console da AWS (tipo, vCPU e memória exatos podem ter mudado), não uma recomendação fechada.

### Cenário A: só o gateway (os ~570 números, como hoje)

| Item | Proposta **[estimativa]** |
|---|---|
| Computação | 16 vCPU dedicados, 32 GB de RAM, família otimizada para CPU (classe "c" de geração recente). Mesma quantidade de memória de hoje, mas sem steal |
| Disco | EBS gp3, 200 GB (hoje 35 GB usados; milhões de arquivos pequenos pedem IOPS, não tamanho) |
| Rede | 1 Elastic IP; saída de dados baixa (hoje ~9 GB acumulados no container) |
| Backup | Snapshot diário do volume das sessões **[verificar]** custo/retenção |
| Banco | Supabase continua fora da AWS (ver 7, item 2) |

Com CPU dedicada, 4 workers com 7 GB cada continuam sendo teto de 28 GB: **não subir o heap**; o plano é diminuir para 6 GB por worker até entendermos o crescimento de memória.

### Cenário B: gateway + chamadas de voz (150 a 200 simultâneas)

Base: **uma única chamada medida** em Docker no Windows, com os registros de log de pacote ligados (ver `project-teste-chamadas-voz` na memória): CPU média 7% (pico 9,2%) de um núcleo, ~150 MB, ~320 kbps por sentido. **[estimativa]** para 200 chamadas: ~14 núcleos para as chamadas, mais folga de pico, ou seja **20 a 24 vCPU dedicados** só para chamadas, ~64 Mbps de rede por sentido e processos Node separados (um satura perto de 14 chamadas; usar 8 a 10 por processo).

- As chamadas devem rodar em **instâncias separadas do gateway**, para uma chamada pesada não atrasar mensagens e uma queda do gateway não derrubar chamadas.
- Só a mídia (codec, SRTP, WebRTC) pode ir para fora; a sinalização da chamada passa pelo socket Baileys da sessão e fica no worker dessa sessão.
- O codec MLow é um binário sem fonte conhecida: deve rodar em contêiner próprio, **sem acesso à pasta de sessões nem às variáveis de ambiente**.
- Liberar o tráfego UDP de saída (WebRTC) no security group.
- Nenhuma compra para chamadas antes de **medir várias chamadas simultâneas** (precisa de mais chips de teste).

### O que cotar
Instância (sob demanda, Savings Plan de 1 ano e Reserved), EBS gp3 e snapshots, Elastic IP, tráfego de saída, e o custo do Supabase Large já contratado. Resultado: tabela comparativa mensal para a diretoria.

## 5. Preparação (sem tocar na produção)

1. **Inventário completo** da VPS: o que mais roda além do gateway (`bidap_bi`) e se deve migrar junto ou ficar. Dono de cada serviço.
2. Medir o tamanho real das sessões (`du`) e testar o tempo de cópia, fora do pico.
3. Subir a AWS **vazia** na sa-east-1: VPC, security groups (80/443 de entrada; SSH só do IP do escritório), Elastic IP, EBS, Docker + EasyPanel (ou Swarm) instalados.
4. Ver restrições de IP: Supabase (network restrictions) e Bitrix (webhooks com lista de IPs permitidos) **[verificar]**. Se existirem, incluir o IP novo antes da migração.
5. Baixar o TTL do DNS de `whatsapp.bmdholding.com.br` (ex.: 60 s) 24 h antes.
6. Rodar a AWS como **homologação**: mesma imagem, banco de teste, uma sessão de teste. Confirmar o login do Baileys a partir do IP novo.
7. Ensaio de cópia: mover uma cópia da pasta de sessões para a AWS **sem iniciar nenhuma sessão** (só para medir tempo e integridade).

## 6. Execução em ondas

Princípio: **parar na Hostinger antes de iniciar na AWS**, sessão por sessão (ou grupo por grupo), nunca as duas ao mesmo tempo.

1. **Onda 0 (piloto):** 5 a 10 sessões de teste ou de vendedores que aceitem o risco. Hoje **não existe** um jeito de dizer ao gateway "não inicie estas sessões" na Hostinger enquanto o resto roda: precisa de uma lista de exclusão (variável de ambiente), pequena de implementar **[a fazer no código]**.
2. Observar 48 h: quedas por código, 440, 403, bans, tempo de envio.
3. **Ondas seguintes:** 10% do total por onda, fora do pico (início da noite ou fim de semana), mantendo os 5 s entre logins. Cada onda só começa se a anterior tiver 0 ban e quedas iguais ou menores que a linha de base.
4. Copiar as pastas das sessões da onda com a sessão **parada** na origem (a chave do Baileys muda com o uso; cópia de sessão em uso pode corromper). Para milhões de arquivos pequenos, usar `tar` em fluxo com compressão ou `rsync` em lotes, não cópia arquivo a arquivo.
5. **Corte final:** quando todas as ondas estiverem na AWS, trocar o DNS, manter a Hostinger parada (não apagada) por 14 dias.

### Reversão
- Antes de qualquer sessão rodar na AWS: voltar é só religar na Hostinger (nada mudou).
- **Depois** que a sessão rodou na AWS, as chaves dela mudam. Para voltar, é preciso copiar a pasta da AWS de volta para a Hostinger com a sessão parada, nunca religar a cópia velha (ela está desatualizada e o WhatsApp pode recusar).
- Manter backup da pasta original antes de cada onda.

## 7. Questões em aberto (precisam de decisão ou verificação)

1. **`bidap_bi` e o EasyPanel:** o que mais está na VPS e quem depende dele.
2. **Onde está o Supabase.** Se estiver em São Paulo, a latência a partir da AWS sa-east-1 fica igual ou melhor. Se estiver em outra região, medir antes: o gateway faz muitas consultas por mensagem.
3. **Contrato da Hostinger:** prazo restante e se cabe reembolso ou troca de plano. Sugestão: manter como homologação/contingência até o fim da migração.
4. **Lista de exclusão de sessões** na origem (item 6.1).
5. **Chave da OpenAI:** o resumo com IA foi desligado em 05/11. A variável `OPENAI_API_KEY` existe no serviço (164 caracteres), mas ainda aparecem erros de "chave não configurada" nos módulos `dapinho` e `team-insights`. Nos workers a variável não aparece no ambiente do processo. Não é bloqueio da migração, mas deve ser esclarecido antes de copiar as variáveis para a AWS.
6. **Quem opera a AWS** (conta, acessos, alertas, custo) e quem aprova o gasto.
7. **Aceite do risco de ban** pela diretoria, com o plano em ondas como mitigação.

## 8. Critérios para considerar a migração bem-sucedida

Comparar com a linha de base da seção 1, no mesmo horário de uso:
- Steal de CPU próximo de 0.
- Envios estourando o tempo: de ~80 por hora para perto de 0.
- Quedas de sessões online por hora: pelo menos pela metade.
- Nenhum worker estourando memória em 7 dias seguidos.
- 0 bans nas ondas.

## 9. Cronograma **[estimativa]**

| Fase | Duração |
|---|---|
| Inventário, cotação e decisão (seções 5.1 a 5.4, 7) | 3 a 5 dias |
| AWS vazia + homologação + ensaio de cópia | 3 a 4 dias |
| Lista de exclusão de sessões no código | 1 dia |
| Piloto + observação | 3 dias |
| Ondas (10 ondas, uma por noite fora do pico) | 2 semanas |
| Contingência na Hostinger | 14 dias após o corte |

Total até o corte: cerca de **4 semanas**, se não houver ban no piloto.
