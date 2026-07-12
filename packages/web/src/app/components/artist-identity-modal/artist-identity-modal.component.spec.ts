import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import {
  ArtistIdentityModalComponent,
  splitArtistParts,
} from './artist-identity-modal.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ToastService } from '../../services/toast.service';

/** Same ɵSIGNAL escape hatch as artist-links.component.spec.ts (JIT input() limitation). */
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

describe('splitArtistParts (client mirror of splitOnDelimiters)', () => {
  it('splits on the shared delimiter set', () => {
    expect(splitArtistParts('Charly García y Luis Alberto Spinetta')).toEqual([
      'Charly García',
      'Luis Alberto Spinetta',
    ]);
    expect(splitArtistParts('Bob Marley, Peter Tosh')).toEqual(['Bob Marley', 'Peter Tosh']);
    expect(splitArtistParts('Wisin & Yandel')).toEqual(['Wisin', 'Yandel']);
  });

  it('keeps an atomic name whole', () => {
    expect(splitArtistParts('Daft Punk')).toEqual(['Daft Punk']);
  });
});

describe('ArtistIdentityModalComponent', () => {
  let fixCalls: unknown[];

  function make(): ArtistIdentityModalComponent {
    fixCalls = [];
    TestBed.configureTestingModule({
      imports: [ArtistIdentityModalComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            fixArtistIdentity: (body: unknown) => {
              fixCalls.push(body);
              return of({ ok: true, resyncing: true });
            },
          },
        },
        { provide: ToastService, useValue: { show: () => 'id' } },
      ],
    });
    const c = TestBed.createComponent(ArtistIdentityModalComponent).componentInstance;
    setInputValue(c.rawName, 'Bob Marley, Peter Tosh');
    return c;
  }

  it('gates save on the selected mode', () => {
    const c = make();
    expect(c.canSave()).toBe(true); // 'single' always valid

    c.mode.set('split');
    c.members.set(['Bob Marley']);
    expect(c.canSave()).toBe(false); // <2 members
    c.members.set(['Bob Marley', 'Peter Tosh']);
    expect(c.canSave()).toBe(true);

    c.mode.set('merge');
    expect(c.canSave()).toBe(false); // empty target
    c.mergeTarget.set('Bob Marley & The Wailers');
    expect(c.canSave()).toBe(true);
  });

  it('posts the split payload with trimmed, non-empty members', () => {
    const c = make();
    let saved = false;
    c.saved.subscribe(() => (saved = true));
    c.mode.set('split');
    c.members.set([' Bob Marley ', 'Peter Tosh', '']);

    c.save();

    expect(fixCalls).toEqual([
      {
        rawName: 'Bob Marley, Peter Tosh',
        decision: 'split',
        members: ['Bob Marley', 'Peter Tosh'],
      },
    ]);
    expect(saved).toBe(true);
  });

  it('posts the one-act payload', () => {
    const c = make();
    c.save();
    expect(fixCalls).toEqual([{ rawName: 'Bob Marley, Peter Tosh', decision: 'single' }]);
  });

  it('posts the merge payload', () => {
    const c = make();
    let closed = false;
    c.closed.subscribe(() => (closed = true));
    c.mode.set('merge');
    c.mergeTarget.set(' Bob Marley & The Wailers ');

    c.save();

    expect(fixCalls).toEqual([
      { rawName: 'Bob Marley, Peter Tosh', mergeInto: 'Bob Marley & The Wailers' },
    ]);
    expect(closed).toBe(true);
  });

  it('member chip editing updates the list', () => {
    const c = make();
    c.members.set(['A', 'B']);
    c.updateMember(1, 'C');
    expect(c.members()).toEqual(['A', 'C']);
    c.addMember();
    expect(c.members()).toEqual(['A', 'C', '']);
    c.removeMember(0);
    expect(c.members()).toEqual(['C', '']);
  });
});
