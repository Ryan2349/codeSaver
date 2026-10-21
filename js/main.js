import { state } from './state.js';
import { loadData } from './storage.js';
import { actions } from './router.js';
import { saveCurrentCode } from './views/project.js';

function init() {
    loadData();
    actions.goHome();

    window.addEventListener('beforeunload', () => {
        saveCurrentCode();
    });
}

init();