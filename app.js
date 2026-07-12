// 手機盤點 PWA 主邏輯。單頁應用（一個 index.html，用 showScreen 切換畫面），
// 所有資料操作直接對 Supabase（supabase-js），不經過主系統。

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.STOCKTAKE_CONFIG;
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---- 全域狀態 ----
let session = null;
let isAdmin = false;
let currentType = null;
let currentCompany = null;
let currentSheet = null; // { id, period, company, type, require_all_counted, status }
let currentItems = []; // cloud_items 陣列
let currentWarehouse = "";
let currentItem = null;
let keypadBuffer = "0";
let itemsChannel = null;
let entriesChannel = null;
let html5QrCode = null;

// ---- 畫面切換 ----
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function setBanner(text, cls) {
  const el = document.getElementById("conn-banner");
  el.textContent = text;
  el.className = "status-banner " + cls;
}

function updateConnBanner() {
  if (!navigator.onLine) {
    setBanner("離線中 — 輸入會先存在手機，恢復連線後自動送出", "offline");
  } else {
    setBanner("連線正常", "ok");
  }
}
window.addEventListener("online", () => {
  updateConnBanner();
  flushQueue();
});
window.addEventListener("offline", updateConnBanner);

// ---- 盤點人員姓名：同一個帳號可能多人輪流用同一台手機，送出的每筆紀錄都帶這個手動輸入的姓名。
// 刻意不預帶任何值、不記住上次輸入：每次登入都必須重新填寫，沒填不能進入盤點（防止換人沒改名）。----
function accountDisplayName() {
  return session?.user?.user_metadata?.display_name || session?.user?.email || "";
}

/// 每筆盤點紀錄要記的人員姓名：用手動輸入的；理論上進不了盤點畫面就不會是空的，保險起見仍退回帳號顯示名稱。
function currentOperatorName() {
  const manual = document.getElementById("operator-name-input").value.trim();
  return manual || accountDisplayName();
}

/// 強制填寫盤點人員姓名才能進入盤點。
function requireOperatorName() {
  const input = document.getElementById("operator-name-input");
  if (!input.value.trim()) {
    alert("請先輸入「目前盤點人員」姓名，才能開始盤點");
    input.focus();
    return false;
  }
  return true;
}

// ---- 登入 ----
async function restoreSession() {
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    session = data.session;
    isAdmin = session.user.app_metadata?.role === "admin";
    document.getElementById("who").textContent =
      (session.user.user_metadata?.display_name || session.user.email) + (isAdmin ? "（Admin）" : "");
    showScreen("screen-select");
  } else {
    showScreen("screen-login");
  }
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.classList.add("d-none");

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    errorEl.textContent = "登入失敗：" + (error.message.includes("Invalid") ? "帳號或密碼錯誤" : error.message);
    errorEl.classList.remove("d-none");
    return;
  }
  session = data.session;
  isAdmin = session.user.app_metadata?.role === "admin";
  document.getElementById("who").textContent =
    (session.user.user_metadata?.display_name || session.user.email) + (isAdmin ? "（Admin）" : "");
  document.getElementById("operator-name-input").value = ""; // 每次登入都要重新填寫盤點人員
  showScreen("screen-select");
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  session = null;
  showScreen("screen-login");
});

// ---- 選擇 初盤/複盤 + 公司 ----
document.querySelectorAll(".select-type").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!requireOperatorName()) return; // 沒填盤點人員姓名不能進入盤點
    currentType = btn.dataset.type;
    document.querySelectorAll(".select-type").forEach((b) => b.classList.remove("btn-primary", "btn-outline-primary"));
    btn.classList.add("btn-primary");
    document.querySelectorAll(".select-type").forEach((b) => { if (b !== btn) b.classList.add("btn-outline-primary"); });
    document.getElementById("company-area").classList.remove("d-none");
    document.getElementById("no-sheet-msg").classList.add("d-none");
    document.getElementById("sheet-pick-area").classList.add("d-none");
  });
});

