const fs = require('fs');
const path = require('path');

const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_session';

// Telefone (só dígitos) do próprio WhatsApp de cada sessão, lido direto das
// credenciais salvas em disco (funciona mesmo se a sessão não estiver online
// agora). Usado para distinguir uma conversa "interna" (o contato do outro
// lado é o WhatsApp de OUTRO usuário do Bitrix — ex: teste entre colegas) de
// uma "externa" (cliente/lead de fora) — ver src/metrics.js e a tag
// automática Interno/Externo em src/store.js (listConversations).
function getOwnNumbersBySession() {
  const bySession = {};
  if (!fs.existsSync(AUTH_FOLDER)) return bySession;

  for (const entry of fs.readdirSync(AUTH_FOLDER, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const credsPath = path.join(AUTH_FOLDER, entry.name, 'creds.json');
    if (!fs.existsSync(credsPath)) continue;
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      const meId = creds?.me?.id; // formato: "5521999999999:9@s.whatsapp.net"
      if (meId) bySession[entry.name] = meId.split('@')[0].split(':')[0];
    } catch {
      // creds corrompido/em uso no momento da leitura — ignora essa sessão
    }
  }
  return bySession;
}

module.exports = { getOwnNumbersBySession };
