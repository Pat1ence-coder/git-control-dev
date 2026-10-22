# Third-party notices

The conflict-marker check in `src/git/conflictMarkers.ts` is adapted from
Microsoft Visual Studio Code 1.105.1:
https://github.com/microsoft/vscode/blob/1.105.1/extensions/git/src/commands.ts
(`categorizeResourceByResolution`).

The extension uses the installed `vscode.git` API and native `git.commit`,
`git.stageAllMerge`, `git.openChange`, and `git.openMergeEditor` commands, plus
VS Code `WorkspaceEdit` for undoable text edits. The preview, backup and
review-fingerprint implementation is specific to this project; it is not
copied from or guaranteed by Microsoft.

## Visual Studio Code — MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Native integration references

Command routing and confirmation behavior were checked against VS Code 1.105.1
`extensions/git/src/commands.ts` (`smartCommit`, `commit`, `stageAllMerge`,
`openMergeEditor`) and `extensions/git/src/api/api1.ts`. These implementations
run inside the installed host; they are not vendored into this extension.
Host updates therefore determine the precise native dialogs and settings.

https://github.com/microsoft/vscode/blob/1.105.1/extensions/git/src/api/api1.ts

The SCM transport adapter in `src/git/nativeGitBridge.ts` uses fixed native
`git.push`, `git.pull`, `git.fetch`, `git.sync`, and `git.publish` commands with
an explicitly checked repository URI. The button/command/repository behavior
was checked against these pinned upstream sources:

- VS Code 1.85.0, `af28b32d7e553898b2a91af498b1fb666fdebe0c`:
  https://github.com/microsoft/vscode/blob/af28b32d7e553898b2a91af498b1fb666fdebe0c/extensions/git/src/commands.ts
- VS Code main snapshot, `98c0b07a5e7f9dc75960f7e2aaa96658926851b8`:
  https://github.com/microsoft/vscode/blob/98c0b07a5e7f9dc75960f7e2aaa96658926851b8/extensions/git/src/actionButton.ts
  https://github.com/microsoft/vscode/blob/98c0b07a5e7f9dc75960f7e2aaa96658926851b8/extensions/git/src/repository.ts

The adapter does not vendor these implementations. Native commands are not a
stable public API; runtime availability, exact repository routing and host
acceptance tests are required. Resolving a command promise is not treated as
proof of remote success. One-use webview tickets and write-context guards are
specific to this project, not guarantees provided by Microsoft.
