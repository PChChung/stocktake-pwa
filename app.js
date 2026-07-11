// Phase 0 骨架：目前只驗證 Supabase 連線與 PWA 安裝，不含業務邏輯。
// Phase 1 起會把這裡換成登入頁與盤點流程（見 docs/01_開發計畫.md）。

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.STOCKTAKE_CONFIG;

const statusEl = document.getElementById("status");

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? "status ok" : "status warn";
}

async function checkSupabaseConnection() {
  if (SUPABASE_URL.includes("REPLACE_ME") || SUPABASE_ANON_KEY.includes("REPLACE_ME")) {
    setStatus("尚未設定 Supabase 連線（請編輯 config.js）", false);
    return;
  }

  try {
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { error } = await supabase.from("keepalive").select("id").limit(1);
    if (error) {
      setStatus("Supabase 連線失敗：" + error.message, false);
    } else {
      setStatus("Supabase 連線正常", true);
    }
  } catch (err) {
    setStatus("Supabase 連線發生例外：" + err.message, false);
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.error("Service worker 註冊失敗", err);
    });
  });
}

checkSupabaseConnection();
