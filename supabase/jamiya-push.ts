import webpush from "npm:web-push@3.6.7";

const BASE = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || SVC;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
const TIPS = [
  "خصّص قسط الجمعية من أول الراتب قبل أي مصروف، ولا تنتظر ما يتبقى آخر الشهر.",
  "جهّز صندوق طوارئ يكفي مصاريفك الأساسية من 3 إلى 6 أشهر، فهو يحميك من الاستدانة.",
  "دوّن مصاريفك أسبوعًا واحدًا فقط، وستكتشف أين يذهب مالك فعلًا.",
  "قاعدة 50/30/20: نصف دخلك للاحتياجات، و30% للرغبات، و20% للادخار.",
  "لا تقترض لتسديد قسط الجمعية. إن ضاق عليك الشهر فتواصل مع الإدارة مبكرًا.",
  "قبل أي شراء كبير انتظر 48 ساعة؛ كثير من المشتريات تفقد جاذبيتها بعدها.",
  "حين يحين دورك في الاستلام، ضع خطة مكتوبة للمبلغ: سداد دين، ادخار، وهدف واحد مهم.",
  "سدّد الديون ذات الفوائد الأعلى أولًا، فهي أكثر ما يستنزف دخلك.",
  "خصّص مبلغًا ثابتًا شهريًا للمناسبات والأعياد والأعراس حتى لا تربك ميزانيتك.",
  "راجع اشتراكاتك الشهرية من تطبيقات وقنوات، وألغِ ما لا تستخدمه.",
  "إذا زاد دخلك فاحتفظ بالزيادة للادخار بدل رفع مستوى الصرف.",
  "قارن الأسعار قبل الشراء، واحذر من التقسيط لما لا تحتاجه.",
];
// الجدول الافتراضي للتنبيهات التلقائية (يمكن تعديله من لوحة التحكم)، الساعة بتوقيت مسقط
const DEF: Record<string, { on: boolean; day: number; hour: number }> = {
  pay1: { on: true, day: 23, hour: 9 },
  pay2: { on: true, day: 27, hour: 9 },
  turn: { on: true, day: 1, hour: 9 },
  milestone: { on: true, day: 1, hour: 9 },
  tip: { on: true, day: 15, hour: 18 },
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function rpc(fn: string, args: unknown, key: string) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_) {}
  try {
    const dump = await rpc("jamiya_push_dump", {}, SVC);
    const conf = dump.conf || {};
    // التحقق: مؤقّت مجدول (سر) أو مستخدم لوحة التحكم (اسم + كلمة مرور + صلاحية)
    if (body.mode === "cron") {
      if (!conf.cron_secret || req.headers.get("x-cron-secret") !== conf.cron_secret) return json({ error: "unauthorized" }, 401);
    } else if (body.mode === "now") {
      const me = await rpc("jamiya_me", { p_u: String(body.u || ""), p_p: String(body.p || "") }, ANON);
      if (!me) return json({ error: "unauthorized" }, 401);
      const need = body.kind === "custom" ? "notify" : "pay";
      if (!Array.isArray(me.perms) || !me.perms.includes(need)) return json({ error: "forbidden" }, 403);
    } else return json({ error: "mode" }, 400);

    const data = dump.data;
    if (!data || !data.settings || !Array.isArray(data.members)) return json({ skipped: "no-data" });
    const s = data.settings;
    const m4 = new Date(Date.now() + 4 * 3600 * 1000); // توقيت مسقط
    const y = m4.getUTCFullYear(), mo = m4.getUTCMonth() + 1;
    const key = `${y}-${String(mo).padStart(2, "0")}`;
    const N = Math.max(1, Math.round((Number(s.years) || 1) * 12));
    const idx = (y - Number(s.startYear)) * 12 + (mo - Number(s.startMonth));
    const inRange = idx >= 0 && idx < N;
    const title0 = s.name || "الجمعية";
    const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
    const members: any[] = data.members;
    const nameOf = new Map(members.map((m: any) => [m.id, m.name]));
    const subsAll: any[] = dump.subs || [];
    let vapidSet = false;

    // إرسال: قائمة اشتراكات + دالة تبني نص كل اشتراك
    async function push(subs: any[], mk: (sub: any) => { title?: string; body: string; tag: string }, dry = false) {
      if (dry) return { dry: true, subscribers: subs.length, sample: subs.length ? mk(subs[0]).body : null };
      if (!vapidSet) { webpush.setVapidDetails(conf.vapid_subject, conf.vapid_public, conf.vapid_private); vapidSet = true; }
      const dead: string[] = [];
      let sent = 0, failed = 0;
      await Promise.all(subs.map(async (sub: any) => {
        const p = mk(sub);
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ title: p.title || title0, body: p.body, tag: p.tag, url: "/" }), { TTL: 86400 });
          sent++;
        } catch (e: any) {
          failed++;
          if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(sub.endpoint);
        }
      }));
      if (dead.length) await rpc("jamiya_push_prune", { p_endpoints: dead }, SVC);
      return { sent, failed, pruned: dead.length };
    }

    async function run(kind: string, b: any) {
      const dry = !!b.dry;
      if (kind === "custom") {
        const text = String(b.text || "").trim().slice(0, 300);
        if (!text) return { error: "empty" };
        const title = String(b.title || "").trim().slice(0, 60) || title0;
        let ids: Set<string>;
        if (b.audience === "members" && Array.isArray(b.members)) ids = new Set(b.members.map(String));
        else if (b.audience === "unpaid") {
          const paid = new Set<string>((dump.payments || {})[key] || []);
          ids = new Set(members.filter((m: any) => Math.round(Number(m.monthly)) > 0 && !paid.has(m.id)).map((m: any) => m.id));
        } else ids = new Set(members.map((m: any) => m.id));
        const subs = subsAll.filter((x: any) => ids.has(x.member_id));
        const r = await push(subs, () => ({ title, body: text, tag: "custom-" + Date.now() }), dry);
        return { kind, members: new Set(subs.map((x: any) => x.member_id)).size, ...r };
      }
      if (kind === "turn") {
        const po = (data.payouts || {})[key];
        if (!inRange || !Array.isArray(po) || !po.length) return { skipped: "no-payout-data", key };
        const subs = subsAll.filter((x: any) => po.some((p: any) => p.id === x.member_id));
        const r = await push(subs, (sub) => {
          const p = po.find((q: any) => q.id === sub.member_id);
          return { body: `${nameOf.get(sub.member_id)}، دورك لاستلام الجمعية في ${MONTHS[mo - 1]} ${y}، بإذن الله بنهاية هذا الشهر. المبلغ: ${fmt(Number(p.amount))} ر.ع.`, tag: "turn-" + key };
        }, dry);
        return { kind, key, receivers: po.map((p: any) => ({ name: nameOf.get(p.id), amount: p.amount })), ...r };
      }
      if (kind === "milestone" || kind === "tip") {
        if (!inRange) return { skipped: "outside-range", key };
        const mem = members.filter((m: any) => Math.round(Number(m.monthly)) > 0);
        const pot = mem.reduce((a: number, m: any) => a + Math.round(Number(m.monthly)), 0);
        let text = "", tag = "";
        if (kind === "tip") {
          text = "نصيحة مالية: " + TIPS[idx % TIPS.length];
          tag = "tip-" + key;
        } else {
          const half = Math.floor(N / 2), phases = Math.ceil(N / 6);
          const lines: string[] = [];
          if (idx === 0) lines.push(`بدأت الجمعية اليوم. مدتها ${N} شهرًا، والوعاء الشهري ${fmt(pot)} ر.ع. بالتوفيق للجميع.`);
          else {
            if (N >= 2 && idx === half) lines.push(`وصلنا منتصف الجمعية! مرّ ${idx} شهرًا وبقي ${N - idx}. تم تجميع ${fmt(pot * idx)} ر.ع من أصل ${fmt(pot * N)} ر.ع.`);
            if (idx % 6 === 0 && idx > 0 && idx !== half) lines.push(`اكتمل الطور ${idx / 6} من ${phases} (${idx} أشهر). تم تجميع ${fmt(pot * idx)} ر.ع، وبقي ${N - idx} شهرًا.`);
            if (idx === N - 1) lines.push("هذا هو الشهر الأخير في الجمعية. شكرًا لالتزامكم، وبادروا بدفع القسط الأخير.");
          }
          if (!lines.length) return { skipped: "no-milestone", key, idx };
          text = lines.join(" ");
          tag = "ms-" + key;
        }
        const ids = new Set(mem.map((m: any) => m.id));
        const subs = subsAll.filter((x: any) => ids.has(x.member_id));
        const r = await push(subs, () => ({ body: text, tag }), dry);
        return { kind, key, text, ...r };
      }
      // تذكير الدفع (الافتراضي)
      if (!inRange) return { skipped: "outside-range", key };
      const paid = new Set<string>((dump.payments || {})[key] || []);
      let targets = members.filter((m: any) => Math.round(Number(m.monthly)) > 0 && !paid.has(m.id));
      if (b.member) targets = targets.filter((m: any) => m.id === String(b.member));
      const byId = new Map(targets.map((m: any) => [m.id, m]));
      const subs = subsAll.filter((x: any) => byId.has(x.member_id));
      const r = await push(subs, (sub) => {
        const m: any = byId.get(sub.member_id);
        return { body: `${m.name}، موعد دفع ${MONTHS[mo - 1]} ${y}: ${Math.round(Number(m.monthly))} ر.ع. بادر بالدفع.`, tag: "pay-" + key };
      }, dry);
      return { key, unpaid: targets.length, subscribed: new Set(subs.map((x: any) => x.member_id)).size, ...r };
    }

    // تشغيل تلقائي كل ساعة: ينفّذ ما حان موعده حسب الجدول المحفوظ
    if (body.mode === "cron" && body.kind === "auto") {
      let saved: any = {};
      try { saved = conf.notif ? JSON.parse(conf.notif) : {}; } catch (_) {}
      const day = m4.getUTCDate(), hour = m4.getUTCHours();
      const ran: Record<string, unknown> = {};
      for (const name of Object.keys(DEF)) {
        const c = { ...DEF[name], ...(saved[name] || {}) };
        if (!c.on || Number(c.day) !== day || Number(c.hour) !== hour) continue;
        ran[name] = await run(name === "pay1" || name === "pay2" ? "pay" : name, {});
      }
      return json({ auto: true, day, hour, ran });
    }

    const kind = ["custom", "turn", "milestone", "tip"].includes(body.kind) ? body.kind : "pay";
    return json(await run(kind, body));
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
