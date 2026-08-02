// 手機盤點 PWA 主邏輯。單頁應用（一個 index.html，用 showScreen 切換畫面），
// 所有資料操作直接對 Supabase（supabase-js），不經過主系統。

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.STOCKTAKE_CONFIG;
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---- 全域狀態 ----
let session = null;
let isAdmin = false;

// 測試模式：只給管理者使用的練習環境。所有 cloud_sheets 查詢都會用 is_test 過濾，
// 所以測試單與正式單在手機上永遠不會混在同一份清單裡。
// 一般盤點人員看不到開關，也永遠是 false——避免現場人員誤盤到測試單。
const TEST_MODE_KEY = "stocktake_test_mode";
let isTestMode = false;
let currentType = null;
let currentSheets = []; // 目前類型（初盤/複盤）跨公司所有「開立中」的盤點單
let sheetsById = {};
let currentItems = []; // cloud_items 陣列，每筆額外帶 company/period（來自所屬 sheet）
let currentWarehouse = "";
let currentItem = null;
let keypadBuffer = "0";
let itemsChannels = [];
let entriesChannel = null;
let html5QrCode = null;

/// 四捨五入到小數第 4 位，避免 JS 浮點數運算（例如 3.33-3）產生 0.33000000000000007 這類雜訊。
function roundQty(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

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

// ---- 測試模式 ----
/// 套用測試模式的視覺（橫幅 + 整體換色）。非管理者一律強制關閉。
function applyTestMode(on) {
  isTestMode = !!on && isAdmin;
  localStorage.setItem(TEST_MODE_KEY, isTestMode ? "1" : "0");
  document.body.classList.toggle("test-mode", isTestMode);
  document.getElementById("test-mode-bar").classList.toggle("d-none", !isTestMode);
  const sw = document.getElementById("test-mode-switch");
  if (sw) sw.checked = isTestMode;
}

/// 登入/還原 session 後套用共用的畫面狀態（顯示名稱、admin 工具、測試模式）。
function applySessionUi() {
  isAdmin = session.user.app_metadata?.role === "admin";
  document.getElementById("who").textContent =
    (session.user.user_metadata?.display_name || session.user.email) + (isAdmin ? "（Admin）" : "");
  document.getElementById("admin-tools-area").classList.toggle("d-none", !isAdmin);
  // 非管理者即使 localStorage 殘留旗標也一律回到正式模式
  applyTestMode(isAdmin && localStorage.getItem(TEST_MODE_KEY) === "1");
}

// ---- 登入 ----
async function restoreSession() {
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    session = data.session;
    applySessionUi();
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
  applySessionUi();
  document.getElementById("operator-name-input").value = ""; // 每次登入都要重新填寫盤點人員
  showScreen("screen-select");
});

document.getElementById("test-mode-switch").addEventListener("change", (e) => {
  applyTestMode(e.target.checked);
  // 已載入的盤點單屬於另一個模式，直接退回選擇畫面重新挑，避免拿舊清單繼續盤
  currentSheets = [];
  currentItems = [];
  currentType = null;
  showScreen("screen-select");
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  session = null;
  isAdmin = false;
  applyTestMode(false); // 登出一律退出測試模式，下一個人登入不會莫名其妙在測試環境
  showScreen("screen-login");
});

// ---- 選擇 初盤/複盤（跨公司）----
document.querySelectorAll(".select-type").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!requireOperatorName()) return; // 沒填盤點人員姓名不能進入盤點
    document.querySelectorAll(".select-type").forEach((b) => b.classList.remove("btn-primary", "btn-outline-primary"));
    btn.classList.add("btn-primary");
    document.querySelectorAll(".select-type").forEach((b) => { if (b !== btn) b.classList.add("btn-outline-primary"); });
    await loadItemsForType(btn.dataset.type);
  });
});

