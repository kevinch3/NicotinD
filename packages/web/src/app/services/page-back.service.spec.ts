import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PageBackService } from './page-back.service';

const calls: string[] = [];

@Component({ standalone: true, template: '' })
class RegistrantComponent {
  static nextName = '';
  private readonly name = RegistrantComponent.nextName;
  constructor() {
    inject(PageBackService).register(() => void calls.push(this.name));
  }
}

function mount(name: string) {
  RegistrantComponent.nextName = name;
  return TestBed.createComponent(RegistrantComponent);
}

describe('PageBackService', () => {
  beforeEach(() => (calls.length = 0));

  it('has no target until a page registers; back() is then a no-op', () => {
    const s = TestBed.inject(PageBackService);
    expect(s.hasTarget()).toBe(false);
    s.back();
    expect(calls).toEqual([]);
  });

  it('runs the newest registration and drops it when its page is destroyed', () => {
    const s = TestBed.inject(PageBackService);
    const first = mount('first');
    const second = mount('second');
    expect(s.hasTarget()).toBe(true);

    s.back();
    expect(calls).toEqual(['second']);

    second.destroy();
    s.back();
    expect(calls).toEqual(['second', 'first']);

    first.destroy();
    expect(s.hasTarget()).toBe(false);
  });

  it('an older page destroyed after a newer one registered does not take the newer one with it', () => {
    const s = TestBed.inject(PageBackService);
    const leaving = mount('leaving');
    mount('arriving');
    leaving.destroy();
    s.back();
    expect(calls).toEqual(['arriving']);
    expect(s.hasTarget()).toBe(true);
  });
});