document.querySelectorAll(".select-company").forEach((btn) => {
  btn.addEventListener("click", async () => {
    currentCompany = btn.dataset.company;
    document.querySelectorAll(".select-company").forEach((b) => b.classList.remove("btn-primary", "btn-outline-primary"));
    btn.classList.add("btn-primary");
    document.querySelectorAll(".select-company").forEach((b) => { if (b !== btn) b.classList.add("btn-outline-primary"); });
    await loadOpenSheets();
  });
});

async function loadOpenSheets() {
  const noSheetMsg = document.getElementById("no-sheet-msg");
  const pickArea = document.getElementById("sheet-pick-area");
  noSheetMsg.classList.add("d-none");
  pickArea.classList.add("d-none");

  const { data, error } = await supabaseClient
    .from("cloud_sheets")
    .select("id, period, company, type, status, require_all_counted, created_at")
    .eq("type", currentType)
    .eq("company", currentCompany)
    .eq("status", "開立中")
    .order("created_at", { ascending: false });

  if (error) {
    alert("讀取盤點單失敗：" + error.message);
    return;
  }

  if (!data || data.length === 0) {
    noSheetMsg.classList.remove("d-none");
    return;
  }

  if (data.length === 1) {
    await selectSheet(data[0]);
    return;
  }

  const listEl = document.getElementById("sheet-pick-list");
  listEl.innerHTML = data
    .map(
      (s) => `<button class="list-group-item list-group-item-action" data-id="${s.id}">
        ${s.period} － 建立於 ${new Date(s.created_at).toLocaleString()}
      </button>`
    )
    .join("");
  listEl.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      const sheet = data.find((s) => s.id === b.dataset.id);
      selectSheet(sheet);
    });
  });
  pickArea.classList.remove("d-none");
}

// ---- 選定盤點單 → 載入品項 ----
async function selectSheet(sheet) {
  currentSheet = sheet;
  currentWarehouse = "";

  const { data, error } = await supabaseClient.from("cloud_items").select("*").eq("sheet_id", sheet.id).order("item_no");
  if (error) {
    alert("讀取品項失敗：" + error.message);
    return;
  }
  currentItems = data || [];

  // 複盤單：抓同期同公司初盤單的品項，附上初盤狀態（未盤點/盤差）與盤差數量。
  // 複盤進行中月結一定還沒跑（開立中複盤會擋月結），初盤的雲端資料保證還在。
  if (sheet.type === "複盤") {
    try {
      const { data: initSheets } = await supabaseClient
        .from("cloud_sheets").select("id")
        .eq("period", sheet.period).eq("company", sheet.company).eq("type", "初盤");
      const initIds = (initSheets || []).map((s) => s.id);
      if (initIds.length > 0) {
        const { data: initItems } = await supabaseClient
          .from("cloud_items").select("item_no, lot_no, warehouse, status, counted_qty, book_qty")
          .in("sheet_id", initIds);
        const key = (i) => `${i.item_no}|${i.lot_no}|${i.warehouse}`;
        const initMap = new Map((initItems || []).map((i) => [key(i), i]));
        for (const item of currentItems) {
          const init = initMap.get(key(item));
          if (!init) continue;
          if (init.status === "已盤點") {
            item._initStatus = "盤差";
            item._initQty = Number(init.counted_qty);
            item._initVariance = Number(init.counted_qty) - Number(item.book_qty);
          } else {
            item._initStatus = "未盤點";
          }
        }
      }
    } catch (e) {
      console.error("讀取初盤狀態失敗（不影響複盤作業）", e);
    }
  }

  const warehouses = [...new Set(currentItems.map((i) => i.warehouse).filter(Boolean))].sort();
  const whSelect = document.getElementById("warehouse-select");
  whSelect.innerHTML =
    '<option value="">請選擇倉庫名稱</option>' + warehouses.map((w) => `<option value="${w}">${w}</option>`).join("");

  document.getElementById("sheet-title").textContent = `${sheet.company} ${sheet.period} ${sheet.type}`;
  document.getElementById("items-list").innerHTML = "";
  document.getElementById("admin-confirm-area").classList.toggle("d-none", !isAdmin);
  document.getElementById("confirm-sheet-btn").textContent = `確認完成${sheet.type}`;

  subscribeRealtime(sheet.id);
  showScreen("screen-items");
}

