const CACHE="stuti-receipts-v6";
const FILES=["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"];
self.addEventListener("install",e=>{ e.waitUntil(caches.open(CACHE).then(c=>Promise.all(FILES.map(u=>c.add(new Request(u,{mode:u.startsWith("http")?"no-cors":"same-origin"})).catch(()=>{}))))); self.skipWaiting(); });
self.addEventListener("activate",e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET") return;
  const u=new URL(e.request.url);
  if(u.origin!==self.location.origin && !/(^|\.)(cdnjs\.cloudflare\.com|gstatic\.com)$/.test(u.hostname)) return;
  e.respondWith(fetch(e.request).then(r=>{ const copy=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{}); return r; }).catch(()=>caches.match(e.request,{ignoreSearch:true})));
});
