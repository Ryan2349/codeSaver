import { state, STORAGE_KEY } from './state.js';
import { showToast, generateId, getNextSemverLabel } from './utils.js';

const DB_NAME = 'codeSaverDB';
const DB_VERSION = 1;
const STORE_NAME = 'appData';
const DATA_KEY = 'main';

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => {
            console.error('IndexedDB open failed', request.error);
            reject(request.error);
        };
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
    return dbPromise;
}

function visitAllFileArrays(appData, callback) {
    (appData.projects || []).forEach(project => {
        callback(project.files || []);
        (project.versions || []).forEach(version => callback(version.files || []));
    });
}

function visitAllFileRecords(appData, callback) {
    visitAllFileArrays(appData, files => files.forEach(callback));
}

/**
 * 將 appData 內重複的 code / 完整檔案記錄壓縮成 pool 參照。
 * 回傳物件；若壓縮後反而更大則回傳深拷貝後的原始結構（不含 pool）。
 */
export function compactAppData(appData) {
    const originalJson = JSON.stringify(appData);
    const codeCounts = new Map();

    visitAllFileRecords(appData, file => {
        if (typeof file.code !== 'string' || file.code.length === 0) return;
        codeCounts.set(file.code, (codeCounts.get(file.code) || 0) + 1);
    });

    let compactData = JSON.parse(originalJson);
    if ([...codeCounts.values()].some(count => count > 1)) {
        const codeCandidate = JSON.parse(originalJson);
        const codePool = Object.create(null);
        const referenceByCode = new Map();
        let nextReference = 1;

        visitAllFileRecords(codeCandidate, file => {
            if (typeof file.code !== 'string' || codeCounts.get(file.code) < 2) return;

            let reference = referenceByCode.get(file.code);
            if (!reference) {
                reference = `c${nextReference++}`;
                referenceByCode.set(file.code, reference);
                codePool[reference] = file.code;
            }

            delete file.code;
            file.codeRef = reference;
        });

        if (Object.keys(codePool).length) {
            codeCandidate.__codePool = codePool;
            if (JSON.stringify(codeCandidate).length < originalJson.length) compactData = codeCandidate;
        }
    }

    // Identical file records (including same ID, name, path and code) appear in
    // current state and snapshots. Store one record and reference it from each copy.
    const recordCounts = new Map();
    visitAllFileRecords(compactData, file => {
        const signature = JSON.stringify(file);
        recordCounts.set(signature, (recordCounts.get(signature) || 0) + 1);
    });

    const filePool = Object.create(null);
    const referenceByRecord = new Map();
    let nextFileReference = 1;
    visitAllFileArrays(compactData, files => {
        for (let index = 0; index < files.length; index++) {
            const file = files[index];
            if (typeof file === 'string') continue;
            const signature = JSON.stringify(file);
            if (recordCounts.get(signature) < 2) continue;

            let reference = referenceByRecord.get(signature);
            if (!reference) {
                reference = `f${nextFileReference++}`;
                referenceByRecord.set(signature, reference);
                filePool[reference] = file;
            }
            files[index] = reference;
        }
    });

    if (Object.keys(filePool).length) compactData.__filePool = filePool;
    const compactJson = JSON.stringify(compactData);
    return compactJson.length < originalJson.length ? compactData : JSON.parse(originalJson);
}

function serializeAppData(appData) {
    return compactAppData(appData);
}

/**
 * 還原 __filePool / __codePool 參照（會就地修改 appData 並刪除 pool 欄位）。
 */
export function restorePooledData(appData) {
    if (!appData || typeof appData !== 'object') return;
    restorePooledFileRecords(appData);
    restorePooledCode(appData);
}

function restorePooledFileRecords(appData) {
    const filePool = appData.__filePool;
    if (!filePool || typeof filePool !== 'object') return;

    visitAllFileArrays(appData, files => {
        for (let index = 0; index < files.length; index++) {
            const entry = files[index];
            const reference = typeof entry === 'string' ? entry : entry?.fileRef;
            if (typeof reference !== 'string' || !filePool[reference]) continue;
            files[index] = JSON.parse(JSON.stringify(filePool[reference]));
        }
    });

    delete appData.__filePool;
}

function restorePooledCode(appData) {
    const codePool = appData.__codePool;
    if (!codePool || typeof codePool !== 'object') return;

    visitAllFileRecords(appData, file => {
        if (typeof file !== 'object' || file === null) return;
        if (typeof file.code === 'string' || typeof file.codeRef !== 'string') return;
        if (typeof codePool[file.codeRef] === 'string') file.code = codePool[file.codeRef];
        delete file.codeRef;
    });

    delete appData.__codePool;
}

/**
 * 建立可下載的專案匯出物件（type: 'project'），並套用重複代碼／檔案壓縮。
 */
