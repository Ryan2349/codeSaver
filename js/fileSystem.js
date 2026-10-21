import { state } from './state.js';
import { generateId, showToast, escapeHtml } from './utils.js';
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
 * 更新既有專案時，按相對路徑保留同一個檔案 ID；內容完全相同時沿用舊檔案記錄。
 * 匯入的資料夾若路徑相同，也會沿用舊資料夾 ID，避免檔案參照失效。
 */
export function reuseExistingFileRecords(project, imported) {
    const oldFolders = project.folders || [];
    const oldFiles = project.files || [];
    const importedFolders = imported.folders || [];
    const importedFiles = imported.files || [];
    const oldFolderPaths = getFolderPathMap(oldFolders);
    const importedFolderPaths = getFolderPathMap(importedFolders);

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

    const oldFilesByPath = new Map();
    const oldFileFolderPaths = getFolderPathMap(oldFolders);
    oldFiles.forEach(file => {
        const path = getFileRelativePath(file, oldFileFolderPaths);
        if (!oldFilesByPath.has(path)) oldFilesByPath.set(path, file);
    });

    const oldFilesByNameAndCode = new Map();
    oldFiles.forEach(file => {
        const key = JSON.stringify([file.name, file.code]);
        if (!oldFilesByNameAndCode.has(key)) oldFilesByNameAndCode.set(key, []);
        oldFilesByNameAndCode.get(key).push(file);
    });

    const incomingPaths = new Set(importedFiles.map(file => getFileRelativePath(file, importedFolderPaths)));
    const reservedPathIds = new Set();
    importedFiles.forEach(file => {
        const oldFile = oldFilesByPath.get(getFileRelativePath(file, importedFolderPaths));
        if (oldFile) reservedPathIds.add(oldFile.id);
    });

    const usedOldIds = new Set();
    const stats = { reused: 0, updated: 0, added: 0 };
    imported.files = importedFiles.map(file => {
        const path = getFileRelativePath(file, importedFolderPaths);
        const pathMatch = oldFilesByPath.get(path);
        const folderId = file.folderId
            ? folderIdMap.get(file.folderId) || file.folderId
            : null;
        let oldFile = pathMatch && !usedOldIds.has(pathMatch.id) ? pathMatch : null;

        // A file moved to another folder can still reuse an unclaimed old record
        // when both its name and complete code are identical.
        if (!oldFile) {
            const key = JSON.stringify([file.name, file.code]);
            oldFile = (oldFilesByNameAndCode.get(key) || []).find(candidate =>
                !usedOldIds.has(candidate.id) &&
                !reservedPathIds.has(candidate.id) &&
                !incomingPaths.has(getFileRelativePath(candidate, oldFileFolderPaths))
            ) || null;
        }

        if (!oldFile) {
            stats.added++;
            return { ...file, folderId };
        }

        usedOldIds.add(oldFile.id);
        const isExactDuplicate = oldFile.name === file.name && oldFile.code === file.code;
        if (isExactDuplicate) stats.reused++;
        else stats.updated++;

        return isExactDuplicate
            ? { ...oldFile, folderId, reusedFromPreviousVersion: true }
            : { ...file, id: oldFile.id, folderId };
    });

    return stats;
}

export function getRootFolderIdsWithReusedFiles(project) {
    const foldersById = new Map((project?.folders || []).map(folder => [folder.id, folder]));
    const rootFolderIds = new Set();

    for (const file of project?.files || []) {
        if (file.reusedFromPreviousVersion !== true || !file.folderId) continue;

        let folder = foldersById.get(file.folderId);
        let rootFolder = null;
        const visited = new Set();
        while (folder) {
            if (visited.has(folder.id)) {
                rootFolder = null;
                break;
            }
            visited.add(folder.id);
            rootFolder = folder;
            if (!folder.parentFolderId) break;
            folder = foldersById.get(folder.parentFolderId);
        }

        if (rootFolder && !rootFolder.parentFolderId) rootFolderIds.add(rootFolder.id);
    }

    return rootFolderIds;
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
                <p>匯入的文件夾會成為新版本，舊內容會保留在版本歷史。相同檔名及完整程式碼的檔案會沿用既有記錄（優先比對相對路徑）；歷史版本中的重複程式碼也會共用本機儲存內容。</p>
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
                fileObj.code = content;
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

            const mergeStats = reuseExistingFileRecords(targetProject, result);

            // ✅ 僅在版本歷史為空時，才保存匯入前的快照
            if (!targetProject.versions || targetProject.versions.length === 0) {
                const oldVersionLabel = `版本 1 (匯入前)`;
                saveVersionSnapshot(targetProject, oldVersionLabel);
            }

            // 更新專案為新內容
            targetProject.folders = result.folders;
            targetProject.files = result.files;
            saveData();

            // ✅ 保存新版本快照（匯入後的狀態）
            const newVersionLabel = `版本 ${(targetProject.versions?.length || 0) + 1} (新匯入)`;
            const newSnapshot = saveVersionSnapshot(targetProject, newVersionLabel);

            // ✅ 設定當前版本為新匯入的版本
            targetProject.currentVersionId = newSnapshot.id;
            saveData();

            showToast(`✅ 已將「${targetProject.name}」更新為新版本：重用 ${mergeStats.reused} 個相同檔案、更新 ${mergeStats.updated} 個、新增 ${mergeStats.added} 個`);
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
 * 處理從作業系統拖曳進來的檔案/資料夾
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
                        fileObj.code = content || '';
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
