// Display exact zone membership, compacting only consecutive positions.
export default function render(value) {
  const [raw, first, last] = String(value ?? "").split("|");
  let positions;
  try { positions = JSON.parse(raw); } catch {
    const low = Number(first), high = Number(last);
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high < low || high - low > 10000) return [];
    positions = Array.from({length:high-low+1},(_,index)=>low+index);
  }
  if (!Array.isArray(positions) || !positions.length || positions.some(p=>!Number.isInteger(p) || p < 1)) return [];
  const sorted = [...new Set(positions)].sort((a,b)=>a-b);
  const spans=[];
  for(const p of sorted) {
    const span=spans[spans.length-1];
    if(span && p===span[1]+1)span[1]=p;
    else spans.push([p,p]);
  }
  return [spans.map(([low,high])=>low===high ? String(low) : `${low}–${high}`).join(", ")];
}
render;
