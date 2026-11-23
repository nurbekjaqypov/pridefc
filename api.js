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
  if (await store.get("demo-seeded5")) return;
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
  // история за 45 дней — чтобы в «Финансах» было что показать
  const names = [["Ерлан", "+77011234567"], ["Айдос", "+77059876543"], ["Нурлан", "+77012223344"], ["Тимур", "+77473334455"], ["Самат", "+77085556677"], ["Данияр", "+77071112233"], ["Арман", "+77024445566"], ["Команда «Барыс»", "+77770001122"], ["Бекзат", "+77756667788"], ["Ильяс", "+77013339900"]];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cfg = (await api.handle("GET", "/admin/config", {}, {}, A)).body;
  for (let i = -45; i < 0; i++) {
    const date = addDays(t, i), wd = new Date(date + "T00:00:00Z").getUTCDay();
    for (const f of cfg.fields) {
      const taken = new Set();
      const n = Math.round(rnd() * 4 + (wd === 0 || wd === 6 ? 4 : 2));
      for (let k = 0; k < n; k++) {
        const h0 = rnd() < 0.7 ? 17 + Math.floor(rnd() * 7) : 8 + Math.floor(rnd() * 9);
        const hours = rnd() < 0.3 ? [h0, h0 + 1] : [h0];
        if (hours.some((h) => taken.has(h) || h >= cfg.close)) continue;
        hours.forEach((h) => taken.add(h));
        const [name, phone] = names[Math.floor(rnd() * names.length)];
        const r = await api.handle("POST", "/admin/book", {}, { date, fieldId: f.id, hours, name, phone, status: rnd() < 0.75 ? "paid" : "unpaid" }, A);
        const id = r.body?.made?.[0]?.id;
        if (!id) continue;
        const b = await store.get(`bk/${date}/${id}`);
        const x = rnd();
        await store.set(`bk/${date}/${id}`, { ...b, source: x < 0.6 ? "site" : "admin", ...(x > 0.94 ? { status: "cancelled" } : {}) });
      }
    }
  }
  await store.set("demo-seeded5", true);
}

async function detect() {
  if (mode) return;
  try {
    const r = await fetch("/api/config", { headers: { accept: "application/json" } });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) { mode = "server"; return; }
  } catch {}
  mode = "demo";
  const store = localAdapter();
  local = createApi(store, { adminPassword: "demo" });
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