// ---- 載入某盤點類型（初盤/複盤）跨所有公司「開立中」的品項，合併成單一清單 ----
async function loadItemsForType(type) {
  currentType = type;
  currentWarehouse = "";

  const { data: sheets, error: sheetErr } = await supabaseClient
    .from("cloud_sheets")
    .select("id, period, company, type, status, require_all_counted, created_at")
    .eq("type", type)
    .eq("status", "開立中")
    .eq("is_test", isTestMode);
  if (sheetErr) {
    alert("讀取盤點單失敗：" + sheetErr.message);
    return;
  }

  currentSheets = sheets || [];
  sheetsById = Object.fromEntries(currentSheets.map((s) => [s.id, s]));
  document.getElementById("sheet-title").textContent = `${type}（跨公司）`;
  document.getElementById("warehouse-select").innerHTML = '<option value="">請選擇倉庫名稱</option>';

  if (currentSheets.length === 0) {
    currentItems = [];
    document.getElementById("items-list").innerHTML = '<p class="text-muted text-center mt-3">目前非盤點期間，請洽管理者。</p>';
    unsubscribeRealtime();
    showScreen("screen-items");
    return;
  }

  const { data: items, error: itemErr } = await supabaseClient
    .from("cloud_items").select("*").in("sheet_id", currentSheets.map((s) => s.id)).order("item_no");
  if (itemErr) {
    alert("讀取品項失敗：" + itemErr.message);
    return;
  }
  currentItems = (items || []).map((i) => ({
    ...i,
    company: sheetsById[i.sheet_id].company,
    period: sheetsById[i.sheet_id].period,
  }));

  // 複盤：依「公司＋期間」逐一找對應初盤單，附上初盤狀態（未盤點/盤差）與盤差數量。
  // 複盤進行中月結一定還沒跑（開立中複盤會擋月結），初盤的雲端資料保證還在。
  if (type === "複盤") {
    await attachInitialStatus(currentSheets, currentItems);
  }

  const warehouses = [...new Set(currentItems.map((i) => i.warehouse).filter(Boolean))].sort();
  const whSelect = document.getElementById("warehouse-select");
  whSelect.innerHTML =
    '<option value="">請選擇倉庫名稱</option>' + warehouses.map((w) => `<option value="${w}">${w}</option>`).join("");

  document.getElementById("items-list").innerHTML = "";

  subscribeRealtimeMulti(currentSheets.map((s) => s.id));
  showScreen("screen-items");
  renderItemsList();
}

/// 複盤品項的初盤狀態比對：依「公司＋期間」逐一查詢對應初盤單，配對鍵加上公司避免跨公司同品號誤配。
async function attachInitialStatus(recountSheets, items) {
  const pairs = [...new Map(recountSheets.map((s) => [`${s.company}|${s.period}`, { company: s.company, period: s.period }])).values()];
  if (pairs.length === 0) return;
  try {
    const initSheetLists = await Promise.all(
      pairs.map((p) =>
        supabaseClient.from("cloud_sheets").select("id, company").eq("type", "初盤").eq("company", p.company).eq("period", p.period).eq("is_test", isTestMode)
      )
    );
    const initSheets = initSheetLists.flatMap((r) => r.data || []);
    const initIds = initSheets.map((s) => s.id);
    if (initIds.length === 0) return;
    const initSheetById = Object.fromEntries(initSheets.map((s) => [s.id, s]));

    const { data: initItems } = await supabaseClient
      .from("cloud_items").select("sheet_id, item_no, lot_no, warehouse, status, counted_qty, book_qty")
      .in("sheet_id", initIds);
    const key = (company, i) => `${company}|${i.item_no}|${i.lot_no}|${i.warehouse}`;
    const initMap = new Map((initItems || []).map((i) => [key(initSheetById[i.sheet_id].company, i), i]));
    for (const item of items) {
      const init = initMap.get(key(item.company, item));
      if (!init) continue;
      if (init.status === "已盤點") {
        item._initStatus = "盤差";
        item._initQty = roundQty(init.counted_qty);
        item._initVariance = roundQty(Number(init.counted_qty) - Number(item.book_qty));
      } else {
        item._initStatus = "未盤點";
      }
    }
  } catch (e) {
    console.error("讀取初盤狀態失敗（不影響複盤作業）", e);
  }
}

document.getElementById("back-to-select").addEventListener("click", () => {
  unsubscribeRealtime();
  currentSheets = [];
  currentItems = [];
  document.getElementById("cross-search-input").value = "";
  document.getElementById("cross-search-results").innerHTML = "";
  showScreen("screen-select");
});

