/**
 * Correção retroativa das conversas antigas salvas com o LID cru do
 * WhatsApp no lugar do telefone real (bug corrigido em _resolveLidPhone,
 * ver HANDOFF Parte CP). Escopo desta rodada: só as 531 conversas já
 * resolvidas nas 3 instâncias que estavam online (..._142498,
 * ..._999__msq741im7l6y, ..._183168) — não as 5.471 totais.
 *
 * Lê o mapeamento LID->telefone real de /tmp/resolve-lid-results.json
 * (gerado via as rotas de diagnóstico, GET/POST /admin/diagnostics/*).
 *
 * Dois casos, por conversa:
 *   1. UPDATE SIMPLES (500 casos): o telefone real ainda não existe como
 *      conversa separada na mesma sessão — troca conversations.phone
 *      direto, sem risco de colisão.
 *   2. MERGE (31 casos): o telefone real já existe como conversa
 *      separada, com mensagens reais nos dois lados (o mesmo backfill de
 *      histórico rodou duas vezes, uma resolvendo certo, outra errado —
 *      confirmado: MUITAS mensagens já são cópia idêntica, mesmo
 *      wa_message_id nos dois lados). Regras confirmadas com o usuário:
 *        - Move só as mensagens da conversa-LID cujo wa_message_id NÃO
 *          existe já na conversa-real (evita duplicata) — descarta o
 *          resto.
 *        - push_name da conversa-real fica com o nome mais recente entre
 *          os dois lados (nunca havia nome do lado LID nos 31 casos
 *          medidos, mas o código trata o caso geral mesmo assim).
 *        - conversation_summaries: mantém só o resumo de IA mais recente
 *          entre os dois lados, apaga os demais (resumos duplicados
 *          eram gerados a partir de histórico incompleto — o próprio
 *          bug).
 *        - conversation_tags/conversation_assignment_history: migra pra
 *          conversa-real (união, sem duplicar — tags já são
 *          PRIMARY KEY(conversation_id, tag_id), então mover é seguro).
 *        - Ao final, apaga a conversa-LID (cascade cuida do que
 *          sobrar, mas não deveria sobrar messages/summaries — só a
 *          própria linha de conversations).
 *
 * USO:
 *   node scripts/fix-lid-phones.js --dry-run   # só reporta o que faria, não escreve nada
 *   node scripts/fix-lid-phones.js --apply     # aplica de verdade, dentro de uma transação
 *
 * Sempre roda dentro de UMA transação (BEGIN/COMMIT) — se qualquer coisa
 * falhar no meio, ROLLBACK completo, nunca fica em estado parcial.
 */
require('dotenv').config();
const { pool } = require('../src/db');
const fs = require('fs');

const RESULTS_PATH = process.env.FIX_LID_RESULTS_PATH || '/tmp/resolve-lid-results.json';