export function buildCompactProjectExport(project, options = {}) {
    const { includeVersions = true } = options;
    const projectData = {
        id: project.id,
        name: project.name,
        folders: project.folders || [],
        files: project.files || [],
        versions: includeVersions ? (project.versions || []) : [],
        currentVersionId: includeVersions ? (project.currentVersionId ?? null) : null
    };

    const plainPayload = { type: 'project', data: projectData };
    const originalJson = JSON.stringify(plainPayload);
    const originalBytes = new TextEncoder().encode(originalJson).length;

    const wrapper = { projects: [JSON.parse(JSON.stringify(projectData))] };
    const compacted = compactAppData(wrapper);

    const exportPayload = {
        type: 'project',
        data: (compacted.projects && compacted.projects[0]) || projectData
    };
    if (compacted.__codePool) exportPayload.__codePool = compacted.__codePool;
    if (compacted.__filePool) exportPayload.__filePool = compacted.__filePool;

    const compactJson = JSON.stringify(exportPayload);
    const compactBytes = new TextEncoder().encode(compactJson).length;

    if (compactBytes >= originalBytes) {
        return {
            payload: plainPayload,
            originalBytes,
            compactBytes: originalBytes,
            savedBytes: 0
        };
    }

    return {
        payload: exportPayload,
        originalBytes,
        compactBytes,
        savedBytes: originalBytes - compactBytes
    };
}

/** 從 IndexedDB 讀取完整 appData（已還原 pool） */
async function idbGetAppData() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(DATA_KEY);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

/** 上次成功寫入的序列化指紋，用於跳過內容完全相同的重複寫入 */
let lastWrittenFingerprint = null;

function fingerprintPayload(payload) {
    try {
        return JSON.stringify(payload);
    } catch {
        return null;
    }
}

/** 寫入完整 appData 到 IndexedDB（會先 compact）；內容未變則略過 put */
async function idbSetAppData(appData) {
    const toStore = serializeAppData(appData);
    const fp = fingerprintPayload(toStore);
    if (fp && fp === lastWrittenFingerprint) {
        return true; // 與上次寫入完全相同，避免無謂放大 IndexedDB 佔用
    }

    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(toStore, DATA_KEY);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => {
            lastWrittenFingerprint = fp;
            resolve(true);
        };
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * 一次性從 localStorage 遷移舊資料到 IndexedDB，成功後清除 localStorage。
 */
async function migrateFromLocalStorage() {
    let stored = null;
    try {
        stored = localStorage.getItem(STORAGE_KEY);
    } catch {
        return false;
    }
    if (!stored) return false;

    try {
        const parsed = JSON.parse(stored);
        restorePooledData(parsed);
        parsed.projects = parsed.projects || [];
        await idbSetAppData(parsed);
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // ignore
        }
        console.info('[codeSaver] Migrated data from localStorage to IndexedDB');
        return true;
    } catch (e) {
        console.warn('Failed to migrate localStorage data', e);
        return false;
    }
}

/**
 * 載入資料：優先 IndexedDB，若無則嘗試從 localStorage 遷移。
 * 回傳 Promise，完成後 state.appData 已就緒。
 */
export async function loadData() {
    const defaultData = { projects: [] };

    try {
        let data = await idbGetAppData();
        if (data) {
            // 從 IDB 取出的可能仍是 compact 形式
            restorePooledData(data);
            state.appData = data;
            state.appData.projects = state.appData.projects || [];
            // 記錄目前已載入內容的指紋，後續若無變更就不會重寫 IDB
            try {
                lastWrittenFingerprint = fingerprintPayload(serializeAppData(state.appData));
            } catch { /* ignore */ }
            migrateAllProjects();
            return;
        }

        // 無 IDB 資料 → 嘗試遷移 localStorage
        const migrated = await migrateFromLocalStorage();
        if (migrated) {
            data = await idbGetAppData();
            if (data) {
                restorePooledData(data);
                state.appData = data;
                state.appData.projects = state.appData.projects || [];
                try {
                    lastWrittenFingerprint = fingerprintPayload(serializeAppData(state.appData));
                } catch { /* ignore */ }
                migrateAllProjects();
                return;
            }
        }
    } catch (e) {
        console.warn('IndexedDB load failed, falling back to empty state', e);
        showToast('⚠️ 儲存系統初始化異常，已使用空白狀態');
    }

    state.appData = defaultData;
}

/**
 * 儲存目前 state.appData 到 IndexedDB。
 * 非阻塞：回傳 Promise，呼叫端通常不必 await。
 */
export function saveData() {
    return idbSetAppData(state.appData)
        .then(() => true)
        .catch(e => {
            console.error('IndexedDB save failed', e);
            showToast('❌ 儲存失敗：請檢查瀏覽器儲存空間或權限');
            return false;
        });
}

