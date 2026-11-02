// A single display-synchronised RAF drives all wires; it does not impose a
// 60-fps timer or spawn an independent RAF per connection. Pauses when hidden.
type FrameConsumer=(time:number)=>void;
const consumers=new Set<FrameConsumer>();
let frame=0;
function tick(time:number){
  frame=0;
  if(document.hidden)return;
  for(const callback of consumers)callback(time);
  if(consumers.size)frame=requestAnimationFrame(tick);
}
function start(){
  if(!frame&&consumers.size&&!document.hidden)
    frame=requestAnimationFrame(tick);
}
function onVisibility(){
  if(document.hidden){
    if(frame)cancelAnimationFrame(frame);
    frame=0;
  }else start();
}
export function subscribeAnimation(callback:FrameConsumer){
  if(!consumers.size)document.addEventListener('visibilitychange',onVisibility);
  consumers.add(callback);
  start();
  return ()=>{
    consumers.delete(callback);
    if(!consumers.size){
      if(frame)cancelAnimationFrame(frame);
      frame=0;
      document.removeEventListener('visibilitychange',onVisibility);
    }
  };
}