// ---- 跨公司搜尋盤點單品項（開始盤點頁面）：找到品項後直接跳進該筆的數量輸入畫面 ----
document.getElementById("cross-search-btn").addEventListener("click", async () => {
  if (!requireOperatorName()) return;
  const kw = document.getElementById("cross-search-input").value.trim();
  const resultsEl = document.getElementById("cross-search-results");
  if (!kw) {
    resultsEl.innerHTML = "";
    return;
  }
  resultsEl.innerHTML = '<div class="text-muted small p-2">搜尋中…</div>';

  const { data: sheets, error: sheetErr } = await supabaseClient
    .from("cloud_sheets")
    .select("id, period, company, type, status, require_all_counted")
    .eq("status", "開立中")
    .eq("is_test", isTestMode);
  if (sheetErr) {
    resultsEl.innerHTML = `<div class="text-danger small p-2">搜尋失敗：${sheetErr.message}</div>`;
    return;
  }
  if (!sheets || sheets.length === 0) {
    resultsEl.innerHTML = '<div class="text-muted small p-2">目前沒有開立中的盤點單</div>';
    return;
  }
  const sheetById = Object.fromEntries(sheets.map((s) => [s.id, s]));
  const esc = kw.replace(/[%_]/g, "\\$&"); // 逸出萬用字元，避免使用者輸入的 % _ 被當成 SQL LIKE 特殊字元
  const { data: items, error: itemErr } = await supabaseClient
    .from("cloud_items")
    .select("*")
    .in("sheet_id", sheets.map((s) => s.id))
    .or(`item_no.ilike.%${esc}%,name.ilike.%${esc}%,lot_no.ilike.%${esc}%`)
    .limit(50);
  if (itemErr) {
    resultsEl.innerHTML = `<div class="text-danger small p-2">搜尋失敗：${itemErr.message}</div>`;
    return;
  }
  if (!items || items.length === 0) {
    resultsEl.innerHTML = '<div class="text-muted small p-2">沒有符合的品項</div>';
    return;
  }

  resultsEl.innerHTML = items
    .map((i) => {
      const s = sheetById[i.sheet_id];
      const badgeClass = i.status === "已盤點" ? "badge-counted" : "badge-uncounted";
      return `<button type="button" class="list-group-item list-group-item-action cross-search-result" data-item-id="${i.id}" data-sheet-id="${i.sheet_id}">
        <div class="d-flex justify-content-between">
          <strong>${i.item_no}</strong>
          <span class="badge ${badgeClass}">${i.status}（${i.counted_qty}）</span>
        </div>
        <div class="small text-muted">${s.company}　${s.period}　${s.type}　倉別：${i.warehouse}</div>
        <div class="small">${i.name}　批號：${i.lot_no || "-"}</div>
      </button>`;
    })
    .join("");

  resultsEl.querySelectorAll(".cross-search-result").forEach((el) => {
    el.addEventListener("click", async () => {
      const sheetRow = sheetById[el.dataset.sheetId];
      const itemRow = items.find((i) => i.id === el.dataset.itemId);
      await jumpToItem(sheetRow, itemRow);
    });
  });
});

/// 從跨公司搜尋結果直接跳進指定品項的數量輸入畫面。
async function jumpToItem(sheetRow, itemRow) {
  await loadItemsForType(sheetRow.type);
  const wh = document.getElementById("warehouse-select");
  wh.value = itemRow.warehouse;
  currentWarehouse = itemRow.warehouse;
  renderItemsList();
  const found = currentItems.find((i) => i.id === itemRow.id) || itemRow;
  openCountScreen(found);
}

document.getElementById("warehouse-select").addEventListener("change", (e) => {
  currentWarehouse = e.target.value;
  document.getElementById("search-input").value = "";
  document.getElementById("search-lot-input").value = "";
  renderItemsList();
});

// ---- 搜尋（搜尋框固定顯示，清除鈕一次清空）----
// 品號 + 批號兩個關鍵字都可獨立輸入、同時生效（AND）。
// 未選倉別時搜尋會跨倉別找（此時品項卡片會多顯示倉別，方便辨識）；已選倉別時只在該倉別內搜尋。
document.getElementById("search-input").addEventListener("input", renderItemsList);
document.getElementById("search-clear-btn").addEventListener("click", () => {
  document.getElementById("search-input").value = "";
  renderItemsList();
});
document.getElementById("search-lot-input").addEventListener("input", renderItemsList);
document.getElementById("search-lot-clear-btn").addEventListener("click", () => {
  document.getElementById("search-lot-input").value = "";
  renderItemsList();
});

