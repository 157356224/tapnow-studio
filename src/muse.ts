export type MuseAccount={
  id:string;
  name:string;
  createdAt:string;
  browserEngine:'edge';
};
export type MuseJob={
  id:string;
  accountId:string;
  projectId:string;
  nodeId:string;
  kind:'image'|'video';
  status:'queued'|'starting'|'running'|'completed'|
    'needs-attention'|'needs-login'|'interrupted';
  progress:number;
  message:string;
  error?:string;
  mediaUrl?:string;
};

export type MuseQuotaRow={
  id:string;
  name:string;
  status:'ok'|'unknown'|'error';
  used:number|null;
  remaining:number|null;
  quotaStatus:string|null;
  tierName:string|null;
  resetsAt:number|null;
  fetchedAt:number|null;
  error:string|null;
};
export type MuseQuotaSummary={
  totalAccounts:number;
  knownAccounts:number;
  unknownAccounts:number;
  totalCapacity:number;
  measuredCapacity:number;
  totalUsed:number;
  totalRemaining:number;
  rows:MuseQuotaRow[];
  refreshedAt:number;
  refreshIntervalMs:number;
  refreshing?:boolean;
};
