const { pool } = require('./db');

/**
 * Contatos e listas de contatos, escopados pelo DONO (owner_id) — não pela
 * instância de WhatsApp. Se uma instância cai e o usuário conecta outra
 * (novo session_id), os mesmos contatos/listas continuam aparecendo, em vez
 * de ficar tudo vazio pra instância nova (ver db/schema.sql para a migração
 * que trouxe os dados existentes de session_id pra owner_id).
 */

async function listContacts(ownerId) {
  const { rows } = await pool.query(
    `select id, name, phone, deal_id as "dealId"
     from contacts where owner_id = $1
     order by coalesce(name, phone)`,
    [ownerId]
  );
  return rows;
}

async function upsertContact(ownerId, { name, phone, dealId }) {
  const { rows } = await pool.query(
    `insert into contacts (owner_id, phone, name, deal_id)
     values ($1, $2, $3, $4)
     on conflict (owner_id, phone)
     do update set
       name = coalesce(excluded.name, contacts.name),
       deal_id = coalesce(excluded.deal_id, contacts.deal_id),
       updated_at = now()
     returning id, name, phone, deal_id as "dealId"`,
    [ownerId, phone, name || null, dealId || null]
  );
  return rows[0];
}

async function updateContact(id, ownerId, { name, phone }) {
  const { rows } = await pool.query(
    `update contacts set name = $1, phone = $2, updated_at = now()
     where id = $3 and owner_id = $4
     returning id, name, phone, deal_id as "dealId"`,
    [name || null, phone, id, ownerId]
  );
  return rows[0];
}

async function deleteContact(id, ownerId) {
  const { rowCount } = await pool.query(`delete from contacts where id = $1 and owner_id = $2`, [id, ownerId]);
  return rowCount > 0;
}

// Cria um contato para cada conversa que QUALQUER instância deste dono já
// tem e que ainda não virou contato — forma rápida de começar a lista de
// contatos a partir de quem já conversou pelo WhatsApp, em qualquer uma das
// instâncias do usuário. Nome vem de `conversations.push_name` (o próprio
// contato definiu no WhatsApp dele, chega sozinho em toda mensagem — ver
// db/schema.sql) — antes esta função criava sempre SEM nome, obrigando a
// pessoa a abrir cada contato na lista de disparo de campanha e adivinhar
// quem era só pelo telefone (usuário reportou, HANDOFF Parte DO). Reexecutar
// esta importação (idempotente) preenche retroativamente o nome de quem já
// tinha sido importado sem nome antes desta correção, sem precisar de
// migração separada. `coalesce(contacts.name, excluded.name)` só preenche se
// o contato AINDA não tiver nome — nunca sobrescreve edição manual feita na
// tela de Contatos (updateContact).
async function importFromConversations(ownerId) {
  const { rowCount } = await pool.query(
    `insert into contacts (owner_id, phone, name, deal_id)
     select $1, phone, push_name, deal_id from conversations
     where session_id in (select id from instances where owner_id = $1)
     on conflict (owner_id, phone)
     do update set
       name = coalesce(contacts.name, excluded.name),
       deal_id = coalesce(contacts.deal_id, excluded.deal_id)`,
    [ownerId]
  );
  return rowCount;
}

// Upsert em lote (ex: importação de CSV, ver src/csvImport.js) — mesma regra
// de upsertContact (não sobrescreve nome já existente com vazio), só que
// numa query só em vez de uma por contato. Deduplica por telefone ANTES de
// montar a query (mantendo o último nome não-vazio encontrado) — Postgres
// rejeita um `ON CONFLICT DO UPDATE` que tentaria afetar a mesma linha duas
// vezes dentro do mesmo INSERT, e planilha real frequentemente tem telefone
// repetido.
async function importRows(ownerId, rows) {
  const byPhone = new Map();
  for (const r of rows) {
    const existing = byPhone.get(r.phone);
    byPhone.set(r.phone, { phone: r.phone, name: r.name || existing?.name || null });
  }
  const deduped = [...byPhone.values()];
  if (!deduped.length) return 0;

  const values = [];
  const placeholders = deduped.map((r, i) => {
    values.push(ownerId, r.phone, r.name);
    return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
  });
  const { rowCount } = await pool.query(
    `insert into contacts (owner_id, phone, name)
     values ${placeholders.join(',')}
     on conflict (owner_id, phone)
     do update set name = coalesce(excluded.name, contacts.name), updated_at = now()`,
    values
  );
  return rowCount;
}

async function listContactLists(ownerId) {
  const { rows } = await pool.query(
    `select l.id, l.name, count(m.contact_id)::int as count
     from contact_lists l
     left join contact_list_members m on m.list_id = l.id
     where l.owner_id = $1
     group by l.id
     order by l.name`,
    [ownerId]
  );
  return rows;
}

async function getContactList(id, ownerId) {
  const { rows: listRows } = await pool.query(
    `select id, name, owner_id as "ownerId" from contact_lists where id = $1 and owner_id = $2`,
    [id, ownerId]
  );
  if (!listRows[0]) return null;

  const { rows: contactRows } = await pool.query(
    `select c.id, c.name, c.phone
     from contact_list_members m
     join contacts c on c.id = m.contact_id
     where m.list_id = $1
     order by coalesce(c.name, c.phone)`,
    [id]
  );
  return { ...listRows[0], contacts: contactRows };
}

async function setListMembers(listId, contactIds) {
  await pool.query(`delete from contact_list_members where list_id = $1`, [listId]);
  if (!contactIds || !contactIds.length) return;

  const values = contactIds.map((_, i) => `($1, $${i + 2})`).join(',');
  await pool.query(
    `insert into contact_list_members (list_id, contact_id) values ${values} on conflict do nothing`,
    [listId, ...contactIds]
  );
}

async function createContactList(ownerId, name, contactIds) {
  const { rows } = await pool.query(
    `insert into contact_lists (owner_id, name) values ($1, $2) returning id`,
    [ownerId, name]
  );
  const id = rows[0].id;
  await setListMembers(id, contactIds);
  return id;
}

async function updateContactList(id, ownerId, name, contactIds) {
  const { rowCount } = await pool.query(
    `update contact_lists set name = $1 where id = $2 and owner_id = $3`,
    [name, id, ownerId]
  );
  if (!rowCount) return false;
  await setListMembers(id, contactIds);
  return true;
}

async function deleteContactList(id, ownerId) {
  const { rowCount } = await pool.query(`delete from contact_lists where id = $1 and owner_id = $2`, [id, ownerId]);
  return rowCount > 0;
}

module.exports = {
  listContacts,
  upsertContact,
  updateContact,
  deleteContact,
  importFromConversations,
  importRows,
  listContactLists,
  getContactList,
  createContactList,
  updateContactList,
  deleteContactList,
};
