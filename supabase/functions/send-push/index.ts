// Supabase Edge Function: send-push
// Вызывается из базы: записи ауры ({op, record}), дела и апелляции суда, комментарии, дуэли, опросы ({kind, record}).
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

    const { data: profs } = await sb.from("profiles").select("id,base_name,display_name,notify_mode");
    // уведомление идёт только участникам той партии, где это случилось, и с именами из этой партии
    const pid = record?.party_id ?? null;
    const { data: mem } = pid
      ? await sb.from("party_members").select("user_id,display_name").eq("party_id", pid).is("left_at", null)
      : { data: [] as { user_id: string; display_name: string }[] };
    const { data: party } = pid ? await sb.from("parties").select("name").eq("id", pid).single() : { data: null };
    const members = new Set((mem ?? []).map((m) => m.user_id));
    const name = (id: string) => {
      const m = (mem ?? []).find((x) => x.user_id === id);
      if (m) return m.display_name;
      const p = (profs ?? []).find((x) => x.id === id);
      return p ? (p.base_name || p.display_name || "Новичок") : "?";
    };
    const mode = (id: string) => (profs ?? []).find((p) => p.id === id)?.notify_mode ?? "all";

    let title = "", body = "", skip = "", about = "";
    let only: string[] | null = null;
    if (kind === "comment") {
      title = `💬 ${name(record.author)}`;
      body = `${String(record.body).slice(0, 140)}\n${on_case ? "К делу" : "К записи"} «${String(topic ?? "").slice(0, 60)}»`;
      skip = record.author;
      only = (Array.isArray(to) ? to : []).filter((x: string) => x && x !== record.author);
    } else if (kind === "duel_challenge") {
      title = `🎲 ${name(record.challenger)} вызывает на дуэль`;
      body = `Ставка ${record.stake} ауры, шансы 50 на 50${record.note ? `: «${record.note}»` : ""}. Принять можно в течение суток.`;
      skip = record.challenger;
      only = [record.opponent];
    } else if (kind === "duel_done") {
      const loser = record.winner === record.challenger ? record.opponent : record.challenger;
      title = `🎲 ${name(record.winner)} выиграл дуэль: +${record.stake}`;
      body = `${name(loser)} теряет ${record.stake} ауры${record.note ? `. Спорили: «${record.note}»` : ""}.`;
      skip = record.opponent; about = record.challenger;
    } else if (kind === "poll") {
      const h = Math.max(1, Math.round((new Date(record.ends_at).getTime() - Date.now()) / 3600e3));
      title = `📊 Опрос партии от ${name(record.author)}`;
      body = `${String(record.question).slice(0, 120)}\nПобедитель получит ${record.sign > 0 ? "+" : "−"}${record.amount}. Голосование ${h} ч.`;
      skip = record.author;
    } else if (kind === "bet_offer") {
      title = `🤝 ${name(record.author)} предлагает пари`;
      body = `«${String(record.claim).slice(0, 120)}»\nСтавка ${record.stake} ауры. Принять можно в течение суток.`;
      skip = record.author;
      only = [record.opponent];
    } else if (kind === "bet_open") {
      title = `🤝 Пари: ${name(record.author)} против ${name(record.opponent)}`;
      body = `«${String(record.claim).slice(0, 120)}»\nКто прав? Голосование ${record.days} ${record.days === 1 ? "день" : record.days < 5 ? "дня" : "дней"}, ставка ${record.stake}.`;
      skip = record.opponent;
      only = [...members].filter((id) => id !== record.author && id !== record.opponent);
    } else if (kind === "bet_done") {
      const loser = record.winner === record.author ? record.opponent : record.author;
      title = `🤝 ${name(record.winner)} выиграл пари: +${record.stake}`;
      body = `«${String(record.claim).slice(0, 120)}»\n${name(loser)} теряет ${record.stake} ауры.`;
      about = record.winner;
    } else if (kind === "meetup") {
      const when = new Date(record.starts_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
      title = `🍢 Сходка: ${String(record.title).slice(0, 60)}`;
      body = `${name(record.author)} зовёт: ${when}${record.place ? `, ${String(record.place).slice(0, 60)}` : ""}.\nПришедшим +${record.reward}${record.penalty ? `, записался и не пришёл −${record.penalty}` : ""}.`;
      skip = record.author;
    } else if (kind === "duel_declined") {
      title = `🎲 ${name(record.opponent)} отказался от дуэли`;
      body = `Ставка была ${record.stake} ауры. Аура никуда не ушла.`;
      only = [record.challenger];
    } else if (kind === "appeal") {
      title = `⚖ Апелляция: ${name(record.accuser)}`;
      body = `Оспаривает −${record.amount} от ${name(record.accused)} «${String(topic ?? "").slice(0, 60)}»\nДовод: ${record.reason}. Голосование 24 часа.`;
      skip = record.accuser; about = record.accused;
    } else if (kind === "appeal_granted") {
      title = `⚖ Аура возвращена: ${name(record.accuser)} +${record.amount}`;
      body = record.conceded_by
        ? `${name(record.conceded_by)} согласился отменить снятие «${String(topic ?? "").slice(0, 60)}».`
        : `Суд отменил снятие «${String(topic ?? "").slice(0, 60)}». За возврат: ${record.votes_for}, против: ${record.votes_against}.`;
      skip = record.conceded_by ?? ""; about = record.accuser;
    } else if (kind === "appeal_denied") {
      title = `⚖ Апелляция отклонена: ${name(record.accuser)}`;
      body = `Снятие −${record.amount} «${String(topic ?? "").slice(0, 60)}» остаётся. За возврат: ${record.votes_for}, против: ${record.votes_against}.`;
      about = record.accuser;
    } else if (kind === "case") {
      title = `⚖ Новое дело: ${name(record.accused)}`;
      body = `Обвиняет ${name(record.accuser)}: ${record.reason}\nНаказание −${record.amount}. Голосование 24 часа.`;
      skip = record.accuser; about = record.accused;
    } else if (kind === "acquitted") {
      title = `⚖ Оправдан: ${name(record.accused)}`;
      body = `Дело «${record.reason}» закрыто. За: ${record.votes_for}, против: ${record.votes_against}.`;
      about = record.accused;
    } else {
      // балансы внутри партии (служебный ключ: представление считает всех)
      const { data: evs } = await sb.from("aura_events").select("target,amount").eq("party_id", pid).is("overturned_at", null);
      const sums: Record<string, number> = {};
      [...members].forEach((id) => sums[id] = 1000);
      (evs ?? []).forEach((e) => { if (e.target in sums) sums[e.target] += e.amount; });
      const bal = Object.entries(sums).map(([id, balance]) => ({ id, balance }));
      const mine = sums[record.target] ?? 1000;
      const top = [...bal].sort((x, y) => y.balance - x.balance)[0];
      const n = Math.abs(record.amount);
      const sign = record.amount > 0 ? "+" : "−";
      const prefix = op === "UPDATE" ? "✏️ " : op === "DELETE" ? "🗑 " : record.amount > 0 ? "⬆ " : "⬇ ";
      title = `${prefix}${name(record.target)} ${sign}${n}`;
      body = `от ${name(record.author)}: ${record.reason ?? "без причины"}\n${name(record.target)}: ${mine}` +
        (top ? `\n🗿 Лидер: ${name(top.id)} — ${top.balance}` : "");
      skip = record.author; about = record.target;
    }
    if (party?.name) body += `\n🏛 ${party.name}`;
    const payload = JSON.stringify({ id: `${kind ?? "ev"}-${record.id}`, title, body, url: pid ? `./?party=${pid}` : "./" });

    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT")!,
      Deno.env.get("VAPID_PUBLIC")!,
      Deno.env.get("VAPID_PRIVATE")!,
    );

    const { data: subs } = await sb.from("push_subs").select("endpoint,p256dh,auth,user_id");
    // режимы: all — всё, me — только про меня, off — ничего; автору не шлём
    const targets = (subs ?? []).filter((s) =>
      s.user_id !== skip && (!pid || members.has(s.user_id)) && (only
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
