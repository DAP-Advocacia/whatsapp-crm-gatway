/**
 * Parser de CSV escrito à mão, sem dependência externa — a alternativa mais
 * usada (biblioteca `xlsx`/SheetJS, que também leria .xlsx) tem duas
 * vulnerabilidades altas sem correção (Prototype Pollution, ReDoS:
 * GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9) — um arquivo malicioso poderia
 * travar o processo inteiro do gateway (todas as instâncias de WhatsApp
 * juntas, já que é um processo Node só). CSV é só texto, então dá pra ler
 * com segurança sem depender disso; por ora .xlsx não é aceito.
 */

// Suporta campos entre aspas (com vírgula/ponto-e-vírgula/aspas escapadas
// como "") e detecta o delimitador (',' ou ';') pela primeira linha — Excel
// em português (locale pt-BR) exporta CSV com ';' por padrão, já que ',' é
// separador decimal nesse locale.
function detectDelimiter(firstLine) {
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parseCsvLine(line, delimiter) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}

const NAME_HEADER_ALIASES = ['nome', 'name', 'cliente', 'contato', 'contato/cliente'];
const PHONE_HEADER_ALIASES = ['telefone', 'phone', 'celular', 'whatsapp', 'numero', 'número', 'tel', 'fone'];

function findHeader(headers, aliases) {
  return headers.find((h) => aliases.includes(h));
}

// Devolve { contacts: [{name, phone}], totalRows, skipped } ou lança erro
// (cabeçalho de telefone não encontrado — não dá pra importar sem isso).
function parseContactsCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { contacts: [], totalRows: 0, skipped: 0 };

  const headers = Object.keys(rows[0]);
  const phoneHeader = findHeader(headers, PHONE_HEADER_ALIASES);
  const nameHeader = findHeader(headers, NAME_HEADER_ALIASES);
  if (!phoneHeader) {
    throw new Error('não encontrei uma coluna de telefone (esperado: "telefone", "phone", "celular" ou "whatsapp")');
  }

  const contacts = [];
  let skipped = 0;
  for (const row of rows) {
    const cleanPhone = String(row[phoneHeader] || '').replace(/\D/g, '');
    if (cleanPhone.length < 10) { skipped++; continue; }
    contacts.push({ name: nameHeader ? (row[nameHeader] || '').trim() || null : null, phone: cleanPhone });
  }
  return { contacts, totalRows: rows.length, skipped };
}

module.exports = { parseContactsCsv };
