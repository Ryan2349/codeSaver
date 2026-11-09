import { state } from '../state.js';
import { saveData, mergeImportedData, getStorageEstimate } from '../storage.js';
import { generateId, escapeHtml, showToast, triggerImportJSON, formatStorageSize } from '../utils.js';
import {
    handleImportFolder,
    processDropToNewProject,
    showExcludedFilesModal,
    applyImportedFolderAsNewVersion,
    detectReusedForAllVersions
} from '../fileSystem.js';

/** 移除專案頁的外部版本側欄（回到主畫面時清理） */
function removeExternalVersionSidebar() {
    const existing = document.getElementById('versionSidebar');
    if (existing) existing.remove();
    document.body.classList.remove('has-version-sidebar');
}

function renderHomeGridSection({ items, inputPlaceholder, addButtonText, emptyMessage, renderCard, onAdd, onCardClick }) {
    const homeMainView = document.getElementById('homeMainView');
    homeMainView.innerHTML = `
        <div class="form-row">
            <input type="text" class="input-field" id="newItemInput" placeholder="${escapeHtml(inputPlaceholder)}" autocomplete="off">
            <button class="btn" id="addItemBtn">${addButtonText}</button>
        </div>
        <div class="topic-grid" id="homeGrid"></div>
    `;

    const grid = document.getElementById('homeGrid');
    const input = document.getElementById('newItemInput');
    const addBtn = document.getElementById('addItemBtn');

    grid.addEventListener('click', (e) => {
        const card = e.target.closest('.topic-card');
        if (!card) return;
        const id = card.dataset.id;
        if (id) onCardClick(id);
    });

    function refreshGrid() {
        if (!items.length) {
            grid.innerHTML = `<div class="empty-message">${emptyMessage}</div>`;
            return;
        }
        grid.innerHTML = items.map(item => renderCard(item)).join('');
    }

    function handleAdd() {
        const name = input.value.trim();
        if (!name) return showToast('請輸入名稱');
        onAdd(name);
        input.value = '';
        refreshGrid();
    }

    addBtn.addEventListener('click', handleAdd);
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleAdd(); });
    refreshGrid();
}

