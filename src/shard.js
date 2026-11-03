// Qual worker cuida de qual sessão: hash FNV-1a do sessionId, módulo N.
// Estável (a mesma sessão cai sempre no mesmo worker enquanto N não mudar) e
// sem tabela pra manter. Usado por RemoteSessionManager (processo principal) e
// por sessionWorker (cada worker filtra o que ele mesmo deve subir no boot).
function shardOf(sessionId, workers) {
  let h = 0x811c9dc5;
  const s = String(sessionId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % workers;
}

module.exports = { shardOf };
