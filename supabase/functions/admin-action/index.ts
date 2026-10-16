// Supabase Edge Function: admin-action
// Действия только для админа: сброс пароля и удаление игрока.
// Проверка: токен пользователя из заголовка Authorization + флаг is_admin в профиле.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
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
    if (typeof user_id !== "string" || !/^[0-9a-f-]{36}$/.test(user_id)) return json({ error: "bad_user" }, 400);

    if (action === "reset_password") {
      if (typeof password !== "string" || password.length < 6) return json({ error: "short_password" }, 400);
      const { error } = await sb.auth.admin.updateUserById(user_id, { password });
      if (error) return json({ error: error.message }, 400);
      console.log("пароль сброшен для", user_id);
      return json({ ok: true });
    }
    if (action === "delete_user") {
      if (user_id === u.user.id) return json({ error: "self" }, 400);
      const { error } = await sb.auth.admin.deleteUser(user_id);
      if (error) return json({ error: error.message }, 400);
      console.log("игрок удалён", user_id);
      return json({ ok: true });
    }
    return json({ error: "bad_action" }, 400);
  } catch (e) {
    console.error("сбой:", String(e));
    return json({ error: "server" }, 500);
  }
});
