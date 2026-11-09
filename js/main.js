import { state } from './state.js';
import { loadData } from './storage.js';
import { actions } from './router.js';
import { saveCurrentCode } from './views/project.js';

async function init() {
    try {
        await loadData();
    } catch (e) {
        console.error('Failed to load data', e);
    }
    actions.goHome();

    window.addEventListener('beforeunload', () => {
        saveCurrentCode();
        // IndexedDB 寫入是非同步的，beforeunload 時盡力觸發；現代瀏覽器可能仍會取消
    });
}

init();