/**
 * 計算單一專案在儲存時的近似 JSON 容量（含目前內容與所有歷史版本）。
 */
export function getProjectStorageBytes(project) {
    if (!project) return 0;
    try {
        const wrapper = {
            projects: [JSON.parse(JSON.stringify({
                id: project.id,
                name: project.name,
                folders: project.folders || [],
                files: project.files || [],
                versions: project.versions || [],
                currentVersionId: project.currentVersionId ?? null
            }))]
        };
        const compacted = compactAppData(wrapper);
        const json = JSON.stringify(compacted.projects[0]);
        const pools = {};
        if (compacted.__codePool) pools.__codePool = compacted.__codePool;
        if (compacted.__filePool) pools.__filePool = compacted.__filePool;
        const poolJson = Object.keys(pools).length ? JSON.stringify(pools) : '';
        return new TextEncoder().encode(json).length + new TextEncoder().encode(poolJson).length;
    } catch {
        return 0;
    }
}

export function migrateAllProjects() {
    let changed = false;
    state.appData.projects.forEach(project => {
        if (!project.folders) {
            project.folders = [];
            changed = true;
        }
        if (!project.versions) {
            project.versions = [];
            changed = true;
        }
        if (project.currentVersionId === undefined) {
            project.currentVersionId = null;
            changed = true;
        }

        const needsMigration = project.files.some(f => f.folderId === undefined);
        if (!needsMigration) return;

        const newFiles = [];
        project.files.forEach(file => {
            if (file.folderId !== undefined) {
                newFiles.push(file);
                return;
            }
            const parts = (file.name || '').split('/');
            const fileName = parts.pop();
            let parentFolderId = null;
            for (const part of parts) {
                if (!part) continue;
                let folder = project.folders.find(f => f.name === part && f.parentFolderId === parentFolderId);
                if (!folder) {
                    folder = { id: generateId(), name: part, parentFolderId };
                    project.folders.push(folder);
                }
                parentFolderId = folder.id;
            }
            newFiles.push({ id: file.id, name: fileName, code: file.code || '', folderId: parentFolderId });
        });
        project.files = newFiles;
        changed = true;
    });
    // 僅在確實有結構修正時才寫入，避免每次刷新都重寫 IndexedDB
    if (changed) saveData();
}

export function mergeImportedData(imported) {
    if (!imported || imported.type !== 'project') {
        showToast('❌ 不支援的備份類型');
        return false;
    }
    if (!imported.data || !imported.data.name) return false;

    const restoreWrapper = {
        projects: [imported.data],
        __codePool: imported.__codePool,
        __filePool: imported.__filePool
    };
    if (!restoreWrapper.__codePool && imported.data.__codePool) {
        restoreWrapper.__codePool = imported.data.__codePool;
        delete imported.data.__codePool;
    }
    if (!restoreWrapper.__filePool && imported.data.__filePool) {
        restoreWrapper.__filePool = imported.data.__filePool;
        delete imported.data.__filePool;
    }
    restorePooledData(restoreWrapper);

    const project = restoreWrapper.projects[0];
    if (!project || !project.name) return false;

    if (state.appData.projects.some(p => p.id === project.id)) {
        project.id = generateId();
        project.name += ' (已匯入)';
    }
    project.folders = project.folders || [];
    project.files = project.files || [];
    project.versions = project.versions || [];
    if (project.currentVersionId === undefined) project.currentVersionId = null;
    (project.files || []).forEach(f => { delete f.reusedFromPreviousVersion; });
    (project.versions || []).forEach(v => {
        (v.files || []).forEach(f => { delete f.reusedFromPreviousVersion; });
    });
    state.appData.projects.push(project);
    saveData();
    return project;
}

export function getProjectById(id) {
    return state.appData.projects.find(p => p.id === id);
}

export function getFileById(project, fileId) {
    return project?.files?.find(f => f.id === fileId);
}

/**
 * 將專案目前的狀態保存為一個版本快照
 * @param {Object} project
 * @param {string} [label]
 * @param {string} [summary] - 版本變動摘要（可留空）
 */
export function saveVersionSnapshot(project, label, summary = '') {
    if (!project.versions) project.versions = [];
    const snapshot = {
        id: generateId(),
        label: (label && String(label).trim()) || getNextSemverLabel(project),
        summary: (summary || '').trim(),
        timestamp: new Date().toISOString(),
        folders: JSON.parse(JSON.stringify(project.folders)),
        files: JSON.parse(JSON.stringify(project.files))
    };
    project.versions.push(snapshot);
    saveData();
    return snapshot;
}

/**
 * 刪除指定版本。
 * 若刪除的是目前閱覽的版本（currentVersionId），則自動還原到「上一個版本」：
 * - 優先還原到陣列中位於該版本之前的那一筆（較舊的版本）
 * - 若刪的是最舊版本且仍有其他版本，則還原到原本的下一筆
 * - 若已無任何版本，則僅清除 currentVersionId，保留目前工作區內容
 * @returns {{ deleted: boolean, restored: boolean, restoredVersionId: string|null }}
 */
