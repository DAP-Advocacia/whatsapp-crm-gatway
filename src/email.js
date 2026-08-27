const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';

/**
 * Cliente mínimo pra API da Resend (resend.com) — fetch cru, sem SDK,
 * mesmo estilo já usado em src/openai.js/src/bitrix.js/src/bitrixHierarchy.js
 * neste projeto. Usado só pelo alerta de e-mail de instância caída (ver
 * src/emailAlert.js). Opcional: sem RESEND_API_KEY configurada, todo
 * envio é um no-op silencioso.
 */
async function sendEmail(to, subject, text) {
  if (!RESEND_API_KEY) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || `erro na API da Resend (status ${res.status})`);
  }
  return data;
}

module.exports = { sendEmail };
