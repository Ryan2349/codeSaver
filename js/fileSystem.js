
import { state } from './state.js';
import { generateId, showToast, escapeHtml, trimTrailingEmptyLines, getNextSemverLabel } from './utils.js';
import { saveData, saveVersionSnapshot } from './storage.js';

const TEXT_EXTENSIONS = new Set([
    'txt', 'js', 'jsx', 'ts', 'tsx', 'html', 'htm', 'css', 'scss', 'less', 'json', 'md', 'mdx', 'py',
    'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'php', 'go', 'rs', 'swift', 'kt', 'kts', 'yaml', 'yml',
    'sh', 'bash', 'sql', 'r', 'lua', 'pl', 'cs', 'vb', 'xml', 'svg', 'ini', 'cfg', 'conf', 'toml',
    'env', 'gitignore', 'editorconfig', 'makefile', 'dockerfile', 'gradle', 'properties', 'bat', 'ps1'
]);

const EXCLUDED_DIRS = new Set([
    'node_modules', '__pycache__', '.git', '.svn',
    'site-packages', 'dist-packages', 'vendor', 'bower_components',
    'Frameworks', '_CodeSignature', 'Versions', 'Resources', 'MacOS',
    'Contents', 'Helpers', 'Libraries', 'SharedFrameworks'
]);

const EXCLUDED_EXTENSIONS = new Set([
    'so', 'dylib', 'dll', 'exe', 'bin', 'pak', 'dat',
    'asar', 'pyc', 'pyo', 'a', 'o', 'lib', 'pyd',
    'zip', 'gz', 'tar', 'whl', 'egg', '7z', 'rar',
    'icns', 'nib', 'pkg'
]);

const MAX_DEPTH = 6;
const MAX_LINES = 10000;

export function getCurrentFolderFiles(project) {
    return project.files.filter(f => f.folderId === state.currentFolderId);
}

export function getCurrentFolderSubfolders(project) {
    return project.folders.filter(f => f.parentFolderId === state.currentFolderId);
}

export function getFolderPath(project, folderId) {
    const path = [];
    let current = folderId;
    while (current) {
        const folder = project.folders.find(f => f.id === current);
        if (!folder) break;
        path.unshift({ id: folder.id, name: folder.name });
        current = folder.parentFolderId;
    }
    return path;
}

function getFolderPathMap(folders = []) {
    const foldersById = new Map(folders.map(folder => [folder.id, folder]));
    const pathById = new Map();

    function resolvePath(folderId, visiting = new Set()) {
        if (!folderId) return '';
        if (pathById.has(folderId)) return pathById.get(folderId);
        const folder = foldersById.get(folderId);
        if (!folder) return '';
        if (visiting.has(folderId)) return folder.name || '';

        visiting.add(folderId);
        const parentPath = resolvePath(folder.parentFolderId, visiting);
        visiting.delete(folderId);
        const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
        pathById.set(folderId, path);
        return path;
    }

    folders.forEach(folder => resolvePath(folder.id));
    return pathById;
}

function getFileRelativePath(file, folderPaths) {
    const folderPath = file.folderId ? folderPaths.get(file.folderId) || '' : '';
    return folderPath ? `${folderPath}/${file.name}` : file.name;
}

/**
 * 判斷兩個檔案是否「內容完全相同」（嚴格字串比對代碼）。
 * 僅檔名相同不算重複。
 */
function isIdenticalFileContent(a, b) {
    return (a?.code ?? '') === (b?.code ?? '');
}

/**
 * 取得「上一個版本」的快照（folders + files），供重複偵測比對。
 * 規則：僅與上一個版本比較。
 * - 若有 currentVersionId，取該版本在 versions 陣列中的前一個
 * - 否則取 versions 陣列的最後一個
 * - 若 versions 為空，回傳 null
 */
export function getPreviousVersionSnapshot(project) {
    const versions = project?.versions || [];
    if (!versions.length) return null;

    if (project.currentVersionId) {
        const idx = versions.findIndex(v => v.id === project.currentVersionId);
        if (idx > 0) {
            const prev = versions[idx - 1];
            return { folders: prev.folders || [], files: prev.files || [] };
        }
        // current 是第一個版本，或找不到 → 沒有「上一個」可比
        if (idx === 0) return null;
    }
    // 沒有 currentVersionId 或找不到：取最後一個版本
    const last = versions[versions.length - 1];
    return { folders: last.folders || [], files: last.files || [] };
}

