/* Service worker minimo para que el navegador permita instalar la app en el
   telefono (icono en pantalla de inicio, pantalla completa sin barra del
   navegador). A proposito NO guarda en cache el HTML principal (index.html /
   cliente.html): esta app depende de Firebase para funcionar y de traer
   siempre la version mas nueva (con las correcciones de seguridad), asi que
   cachear el documento podria dejar a alguien atascado en una version vieja.
   Solo deja pasar las peticiones directo a la red. */
const VERSION = 'rn-sw-v1';

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
