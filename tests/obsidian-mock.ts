export class App {}
export class PluginSettingTab {}
export class Setting {}
export class WorkspaceLeaf {}
export class Workspace {
    openLinkText(_linktext: string, _sourcePath: string, _newLeaf?: boolean | string): Promise<void> {
        return Promise.resolve();
    }
}
export class ItemView {
    containerEl: any;
    app: any;

    constructor(leaf: any) {
        this.containerEl = leaf.containerEl;
        this.app = leaf.app ?? { workspace: new Workspace() };
    }
}