// ---- 品項清單渲染 ----
function renderItemsList() {
  const keyword = document.getElementById("search-input").value.trim().toLowerCase();
  const lotKeyword = document.getElementById("search-lot-input").value.trim().toLowerCase();
  const searching = keyword || lotKeyword;

  let list = currentItems;
  if (currentWarehouse) list = list.filter((i) => i.warehouse === currentWarehouse);
  if (keyword) list = list.filter((i) => i.item_no.toLowerCase().includes(keyword));
  if (lotKeyword) list = list.filter((i) => (i.lot_no || "").toLowerCase().includes(lotKeyword));

  const container = document.getElementById("items-list");
  if (!currentWarehouse && !searching) {
    container.innerHTML = '<p class="text-muted text-center mt-3">請先選擇倉庫名稱，或直接搜尋品號/批號（未選倉別時可跨倉別、跨公司搜尋）</p>';
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
      const statusLabel = i.status === "已盤點" && currentType === "複盤" ? "已盤點/複盤" : i.status;
      return `<div class="card mb-2 item-row" data-item-id="${i.id}">
        <div class="card-body py-2 px-3">
          <div class="d-flex justify-content-between">
            <span class="item-no-lg">${i.item_no}</span>
            <span class="badge ${badgeClass}">${statusLabel}（${i.counted_qty}）</span>
          </div>
          <div class="small text-muted">${i.name}</div>
          <div class="item-attrs">公司別：${i.company}<span class="attr-sep">｜</span>倉別：${i.warehouse}</div>
          <div class="item-attrs">規格：${i.spec || "-"}<span class="attr-sep">｜</span>批號：<span class="lot-no-lg">${i.lot_no || "-"}</span></div>
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

// ---- Realtime 訂閱：任何人送出數量，其他人畫面即時更新（跨公司清單要同時訂多張單）----
function subscribeRealtimeMulti(sheetIds) {
  unsubscribeRealtime();
  itemsChannels = sheetIds.map((sheetId) =>
    supabaseClient
      .channel(`items-${sheetId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "cloud_items", filter: `sheet_id=eq.${sheetId}` },
        (payload) => updateItemInPlace(payload.new)
      )
      .subscribe()
  );
}

function unsubscribeRealtime() {
  itemsChannels.forEach((ch) => supabaseClient.removeChannel(ch));
  itemsChannels = [];
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
    const v = roundQty(item._initVariance);
    return `　<span class="badge bg-warning text-dark">初盤 ${roundQty(item._initQty)}（盤差 ${v > 0 ? "+" : ""}${v}）</span>`;
  }
  return "";
}

