import { describe, expect, it } from 'bun:test';
import { pickFormat, renderSubsonic, renderSubsonicError } from './opensubsonic-response.js';

describe('OpenSubsonic envelope', () => {
  it('defaults to XML, and only `f=json` selects JSON', () => {
    expect(pickFormat(undefined)).toBe('xml');
    expect(pickFormat('xml')).toBe('xml');
    expect(pickFormat('jsonp')).toBe('xml');
    expect(pickFormat('json')).toBe('json');
  });

  it('wraps a JSON payload in subsonic-response with the OpenSubsonic header', async () => {
    const res = renderSubsonic('json', '1.2.3', { license: { valid: true } });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      'subsonic-response': {
        status: 'ok',
        version: '1.16.1',
        type: 'nicotind',
        serverVersion: '1.2.3',
        openSubsonic: true,
        license: { valid: true },
      },
    });
  });

  it('writes scalars as attributes, arrays as repeated elements, `value` as text', async () => {
    const res = renderSubsonic('xml', 'v', {
      album: {
        id: 'a1',
        name: 'Tom & "Jerry" <live>',
        missing: undefined,
        song: [{ id: 's1' }, { id: 's2' }],
        releaseTypes: ['Album'],
      },
      lyrics: { artist: 'X', value: 'line one\nline <two>' },
    });
    const xml = await res.text();
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<subsonic-response xmlns="http://subsonic.org/restapi" status="ok"');
    expect(xml).toContain(
      '<album id="a1" name="Tom &amp; &quot;Jerry&quot; &lt;live&gt;"><song id="s1"/><song id="s2"/><releaseTypes>Album</releaseTypes></album>',
    );
    expect(xml).not.toContain('missing');
    expect(xml).toContain('<lyrics artist="X">line one\nline &lt;two&gt;</lyrics>');
  });

  it('reports a failure with status=failed and the numeric code', async () => {
    const res = renderSubsonicError('json', 'v', 70, 'Not found');
    const body = (await res.json()) as {
      'subsonic-response': { status: string; error: { code: number; message: string } };
    };
    expect(res.status).toBe(200);
    expect(body['subsonic-response'].status).toBe('failed');
    expect(body['subsonic-response'].error).toEqual({ code: 70, message: 'Not found' });
    const xml = await renderSubsonicError('xml', 'v', 40, 'Wrong').text();
    expect(xml).toContain('status="failed"');
    expect(xml).toContain('<error code="40" message="Wrong"/>');
  });
});