document.getElementById("back-to-select").addEventListener("click", () => {
  unsubscribeRealtime();
  currentSheet = null;
  showScreen("screen-select");
});

document.getElementById("warehouse-select").addEventListener("change", (e) => {
  currentWarehouse = e.target.value;
  document.getElementById("search-input").value = "";
  renderItemsList();
});

// ---- 搜尋（搜尋框固定顯示，清除鈕一次清空） ----
document.getElementById("search-input").addEventListener("input", renderItemsList);
document.getElementById("search-clear-btn").addEventListener("click", () => {
  document.getElementById("search-input").value = "";
  renderItemsList();
});

// ---- 品項清單渲染 ----
function renderItemsList() {
  const keyword = document.getElementById("search-input").value.trim().toLowerCase();
  let list = currentItems;
  if (currentWarehouse) list = list.filter((i) => i.warehouse === currentWarehouse);
  if (keyword) list = list.filter((i) => i.item_no.toLowerCase().includes(keyword));

  const container = document.getElementById("items-list");
  if (!currentWarehouse) {
    container.innerHTML = '<p class="text-muted text-center mt-3">請先選擇倉庫名稱</p>';
    return;
  }
  if (list.length === 0) {
    container.innerHTML = '<p class="text-muted text-center mt-3">沒有符合的品項</p>';
    return;
  }

  container.innerHTML = list
    .map((i) => {
      const badgeClass = i.status === "已盤點" ? "badge-counted" : "badge-uncounted";
      // 複盤流程時按鈕/狀態文字要顯示「已盤點/複盤」（需求書用字），初盤維持「已盤點」
      const statusLabel = i.status === "已盤點" && currentSheet?.type === "複盤" ? "已盤點/複盤" : i.status;
      return `<div class="card mb-2 item-row" data-item-id="${i.id}">
        <div class="card-body py-2 px-3">
          <div class="d-flex justify-content-between">
            <strong>${i.item_no}</strong>
            <span class="badge ${badgeClass}">${statusLabel}（${i.counted_qty}）</span>
          </div>
          <div class="small text-muted">${i.name}</div>
          <div class="item-attrs">規格：${i.spec || "-"}<span class="attr-sep">｜</span>批號：${i.lot_no || "-"}</div>
          <div class="item-attrs">有效日期：${i.expiry_date || "-"}</div>
          <div class="small">帳面：${i.book_qty} ${i.unit}${initialInfoHtml(i)}</div>
        </div>
      </div>`;
    })
    .join("");

  container.querySelectorAll(".item-row").forEach((el) => {
    el.addEventListener("click", () => {
      const item = currentItems.find((i) => i.id === el.dataset.itemId);
      openCountScreen(item);
    });
  });
}

function updateItemInPlace(updated) {
  const idx = currentItems.findIndex((i) => i.id === updated.id);
  if (idx >= 0) currentItems[idx] = { ...currentItems[idx], ...updated };
  renderItemsList();
  // 數量輸入畫面開著同一個品項時，上方的「目前已盤」也要跟著即時更新
  if (currentItem && updated.id === currentItem.id) {
    currentItem = currentItems[idx] || currentItem;
    renderCountItemInfo();
  }
}