/**
 * 更新既有專案時的重複檔案偵測。
 *
 * 規則：
 * - 只與「上一個版本」比較（由 compareBase 傳入；未傳則用 project 自身）
 * - 只有「代碼內容完全相同」的檔案才視為重複並重用舊記錄
 * - 僅檔案名稱相同（內容不同）→ 不視為重複，視為新檔案
 * - 會掃描比對基準的根目錄以及所有巢狀 folder 內的檔案
 * - 資料夾若相對路徑相同，沿用舊資料夾 ID（維持結構）
 *
 * 比對順序：
 * 1. 相對路徑相同（含資料夾層級，例如 src/utils/a.js）且代碼完全相同
 * 2. 否則在全專案（含所有 folder）中找：檔名相同且代碼完全相同（檔案被移動但仍完全一致）
 *
 * @param {Object} project - 目前專案（用於相容；實際比對基準為 compareBase）
 * @param {Object} imported - 即將寫入的 { folders, files }
 * @param {{ folders: Array, files: Array }|null} [compareBase] - 上一個版本的快照；省略則用 project
 */
export function reuseExistingFileRecords(project, imported, compareBase = null) {
    const base = compareBase || project;
    const oldFolders = base.folders || [];
    const oldFiles = base.files || [];
    const importedFolders = imported.folders || [];
    const importedFiles = imported.files || [];
    const oldFolderPaths = getFolderPathMap(oldFolders);
    const importedFolderPaths = getFolderPathMap(importedFolders);

    // —— 資料夾：相對路徑相同則沿用舊 ID（含巢狀）——
    const oldFoldersByPath = new Map();
    oldFolders.forEach(folder => {
        const path = oldFolderPaths.get(folder.id);
        if (path && !oldFoldersByPath.has(path)) oldFoldersByPath.set(path, folder);
    });

    const folderIdMap = new Map();
    importedFolders.forEach(folder => {
        const path = importedFolderPaths.get(folder.id);
        const oldFolder = path ? oldFoldersByPath.get(path) : null;
        folderIdMap.set(folder.id, oldFolder?.id || folder.id);
    });

    imported.folders = importedFolders.map(folder => ({
        ...folder,
        id: folderIdMap.get(folder.id) || folder.id,
        parentFolderId: folder.parentFolderId
            ? folderIdMap.get(folder.parentFolderId) || folder.parentFolderId
            : null
    }));

    // —— 索引原專案「全部」檔案：根目錄 + 每一層 folder 內的檔案 ——
    // 鍵 1：完整相對路徑（folder1/folder2/file.js）
    const oldFilesByPath = new Map();
    // 鍵 2：檔名 + 完整代碼（僅內容完全相同才會命中；同名不同內容不會進同一桶）
    const oldFilesByNameAndCode = new Map();

    oldFiles.forEach(file => {
        const relPath = getFileRelativePath(file, oldFolderPaths);
        if (!oldFilesByPath.has(relPath)) {
            oldFilesByPath.set(relPath, file);
        }
        // 必須同時用 name + code 當鍵，避免「只同名」被當成重複
        const contentKey = JSON.stringify([file.name, file.code ?? '']);
        if (!oldFilesByNameAndCode.has(contentKey)) {
            oldFilesByNameAndCode.set(contentKey, []);
        }
        oldFilesByNameAndCode.get(contentKey).push(file);
    });

    const usedOldIds = new Set();
    // updated 保留欄位以相容呼叫端，此規則下不會出現「同路徑改內容仍重用 ID」的情況
    const stats = { reused: 0, updated: 0, added: 0 };

    imported.files = importedFiles.map(file => {
        const folderId = file.folderId
            ? folderIdMap.get(file.folderId) || file.folderId
            : null;
        const incomingCode = file.code ?? '';
        // 用匯入當下的 folder 結構算相對路徑，才能正確對應巢狀資料夾
        const relPath = getFileRelativePath(
            { name: file.name, folderId: file.folderId },
            importedFolderPaths
        );
        const contentKey = JSON.stringify([file.name, incomingCode]);

        let oldFile = null;

        // 1) 同相對路徑（含資料夾層級）且代碼內容完全相同
        const pathCandidate = oldFilesByPath.get(relPath);
        if (
            pathCandidate &&
            !usedOldIds.has(pathCandidate.id) &&
            pathCandidate.name === file.name &&
            isIdenticalFileContent(pathCandidate, { code: incomingCode })
        ) {
            oldFile = pathCandidate;
        }

        // 2) 全專案掃描（根目錄 + 所有 folder）：檔名相同且代碼完全相同
        //    （檔案可能被移動到其他資料夾，但內容一字不差）
        if (!oldFile) {
            oldFile = (oldFilesByNameAndCode.get(contentKey) || []).find(
                candidate => !usedOldIds.has(candidate.id)
            ) || null;
        }

        // 只有「代碼內容完全相同」才會走到這裡；同名不同內容 → 新檔案
        if (!oldFile) {
            stats.added++;
            return { ...file, folderId };
        }

        usedOldIds.add(oldFile.id);
        stats.reused++;
        return {
            ...oldFile,
            folderId,
            reusedFromPreviousVersion: true
        };
    });

    return stats;
}

/**
 * 回傳「在 parentFolderId 下一層」且其子孫樹中含有
 * reusedFromPreviousVersion 檔案的資料夾 ID 集合。
 * parentFolderId 為 null 時表示根目錄下的頂層資料夾。
 */
