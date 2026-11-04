import type {StudioEdge} from './types';
export function planGroupConnections(
  sourceIds:string[],targetId:string,edges:StudioEdge[],
  canConnect:(source:string,target:string,edges:StudioEdge[])=>boolean
):Array<{source:string;target:string;sourceHandle:string;targetHandle:string}>;