// ---- Realtime 訂閱：任何人送出數量，其他人畫面即時更新 ----
function subscribeRealtime(sheetId) {
  unsubscribeRealtime();
  itemsChannel = supabaseClient
    .channel(`items-${sheetId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "cloud_items", filter: `sheet_id=eq.${sheetId}` },
      (payload) => updateItemInPlace(payload.new)
    )
    .subscribe();
}

function unsubscribeRealtime() {
  if (itemsChannel) {
    supabaseClient.removeChannel(itemsChannel);
    itemsChannel = null;
  }
}

// ---- 掃描條碼 ----
document.getElementById("scan-btn").addEventListener("click", openScanner);
document.getElementById("scanner-close").addEventListener("click", closeScanner);

function openScanner() {
  document.getElementById("scanner-overlay").classList.remove("d-none");
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode
    .start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 220 },
      (decodedText) => {
        document.getElementById("search-input").value = decodedText;
        renderItemsList();
        closeScanner();
      },
      () => {} // 每幀掃描失敗屬正常，不處理
    )
    .catch((err) => {
      alert("無法開啟相機：" + err);
      closeScanner();
    });
}

function closeScanner() {
  if (html5QrCode) {
    html5QrCode.stop().catch(() => {}).finally(() => {
      html5QrCode.clear();
      html5QrCode = null;
    });
  }
  document.getElementById("scanner-overlay").classList.add("d-none");
}

// ---- 數量輸入畫面 ----
document.getElementById("back-to-items").addEventListener("click", () => {
  if (entriesChannel) {
    supabaseClient.removeChannel(entriesChannel);
    entriesChannel = null;
  }
  showScreen("screen-items");
});

/// 複盤品項的初盤狀態徽章：「初盤：未盤點」或「初盤 X（盤差 ±Y）」；初盤單或查無資料時回空字串。
function initialInfoHtml(item) {
  if (item._initStatus === "未盤點") {
    return '　<span class="badge bg-secondary">初盤：未盤點</span>';
  }
  if (item._initStatus === "盤差") {
    const v = item._initVariance;
    return `　<span class="badge bg-warning text-dark">初盤 ${item._initQty}（盤差 ${v > 0 ? "+" : ""}${v}）</span>`;
  }
  return "";
}

function renderCountItemInfo() {
  const item = currentItem;
  document.getElementById("count-item-info").innerHTML = `
    <strong>${item.item_no}</strong>　${item.name}<br/>
    <div class="item-attrs">規格：${item.spec || "-"}<span class="attr-sep">｜</span>批號：${item.lot_no || "-"}</div>
    <div class="item-attrs">有效日期：${item.expiry_date || "-"}</div>
    <span class="small">帳面盤點數量：${item.book_qty} ${item.unit}　目前已盤：<strong>${item.counted_qty}</strong>（${item.status}）${initialInfoHtml(item)}</span>
  `;
  // 未盤點：顯示「無庫存」、藏「更正總數」；已盤點：顯示「更正總數」、藏「無庫存」
  const counted = item.status === "已盤點";
  document.getElementById("zero-stock-btn").classList.toggle("d-none", counted);
  document.getElementById("correct-count-btn").classList.toggle("d-none", !counted);
}

// ---- 更正模式：點「更正總數」後鍵盤輸入的是「正確的已盤總數」，只留「強制更正數量」「取消」兩個按鈕 ----
let correctionMode = false;
function setCorrectionMode(on) {
  correctionMode = on;
  document.getElementById("correct-mode-hint").classList.toggle("d-none", !on);
  document.getElementById("correct-mode-btns").classList.toggle("d-none", !on);
  document.getElementById("normal-btns").classList.toggle("d-none", on);
  keypadBuffer = "0";
  updateKeypadDisplay();
  document.getElementById("count-submit-error").classList.add("d-none");
}

function openCountScreen(item) {
  currentItem = item;
  keypadBuffer = "0";
  updateKeypadDisplay();
  setCorrectionMode(false);
  renderCountItemInfo();
  document.getElementById("count-submit-error").classList.add("d-none");
  loadEntries(item.id);
  subscribeEntries(item.id);
  showScreen("screen-count");
}

function updateKeypadDisplay() {
  document.getElementById("keypad-display").textContent = keypadBuffer;
}

document.querySelectorAll(".keypad-grid button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.key;
    let n = parseInt(keypadBuffer, 10) || 0;
    if (key === "+") {
      n += 1;
      keypadBuffer = String(n);
    } else if (key === "-") {
      n = Math.max(0, n - 1);
      keypadBuffer = String(n);
    } else {
      // 數字依序串接：按 1 再按 9 → "19"
      keypadBuffer = keypadBuffer === "0" ? key : keypadBuffer + key;
    }
    updateKeypadDisplay();
  });
});

document.getElementById("clear-btn").addEventListener("click", () => {
  keypadBuffer = "0";
  updateKeypadDisplay();
});

function buildEntry(qty) {
  return {
    id: crypto.randomUUID(),
    item_id: currentItem.id,
    operator_name: currentOperatorName(),
    qty,
    created_at: new Date().toISOString(),
  };
}

document.getElementById("submit-count-btn").addEventListener("click", async () => {
  const qty = parseInt(keypadBuffer, 10) || 0;
  const errorEl = document.getElementById("count-submit-error");
  // 防呆：一般送出不接受 0，確定沒有庫存要走「無庫存」按鈕
  if (qty === 0) {
    errorEl.textContent = "數量為 0：如果確定這個品項沒有庫存，請按「無庫存」按鈕送出";
    errorEl.classList.remove("d-none");
    return;
  }
  await submitEntry(buildEntry(qty));
  keypadBuffer = "0";
  updateKeypadDisplay();
});

// 無庫存：送出一筆數量 0 的紀錄，品項會標成已盤點、已盤總數維持 0
document.getElementById("zero-stock-btn").addEventListener("click", async () => {
  if (!confirm(`確定「${currentItem.item_no}」無庫存（盤點數量 0）嗎？`)) return;
  await submitEntry(buildEntry(0));
  keypadBuffer = "0";
  updateKeypadDisplay();
});

// 更正總數：進入更正模式（鍵盤重新計、只剩「強制更正數量」「取消」兩個按鈕）
document.getElementById("correct-count-btn").addEventListener("click", () => setCorrectionMode(true));
document.getElementById("cancel-correct-btn").addEventListener("click", () => setCorrectionMode(false));

// 強制更正數量：把鍵盤上的數字當成「正確的已盤總數」，自動補一筆差額紀錄（雲端紀錄不可修改，用差額補正）
document.getElementById("force-correct-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("count-submit-error");
  errorEl.classList.add("d-none");
  const newTotal = parseInt(keypadBuffer, 10) || 0;
  const currentTotal = Number(currentItem.counted_qty) || 0;
  const delta = newTotal - currentTotal;
  if (delta === 0) {
    errorEl.textContent = `目前已盤總數就是 ${currentTotal}，不需要更正`;
    errorEl.classList.remove("d-none");
    return;
  }
  await submitEntry(buildEntry(delta));
  setCorrectionMode(false);
});

async function submitEntry(entry) {
  const errorEl = document.getElementById("count-submit-error");
  errorEl.classList.add("d-none");

  if (!navigator.onLine) {
    await OfflineQueue.add(entry);
    markItemPending(entry.item_id);
    return;
  }

  const { error } = await supabaseClient.from("cloud_entries").insert(entry);
  if (error) {
    // 網路問題也可能在 navigator.onLine=true 時發生（例如雲端專案暫停），一律排入離線佇列稍後補送
    await OfflineQueue.add(entry);
    markItemPending(entry.item_id);
    errorEl.textContent = "暫時無法送出，已存到待同步佇列，恢復連線後會自動補送";
    errorEl.classList.remove("d-none");
    return;
  }
  loadEntries(currentItem.id);
  // 送出成功後主動抓一次品項最新數值，不依賴 Realtime 推播——手機瀏覽器休眠/切換 App 後
  // websocket 可能悄悄斷線，只靠 Realtime 會出現「明細有新紀錄但已盤數量凍住」的假象。
  await refreshItemFromCloud(entry.item_id);
}

async function refreshItemFromCloud(itemId) {
  const { data } = await supabaseClient.from("cloud_items").select("*").eq("id", itemId).single();
  if (data) updateItemInPlace(data);
}

function markItemPending(itemId) {
  const idx = currentItems.findIndex((i) => i.id === itemId);
  if (idx >= 0) currentItems[idx]._pending = true;
}

async function loadEntries(itemId) {
  const { data, error } = await supabaseClient
    .from("cloud_entries")
    .select("*")
    .eq("item_id", itemId)
    .order("created_at", { ascending: false });
  const listEl = document.getElementById("entry-list");
  if (error) {
    listEl.innerHTML = `<li class="text-danger">讀取失敗：${error.message}</li>`;
    return;
  }
  const pendingCount = await OfflineQueue.countForItem(itemId);
  let html = (data || [])
    .map((e) => `<li><span>${e.operator_name}</span><span>${new Date(e.created_at).toLocaleTimeString()}</span><span>${e.qty}</span></li>`)
    .join("");
  if (pendingCount > 0) {
    html += `<li class="text-warning">待同步：${pendingCount} 筆（尚未連上雲端）</li>`;
  }
  listEl.innerHTML = html || '<li class="text-muted">尚無盤點紀錄</li>';
}

function subscribeEntries(itemId) {
  if (entriesChannel) supabaseClient.removeChannel(entriesChannel);
  entriesChannel = supabaseClient
    .channel(`entries-${itemId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "cloud_entries", filter: `item_id=eq.${itemId}` },
      () => loadEntries(itemId)
    )
    .subscribe();
}

