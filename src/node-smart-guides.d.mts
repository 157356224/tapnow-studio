import type {NodeChange} from '@xyflow/react';
import type {StudioNode} from './types';
export type SmartGuides={
  vertical?:{x:number;y1:number;y2:number}|null;
  horizontal?:{y:number;x1:number;x2:number}|null;
}|null;
export function snapNodePositionChanges(
  nodes:StudioNode[],changes:NodeChange<StudioNode>[],
  zoom?:number,thresholdPx?:number
):{changes:NodeChange<StudioNode>[];guides:SmartGuides};
