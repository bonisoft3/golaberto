export function adaptBlobRequest(request: Request): Request {
  const url = new URL(request.url);
  const variant = /^\/mecha-objects\/([^/]+)\/(medium|thumb)\.png$/.exec(url.pathname);
  url.pathname = variant ? `/media/objects/${variant[1]}/${variant[2]}.png` : `/blobs${url.pathname}`;
  return new Request(url, request);
}
