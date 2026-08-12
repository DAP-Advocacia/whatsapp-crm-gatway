/**
 * Correção retroativa da tabela `contacts` (HANDOFF Parte CP) — companheiro
 * de scripts/fix-lid-phones.js, que corrigiu `conversations`/`messages` mas
 * não tocava em `contacts` (escopos diferentes: conversations é por
 * session_id, contacts é por owner_id — um contato fantasma podia sobrar
 * mesmo depois da conversa já estar corrigida).
 *
 * Mesmo escopo desta rodada: só os telefones já resolvidos em
 * /tmp/resolve-lid-results.json (as 3 sessões que estavam online).
 *
 * Dois casos, por contato:
 *   1. UPDATE SIMPLES: telefone real ainda não existe como contato
 *      separado do mesmo owner — troca contacts.phone direto.
 *   2. MERGE: telefone real já existe como contato separado — mantém o
 *      contato REAL (é o que tende a já ter sido editado manualmente/visto
 *      pelo usuário), preenche name/deal_id que estiverem faltando nele a
 *      partir do fantasma (coalesce, nunca sobrescreve valor já
 *      preenchido — mesma regra de upsertContact em src/contacts.js), e
 *      apaga o contato-fantasma.
 *
 * USO:
 *   node scripts/fix-lid-contacts.js --dry-run
 *   node scripts/fix-lid-contacts.js --apply
 */
require('dotenv').config();
const { pool } = require('../src/db');
const fs = require('fs');

const RESULTS_PATH = process.env.FIX_LID_RESULTS_PATH || '/tmp/resolve-lid-results.json';

async function run() {
  const isDryRun = !process.argv.includes('--apply');
  console.log(isDryRun ? '=== DRY RUN (nada será escrito) ===' : '=== APLICANDO DE VERDADE ===');

  const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  // Achata o mapeamento de todas as sessões resolvidas num Map único
  // lidPhone -> realPhone (contacts não é escopado por sessão).
  const flatMapping = new Map();
  for (const mapping of Object.values(results)) {
    for (const [lidPhone, realPhone] of Object.entries(mapping)) {
      if (realPhone) flatMapping.set(lidPhone, realPhone);
    }
  }

  const client = await pool.connect();
  let simpleUpdates = 0;
  let merges = 0;

  try {
    await client.query('BEGIN');

    const { rows: badContacts } = await client.query(
      `select id, owner_id, phone, name, deal_id from contacts where length(phone) >= 14`
    );

    for (const c of badContacts) {
      const realPhone = flatMapping.get(c.phone);
      if (!realPhone) continue; // fora do escopo já resolvido nesta rodada

      const { rows: existing } = await client.query(
        `select id, name, deal_id from contacts where owner_id = $1 and phone = $2`,
        [c.owner_id, realPhone]
      );

      if (existing.length === 0) {
        console.log(`[SIMPLES] owner=${c.owner_id} contato=${c.id}: ${c.phone} -> ${realPhone}`);
        if (!isDryRun) {
          await client.query(`update contacts set phone = $1, updated_at = now() where id = $2`, [realPhone, c.id]);
        }
        simpleUpdates++;
        continue;
      }

      const realContact = existing[0];
      const mergedName = realContact.name || c.name || null;
      const mergedDealId = realContact.deal_id || c.deal_id || null;
      console.log(
        `[MERGE] owner=${c.owner_id}: fantasma=${c.id} (${c.phone}) -> contato real=${realContact.id} (${realPhone}, nome final="${mergedName || '-'}", deal final=${mergedDealId || '-'})`
      );

      // contact_list_members (o fantasma pode estar numa lista de contatos
      // personalizada) — migra pro contato real, PK composta evita duplicar
      // se o real já estiver na mesma lista.
      const { rows: listRows } = await client.query(`select list_id from contact_list_members where contact_id = $1`, [c.id]);
      if (listRows.length > 0) console.log(`  listas a migrar: ${listRows.length}`);

      // lead_form_submissions (o fantasma pode ter vindo de um formulário
      // de captura de lead) — sem PK composta aqui, UPDATE simples.
      const { rows: submissionRows } = await client.query(`select id from lead_form_submissions where contact_id = $1`, [c.id]);
      if (submissionRows.length > 0) console.log(`  submissões de LP a migrar: ${submissionRows.length}`);

      if (!isDryRun) {
        await client.query(`update contacts set name = $1, deal_id = $2, updated_at = now() where id = $3`, [
          mergedName,
          mergedDealId,
          realContact.id,
        ]);
        if (listRows.length > 0) {
          await client.query(
            `insert into contact_list_members (list_id, contact_id)
             select list_id, $1 from contact_list_members where contact_id = $2
             on conflict do nothing`,
            [realContact.id, c.id]
          );
        }
        if (submissionRows.length > 0) {
          await client.query(`update lead_form_submissions set contact_id = $1 where contact_id = $2`, [realContact.id, c.id]);
        }
        // delete cuida do que sobrar em contact_list_members (cascade) — a
        // linha do fantasma lá já não tem mais função depois da migração.
        await client.query(`delete from contacts where id = $1`, [c.id]);
      }
      merges++;
    }

    console.log('\n=== RESUMO ===');
    console.log('Updates simples:', simpleUpdates);
    console.log('Merges:', merges);

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