export function deleteVersion(project, versionId) {
    if (!project.versions || !project.versions.length) {
        return { deleted: false, restored: false, restoredVersionId: null };
    }

    const idx = project.versions.findIndex(v => v.id === versionId);
    if (idx === -1) {
        return { deleted: false, restored: false, restoredVersionId: null };
    }

    const wasCurrent = project.currentVersionId === versionId;
    let restoreToId = null;

    if (wasCurrent) {
        if (idx > 0) {
            // 有「上一個」較舊版本
            restoreToId = project.versions[idx - 1].id;
        } else if (project.versions.length > 1) {
            // 刪的是最舊版本，改還原到原本的下一筆
            restoreToId = project.versions[idx + 1].id;
        }
        // 否則已無版本可還原
    }

    // 先移除目標版本
    project.versions = project.versions.filter(v => v.id !== versionId);

    let restored = false;
    if (wasCurrent) {
        if (restoreToId) {
            // restoreVersion 會寫入內容、設定 currentVersionId 並 saveData
            restored = !!restoreVersion(project, restoreToId);
            if (!restored) {
                // 理論上不應發生；保險起見清除無效的 currentVersionId
                project.currentVersionId = null;
                saveData();
            }
        } else {
            project.currentVersionId = null;
            saveData();
        }
    } else {
        saveData();
    }

    return {
        deleted: true,
        restored,
        restoredVersionId: restored ? restoreToId : null
    };
}

/**
 * 還原指定版本到專案
 */
export function restoreVersion(project, versionId) {
    if (!project.versions) return false;
    const version = project.versions.find(v => v.id === versionId);
    if (!version) return false;

    const nextFolders = JSON.parse(JSON.stringify(version.folders));
    const nextFiles = JSON.parse(JSON.stringify(version.files));

    // 已是此版本且內容相同 → 不重寫，避免 IndexedDB 佔用上升
    const sameId = project.currentVersionId === versionId;
    const sameContent =
        JSON.stringify(project.folders || []) === JSON.stringify(nextFolders) &&
        JSON.stringify(project.files || []) === JSON.stringify(nextFiles);
    if (sameId && sameContent) {
        return true;
    }

    project.folders = nextFolders;
    project.files = nextFiles;
    project.currentVersionId = versionId;

    saveData();
    return true;
}

/**
 * 將當前專案狀態覆蓋寫入指定歷史版本 (不新增版本)
 */
export function overwriteVersion(project, versionId) {
    if (!project.versions) return false;
    const version = project.versions.find(v => v.id === versionId);
    if (!version) return false;

    const nextFolders = JSON.parse(JSON.stringify(project.folders));
    const nextFiles = JSON.parse(JSON.stringify(project.files));

    // 內容完全相同 → 不更新 timestamp、不寫入
    const sameContent =
        JSON.stringify(version.folders || []) === JSON.stringify(nextFolders) &&
        JSON.stringify(version.files || []) === JSON.stringify(nextFiles);
    if (sameContent) {
        return true;
    }

    version.folders = nextFolders;
    version.files = nextFiles;
    version.timestamp = new Date().toISOString();

    saveData();
    return true;
}

/**
 * 取得目前來源的儲存用量與配額（IndexedDB 等）。
 * 使用 StorageManager.estimate()；不支援時回傳 null。
 * @returns {Promise<{ usage: number, quota: number, usageRatio: number, appApproxBytes: number }|null>}
 */
export async function getStorageEstimate() {
    let usage = 0;
    let quota = 0;

    try {
        if (navigator.storage && typeof navigator.storage.estimate === 'function') {
            const est = await navigator.storage.estimate();
            usage = Number(est.usage) || 0;
            quota = Number(est.quota) || 0;
        }
    } catch (e) {
        console.warn('storage.estimate failed', e);
    }

    // 本應用資料的近似大小（compact 後）
    let appApproxBytes = 0;
    try {
        const compacted = serializeAppData(state.appData || { projects: [] });
        appApproxBytes = new TextEncoder().encode(JSON.stringify(compacted)).length;
    } catch {
        appApproxBytes = 0;
    }

    // 若 estimate 不可用，以本應用近似值當作 usage，quota 給一個保守預設
    if (!quota) {
        if (!appApproxBytes) return null;
        usage = appApproxBytes;
        // 多數瀏覽器 origin 配額遠大於此；顯示時用「已用 / 未知上限」較誠實
        quota = 0;
    }

    const usageRatio = quota > 0 ? Math.min(1, usage / quota) : 0;

    return {
        usage,
        quota,
        usageRatio,
        appApproxBytes
    };
}
