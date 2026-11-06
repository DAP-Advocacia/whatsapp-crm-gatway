#!/usr/bin/env node
/*
 * Cria (ou troca a senha de) um usuário do painel de auditoria (/painel).
 *
 *   node scripts/panel-user.js <login> ["Nome de exibição"]
 *
 * A senha é GERADA aqui (24 caracteres aleatórios) e mostrada uma única vez — não passa por
 * argumento de linha de comando nem por arquivo. A pessoa pode trocá-la depois no próprio painel.
 * Precisa de DATABASE_URL (as tabelas vêm de db/painel.sql).
 */
require('dotenv').config();
const crypto = require('crypto');
const { hashPassword } = require('../src/panelAuth');
const panelStore = require('../src/panelStore');
const { pool } = require('../src/db');

(async () => {
  const username = String(process.argv[2] || '').trim();
  const displayName = process.argv[3] ? String(process.argv[3]).trim() : null;
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    console.error('Uso: node scripts/panel-user.js <login> ["Nome"]   (login: 3-40 letras, números, . _ -)');
    process.exit(1);
  }
  const password = crypto.randomBytes(18).toString('base64url');
  try {
    const user = await panelStore.upsertUser({ username, displayName, passwordHash: await hashPassword(password) });
    console.log(`Usuário do painel pronto: ${user.username}`);
    console.log(`Senha (mostrada só agora, guarde): ${password}`);
  } catch (err) {
    if (panelStore.tablesMissing(err)) console.error('As tabelas do painel não existem ainda: rode db/painel.sql primeiro.');
    else console.error('Falha:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
