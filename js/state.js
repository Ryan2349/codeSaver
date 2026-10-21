export const STORAGE_KEY = 'code_storage_projects_v1';

export const state = {
    appData: { projects: [] },
    currentView: 'home',
    currentProjectId: null,
    currentFileId: null,
    currentFolderId: null,
    autoSaveTimeout: null,
    draggedFileId: null,
    versionSidebarOpen: true,
    isDraggingInternal: false
};