function isExternalFileDrag(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

function clearCardDropTargets() {
    document.querySelectorAll('.topic-card.drop-target').forEach(el => el.classList.remove('drop-target'));
}

/**
 * 讀取拖入內容後，套用到指定專案作為新版本
 */
async function updateProjectFromDrop(projectId, dataTransferItems, actions) {
    const targetProject = state.appData.projects.find(p => p.id === projectId);
    if (!targetProject) {
        showToast('❌ 找不到選擇的專案');
        return;
    }

    showToast('⏳ 正在讀取資料夾…');

    const { folders, files, excludedFiles } = await processDropToNewProject(dataTransferItems);

    if (!folders.length && !files.length) {
        if (excludedFiles.length > 0) {
            await showExcludedFilesModal(excludedFiles);
        } else {
            showToast('⚠️ 沒有可匯入的檔案或資料夾為空');
        }
        return;
    }

    if (excludedFiles.length > 0) {
        await showExcludedFilesModal(excludedFiles);
    }

    const mergeStats = applyImportedFolderAsNewVersion(targetProject, { folders, files });
    showToast(`✅ 已將「${targetProject.name}」更新為新版本：重用 ${mergeStats.reused} 個相同檔案（名稱與內容皆相同）、新增 ${mergeStats.added} 個`);
    actions.navigateToProject(targetProject.id);
}

/**
 * 讀取拖入內容後，建立新專案
 */
async function createProjectFromDrop(dataTransferItems, actions) {
    showToast('⏳ 正在讀取資料夾…');

    const { folders, files, excludedFiles, projectName: suggestedName } = await processDropToNewProject(dataTransferItems);

    if ((!folders.length && !files.length) || !suggestedName) {
        if (excludedFiles.length > 0) {
            await showExcludedFilesModal(excludedFiles);
        } else {
            showToast('⚠️ 沒有可匯入的檔案或資料夾為空');
        }
        return;
    }

    if (excludedFiles.length > 0) {
        await showExcludedFilesModal(excludedFiles);
    }

    let projectName = suggestedName;
    if (state.appData.projects.some(p => p.name === projectName)) {
        let counter = 1;
        while (state.appData.projects.some(p => p.name === `${projectName} (${counter})`)) counter++;
        projectName = `${projectName} (${counter})`;
    }

    const project = {
        id: generateId(),
        name: projectName,
        folders,
        files,
        versions: [],
        currentVersionId: null
    };

    state.appData.projects.push(project);
    saveData();
    showToast(`✅ 已新增專案「${projectName}」（${files.length} 個檔案）`);
    actions.navigateToProject(project.id);
}

/**
 * 主畫面拖曳：空白處 → 新增專案；專案卡片 → 更新為新版本
 */
function setupHomeDropZone(actions) {
    const homeMainView = document.getElementById('homeMainView');
    if (!homeMainView) return;

    homeMainView.classList.add('home-drop-zone');

    const clearMainActive = () => homeMainView.classList.remove('drop-zone-active');

    homeMainView.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (state.isDraggingInternal) return;
        if (!isExternalFileDrag(e)) return;

        const card = e.target.closest('.topic-card');
        if (card) {
            clearMainActive();
            clearCardDropTargets();
            card.classList.add('drop-target');
        } else {
            clearCardDropTargets();
            homeMainView.classList.add('drop-zone-active');
        }
    });

    homeMainView.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (state.isDraggingInternal) return;
        if (!isExternalFileDrag(e)) return;

        e.dataTransfer.dropEffect = 'copy';

        const card = e.target.closest('.topic-card');
        if (card) {
            clearMainActive();
            if (!card.classList.contains('drop-target')) {
                clearCardDropTargets();
                card.classList.add('drop-target');
            }
        } else {
            clearCardDropTargets();
            homeMainView.classList.add('drop-zone-active');
        }
    });

    homeMainView.addEventListener('dragleave', (e) => {
        if (state.isDraggingInternal) return;
        const card = e.target.closest('.topic-card');
        if (card && !card.contains(e.relatedTarget)) {
            card.classList.remove('drop-target');
        }
        if (!homeMainView.contains(e.relatedTarget)) {
            clearMainActive();
            clearCardDropTargets();
        }
    });

    homeMainView.addEventListener('drop', async (e) => {
        e.preventDefault();
        clearMainActive();
        clearCardDropTargets();
        if (state.isDraggingInternal) return;

        const items = e.dataTransfer?.items;
        if (!items || items.length === 0) {
            showToast('⚠️ 沒有可匯入的檔案');
            return;
        }

        // 若落在專案卡片上 → 更新該專案為新版本
        const card = e.target.closest('.topic-card');
        if (card && card.dataset.id) {
            await updateProjectFromDrop(card.dataset.id, items, actions);
            return;
        }

        // 否則在空白處 → 新增專案
        await createProjectFromDrop(items, actions);
    });
}


/**
 * 在主畫面顯示 IndexedDB / 來源儲存容量條
 */
