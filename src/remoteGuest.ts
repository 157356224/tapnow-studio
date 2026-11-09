// The session identifier is kept in a URL fragment, never sent to the host
// as a referrer or placed into the shared canvas project data.
export function remoteGuestSession():string|null{
  const match=/^#remote=([a-f0-9]{48})$/i.exec(window.location.hash);
  return match?.[1]||null;
}
export function guestRoute(url:string):string{
  const id=remoteGuestSession();
  if(!id)return url;
  if(url.startsWith('/api/share/'))
    return '/api/remote/'+id+'/share/'+url.slice('/api/share/'.length);
  if(url==='/api/projects'||url.startsWith('/api/projects/'))
    return '/api/remote/'+id+'/projects'+url.slice('/api/projects'.length);
  if(url.startsWith('/api/videos/extract-'))
    return '/api/remote/'+id+'/videos/'+url.slice('/api/videos/'.length);
  return url;
}
export function guestMediaURL(url?:string):string|undefined{
  const id=remoteGuestSession();
  if(id&&url?.startsWith('/api/uploads/'))
    return '/api/remote/'+id+'/uploads/'+url.slice('/api/uploads/'.length);
  return url;
}
