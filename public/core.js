// PRIDE FC — общая логика бронирования.
// Один и тот же код работает на сервере (Netlify Function + Netlify Blobs)
// и в браузере в демо-режиме (localStorage).

export const DEFAULT_CONFIG = {
  name: "PRIDE FC",
  address: "Алматы",
  locations: [
    { id: "zh", name: "Жарокова", address: "ул. Жарокова, Алматы", map: "https://2gis.kz/almaty/search/pride%20fc/firm/70000001061219138?m=76.898251%2C43.243251%2F16.21" },
    { id: "mm", name: "Мамыр-1", address: "мкр. Мамыр-1, Алматы", map: "https://2gis.kz/almaty/search/pride%20fc/firm/70000001061337855/76.845982%2C43.212012?m=76.845982%2C43.212012%2F16.21" },
  ],
  phone: "+7 700 000 00 00",
  open: 8,            // первый час работы
  close: 24,          // час закрытия (можно до 26 = 02:00 ночи)
  daysAhead: 14,      // на сколько дней вперёд можно бронировать
  prepayPercent: 50,  // предоплата, % от суммы (0 = без предоплаты)
  holdMinutes: 15,    // сколько минут держим слот, пока клиент оплачивает
  kaspiLink: "",      // ссылка Kaspi Pay / Kaspi QR для оплаты
  kaspiPhone: "+7 700 000 00 00",
  kaspiName: "",       // получатель как в чеке Kaspi, напр. «Нурбек Ж.» — сверяется с чеком
  discounts: [],      // скидки: {id,title,percent,dateFrom,dateTo,days[],from,to,fields[],active}
  fields: [
    { id: "f1", locationId: "zh", name: "Поле 1", note: "", priceDay: 15000, priceEvening: 20000, eveningFrom: 18, priceWeekend: 22000, active: true },
    { id: "f2", locationId: "mm", name: "Поле 1", note: "", priceDay: 15000, priceEvening: 20000, eveningFrom: 18, priceWeekend: 22000, active: true },
  ],
};

const TZ = 5 * 3600e3; // Алматы, UTC+5

export const dayKey = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
export function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const weekday = (date) => new Date(date + "T00:00:00Z").getUTCDay(); // 0 = вс
export const slotStart = (date, h) => Date.parse(date + "T00:00:00Z") - TZ + h * 3600e3;
export const hourLabel = (h) => String(h % 24).padStart(2, "0") + ":00";
export const rangeLabel = (hours) => {
  const s = [...hours].sort((a, b) => a - b);
  const parts = [];
  let a = s[0], b = s[0];
  for (let i = 1; i <= s.length; i++) {
    if (s[i] === b + 1) { b = s[i]; continue; }
    parts.push(hourLabel(a) + "–" + hourLabel(b + 1));
    a = b = s[i];
  }
  return parts.join(", ");
};
export const money = (n) => Math.round(n || 0).toLocaleString("ru-RU").replace(/,/g, " ") + " ₸";

export function priceFor(field, date, h) {
  const wd = weekday(date);
  if ((wd === 0 || wd === 6) && field.priceWeekend) return +field.priceWeekend;
  return h >= +field.eveningFrom ? +field.priceEvening : +field.priceDay;
}

export function discountFor(cfg, fieldId, date, h) {
  let best = null;
  const wd = weekday(date);
  for (const d of cfg.discounts || []) {
    if (d.active === false || !(d.percent > 0)) continue;
    if (d.dateFrom && date < d.dateFrom) continue;
    if (d.dateTo && date > d.dateTo) continue;
    if (d.days?.length && !d.days.includes(wd)) continue;
    if (h < d.from || h >= d.to) continue;
    if (d.fields?.length && !d.fields.includes(fieldId)) continue;
    if (!best || d.percent > best.percent) best = d;
  }
  return best;
}

export function priceInfo(cfg, field, date, h) {
  const base = priceFor(field, date, h);
  const d = discountFor(cfg, field.id, date, h);
  const price = d ? Math.round((base * (100 - d.percent)) / 100 / 100) * 100 : base;
  return { base, price, pct: d ? d.percent : 0, promo: d ? d.title : "" };
}

export const promosForDay = (cfg, date) => {
  const wd = weekday(date);
  return (cfg.discounts || []).filter((d) => d.active !== false && d.percent > 0 &&
    (!d.dateFrom || date >= d.dateFrom) && (!d.dateTo || date <= d.dateTo) && (!d.days?.length || d.days.includes(wd)));
};

