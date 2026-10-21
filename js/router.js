import { state } from './state.js';
import { getProjectById } from './storage.js';
import { saveCurrentCode } from './views/project.js';
import { renderHome } from './views/home.js';
import { renderProjectView } from './views/project.js';

export function goHome() {
    saveCurrentCode();
    state.currentView = 'home';
    state.currentProjectId = null;
    state.currentFileId = null;
    state.currentFolderId = null;
    state.draggedFileId = null;
    renderHome(actions);
}

export function navigateToProject(id) {
    const project = getProjectById(id);
    if (!project) return goHome();
    state.currentView = 'project';
    state.currentProjectId = id;
    state.currentFolderId = null;
    state.currentFileId = project.files.length > 0 ? project.files[0].id : null;
    state.draggedFileId = null;
    renderProjectView(project, actions);
}

export const actions = {
    goHome,
    navigateToProject
};