import { state } from '../state.js';
import { saveData, mergeImportedData } from '../storage.js';
import { generateId, escapeHtml, showToast, triggerImportJSON } from '../utils.js';
import { handleImportFolder } from '../fileSystem.js';

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

export function renderHome(actions) {
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
            if (mergeImportedData(json)) {
                showToast('✅ 匯入成功');
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
        emptyMessage: '尚無專案，請新增一個。',
        renderCard: p => `
            <div class="topic-card" data-id="${p.id}">
                <div class="topic-icon">💻</div>
                <div class="topic-name">${escapeHtml(p.name)}</div>
                <div class="topic-count">${p.files?.length || 0} 個檔案</div>
            </div>`,
        onAdd: (name) => {
            state.appData.projects.push({ id: generateId(), name, folders: [], files: [] });
            saveData();
        },
        onCardClick: (id) => actions.navigateToProject(id)
    };

    renderHomeGridSection(config);
}