// ---- 離線佇列補送 ----
let flushing = false;
async function flushQueue() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const pending = await OfflineQueue.all();
    const flushedItemIds = new Set();
    for (const entry of pending) {
      const { error } = await supabaseClient.from("cloud_entries").insert(entry);
      // 重複送出（同一 UUID）在 primary key 衝突時視為已成功，一樣移出佇列
      if (!error || error.code === "23505") {
        await OfflineQueue.remove(entry.id);
        flushedItemIds.add(entry.item_id);
      }
    }
    // 補送成功的品項主動抓最新數值（不依賴 Realtime，理由同 submitEntry）
    for (const itemId of flushedItemIds) await refreshItemFromCloud(itemId);
    if (currentItem) loadEntries(currentItem.id);
  } finally {
    flushing = false;
  }
}
setInterval(flushQueue, 30000);

// ---- 確認完成初盤/複盤（Admin） ----
document.getElementById("confirm-sheet-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("confirm-error");
  errorEl.classList.add("d-none");

  if (currentSheet.require_all_counted) {
    const { data, error } = await supabaseClient
      .from("cloud_items")
      .select("id", { count: "exact" })
      .eq("sheet_id", currentSheet.id)
      .eq("status", "未盤點");
    if (error) {
      errorEl.textContent = "檢查未盤點項目失敗：" + error.message;
      errorEl.classList.remove("d-none");
      return;
    }
    if (data.length > 0) {
      errorEl.textContent = `還有 ${data.length} 項未盤點，無法確認完成${currentSheet.type}`;
      errorEl.classList.remove("d-none");
      return;
    }
  }

  const { error } = await supabaseClient
    .from("cloud_sheets")
    .update({
      status: "已確認",
      confirmed_by: session.user.user_metadata?.display_name || session.user.email,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", currentSheet.id);

  if (error) {
    errorEl.textContent = "確認失敗：" + error.message;
    errorEl.classList.remove("d-none");
    return;
  }

  alert(`已確認完成${currentSheet.type}`);
  unsubscribeRealtime();
  showScreen("screen-select");
});

// ---- Service Worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.error("Service worker 註冊失敗", err));
  });
}

// ---- 啟動 ----
updateConnBanner();
restoreSession();
flushQueue();
