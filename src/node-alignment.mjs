// Compute the entire fan-out before changing state, and apply the same cycle,
// duplicate and reverse-link validation used for a normal single connection.
export function planGroupConnections(sourceIds,targetId,edges,canConnect){
  const accepted=[],pending=[...edges];
  for(const source of [...new Set(sourceIds)]){
    if(source===targetId||!canConnect(source,targetId,pending))continue;
    const edge={source,target:targetId,sourceHandle:'out',targetHandle:'in'};
    pending.push(edge);
    accepted.push(edge);
  }
  return accepted;
}
