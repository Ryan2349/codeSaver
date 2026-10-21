# codeSaver

[English](README.md) | [中文](README.zh-TW.md)

一個輕量級的瀏覽器端程式碼片段與專案管理工具。  
完全在瀏覽器中儲存、組織和版本化你的程式碼專案——無需伺服器、無需註冊、無外部依賴。

## 功能特色

- **多專案管理** – 建立、重新命名、刪除及切換多個專案。
- **虛擬檔案系統** – 支援巢狀資料夾、麵包屑導航、拖曳移動檔案。
- **內建程式碼編輯器** – 行號顯示、自動儲存、Tab 縮排、10,000 行上限。
- **版本歷史** – 手動保存快照、還原舊版本、重新命名或刪除版本記錄。
- **匯入本機資料夾** – 可將真實資料夾匯入為新專案或更新現有專案（自動過濾二進位檔、過大檔案、排除目錄）；更新時同名且完整程式碼相同的檔案會沿用舊記錄，並優先比對相對路徑。重用檔案所在的頂層資料夾會在新版本根目錄以淺綠色標示；位於根目錄的重用檔案也會直接標示。
- **版本儲存去重** – 完全相同的檔案記錄（包括版本快照）只保存一份；重複程式碼內容在確實節省空間時也會共用，載入時還原原有資料格式，節省瀏覽器 `localStorage` 空間。
- **匯出 Markdown** – 自選包含的檔案、預覽專案結構樹、搜尋檔案，並下載或複製含程式碼區塊的 Markdown。
- **匯出 ZIP** – 將整個專案下載為真實的資料夾結構（STORE 模式 ZIP，無壓縮依賴）。
- **匯出 / 匯入 JSON** – 備份與還原專案（可選擇是否包含版本歷史）。
- **純前端** – 所有資料儲存在 `localStorage`，完全離線、隱私安全。
- **溫暖紙質風格介面** – 流暢動畫、毛玻璃卡片、響應式佈局。

## 專案結構

```
codeSaver/
├── index.html              # 應用入口 – 載入 CSS 與 JS 模組
├── style.css               # 全域樣式（紙質主題、響應式、模態框、版本側欄）
└── js/
    ├── main.js             # 初始化：載入資料、綁定 beforeunload、啟動路由
    ├── state.js            # 全域狀態物件與 localStorage 鍵值
    ├── storage.js          # localStorage 讀寫、資料遷移、版本快照管理
    ├── router.js           # 簡易視圖路由（首頁 ↔ 專案）與導航動作
    ├── fileSystem.js       # 虛擬檔案系統輔助函式、資料夾匯入邏輯與排除規則
    ├── markdown.js         # 產生 Markdown 樹狀圖與程式碼匯出（含語言偵測）
    ├── zip.js              # 零依賴 ZIP 產生器（STORE 模式）
    ├── utils.js            # 工具函式：ID 產生、提示訊息、剪貼簿、下載、HTML 跳脫
    └── views/
        ├── home.js         # 首頁視圖：專案列表、新增專案、匯入 JSON/資料夾
        └── project.js      # 專案視圖：檔案樹、編輯器、版本歷史、匯出模態框
```

## 安裝步驟

本應用為純靜態檔案，無需建置工具或套件管理器，可透過任何 HTTP 伺服器提供服務。

### 1. 下載或克隆專案

```bash
git clone https://github.com/your-username/codeSaver.git
cd codeSaver
```

### 2. 啟動本地伺服器

由於應用使用 ES 模組（`type="module"`），必須透過 HTTP 伺服器存取，不可直接從檔案系統打開 `index.html`。你可以使用以下任何一種方式：

**使用 Node.js (http-server)**
```bash
npx http-server . -p 8080 -o
```

**使用 Python 3**
```bash
python -m http.server 8080
```

**使用 VS Code Live Server**  
在 `index.html` 上按右鍵 → 「Open with Live Server」。

然後在現代瀏覽器（Chrome、Firefox、Edge、Safari）中開啟 `http://localhost:8080`。

## 授權條款

本專案基於 Apache License 2.0 協議開源。詳細內容請參閱 [LICENSE](LICENSE) 文件。