async function run() {
  const isDryRun = !process.argv.includes('--apply');
  console.log(isDryRun ? '=== DRY RUN (nada será escrito) ===' : '=== APLICANDO DE VERDADE ===');

  const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));

  const client = await pool.connect();
  let simpleUpdates = 0;
  let merges = 0;
  let messagesDiscarded = 0;
  let messagesMigrated = 0;
  let summariesDeleted = 0;

  try {
    await client.query('BEGIN');

    for (const [sessionId, mapping] of Object.entries(results)) {
      for (const [lidPhone, realPhone] of Object.entries(mapping)) {
        if (!realPhone) continue; // não resolvido, pula

        const { rows: lidConvRows } = await client.query(
          `select id from conversations where session_id = $1 and phone = $2`,
          [sessionId, lidPhone]
        );
        if (lidConvRows.length === 0) continue; // já não existe mais (rodou 2x?)
        const lidConvId = lidConvRows[0].id;

        const { rows: realConvRows } = await client.query(
          `select id, push_name from conversations where session_id = $1 and phone = $2`,
          [sessionId, realPhone]
        );

        if (realConvRows.length === 0) {
          // Caso 1: update simples
          console.log(`[SIMPLES] sessão=${sessionId} conv=${lidConvId}: ${lidPhone} -> ${realPhone}`);
          if (!isDryRun) {
            await client.query(`update conversations set phone = $1, updated_at = now() where id = $2`, [realPhone, lidConvId]);
          }
          simpleUpdates++;
          continue;
        }

        // Caso 2: merge
        const realConvId = realConvRows[0].id;
        console.log(`[MERGE] sessão=${sessionId}: LID conv=${lidConvId} (${lidPhone}) -> conv real=${realConvId} (${realPhone})`);

        // Mensagens: migra só as que NÃO colidem por wa_message_id
        const { rows: toMigrate } = await client.query(
          `select m.id from messages m
           where m.conversation_id = $1
             and (m.wa_message_id is null or not exists (
               select 1 from messages r where r.conversation_id = $2 and r.wa_message_id = m.wa_message_id
             ))`,
          [lidConvId, realConvId]
        );
        const { rows: toDiscard } = await client.query(
          `select count(*) from messages m
           where m.conversation_id = $1
             and m.wa_message_id is not null
             and exists (select 1 from messages r where r.conversation_id = $2 and r.wa_message_id = m.wa_message_id)`,
          [lidConvId, realConvId]
        );
        console.log(`  mensagens a migrar: ${toMigrate.length}, descartadas (já duplicadas): ${toDiscard[0].count}`);
        messagesMigrated += toMigrate.length;
        messagesDiscarded += Number(toDiscard[0].count);

        if (!isDryRun && toMigrate.length > 0) {
          const ids = toMigrate.map((r) => r.id);
          await client.query(`update messages set conversation_id = $1 where id = any($2::bigint[])`, [realConvId, ids]);
        }

        // A partir daqui, os SELECTs de simulação rodam SEMPRE (dry-run
        // também) — só os INSERT/UPDATE/DELETE ficam atrás de isDryRun.
        // Isso corrige uma lacuna real: antes, tags/histórico/resumos só
        // eram calculados E reportados dentro do --apply, então o --dry-run
        // nunca mostrava essa parte do que ia acontecer.

        // push_name mais recente: compara updated_at das duas conversations originais
        const { rows: bothConvs } = await client.query(
          `select id, push_name, updated_at from conversations where id = any($1::bigint[])`,
          [[lidConvId, realConvId]]
        );
        const newest = bothConvs.filter((c) => c.push_name).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
        if (newest && newest.id !== realConvId) {
          console.log(`  push_name: assume "${newest.push_name}" (vinha da conversa ${newest.id})`);
        }
        if (!isDryRun && newest) {
          await client.query(`update conversations set push_name = $1 where id = $2`, [newest.push_name, realConvId]);
        }

        // conversation_tags: migra (union, PK composta evita duplicata)
        const { rows: tagsToMigrate } = await client.query(
          `select tag_id from conversation_tags where conversation_id = $1
           and tag_id not in (select tag_id from conversation_tags where conversation_id = $2)`,
          [lidConvId, realConvId]
        );
        if (tagsToMigrate.length > 0) console.log(`  tags a migrar: ${tagsToMigrate.length}`);
        if (!isDryRun) {
          await client.query(
            `insert into conversation_tags (conversation_id, tag_id)
             select $1, tag_id from conversation_tags where conversation_id = $2
             on conflict do nothing`,
            [realConvId, lidConvId]
          );
        }

        // conversation_assignment_history: migra tudo pra conversa real
        const { rows: histCount } = await client.query(
          `select count(*) from conversation_assignment_history where conversation_id = $1`,
          [lidConvId]
        );
        if (Number(histCount[0].count) > 0) console.log(`  histórico de atribuição a migrar: ${histCount[0].count}`);
        if (!isDryRun) {
          await client.query(
            `update conversation_assignment_history set conversation_id = $1 where conversation_id = $2`,
            [realConvId, lidConvId]
          );
        }

        // conversation_summaries: mantém só o mais recente entre os dois lados, apaga o resto
        const { rows: allSummaries } = await client.query(
          `select id, conversation_id, created_at from conversation_summaries where conversation_id = any($1::bigint[]) order by created_at desc`,
          [[lidConvId, realConvId]]
        );
        if (allSummaries.length > 0) {
          const keepId = allSummaries[0].id;
          const deleteIds = allSummaries.slice(1).map((s) => s.id);
          if (deleteIds.length > 0) {
            console.log(`  resumos de IA: mantém id=${keepId} (conv=${allSummaries[0].conversation_id}), apaga ${deleteIds.length}`);
          }
          summariesDeleted += deleteIds.length;
          if (!isDryRun) {
            if (deleteIds.length > 0) {
              await client.query(`delete from conversation_summaries where id = any($1::bigint[])`, [deleteIds]);
            }
            await client.query(`update conversation_summaries set conversation_id = $1 where id = $2`, [realConvId, keepId]);
          }
        }

        // Apaga a conversa-LID (cascade cuida de messages/summaries/tags/history remanescentes)
        if (!isDryRun) {
          await client.query(`delete from conversations where id = $1`, [lidConvId]);
        }
        merges++;
      }
    }

    console.log('\n=== RESUMO ===');
    console.log('Updates simples:', simpleUpdates);
    console.log('Merges:', merges);
    console.log('Mensagens migradas:', messagesMigrated);
    console.log('Mensagens descartadas (já duplicadas):', messagesDiscarded);
    console.log('Resumos de IA apagados (duplicados):', summariesDeleted);

    if (isDryRun) {
      console.log('\nDRY RUN — nada foi escrito. Rode com --apply pra aplicar de verdade.');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('\nCOMMIT realizado com sucesso.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('FALHA — ROLLBACK completo, nada foi alterado:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
