import { subsonicToken, generateSalt } from '@nicotind/core';

export interface SubsonicAuthParams {
  u: string;
  t: string;
  s: string;
  v: string;
  c: string;
  f: string;
}

export function buildAuthParams(username: string, password: string): SubsonicAuthParams {
  const salt = generateSalt(8);
  return {
    u: username,
    t: subsonicToken(password, salt),
    s: salt,
    v: '1.16.1',
    c: 'nicotind',
    f: 'json',
  };
}

export function authQueryString(username: string, password: string): string {
  const params = buildAuthParams(username, password);
  const entries: Record<string, string> = { ...params };
  return new URLSearchParams(entries).toString();
}
