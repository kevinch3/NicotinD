import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import {
  buildFolderTree,
  getDirectFiles,
  type BrowseDir,
  type BrowseFile,
  type FolderNode,
} from '@/lib/folderUtils';
import { getFolderDownloadLabel, BUTTON_CLASSES, DEFAULT_FOLDER_LABEL } from '@/lib/downloadStatus';
import type { TransferEntry } from '@/lib/transferTypes';

interface FolderBrowserProps {
  username: string;
  matchedPath: string;
  fallbackFiles: BrowseFile[];
  onDownload: (files: Array<{ filename: string; size: number }>) => void;
  /** When provided, Download all button reflects live transfer status. */
  getStatus?: (username: string, filename: string) => TransferEntry | undefined;
  isFolderQueued?: boolean;
}

function formatSize(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000).toFixed(0)} KB`;
}

function extractBasename(filepath: string): string {
  const parts = filepath.split(/[\\/]/);
  return parts[parts.length - 1];
}

function TreeNode({
  node,
  selected,
  onSelect,
}: {
  node: FolderNode;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(
    selected.startsWith(node.fullPath),
  );

  return (
    <div>
      <button
        onClick={() => {
          setExpanded((e) => !e);
          onSelect(node.fullPath);
        }}
        className={`w-full text-left flex items-center gap-1 px-2 py-1 rounded text-xs transition ${
          selected === node.fullPath
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
        }`}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span className="truncate">{node.segment}</span>
      </button>
      {expanded && node.children.length > 0 && (
        <div className="pl-3">
          {node.children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FolderBrowser({
  username,
  matchedPath,
  fallbackFiles,
  onDownload,
  getStatus,
  isFolderQueued = false,
}: FolderBrowserProps) {
  const [dirs, setDirs] = useState<BrowseDir[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState(matchedPath);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setErrorMsg(null);
    api
      .browseUser(username)
      .then((result) => {
        if (!cancelled) {
          setDirs(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(true);
          setErrorMsg(msg);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [username]);

  const tree = dirs ? buildFolderTree(dirs) : [];
  const directFiles: BrowseFile[] = dirs
    ? getDirectFiles(dirs, selected)
    : fallbackFiles;

  return (
    <div className="mt-2 border border-zinc-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <span className="text-xs text-zinc-400 truncate">
          {username}'s library
        </span>
        {loading && (
          <span className="text-[11px] text-zinc-600 flex items-center gap-1">
            <span className="inline-block w-3 h-3 border border-zinc-600 border-t-zinc-400 rounded-full animate-spin" />
            Loading…
          </span>
        )}
        {error && (
          <div className="flex flex-col items-end">
            <span className="text-[11px] text-amber-600">
              Couldn't load full library ({errorMsg}) — showing files from search results
            </span>
            <span className="text-[10px] text-zinc-500">
              Check Soulseek network settings (Port, UPnP) in Settings if this happens often.
            </span>
          </div>
        )}
      </div>

      <div className="flex min-h-[120px] max-h-64">
        {/* Tree panel — only shown after successful load */}
        {!loading && !error && dirs && (
          <div className="w-44 shrink-0 overflow-y-auto border-r border-zinc-800 p-1">
            {tree.map((node) => (
              <TreeNode
                key={node.fullPath}
                node={node}
                selected={selected}
                onSelect={setSelected}
              />
            ))}
          </div>
        )}

        {/* File list panel */}
        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {directFiles.length === 0 ? (
            <p className="text-xs text-zinc-600 p-2">No files</p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-zinc-600">
                  {directFiles.length} file{directFiles.length !== 1 ? 's' : ''}
                </span>
                {(() => {
                  const validFiles = directFiles.filter((f) => f.size > 0); // skip 0-byte stubs
                  const folderFiles = validFiles.map((f) => ({ username, filename: f.filename }));
                  const btn = getStatus
                    ? getFolderDownloadLabel(folderFiles, isFolderQueued, getStatus)
                    : isFolderQueued
                      ? { label: 'Queued', variant: 'queued' as const, disabled: true }
                      : { label: `Download all (${validFiles.length})`, variant: 'default' as const, disabled: false };

                  // When getFolderDownloadLabel returns the default label, use the more
                  // descriptive "Download all (N)" label instead.
                  const displayLabel = btn.label === DEFAULT_FOLDER_LABEL
                    ? `Download all (${validFiles.length})`
                    : btn.label;

                  return (
                    <button
                      onClick={() => {
                        onDownload(validFiles.map((f) => ({ filename: f.filename, size: f.size })));
                      }}
                      disabled={btn.disabled || validFiles.length === 0}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${BUTTON_CLASSES[btn.variant]} ${btn.disabled ? 'cursor-default' : ''}`}
                    >
                      {displayLabel}
                    </button>
                  );
                })()}
              </div>
              {directFiles.map((file) => (
                <div
                  key={file.filename}
                  className="flex items-center justify-between text-[11px] text-zinc-500 hover:text-zinc-300 px-1"
                >
                  <span className="truncate flex-1">{extractBasename(file.filename)}</span>
                  <span className="shrink-0 ml-2 text-zinc-700">
                    {file.bitRate ? `${file.bitRate} kbps · ` : ''}{formatSize(file.size)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
