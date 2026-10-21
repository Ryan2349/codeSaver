import { state } from '../state.js';
import { saveData, getFileById, saveVersionSnapshot, deleteVersion, restoreVersion, overwriteVersion } from '../storage.js';
import { generateId, escapeHtml, showToast, copyToClipboard, downloadBlob, downloadJSON, formatDateTime } from '../utils.js';
import { exportProjectToMarkdownFiltered, generateTreeMarkdown } from '../markdown.js';
import { getCurrentFolderFiles, getCurrentFolderSubfolders, getFolderPath, deleteFolderRecursive, processExternalDrop, showExcludedFilesModal, getRootFolderIdsWithReusedFiles } from '../fileSystem.js';
import { createZipBlob } from '../zip.js';

const MAX_LINES = 10000;

export function saveCurrentCode() {
    if (state.autoSaveTimeout) {
        clearTimeout(state.autoSaveTimeout);
        state.autoSaveTimeout = null;
    }
    const codeTextarea = document.getElementById('codeTextarea');
    if (codeTextarea && state.currentFileId && state.currentView === 'project') {
        const project = state.appData.projects.find(p => p.id === state.currentProjectId);
        const file = getFileById(project, state.currentFileId);
        if (file) {
            let code = codeTextarea.value;
            const lines = code.split('\n');
            if (lines.length > MAX_LINES) {
                code = lines.slice(0, MAX_LINES).join('\n');
                codeTextarea.value = code;
                showToast('⚠️ 已達檔案行數上限 (10,000 行)，儲存時已截斷');
            }
            file.code = code;
            saveData();
        }
    }
}

function getFolderFullPathString(project, folderId) {
    if (!folderId) return '';
    const path = getFolderPath(project, folderId);
    return path.map(p => p.name).join('/');
}

function buildZipEntries(project) {
    const entries = [];
    for (const folder of project.folders) {
        const path = getFolderFullPathString(project, folder.id) + '/';
        entries.push({ path, content: '', isFolder: true });
    }
    for (const file of project.files) {
        let filePath = file.name;
        if (file.folderId) {
            const folderPath = getFolderFullPathString(project, file.folderId);
            filePath = folderPath + '/' + file.name;
        }
        entries.push({ path: filePath, content: file.code || '', isFolder: false });
    }
    entries.sort((a, b) => {
        if (a.isFolder && !b.isFolder) return -1;
        if (!a.isFolder && b.isFolder) return 1;
        return a.path.localeCompare(b.path);
    });
    return entries;
}

function exportProjectAsZip(project) {
    saveCurrentCode();
    if (!project.files.length && !project.folders.length) {
        showToast('⚠️ 專案中沒有內容可以匯出');
        return;
    }
    const entries = buildZipEntries(project);
    if (!entries.length) {
        showToast('⚠️ 專案中沒有內容可以匯出');
        return;
    }
    try {
        const blob = createZipBlob(entries);
        const safeName = (project.name || 'project').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-\s]/g, '_');
        downloadBlob(blob, `${safeName}.zip`);
        showToast('📥 ZIP 檔案已下載');
    } catch (e) {
        console.error('ZIP 匯出失敗:', e);
        showToast('❌ ZIP 匯出失敗');
    }
}

function showExportJsonModal(project) {
    const existing = document.getElementById('exportJsonModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'exportJsonModal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.4); display: flex; justify-content: center;
        align-items: center; z-index: 2000; backdrop-filter: blur(4px);
    `;

    modal.innerHTML = `
        <div style="background: #fffbf5; border-radius: 1.8rem; padding: 2rem;
            box-shadow: 0 20px 30px rgba(0,0,0,0.2);
            width: 90%; max-width: 420px; display: flex; flex-direction: column;
            border: 1px solid #eedcc8; text-align: center;">
            <h3 style="color: #5e4632; margin: 0 0 1rem 0;">📤 匯出 JSON</h3>
            <p style="color: #8b7355; margin: 0 0 1.5rem 0; font-size: 0.95rem;">
                請選擇要匯出的內容範圍
            </p>
            <div style="display: flex; flex-direction: column; gap: 0.8rem;">
                <button id="exportCurrentOnlyBtn" class="btn" style="width: 100%;">
                    📄 僅當前版本
                </button>
                <button id="exportAllVersionsBtn" class="btn btn-outline" style="width: 100%;">
                    📚 包含所有歷史版本
                </button>
            </div>
            <button id="cancelExportJsonBtn" style="background: none; border: none; color: #8b7355;
                margin-top: 1.5rem; cursor: pointer; font-size: 0.9rem; align-self: center;
                padding: 0.4rem 1.2rem; border-radius: 1rem; transition: background 0.2s;"
                onmouseover="this.style.background='rgba(179,146,100,0.12)'"
                onmouseout="this.style.background='none'">取消</button>
        </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    document.getElementById('cancelExportJsonBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    document.getElementById('exportCurrentOnlyBtn').addEventListener('click', () => {
        const data = {
            type: 'project',
            data: {
                id: project.id,
                name: project.name,
                folders: project.folders,
                files: project.files,
                versions: [],
                currentVersionId: null
            }
        };
        downloadJSON(data, project.name + '_當前版本');
        closeModal();
    });

    document.getElementById('exportAllVersionsBtn').addEventListener('click', () => {
        const data = {
            type: 'project',
            data: {
                id: project.id,
                name: project.name,
                folders: project.folders,
                files: project.files,
                versions: project.versions,
                currentVersionId: project.currentVersionId
            }
        };
        downloadJSON(data, project.name + '_完整備份');
        closeModal();
    });
}

