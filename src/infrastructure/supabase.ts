import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

// service_role کلید ادمین است و RLS را دور می‌زند؛ فقط باید در بک‌اند استفاده شود
// (docs/SECURITY.md بخش ۶). persistSession خاموش است چون سرور session کاربر ندارد.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
