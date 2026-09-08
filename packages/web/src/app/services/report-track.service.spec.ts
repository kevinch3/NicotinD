import { describe, it, expect, vi } from 'vitest';
import { TestBed, getTestBed } from '@angular/core/testing';
import { ReportTrackService } from './report-track.service';
import { BackButtonService } from './native/back-button.service';
import { BackHandlerStack } from '../lib/back-handlers';

function setup() {
  const stack = new BackHandlerStack();
  getTestBed().resetTestingModule();
  TestBed.configureTestingModule({
    providers: [ReportTrackService, { provide: BackButtonService, useValue: { stack } }],
  });
  return { svc: TestBed.inject(ReportTrackService), stack };
}

describe('ReportTrackService', () => {
  it('holds the track whose dialog is open', () => {
    const { svc } = setup();
    expect(svc.target()).toBeNull();
    svc.open('s1');
    expect(svc.target()).toBe('s1');
    svc.close();
    expect(svc.target()).toBeNull();
  });

  it('lets hardware Back close the dialog, and unregisters after', () => {
    const { svc, stack } = setup();
    svc.open('s1');

    // Back is handled here rather than falling through to navigation (#394).
    expect(stack.handleBack()).toBe(true);
    expect(svc.target()).toBeNull();

    // The handler is gone, so the next Back walks router history instead of
    // being swallowed by a dialog that is no longer open.
    expect(stack.handleBack()).toBe(false);
  });

  it('registers one Back handler across repeated opens', () => {
    const { svc, stack } = setup();
    svc.open('s1');
    svc.open('s2');
    expect(svc.target()).toBe('s2');
    expect(stack.handleBack()).toBe(true);
    expect(stack.handleBack()).toBe(false);
  });
});
