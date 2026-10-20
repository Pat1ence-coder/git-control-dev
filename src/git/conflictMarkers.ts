/*---------------------------------------------------------------------------------------------
 * Portions copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See THIRD_PARTY_NOTICES.md.
 * Adapted from VS Code 1.105.1, extensions/git/src/commands.ts,
 * categorizeResourceByResolution. Diff3/custom-width detection added locally.
 *--------------------------------------------------------------------------------------------*/
export function containsConflictMarkers(text: string): boolean {
    return /^<{7}\s|^={7}$|^>{7}\s/m.test(text)
        || /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:\s|$)/m.test(text);
}
