import { showToast } from './utils.js';

export function generateTreeMarkdown(project, folderId = null, prefix = '') {
    let md = '';
    const folders = project.folders.filter(f => f.parentFolderId === folderId);
    const files = project.files.filter(f => f.folderId === folderId);
    const items = [
        ...folders.map(f => ({ name: f.name, type: 'folder', id: f.id })),
        ...files.map(f => ({ name: f.name, type: 'file' }))
    ].sort((a, b) => a.name.localeCompare(b.name));

    items.forEach((item, idx) => {
        const isLast = idx === items.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        if (item.type === 'folder') {
            md += `${prefix}${connector}${item.name}/\n`;
            md += generateTreeMarkdown(project, item.id, childPrefix);
        } else {
            md += `${prefix}${connector}${item.name}\n`;
        }
    });
    return md;
}

/**
 * 根據勾選的檔案 id 集合輸出 Markdown（可選擇是否包含專案結構）
 * @param {Object} project
 * @param {Set|null} includeFileIds - 若為 null 則輸出所有檔案代碼，否則僅輸出 id 存在於集合中的檔案
 * @param {Object} options - { includeStructure: boolean }
 */
export function exportProjectToMarkdownFiltered(project, includeFileIds = null, options = {}) {
    const { includeStructure = true } = options;

    if (!project || (!project.files.length && !project.folders.length)) {
        showToast('⚠️ 專案中沒有內容可以匯出');
        return null;
    }
    let markdown = `# ${project.name}\n\n---\n\n`;

    if (includeStructure) {
        markdown += `## 專案結構\n\n\`\`\`\n${project.name}/\n`;
        markdown += generateTreeMarkdown(project, null);
        markdown += `\`\`\`\n\n---\n\n`;
    }

    markdown += `## 檔案內容\n\n`;

    function generateCodeSection(folderId, folderPath) {
        let content = '';
        const folders = project.folders.filter(f => f.parentFolderId === folderId).sort((a, b) => a.name.localeCompare(b.name));
        const files = project.files.filter(f => f.folderId === folderId).sort((a, b) => a.name.localeCompare(b.name));
        files.forEach(file => {
            if (includeFileIds && !includeFileIds.has(file.id)) return;
            if (!file.code?.trim()) return;
            const fullPath = folderPath + file.name;
            content += `### ${fullPath}\n\n`;
            const ext = file.name.split('.').pop()?.toLowerCase() || '';
            const langMap = {
                js:'javascript',jsx:'jsx',ts:'typescript',tsx:'tsx',py:'python',html:'html',
                css:'css',scss:'scss',json:'json',md:'markdown',xml:'xml',yaml:'yaml',
                yml:'yaml',sh:'bash',bash:'bash',sql:'sql',java:'java',cpp:'cpp',
                c:'c',rb:'ruby',php:'php',go:'go',rs:'rust',swift:'swift',
                kt:'kotlin',r:'r',txt:'text'
            };
            const language = langMap[ext] || '';
            content += `\`\`\`${language}\n${file.code}\n\`\`\`\n\n`;
        });
        folders.forEach(f => {
            content += generateCodeSection(f.id, folderPath + f.name + '/');
        });
        return content;
    }
    markdown += generateCodeSection(null, '');
    return markdown;
}