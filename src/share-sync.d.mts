import type {CanvasGroup,StudioNode,StudioEdge} from './types';
export type CanvasSnapshot={
  title:string;
  nodes:StudioNode[];
  edges:StudioEdge[];
  groups:CanvasGroup[];
  groupColorCursor:number;
};
export type CollectionPatch={
  upsert:Array<{
    id:string;
    create?:Record<string,unknown>;
    replace?:Record<string,unknown>;
    fields?:Record<string,unknown>;
    data?:Record<string,unknown>;
  }>;
  remove:string[];
};
export type CanvasPatch={
  nodes:CollectionPatch;
  edges:CollectionPatch;
  groups:CollectionPatch;
  title?:string;
  groupColorCursor?:number;
};
export function snapshotCanvas(project:Partial<CanvasSnapshot>):CanvasSnapshot;
export function diffCanvas(previous:CanvasSnapshot,next:CanvasSnapshot):CanvasPatch;
export function emptyCanvasPatch(patch:CanvasPatch):boolean;
export function applyCanvasPatch(canvas:CanvasSnapshot,patch:CanvasPatch,options?:{
  locks?:Map<string,{clientId:string}>;
  clientId?:string|null;
}):CanvasSnapshot;
export function rebaseLocalCanvas(
  local:CanvasSnapshot,oldRemote:CanvasSnapshot,newRemote:CanvasSnapshot
):CanvasSnapshot;
export function withLocalNodeSelection(
  snapshot:CanvasSnapshot,localNodes:StudioNode[]
):StudioNode[];
