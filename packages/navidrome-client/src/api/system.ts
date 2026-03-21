import type { ScanStatus } from '@nicotind/core';
import type { NavidromeClient } from '../client.js';

export class SystemApi {
  constructor(private client: NavidromeClient) {}

  async ping(): Promise<boolean> {
    try {
      await this.client.request('ping.view');
      return true;
    } catch {
      return false;
    }
  }

  async startScan(fullScan = false): Promise<void> {
    await this.client.request('startScan.view', fullScan ? { fullScan: 'true' } : {});
  }

  async getScanStatus(): Promise<ScanStatus> {
    const res = await this.client.request<{ scanStatus: ScanStatus }>('getScanStatus.view');
    return res.scanStatus;
  }
}
