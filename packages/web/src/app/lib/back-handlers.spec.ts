import { describe, it, expect } from 'vitest';
import { BackHandlerStack } from './back-handlers';

describe('BackHandlerStack (issue #394)', () => {
  it('runs handlers LIFO and stops at the first that consumes', () => {
    const stack = new BackHandlerStack();
    const calls: string[] = [];
    stack.push(() => {
      calls.push('bottom');
      return true;
    });
    stack.push(() => {
      calls.push('top');
      return true;
    });
    expect(stack.handleBack()).toBe(true);
    expect(calls).toEqual(['top']);
  });

  it('falls through handlers that decline (return false)', () => {
    const stack = new BackHandlerStack();
    const calls: string[] = [];
    stack.push(() => {
      calls.push('bottom');
      return true;
    });
    stack.push(() => {
      calls.push('decliner');
      return false;
    });
    expect(stack.handleBack()).toBe(true);
    expect(calls).toEqual(['decliner', 'bottom']);
  });

  it('returns false on an empty stack or when every handler declines', () => {
    const stack = new BackHandlerStack();
    expect(stack.handleBack()).toBe(false);
    stack.push(() => false);
    expect(stack.handleBack()).toBe(false);
  });

  it('unregister removes exactly its own handler, mid-stack included', () => {
    const stack = new BackHandlerStack();
    const calls: string[] = [];
    stack.push(() => {
      calls.push('a');
      return true;
    });
    const unregister = stack.push(() => {
      calls.push('b');
      return true;
    });
    stack.push(() => {
      calls.push('c');
      return false;
    });
    unregister();
    unregister(); // idempotent
    expect(stack.handleBack()).toBe(true);
    expect(calls).toEqual(['c', 'a']);
  });
});
