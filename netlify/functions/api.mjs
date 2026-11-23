import { getStore } from "@netlify/blobs";
import { createApi } from "../../public/core.js";

const PROMPT = `Это чек (квитанция) об оплате или переводе. Ответь ТОЛЬКО JSON без пояснений:
{"is_kaspi": true/false — это квитанция Kaspi.kz о переводе или платеже,
 "status_ok": true/false — операция успешна (не «в обработке», не «отклонено»),
 "amount": число — сумма перевода в тенге без комиссии,
 "recipient": "получатель так, как написано в чеке",
 "datetime": "YYYY-MM-DD HH:MM" — дата и время операции,
 "number": "номер квитанции / операции"}
Если какого-то поля нет в чеке — ставь null. Ничего не придумывай.`;

async function recognize({ type, b64 }) {
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  const source = { type: "base64", media_type: type, data: b64 };
  const block = type === "application/pdf" ? { type: "document", source } : { type: "image", source };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Netlify.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5",
      max_tokens: 400,
      messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const text = j.content?.find((c) => c.type === "text")?.text || "";
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

export default async (req) => {
  const store = getStore({ name: "pride-fc", consistency: "strong" });
  const adapter = {
    get: (k) => store.get(k, { type: "json" }),
    getE: async (k) => {
      const r = await store.getWithMetadata(k, { type: "json" });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    set: (k, v, o = {}) => store.setJSON(k, v, o),
    del: (k) => store.delete(k),
    list: async (prefix) => (await store.list({ prefix })).blobs.map((b) => b.key),
  };
  const api = createApi(adapter, { adminPassword: Netlify.env.get("ADMIN_PASSWORD"), recognize });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const r = await api.handle(req.method, path, Object.fromEntries(url.searchParams), body, {
    admin: req.headers.get("x-admin") || "",
  });
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
};

export const config = { path: "/api/*" };
