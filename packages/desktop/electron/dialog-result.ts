/**
 * Pure decision for the folder-picker IPC handler (Task 8): an Electron
 * `dialog.showOpenDialog` result maps to `null` when the user canceled or
 * picked nothing, otherwise the first selected path. Factored out of
 * `main.ts` so it's unit-testable without booting Electron.
 */
export interface OpenDialogResultLike {
  canceled: boolean;
  filePaths: string[];
}

export function pickDirectoryResult(res: OpenDialogResultLike): string | null {
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
}
