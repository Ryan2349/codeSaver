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

export function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const safeName = (filename || 'backup').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-\s]/g, '_') || 'backup';
    downloadBlob(blob, safeName.endsWith('.json') ? safeName : safeName + '.json');
    showToast('📥 JSON 檔案已下載');
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