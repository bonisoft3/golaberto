export function compressedStorage(source: string): string {
  const opening = 'const Base = edgeObject({'
  if (source.split(opening).length !== 2 || source.includes('storageFormat:')) {
    throw new Error('Cloudflare database entry changed; review the Golaberto storage policy')
  }
  return source.replace(opening, `${opening}\n  storageFormat: { version: 1, blockSize: 8192, codec: 'deflate' },`)
}
