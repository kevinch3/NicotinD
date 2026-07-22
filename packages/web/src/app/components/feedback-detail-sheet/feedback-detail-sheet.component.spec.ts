import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { FeedbackDetailSheetComponent } from './feedback-detail-sheet.component';
import { FeedbackSheetService } from '../../services/feedback-sheet.service';

function open(sheet: FeedbackSheetService) {
  sheet.open({
    feedbackId: 5,
    artistName: 'Soda Stereo',
    albumTitle: 'Canción Animal',
    candidates: [
      { username: 'alice', directory: 'A/Album', matchPct: 100, format: 'FLAC' },
      { username: 'bob', directory: 'B/Album', matchPct: 60, format: 'MP3' },
    ],
  });
}

describe('FeedbackDetailSheetComponent', () => {
  let component: FeedbackDetailSheetComponent;
  let sheet: FeedbackSheetService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    component = TestBed.createComponent(FeedbackDetailSheetComponent).componentInstance;
    sheet = TestBed.inject(FeedbackSheetService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('buildItemFlags maps a picked folder to its correctFolder ref', () => {
    open(sheet);
    component.select('B/Album');
    expect(component.buildItemFlags()).toEqual({
      correctFolder: { username: 'bob', directory: 'B/Album' },
    });
  });

  it('buildItemFlags returns null correctFolder for "none of these"', () => {
    open(sheet);
    component.select('none');
    expect(component.buildItemFlags()).toEqual({ correctFolder: null });
  });

  it('confirm PATCHes verdict=bad with the note + itemFlags, then closes', () => {
    open(sheet);
    component.select('B/Album');
    component.note.set('  wrong release  ');
    component.confirm();

    const req = http.expectOne('/api/feedback/5');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      verdict: 'bad',
      note: 'wrong release',
      itemFlags: { correctFolder: { username: 'bob', directory: 'B/Album' } },
    });
    req.flush({ ok: true });
    expect(sheet.payload()).toBeNull();
  });

  it('cannot confirm before a selection is made', () => {
    open(sheet);
    expect(component.canConfirm()).toBe(false);
    component.select('A/Album');
    expect(component.canConfirm()).toBe(true);
  });
});
