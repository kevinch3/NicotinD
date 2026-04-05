import type { SlskdTransferState } from '@nicotind/core';

export interface TransferEntry {
  state: SlskdTransferState;
  percent: number;
}