function renderCountItemInfo() {
  const item = currentItem;
  document.getElementById("count-item-info").innerHTML = `
    <span class="item-no-lg">${item.item_no}</span>　${item.name}<br/>
    <div class="item-attrs">公司別：${item.company}<span class="attr-sep">｜</span>倉別：${item.warehouse}</div>
    <div class="item-attrs">規格：${item.spec || "-"}<span class="attr-sep">｜</span>批號：<span class="lot-no-lg">${item.lot_no || "-"}</span></div>
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
  // 內部用 "*" 儲存乘號方便解析，顯示時換成 "×" 比較好讀
  document.getElementById("keypad-display").textContent = keypadBuffer.replace("*", "×");
}

document.querySelectorAll(".keypad-grid button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.key;
    if (key === "back") {
      // 刪除一個字，刪到空就回到 0
      keypadBuffer = keypadBuffer.length > 1 ? keypadBuffer.slice(0, -1) : "0";
    } else if (key === ".") {
      // 小數點只能有一個
      if (!keypadBuffer.includes(".")) keypadBuffer += ".";
    } else {
      // 數字依序串接：按 1 再按 9 → "19"；"0" 開頭直接取代避免 "05"
      keypadBuffer = keypadBuffer === "0" ? key : keypadBuffer + key;
    }
    updateKeypadDisplay();
  });
});

// ---- 計算機乘法：例如輸入 3×10，按「＝」算出 30 後才能送出（不是每個品項都需要，直接輸入數量照舊可用）----
document.getElementById("calc-multiply-btn").addEventListener("click", () => {
  // 最多一個乘號，且乘號前面要有數字（不能是空的或還是初始的 "0"）
  if (keypadBuffer.includes("*") || keypadBuffer === "0") return;
  keypadBuffer += "*";
  updateKeypadDisplay();
});

document.getElementById("calc-equals-btn").addEventListener("click", () => {
  const errorEl = document.getElementById("count-submit-error");
  if (!keypadBuffer.includes("*")) return; // 沒有乘號就不用算，維持原數字
  const [left, right] = keypadBuffer.split("*");
  const a = parseFloat(left);
  const b = parseFloat(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    errorEl.textContent = "算式不完整，例如：3×10";
    errorEl.classList.remove("d-none");
    return;
  }
  errorEl.classList.add("d-none");
  keypadBuffer = String(roundQty(a * b));
  updateKeypadDisplay();
});

/// 讀取鍵盤目前的數量（支援小數），非法輸入回 0。
function keypadValue() {
  const n = parseFloat(keypadBuffer);
  return Number.isFinite(n) ? n : 0;
}

function clearKeypad() {
  keypadBuffer = "0";
  updateKeypadDisplay();
}
document.getElementById("clear-btn").addEventListener("click", clearKeypad);
document.getElementById("clear-btn-correct").addEventListener("click", clearKeypad);

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
  const errorEl = document.getElementById("count-submit-error");
  // 算式還沒按「＝」算出結果，不能直接送出（避免誤送出算式裡的第一個數字）
  if (keypadBuffer.includes("*")) {
    errorEl.textContent = "請先按「＝」算出結果，再送出";
    errorEl.classList.remove("d-none");
    return;
  }
  const qty = keypadValue();
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
// 用自訂 Modal 取代原生 confirm()：安裝到主畫面的 standalone PWA 有些瀏覽器會靜默吃掉原生對話框，
// if(!confirm()) 會直接 return，按鈕看起來完全沒反應。
const zeroStockModal = new bootstrap.Modal(document.getElementById("zero-stock-modal"));
document.getElementById("zero-stock-btn").addEventListener("click", () => {
  document.getElementById("zero-stock-modal-text").textContent = `確定「${currentItem.item_no}」無庫存（盤點數量 0）嗎？`;
  zeroStockModal.show();
});
document.getElementById("zero-stock-modal-ok-btn").addEventListener("click", async () => {
  zeroStockModal.hide();
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
  // 算式還沒按「＝」算出結果，不能直接當成正確總數送出
  if (keypadBuffer.includes("*")) {
    errorEl.textContent = "請先按「＝」算出結果，再更正";
    errorEl.classList.remove("d-none");
    return;
  }
  const newTotal = keypadValue();
  const currentTotal = Number(currentItem.counted_qty) || 0;
  const delta = roundQty(newTotal - currentTotal);
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

  // 送出前檢查盤點單狀態：避免單已被確認/刪除，但手機沒重整還繼續盤（查詢失敗時不擋，交給下面的離線佇列邏輯）
  try {
    const { data: sheetRow, error: sheetErr } = await supabaseClient
      .from("cloud_sheets").select("status").eq("id", currentItem.sheet_id).maybeSingle();
    if (!sheetErr) {
      if (!sheetRow) {
        errorEl.textContent = "此盤點單已被刪除，無法送出盤點，請返回重新選擇盤點單";
        errorEl.classList.remove("d-none");
        return;
      }
      if (sheetRow.status !== "開立中") {
        errorEl.textContent = `此盤點單已確認完成（${sheetRow.status}），無法再送出盤點，請返回重新選擇盤點單`;
        errorEl.classList.remove("d-none");
        return;
      }
    }
  } catch { /* 檢查失敗不擋送出 */ }

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

// ---- 確認完成初盤/複盤（Admin 專屬獨立頁面，跨公司列出所有開立中的盤點單）----
document.getElementById("admin-confirm-btn").addEventListener("click", async () => {
  showScreen("screen-admin-confirm");
  await loadAdminConfirmList();
});

document.getElementById("back-from-admin-confirm").addEventListener("click", () => {
  showScreen("screen-select");
});

async function loadAdminConfirmList() {
  const listEl = document.getElementById("admin-confirm-list");
  listEl.innerHTML = '<p class="text-muted text-center mt-3">讀取中…</p>';

  const { data: sheets, error } = await supabaseClient
    .from("cloud_sheets")
    .select("id, period, company, type, status, require_all_counted, created_at")
    .eq("status", "開立中")
    .eq("is_test", isTestMode)
    .order("period", { ascending: false });

  if (error) {
    listEl.innerHTML = `<div class="alert alert-danger">讀取失敗：${error.message}</div>`;
    return;
  }
  if (!sheets || sheets.length === 0) {
    listEl.innerHTML = '<p class="text-muted text-center mt-3">目前沒有開立中的盤點單</p>';
    return;
  }

  // 逐張單查已盤點/總品項數，供畫面顯示進度
  const rows = await Promise.all(
    sheets.map(async (s) => {
      const { count: total } = await supabaseClient
        .from("cloud_items").select("id", { count: "exact", head: true }).eq("sheet_id", s.id);
      const { count: counted } = await supabaseClient
        .from("cloud_items").select("id", { count: "exact", head: true }).eq("sheet_id", s.id).eq("status", "已盤點");
      return { ...s, total: total || 0, counted: counted || 0 };
    })
  );

  listEl.innerHTML = rows
    .map(
      (s) => `<div class="card mb-2">
        <div class="card-body py-2 px-3">
          <div class="d-flex justify-content-between">
            <strong>${s.company}</strong>
            <span class="badge bg-secondary">${s.period}　${s.type}</span>
          </div>
          <div class="small text-muted mb-2">已盤點 ${s.counted} / ${s.total} 項</div>
          <button class="btn btn-success btn-sm w-100 admin-confirm-row-btn" data-sheet-id="${s.id}">確認完成${s.type}</button>
          <div class="alert alert-danger py-1 px-2 mt-2 d-none small admin-confirm-row-error" data-sheet-id="${s.id}"></div>
        </div>
      </div>`
    )
    .join("");

  listEl.querySelectorAll(".admin-confirm-row-btn").forEach((btn) => {
    btn.addEventListener("click", () => confirmSheet(rows.find((s) => s.id === btn.dataset.sheetId)));
  });
}

// 確認完成用自訂 Modal（不用原生 confirm()，理由同無庫存按鈕），並加一道防呆：
// 要求 admin 在跳出的視窗裡重新輸入一次姓名，確認後才真正送出。
const adminConfirmModalEl = document.getElementById("admin-confirm-modal");
const adminConfirmModal = new bootstrap.Modal(adminConfirmModalEl);
let pendingConfirmSheet = null;

async function confirmSheet(sheet) {
  const rowErrorEl = document.querySelector(`.admin-confirm-row-error[data-sheet-id="${sheet.id}"]`);
  rowErrorEl.classList.add("d-none");

  if (sheet.require_all_counted) {
    const { data, error } = await supabaseClient
      .from("cloud_items")
      .select("id", { count: "exact" })
      .eq("sheet_id", sheet.id)
      .eq("status", "未盤點");
    if (error) {
      rowErrorEl.textContent = "檢查未盤點項目失敗：" + error.message;
      rowErrorEl.classList.remove("d-none");
      return;
    }
    if (data.length > 0) {
      rowErrorEl.textContent = `還有 ${data.length} 項未盤點，無法確認完成${sheet.type}`;
      rowErrorEl.classList.remove("d-none");
      return;
    }
  }

  pendingConfirmSheet = sheet;
  document.getElementById("admin-confirm-modal-text").textContent =
    `確定要確認完成「${sheet.company} ${sheet.period} ${sheet.type}」嗎？確認後雲端資料將於月結時清除。`;
  document.getElementById("admin-confirm-name-input").value = "";
  document.getElementById("admin-confirm-modal-error").classList.add("d-none");
  adminConfirmModal.show();
}

document.getElementById("admin-confirm-modal-ok-btn").addEventListener("click", async () => {
  const sheet = pendingConfirmSheet;
  const modalErrorEl = document.getElementById("admin-confirm-modal-error");
  const name = document.getElementById("admin-confirm-name-input").value.trim();
  if (!name) {
    modalErrorEl.textContent = "請輸入您的姓名才能確認";
    modalErrorEl.classList.remove("d-none");
    return;
  }

  const { error } = await supabaseClient
    .from("cloud_sheets")
    .update({
      status: "已確認",
      confirmed_by: name,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", sheet.id);

  if (error) {
    modalErrorEl.textContent = "確認失敗：" + error.message;
    modalErrorEl.classList.remove("d-none");
    return;
  }

  adminConfirmModal.hide();
  await loadAdminConfirmList();
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
