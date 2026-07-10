import { TestBed } from '@angular/core/testing';
import { TrackInfoService } from './track-info.service';

describe('TrackInfoService', () => {
  let svc: TrackInfoService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TrackInfoService] });
    svc = TestBed.inject(TrackInfoService);
  });

  it('open() stores the target; close() clears it', () => {
    svc.open({ songId: 's1', title: 'Toxic' });
    expect(svc.target()?.songId).toBe('s1');
    expect(svc.target()?.title).toBe('Toxic');
    svc.close();
    expect(svc.target()).toBeNull();
  });
});
