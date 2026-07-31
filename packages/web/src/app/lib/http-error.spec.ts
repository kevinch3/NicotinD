import { HttpErrorResponse } from '@angular/common/http';
import {
  httpErrorMessage,
  httpErrorCode,
  errorMessageForCode,
  httpErrorMessageI18n,
} from './http-error';

describe('httpErrorMessage', () => {
  it('prefers the server-supplied { error } body of an HttpErrorResponse', () => {
    // HttpErrorResponse is NOT an instanceof Error — the regression this guards.
    const err = new HttpErrorResponse({
      status: 404,
      error: { error: '"Cómo estás" isn\'t in Ke Personajes\'s Lidarr discography yet' },
    });
    expect(err instanceof Error).toBe(false);
    expect(httpErrorMessage(err, 'Failed to prepare album')).toBe(
      '"Cómo estás" isn\'t in Ke Personajes\'s Lidarr discography yet',
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

describe('httpErrorCode', () => {
  it('reads the typed code from an HttpErrorResponse body', () => {
    const err = new HttpErrorResponse({
      status: 404,
      error: { error: 'nope', code: 'ALBUM_NOT_IN_LIDARR' },
    });
    expect(httpErrorCode(err)).toBe('ALBUM_NOT_IN_LIDARR');
  });
  it('returns undefined when no code is present', () => {
    expect(httpErrorCode(new HttpErrorResponse({ status: 500 }))).toBeUndefined();
    expect(httpErrorCode({})).toBeUndefined();
  });
});

describe('errorMessageForCode (issue #337)', () => {
  const i18n = { t: (key: string) => `translated:${key}` };

  it('translates a mapped code', () => {
    expect(errorMessageForCode('INVALID_CREDENTIALS', i18n, 'fallback')).toBe(
      'translated:errors.invalidCredentials',
    );
  });

  it('falls back for an unmapped code (message varies per call site)', () => {
    expect(errorMessageForCode('VALIDATION_ERROR', i18n, 'fallback')).toBe('fallback');
  });

  it('falls back when there is no code at all', () => {
    expect(errorMessageForCode(undefined, i18n, 'fallback')).toBe('fallback');
  });
});

describe('httpErrorMessageI18n (issue #337)', () => {
  const i18n = { t: (key: string) => `translated:${key}` };

  it('prefers a mapped code translation over the raw server message', () => {
    const err = new HttpErrorResponse({
      status: 401,
      error: { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' },
    });
    expect(httpErrorMessageI18n(err, i18n, 'fallback')).toBe(
      'translated:errors.invalidCredentials',
    );
  });

  it('falls back to the raw server message for an unmapped code', () => {
    const err = new HttpErrorResponse({
      status: 400,
      error: { error: 'name is required', code: 'VALIDATION_ERROR' },
    });
    expect(httpErrorMessageI18n(err, i18n, 'fallback')).toBe('name is required');
  });

  it('falls back to the caller fallback with no server body at all', () => {
    expect(httpErrorMessageI18n({}, i18n, 'fallback')).toBe('fallback');
  });
});
