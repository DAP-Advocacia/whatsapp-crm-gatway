const instanceHealthStore = require('./instanceHealthStore');

/**
 * Regra de "instância banida" num só lugar — usada tanto por
 * GET /instances (categoria visual "Banida" na aba Instâncias) quanto
 * pelo poller de aviso (src/instanceBanPoller.js), garantindo que os
 * dois nunca divirjam sobre o que conta como banida.
 *
 * Critério original (1ª versão desta feature): "1 janela de `forbidden`
 * ABERTA há mais de 24h contínuas". CORRIGIDO depois de testar contra
 * produção real: o Baileys tenta reconectar sozinho e falha de novo com
 * `forbidden`, fazendo o evento fechar e REABRIR repetidamente — a
 * instância real do usuário nunca acumulou mais que ~19-22h numa única
 * janela contínua, mesmo estando banida de verdade (confirmado pelo
 * próprio WhatsApp Business, "Conta em análise"). Com o critério
 * original, ela NUNCA apareceria como "Banida".
 *
 * Critério atual (confirmado com o usuário, 2ª correção): soma o tempo
 * TOTAL em `forbidden` (ver PERMANENT_CODES, src/whatsapp.js) olhando
 * pra trás 24h — cobre as 2 formas reais já observadas em produção:
 * (1) 1 janela única aberta há muito tempo, nunca reaberta (típico de
 * instância ÓRFÃ — 3 casos reais somando 27h a 145h numa única janela);
 * (2) múltiplas janelas curtas se sobrepondo, o Baileys tentando
 * reconectar sozinho e falhando de novo com o mesmo motivo (a instância
 * real do usuário: 5 janelas somando ~22h, nenhuma isolada passou de
 * ~19.5h contínuas). Por isso o critério é só o TEMPO TOTAL — não exige
 * um número mínimo de janelas (1ª tentativa desta correção exigia 2+,
 * o que excluía incorretamente as órfãs de janela única). `windowCount`
 * ainda vai junto no retorno, só como contexto pro log/aviso (ex:
 * "5 tentativas de reconexão falhas"), nunca como trava.
 *
 * Limiar de tempo um pouco abaixo de 24h cheias (20h) porque, no
 * padrão intermitente, dificilmente a soma bate exatamente 24h — dado
 * real observado: instâncias genuinamente banidas por reconexão
 * intermitente somaram entre ~20h e ~22h dentro do período de 24h.
 *
 * Sem coluna nova em `instances` — calculado na hora a partir de
 * `instance_connection_events` (decisão confirmada: se a instância
 * reconectar de verdade e ficar estável, a soma cai naturalmente com o
 * tempo, sem precisar de nenhum passo de "destravar" manual).
 */

const LOOKBACK_MS = 24 * 60 * 60 * 1000; // olha as últimas 24h
const MIN_TOTAL_MS = 20 * 60 * 60 * 1000; // soma mínima nesse período pra contar como banida

// Todas as instâncias com atividade de 'forbidden' persistente o
// bastante pra contar como banida agora — cada linha tem
// { instanceId, windowCount, totalMs }.
async function listBannedNow() {
  const rows = await instanceHealthStore.sumAttentionDuration(['forbidden'], LOOKBACK_MS);
  return rows.filter((r) => r.totalMs >= MIN_TOTAL_MS);
}

module.exports = { listBannedNow, LOOKBACK_MS, MIN_TOTAL_MS };
