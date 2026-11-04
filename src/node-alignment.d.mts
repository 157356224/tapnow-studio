import type {StudioNode,StudioEdge} from './types';
export type AlignmentMode='left'|'center-x'|'right'|'top'|'center-y'|'bottom'|'distribute-x'|'distribute-y';
export const ALIGN_MODES: AlignmentMode[];
export function alignSelectedNodes(nodes:StudioNode[],mode:AlignmentMode):StudioNode[];
export function planGroupConnections(
  sourceIds:string[],targetId:string,edges:StudioEdge[],
  canConnect:(source:string,target:string,edges:StudioEdge[])=>boolean
):Array<{source:string;target:string;sourceHandle:string;targetHandle:string}>;
