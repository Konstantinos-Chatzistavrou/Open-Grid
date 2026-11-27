// Apache-2.0 — Zero-dependency OAuth2 sign-in for Google, GitHub & Discord on Cloudflare Workers (OpenGrid).
// Features:
//   - Zero npm dependencies (pure WebCrypto HMAC-SHA256 + fetch)
//   - Graceful availability detection (UI hides any provider whose secrets aren't set yet)
//   - Safe return_to allowlist (open-grid.racing, vercel.app, localhost dev, and opengrid://auth for UE 5.8)
//   - Verified email extraction (Google email_verified, GitHub /user/emails primary verified, Discord verified)
import type { Env } from './util';

export type OAuthProvider = 'google' | 'github' | 'discord';

export interface OAuthProfile {
  provider: OAuthProvider;
  providerId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
}

export interface EnabledOAuthProviders {
  google: boolean;
  github: boolean;
  discord: boolean;
}

export function isOAuthProvider(s: string): s is OAuthProvider {
  return s === 'google' || s === 'github' || s === 'discord';
}

export function enabledOAuthProviders(env: Env): EnabledOAuthProviders {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    discord: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
  };
}

export function oauthCreds(provider: OAuthProvider, env: Env): { clientId: string; clientSecret: string } | null {
  if (provider === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (provider === 'github' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (provider === 'discord' && env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    return { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET };
  }
  return null;
}

/** Validate redirect target back to the game client (prevents open-redirect attacks while supporting UE 5.8). */
export function sanitizeReturnTo(raw: string | undefined): string {
  const fallback = 'https://open-grid.racing/';
  if (!raw || typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === 'opengrid://auth') return trimmed;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    const allowedHttps = u.protocol === 'https:' && (
      host === 'open-grid.racing' ||
      host === 'www.open-grid.racing' ||
      host === 'racing-game-brown-six.vercel.app' ||
      host.endsWith('.open-grid.racing')
    );
    const allowedLocal = u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost');
    if (!allowedHttps && !allowedLocal) return fallback;
    // Strip any pre-existing hash so we append our clean #og_auth=... fragment safely
    u.hash = '';
    return u.toString();
  } catch {
    return fallback;
  }
}

export function buildOAuthAuthorizeUrl(
  provider: OAuthProvider,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  if (provider === 'google') {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  }
  if (provider === 'github') {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
    });
    return `https://github.com/login/oauth/authorize?${q.toString()}`;
  }
  // Discord
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify email',
    prompt: 'none',
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${q.toString()}`;
}

export async function exchangeOAuthCode(
  provider: OAuthProvider,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<OAuthProfile> {
  if (provider === 'google') {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokRes.ok) throw new Error('Google token exchange failed');
    const tok = await tokRes.json<{ access_token?: string }>();
    if (!tok.access_token) throw new Error('Missing Google access token');

    const uRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!uRes.ok) throw new Error('Could not read Google user profile');
    const u = await uRes.json<{ sub?: string; email?: string; email_verified?: boolean; name?: string }>();
    if (!u.sub) throw new Error('Missing Google user id');
    return {
      provider: 'google',
      providerId: String(u.sub),
      email: u.email ? u.email.trim().toLowerCase() : null,
      emailVerified: Boolean(u.email && u.email_verified),
      displayName: (u.name || u.email?.split('@')[0] || 'Driver').trim().slice(0, 24),
    };
  }

  if (provider === 'github') {
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': 'OpenGrid-Auth/1.0',
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokRes.ok) throw new Error('GitHub token exchange failed');
    const tok = await tokRes.json<{ access_token?: string }>();
    if (!tok.access_token) throw new Error('Missing GitHub access token');

    const headers = {
      authorization: `Bearer ${tok.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'OpenGrid-Auth/1.0',
    };
    const uRes = await fetch('https://api.github.com/user', { headers });
    if (!uRes.ok) throw new Error('Could not read GitHub profile');
    const u = await uRes.json<{ id?: number | string; login?: string; name?: string; email?: string | null }>();
    if (!u.id) throw new Error('Missing GitHub user id');

    let email: string | null = u.email ? u.email.trim().toLowerCase() : null;
    let emailVerified = false;
    const emRes = await fetch('https://api.github.com/user/emails', { headers }).catch(() => null);
    if (emRes?.ok) {
      const list = await emRes.json<{ email: string; primary: boolean; verified: boolean }[]>();
      const primary = list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified);
      if (primary?.email) {
        email = primary.email.trim().toLowerCase();
        emailVerified = true;
      }
    }
    return {
      provider: 'github',
      providerId: String(u.id),
      email,
      emailVerified,
      displayName: (u.login || u.name || 'Driver').trim().slice(0, 24),
    };
  }

  // Discord
  const tokRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokRes.ok) throw new Error('Discord token exchange failed');
  const tok = await tokRes.json<{ access_token?: string }>();
  if (!tok.access_token) throw new Error('Missing Discord access token');

  const uRes = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bearer ${tok.access_token}` },
  });
  if (!uRes.ok) throw new Error('Could not read Discord profile');
  const u = await uRes.json<{ id?: string; username?: string; global_name?: string; email?: string | null; verified?: boolean }>();
  if (!u.id) throw new Error('Missing Discord user id');
  return {
    provider: 'discord',
    providerId: String(u.id),
    email: u.email ? u.email.trim().toLowerCase() : null,
    emailVerified: Boolean(u.email && u.verified),
    displayName: (u.global_name || u.username || 'Driver').trim().slice(0, 24),
  };
}
