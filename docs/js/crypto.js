/**
 * tasks.json の暗号化/復号（GitHub Pages が公開リポジトリ限定であることへの対策）。
 *
 * 方式: PBKDF2-SHA256(600,000回) で合言葉から鍵導出 → AES-256-GCM。
 * Node（取り込みバッチ）とブラウザの両方で同じ WebCrypto API を使うので実装は1つで済む。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const ITERATIONS = 600000;

export async function deriveKey(passphrase, saltBytes) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export const b64 = {
  // 大きなデータでも壊れないよう、32KBずつ小分けにして変換する。
  // String.fromCharCode(...bytes) のような一括展開は、数万件規模で
  // 「Maximum call stack size exceeded」になるため使わない。
  from: (bytes) => {
    const u8 = new Uint8Array(bytes);
    const CHUNK = 0x8000;
    let s = '';
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  },
  to: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

export async function encryptJSON(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return {
    encrypted: true,
    alg: 'AES-GCM',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS },
    salt: b64.from(salt),
    iv: b64.from(iv),
    ct: b64.from(ct),
  };
}

export async function decryptJSON(env, passphrase) {
  const key = await deriveKey(passphrase, b64.to(env.salt));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64.to(env.iv) },
    key,
    b64.to(env.ct)
  );
  return JSON.parse(dec.decode(pt));
}
