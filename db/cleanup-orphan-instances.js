// Remove instâncias "Principal" (e quaisquer outras) NUNCA pareadas — sem
// creds.registered=true na pasta de auth_session correspondente, e sem
// nenhuma conversa/mensagem gravada no banco (dupla checagem: mesmo que a
// pasta em disco tenha sumido por outro motivo, uma instância com histórico
// real de conversa nunca é tocada). Roda DENTRO do container de produção
// (onde AUTH_FOLDER/auth_session existe fisicamente) — precisa do mesmo
// ambiente (.env, node_modules) que o servidor já usa.
//
// Causa raiz do problema (ver ROADMAP.md itens 5/13/17): GET /instances
// chamava instancesStore.ensureDefault() sempre que a tela de Conexões era
// aberta, mesmo sem o usuário clicar em nada — cada pessoa do escritório que
// só deu uma olhada na tela ganhou uma linha "Principal" órfã no Postgres.
// O commit que corrigiu isso (item 17) só impede NOVAS instâncias órfãs de
// serem criadas dai pra frente — não limpa as que já existiam. Este script
// faz essa limpeza pontual, uma vez.
//
// IRREVERSÍVEL (apaga linha em `instances` + pasta em disco). Por isso exige
// --yes explícito, e sempre lista TUDO que vai remover antes de agir:
//   node db/cleanup-orphan-instances.js          (dry-run, só lista)
//   node db/cleanup-orphan-instances.js --yes    (remove de verdade)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_session';

function isRegistered(instanceId) {
  const credsPath = path.join(AUTH_FOLDER, instanceId, 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    return creds.registered === true;
  } catch {
    return false; // creds.json corrompido/ilegível — trata como não pareado
  }
}

async function main() {
  const dryRun = !process.argv.includes('--yes');

  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  try {
    const { rows: instances } = await client.query(
      `select id, owner_id as "ownerId", label, created_at as "createdAt" from instances order by created_at asc`
    );
    console.log(`[cleanup] ${instances.length} instância(s) no banco.`);

    const candidates = [];
    for (const inst of instances) {
      if (isRegistered(inst.id)) continue; // pareada de verdade — nunca tocar

      // Segunda checagem, independente do disco: se já existe QUALQUER
      // conversa gravada pra este session_id, não é órfã de verdade (pode
      // ter recebido mensagem antes de terminar de parear, ou a pasta em
      // disco sumiu por outro motivo depois) — mantém por segurança.
      const { rows: convRows } = await client.query(
        `select count(*)::int as n from conversations where session_id = $1`,
        [inst.id]
      );
      if (convRows[0].n > 0) {
        console.log(`[cleanup] MANTIDA (tem ${convRows[0].n} conversa(s) apesar de não registrada em disco): ${inst.id} (${inst.label}, owner ${inst.ownerId})`);
        continue;
      }

      candidates.push(inst);
    }

    console.log(`\n[cleanup] ${candidates.length} instância(s) candidata(s) à remoção (nunca pareada, sem nenhuma conversa):`);
    candidates.forEach((c) => {
      console.log(`  - ${c.id} | label="${c.label}" | owner=${c.ownerId} | criada em ${c.createdAt.toISOString()}`);
    });

    if (!candidates.length) {
      console.log('\n[cleanup] nada para remover.');
      return;
    }

    if (dryRun) {
      console.log(`\n[cleanup] DRY-RUN — nada foi removido. Rode com --yes para remover de verdade.`);
      return;
    }

    console.log(`\n[cleanup] removendo ${candidates.length} instância(s)...`);
    let removed = 0;
    for (const c of candidates) {
      try {
        await client.query(`delete from instances where id = $1`, [c.id]);
        const folder = path.join(AUTH_FOLDER, c.id);
        if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.error(`[cleanup] falha ao remover ${c.id}:`, err.message);
      }
    }
    console.log(`[cleanup] concluído — ${removed}/${candidates.length} instância(s) removida(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[cleanup] falhou:', err.message);
  process.exit(1);
});