export function renderProjectView(project, actions) {
    if (!project) return actions.goHome();
    saveCurrentCode();

    if (!project.versions) project.versions = [];
    if (project.currentVersionId === undefined) project.currentVersionId = null;

    if (!project.files?.length) state.currentFileId = null;
    else if (!project.files.find(f => f.id === state.currentFileId)) state.currentFileId = project.files[0].id;

    const appContainer = document.getElementById('appContainer');
    appContainer.innerHTML = `
        <div class="header">
            <div class="logo">
                💻 <span id="projectNameDisplay">${escapeHtml(project.name)}</span>
                <button class="edit-btn" id="editProjectNameBtn">✏️ 編輯</button>
                <button class="delete-btn" id="deleteProjectBtn">🗑️ 刪除專案</button>
            </div>
            <div class="header-actions">
                <button class="version-toggle-btn" id="versionToggleBtn">🕐 版本歷史</button>
                <button class="export-json-btn" id="exportZipBtn">📁 匯出文件夾</button>
                <button class="export-json-btn" id="exportProjectJsonBtn">📤 匯出 JSON</button>
                <button class="back-btn" id="backBtn">← 所有專案</button>
            </div>
        </div>
        <div class="main-view">
            <div class="form-row">
                <input class="input-field" id="newItemNameInput" placeholder="輸入檔案或資料夾名稱..." autocomplete="off">
                <button class="btn" id="addFileBtn">➕ 新增檔案</button>
                <button class="btn btn-outline" id="addFolderBtn">📁 新增資料夾</button>
            </div>
            <div class="project-container">
                <div class="file-sidebar">
                    <div class="breadcrumb" id="breadcrumb"></div>
                    <div class="file-list" id="fileList"></div>
                </div>
                <div class="code-editor-area" id="codeArea"></div>
                <div class="version-sidebar ${state.versionSidebarOpen ? '' : 'collapsed'}" id="versionSidebar">
                    <div class="version-sidebar-title">🕐 版本歷史</div>
                    <div class="version-save-row">
                        <button id="manualSaveVersionBtn" class="btn btn-outline" style="font-size:0.8rem; padding:0.3rem 0.8rem; width:100%;">💾 保存當前版本</button>
                    </div>
                    <div id="versionList"></div>
                </div>
            </div>
        </div>`;

    // ===== 事件綁定 =====
    document.getElementById('backBtn').addEventListener('click', () => actions.goHome());
    document.getElementById('exportZipBtn').addEventListener('click', () => exportProjectAsZip(project));
    document.getElementById('exportProjectJsonBtn').addEventListener('click', () => {
        saveCurrentCode();
        showExportJsonModal(project);
    });
    document.getElementById('deleteProjectBtn').addEventListener('click', () => {
        if (confirm('刪除整個專案？（包含所有版本歷史）')) {
            state.appData.projects = state.appData.projects.filter(p => p.id !== project.id);
            saveData();
            actions.goHome();
        }
    });
    document.getElementById('editProjectNameBtn').addEventListener('click', () => {
        const newName = prompt('新的專案名稱', project.name);
        if (newName?.trim()) {
            project.name = newName.trim();
            saveData();
            document.getElementById('projectNameDisplay').textContent = project.name;
            showToast('✅ 專案名稱已更新');
        }
    });

    // 版本歷史 sidebar 切換
    document.getElementById('versionToggleBtn').addEventListener('click', () => {
        state.versionSidebarOpen = !state.versionSidebarOpen;
        const sidebar = document.getElementById('versionSidebar');
        if (sidebar) {
            sidebar.classList.toggle('collapsed', !state.versionSidebarOpen);
        }
    });

    // 手動保存版本按鈕事件（保存後自動設為當前版本）
    document.getElementById('manualSaveVersionBtn').addEventListener('click', () => {
        saveCurrentCode();
        const label = prompt('請輸入版本名稱（可留空自動命名）：');
        if (label === null) return;
        const versionLabel = label?.trim() ? label.trim() : `版本 ${(project.versions?.length || 0) + 1}`;
        const snapshot = saveVersionSnapshot(project, versionLabel);
        // 設定當前版本為新保存的版本
        project.currentVersionId = snapshot.id;
        saveData();
        renderVersionList();
        showToast('✅ 版本已保存，並已設為當前版本');
    });

    const fileList = document.getElementById('fileList');
    const codeArea = document.getElementById('codeArea');
    const newItemNameInput = document.getElementById('newItemNameInput');
    const breadcrumb = document.getElementById('breadcrumb');
    const addFileBtn = document.getElementById('addFileBtn');
    const addFolderBtn = document.getElementById('addFolderBtn');
    const fileSidebar = document.querySelector('.file-sidebar');

    // ===== 外部拖曳匯入邏輯 =====
    if (fileSidebar) {
        fileSidebar.addEventListener('dragenter', (e) => {
            if (state.isDraggingInternal) return;
            e.preventDefault();
            fileSidebar.classList.add('drop-zone-active');
        });
        
        fileSidebar.addEventListener('dragover', (e) => {
            if (state.isDraggingInternal) return;
            e.preventDefault();
        });
        
        fileSidebar.addEventListener('dragleave', (e) => {
            if (state.isDraggingInternal) return;
            if (!fileSidebar.contains(e.relatedTarget)) {
                fileSidebar.classList.remove('drop-zone-active');
            }
        });
        
        fileSidebar.addEventListener('drop', async (e) => {
            if (state.isDraggingInternal) return;
            e.preventDefault();
            fileSidebar.classList.remove('drop-zone-active');
            
            if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
                const targetFolderId = state.currentFolderId;
                const { newFolders, newFiles, excludedFiles } = await processExternalDrop(e.dataTransfer.items, targetFolderId);
                
                if (newFolders.length === 0 && newFiles.length === 0) {
                    if (excludedFiles.length > 0) {
                        await showExcludedFilesModal(excludedFiles);
                    } else {
                        showToast('⚠️ 沒有可匯入的檔案');
                    }
                    return;
                }
                
                if (excludedFiles.length > 0) {
                    await showExcludedFilesModal(excludedFiles);
                }
                
                project.folders.push(...newFolders);
                project.files.push(...newFiles);
                saveData();
                showToast(`✅ 已匯入 ${newFiles.length} 個檔案和 ${newFolders.length} 個資料夾`);
                renderFileListAndEditor();
            }
        });
    }

    // ===== 版本歷史渲染 =====
    function renderVersionList() {
        const versionList = document.getElementById('versionList');
        if (!versionList) return;

        if (!project.versions || project.versions.length === 0) {
            versionList.innerHTML = `<div class="version-empty">尚無歷史版本<br><small>匯入新版本時會自動保存舊版</small></div>`;
            return;
        }

        const sortedVersions = [...project.versions].reverse();
        versionList.innerHTML = sortedVersions.map((v, idx) => {
            const isCurrent = project.currentVersionId === v.id;
            return `
                <div class="version-item ${isCurrent ? 'version-current' : ''}" data-version-id="${v.id}">
                    <div class="version-item-header">
                        <span class="version-item-label">${escapeHtml(v.label)}</span>
                        ${isCurrent ? '<span class="version-current-badge">當前</span>' : ''}
                    </div>
                    <span class="version-item-date">${formatDateTime(v.timestamp)}</span>
                    <div class="version-item-actions">
                        <button data-action="save-to-version" data-id="${v.id}">保存</button>
                        <button data-action="restore-version" data-id="${v.id}">還原</button>
                        <button data-action="edit-version-label" data-id="${v.id}">編輯</button>
                        <button class="version-delete-btn" data-action="delete-version" data-id="${v.id}">✕</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // 版本列表事件
    const versionListEl = document.getElementById('versionList');
    if (versionListEl) {
        versionListEl.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const action = btn.dataset.action;
            const versionId = btn.dataset.id;

            if (action === 'restore-version') {
                if (confirm('確定要還原到此版本？當前內容將會被直接覆蓋，且不會自動備份。')) {
                    saveCurrentCode();
                    if (restoreVersion(project, versionId)) {
                        state.currentFolderId = null;
                        state.currentFileId = project.files.length > 0 ? project.files[0].id : null;
                        showToast('✅ 已還原版本');
                        renderFileListAndEditor();
                        renderVersionList();
                    }
                }
            } else if (action === 'save-to-version') {
                if (confirm('確定要將當前內容覆蓋保存到此版本？此操作不會新增版本，而是直接替換該歷史版本的內容。')) {
                    saveCurrentCode();
                    if (overwriteVersion(project, versionId)) {
                        showToast('✅ 已覆蓋保存到此版本');
                        renderVersionList();
                    }
                }
            } else if (action === 'delete-version') {
                if (confirm('刪除此版本記錄？')) {
                    deleteVersion(project, versionId);
                    renderVersionList();
                    showToast('🗑️ 版本已刪除');
                }
            } else if (action === 'edit-version-label') {
                const version = project.versions.find(v => v.id === versionId);
                if (version) {
                    const newLabel = prompt('修改版本名稱：', version.label);
                    if (newLabel !== null && newLabel.trim() !== '') {
                        version.label = newLabel.trim();
                        saveData();
                        renderVersionList();
                        showToast('✅ 版本名稱已更新');
                    }
                }
            }
        });
    }

    // ===== 麵包屑 =====
    function renderBreadcrumb() {
        const path = getFolderPath(project, state.currentFolderId);
        let html = `<span data-folder-id="null" style="font-weight:600;">📂 根目錄</span>`;
        path.forEach((item) => {
            html += ` <span class="separator">/</span> <span data-folder-id="${item.id}">${escapeHtml(item.name)}</span>`;
        });
        breadcrumb.innerHTML = html;
    }

    function moveFileToFolder(targetFolderId) {
        if (!state.draggedFileId) return;
        const file = getFileById(project, state.draggedFileId);
        if (!file) return;
        if (file.folderId === targetFolderId) return showToast('檔案已在該目錄中');
        file.folderId = targetFolderId;
        saveData();
        showToast('📁 檔案已移動');
        state.draggedFileId = null;
        renderFileListAndEditor();
    }

    breadcrumb.addEventListener('click', (e) => {
        const span = e.target.closest('span[data-folder-id]');
        if (!span) return;
        const fid = span.dataset.folderId;
        state.currentFolderId = fid === 'null' ? null : fid;
        state.draggedFileId = null;
        saveCurrentCode();
        renderFileListAndEditor();
    });

    fileList.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (btn) {
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            if (action === 'delete-folder') {
                if (confirm('刪除此資料夾及其內所有檔案？')) {
                    deleteFolderRecursive(project, id);
                    if (state.currentFolderId === id) state.currentFolderId = null;
                    if (state.currentFileId && !project.files.find(f => f.id === state.currentFileId))
                        state.currentFileId = project.files.length > 0 ? project.files[0].id : null;
                    saveData();
                    renderFileListAndEditor();
                }
            } else if (action === 'delete-file') {
                if (confirm('刪除這個檔案？')) {
                    project.files = project.files.filter(f => f.id !== id);
                    if (state.currentFileId === id) state.currentFileId = project.files.length > 0 ? project.files[0].id : null;
                    if (state.draggedFileId === id) state.draggedFileId = null;
                    saveData();
                    renderFileListAndEditor();
                }
            }
            return;
        }
        const folderItem = e.target.closest('.folder-item');
        if (folderItem) {
            state.currentFolderId = folderItem.dataset.folderId;
            state.draggedFileId = null;
            saveCurrentCode();
            renderFileListAndEditor();
            return;
        }
        const fileItem = e.target.closest('.file-item');
        if (fileItem) {
            saveCurrentCode();
            state.currentFileId = fileItem.dataset.fileId;
            renderFileListAndEditor();
            return;
        }
    });

    const handleDragOver = (e) => {
        e.preventDefault();
        const target = e.target.closest('.folder-item, span[data-folder-id]');
        if (target && state.draggedFileId) target.classList.add('drop-target');
    };
    const handleDragLeave = (e) => {
        const target = e.target.closest('.folder-item, span[data-folder-id]');
        if (target) target.classList.remove('drop-target');
    };
    const handleDrop = (e) => {
        e.preventDefault();
        const target = e.target.closest('.folder-item, span[data-folder-id]');
        document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        if (!target) return;
        const targetFolderId = target.dataset.folderId === 'null' ? null : target.dataset.folderId;
        moveFileToFolder(targetFolderId);
    };

    fileList.addEventListener('dragover', handleDragOver);
    fileList.addEventListener('dragleave', handleDragLeave);
    fileList.addEventListener('drop', handleDrop);
    breadcrumb.addEventListener('dragover', handleDragOver);
    breadcrumb.addEventListener('dragleave', handleDragLeave);
    breadcrumb.addEventListener('drop', handleDrop);

    fileList.addEventListener('dragstart', (e) => {
        const fileItem = e.target.closest('.file-item');
        if (!fileItem) return;
        state.isDraggingInternal = true;
        state.draggedFileId = fileItem.dataset.fileId;
        fileItem.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', state.draggedFileId);
    });

    fileList.addEventListener('dragend', (e) => {
        const fileItem = e.target.closest('.file-item');
        if (fileItem) fileItem.classList.remove('dragging');
        state.draggedFileId = null;
        state.isDraggingInternal = false;
        document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    });

    function renderFileList() {
        const isRootFolderView = state.currentFolderId === null;
        const reusedRootFolderIds = isRootFolderView
            ? getRootFolderIdsWithReusedFiles(project)
            : new Set();
        const folders = getCurrentFolderSubfolders(project).sort((a, b) => a.name.localeCompare(b.name));
        const files = getCurrentFolderFiles(project).sort((a, b) => a.name.localeCompare(b.name));
        if (folders.length === 0 && files.length === 0) {
            fileList.innerHTML = `<div class="empty-message" style="padding:1rem;">此目錄為空</div>`;
            return;
        }
        let html = '';
        folders.forEach(f => {
            const reusedClass = reusedRootFolderIds.has(f.id) ? ' reused-file-folder' : '';
            html += `<div class="folder-item${reusedClass}" data-folder-id="${f.id}">
                <span style="flex:1;">📁 ${escapeHtml(f.name)}</span>
                <div class="actions"><button class="folder-delete-btn" data-action="delete-folder" data-id="${f.id}">✕</button></div>
            </div>`;
        });
        files.forEach(f => {
            const isActive = f.id === state.currentFileId;
            const reusedClass = isRootFolderView && f.reusedFromPreviousVersion === true ? ' reused-file-item' : '';
            html += `<div class="file-item${isActive ? ' active' : ''}${reusedClass}" data-file-id="${f.id}" draggable="true">
                <span style="flex:1;">📄 ${escapeHtml(f.name)}</span>
                <div class="actions"><button class="file-delete-btn" data-action="delete-file" data-id="${f.id}">✕</button></div>
            </div>`;
        });
        fileList.innerHTML = html;
    }

    function renderCodeEditor() {
        const file = getFileById(project, state.currentFileId);
        if (!file) {
            codeArea.innerHTML = `<div class="empty-message">請選擇一個檔案</div>`;
            return;
        }

        let code = file.code || '';
        const lines = code.split('\n');
        if (lines.length > MAX_LINES) {
            code = lines.slice(0, MAX_LINES).join('\n');
            file.code = code;
            saveData();
            showToast('⚠️ 檔案行數超過上限，已截斷至 10,000 行');
        }

        codeArea.innerHTML = `
            <div class="code-editor-wrapper">
                <div class="line-numbers" id="lineNumbers"></div>
                <textarea class="code-textarea" id="codeTextarea" placeholder="輸入代碼..." spellcheck="false">${escapeHtml(code)}</textarea>
            </div>
            <div class="code-actions">
                <button class="btn-outline btn" id="markdownBtn">📝 Markdown</button>
                <button class="btn-outline btn" id="scrollToBottomBtn">🔽 到底部</button>
            </div>`;
        const codeTextarea = document.getElementById('codeTextarea');
        const lineNumbers = document.getElementById('lineNumbers');

        function updateLineNumbers() {
            const lines = codeTextarea.value.split('\n').length;
            let nums = '';
            for (let i = 1; i <= lines; i++) nums += i + '\n';
            lineNumbers.textContent = nums;
        }

        function syncScroll() { lineNumbers.scrollTop = codeTextarea.scrollTop; }

        codeTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = codeTextarea.selectionStart;
                const end = codeTextarea.selectionEnd;
                const value = codeTextarea.value;

                if (start === end) {
                    codeTextarea.value = value.substring(0, start) + '  ' + value.substring(end);
                    codeTextarea.selectionStart = codeTextarea.selectionEnd = start + 2;
                } else {
                    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                    const selectedText = value.substring(lineStart, end);
                    const lines = selectedText.split('\n');
                    let newText;
                    if (e.shiftKey) {
                        newText = lines.map(line => line.startsWith('  ') ? line.substring(2) : (line.startsWith(' ') ? line.substring(1) : line)).join('\n');
                    } else {
                        newText = lines.map(line => '  ' + line).join('\n');
                    }
                    codeTextarea.value = value.substring(0, lineStart) + newText + value.substring(end);
                    codeTextarea.selectionStart = lineStart;
                    codeTextarea.selectionEnd = lineStart + newText.length;
                }
                codeTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        codeTextarea.addEventListener('input', () => {
            const value = codeTextarea.value;
            const currentLines = value.split('\n');
            if (currentLines.length > MAX_LINES) {
                codeTextarea.value = currentLines.slice(0, MAX_LINES).join('\n');
                codeTextarea.selectionStart = codeTextarea.value.length;
                codeTextarea.selectionEnd = codeTextarea.value.length;
                showToast('⚠️ 已達檔案行數上限 (10,000 行)');
            }
            updateLineNumbers();
            if (state.autoSaveTimeout) clearTimeout(state.autoSaveTimeout);
            state.autoSaveTimeout = setTimeout(() => {
                const f = getFileById(project, state.currentFileId);
                if (f) {
                    f.code = codeTextarea.value;
                    saveData();
                }
            }, 500);
        });
        codeTextarea.addEventListener('scroll', syncScroll);
        codeTextarea.addEventListener('blur', () => saveCurrentCode());

        updateLineNumbers();
        syncScroll();

        document.getElementById('markdownBtn').addEventListener('click', () => {
            saveCurrentCode();
            showMarkdownModal(project.name);
        });
        document.getElementById('scrollToBottomBtn').addEventListener('click', () => {
            codeTextarea.scrollTop = codeTextarea.scrollHeight;
        });
    }

    function showMarkdownModal(projectName) {
        const existing = document.getElementById('markdownModal');
        if (existing) existing.remove();

        function checkHasValidFiles(folderId) {
            const files = project.files.filter(f => f.folderId === folderId && f.code && f.code.trim().length > 0);
            if (files.length > 0) return true;
            const subfolders = project.folders.filter(f => f.parentFolderId === folderId);
            for (const sf of subfolders) {
                if (checkHasValidFiles(sf.id)) return true;
            }
            return false;
        }

        function generateTreeNodes(folderId, pathPrefix = '') {
            const subfolders = project.folders
                .filter(f => f.parentFolderId === folderId)
                .sort((a, b) => a.name.localeCompare(b.name));
            const files = project.files
                .filter(f => f.folderId === folderId && f.code && f.code.trim().length > 0)
                .sort((a, b) => a.name.localeCompare(b.name));

            let html = '';

            subfolders.forEach(folder => {
                if (!checkHasValidFiles(folder.id)) return;
                const childrenHTML = generateTreeNodes(folder.id, pathPrefix + folder.name + '/');
                html += `
                    <div class="tree-folder" data-folder-name="${escapeHtml(folder.name.toLowerCase())}">
                        <div class="tree-item folder-header">
                            <input type="checkbox" class="folder-checkbox" data-folder-id="${folder.id}">
                            <span class="toggle-icon">▶</span>
                            <span class="folder-name">📁 ${escapeHtml(folder.name)}</span>
                        </div>
                        <div class="tree-children">
                            ${childrenHTML}
                        </div>
                    </div>
                `;
            });

            files.forEach(file => {
                const fullPath = pathPrefix + file.name;
                html += `
                    <div class="tree-item file-header" data-file-path="${escapeHtml(fullPath.toLowerCase())}" data-file-name="${escapeHtml(file.name.toLowerCase())}">
                        <input type="checkbox" class="file-checkbox" data-file-id="${file.id}" checked>
                        <span class="file-name">📄 ${escapeHtml(file.name)}</span>
                    </div>
                `;
            });

            return html;
        }

        const treeHTML = generateTreeNodes(null);
        const treeText = projectName + '/\n' + generateTreeMarkdown(project, null);

        const modal = document.createElement('div');
        modal.id = 'markdownModal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.4); display: flex; justify-content: center;
            align-items: center; z-index: 2000; backdrop-filter: blur(4px);
        `;

        modal.innerHTML = `
            <style>
                #markdownModal .tree-folder { margin-bottom: 0.2rem; }
                #markdownModal .tree-children { display: none; margin-left: 1.2rem; border-left: 1px dashed #e6d7bd; padding-left: 0.8rem; margin-top: 0.2rem; }
                #markdownModal .tree-folder.expanded > .tree-children { display: block; }
                #markdownModal .tree-folder.expanded > .tree-item > .toggle-icon { transform: rotate(90deg); }
                #markdownModal .toggle-icon { transition: transform 0.2s; display: inline-block; width: 16px; text-align: center; color: #8b7355; font-size: 0.8rem; }
                #markdownModal .tree-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.2rem; cursor: pointer; border-radius: 0.4rem; user-select: none; }
                #markdownModal .tree-item:hover { background: rgba(179,146,100,0.08); }
                #markdownModal input[type="checkbox"] { cursor: pointer; width: 16px; height: 16px; accent-color: #5e4632; flex-shrink: 0; }
            </style>
            <div style="background: #fffbf5; border-radius: 1.8rem; padding: 2rem;
                box-shadow: 0 20px 30px rgba(0,0,0,0.2); 
                width: 90%; max-width: 700px; max-height: 85vh; display: flex; flex-direction: column;
                border: 1px solid #eedcc8;">
                <h3 style="color: #5e4632; margin: 0 0 1rem 0;">📝 Markdown 匯出選項</h3>
                <div style="margin-bottom: 0.8rem;">
                    <strong style="color: #5e4632; font-size: 0.9rem;">📂 專案結構預覽</strong>
                    <pre style="background: #faf6ef; border: 1px solid #e6d7bd; border-radius: 0.8rem; 
                        padding: 0.6rem; font-size: 0.8rem; max-height: 140px; overflow-y: auto; 
                        white-space: pre; font-family: monospace; margin: 0.3rem 0 0;">${escapeHtml(treeText)}</pre>
                </div>
                <p style="margin: 0 0 0.5rem 0; color: #8b7355; font-size: 0.9rem;">
                    選擇要匯出的檔案（點擊資料夾可展開，勾選資料夾會連動內部檔案）
                </p>
                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.8rem;">
                    <button id="checkAllBtn" class="btn-outline btn" style="padding: 0.3rem 1rem; font-size:0.8rem;">全選</button>
                    <button id="uncheckAllBtn" class="btn-outline btn" style="padding: 0.3rem 1rem; font-size:0.8rem;">取消全選</button>
                    <div style="display: flex; align-items: center; gap: 0.3rem; margin-left: auto;">
                        <input type="checkbox" id="includeStructureCheckbox" checked>
                        <label for="includeStructureCheckbox" style="color: #5e4632; font-size: 0.9rem; cursor: pointer; white-space: nowrap;">包含專案結構</label>
                    </div>
                </div>
                <div style="margin-bottom: 0.8rem;">
                    <input type="text" id="searchFileInput" placeholder="🔍 搜尋檔案名稱或路徑..." 
                        style="width: 100%; padding: 0.5rem 0.8rem; border: 1px solid #e6d7bd; border-radius: 0.8rem; font-size: 0.9rem; outline: none; box-sizing: border-box; transition: border-color 0.2s;"
                        onfocus="this.style.borderColor='#b39264'" onblur="this.style.borderColor='#e6d7bd'">
                </div>
                <div id="treeContainer" style="flex:1; overflow-y: auto; max-height: 300px; border: 1px solid #e6d7bd; border-radius: 1rem; padding: 0.8rem; background: #fffef9; margin-bottom: 1.2rem;">
                    ${treeHTML || '<div style="color:#8b7355; text-align:center;">尚無可匯出的代碼檔案</div>'}
                </div>
                <div style="display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap;">
                    <button id="copyMarkdownBtn" class="btn" style="flex:1; min-width:120px;">📋 複製到剪貼簿</button>
                    <button id="downloadMarkdownBtn" class="btn btn-outline" style="flex:1; min-width:120px;">📥 下載 .md 檔案</button>
                </div>
                <button id="closeMarkdownModal" style="background: none; border: none; color: #8b7355;
                    margin-top: 1.2rem; cursor: pointer; font-size: 0.9rem; align-self: center;
                    padding: 0.4rem 1.2rem; border-radius: 1rem; transition: background 0.2s;"
                    onmouseover="this.style.background='rgba(179,146,100,0.12)'"
                    onmouseout="this.style.background='none'">取消</button>
            </div>
        `;
        document.body.appendChild(modal);

        const closeModal = () => modal.remove();
        document.getElementById('closeMarkdownModal').addEventListener('click', closeModal);

        const getCheckedFileIds = () => {
            const ids = new Set();
            modal.querySelectorAll('input.file-checkbox:checked').forEach(cb => ids.add(cb.dataset.fileId));
            return ids;
        };

        function updateParentCheckboxes(checkboxElement) {
            let currentNode = checkboxElement.closest('.tree-children');
            while (currentNode) {
                const parentFolder = currentNode.closest('.tree-folder');
                if (!parentFolder) break;
                const parentCheckbox = parentFolder.querySelector(':scope > .tree-item > .folder-checkbox');
                if (!parentCheckbox) break;
                const fileCheckboxes = parentFolder.querySelectorAll('.file-checkbox');
                const checkedCount = Array.from(fileCheckboxes).filter(cb => cb.checked).length;
                const totalCount = fileCheckboxes.length;
                if (checkedCount === 0) {
                    parentCheckbox.checked = false;
                    parentCheckbox.indeterminate = false;
                } else if (checkedCount === totalCount) {
                    parentCheckbox.checked = true;
                    parentCheckbox.indeterminate = false;
                } else {
                    parentCheckbox.checked = false;
                    parentCheckbox.indeterminate = true;
                }
                currentNode = parentFolder.parentElement?.closest('.tree-children');
            }
        }

        const treeContainer = document.getElementById('treeContainer');

        const isVisible = (el) => {
            let current = el;
            while (current && current !== treeContainer) {
                if (current.style.display === 'none') return false;
                current = current.parentElement;
            }
            return true;
        };

        function filterTree(query) {
            const q = query.toLowerCase().trim();
            if (!treeContainer) return;
            const allFolders = treeContainer.querySelectorAll('.tree-folder');
            const allFiles = treeContainer.querySelectorAll('.file-header');
            if (!q) {
                allFolders.forEach(f => f.style.display = '');
                allFiles.forEach(f => f.style.display = '');
                return;
            }
            allFolders.forEach(f => { f.style.display = 'none'; f.classList.remove('expanded'); });
            allFiles.forEach(f => f.style.display = 'none');
            allFiles.forEach(fileEl => {
                const filePath = fileEl.getAttribute('data-file-path') || '';
                const fileName = fileEl.getAttribute('data-file-name') || '';
                if (filePath.includes(q) || fileName.includes(q)) {
                    fileEl.style.display = '';
                    let parent = fileEl.closest('.tree-folder');
                    while (parent) {
                        parent.style.display = '';
                        parent.classList.add('expanded');
                        parent = parent.parentElement?.closest('.tree-folder');
                    }
                }
            });
            allFolders.forEach(folderEl => {
                const folderName = folderEl.getAttribute('data-folder-name') || '';
                if (folderName.includes(q)) {
                    folderEl.style.display = '';
                    folderEl.classList.add('expanded');
                    folderEl.querySelectorAll('.tree-folder, .file-header').forEach(child => { child.style.display = ''; });
                    let parent = folderEl.parentElement?.closest('.tree-folder');
                    while (parent) {
                        parent.style.display = '';
                        parent.classList.add('expanded');
                        parent = parent.parentElement?.closest('.tree-folder');
                    }
                }
            });
        }

        document.getElementById('checkAllBtn').addEventListener('click', () => {
            const visibleCbs = Array.from(modal.querySelectorAll('#treeContainer input[type="checkbox"]')).filter(isVisible);
            visibleCbs.forEach(cb => { cb.checked = true; cb.indeterminate = false; });
            modal.querySelectorAll('.file-checkbox').forEach(cb => { if (isVisible(cb)) updateParentCheckboxes(cb); });
        });

        document.getElementById('uncheckAllBtn').addEventListener('click', () => {
            const visibleCbs = Array.from(modal.querySelectorAll('#treeContainer input[type="checkbox"]')).filter(isVisible);
            visibleCbs.forEach(cb => { cb.checked = false; cb.indeterminate = false; });
            modal.querySelectorAll('.file-checkbox').forEach(cb => { if (isVisible(cb)) updateParentCheckboxes(cb); });
        });

        document.getElementById('searchFileInput').addEventListener('input', (e) => { filterTree(e.target.value); });

        if (treeContainer) {
            treeContainer.addEventListener('click', (e) => {
                const folderItem = e.target.closest('.folder-header');
                if (folderItem && !e.target.matches('input[type="checkbox"]')) {
                    const folderNode = folderItem.closest('.tree-folder');
                    if (folderNode) folderNode.classList.toggle('expanded');
                }
            });

            treeContainer.addEventListener('change', (e) => {
                if (e.target.classList.contains('folder-checkbox')) {
                    const isChecked = e.target.checked;
                    const folderNode = e.target.closest('.tree-folder');
                    if (folderNode) {
                        const childCheckboxes = folderNode.querySelectorAll('.file-checkbox, .folder-checkbox');
                        childCheckboxes.forEach(cb => { cb.checked = isChecked; cb.indeterminate = false; });
                        updateParentCheckboxes(e.target);
                    }
                } else if (e.target.classList.contains('file-checkbox')) {
                    updateParentCheckboxes(e.target);
                }
            });
        }

        modal.querySelectorAll('.folder-checkbox').forEach(cb => { cb.checked = true; });

        const getIncludeStructure = () => {
            const cb = document.getElementById('includeStructureCheckbox');
            return cb ? cb.checked : true;
        };

        document.getElementById('copyMarkdownBtn').addEventListener('click', () => {
            const checkedIds = getCheckedFileIds();
            const includeStructure = getIncludeStructure();
            const markdown = exportProjectToMarkdownFiltered(project, checkedIds, { includeStructure });
            if (markdown) { copyToClipboard(markdown); }
            else { showToast('⚠️ 請至少選擇一個檔案'); }
        });

        document.getElementById('downloadMarkdownBtn').addEventListener('click', () => {
            const checkedIds = getCheckedFileIds();
            const includeStructure = getIncludeStructure();
            const markdown = exportProjectToMarkdownFiltered(project, checkedIds, { includeStructure });
            if (!markdown) { showToast('⚠️ 請至少選擇一個檔案'); return; }
            const blob = new Blob([markdown], { type: 'text/markdown' });
            const filename = (projectName || 'project').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_\-\s]/g, '_') + '.md';
            downloadBlob(blob, filename);
            showToast('📥 Markdown 檔案已下載');
        });
    }

    function renderFileListAndEditor() {
        renderBreadcrumb();
        renderFileList();
        renderCodeEditor();
    }

    addFileBtn.addEventListener('click', () => {
        const name = newItemNameInput.value.trim();
        if (!name) return showToast('請輸入檔案名稱');
        if (name.includes('/')) return showToast('檔案名稱不能包含 /');
        if (getCurrentFolderFiles(project).some(f => f.name === name)) return showToast('此目錄下已有同名檔案');
        const newFile = { id: generateId(), name, code: '', folderId: state.currentFolderId };
        project.files.push(newFile);
        saveCurrentCode();
        state.currentFileId = newFile.id;
        saveData();
        newItemNameInput.value = '';
        renderFileListAndEditor();
    });

    addFolderBtn.addEventListener('click', () => {
        const name = newItemNameInput.value.trim();
        if (!name) return showToast('請輸入資料夾名稱');
        if (name.includes('/')) return showToast('資料夾名稱不能包含 /');
        if (getCurrentFolderSubfolders(project).some(f => f.name === name)) return showToast('此目錄下已有同名資料夾');
        const newFolder = { id: generateId(), name, parentFolderId: state.currentFolderId };
        project.folders.push(newFolder);
        saveData();
        newItemNameInput.value = '';
        renderFileListAndEditor();
    });

    newItemNameInput.addEventListener('keypress', e => {
        if (e.key === 'Enter') addFileBtn.click();
    });

    renderFileListAndEditor();
    renderVersionList();
}
