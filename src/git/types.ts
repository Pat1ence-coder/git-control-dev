import type { Event, Uri } from 'vscode';
export interface Ref {
    type: number;
    name?: string;
    commit?: string;
}
export interface Commit {
    hash: string;
    message: string;
    parents: string[];
    authorName?: string;
    authorDate?: Date;
}
export interface Change {
    uri: Uri;
    originalUri: Uri;
    renameUri?: Uri;
    status: number;
}
export interface Repository {
    rootUri: Uri;
    onDidCommit: Event<void>;
    inputBox: {
        value: string;
    };
    state: {
        HEAD?: Ref;
        refs: Ref[];
        mergeChanges: Change[];
        workingTreeChanges: Change[];
        indexChanges: Change[];
        untrackedChanges?: Change[];
        rebaseCommit?: Commit;
        onDidChange: Event<void>;
    };
    status(): Promise<void>;
    getConfig(key: string): Promise<string>;
    getRefs?(query: { pattern?: string | string[]; sort?: 'alphabetically' | 'committerdate' }): Promise<Ref[]>;
    getBranches?(query: { remote?: boolean }): Promise<Ref[]>;
    log(options?: {
        maxEntries?: number;
        refNames?: string[];
    }): Promise<Commit[]>;
    add(paths: string[]): Promise<void>;
    merge?(ref: string): Promise<void>;
    mergeAbort?(): Promise<void>;
    diffIndexWithHEAD(): Promise<Change[]>;
    diffIndexWithHEAD(path: string): Promise<string>;
    commit(message: string, options?: { all?: boolean; postCommitCommand?: string | null }): Promise<void>;
    getCommit(ref: string): Promise<Commit>;
    show(ref: string, path: string): Promise<string>;
    diffBetween(ref1: string, ref2: string): Promise<Change[]>;
    diffBetween(ref1: string, ref2: string, path: string): Promise<string>;
    getObjectDetails(ref: string, path: string): Promise<{
        size: number;
        mode: string;
        object: string;
    }>;
}
export interface GitAPI {
    state: 'uninitialized' | 'initialized';
    repositories: Repository[];
    onDidChangeState: Event<string>;
    onDidOpenRepository: Event<Repository>;
    onDidCloseRepository: Event<Repository>;
    getRepository(uri: Uri): Repository | null;
    openRepository?(uri: Uri): Promise<Repository | null>;
}
export interface GitExtension {
    enabled: boolean;
    onDidChangeEnablement: Event<boolean>;
    getAPI(version: 1): GitAPI;
}
