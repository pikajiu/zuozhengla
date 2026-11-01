// 坐正啦 日志中转（Cloudflare Worker）
// 网页把日志发到这里，这里用保存在 Cloudflare 的 GitHub 令牌建 Issue。令牌不会出现在网页代码里。
// 需要在 Worker 设置里添加机密变量 GITHUB_TOKEN（只对 pikajiu/zuozhengla 有 Issues 读写权限）。
const REPO = "pikajiu/zuozhengla";
const ALLOWED_ORIGINS = ["https://pikajiu.github.io", "https://raw.githack.com"];
const MAX_BODY = 60000;
const recent = new Map(); // 简单限流：同一 IP 每分钟最多 3 次

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const h = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, { headers: h });
    if (req.method !== "POST") return new Response("ok", { headers: h });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response("forbidden", { status: 403, headers: h });

    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const now = Date.now();
    const hits = (recent.get(ip) || []).filter((t) => now - t < 60000);
    if (hits.length >= 3) return new Response("too many", { status: 429, headers: h });
    recent.set(ip, [...hits, now]);

    let data;
    try { data = await req.json(); } catch { return new Response("bad json", { status: 400, headers: h }); }
    const title = String(data.title || "[日志]").slice(0, 120);
    const body = String(data.body || "").slice(0, MAX_BODY);
    if (!title.startsWith("[日志]") || !body.includes("zuozhengla")) return new Response("bad log", { status: 400, headers: h });

    const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "zuozhengla-relay",
      },
      body: JSON.stringify({ title, body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return new Response(JSON.stringify({ error: res.status, message: j.message }), { status: 502, headers: { ...h, "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ html_url: j.html_url, number: j.number }), { headers: { ...h, "Content-Type": "application/json" } });
  },
};
