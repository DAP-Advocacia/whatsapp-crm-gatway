// Reconhecimento real de mídia (áudio/imagem/vídeo) via OpenAI — Whisper
// pra transcrição de áudio, Vision (gpt-4o-mini) pra descrição de imagem/
// vídeo. Mesmo estilo de src/openai.js/src/embeddings.js: fetch cru, sem
// SDK, funções puras (sem I/O de banco).
//
// ISOLADO de _callOpenAI (src/openai.js) DE PROPÓSITO — aquela função é
// compartilhada por 6 consumidores de produção (summarizeConversation,
// suggestAbTestAnalysis, generateDashboardInsights, generateTeamInsights,
// generateConversationAnalysisInsight, generateAgentReply) e sempre passa
// `userPrompt` como string simples; mudar a assinatura pra aceitar também
// array de content blocks (formato do Vision) é risco desnecessário de
// regressão numa função já crítica, pra economizar ~15 linhas de fetch
// duplicadas aqui.
//
// Chamado tanto por produção (src/agentDispatch.js::recognizeMedia) quanto
// pelo Playground de teste (src/routes/agent.js, POST /test-reply) — as 3
// funções abaixo não têm nenhum efeito colateral de banco/produção, só
// texto, seguras de chamar dos dois lados sem duplicar lógica de
// transcrição/Vision.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VISION_MODEL = 'gpt-4o-mini'; // mesmo modelo já usado em src/openai.js — família gpt-4o suporta Vision nativamente

// Transcrição de áudio via Whisper (endpoint /v1/audio/transcriptions,
// multipart/form-data — diferente de /v1/chat/completions, que é JSON).
// FormData/Blob são NATIVOS do Node 24 (runtime confirmado v24.18.0):
// `fetch` aceita um body FormData e define o Content-Type multipart com
// boundary sozinho, sem lib nova.
async function transcribeAudio(buffer, mimetype) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada no servidor');

  const form = new FormData();
  const ext = mimetype?.includes('ogg') ? 'ogg' : mimetype?.includes('mp3') || mimetype?.includes('mpeg') ? 'mp3' : 'audio';
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/ogg' }), `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'erro na API de transcrição da OpenAI');
  const text = data.text?.trim();
  if (!text) throw new Error('transcrição vazia');
  return text;
}

// Descrição de imagem via Vision (Chat Completions com `content` como
// array de blocks — a família gpt-4o aceita image_url nativamente, sem
// endpoint separado).
async function describeImage(buffer, mimetype) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada no servidor');
  const dataUri = `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 300,
      messages: [
        { role: 'system', content: 'Descreva objetivamente o conteúdo desta imagem em português do Brasil, em 1 a 2 frases curtas — como se fosse a legenda de uma mensagem de WhatsApp. Sem introdução, sem "a imagem mostra".' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
      ],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'erro na API de Vision da OpenAI');
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('descrição vazia');
  return text;
}

// Extrai 1 frame (segundo 1 — evita frame preto/fade-in do 0:00) do
// buffer de vídeo recebido. Mesmo padrão de tmpdir de
// src/audioConvert.js::convertToOggOpus (grava buffer em os.tmpdir(),
// roda ffmpeg, lê a saída, limpa os 2 arquivos temporários — inclusive
// em caso de erro, via cleanup() chamado nos 2 branches).
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
ffmpeg.setFfmpegPath(ffmpegPath);

function extractVideoFrame(buffer) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');
    const inputPath = path.join(os.tmpdir(), `${id}-in.mp4`);
    const outputPath = path.join(os.tmpdir(), `${id}-out.jpg`);
    const cleanup = () => { fs.unlink(inputPath, () => {}); fs.unlink(outputPath, () => {}); };
    fs.writeFileSync(inputPath, buffer);
    ffmpeg(inputPath)
      .on('error', (err) => { cleanup(); reject(err); })
      .on('end', () => {
        try { const out = fs.readFileSync(outputPath); cleanup(); resolve(out); }
        catch (err) { cleanup(); reject(err); }
      })
      .screenshots({ timestamps: ['1'], filename: `${id}-out.jpg`, folder: os.tmpdir(), size: '640x?' });
  });
}

// Vision não aceita vídeo direto, só imagem estática — extrai 1 frame e
// reaproveita describeImage. A descrição é necessariamente incompleta
// (descreve UM instante, não o vídeo inteiro) — prefixo explícito deixa
// isso claro em qualquer lugar que o texto apareça (Chat, prompt da IA,
// resumo de conversa), pra nunca passar a entender que é uma transcrição
// completa do conteúdo.
async function describeVideo(buffer) {
  const frame = await extractVideoFrame(buffer);
  const description = await describeImage(frame, 'image/jpeg');
  return `[Descrição do início do vídeo] ${description}`;
}

module.exports = { transcribeAudio, describeImage, describeVideo };
