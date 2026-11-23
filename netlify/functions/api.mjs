import { getStore } from "@netlify/blobs";
import { createApi } from "../../public/core.js";

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
  const api = createApi(adapter, { adminPassword: Netlify.env.get("ADMIN_PASSWORD") });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const r = await api.handle(req.method, path, Object.fromEntries(url.searchParams), body, {
    admin: req.headers.get("x-admin") || "",
  });
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
};

export const config = { path: "/api/*" };
