export function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

export function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast('✅ 已複製到剪貼簿');
    } catch (err) {
        showToast('❌ 複製失敗，請檢查瀏覽器權限');
    }
}

export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * @param {Object} data
 * @param {string} filename
 * @param {{ pretty?: boolean, toastMessage?: string }} [options]
 *   - pretty: 是否縮排（預設 true；完整備份壓縮匯出時建議 false 以進一步減小體積）
 *   - toastMessage: 自訂成功提示
 */
export function downloadJSON(data, filename, options = {}) {
    const { pretty = true, toastMessage } = options;
    const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    const blob = new Blob([text], { type: 'application/json' });
    const safeName = (filename || 'backup').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-\s]/g, '_') || 'backup';
    downloadBlob(blob, safeName.endsWith('.json') ? safeName : safeName + '.json');
    showToast(toastMessage || '📥 JSON 檔案已下載');
}

export function triggerImportJSON(callback) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const json = JSON.parse(ev.target.result);
                callback(json);
            } catch {
                showToast('❌ JSON 格式錯誤');
            }
        };
        reader.readAsText(file);
    });
    input.click();
}

export function formatDateTime(isoString) {
    try {
        const d = new Date(isoString);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
        return isoString;
    }
}

/**
 * 將位元組數格式化為可讀儲存容量（B / KB / MB / GB）
 */
export function formatStorageSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) {
        const kb = n / 1024;
        return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
    }
    if (n < 1024 * 1024 * 1024) {
        const mb = n / (1024 * 1024);
        return mb < 10 ? `${mb.toFixed(2)} MB` : `${mb.toFixed(1)} MB`;
    }
    const gb = n / (1024 * 1024 * 1024);
    return `${gb.toFixed(2)} GB`;
}

/**
 * 計算單一專案 raw JSON 位元組數（未去重）。實際儲存容量請用 storage.getProjectStorageBytes。
 * @deprecated 保留給不需去重的場景
 */
export function getProjectRawStorageBytes(project) {
    if (!project) return 0;
    try {
        const json = JSON.stringify(project);
        return new TextEncoder().encode(json).length;
    } catch {
        return 0;
    }
}

/**
 * 移除代碼末尾「代碼完結後」的空行（含僅空白的行與結尾換行）。
 * 用於上傳／拖曳匯入時自動清理，不影響行內內容或中間空行。
 */
export function trimTrailingEmptyLines(code) {
    if (typeof code !== 'string' || code.length === 0) return code || '';
    return code.replace(/(\r?\n[ \t]*)+$/, '');
}

/**
 * 從字串解析 Semantic Version（主.次.修訂），支援可選 v/V 前綴。
 * @returns {{ major: number, minor: number, patch: number }|null}
 */
export function parseSemver(label) {
    if (typeof label !== 'string') return null;
    const m = String(label).trim().match(/^v?(\d+)\.(\d+)\.(\d+)\b/i);
    if (!m) return null;
    return {
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10)
    };
}

/**
 * 依專案既有版本標籤，計算下一個自動版本號（Semantic Versioning）。
 * 規則：在已出現的最高版本上，次版本號 +1，修訂號歸 0；若無任何 semver 則從 0.1.0 開始。
 * @param {{ versions?: Array<{ id?: string, label?: string }> }|null} project
 * @param {{ excludeVersionId?: string|null }} [options] - 計算時可排除指定版本（例如正在編輯的那一筆）
 * @returns {string} 例如 "0.1.0"、"0.2.0"
 */
export function getNextSemverLabel(project, options = {}) {
    const excludeId = options?.excludeVersionId ?? null;
    let best = null;
    const versions = project?.versions || [];
    for (const v of versions) {
        if (excludeId && v?.id === excludeId) continue;
        const parsed = parseSemver(v?.label);
        if (!parsed) continue;
        if (
            !best ||
            parsed.major > best.major ||
            (parsed.major === best.major && parsed.minor > best.minor) ||
            (parsed.major === best.major && parsed.minor === best.minor && parsed.patch > best.patch)
        ) {
            best = parsed;
        }
    }
    if (!best) return '0.1.0';
    return `${best.major}.${best.minor + 1}.0`;
}