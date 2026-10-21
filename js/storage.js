import { state, STORAGE_KEY } from './state.js';
import { showToast, generateId } from './utils.js';

function visitAllFileArrays(appData, callback) {
    (appData.projects || []).forEach(project => {
        callback(project.files || []);
        (project.versions || []).forEach(version => callback(version.files || []));
    });
}

function visitAllFileRecords(appData, callback) {
    visitAllFileArrays(appData, files => files.forEach(callback));
}

function serializeAppData(appData) {
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
    // Metadata overhead can outweigh savings for small projects; only keep a smaller representation.
    return compactJson.length < originalJson.length ? compactJson : originalJson;
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
        if (typeof file.code === 'string' || typeof file.codeRef !== 'string') return;
        if (typeof codePool[file.codeRef] === 'string') file.code = codePool[file.codeRef];
        delete file.codeRef;
    });

    delete appData.__codePool;
}

export function loadData() {
    const stored = localStorage.getItem(STORAGE_KEY);
    const defaultData = { projects: [] };

    if (stored) {
        try {
            state.appData = JSON.parse(stored);
            restorePooledFileRecords(state.appData);
            restorePooledCode(state.appData);
            state.appData.projects = state.appData.projects || [];
            migrateAllProjects();
            return;
        } catch (e) {
            console.warn("Failed to parse localStorage data, resetting.", e);
        }
    }
    state.appData = defaultData;
}

export function saveData() {
    try {
        localStorage.setItem(STORAGE_KEY, serializeAppData(state.appData));
        return true;
    } catch (e) {
        showToast('❌ 儲存失敗：儲存空間可能已滿');
        return false;
    }
}

export function migrateAllProjects() {
    state.appData.projects.forEach(project => {
        if (!project.folders) project.folders = [];
        if (!project.versions) project.versions = [];
        if (project.currentVersionId === undefined) project.currentVersionId = null;

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
    });
    saveData();
}

export function mergeImportedData(imported) {
    if (!imported || imported.type !== 'project') {
        showToast('❌ 不支援的備份類型');
        return false;
    }
    const project = imported.data;
    if (!project || !project.name) return false;

    if (state.appData.projects.some(p => p.id === project.id)) {
        project.id = generateId();
        project.name += ' (已匯入)';
    }
    project.folders = project.folders || [];
    project.files = project.files || [];
    project.versions = project.versions || [];
    if (project.currentVersionId === undefined) project.currentVersionId = null;
    state.appData.projects.push(project);
    saveData();
    return true;
}

export function getProjectById(id) {
    return state.appData.projects.find(p => p.id === id);
}

export function getFileById(project, fileId) {
    return project?.files?.find(f => f.id === fileId);
}

/**
 * 將專案目前的狀態保存為一個版本快照
 */
export function saveVersionSnapshot(project, label) {
    if (!project.versions) project.versions = [];
    const snapshot = {
        id: generateId(),
        label: label || `版本 ${project.versions.length + 1}`,
        timestamp: new Date().toISOString(),
        folders: JSON.parse(JSON.stringify(project.folders)),
        files: JSON.parse(JSON.stringify(project.files))
    };
    project.versions.push(snapshot);
    saveData();
    return snapshot;
}

/**
 * 刪除指定版本
 */
export function deleteVersion(project, versionId) {
    if (!project.versions) return;
    project.versions = project.versions.filter(v => v.id !== versionId);
    // 如果刪除的是當前版本，清除 currentVersionId
    if (project.currentVersionId === versionId) {
        project.currentVersionId = null;
    }
    saveData();
}

/**
 * 還原指定版本到專案
 */
export function restoreVersion(project, versionId) {
    if (!project.versions) return false;
    const version = project.versions.find(v => v.id === versionId);
    if (!version) return false;

    // 直接還原，不保存當前狀態的快照
    project.folders = JSON.parse(JSON.stringify(version.folders));
    project.files = JSON.parse(JSON.stringify(version.files));

    // ✅ 設定當前版本為被還原的版本
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

    // 直接將當前專案的 folders 和 files 覆蓋到該版本
    version.folders = JSON.parse(JSON.stringify(project.folders));
    version.files = JSON.parse(JSON.stringify(project.files));
    
    // 更新保存時間戳記
    version.timestamp = new Date().toISOString();
    
    saveData();
    return true;
}
