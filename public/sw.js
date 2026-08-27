// Service Worker — Web Push. Fica na RAIZ de public/ de propósito: o
// escopo de um Service Worker é a pasta onde o arquivo vive, e este
// precisa controlar o site inteiro (qualquer página pode registrar,
// qualquer alerta pode chegar independente de qual tela estava aberta
// quando a subscription foi criada).
//
// Ver src/webpush.js (backend, quem envia) e o botão "Ativar notificações
// do sistema" nas 17 telas com sidebar (frontend, quem registra/assina).

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'WhatsApp Gateway', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'WhatsApp Gateway', {
      body: data.body || '',
      data: data.target || {},
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data || {};
  const url = target.page || '/';
  event.waitUntil(clients.openWindow(url));
});