export function getFolderIdsWithReusedFiles(project, parentFolderId = null) {
    const folders = project?.folders || [];
    const files = project?.files || [];
    const foldersById = new Map(folders.map(f => [f.id, f]));
    const childrenByParent = new Map();

    folders.forEach(folder => {
        const pid = folder.parentFolderId ?? null;
        if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
        childrenByParent.get(pid).push(folder.id);
    });

    // 標記：資料夾自身或其子孫是否含有重用檔案
    const hasReusedCache = new Map();

    function folderHasReused(folderId) {
        if (hasReusedCache.has(folderId)) return hasReusedCache.get(folderId);

        const direct = files.some(
            f => f.folderId === folderId && f.reusedFromPreviousVersion === true
        );
        if (direct) {
            hasReusedCache.set(folderId, true);
            return true;
        }

        const children = childrenByParent.get(folderId) || [];
        for (const childId of children) {
            if (folderHasReused(childId)) {
                hasReusedCache.set(folderId, true);
                return true;
            }
        }
        hasReusedCache.set(folderId, false);
        return false;
    }

    const result = new Set();
    const directChildren = childrenByParent.get(parentFolderId ?? null) || [];
    for (const childId of directChildren) {
        if (folderHasReused(childId)) result.add(childId);
    }
    return result;
}

/** @deprecated 請改用 getFolderIdsWithReusedFiles(project, null) */
export function getRootFolderIdsWithReusedFiles(project) {
    return getFolderIdsWithReusedFiles(project, null);
}

export function deleteFolderRecursive(project, folderId) {
    const childFolders = project.folders.filter(f => f.parentFolderId === folderId);
    childFolders.forEach(f => deleteFolderRecursive(project, f.id));
    project.files = project.files.filter(f => f.folderId !== folderId);
    project.folders = project.folders.filter(f => f.id !== folderId);
}

export function showExcludedFilesModal(excludedFiles) {
    return new Promise((resolve) => {
        const existing = document.getElementById('excludedFilesModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'excludedFilesModal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.4); display: flex; justify-content: center;
            align-items: center; z-index: 2000; backdrop-filter: blur(4px);
        `;

        const maxDisplay = 10;
        const displayFiles = excludedFiles.slice(0, maxDisplay).map(f => escapeHtml(f)).join('<br>');
        const extraCount = excludedFiles.length - maxDisplay;
        const extraMsg = extraCount > 0 ? `<br>... 及其他 ${extraCount} 個檔案` : '';

        modal.innerHTML = `
            <div style="background: #fffbf5; border-radius: 1.8rem; padding: 2rem;
                box-shadow: 0 20px 30px rgba(0,0,0,0.2);
                width: 90%; max-width: 600px; max-height: 80vh; display: flex; flex-direction: column;
                border: 1px solid #eedcc8;">
                <h3 style="color: #5e4632; margin: 0 0 1rem 0;">⚠️ 部分檔案將不會被匯入</h3>
                <p style="margin: 0 0 1rem; color: #8b7355; font-size: 0.9rem;">
                    以下檔案因不符合匯入規則（深度超過 ${MAX_DEPTH} 層、位於排除目錄、二進位格式、為隱藏檔案或行數超過 ${MAX_LINES} 行）而被排除：
                </p>
                <div style="flex:1; overflow-y: auto; max-height: 250px; border: 1px solid #e6d7bd; border-radius: 0.8rem; padding: 0.8rem; background: #fffef9; margin-bottom: 1.2rem; font-family: monospace; font-size: 0.85rem; word-break: break-all;">
                    ${displayFiles}${extraMsg}
                </div>
                <button id="closeExcludedModalBtn" class="btn" style="align-self: center; padding: 0.8rem 2rem;">確定</button>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('closeExcludedModalBtn').addEventListener('click', () => {
            modal.remove();
            resolve();
        });
    });
}

/**
 * 顯示匯入方式選擇 Modal
 * 返回 Promise<'new' | 'version' | null>
 */
function showImportChoiceModal() {
    return new Promise((resolve) => {
        const existing = document.getElementById('importChoiceModal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'importChoiceModal';
        modal.className = 'import-choice-modal';
        modal.innerHTML = `
            <div class="import-choice-box">
                <h3>📂 匯入文件夾</h3>
                <p>請選擇匯入方式：</p>
                <div class="import-choice-options">
                    <div class="import-choice-option" id="choiceNewProject">
                        <span class="option-icon">🆕</span>
                        <div class="option-text">
                            <span class="option-title">新增專案</span>
                            <span class="option-desc">將文件夾匯入為一個全新的專案</span>
                        </div>
                    </div>
                    <div class="import-choice-option" id="choiceNewVersion">
                        <span class="option-icon">🔄</span>
                        <div class="option-text">
                            <span class="option-title">更新現有專案（新版本）</span>
                            <span class="option-desc">選擇已有專案，將文件夾作為新版本匯入，舊版本將自動保存</span>
                        </div>
                    </div>
                </div>
                <button class="import-choice-cancel" id="importChoiceCancel">取消</button>
            </div>
        `;
        document.body.appendChild(modal);

        const cleanup = (result) => {
            modal.remove();
            resolve(result);
        };

        document.getElementById('choiceNewProject').addEventListener('click', () => cleanup('new'));
        document.getElementById('choiceNewVersion').addEventListener('click', () => cleanup('version'));
        document.getElementById('importChoiceCancel').addEventListener('click', () => cleanup(null));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) cleanup(null);
        });
    });
}

