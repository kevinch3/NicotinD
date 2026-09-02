import { TestBed } from '@angular/core/testing';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import { of, throwError } from 'rxjs';
import { VocalSeparationSettingsService } from './vocal-separation-settings.service';
import { SystemApiService } from './api/system-api.service';

describe('VocalSeparationSettingsService', () => {
  let get: ReturnType<typeof vi.fn>;
  let set: ReturnType<typeof vi.fn>;
  let service: VocalSeparationSettingsService;

  beforeEach(() => {
    get = vi.fn(() => of({ enabled: false, configurable: true }));
    set = vi.fn((enabled: boolean) => of({ enabled, configurable: true }));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SystemApiService,
          useValue: { getVocalSeparation: get, setVocalSeparation: set },
        },
      ],
    });
    service = TestBed.inject(VocalSeparationSettingsService);
  });

  it('loads the state and reports off', () => {
    service.load();
    expect(service.state()).toEqual({ enabled: false, configurable: true });
    expect(service.off()).toBe(true);
  });

  it('writes through and adopts the effective value', () => {
    service.load();
    service.set(true);
    expect(set).toHaveBeenCalledWith(true);
    expect(service.state()?.enabled).toBe(true);
  });

  it('never asks the server when the environment has no sidecar', () => {
    get.mockReturnValue(of({ enabled: false, configurable: false }));
    service.load();
    service.set(true);
    expect(set).not.toHaveBeenCalled();
  });

  it('hides the control on a 503 (toggle not wired)', () => {
    get.mockReturnValue(throwError(() => new Error('503')));
    service.load();
    expect(service.state()).toBeNull();
  });
});
