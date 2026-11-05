/*
 * Estado de autenticação do Baileys em disco (uma pasta por sessão), no lugar do
 * useMultiFileAuthState da lib. Mesma estrutura de arquivos (creds.json +
 * <tipo>-<id>.json), então as pastas que já existem continuam valendo.
 *
 * O que muda (2026-11-05): a lib grava com writeFile direto no arquivo, que
 * TRUNCA antes de escrever. Se o processo é morto no meio (deploy, OOM, SIGKILL
 * do Swarm), sobra um arquivo vazio ou pela metade. Medido em produção: 62
 * creds.json com 0 bytes e 10 pastas com chaves de gerações diferentes. Aqui:
 *  - toda gravação vai num arquivo temporário e entra no lugar com rename (que é
 *    atômico): o arquivo tem sempre o conteúdo antigo ou o novo, nunca metade;
 *  - creds.json guarda uma cópia boa (creds.json.bak) da versão anterior;
 *  - creds.json ilegível NÃO vira credencial nova em silêncio (a lib faz isso, e
 *    aí as chaves antigas da pasta se misturam com as novas): usa a cópia, e sem
 *    cópia lança AUTH_CREDS_CORRUPT pra quem chamou decidir (pedir novo QR).
 */
const fs = require('fs');
const path = require('path');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const fsp = fs.promises;

// Uma gravação por vez em cada arquivo (mesma garantia do mutex da lib).
const locks = new Map(); // caminho -> fim da fila
function withLock(file, fn) {
  const prev = locks.get(file) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  locks.set(file, tail);
  tail.then(() => {
    if (locks.get(file) === tail) locks.delete(file);
  });
  return run;
}

// Gravações em andamento: o desligamento espera por elas (ver flushAuthWrites).
const inflight = new Set();
function track(promise) {
  inflight.add(promise);
  const done = () => inflight.delete(promise);
  promise.then(done, done);
  return promise;
}

async function flushAuthWrites(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (inflight.size && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
    ]);
  }
}

// Escreve em <arquivo>.tmp e troca por rename. `sync`: força o conteúdo pro disco
// antes da troca (só pro creds.json, é o arquivo que não pode se perder).
async function writeAtomic(filePath, text, { sync = false } = {}) {
  const tmp = `${filePath}.tmp`;
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'w');
    await fh.writeFile(text);
    if (sync) await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, filePath);
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

// { status: 'ok', raw, value } | { status: 'missing' } | { status: 'corrupt' }.
// Qualquer outro erro de leitura (EMFILE, EIO...) sobe: não é arquivo ruim, é
// problema passageiro, e não pode virar "credencial nova".
async function readJson(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing' };
    throw err;
  }
  try {
    const value = JSON.parse(raw, BufferJSON.reviver);
    if (value && typeof value === 'object') return { status: 'ok', raw, value };
  } catch {
    // cai no corrupt
  }
  return { status: 'corrupt' };
}

class AuthStateCorruptError extends Error {
  constructor(folder) {
    super(`creds.json ilegível e sem cópia boa em ${folder}`);
    this.code = 'AUTH_CREDS_CORRUPT';
  }
}

async function loadCreds(folder) {
  const credsPath = path.join(folder, 'creds.json');
  const cur = await readJson(credsPath);
  if (cur.status === 'ok') return cur.value;
  if (cur.status === 'missing') return initAuthCreds(); // pasta nova: ainda não pareou
  const bak = await readJson(`${credsPath}.bak`);
  if (bak.status === 'ok') {
    console.warn(`[authState] creds.json ilegível em ${path.basename(folder)} — restaurado da cópia`);
    await writeAtomic(credsPath, bak.raw, { sync: true });
    return bak.value;
  }
  throw new AuthStateCorruptError(folder);
}

async function useAtomicAuthState(folder) {
  const folderInfo = await fsp.stat(folder).catch(() => {});
  if (folderInfo) {
    if (!folderInfo.isDirectory()) {
      throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
    }
  } else {
    await fsp.mkdir(folder, { recursive: true });
  }

  const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
  const pathOf = (file) => path.join(folder, fixFileName(file));

  const writeData = (data, file) => {
    const filePath = pathOf(file);
    return track(withLock(filePath, () => writeAtomic(filePath, JSON.stringify(data, BufferJSON.replacer))));
  };

  const readData = (file) => {
    const filePath = pathOf(file);
    return withLock(filePath, async () => {
      try {
        const r = await readJson(filePath);
        return r.status === 'ok' ? r.value : null;
      } catch {
        return null;
      }
    });
  };

  const removeData = (file) => {
    const filePath = pathOf(file);
    return withLock(filePath, () => fsp.unlink(filePath).catch(() => {}));
  };

  const creds = await loadCreds(folder);

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => {
      const credsPath = pathOf('creds.json');
      return track(withLock(credsPath, async () => {
        // Guarda a versão boa que está em disco antes de trocar pela nova.
        try {
          const cur = await readJson(credsPath);
          if (cur.status === 'ok') await writeAtomic(`${credsPath}.bak`, cur.raw);
        } catch {
          // sem cópia desta vez; a gravação nova segue
        }
        await writeAtomic(credsPath, JSON.stringify(creds, BufferJSON.replacer), { sync: true });
      }));
    },
  };
}

module.exports = { useAtomicAuthState, flushAuthWrites, AuthStateCorruptError };
