/**
 * Service Worker - P&G Preços Justos
 * Permite instalar o site como aplicativo (celular e computador).
 * Estratégia "rede primeiro": sempre busca a versão mais nova do site e só
 * usa a cópia salva quando a pessoa estiver sem internet.
 * Dados do Supabase e outros sites externos nunca são guardados aqui.
 */
const CACHE = "pg-precos-justos-v1";
const ARQUIVOS_BASE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./img/logo-horizontal.png",
  "./img/icone-192.png"
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS_BASE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (evento) => {
  const req = evento.request;
  const url = new URL(req.url);

  // Só arquivos do próprio site; o painel /admin/ fica fora do app
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/admin/")) return;

  evento.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((resposta) => {
        if (resposta.ok) {
          const copia = resposta.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copia));
        }
        return resposta;
      })
      .catch(() =>
        caches.match(req).then((salvo) => salvo || caches.match("./index.html"))
      )
  );
});
