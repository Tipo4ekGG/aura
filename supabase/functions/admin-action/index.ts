// Supabase Edge Function: admin-action
// Действия только для админа: сброс пароля, удаление игрока, тестовое уведомление себе.
// Проверка: токен пользователя из заголовка Authorization + флаг is_admin в профиле.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

// запросы принимаются только со страницы приложения
const CORS = {
  "Access-Control-Allow-Origin": "https://tipo4ekgg.github.io",
  "Vary": "Origin",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "no_token" }, 401);
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: u, error: ue } = await sb.auth.getUser(token);
    if (ue || !u?.user) return json({ error: "bad_token" }, 401);
    const { data: me } = await sb.from("profiles").select("is_admin").eq("id", u.user.id).single();
    if (!me?.is_admin) return json({ error: "not_admin" }, 403);

    const { action, user_id, password } = await req.json();

    // тестовое уведомление: только на устройства самого админа
    if (action === "test_push") {
      webpush.setVapidDetails(
        Deno.env.get("VAPID_SUBJECT")!,
        Deno.env.get("VAPID_PUBLIC")!,
        Deno.env.get("VAPID_PRIVATE")!,
      );
      const { data: subs } = await sb.from("push_subs").select("endpoint,p256dh,auth").eq("user_id", u.user.id);
      const payload = JSON.stringify({
        id: "test-" + Date.now(),
        title: "🔔 Проверка уведомлений",
        body: "Если ты это видишь, уведомления на этом устройстве работают.",
      });
      let sent = 0, failed = 0;
      await Promise.all((subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 600 });
          sent++;
        } catch (e) {
          failed++;
          const code = (e as { statusCode?: number }).statusCode;
          console.error("тест: ошибка отправки", code);
          if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
        }
      }));
      console.log("тест уведомлений: устройств", subs?.length ?? 0, "отправлено", sent, "ошибок", failed);
      return json({ ok: true, devices: subs?.length ?? 0, sent, failed });
    }

    if (typeof user_id !== "string" || !/^[0-9a-f-]{36}$/.test(user_id)) return json({ error: "bad_user" }, 400);

    // журнал главного админа (без партии) виден только ему
    const { data: tp } = await sb.from("profiles").select("base_name,display_name,username").eq("id", user_id).single();
    const tname = tp?.base_name || tp?.display_name || tp?.username || "игрок";
    const log = (act: string, target: string | null, details: string) =>
      sb.from("admin_log").insert({ admin: u.user.id, action: act, target, details });

    if (action === "reset_password") {
      if (typeof password !== "string" || password.length < 6) return json({ error: "short_password" }, 400);
      const { error } = await sb.auth.admin.updateUserById(user_id, { password });
      if (error) return json({ error: error.message }, 400);
      await log("Сбросил пароль", user_id, tname);
      console.log("пароль сброшен для", user_id);
      return json({ ok: true });
    }
    if (action === "delete_user") {
      if (user_id === u.user.id) return json({ error: "self" }, 400);
      const { error } = await sb.auth.admin.deleteUser(user_id);
      if (error) return json({ error: error.message }, 400);
      await log("Удалил игрока", null, tname);
      console.log("игрок удалён", user_id);
      return json({ ok: true });
    }
    return json({ error: "bad_action" }, 400);
  } catch (e) {
    console.error("сбой:", String(e));
    return json({ error: "server" }, 500);
  }
});