/**
 * 顯示選擇專案 Modal（用於新版本匯入）
 * 返回 Promise<projectId | null>
 */
function showSelectProjectModal() {
    return new Promise((resolve) => {
        const existing = document.getElementById('selectProjectModal');
        if (existing) existing.remove();

        const projects = state.appData.projects;
        if (!projects.length) {
            showToast('⚠️ 尚無專案可供選擇，請先新增專案');
            resolve(null);
            return;
        }

        const modal = document.createElement('div');
        modal.id = 'selectProjectModal';
        modal.className = 'select-project-modal';

        const projectListHtml = projects.map(p => `
            <div class="select-project-item" data-project-id="${p.id}">
                <span class="proj-icon">💻</span>
                <span class="proj-name">${escapeHtml(p.name)}</span>
                <span class="proj-count">${p.files?.length || 0} 檔案</span>
            </div>
        `).join('');

        modal.innerHTML = `
            <div class="select-project-box">
                <h3>🔄 選擇要更新的專案</h3>
                <p>匯入的文件夾會成為新版本，舊內容會保留在版本歷史。重複偵測會掃描根目錄與所有資料夾內的檔案：僅當「代碼內容完全相同」才視為重複（只同檔名不算）；同名但內容不同則視為新檔案。</p>
                <div class="select-project-list" id="selectProjectList">
                    ${projectListHtml}
                </div>
                <div class="select-project-actions">
                    <button class="btn" id="confirmSelectProjectBtn" disabled>確認選擇</button>
                    <button class="btn btn-outline" id="cancelSelectProjectBtn">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        let selectedId = null;
        const confirmBtn = document.getElementById('confirmSelectProjectBtn');
        const list = document.getElementById('selectProjectList');

        list.addEventListener('click', (e) => {
            const item = e.target.closest('.select-project-item');
            if (!item) return;
            list.querySelectorAll('.select-project-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            selectedId = item.dataset.projectId;
            confirmBtn.disabled = false;
        });

        const cleanup = (result) => {
            modal.remove();
            resolve(result);
        };

        confirmBtn.addEventListener('click', () => cleanup(selectedId));
        document.getElementById('cancelSelectProjectBtn').addEventListener('click', () => cleanup(null));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) cleanup(null);
        });
    });
}

/**
 * 核心：讀取文件夾並建立專案結構
 */
async function readFolderAndBuildProject(files, excludedFiles) {
    const filteredFiles = files.filter(f => {
        const parts = f.webkitRelativePath.split('/');
        if (parts.length > MAX_DEPTH) {
            excludedFiles.push(f.webkitRelativePath);
            return false;
        }
        if (parts.some(part => part.endsWith('.app'))) {
            excludedFiles.push(f.webkitRelativePath);
            return false;
        }
        if (parts.some(part => EXCLUDED_DIRS.has(part))) {
            excludedFiles.push(f.webkitRelativePath);
            return false;
        }
        const fileName = parts[parts.length - 1];
        const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        if (EXCLUDED_EXTENSIONS.has(ext)) {
            excludedFiles.push(f.webkitRelativePath);
            return false;
        }
        // 允許 .github 資料夾，排除其他隱藏檔案/資料夾
        if (parts.some(part => part.startsWith('.') && part !== '.github')) {
            excludedFiles.push(f.webkitRelativePath);
            return false;
        }
        return true;
    });

    if (!filteredFiles.length) return null;

    const folders = [];
    const filesArr = [];
    const folderMap = new Map();

    function ensureFolderPath(pathParts) {
        let parentId = null;
        for (const part of pathParts) {
            const key = parentId ? `${parentId}/${part}` : part;
            if (!folderMap.has(key)) {
                const folder = { id: generateId(), name: part, parentFolderId: parentId };
                folders.push(folder);
                folderMap.set(key, folder.id);
            }
            parentId = folderMap.get(key);
        }
        return parentId;
    }

    const MAX_FILE_SIZE = 1024 * 1024;
    const fileObjects = [];

    for (const file of filteredFiles) {
        const parts = file.webkitRelativePath.split('/');
        const fileName = parts.pop();
        const folderParts = parts.slice(1);
        const parentFolderId = folderParts.length > 0 ? ensureFolderPath(folderParts) : null;

        const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        const mimeType = file.type || '';
        let isText = mimeType.startsWith('text/') || mimeType === 'application/json' ||
                     mimeType === 'application/javascript' || mimeType === 'application/xml' ||
                     TEXT_EXTENSIONS.has(ext) ||
                     (fileName.startsWith('.') && TEXT_EXTENSIONS.has(fileName.substring(1).toLowerCase())) || ext === '';

        if (isText && file.size > MAX_FILE_SIZE) {
            isText = false;
        }

        const fileObj = { id: generateId(), name: fileName, code: '', folderId: parentFolderId };
        fileObjects.push({ fileObj, isText, file });
        filesArr.push(fileObj);
    }

    // 讀取檔案內容
    const readPromises = fileObjects.map(async ({ fileObj, isText, file }) => {
        if (!isText) return;
        try {
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsText(file, 'UTF-8');
            });
            if (content && content.split('\n').length > MAX_LINES) {
                fileObj.code = '';
                excludedFiles.push(file.webkitRelativePath + ` (超過${MAX_LINES}行)`);
            } else {
                fileObj.code = trimTrailingEmptyLines(content || '');
            }
        } catch {
            // 讀取失敗
        }
    });
    await Promise.all(readPromises);

    return { folders, files: filesArr };
}

export async function handleImportFolder(actions) {
    // 1. 顯示選擇 Modal
    const choice = await showImportChoiceModal();
    if (!choice) return;

    if (choice === 'version') {
        // 選擇要更新的專案
        const targetProjectId = await showSelectProjectModal();
        if (!targetProjectId) return;

        const targetProject = state.appData.projects.find(p => p.id === targetProjectId);
        if (!targetProject) {
            showToast('❌ 找不到選擇的專案');
            return;
        }

        // 開啟文件夾選擇器
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.directory = true;
        input.multiple = true;

        input.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            if (!files.length) return showToast('⚠️ 未選擇任何檔案或資料夾為空');

            const excludedFiles = [];
            const result = await readFolderAndBuildProject(files, excludedFiles);

            if (!result) {
                if (excludedFiles.length > 0) {
                    await showExcludedFilesModal(excludedFiles);
                } else {
                    showToast('⚠️ 選擇的資料夾中沒有可匯入的檔案');
                }
                return;
            }

            if (excludedFiles.length > 0) {
                await showExcludedFilesModal(excludedFiles);
            }

            const mergeStats = applyImportedFolderAsNewVersion(targetProject, result);
            showToast(`✅ 已將「${targetProject.name}」更新為新版本：重用 ${mergeStats.reused} 個相同檔案（名稱與內容皆相同）、新增 ${mergeStats.added} 個`);
            actions.navigateToProject(targetProject.id);
        });
        input.click();

    } else {
        // 新增專案（原有邏輯）
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.directory = true;
        input.multiple = true;

        input.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            if (!files.length) return showToast('⚠️ 未選擇任何檔案或資料夾為空');

            const excludedFiles = [];
            const result = await readFolderAndBuildProject(files, excludedFiles);

            if (!result) {
                if (excludedFiles.length > 0) {
                    await showExcludedFilesModal(excludedFiles);
                } else {
                    showToast('⚠️ 選擇的資料夾中沒有可匯入的檔案');
                }
                return;
            }

            if (excludedFiles.length > 0) {
                await showExcludedFilesModal(excludedFiles);
            }

            const firstPath = files[0].webkitRelativePath;
            let projectName = firstPath.split('/')[0] || '未命名專案';
            if (state.appData.projects.some(p => p.name === projectName)) {
                let counter = 1;
                while (state.appData.projects.some(p => p.name === `${projectName} (${counter})`)) counter++;
                projectName = `${projectName} (${counter})`;
            }

            const project = {
                id: generateId(),
                name: projectName,
                folders: result.folders,
                files: result.files,
                versions: [],
                currentVersionId: null
            };

            state.appData.projects.push(project);
            saveData();
            showToast(`✅ 已匯入專案「${projectName}」`);
            actions.navigateToProject(project.id);
        });
        input.click();
    }
}

/**
 * 處理從作業系統拖曳進來的檔案/資料夾（專案內匯入）
 */
export async function processExternalDrop(dataTransferItems, targetFolderId) {
    const excludedFiles = [];
    const newFolders = [];
    const newFiles = [];

    async function traverseEntry(entry, depth = 0, parentFolderId = targetFolderId, pathPrefix = '') {
        if (depth > MAX_DEPTH) {
            excludedFiles.push(pathPrefix + entry.name + ' (超過深度限制)');
            return;
        }

        if (entry.isFile) {
            const fileName = entry.name;
            // 過濾隱藏檔案 (允許 .github)
            if (fileName.startsWith('.') && fileName !== '.github') {
                excludedFiles.push(pathPrefix + fileName);
                return;
            }
            const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
            if (EXCLUDED_EXTENSIONS.has(ext)) {
                excludedFiles.push(pathPrefix + fileName);
                return;
            }

            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            
            let isText = file.type.startsWith('text/') || file.type === 'application/json' ||
                         file.type === 'application/javascript' || file.type === 'application/xml' ||
                         TEXT_EXTENSIONS.has(ext) ||
                         (fileName.startsWith('.') && TEXT_EXTENSIONS.has(fileName.substring(1).toLowerCase())) || ext === '';
            
            const MAX_FILE_SIZE = 1024 * 1024;
            if (isText && file.size > MAX_FILE_SIZE) isText = false;

            const fileObj = { id: generateId(), name: fileName, code: '', folderId: parentFolderId };
            
            if (isText) {
                try {
                    const content = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsText(file, 'UTF-8');
                    });
                    if (content && content.split('\n').length > MAX_LINES) {
                        fileObj.code = '';
                        excludedFiles.push(pathPrefix + fileName + ` (超過${MAX_LINES}行)`);
                    } else {
                        fileObj.code = trimTrailingEmptyLines(content || '');
                    }
                } catch (e) {
                    // 忽略讀取錯誤
                }
            }
            newFiles.push(fileObj);

        } else if (entry.isDirectory) {
            const dirName = entry.name;
            if (dirName.startsWith('.') && dirName !== '.github') {
                excludedFiles.push(pathPrefix + dirName + '/');
                return;
            }
            if (EXCLUDED_DIRS.has(dirName) || dirName.endsWith('.app')) {
                excludedFiles.push(pathPrefix + dirName + '/');
                return;
            }

            // 建立資料夾
            const folderId = generateId();
            newFolders.push({ id: folderId, name: dirName, parentFolderId: parentFolderId });

            const dirReader = entry.createReader();
            const readAllEntries = async () => {
                const allEntries = [];
                return new Promise((resolve, reject) => {
                    const readBatch = () => {
                        dirReader.readEntries((batch) => {
                            if (batch.length === 0) {
                                resolve(allEntries);
                            } else {
                                allEntries.push(...batch);
                                readBatch();
                            }
                        }, reject);
                    };
                    readBatch();
                });
            };

            const children = await readAllEntries();
            for (const child of children) {
                await traverseEntry(child, depth + 1, folderId, pathPrefix + dirName + '/');
            }
        }
    }

    const entries = [];
    for (let i = 0; i < dataTransferItems.length; i++) {
        const item = dataTransferItems[i];
        if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : (item.getAsEntry ? item.getAsEntry() : null);
            if (entry) {
                entries.push(entry);
            }
        }
    }

    for (const entry of entries) {
        await traverseEntry(entry, 0, targetFolderId, '');
    }

    return { newFolders, newFiles, excludedFiles };
}

/**
 * 主畫面拖曳：將資料夾/檔案轉為新專案
 * 行為與「匯入文件夾 → 新增專案」一致：
 * - 若拖入單一資料夾，專案名稱 = 該資料夾名稱，內容置於專案根目錄
 * - 若拖入多個項目或僅檔案，專案名稱 = 「未命名專案」（若重名則加序號）
 */
export async function processDropToNewProject(dataTransferItems) {
    const excludedFiles = [];
    const folders = [];
    const filesArr = [];

    async function traverseEntry(entry, depth, parentFolderId, pathPrefix) {
        if (depth > MAX_DEPTH) {
            excludedFiles.push(pathPrefix + entry.name + (entry.isDirectory ? '/' : '') + ' (超過深度限制)');
            return;
        }

        if (entry.isFile) {
            const fileName = entry.name;
            if (fileName.startsWith('.') && fileName !== '.github') {
                excludedFiles.push(pathPrefix + fileName);
                return;
            }
            const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
            if (EXCLUDED_EXTENSIONS.has(ext)) {
                excludedFiles.push(pathPrefix + fileName);
                return;
            }

            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));

            let isText = file.type.startsWith('text/') || file.type === 'application/json' ||
                         file.type === 'application/javascript' || file.type === 'application/xml' ||
                         TEXT_EXTENSIONS.has(ext) ||
                         (fileName.startsWith('.') && TEXT_EXTENSIONS.has(fileName.substring(1).toLowerCase())) ||
                         ext === '';

            const MAX_FILE_SIZE = 1024 * 1024;
            if (isText && file.size > MAX_FILE_SIZE) isText = false;

            const fileObj = { id: generateId(), name: fileName, code: '', folderId: parentFolderId };

            if (isText) {
                try {
                    const content = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsText(file, 'UTF-8');
                    });
                    if (content && content.split('\n').length > MAX_LINES) {
                        fileObj.code = '';
                        excludedFiles.push(pathPrefix + fileName + ` (超過${MAX_LINES}行)`);
                    } else {
                        fileObj.code = trimTrailingEmptyLines(content || '');
                    }
                } catch {
                    // 讀取失敗
                }
            }
            filesArr.push(fileObj);
            return;
        }

        if (entry.isDirectory) {
            const dirName = entry.name;
            if (dirName.startsWith('.') && dirName !== '.github') {
                excludedFiles.push(pathPrefix + dirName + '/');
                return;
            }
            if (EXCLUDED_DIRS.has(dirName) || dirName.endsWith('.app')) {
                excludedFiles.push(pathPrefix + dirName + '/');
                return;
            }

            const folderId = generateId();
            folders.push({ id: folderId, name: dirName, parentFolderId });

            const dirReader = entry.createReader();
            const readAllEntries = () => new Promise((resolve, reject) => {
                const all = [];
                const readBatch = () => {
                    dirReader.readEntries((batch) => {
                        if (batch.length === 0) resolve(all);
                        else {
                            all.push(...batch);
                            readBatch();
                        }
                    }, reject);
                };
                readBatch();
            });

            const children = await readAllEntries();
            for (const child of children) {
                await traverseEntry(child, depth + 1, folderId, pathPrefix + dirName + '/');
            }
        }
    }

    const entries = [];
    for (let i = 0; i < dataTransferItems.length; i++) {
        const item = dataTransferItems[i];
        if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : (item.getAsEntry ? item.getAsEntry() : null);
            if (entry) entries.push(entry);
        }
    }

    if (!entries.length) {
        return { folders: [], files: [], excludedFiles, projectName: null };
    }

    // 單一頂層資料夾：專案名 = 資料夾名，內容放在專案根目錄（與 file input 行為一致）
    if (entries.length === 1 && entries[0].isDirectory) {
        const rootDir = entries[0];
        const projectName = rootDir.name;

        if (EXCLUDED_DIRS.has(projectName) || projectName.endsWith('.app') ||
            (projectName.startsWith('.') && projectName !== '.github')) {
            excludedFiles.push(projectName + '/');
            return { folders: [], files: [], excludedFiles, projectName: null };
        }

        const dirReader = rootDir.createReader();
        const readAllEntries = () => new Promise((resolve, reject) => {
            const all = [];
            const readBatch = () => {
                dirReader.readEntries((batch) => {
                    if (batch.length === 0) resolve(all);
                    else {
                        all.push(...batch);
                        readBatch();
                    }
                }, reject);
            };
            readBatch();
        });

        const children = await readAllEntries();
        for (const child of children) {
            await traverseEntry(child, 1, null, projectName + '/');
        }

        return { folders, files: filesArr, excludedFiles, projectName };
    }

    // 多個項目或僅檔案：全部放在根目錄
    for (const entry of entries) {
        await traverseEntry(entry, 0, null, '');
    }

    return { folders, files: filesArr, excludedFiles, projectName: '未命名專案' };
}

/**
 * 將已讀取的資料夾結構套用為現有專案的新版本
 * （重用相同檔案、保存舊快照、寫入新內容並標記為當前版本）
 * 重複偵測只與「上一個版本」比較：
 * - 若已有版本歷史 → 用最後一個版本作為比對基準
 * - 若尚無版本 → 先把當前狀態存成版本 1，再以該快照作為比對基準
 * @returns {{ reused: number, updated: number, added: number }}
 */
export function applyImportedFolderAsNewVersion(targetProject, result) {
    // 先決定比對基準（上一個版本）
    let compareBase = null;

    if (!targetProject.versions || targetProject.versions.length === 0) {
        // 尚無歷史：先以 SemVer 保存當前狀態，再以此為「上一個版本」
        const preLabel = getNextSemverLabel(targetProject);
        const snap = saveVersionSnapshot(targetProject, preLabel, '匯入前');
        compareBase = { folders: snap.folders, files: snap.files };
    } else {
        // 有歷史：只與最後一個版本比較
        const last = targetProject.versions[targetProject.versions.length - 1];
        compareBase = { folders: last.folders || [], files: last.files || [] };
    }

    const mergeStats = reuseExistingFileRecords(targetProject, result, compareBase);

    targetProject.folders = result.folders;
    targetProject.files = result.files;
    saveData();

    // 新匯入版本同樣以 SemVer 自動命名（次版本號 +1）
    const newVersionLabel = getNextSemverLabel(targetProject);
    const newSnapshot = saveVersionSnapshot(targetProject, newVersionLabel, '新匯入');

    targetProject.currentVersionId = newSnapshot.id;
    saveData();

    return mergeStats;
}

/**
 * 對「一組 folders + files」相對於 compareBase 標記 reusedFromPreviousVersion。
 * 不改動檔案 ID / 結構，只更新標記。
 * @returns {{ reused: number, total: number, hasPrevious: boolean }}
 */
function markReusedAgainstBase(folders, files, compareBase) {
    const fileList = files || [];
    // 先記下原本的標記，用來判斷是否真的有變更
    const beforeFlags = fileList.map(f => f.reusedFromPreviousVersion === true);

    fileList.forEach(f => {
        delete f.reusedFromPreviousVersion;
    });

    if (!compareBase) {
        const changed = beforeFlags.some(Boolean);
        return { reused: 0, total: fileList.length, hasPrevious: false, changed };
    }

    const oldFolders = compareBase.folders || [];
    const oldFiles = compareBase.files || [];
    const oldFolderPaths = getFolderPathMap(oldFolders);
    const currentFolderPaths = getFolderPathMap(folders || []);

    const oldFilesByPath = new Map();
    const oldFilesByNameAndCode = new Map();

    oldFiles.forEach(file => {
        const relPath = getFileRelativePath(file, oldFolderPaths);
        if (!oldFilesByPath.has(relPath)) {
            oldFilesByPath.set(relPath, file);
        }
        const contentKey = JSON.stringify([file.name, file.code ?? '']);
        if (!oldFilesByNameAndCode.has(contentKey)) {
            oldFilesByNameAndCode.set(contentKey, []);
        }
        oldFilesByNameAndCode.get(contentKey).push(file);
    });

    const usedOldIds = new Set();
    let reused = 0;

    fileList.forEach(file => {
        const incomingCode = file.code ?? '';
        const relPath = getFileRelativePath(file, currentFolderPaths);
        const contentKey = JSON.stringify([file.name, incomingCode]);

        let oldFile = null;

        const pathCandidate = oldFilesByPath.get(relPath);
        if (
            pathCandidate &&
            !usedOldIds.has(pathCandidate.id) &&
            pathCandidate.name === file.name &&
            isIdenticalFileContent(pathCandidate, { code: incomingCode })
        ) {
            oldFile = pathCandidate;
        }

        if (!oldFile) {
            oldFile = (oldFilesByNameAndCode.get(contentKey) || []).find(
                candidate => !usedOldIds.has(candidate.id)
            ) || null;
        }

        if (oldFile) {
            usedOldIds.add(oldFile.id);
            file.reusedFromPreviousVersion = true;
            reused++;
        }
    });

    const afterFlags = fileList.map(f => f.reusedFromPreviousVersion === true);
    const changed = beforeFlags.length !== afterFlags.length ||
        beforeFlags.some((v, i) => v !== afterFlags[i]);

    return { reused, total: fileList.length, hasPrevious: true, changed };
}

/**
 * 手動重複代碼偵測：僅與上一個版本比較，標記目前檔案的 reusedFromPreviousVersion。
 * 不改動檔案 ID / 結構，只更新標記並回傳統計。
 * @returns {{ reused: number, total: number, hasPrevious: boolean }}
 */
export function detectReusedAgainstPreviousVersion(project) {
    const prev = getPreviousVersionSnapshot(project);
    return markReusedAgainstBase(project.folders || [], project.files || [], prev);
}

/**
 * 為專案中「所有已存在版本」以及目前工作區執行重複代碼檢測並寫回（覆寫，不另存新版本）。
 *
 * 規則：
 * - 版本陣列依序處理：版本 i 與版本 i-1 比對（第一個版本無可比對基準）
 * - 再對目前工作區（project.folders / project.files）與「上一個版本」比對
 * - 標記寫回各版本快照與目前工作區；呼叫端應再 saveData / 必要時 overwrite 當前版本
 *
 * @returns {{
 *   current: { reused: number, total: number, hasPrevious: boolean },
 *   versionsProcessed: number,
 *   versionsWithPrevious: number,
 *   versionResults: Array<{ id: string, label: string, reused: number, total: number, hasPrevious: boolean }>
 * }}
 */
export function detectReusedForAllVersions(project) {
    const versions = project?.versions || [];
    const versionResults = [];
    let versionsWithPrevious = 0;
    let anyChanged = false;

    for (let i = 0; i < versions.length; i++) {
        const version = versions[i];
        const compareBase = i > 0
            ? { folders: versions[i - 1].folders || [], files: versions[i - 1].files || [] }
            : null;

        // 就地標記該版本快照內的檔案（不另存新版本）
        const stats = markReusedAgainstBase(
            version.folders || [],
            version.files || [],
            compareBase
        );
        // 只有標記真的變了才動 timestamp，避免每次檢測都重寫 IDB
        if (stats.changed) {
            version.timestamp = new Date().toISOString();
            anyChanged = true;
        }

        if (stats.hasPrevious) versionsWithPrevious++;
        versionResults.push({
            id: version.id,
            label: version.label || `版本 ${i + 1}`,
            reused: stats.reused,
            total: stats.total,
            hasPrevious: stats.hasPrevious
        });
    }

    // 目前工作區：與「上一個版本」比對（沿用既有 getPreviousVersionSnapshot 規則）
    const currentStats = detectReusedAgainstPreviousVersion(project);
    if (currentStats.changed) anyChanged = true;

    return {
        current: currentStats,
        versionsProcessed: versions.length,
        versionsWithPrevious,
        versionResults,
        changed: anyChanged
    };
}