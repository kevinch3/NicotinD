/** One transfer's lifecycle entry, keyed `username:filename` — sourced from
 * the unified acquisition-jobs feed since the raw slskd transfers lane was
 * removed (phase 3). The state vocabulary keeps the historical slskd strings
 * the result-card lifecycle switches on. */
export interface TransferEntry {
  state: string;
  percent?: number;
}
