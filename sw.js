// 把模型和运行库缓存在手机上：第一次下载后，以后打开不用再下载
const CACHE = "zuozhengla-vendor-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || !url.pathname.includes("/vendor/")) return;
  // 缓存键去掉提交号之类的路径差异：只看 vendor/ 之后的文件名
  const key = new Request(self.registration.scope + "vendor/" + url.pathname.split("/vendor/")[1]);
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) cache.put(key, res.clone());
    return res;
  })());
});
