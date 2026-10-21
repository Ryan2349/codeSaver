# codeSaver

[English](README.md) | [中文](README.zh-TW.md)

A lightweight, browser‑based code snippet and project manager.  
Store, organize, and version your code projects entirely in the browser — no server, no sign‑up, no dependencies.

## Features

- **Multi‑project management** – create, rename, delete, and switch between projects.
- **Virtual file system** – nested folders, breadcrumb navigation, drag‑and‑drop file moving.
- **Built‑in code editor** – line numbers, auto‑save, tab indentation, and 10k‑line limit.
- **Version history** – manually save snapshots, restore previous versions, rename or delete versions.
- **Folder import** – import a real local folder (with filtering of binary / large / excluded files) as a new project or as a new version of an existing project; updates reuse the existing file record when its name and full code match, preferring a relative-path match. Reused files are marked light green in the new version's root folder tree (and directly highlighted when they are in the project root).
- **Deduplicated version storage** – identical file records, including version snapshots, are stored once; repeated code contents share storage when the serialized result is smaller and are restored to the original in-memory format.
- **Export to Markdown** – choose which files to include, preview the tree, search, and download or copy formatted Markdown with code blocks.
- **Export to ZIP** – download your entire project as a real folder structure (STORE‑mode ZIP, no compression dependencies).
- **Export / Import JSON** – backup and restore projects (optionally including version history).
- **Pure front‑end** – all data is stored in `localStorage`, nothing leaves your browser.
- **Warm, paper‑themed UI** – smooth animations, glass‑morphism cards, and responsive layout.

## Project Structure

```
codeSaver/
├── index.html              # App entry point – loads CSS and JS modules
├── style.css               # All styling (paper theme, responsive, modals, version sidebar)
└── js/
    ├── main.js             # Initialisation: load data, attach beforeunload, start router
    ├── state.js            # Global state object and localStorage key
    ├── storage.js          # localStorage CRUD, data migration, version snapshot/restore/delete
    ├── router.js           # Simple view router (home ↔ project) and navigation actions
    ├── fileSystem.js       # Virtual file system helpers, folder import logic, import modals
    ├── markdown.js         # Generates Markdown tree and code export with language detection
    ├── zip.js              # Zero‑dependency ZIP creator (STORE mode)
    ├── utils.js            # ID generation, toast, clipboard, download, HTML escape
    └── views/
        ├── home.js         # Home view: project list, add project, import JSON / folder
        └── project.js      # Project view: file tree, editor, version sidebar, export modals
```

## Installation

No build tools or package managers are required. The application is a set of static files that can be served by any HTTP server.

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/codeSaver.git
cd codeSaver
```

### 2. Serve the Files

Because the app uses ES modules (`type="module"`), you must serve it over HTTP rather than opening `index.html` directly from disk. You can use any static server, for example:

**Using Node.js (http-server)**
```bash
npx http-server . -p 8080 -o
```

**Using Python 3**
```bash
python -m http.server 8080
```

**Using VS Code Live Server**  
Right‑click `index.html` → “Open with Live Server”.

Then open `http://localhost:8080` in a modern browser (Chrome, Firefox, Edge, or Safari).

## License

This project is open‑sourced under the Apache License 2.0. See the [LICENSE](LICENSE) file for more information.
