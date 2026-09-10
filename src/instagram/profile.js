// The personalization surface: name, username, follower count, and the mutual-
// follow flags Meta exposes for users in a messaging context — plus the caption
// of the post a comment landed on.
import { config } from '../config.js';
import { trace } from '../sim/trace.js';

async function metaGet(path) {
  const res = await fetch(`${config.graphBase}/${path}${path.includes('?') ? '&' : '?'}access_token=${config.igAccessToken}`);
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function fetchProfile(igsid) {
  try {
    if (config.transport === 'meta') {
      return await metaGet(`${igsid}?fields=name,username,follower_count,is_user_follow_business,is_business_follow_user`);
    }
    const res = await fetch(`http://127.0.0.1:${config.port}/sim/profile/${igsid}`);
    return res.ok ? await res.json() : null;
  } catch (err) {
    trace('error', `profile fetch failed for ${igsid} (continuing without): ${err.message}`);
    return null;
  }
}

export async function fetchPostContext(mediaId) {
  // caption AND the actual picture: openers that react to what's in the photo
  // read human; caption-only context goes blind on caption-less posts.
  const empty = { caption: null, imageUrl: null, permalink: null };
  if (!mediaId) return empty;
  try {
    if (config.transport === 'meta') {
      const media = await metaGet(`${mediaId}?fields=caption,media_type,media_url,thumbnail_url,permalink`);
      const url = media.thumbnail_url || (media.media_type === 'VIDEO' ? null : media.media_url) || null;
      // IG's CDN 403s third-party fetchers (OpenAI included), so we download
      // the picture ourselves and hand the model inline data it never has to fetch.
      let imageUrl = null;
      if (url) {
        const img = await fetch(url);
        if (img.ok) {
          const mime = img.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
          imageUrl = `data:${mime};base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`;
        } else {
          trace('error', `post image download failed (${img.status}) — opener goes caption-only`);
        }
      }
      return { caption: media.caption || null, imageUrl, permalink: media.permalink || null };
    }
    const res = await fetch(`http://127.0.0.1:${config.port}/sim/post/${mediaId}`);
    return res.ok ? { ...empty, caption: (await res.json()).caption } : empty;
  } catch (err) {
    trace('error', `post context fetch failed for ${mediaId} (continuing without): ${err.message}`);
    return empty;
  }
}
