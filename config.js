// Supabase 連線設定（總覽 §2、§9：這裡只能放 URL 與 anon key，兩者公開沒關係，
// 資安完全靠 Supabase 的 RLS 政策，見 supabase/schema.sql）。
// 嚴禁在此檔或本 repo 任何地方放 service_role key 或 Postgres 連線字串。
//
// 使用前請把下面兩個值換成你自己 Supabase 專案的實際值
// （Supabase 後台 → Project Settings → API）。
window.STOCKTAKE_CONFIG = {
  SUPABASE_URL: "https://yvolycibskromyqraijg.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2b2x5Y2lic2tyb215cXJhaWpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3MjU0NTIsImV4cCI6MjA5OTMwMTQ1Mn0.laDjpe5-IYFiSDoISq_G8vUn2CMDtxd8pep92O3TeJ0",
};
