const dns = require('dns').promises;
const net = require('net');

// og:* sempre fica no <head>, então não precisa (nem é seguro) baixar a
// página inteira pra achar as tags.
const MAX_HTML_BYTES = 300 * 1024;
const FETCH_TIMEOUT_MS = 6000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

/**
 * Valida que a URL é http(s) e que o host não resolve pra um endereço
 * privado/interno — proteção básica contra SSRF, já que quem manda a URL é
 * texto livre de uma mensagem de WhatsApp, uma entrada não confiável.
 */
async function resolvePublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('protocolo não suportado');
  }
  const { address } = await dns.lookup(parsed.hostname);
  if (isPrivateIp(address)) throw new Error('endereço não permitido');
  return parsed;
}

async function fetchHtmlSnippet(parsedUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WhatsAppGatewayLinkPreview/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) throw new Error('não é HTML');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let received = 0;
    while (received < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function metaContent(html, prop) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Extrai título/descrição/imagem via tags Open Graph (fallback pra <title>
 * e <meta name="description"> quando o site não tem og:*). Regex simples em
 * vez de um parser de HTML de verdade — suficiente pra tags <meta>, que são
 * sempre auto-fechadas e ficam no <head>, e evita adicionar uma dependência
 * nova só pra isso.
 */
function extractOpenGraph(html, parsedUrl) {
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = metaContent(html, 'og:title') || (titleTag ? decodeEntities(titleTag[1].trim()) : null);
  const description = metaContent(html, 'og:description') || metaContent(html, 'description');
  let image = metaContent(html, 'og:image');
  if (image && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, parsedUrl).toString();
    } catch {
      image = null;
    }
  }
  const siteName = metaContent(html, 'og:site_name') || parsedUrl.hostname;
  return { title, description, image, siteName };
}

module.exports = { resolvePublicUrl, fetchHtmlSnippet, extractOpenGraph };
