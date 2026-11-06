import type { Edge, Node, Viewport } from '@xyflow/react';

export type Kind = 'image' | 'video' | 'text' | 'audio';
export type GenerationStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';
export type StudioNodeData = Record<string, unknown> & {
  kind: Kind;
  title: string;
  prompt: string;
  mediaUrl?: string;
  mediaName?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  model?: string;
  provider?: 'doubao'|'muse'|'h3'|'chatgpt'|'demo';
  museAccountId?: string;
  chatgptAccountId?: string;
  ratio?: string;
  resolution?: string;
  duration?: string;
  accountId?: string;
  h3FirstFrameId?: string;
  h3LastFrameId?: string;
  h3OptimizePrompt?: boolean;
  referenceIds?: string[];
  /** Explicit ordering of incoming image node IDs, used for @图片N numbering. */
  referenceOrder?: string[];
  jobId?: string;
  jobMessage?: string;
  status?: GenerationStatus;
  progress?: number;
  bypass?: boolean;
  demo?: boolean;
  text?: string;
  color?: string;
};
export type StudioNode = Node<StudioNodeData, 'studio'>;
export type StudioEdge = Edge;
export type Project = {
  id: string;
  title: string;
  nodes: StudioNode[];
  edges: StudioEdge[];
  viewport: Viewport;
  createdAt: string;
  updatedAt: string;
};
export type ProjectSummary = Pick<Project, 'id' | 'title' | 'updatedAt'>;
