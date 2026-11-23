// Клиент API. На Netlify ходит в /api/*. Если сервера нет (превью) — демо-режим в браузере.
import { createApi, dayKey, addDays } from "./core.js";

let mode = null;
let local = null;

function memoryOrLocal() {
  try {
    const t = "__jarys_test";
    localStorage.setItem(t, "1");
    localStorage.removeItem(t);
    return {
      read: (k) => { const s = localStorage.getItem("jarys:" + k); return s ? JSON.parse(s) : null; },
      write: (k, v) => localStorage.setItem("jarys:" + k, JSON.stringify(v)),
      remove: (k) => localStorage.removeItem("jarys:" + k),
      keys: () => Object.keys(localStorage).filter((k) => k.startsWith("jarys:")).map((k) => k.slice(6)),
    };
  } catch {
    const m = new Map();
    return { read: (k) => m.get(k) ?? null, write: (k, v) => m.set(k, v), remove: (k) => m.delete(k), keys: () => [...m.keys()] };
  }
}

function localAdapter() {
  const s = memoryOrLocal();
  return {
    get: async (k) => s.read(k)?.v ?? null,
    getE: async (k) => { const r = s.read(k); return r ? { data: r.v, etag: String(r.e) } : null; },
    set: async (k, v, o = {}) => {
      const cur = s.read(k);
      if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch && (!cur || String(cur.e) !== o.onlyIfMatch)) return { modified: false };
      s.write(k, { v, e: (cur?.e || 0) + 1 });
      return { modified: true };
    },
    del: async (k) => s.remove(k),
    list: async (p) => s.keys().filter((k) => k.startsWith(p)),
  };
}

async function seedDemo(api, store) {
  if (await store.get("demo-seeded3")) return;
  for (const k of await store.list("")) await store.del(k);
  await api.handle("POST", "/admin/discounts", {}, { discounts: [
    { title: "Утро будни", percent: 20, days: [1, 2, 3, 4, 5], from: 8, to: 12 },
    { title: "Поздний вечер", percent: 15, from: 22, to: 24 },
  ] }, { admin: "demo" });
  const t = dayKey(Date.now());
  const A = { admin: "demo" };
  const mk = (date, fieldId, hours, name, phone, status, weeks = 1) =>
    api.handle("POST", "/admin/book", {}, { date, fieldId, hours, name, phone, status, weeks }, A);
  await mk(t, "f1", [20, 21], "Ерлан", "+77011234567", "paid", 6);
  await mk(t, "f2", [19], "Айдос", "+77059876543", "unpaid");
  await mk(t, "f2", [22], "Команда «Барыс»", "+77770001122", "paid");
  await mk(addDays(t, 1), "f1", [19, 20], "Нурлан", "+77012223344", "paid");
  await mk(addDays(t, 1), "f2", [21], "Тимур", "+77473334455", "unpaid");
  await mk(addDays(t, 2), "f1", [18, 19], "Самат", "+77085556677", "paid", 4);
  await store.set("demo-seeded3", true);
}

async function detect() {
  if (mode) return;
  try {
    const r = await fetch("/api/config", { headers: { accept: "application/json" } });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) { mode = "server"; return; }
  } catch {}
  mode = "demo";
  const store = localAdapter();
  // В демо распознавание чека имитируется: считаем, что в чеке ровно сумма предоплаты.
  const recognize = async (_file, { booking, cfg }) => {
    const t = new Date(Date.now() + 5 * 3600e3).toISOString();
    return { is_kaspi: true, status_ok: true, amount: booking.prepay, recipient: cfg.kaspiName || "Демо",
      datetime: t.slice(0, 10) + " " + t.slice(11, 16), number: "DEMO" + Math.random().toString(36).slice(2, 10) };
  };
  local = createApi(store, { adminPassword: "demo", recognize });
  await seedDemo(local, store);
}

export async function call(method, path, { query = {}, body = {}, admin } = {}) {
  await detect();
  if (mode === "demo") {
    const r = await local.handle(method, path, query, body, { admin });
    if (r.status >= 400) throw Object.assign(new Error(r.body.error), { status: r.status });
    return r.body;
  }
  const qs = new URLSearchParams(query).toString();
  const r = await fetch("/api" + path + (qs ? "?" + qs : ""), {
    method,
    headers: { "content-type": "application/json", ...(admin ? { "x-admin": admin } : {}) },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({ error: "Нет связи с сервером" }));
  if (!r.ok) throw Object.assign(new Error(data.error || "Ошибка"), { status: r.status });
  return data;
}

export const isDemo = async () => { await detect(); return mode === "demo"; };

export const saveLocal = (k, v) => { try { localStorage.setItem("jarys-ui:" + k, JSON.stringify(v)); } catch {} };
export const loadLocal = (k) => { try { return JSON.parse(localStorage.getItem("jarys-ui:" + k)); } catch { return null; } };
export const dropLocal = (k) => { try { localStorage.removeItem("jarys-ui:" + k); } catch {} };