async function renderStorageCapacityBar(container) {
    if (!container) return;

    const barWrap = document.createElement('div');
    barWrap.className = 'storage-capacity';
    barWrap.id = 'storageCapacityBar';
    barWrap.innerHTML = `
        <div class="storage-capacity-header">
            <span class="storage-capacity-title">📦 儲存空間（IndexedDB）</span>
            <span class="storage-capacity-text" id="storageCapacityText">計算中…</span>
        </div>
        <div class="storage-capacity-track">
            <div class="storage-capacity-fill" id="storageCapacityFill" style="width:0%"></div>
        </div>
        <div class="storage-capacity-hint" id="storageCapacityHint"></div>
    `;
    container.insertAdjacentElement('afterbegin', barWrap);

    try {
        const est = await getStorageEstimate();
        const textEl = document.getElementById('storageCapacityText');
        const fillEl = document.getElementById('storageCapacityFill');
        const hintEl = document.getElementById('storageCapacityHint');
        if (!est || !textEl || !fillEl) return;

        const usedStr = formatStorageSize(est.usage);
        const appStr = formatStorageSize(est.appApproxBytes);

        if (est.quota > 0) {
            const quotaStr = formatStorageSize(est.quota);
            const pct = Math.round(est.usageRatio * 1000) / 10; // 一位小數
            const remain = Math.max(0, est.quota - est.usage);
            const remainStr = formatStorageSize(remain);
            textEl.textContent = `${usedStr} / ${quotaStr}（${pct}%）`;
            fillEl.style.width = `${Math.min(100, pct)}%`;
            // 顏色依使用率
            fillEl.classList.remove('level-ok', 'level-warn', 'level-crit');
            if (est.usageRatio >= 0.9) fillEl.classList.add('level-crit');
            else if (est.usageRatio >= 0.7) fillEl.classList.add('level-warn');
            else fillEl.classList.add('level-ok');
            if (hintEl) {
                hintEl.textContent = `剩餘約 ${remainStr} · 本應用資料約 ${appStr}`;
            }
        } else {
            // 無法取得配額
            textEl.textContent = `已使用約 ${usedStr}`;
            fillEl.style.width = '0%';
            fillEl.classList.add('level-ok');
            if (hintEl) {
                hintEl.textContent = `瀏覽器未回報總配額 · 本應用資料約 ${appStr}`;
            }
        }
    } catch (e) {
        console.warn('renderStorageCapacityBar failed', e);
        const textEl = document.getElementById('storageCapacityText');
        if (textEl) textEl.textContent = '無法取得儲存容量資訊';
    }
}

export function renderHome(actions) {
    removeExternalVersionSidebar();

    const appContainer = document.getElementById('appContainer');
    appContainer.innerHTML = `
        <div class="header">
            <div class="logo">💻 代碼儲存應用</div>
            <div class="header-actions">
                <button class="import-btn" id="importJsonBtn">📥 匯入 JSON</button>
                <button class="import-btn" id="importFolderBtn">📂 匯入文件夾</button>
            </div>
        </div>
        <div class="main-view" id="homeMainView"></div>
    `;

    document.getElementById('importJsonBtn').addEventListener('click', () => {
        triggerImportJSON((json) => {
            const project = mergeImportedData(json);
            if (project) {
                // 與匯入文件夾／手動「重複代碼檢測」相同：對所有歷史版本與目前工作區自動偵測重複檔案並標記
                const allStats = detectReusedForAllVersions(project);
                saveData();

                const { current, versionsProcessed, versionsWithPrevious } = allStats;
                const parts = [`✅ 已匯入專案「${project.name}」`];
                if (versionsProcessed > 0) {
                    parts.push(`已對 ${versionsProcessed} 個歷史版本偵測重複` +
                        (versionsWithPrevious > 0 ? `（${versionsWithPrevious} 個可與前一版比對）` : ''));
                }
                if (current.hasPrevious) {
                    parts.push(`目前工作區 ${current.reused}/${current.total} 個檔案與上版相同`);
                } else if (versionsProcessed === 0) {
                    parts.push('尚無歷史版本可供比對');
                }
                showToast(parts.join('；'));
                renderHome(actions);
            } else {
                showToast('❌ 匯入失敗');
            }
        });
    });

    document.getElementById('importFolderBtn').addEventListener('click', () => handleImportFolder(actions));

    const config = {
        items: state.appData.projects,
        inputPlaceholder: '新專案名稱...',
        addButtonText: '➕ 新增專案',
        emptyMessage: '尚無專案，請新增一個，或直接拖曳資料夾到此處。',
        renderCard: p => {
            const versionCount = p.versions?.length || 0;
            return `
            <div class="topic-card" data-id="${p.id}">
                <div class="topic-icon">💻</div>
                <div class="topic-name">${escapeHtml(p.name)}</div>
                <div class="topic-meta">
                    <div class="topic-count">${p.files?.length || 0} 個檔案${versionCount > 0 ? ` · ${versionCount} 版本` : ''}</div>
                </div>
            </div>`;
        },
        onAdd: (name) => {
            state.appData.projects.push({ id: generateId(), name, folders: [], files: [] });
            saveData();
        },
        onCardClick: (id) => actions.navigateToProject(id)
    };

    renderHomeGridSection(config);
    setupHomeDropZone(actions);

    // 容量顯示條（插在主畫面最上方）
    const homeMainView = document.getElementById('homeMainView');
    renderStorageCapacityBar(homeMainView);
}
