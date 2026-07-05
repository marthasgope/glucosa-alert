self.addEventListener('push', function(e) {
  if (!e.data) return;
  var data = e.data.json();
  var title = data.title || 'Glucosa Alert';
  var body = data.body || '';
  var opts = {
    body: body,
    icon: '/icon.png',
    badge: '/icon.png',
    vibrate: [500, 200, 500, 200, 500],
    requireInteraction: true,
    data: data,
    actions: [
      { action: 'open', title: 'Open app' }
    ]
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var data = e.notification.data || {};
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      if (list.length > 0) {
        var client = list[0];
        client.focus();
        client.postMessage(data);
        return;
      }
      return clients.openWindow('/');
    })
  );
});

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(clients.claim());
});
