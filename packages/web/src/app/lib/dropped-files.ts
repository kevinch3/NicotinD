import type { DroppedFile } from './upload-plan';

/**
 * Turn a drop or a folder picker into a flat, path-preserving file list.
 *
 * Two browser APIs, one shape. A `<input webkitdirectory>` hands back files
 * carrying `webkitRelativePath`; a drag-and-drop hands back `DataTransferItem`s
 * whose directory entries have to be walked. Both must preserve the *relative*
 * path, because the server groups staged files by directory — flattening to
 * basenames would collapse a multi-disc release into one folder.
 */

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: FileSystemEntryLike[]) => void, err: (e: unknown) => void) => void;
  };
}

/** Strip the leading slash `fullPath` carries so paths are root-relative. */
function relativePath(fullPath: string): string {
  return fullPath.replace(/^\/+/, '');
}

function readEntries(reader: {
  readEntries: (cb: (e: FileSystemEntryLike[]) => void, err: (e: unknown) => void) => void;
}): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walkEntry(entry: FileSystemEntryLike, out: DroppedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const blob = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
    out.push({ path: relativePath(entry.fullPath), size: blob.size, blob });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  // `readEntries` returns at most 100 per call and signals the end with an empty
  // batch — calling it once silently truncates a large album to its first 100
  // files, which would look like a partial import rather than a bug.
  for (;;) {
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    for (const child of batch) await walkEntry(child, out);
  }
}

/** Files from a drag-and-drop, directories walked recursively. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries: FileSystemEntryLike[] = [];
  const plainFiles: DroppedFile[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }
    ).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      // No entry API (or a bare file): fall back to the file itself, named by
      // its own name since there is no directory context to preserve.
      const f = item.getAsFile();
      if (f) plainFiles.push({ path: f.name, size: f.size, blob: f });
    }
  }
  const walked: DroppedFile[] = [];
  for (const entry of entries) await walkEntry(entry, walked);
  return [...walked, ...plainFiles];
}

/** Files from an `<input type="file" webkitdirectory>` or a plain multi-select. */
export function filesFromInput(list: FileList): DroppedFile[] {
  return Array.from(list).map((f) => ({
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    size: f.size,
    blob: f,
  }));
}
