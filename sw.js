/**
 * Service Worker - P&G Preços Justos
 * Permite instalar o site como aplicativo (celular e computador).
 * Estratégia "rede primeiro": sempre busca a versão mais nova do site e só
 * usa a cópia salva quando a pessoa estiver sem internet.
 * Dados do Supabase e outros sites externos nunca são guardados aqui.
 */
const CACHE = "pg-precos-justos-v6";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    (async () => {
      const nomes = await caches.keys();
      await Promise.all(
        nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (evento) => {
  const req = evento.request;
  const url = new URL(req.url);

  // Só arquivos do próprio site; o painel /admin/ fica fora do app
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.includes("/admin/")) return;

  evento.respondWith(
    fetch(req.url, { cache: "no-store" })
      .then((resposta) => {
        if (resposta && resposta.ok) {
          const copia = resposta.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(req, copia))
            .catch(() => {});
        }
        return resposta;
      })
      .catch(() =>
        caches
          .match(req, { ignoreSearch: true })
          .then((salvo) => salvo || caches.match("./index.html"))
      )
  );
});
