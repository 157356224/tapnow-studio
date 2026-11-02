/** Fit the actual image dimensions to a usable canvas node without cropping.
 * The media's aspect ratio always wins over the generation aspect-ratio
 * setting once a real image has been uploaded or returned by the provider.
 * A 4K/8K asset must not create a multi-thousand-pixel wide React Flow node.
 */
export function intrinsicImageFrame(width?:number,height?:number){
  if(!Number.isFinite(width)||!Number.isFinite(height)||
    !width||!height||width<=0||height<=0)return null;
  const scale=Math.min(
    Math.sqrt(150000/(width*height)),
    540/width,
    530/height
  );
  return {
    width:Math.max(1,Math.round(width*scale)),
    height:Math.max(1,Math.round(height*scale))
  };
}