export function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  return d.length === 11 ? "+" + d : "";
}

const rid = (n = 10) => {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  const r = (globalThis.crypto?.getRandomValues?.(new Uint8Array(n))) || Array.from({ length: n }, () => Math.random() * 256);
  for (let i = 0; i < n; i++) s += a[r[i] % a.length];
  return s;
};

const ok = (body) => ({ status: 200, body });
const err = (status, error) => ({ status, body: { error } });
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");

// store: { get(k), getE(k) -> {data, etag}, set(k, v, {onlyIfNew|onlyIfMatch}) -> {modified}, del(k), list(prefix) -> keys }
export function createApi(store, { adminPassword, now = () => Date.now(), recognize = null } = {}) {
  const getConfig = async () => {
    const saved = (await store.get("config")) || {};
    const c = { ...DEFAULT_CONFIG, ...saved, fields: saved.fields || DEFAULT_CONFIG.fields, locations: saved.locations?.length ? saved.locations : DEFAULT_CONFIG.locations };
    const first = c.locations[0].id;
    c.fields = c.fields.map((f) => (c.locations.some((l) => l.id === f.locationId) ? f : { ...f, locationId: first }));
    return c;
  };

  const live = (b) => b.status !== "cancelled" && !(b.status === "hold" && b.exp <= now());
  const view = (b) => ({ ...b, live: live(b), expired: b.status === "hold" && b.exp <= now() });

  async function dayBookings(date) {
    const keys = await store.list(`bk/${date}/`);
    const all = await Promise.all(keys.map((k) => store.get(k)));
    return all.filter(Boolean).map(view).sort((a, b) => a.hours[0] - b.hours[0]);
  }

  const slotKey = (date, f, h) => `slot/${date}/${f}/${h}`;

  async function lockOne(date, f, h, id, exp) {
    const key = slotKey(date, f, h);
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await store.set(key, { id, exp }, { onlyIfNew: true });
      if (r?.modified !== false) return true;
      const cur = await store.getE(key);
      if (!cur) continue;
      if (cur.data?.id === id) return true;
      let stale = cur.data?.exp && cur.data.exp <= now();
      if (!stale) {
        const other = await store.get(`bk/${date}/${cur.data?.id}`);
        stale = !other || !live(other);
      }
      if (!stale) return false;
      const r2 = await store.set(key, { id, exp }, { onlyIfMatch: cur.etag });
      if (r2?.modified !== false) return true;
    }
    return false;
  }

  async function lockSlots(b) {
    const got = [];
    for (const h of b.hours) {
      if (await lockOne(b.date, b.fieldId, h, b.id, b.exp || null)) got.push(h);
      else { await releaseSlots({ ...b, hours: got }); return h; }
    }
    return null;
  }

  async function releaseSlots(b) {
    for (const h of b.hours) {
      const key = slotKey(b.date, b.fieldId, h);
      const cur = await store.get(key);
      if (cur && cur.id === b.id) await store.del(key);
    }
  }

  async function touchClient(phone, name, patch = {}) {
    const key = `client/${phone}`;
    const c = (await store.get(key)) || { phone, name, regular: false, count: 0, note: "", since: now() };
    const next = { ...c, name: name || c.name, ...patch };
    await store.set(key, next);
    return next;
  }

  function validateSlots(cfg, date, fieldId, hours, { publicSide }) {
    if (!isDate(date)) return "Неверная дата";
    const field = cfg.fields.find((f) => f.id === fieldId && f.active !== false);
    if (!field) return "Поле не найдено";
    if (!Array.isArray(hours) || !hours.length) return "Выберите время";
    if (new Set(hours).size !== hours.length) return "Повтор часов";
    for (const h of hours) {
      if (!Number.isInteger(h) || h < cfg.open || h >= cfg.close) return "Время вне графика работы";
      if (publicSide && slotStart(date, h) <= now()) return "Это время уже прошло";
    }
    if (publicSide) {
      const today = dayKey(now());
      if (date < today || date > addDays(today, cfg.daysAhead)) return "Эта дата недоступна";
      if (hours.length > 6) return "Не больше 6 часов за раз";
    }
    return null;
  }

  async function createBooking(b) {
    await store.set(`bk/${b.date}/${b.id}`, b);
    const fail = await lockSlots(b);
    if (fail !== null) {
      await store.del(`bk/${b.date}/${b.id}`);
      return fail;
    }
    return null;
  }

  async function saveBooking(b) { await store.set(`bk/${b.date}/${b.id}`, b); }

  // ---------- публичные запросы ----------
  const pub = {
    "GET /config": async () => {
      const c = await getConfig();
      return ok({ ...c, fields: c.fields.filter((f) => f.active !== false), today: dayKey(now()) });
    },

    "GET /day": async (q) => {
      if (!isDate(q.date)) return err(400, "Неверная дата");
      const cfg = await getConfig();
      const bks = (await dayBookings(q.date)).filter((b) => b.live);
      const fields = cfg.fields.filter((f) => f.active !== false).map((f) => {
        const busy = new Set(bks.filter((b) => b.fieldId === f.id).flatMap((b) => b.hours));
        const slots = [];
        for (let h = cfg.open; h < cfg.close; h++) {
          slots.push({ h, ...priceInfo(cfg, f, q.date, h), state: slotStart(q.date, h) <= now() ? "past" : busy.has(h) ? "busy" : "free" });
        }
        return { id: f.id, locationId: f.locationId, name: f.name, note: f.note, slots };
      });
      const promos = promosForDay(cfg, q.date).map(({ title, percent, from, to, fields }) => ({ title, percent, from, to, fields }));
      return ok({ date: q.date, fields, promos });
    },

    "POST /book": async (_q, body) => {
      const cfg = await getConfig();
      const hours = (body.hours || []).map(Number).sort((a, b) => a - b);
      const bad = validateSlots(cfg, body.date, body.fieldId, hours, { publicSide: true });
      if (bad) return err(400, bad);
      const name = String(body.name || "").trim().slice(0, 60);
      const phone = normPhone(body.phone);
      if (name.length < 2) return err(400, "Укажите имя");
      if (!phone) return err(400, "Укажите номер телефона");
      const field = cfg.fields.find((f) => f.id === body.fieldId);
      const total = hours.reduce((s, h) => s + priceInfo(cfg, field, body.date, h).price, 0);
      const fullTotal = hours.reduce((s, h) => s + priceFor(field, body.date, h), 0);
      const pct = +cfg.prepayPercent || 0;
      const prepay = Math.round((total * pct) / 100);
      const client = await store.get(`client/${phone}`);
      const loc = cfg.locations.find((l) => l.id === field.locationId);
      const b = {
        id: rid(), date: body.date, fieldId: field.id, fieldName: field.name, locationId: loc?.id, locationName: loc?.name || "", hours, name, phone,
        total, fullTotal, prepay, status: pct > 0 ? "hold" : "unpaid", exp: pct > 0 ? now() + cfg.holdMinutes * 60e3 : null,
        source: "site", regular: !!client?.regular, note: "", createdAt: now(),
      };
      const fail = await createBooking(b);
      if (fail !== null) return err(409, `Время ${hourLabel(fail)} уже заняли — выберите другое`);
      await touchClient(phone, name, { count: (client?.count || 0) + 1, last: b.date });
      return ok({ booking: view(b) });
    },

    "GET /booking": async (q) => {
      if (!isDate(q.date)) return err(400, "Неверная дата");
      const b = await store.get(`bk/${q.date}/${q.id}`);
      if (!b) return err(404, "Бронь не найдена");
      const { phone, note, ...rest } = view(b);
      if (rest.receipt) rest.receipt = { checks: rest.receipt.checks };
      return ok({ booking: rest });
    },

    "POST /receipt": async (_q, body) => {
      if (!isDate(body.date)) return err(400, "Неверная дата");
      const b = await store.get(`bk/${body.date}/${body.id}`);
      if (!b) return err(404, "Бронь не найдена");
      if (b.status !== "hold") return ok({ booking: view(b) });
      const types = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
      if (!types.includes(body.type)) return err(400, "Прикрепите PDF или фото/скриншот чека");
      if (!body.b64 || body.b64.length > 5.6e6) return err(400, "Файл слишком большой (до 4 МБ)");
      await store.set(`file/${b.id}`, { type: body.type, b64: body.b64 });

      const cfg = await getConfig();
      let r = null;
      try { r = recognize ? await recognize({ type: body.type, b64: body.b64 }, { booking: b, cfg }) : null; } catch { r = null; }
      const checks = [];
      const add = (okay, text) => checks.push({ ok: !!okay, text });
      if (!r) add(false, "Не удалось распознать чек — попробуйте PDF из Kaspi или чёткий скриншот");
      else {
        add(r.is_kaspi && r.status_ok !== false, "Это успешный перевод/платёж Kaspi");
        add(+r.amount >= b.prepay, `Сумма не меньше ${money(b.prepay)}` + (r.amount ? ` (в чеке ${money(r.amount)})` : ""));
        if (cfg.kaspiName) {
          const n = (x) => String(x || "").toLowerCase().replace(/[^a-zа-яёәғқңөұүһі0-9]/gi, "");
          const a = n(r.recipient), e = n(cfg.kaspiName);
          add(a && (a.includes(e) || e.includes(a)), `Получатель — ${cfg.kaspiName}` + (r.recipient ? ` (в чеке «${r.recipient}»)` : ""));
        }
        const ts = r.datetime ? Date.parse(String(r.datetime).trim().replace(" ", "T") + ":00Z") - TZ : NaN;
        add(ts >= b.createdAt - 10 * 60e3 && ts <= now() + 10 * 60e3, "Оплата сделана после создания брони");
        add(!!r.number, "Виден номер квитанции");
      }
      let next = { ...b, receipt: { ...(r || {}), checks, at: now() } };
      if (checks.every((c) => c.ok)) {
        const num = String(r.number).replace(/\s/g, "").toUpperCase();
        const w = await store.set(`rcpt/${num}`, { id: b.id, date: b.date }, { onlyIfNew: true });
        if (w?.modified === false) {
          const used = await store.get(`rcpt/${num}`);
          if (used?.id !== b.id) next.receipt.checks.push({ ok: false, text: "Этот чек уже использован для другой брони" });
        }
      }
      if (next.receipt.checks.every((c) => c.ok)) {
        next = { ...next, status: "prelim", exp: null, paidAt: now() };
        if ((await lockSlots(next)) !== null) return err(409, "Время на оплату вышло, и слот уже заняли. Свяжитесь с администратором для возврата.");
      }
      await saveBooking(next);
      return ok({ booking: view(next) });
    },

    "POST /claim": async (_q, body) => {
      if (!isDate(body.date)) return err(400, "Неверная дата");
      const b = await store.get(`bk/${body.date}/${body.id}`);
      if (!b) return err(404, "Бронь не найдена");
      if (b.status !== "hold") return ok({ booking: view(b) });
      if (!b.receipt) return err(400, "Сначала прикрепите чек");
      const next = { ...b, status: "claimed", exp: null, claimedAt: now() };
      const fail = await lockSlots(next); // обновит или вернёт слоты, если время на оплату вышло
      if (fail !== null) return err(409, "Время на оплату вышло, и слот уже заняли. Свяжитесь с администратором для возврата.");
      await saveBooking(next);
      return ok({ booking: view(next) });
    },
  };

  // ---------- админка ----------
  const admin = {
    "GET /admin/check": async () => ok({ ok: true }),

    "GET /admin/config": async () => ok(await getConfig()),

    "GET /admin/receipt": async (q) => {
      const f = await store.get(`file/${q.id}`);
      return f ? ok(f) : err(404, "Чек не прикреплён");
    },

    "POST /admin/discounts": async (_q, body) => {
      const cfg = await getConfig();
      const ids = new Set(cfg.fields.map((f) => f.id));
      const discounts = (body.discounts || []).slice(0, 50).map((d) => ({
        id: /^[a-z0-9]{4,12}$/.test(d.id || "") ? d.id : rid(6),
        title: String(d.title || "Скидка").slice(0, 60),
        percent: Math.min(Math.max(parseInt(d.percent) || 0, 1), 90),
        dateFrom: isDate(d.dateFrom) ? d.dateFrom : "",
        dateTo: isDate(d.dateTo) ? d.dateTo : "",
        days: (d.days || []).map(Number).filter((x) => x >= 0 && x <= 6),
        from: Math.min(Math.max(parseInt(d.from) || 0, 0), 28),
        to: Math.min(Math.max(parseInt(d.to) || 24, 1), 28),
        fields: (d.fields || []).filter((x) => ids.has(x)),
        active: d.active !== false,
      })).filter((d) => d.to > d.from);
      const saved = (await store.get("config")) || {};
      await store.set("config", { ...DEFAULT_CONFIG, ...saved, fields: cfg.fields, discounts });
      return ok({ discounts });
    },

    "GET /admin/day": async (q) => {
      if (!isDate(q.date)) return err(400, "Неверная дата");
      return ok({ bookings: await dayBookings(q.date) });
    },

    "GET /admin/pending": async () => {
      const cfg = await getConfig();
      const today = dayKey(now());
      const out = [];
      for (let i = -1; i <= cfg.daysAhead; i++) {
        const d = addDays(today, i);
        for (const b of await dayBookings(d)) if (b.live && ["hold", "claimed", "prelim"].includes(b.status)) out.push(b);
      }
      return ok({ bookings: out });
    },

    "POST /admin/book": async (_q, body) => {
      const cfg = await getConfig();
      const hours = (body.hours || []).map(Number).sort((a, b) => a - b);
      const bad = validateSlots(cfg, body.date, body.fieldId, hours, { publicSide: false });
      if (bad) return err(400, bad);
      const name = String(body.name || "").trim().slice(0, 60) || "Без имени";
      const phone = normPhone(body.phone);
      const field = cfg.fields.find((f) => f.id === body.fieldId);
      const weeks = Math.min(Math.max(parseInt(body.weeks) || 1, 1), 26);
      const series = weeks > 1 ? rid(8) : null;
      const made = [], skipped = [];
      for (let k = 0; k < weeks; k++) {
        const date = addDays(body.date, 7 * k);
        const auto = hours.reduce((s, h) => s + priceInfo(cfg, field, date, h).price, 0);
        const total = body.total ? Math.round(+body.total) : auto;
        const loc = cfg.locations.find((l) => l.id === field.locationId);
        const b = {
          id: rid(), date, fieldId: field.id, fieldName: field.name, locationId: loc?.id, locationName: loc?.name || "", hours, name, phone,
          total, prepay: body.status === "paid" ? Math.round((total * (+cfg.prepayPercent || 0)) / 100) : 0,
          status: body.status === "paid" ? "paid" : "unpaid", exp: null, source: "admin",
          regular: !!body.regular || weeks > 1, series, note: String(body.note || "").slice(0, 300), createdAt: now(),
        };
        if ((await createBooking(b)) === null) made.push({ date, id: b.id });
        else skipped.push(date);
      }
      if (series) await store.set(`series/${series}`, made);
      if (phone) {
        const c = await store.get(`client/${phone}`);
        await touchClient(phone, name, { count: (c?.count || 0) + made.length, last: body.date, ...(body.regular || weeks > 1 ? { regular: true } : {}) });
      }
      if (!made.length) return err(409, "Это время уже занято");
      return ok({ made, skipped });
    },

    "POST /admin/status": async (_q, body) => {
      const b = await store.get(`bk/${body.date}/${body.id}`);
      if (!b) return err(404, "Бронь не найдена");
      const st = body.status;
      if (!["paid", "unpaid", "cancelled", "done"].includes(st)) return err(400, "Неверный статус");
      let targets = [b];
      if (st === "cancelled" && body.all && b.series) {
        const list = (await store.get(`series/${b.series}`)) || [];
        targets = (await Promise.all(list.filter((x) => x.date >= b.date).map((x) => store.get(`bk/${x.date}/${x.id}`)))).filter(Boolean);
      }
      const pct = +(await getConfig()).prepayPercent || 0;
      for (const t of targets) {
        if (st === "cancelled") {
          await releaseSlots(t);
          await saveBooking({ ...t, status: "cancelled", cancelledAt: now() });
        } else {
          const next = { ...t, status: st, exp: null, prepay: st === "paid" && !t.prepay ? Math.round((t.total * pct) / 100) : t.prepay };
          if (["cancelled", "hold", "claimed", "prelim"].includes(t.status)) {
            if ((await lockSlots(next)) !== null) return err(409, "Это время уже занято другой бронью");
          }
          await saveBooking(next);
        }
      }
      return ok({ count: targets.length });
    },

    "POST /admin/update": async (_q, body) => {
      const b = await store.get(`bk/${body.date}/${body.id}`);
      if (!b) return err(404, "Бронь не найдена");
      const next = { ...b };
      if (body.name != null) next.name = String(body.name).slice(0, 60);
      if (body.phone != null) next.phone = normPhone(body.phone) || b.phone;
      if (body.note != null) next.note = String(body.note).slice(0, 300);
      if (body.total != null && +body.total >= 0) next.total = Math.round(+body.total);
      if (body.prepay != null && +body.prepay >= 0) next.prepay = Math.round(+body.prepay);
      await saveBooking(next);
      return ok({ booking: view(next) });
    },

    "POST /admin/config": async (_q, body) => {
      const c = body.config || {};
      const clean = {
        name: String(c.name || "PRIDE FC").slice(0, 60),
        address: String(c.address || "").slice(0, 120),
        phone: String(c.phone || "").slice(0, 30),
        open: Math.min(Math.max(parseInt(c.open) || 0, 0), 23),
        close: Math.min(Math.max(parseInt(c.close) || 24, 1), 28),
        daysAhead: Math.min(Math.max(parseInt(c.daysAhead) || 14, 1), 90),
        prepayPercent: Math.min(Math.max(parseInt(c.prepayPercent) || 0, 0), 100),
        holdMinutes: Math.min(Math.max(parseInt(c.holdMinutes) || 15, 5), 120),
        kaspiLink: String(c.kaspiLink || "").slice(0, 300),
        kaspiPhone: String(c.kaspiPhone || "").slice(0, 30),
        kaspiName: String(c.kaspiName || "").slice(0, 60),
        locations: (c.locations || []).slice(0, 10).map((l) => ({
          id: /^[a-z0-9]{2,12}$/.test(l.id || "") ? l.id : "l" + rid(5),
          name: String(l.name || "Адрес").slice(0, 40), address: String(l.address || "").slice(0, 120),
          map: /^https:\/\//.test(l.map || "") ? String(l.map).slice(0, 400) : "",
        })),
        fields: (c.fields || []).slice(0, 24).map((f) => ({
          id: /^[a-z0-9]{2,12}$/.test(f.id || "") ? f.id : "f" + rid(5),
          locationId: String(f.locationId || ""),
          name: String(f.name || "Поле").slice(0, 40), note: String(f.note || "").slice(0, 80),
          priceDay: Math.max(0, +f.priceDay || 0), priceEvening: Math.max(0, +f.priceEvening || 0),
          eveningFrom: Math.min(Math.max(parseInt(f.eveningFrom) || 18, 0), 28), priceWeekend: Math.max(0, +f.priceWeekend || 0),
          active: f.active !== false,
        })),
      };
      if (clean.close <= clean.open) return err(400, "Время закрытия должно быть позже открытия");
      if (!clean.fields.length) return err(400, "Добавьте хотя бы одно поле");
      if (!clean.locations.length) return err(400, "Добавьте хотя бы один адрес");
      clean.fields = clean.fields.map((f) => (clean.locations.some((l) => l.id === f.locationId) ? f : { ...f, locationId: clean.locations[0].id }));
      clean.discounts = (await getConfig()).discounts || [];
      await store.set("config", clean);
      return ok({ config: clean });
    },

    "GET /admin/clients": async () => {
      const keys = await store.list("client/");
      const all = (await Promise.all(keys.map((k) => store.get(k)))).filter(Boolean);
      return ok({ clients: all.sort((a, b) => (b.regular - a.regular) || (b.count - a.count)) });
    },

    "POST /admin/client": async (_q, body) => {
      const phone = normPhone(body.phone);
      if (!phone) return err(400, "Неверный номер");
      const patch = {};
      if (body.regular != null) patch.regular = !!body.regular;
      if (body.note != null) patch.note = String(body.note).slice(0, 300);
      return ok({ client: await touchClient(phone, body.name ? String(body.name).slice(0, 60) : "", patch) });
    },
  };

  return {
    async handle(method, path, query = {}, body = {}, { admin: pass } = {}) {
      const key = `${method} ${path.replace(/\/+$/, "")}`;
      try {
        if (pub[key]) return await pub[key](query, body);
        if (admin[key]) {
          if (!adminPassword || pass !== adminPassword) return err(401, "Неверный пароль");
          return await admin[key](query, body);
        }
        return err(404, "Не найдено");
      } catch (e) {
        return err(500, "Ошибка сервера: " + (e?.message || e));
      }
    },
  };
}
