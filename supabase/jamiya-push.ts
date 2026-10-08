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
    // التحقق: مؤقّت مجدول (سر) أو أدمن (مستخدم + كلمة مرور)
    if (body.mode === "cron") {
      if (!conf.cron_secret || req.headers.get("x-cron-secret") !== conf.cron_secret) return json({ error: "unauthorized" }, 401);
    } else if (body.mode === "now") {
      const me = await rpc("jamiya_me", { p_u: String(body.u || ""), p_p: String(body.p || "") }, ANON);
      if (!me) return json({ error: "unauthorized" }, 401);
      if (!Array.isArray(me.perms) || !me.perms.includes("pay")) return json({ error: "forbidden" }, 403);
    } else return json({ error: "mode" }, 400);

    const data = dump.data;
    if (!data || !data.settings || !Array.isArray(data.members)) return json({ skipped: "no-data" });
    const s = data.settings;
    const m4 = new Date(Date.now() + 4 * 3600 * 1000); // توقيت مسقط
    const y = m4.getUTCFullYear(), mo = m4.getUTCMonth() + 1;
    const key = `${y}-${String(mo).padStart(2, "0")}`;
    const N = Math.max(1, Math.round((Number(s.years) || 1) * 12));
    const idx = (y - Number(s.startYear)) * 12 + (mo - Number(s.startMonth));
    if (idx < 0 || idx >= N) return json({ skipped: "outside-range", key });

    if (body.kind === "milestone" || body.kind === "tip") {
      const mem = data.members.filter((m: any) => Math.round(Number(m.monthly)) > 0);
      const pot = mem.reduce((a: number, m: any) => a + Math.round(Number(m.monthly)), 0);
      const fmt = (n: number) => n.toLocaleString("en-US");
      let title = s.name || "الجمعية", text = "", tag = "";
      if (body.kind === "tip") {
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
        if (!lines.length) return json({ skipped: "no-milestone", key, idx });
        text = lines.join(" ");
        tag = "ms-" + key;
      }
      const subsAll = dump.subs || [];
      const ids = new Set(mem.map((m: any) => m.id));
      const subsN = subsAll.filter((x: any) => ids.has(x.member_id));
      if (body.dry) return json({ dry: true, title, text, subscribers: subsN.length });
      webpush.setVapidDetails(conf.vapid_subject, conf.vapid_public, conf.vapid_private);
      const dead2: string[] = [];
      let ok = 0, bad = 0;
      await Promise.all(subsN.map(async (sub: any) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ title, body: text, tag, url: "/" }), { TTL: 86400 });
          ok++;
        } catch (e: any) {
          bad++;
          if (e && (e.statusCode === 404 || e.statusCode === 410)) dead2.push(sub.endpoint);
        }
      }));
      if (dead2.length) await rpc("jamiya_push_prune", { p_endpoints: dead2 }, SVC);
      return json({ kind: body.kind, key, sent: ok, failed: bad, pruned: dead2.length });
    }

    const paid = new Set<string>((dump.payments || {})[key] || []);
    let targets = data.members.filter((m: any) => Math.round(Number(m.monthly)) > 0 && !paid.has(m.id));
    if (body.member) targets = targets.filter((m: any) => m.id === String(body.member));
    const byId = new Map(targets.map((m: any) => [m.id, m]));
    const subs = (dump.subs || []).filter((x: any) => byId.has(x.member_id));

    webpush.setVapidDetails(conf.vapid_subject, conf.vapid_public, conf.vapid_private);
    const dead: string[] = [];
    let sent = 0, failed = 0;
    await Promise.all(subs.map(async (sub: any) => {
      const m: any = byId.get(sub.member_id);
      const payload = JSON.stringify({
        title: s.name || "الجمعية",
        body: `${m.name}، موعد دفع ${MONTHS[mo - 1]} ${y}: ${Math.round(Number(m.monthly))} ر.ع. بادر بالدفع.`,
        tag: "pay-" + key,
        url: "/",
      });
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400 });
        sent++;
      } catch (e: any) {
        failed++;
        if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(sub.endpoint);
      }
    }));
    if (dead.length) await rpc("jamiya_push_prune", { p_endpoints: dead }, SVC);
    return json({ key, unpaid: targets.length, subscribed: new Set(subs.map((x: any) => x.member_id)).size, sent, failed, pruned: dead.length });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
