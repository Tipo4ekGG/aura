// Supabase Edge Function: send-push
// Вызывается из базы: записи ауры ({op, record}) и дела народного суда ({kind, record}).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.headers.get("x-aura-secret") !== Deno.env.get("AURA_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const { op, kind, record, to, topic, on_case } = await req.json();
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: profs } = await sb.from("profiles").select("id,display_name,notify_mode");
    const name = (id: string) => {
      const p = (profs ?? []).find((x) => x.id === id);
      return p ? (p.display_name || "Новичок") : "?";
    };
    const mode = (id: string) => (profs ?? []).find((p) => p.id === id)?.notify_mode ?? "all";

    let title = "", body = "", skip = "", about = "";
    let only: string[] | null = null;
    if (kind === "comment") {
      title = `💬 ${name(record.author)}`;
      body = `${String(record.body).slice(0, 140)}\n${on_case ? "К делу" : "К записи"} «${String(topic ?? "").slice(0, 60)}»`;
      skip = record.author;
      only = (Array.isArray(to) ? to : []).filter((x: string) => x && x !== record.author);
    } else if (kind === "case") {
      title = `⚖ Новое дело: ${name(record.accused)}`;
      body = `Обвиняет ${name(record.accuser)}: ${record.reason}\nНаказание −${record.amount}. Голосование 24 часа.`;
      skip = record.accuser; about = record.accused;
    } else if (kind === "acquitted") {
      title = `⚖ Оправдан: ${name(record.accused)}`;
      body = `Дело «${record.reason}» закрыто. За: ${record.votes_for}, против: ${record.votes_against}.`;
      about = record.accused;
    } else {
      const { data: bal } = await sb.from("balances").select("id,balance");
      const mine = (bal ?? []).find((x) => x.id === record.target)?.balance ?? 1000;
      const top = [...(bal ?? [])].sort((x, y) => y.balance - x.balance)[0];
      const n = Math.abs(record.amount);
      const sign = record.amount > 0 ? "+" : "−";
      const prefix = op === "UPDATE" ? "✏️ " : op === "DELETE" ? "🗑 " : record.amount > 0 ? "⬆ " : "⬇ ";
      title = `${prefix}${name(record.target)} ${sign}${n}`;
      body = `от ${name(record.author)}: ${record.reason ?? "без причины"}\n${name(record.target)}: ${mine}` +
        (top ? `\n🗿 Лидер: ${name(top.id)} — ${top.balance}` : "");
      skip = record.author; about = record.target;
    }
    const payload = JSON.stringify({ id: `${kind ?? "ev"}-${record.id}`, title, body });

    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT")!,
      Deno.env.get("VAPID_PUBLIC")!,
      Deno.env.get("VAPID_PRIVATE")!,
    );

    const { data: subs } = await sb.from("push_subs").select("endpoint,p256dh,auth,user_id");
    // режимы: all — всё, me — только про меня, off — ничего; автору не шлём
    const targets = (subs ?? []).filter((s) =>
      s.user_id !== skip && (only
        ? only.includes(s.user_id) && mode(s.user_id) !== "off"
        : (mode(s.user_id) === "all" || (mode(s.user_id) === "me" && s.user_id === about)))
    );
    console.log("вид:", kind ?? "event", "подписок:", subs?.length ?? 0, "получат:", targets.length);

    await Promise.all(targets.map(async (s) => {
      try {
        const res = await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600 },
        );
        console.log("отправлено:", s.endpoint.slice(0, 40), "статус", res.statusCode);
      } catch (e) {
        const err = e as { statusCode?: number; body?: string };
        console.error("ошибка отправки:", err.statusCode, err.body);
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
        }
      }
    }));

    return new Response("ok");
  } catch (e) {
    console.error("сбой функции:", String(e));
    return new Response("error: " + String(e), { status: 500 });
  }
});
