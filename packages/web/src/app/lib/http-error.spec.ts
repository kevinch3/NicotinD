import { HttpErrorResponse } from '@angular/common/http';
import { httpErrorMessage } from './http-error';

describe('httpErrorMessage', () => {
  it('prefers the server-supplied { error } body of an HttpErrorResponse', () => {
    // HttpErrorResponse is NOT an instanceof Error — the regression this guards.
    const err = new HttpErrorResponse({
      status: 404,
      error: { error: "\"Cómo estás\" isn't in Ke Personajes's Lidarr discography yet" },
    });
    expect(err instanceof Error).toBe(false);
    expect(httpErrorMessage(err, 'Failed to prepare album')).toBe(
      "\"Cómo estás\" isn't in Ke Personajes's Lidarr discography yet",
    );
  });

  it('falls back to a real Error message when there is no server body', () => {
    expect(httpErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('uses the fallback when no message is available', () => {
    expect(httpErrorMessage({}, 'Failed to prepare album')).toBe('Failed to prepare album');
    expect(httpErrorMessage(new HttpErrorResponse({ status: 500 }), 'fallback')).toBe('fallback');
  });

  it('ignores an empty server message string', () => {
    const err = new HttpErrorResponse({ status: 503, error: { error: '' } });
    expect(httpErrorMessage(err, 'fallback')).toBe('fallback');
  });
});
